import math
import random

import pytest
import torch

from micrograd import MLP, Value, bce_with_logit


def test_simple_chain_matches_hand_calculation():
    a, b, c = Value(2.0), Value(-3.0), Value(10.0)
    L = (a * b + c).relu() ** 2          # (2*-3+10)^2 = 16
    L.backward()
    assert L.data == 16
    # dL/d(ab+c) = 2*4 = 8；dL/da = 8*b = -24；dL/db = 8*a = 16；dL/dc = 8
    assert (a.grad, b.grad, c.grad) == (-24, 16, 8)


def test_reused_node_accumulates_grad():
    # x 被用了两次：y = x*x + x，dy/dx = 2x + 1
    x = Value(3.0)
    y = x * x + x
    y.backward()
    assert x.grad == 7


def _torch_version(fn, *vals):
    ts = [torch.tensor(v, dtype=torch.float64, requires_grad=True) for v in vals]
    out = fn(*ts)
    out.backward()
    return out.item(), [t.grad.item() for t in ts]


EXPRS = {
    "poly": lambda a, b: (a * b + a ** 3 - b / a) * 2,
    "tanh": lambda a, b: (a * b).tanh() + (a - b) ** 2,
    "exp_log": lambda a, b: (a.exp() + b.exp()).log() * a,
    "relu_mix": lambda a, b: (a - 2 * b).relu() * (b + 1).relu() + 1 / (a * a + 1),
}


def _torch_ops(name):
    # 同一个表达式在 torch 里的写法（tanh/exp/log/relu 是方法调用，形式一致）
    return EXPRS[name]


@pytest.mark.parametrize("name", list(EXPRS))
@pytest.mark.parametrize("a,b", [(1.5, -0.7), (-2.0, 0.3), (0.4, 1.9)])
def test_grad_matches_torch(name, a, b):
    va, vb = Value(a), Value(b)
    out = EXPRS[name](va, vb)
    out.backward()
    t_out, (ga, gb) = _torch_version(_torch_ops(name), a, b)
    assert out.data == pytest.approx(t_out, rel=1e-9)
    assert va.grad == pytest.approx(ga, rel=1e-9, abs=1e-12)
    assert vb.grad == pytest.approx(gb, rel=1e-9, abs=1e-12)


def test_mlp_param_grads_match_torch():
    random.seed(0)
    model = MLP(3, [4, 4, 1])
    x = [0.5, -1.2, 2.0]
    y = 1
    loss = bce_with_logit(model([Value(v) for v in x]), y)
    model.zero_grad()
    loss.backward()

    # 把同样的权重搬进 torch，算同一个 loss
    tparams = [torch.tensor(p.data, dtype=torch.float64, requires_grad=True) for p in model.parameters()]
    it = iter(tparams)
    h = [torch.tensor(v, dtype=torch.float64) for v in x]
    for li, layer in enumerate(model.layers):
        new_h = []
        for n in layer.neurons:
            ws = [next(it) for _ in n.w]
            b = next(it)
            act = sum((w * xi for w, xi in zip(ws, h)), b)
            new_h.append(torch.relu(act) if n.nonlin else act)
        h = new_h
    z = h[0]
    tloss = torch.nn.functional.binary_cross_entropy_with_logits(z, torch.tensor(float(y), dtype=torch.float64))
    tloss.backward()

    assert loss.data == pytest.approx(tloss.item(), rel=1e-9)
    for p, tp in zip(model.parameters(), tparams):
        assert p.grad == pytest.approx(tp.grad.item(), rel=1e-7, abs=1e-12)


def test_numerical_gradient_check():
    # 不依赖 torch 的另一种验证：有限差分
    f = lambda a: ((a * 3).tanh() * a + a.exp()).log()  # noqa: E731
    x0, eps = 0.37, 1e-6
    v = Value(x0)
    f(v).backward()
    num = (f(Value(x0 + eps)).data - f(Value(x0 - eps)).data) / (2 * eps)
    assert math.isclose(v.grad, num, rel_tol=1e-6)
