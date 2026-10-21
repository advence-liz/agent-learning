"""一个 micrograd 风格的标量自动求导引擎。

核心只有两件事：
1. 前向时，每个运算都新建一个 Value，并记住「我是由谁、怎么算出来的」（_prev + _backward）。
2. backward() 时，先拓扑排序整张计算图，再从输出倒着走，每个节点把自己的 grad
   按链式法则「分发」给它的输入。
"""

from __future__ import annotations

import math
import random


class Value:
    __slots__ = ("data", "grad", "_backward", "_prev", "_op")

    def __init__(self, data: float, _children: tuple = (), _op: str = ""):
        self.data = float(data)
        self.grad = 0.0
        self._backward = lambda: None  # 叶子节点没有输入，什么都不用做
        self._prev = set(_children)
        self._op = _op

    # ---------- 基本运算：每个运算 = 前向公式 + 局部导数 ----------
    def __add__(self, other):
        other = other if isinstance(other, Value) else Value(other)
        out = Value(self.data + other.data, (self, other), "+")

        def _backward():
            # d(a+b)/da = 1, d(a+b)/db = 1。用 += 而不是 =：同一个节点可能被用了多次
            self.grad += out.grad
            other.grad += out.grad

        out._backward = _backward
        return out

    def __mul__(self, other):
        other = other if isinstance(other, Value) else Value(other)
        out = Value(self.data * other.data, (self, other), "*")

        def _backward():
            self.grad += other.data * out.grad
            other.grad += self.data * out.grad

        out._backward = _backward
        return out

    def __pow__(self, k: float):
        assert isinstance(k, (int, float)), "只支持常数次幂"
        out = Value(self.data ** k, (self,), f"**{k}")

        def _backward():
            self.grad += k * self.data ** (k - 1) * out.grad

        out._backward = _backward
        return out

    def relu(self):
        out = Value(self.data if self.data > 0 else 0.0, (self,), "relu")

        def _backward():
            self.grad += (out.data > 0) * out.grad

        out._backward = _backward
        return out

    def tanh(self):
        t = math.tanh(self.data)
        out = Value(t, (self,), "tanh")

        def _backward():
            self.grad += (1 - t * t) * out.grad

        out._backward = _backward
        return out

    def exp(self):
        e = math.exp(self.data)
        out = Value(e, (self,), "exp")

        def _backward():
            self.grad += e * out.grad

        out._backward = _backward
        return out

    def log(self):
        out = Value(math.log(self.data), (self,), "log")

        def _backward():
            self.grad += (1 / self.data) * out.grad

        out._backward = _backward
        return out

    # ---------- 反向传播 ----------
    def backward(self):
        topo: list[Value] = []
        visited: set[int] = set()

        def build(v: Value):
            if id(v) in visited:
                return
            visited.add(id(v))
            for child in v._prev:
                build(child)
            topo.append(v)  # 所有输入都进列表之后，自己才进 —— 这就是拓扑序

        build(self)
        self.grad = 1.0  # dL/dL = 1
        for v in reversed(topo):
            v._backward()

    # ---------- 语法糖：都归结到上面几个运算 ----------
    def __neg__(self):
        return self * -1

    def __sub__(self, other):
        return self + (-other)

    def __truediv__(self, other):
        return self * other ** -1

    def __radd__(self, other):
        return self + other

    def __rsub__(self, other):
        return (-self) + other

    def __rmul__(self, other):
        return self * other

    def __rtruediv__(self, other):
        return Value(other) * self ** -1

    def __repr__(self):
        return f"Value(data={self.data:.4f}, grad={self.grad:.4f})"


# ---------- 用 Value 搭一个小 MLP ----------
class Neuron:
    def __init__(self, n_in: int, nonlin: bool = True):
        self.w = [Value(random.uniform(-1, 1) / math.sqrt(n_in)) for _ in range(n_in)]
        self.b = Value(0.0)
        self.nonlin = nonlin

    def __call__(self, x):
        act = sum((wi * xi for wi, xi in zip(self.w, x)), self.b)
        return act.relu() if self.nonlin else act

    def parameters(self):
        return self.w + [self.b]


