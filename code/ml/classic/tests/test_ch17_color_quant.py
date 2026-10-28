import numpy as np
from sklearn.cluster import KMeans

from classic.ch16_kmeans import kmeans
from classic.ch17_color_quant import load_pixels, psnr, quantize


def test_same_init_matches_sklearn_on_pixels():
    _, px = load_pixels()
    rng = np.random.default_rng(0)
    sample = px[rng.choice(len(px), 5000, replace=False)]
    init = sample[:8]
    C, labels, inertia, _, _ = kmeans(sample, 8, init=init, tol=0)
    sk = KMeans(8, init=init, n_init=1, algorithm="lloyd", tol=0).fit(sample)
    assert np.isclose(inertia, sk.inertia_, rtol=1e-6)
    np.testing.assert_allclose(C, sk.cluster_centers_, atol=1e-6)


def test_more_colors_better_quality():
    _, px = load_pixels()
    q = []
    for k in (2, 8, 32):
        C, labels, _ = quantize(px, k, n_sample=3000)
        q.append(psnr(px, C[labels]))
    assert q[0] < q[1] < q[2]
