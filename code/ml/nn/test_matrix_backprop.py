import numpy as np
import torch

from matrix_backprop import forward_backward


def test_matrix_backprop_matches_torch():
    rng = np.random.default_rng(0)
    X = rng.normal(size=(32, 5))
    y = (rng.random(32) > 0.5).astype(float)
    W1, b1 = rng.normal(size=(5, 16)), rng.normal(size=16)
    W2, b2 = rng.normal(size=(16, 1)), rng.normal(size=1)

    loss, grads = forward_backward(X, y, W1, b1, W2, b2)

    ts = [torch.tensor(a, requires_grad=True) for a in (W1, b1, W2, b2)]
    tW1, tb1, tW2, tb2 = ts
    Z = (torch.relu(torch.tensor(X) @ tW1 + tb1) @ tW2 + tb2).ravel()
    tloss = torch.nn.functional.binary_cross_entropy_with_logits(Z, torch.tensor(y))
    tloss.backward()

    assert np.isclose(loss, tloss.item())
    for g, t in zip(grads, ts):
        assert np.allclose(g, t.grad.numpy(), atol=1e-10)
