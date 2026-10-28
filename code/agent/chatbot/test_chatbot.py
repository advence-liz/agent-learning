from chatbot.bot import Chatbot
from fake_llm import FakeAnthropic, text


def test_memory_is_the_messages_array():
    client = FakeAnthropic([text("你好小林"), text("你叫小林")])
    bot = Chatbot(client, system="S")
    bot.send("我叫小林")
    bot.send("我叫什么？")

    # 第二次请求时，模型看到的是完整历史：user / assistant / user
    second = client.calls[1]
    roles = [m["role"] for m in second["messages"]]
    assert roles == ["user", "assistant", "user"]
    assert second["messages"][0]["content"] == "我叫小林"
    assert second["system"] == "S"


def test_reset_forgets_everything():
    client = FakeAnthropic([text("a"), text("b")])
    bot = Chatbot(client)
    bot.send("我叫小林")
    bot.reset(system="你是一只猫")
    bot.send("我叫什么？")
    assert len(client.calls[1]["messages"]) == 1  # 没有任何历史
    assert client.calls[1]["system"] == "你是一只猫"
