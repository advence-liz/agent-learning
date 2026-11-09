from cost_routing.ledger import SCENARIOS, prompts, run, usages


def total(name):
    return run(next(s for s in SCENARIOS if s.name == name)).spent()


def test_input_grows_linearly_cumulative_quadratically():
    ps = prompts(truncate=False)
    steps = {b - a for a, b in zip(ps, ps[1:])}
    assert len(steps) == 1  # 每圈多出来的量相同：线性
    assert sum(ps) > 4 * ps[0] * len(ps)  # 累计远超「每圈都和第一圈一样长」


def test_cache_usage_shape():
    s = next(s for s in SCENARIOS if s.cache and not s.truncate and not s.prefix_breaks)
    us, ps = usages(s), prompts(False)
    assert us[0].write_5m == ps[0] and us[0].cache_read == 0
    for i in range(1, len(us)):
        assert us[i].cache_read == ps[i - 1]  # 读到上一圈的全部
        assert us[i].prompt == ps[i]  # 三项之和 = 本圈输入总量


def test_ordering_of_scenarios():
    base = total("不缓存 · 不截断")
    assert total("缓存 · 截断工具结果") < total("缓存 · 不截断") < total("不缓存 · 截断工具结果") < base
    # 前缀每圈都变：每圈全量写缓存，比不开缓存还贵 25%
    assert abs(total("缓存，但前缀每圈都变") / base - 1.25) < 0.05
