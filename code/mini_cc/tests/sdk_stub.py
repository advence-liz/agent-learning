"""一个假的 anthropic SDK 对象：只实现 AnthropicClient 用到的那几个属性，用来测适配层。不联网。"""

from types import SimpleNamespace


class _Block(SimpleNamespace):
    def to_dict(self):
        return dict(self.__dict__)


class _Usage(SimpleNamespace):
    def to_dict(self):
        return dict(self.__dict__)


class _Stream:
    def __init__(self, events, final, error=None):
        self._events, self._final, self._error = events, final, error

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def __iter__(self):
        for e in self._events:
            yield e
        if self._error:
            raise self._error

    def get_final_message(self):
        return self._final


class StubSDK:
    """stub.messages.stream(**kw) 依次返回 responses 里的结果；收到的 kwargs 存在 calls。"""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.messages = SimpleNamespace(stream=self._stream)
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self._stream))

    def _stream(self, **kw):
        self.calls.append(kw)
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def text_stream(text, stop_reason="end_turn", thinking=None, extra_blocks=(), error=None):
    events = []
    blocks = []
    if thinking:
        events.append(SimpleNamespace(type="thinking", thinking=thinking))
        blocks.append(_Block(type="thinking", thinking=thinking, signature="sig"))
    events += [SimpleNamespace(type="text", text=c) for c in (text[:3], text[3:])]
    blocks.append(_Block(type="text", text=text))
    blocks += [_Block(**b) for b in extra_blocks]
    final = SimpleNamespace(content=blocks, stop_reason=stop_reason,
                            usage=_Usage(input_tokens=10, output_tokens=5))
    return _Stream(events, final, error)
