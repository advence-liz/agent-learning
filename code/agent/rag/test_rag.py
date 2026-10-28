from rag.rag import Index, answer, build_prompt, chunk_markdown, DOCS
from fake_llm import FakeAnthropic, text


def test_chunks_carry_title():
    chunks = chunk_markdown(DOCS / "refund.md")
    assert len(chunks) == 3
    assert all(c.text.startswith("【退款政策】") for c in chunks)


def test_retrieval_top1():
    idx = Index.from_dir()
    cases = {
        "会员多少钱": "membership.md",
        "能不能导出我的数据": "export.md",
        "忘记密码怎么办": "account.md",
        "蓝牙连不上": "device.md",
        "可以退钱吗": "refund.md",
        "支持日语吗": "recognition.md",
    }
    for q, src in cases.items():
        assert idx.search(q, 1)[0][1].source.startswith(src), q


def test_prompt_contains_only_topk_docs():
    idx = Index.from_dir()
    client = FakeAnthropic([text("39 元 [1]")])
    reply, hits = answer(client, idx, "会员多少钱", k=2)
    sent = client.calls[0]["messages"][0]["content"]
    assert sent.count("<doc ") == 2
    assert "资料中没有相关说明" in client.calls[0]["system"]
    assert reply == "39 元 [1]"
    assert build_prompt("q", hits).endswith("问题：q")
