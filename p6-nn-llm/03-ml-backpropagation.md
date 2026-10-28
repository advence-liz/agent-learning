# 反向传播：手写自动求导引擎

> 对应原站：[反向传播：手写自动求导引擎](https://labuladong.online/zh/ai-coding/machine-learning/ml-backpropagation/)（会员内容；本章为独立原创重写）

> **一句话结论**：反向传播没有魔法——每个运算只记住「我的输入是谁」和「我自己的局部导数」，`backward()` 按拓扑序倒着走一遍，把梯度一路乘下去、累加起来。整个引擎 100 来行 Python。

上一章的 1D-CNN 有 8228 个参数。每训练一步，都要知道「损失对这 8228 个参数各自的偏导数」。

在 [梯度下降](../p5-ml/05-ml-gradient-descent.md) 那章，我们只有两个参数，手推一下公式就行。可是 8228 个参数、5 层网络，手推的话光一个参数的偏导就得写半页纸。

而 PyTorch 只用一行：`loss.backward()`。

你可能会问：它是不是做了什么符号推导，把整个网络的导数公式化简出来了？

不是。它做的事情比这笨得多，也聪明得多。这一章我们自己写一个，写完你就再也不会觉得 `backward()` 神秘了。

## 先跑起来看看

`code/ml/nn/micrograd.py` 是我们要写的引擎（名字致敬 Karpathy 的 micrograd）。直接运行它：

```text
❯ cd code/ml && uv run python nn/micrograd.py
L = 16.0 | dL/da = -24.0 dL/db = 16.0 dL/dc = 8.0

params=105
step   0  micrograd_loss=0.671079  torch_loss=0.671079  acc=0.48
step  25  micrograd_loss=0.413331  torch_loss=0.413331  acc=0.83
step  50  micrograd_loss=0.304707  torch_loss=0.304707  acc=0.88
step  75  micrograd_loss=0.270792  torch_loss=0.270792  acc=0.89
step 100  micrograd_loss=0.244870  torch_loss=0.244870  acc=0.89
step 125  micrograd_loss=0.216820  torch_loss=0.216820  acc=0.91
step 149  micrograd_loss=0.183059  torch_loss=0.183059  acc=0.93
```

第一行是一个小表达式的梯度，下面马上手算验证。

后面是用这个引擎训练一个 2-8-8-1 的小网络，区分 sklearn 的两个「月牙」（make_moons）。同时让 PyTorch 用**完全相同的初始权重**同步训练。150 步下来，两边的 loss 到小数点后 6 位都一样。

也就是说，我们 100 来行代码，和 PyTorch 算出了一模一样的梯度。

## 计算图：把一个公式拆成一串小运算

先看第一行那个例子：

$$L = \text{relu}(a \cdot b + c)^2,\quad a=2,\ b=-3,\ c=10$$

PyTorch（和我们的引擎）在算 $L$ 的时候，会把它拆成一个个最简单的运算，并且**记下每个中间结果是怎么来的**。这就是计算图（computational graph）：

```d2
direction: down
a: "a = 2\ngrad = -24"
mul: "×" {shape: circle; style.font-size: 28}
b: "b = -3\ngrad = 16"
d: "d = a·b = -6\ngrad = 8"
add: "+" {shape: circle; style.font-size: 28}
c: "c = 10\ngrad = 8"
e: "e = d+c = 4\ngrad = 8"
relu: relu {shape: circle}
f: "f = 4\ngrad = 8"
sq: "²" {shape: circle}
l: "L = 16\ngrad = 1"
a -> mul
b -> mul
mul -> d
d -> add
c -> add
add -> e
e -> relu
relu -> f
f -> sq
sq -> l
```

图注：箭头方向是前向计算。每个方框里的 `grad` 是反向传播之后填进去的「L 对它的偏导」，要从右往左读。

反向是这样一步步填的：

- $L$ 对自己的导数是 1。
- $L = f^2$，局部导数 $2f = 8$，所以 $\partial L/\partial f = 8 \times 1 = 8$。
- $f = \text{relu}(e)$，$e > 0$ 时局部导数是 1，所以 $\partial L/\partial e = 8$。
- $e = d + c$，加法对两个输入的局部导数都是 1，所以 $d$ 和 $c$ 都拿到 8。
- $d = a \cdot b$，乘法对 $a$ 的局部导数是 $b$，对 $b$ 的是 $a$。所以 $a$ 拿到 $8 \times (-3) = -24$，$b$ 拿到 $8 \times 2 = 16$。

这就是链式法则（chain rule）：**一个节点的梯度 = 下游传来的梯度 × 自己的局部导数**。

注意，每个运算节点只需要知道两件事：自己的输入是谁、自己的局部导数是什么。乘法节点完全不需要知道后面还有 relu 和平方。

打个比方：一家公司年底亏了钱，要追责。CEO 不用知道每个基层员工干了什么，他只问几个直接汇报的 VP「你们各自贡献了多少」；每个 VP 再问自己的直接下属……一层层往下问，最后每个人都知道了自己的「责任」。

这个比方有一处不成立：公司追责一般是把一笔总账「分摊」掉，加起来等于总数；梯度不守恒，乘法节点会把梯度放大或缩小（上面 $a$ 拿到的 -24 比上游的 8 大得多）。

## 手写 Value：前向记账，反向分发

整个引擎的核心是一个 `Value` 类，包着一个浮点数，外加四个字段：

```python
class Value:
    def __init__(self, data, _children=(), _op=""):
        self.data = float(data)
        self.grad = 0.0
        self._backward = lambda: None   # 怎么把我的 grad 分给输入
        self._prev = set(_children)     # 我是由谁算出来的
        self._op = _op
```

每个运算都做两件事：算出结果，并且留下一个「反向时怎么分梯度」的闭包。以乘法为例：

```python
def __mul__(self, other):
    other = other if isinstance(other, Value) else Value(other)
    out = Value(self.data * other.data, (self, other), "*")

    def _backward():
        self.grad += other.data * out.grad
        other.grad += self.data * out.grad

    out._backward = _backward
    return out
```

就这么简单。加法、幂、relu、tanh、exp、log 都是同一个套路，区别只在局部导数那一行。减法、除法这些「语法糖」直接复用已有运算（`a - b` 就是 `a + (-1)*b`），不用单独写导数。

你可能会问：为什么是 `+=` 而不是 `=`？

因为同一个值可能被用了不止一次。比如 $y = x \cdot x + x$，$x$ 在图里有三条出边，三条路传回来的梯度要加在一起：$2x + 1$。如果用 `=`，后面的路径会把前面的覆盖掉。测试 `test_reused_node_accumulates_grad` 专门守着这一点。

### backward：先拓扑排序，再倒着走

有了每个节点的 `_backward`，剩下的问题是：**按什么顺序调用它们**？

必须保证：轮到某个节点分发梯度时，它自己的 grad 已经从**所有**下游收齐了。这正好是拓扑排序（topological sort）的倒序：

```python
def backward(self):
    topo, visited = [], set()

    def build(v):
        if id(v) in visited:
            return
        visited.add(id(v))
        for child in v._prev:
            build(child)
        topo.append(v)  # 所有输入都进列表之后，自己才进

    build(self)
    self.grad = 1.0
    for v in reversed(topo):
        v._backward()
```

一次深度优先遍历，一次倒序循环。说穿了，`loss.backward()` 就是**一个 DFS 加一个 for 循环**。

这种「从输出往输入倒推，一次算出所有输入的梯度」的方式叫反向模式自动微分（reverse-mode autodiff）。不管有多少个参数，只要反向走一遍，成本和前向是同一个数量级。这就是它能训练千亿参数模型的根本原因。

## 搭网络、对答案

有了 `Value`，神经元就是一个加权求和再过 relu：

```python
class Neuron:
    def __call__(self, x):
        act = sum((wi * xi for wi, xi in zip(self.w, x)), self.b)
        return act.relu() if self.nonlin else act
```

`Layer` 是一组 `Neuron`，`MLP` 是一串 `Layer`。损失用带 logit 的二元交叉熵 $\log(1+e^z) - yz$，也是用 `exp`、`log` 拼出来的。

训练循环和 PyTorch 的写法几乎一样，只是优化器是手写的 `p.data -= lr * p.grad`：

```python
losses = [bce_with_logit(model([Value(a), Value(b)]), int(t)) for (a, b), t in zip(X, y)]
loss = sum(losses) * (1.0 / len(losses))
model.zero_grad()
loss.backward()
for p in model.parameters():
    p.data -= lr * p.grad
```

怎么证明梯度是对的？`test_micrograd.py` 用了三种方式：

1. **手算**：上面那个 $L=16$ 的例子，断言 `(a.grad, b.grad, c.grad) == (-24, 16, 8)`。
2. **对照 torch.autograd**：4 个表达式（多项式、tanh、exp/log、relu 混合）× 3 组输入，用 float64 跑 PyTorch，梯度相对误差 < 1e-9。再把整个 MLP 的 105 个参数搬进 PyTorch，逐个比梯度。
3. **有限差分**：不依赖任何库，$\frac{f(x+\epsilon)-f(x-\epsilon)}{2\epsilon}$ 和我们的梯度比。

```text
❯ uv run pytest -v nn/test_micrograd.py nn/test_matrix_backprop.py
nn/test_micrograd.py::test_simple_chain_matches_hand_calculation PASSED
nn/test_micrograd.py::test_reused_node_accumulates_grad PASSED
nn/test_micrograd.py::test_grad_matches_torch[1.5--0.7-poly] PASSED
... （12 组参数化用例全部 PASSED，略）
nn/test_micrograd.py::test_mlp_param_grads_match_torch PASSED
nn/test_micrograd.py::test_numerical_gradient_check PASSED
nn/test_matrix_backprop.py::test_matrix_backprop_matches_torch PASSED
============================== 17 passed in 0.61s ==============================
```

## 为什么 PyTorch 不这么写：矩阵形式

我们的引擎能跑，但慢。数一下就知道：训练月牙那个 105 参数的小网络，100 个样本一步前向，计算图里有 **20508 个 Value 节点**，每个都是一个 Python 对象、一个闭包。150 步跑了 16 秒。

PyTorch 的计算图节点不是标量，而是张量。一个 `X @ W` 是**一个**节点，里面几百万次乘加交给 C++/GPU 一次做完。

同样的链式法则，写成矩阵形式只有几行（`nn/matrix_backprop.py`）：

```python
# 前向
A = X @ W1 + b1
H = np.maximum(A, 0)
Z = (H @ W2 + b2).ravel()
# 反向：每一行都是标量版的「批量化」
dZ  = (sigmoid(Z) - y)[:, None] / N
dW2 = H.T @ dZ;  db2 = dZ.sum(0)
dH  = dZ @ W2.T
dA  = dH * (A > 0)          # relu 的局部导数
dW1 = X.T @ dA;  db1 = dA.sum(0)
```

对照标量版看：`dH = dZ @ W2.T` 就是乘法节点的「`self.grad += other.data * out.grad`」，只不过一次处理了整个矩阵；`db2 = dZ.sum(0)` 就是 `+=` 的累加——偏置被 N 个样本共用，梯度要加起来。`test_matrix_backprop_matches_torch` 验证这 4 个梯度和 PyTorch 误差 < 1e-10。

**回到主线**：反向传播是模型「学习」的唯一途径——它把损失的变化归因到每一个权重上。LLM 的预训练、微调，本质上就是对「预测下一个 token 的交叉熵」做 `backward()`。而你在用 Claude 时，这条路是**关着的**：API 只返回 token，不返回梯度，你改不了它的权重。所以你对 Claude 做的一切「调教」，都只能发生在上下文里。

## 对照你的环境

- **你所有的 Claude 配置都是「改输入」，不是「改权重」**。`CLAUDE.md`、40 多个 skill、`inject-guardrails.sh` 通过 SessionStart hook 注入的 additionalContext——它们全部是往上下文里塞 token。没有一个能触发 `backward()`。这也解释了为什么你的 CLAUDE.md 里写「常驻层是稀缺资源」：在不能改权重的前提下，上下文就是你唯一的杠杆，而它有长度上限。
- **想改权重怎么办**？那就是第 6 章 [LoRA 微调](06-lora-fine-tuning.md) 的事：拿一个开源小模型，冻住大部分参数，只对一小部分做反向传播。
- **`+=` 累加 ↔ `zero_grad()`**：PyTorch 的 `.grad` 也是累加的，所以每步训练前必须清零。这和你在 hook 里处理「同一个 session 多次触发」是一个道理：状态默认会累积，要显式重置。

## 常见坑

1. **`_backward` 里写成 `=` 而不是 `+=`**。只要有节点被复用（几乎所有网络都有，比如同一个输入喂给多个神经元），梯度就是错的，而且不会报错。
2. **忘了 `zero_grad()`**。我们的 `Value.grad` 和 PyTorch 一样会累加，不清零的话第二步的梯度是两步之和，loss 很快就炸。
3. **递归太深**。`build()` 是递归 DFS，计算图深度超过 Python 默认递归上限（1000）就会 `RecursionError`。我们的 `sum(losses)` 产生了一条 100 层的加法链，还在安全范围；真要做大图，改成显式栈。
4. **数值溢出**。`bce_with_logit` 用的是 $\log(1+e^z)$，$z > 709$ 时 `math.exp` 会溢出。PyTorch 的 `BCEWithLogitsLoss` 内部用了 log-sum-exp 技巧，矩阵版里我们也用了 `np.logaddexp(0, Z)`。
5. **relu 在 0 点的导数**。数学上不存在，我们和 PyTorch 都取 0（`out.data > 0`）。做梯度检查时别把测试点选在 0 附近。

## 练习

1. 给 `Value` 加一个 `sigmoid()` 方法（只写局部导数，别用 `exp` 拼），并在 `test_micrograd.py` 里加一条和 `torch.sigmoid` 对比的用例。
2. 把 `backward()` 里的递归 `build` 改写成用显式栈的迭代版本，然后构造一个 5000 层深的加法链验证它不会 `RecursionError`。
3. （开放）`Value` 每个节点都在内存里保留了 `_prev` 引用。训练一步后这 20508 个节点什么时候被释放？PyTorch 的 `loss.backward()` 默认会释放计算图（`retain_graph=False`），为什么要这样设计？这和推理时只需要前向、不需要保留计算图有什么关系（提示：`torch.no_grad()`，第 5 章会用到）？

## 延伸阅读

- Karpathy 的 micrograd 源码：<https://github.com/karpathy/micrograd>
- PyTorch autograd 机制说明：<https://pytorch.org/docs/stable/notes/autograd.html>
- 本章代码：`code/ml/nn/micrograd.py`、`code/ml/nn/matrix_backprop.py`，测试 `code/ml/nn/test_micrograd.py`、`code/ml/nn/test_matrix_backprop.py`
- 下一章 [优化器：Momentum 和 Adam](04-ml-optimizers.md)：梯度算出来之后，`p.data -= lr * p.grad` 这一行还能怎么写