class Layer:
    def __init__(self, n_in: int, n_out: int, nonlin: bool = True):
        self.neurons = [Neuron(n_in, nonlin) for _ in range(n_out)]

    def __call__(self, x):
        out = [n(x) for n in self.neurons]
        return out[0] if len(out) == 1 else out

    def parameters(self):
        return [p for n in self.neurons for p in n.parameters()]


class MLP:
    def __init__(self, n_in: int, sizes: list[int]):
        dims = [n_in] + sizes
        self.layers = [Layer(dims[i], dims[i + 1], nonlin=i != len(sizes) - 1) for i in range(len(sizes))]

    def __call__(self, x):
        for layer in self.layers:
            x = layer(x)
        return x

    def parameters(self):
        return [p for layer in self.layers for p in layer.parameters()]

    def zero_grad(self):
        for p in self.parameters():
            p.grad = 0.0


def bce_with_logit(z: Value, y: int) -> Value:
    """二元交叉熵，输入是 logit。用 log(1+e^z) - y*z 的形式。"""
    return (1 + z.exp()).log() - y * z


def torch_twin(model: MLP):
    """把同一组初始权重拷进 torch，返回 (参数列表, forward 函数)，用来逐步对照。"""
    import torch

    params = [torch.tensor(p.data, dtype=torch.float64, requires_grad=True) for p in model.parameters()]

    def forward(X):  # X: (N, 2) float64 tensor
        it = iter(params)
        h = [X[:, 0], X[:, 1]]
        for layer in model.layers:
            new_h = []
            for n in layer.neurons:
                ws = [next(it) for _ in n.w]
                b = next(it)
                act = sum((w * xi for w, xi in zip(ws, h)), b)
                new_h.append(torch.relu(act) if n.nonlin else act)
            h = new_h
        return h[0]

    return params, forward


def demo_train(seed: int = 0, steps: int = 150, lr: float = 0.5, log=print):
    """用标量引擎训练一个 2-8-8-1 的网络分开两个月牙，同时让 torch 用同样的初值同步训练做对照。"""
    import torch
    from sklearn.datasets import make_moons

    random.seed(seed)
    X, y = make_moons(n_samples=100, noise=0.1, random_state=seed)
    model = MLP(2, [8, 8, 1])
    tparams, tforward = torch_twin(model)
    tX, ty = torch.tensor(X), torch.tensor(y, dtype=torch.float64)
    log(f"params={len(model.parameters())}")
    for step in range(steps):
        losses = [bce_with_logit(model([Value(a), Value(b)]), int(t)) for (a, b), t in zip(X, y)]
        loss = sum(losses) * (1.0 / len(losses))
        model.zero_grad()
        loss.backward()
        for p in model.parameters():
            p.data -= lr * p.grad

        tloss = torch.nn.functional.binary_cross_entropy_with_logits(tforward(tX), ty)
        for p in tparams:
            p.grad = None
        tloss.backward()
        with torch.no_grad():
            for p in tparams:
                p -= lr * p.grad

        if step % 25 == 0 or step == steps - 1:
            acc = sum((model([Value(a), Value(b)]).data > 0) == bool(t) for (a, b), t in zip(X, y)) / len(y)
            log(f"step {step:3d}  micrograd_loss={loss.data:.6f}  torch_loss={tloss.item():.6f}  acc={acc:.2f}")
    return model, X, y


if __name__ == "__main__":
    # 先看一个最小例子：L = (a*b + c).relu() ** 2
    a, b, c = Value(2.0), Value(-3.0), Value(10.0)
    L = (a * b + c).relu() ** 2
    L.backward()
    print("L =", L.data, "| dL/da =", a.grad, "dL/db =", b.grad, "dL/dc =", c.grad)
    print()
    demo_train()
