# 详解 LLM API 的流式响应模式

> 对应原站：[详解 LLM API 的流式响应模式](https://labuladong.online/zh/ai-coding/basics/streaming-response/)（会员内容；本章为独立原创重写）

> **一句话结论**：模型本来就是一个 token 一个 token 生成的；流式响应用 SSE（Server-Sent Events）把每一小段立刻推给你。拼装规则很简单：按 `index` 把 `content_block_delta` 追加到对应的块里；`tool_use` 的参数是一串 `input_json_delta` 片段，**只有到 `content_block_stop` 才保证是合法 JSON**。

你在 webapp 里做过聊天界面就知道：用户发完消息，如果要等十几秒才一下子出现整段回复，体验会非常差。所以前端都会做「打字机效果」。

你可能会问：这个效果是前端拿到完整回复后慢慢「演」出来的，还是后端真的一点点发过来的？

是真的一点点发过来的。第 0 部分讲过，LLM 的生成过程就是「预测下一个 token → 拼到末尾 → 再预测」，它本来就不是想好一整段才开口。流式响应只是把这个过程如实地透传给你：生成一段，推一段。

## 先跑起来看看

代码在 [`code/agent-node/streaming/sse.ts`](../code/agent-node/streaming/sse.ts)（Python 版 [`sse.py`](../code/agent/streaming/sse.py)）。两版共用同一个 [`fixture.sse`](../code/agent/streaming/fixture.sse)，它是我按 Messages API 的流式事件格式手工构造的一段响应（**不是**真实录制，因为本教程不发真实请求）：模型先说一句话，再调用 `write_file` 工具。

=== "Node"

    ```text
    $ node streaming/sse.ts --sdk
    message_start        开始 id=msg_stream_01 input_tokens=412
    content_block_start  [0] text 块开始
    ping                 ping（心跳，忽略）
    content_block_delta  [0] +"找到"           → 找到
    content_block_delta  [0] +"原因了："         → 找到原因了：
    content_block_delta  [0] +"add 写成了"      → 找到原因了：add 写成了
    content_block_delta  [0] +"减法，我来"        → 找到原因了：add 写成了减法，我来
    content_block_delta  [0] +"修正。"          → 找到原因了：add 写成了减法，我来修正。
    content_block_stop   [0] 块结束
    content_block_start  [1] tool_use 开始 name=write_file（参数还没来）
    content_block_delta  [1] +""                               缓冲区能解析吗？✘
    content_block_delta  [1] +"{\"path\": \"ca"                缓冲区能解析吗？✘
    content_block_delta  [1] +"lc.py\", \"con"                 缓冲区能解析吗？✘
    content_block_delta  [1] +"tent\": \"def add(a, b):\\n    re" 缓冲区能解析吗？✘
    content_block_delta  [1] +"turn a + b\\n\"}"               缓冲区能解析吗？✔
    content_block_stop   [1] tool_use 结束 → input={"path":"calc.py","content":"def add(a, b):\n    return a + b\n"}
    message_delta        message_delta stop_reason=tool_use output_tokens=58
    message_stop         结束
    ...
    SDK final message 的 tool_use.input： { path: 'calc.py', content: 'def add(a, b):\n    return a + b\n' }
    与手写拼装一致： true
    ```

=== "Python"

    ```text
    $ uv run python -m streaming.sse --sdk
    message_start        开始 id=msg_stream_01 input_tokens=412
    content_block_start  [0] text 块开始
    ping                 ping（心跳，忽略）
    content_block_delta  [0] +'找到'           → 找到
    content_block_delta  [0] +'原因了：'         → 找到原因了：
    content_block_delta  [0] +'add 写成了'      → 找到原因了：add 写成了
    content_block_delta  [0] +'减法，我来'        → 找到原因了：add 写成了减法，我来
    content_block_delta  [0] +'修正。'          → 找到原因了：add 写成了减法，我来修正。
    content_block_stop   [0] 块结束
    content_block_start  [1] tool_use 开始 name=write_file（参数还没来）
    content_block_delta  [1] +''                               缓冲区能解析吗？✘
    content_block_delta  [1] +'{"path": "ca'                   缓冲区能解析吗？✘
    content_block_delta  [1] +'lc.py", "con'                   缓冲区能解析吗？✘
    content_block_delta  [1] +'tent": "def add(a, b):\\n    re' 缓冲区能解析吗？✘
    content_block_delta  [1] +'turn a + b\\n"}'                缓冲区能解析吗？✔
    content_block_stop   [1] tool_use 结束 → input={'path': 'calc.py', 'content': 'def add(a, b):\n    return a + b\n'}
    message_delta        message_delta stop_reason=tool_use output_tokens=58
    message_stop         结束
    ...
    SDK final message 的 tool_use.input： {'path': 'calc.py', 'content': 'def add(a, b):\n    return a + b\n'}
    与手写拼装一致： True
    ```

最后一行很重要：我把**同一段字节**喂给了真实的 SDK（Node 版通过构造参数里的自定义 `fetch` 喂给 `@anthropic-ai/sdk`，Python 版通过 `httpx2.MockTransport` 喂给 `anthropic`；请求被拦在本地，没有发出去），SDK 用 `messages.stream()` + `finalMessage()`（Python 是 `get_final_message()`）拼出来的结果，和我们手写的拼装器完全一致。

## SSE：一种很朴素的文本协议

先看原始字节长什么样（`fixture.sse` 开头）：

```text
event: message_start
data: {"type": "message_start", "message": {"id": "msg_stream_01", ..., "content": [], "stop_reason": null, "usage": {"input_tokens": 412, "output_tokens": 1}}}

event: content_block_start
data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}

event: ping
data: {"type": "ping"}
```

规则就三条：每行是 `字段: 值`；`event:` 是事件名，`data:` 是负载；**空行**表示一个事件结束。以冒号开头的行是注释，常被拿来当心跳。

=== "Node"

    ```ts
    function* parseSse(lines) {
      let event = "message", data = [];
      for (const raw of lines) {
        const line = raw.replace(/\r?\n$/, "");
        if (line === "") {                   // 空行 = 一个事件结束
          if (data.length) yield [event, JSON.parse(data.join("\n"))];
          [event, data] = ["message", []];
        } else if (line.startsWith(":")) {   // 注释行
          continue;
        } else {
          const i = line.indexOf(":");
          const field = i === -1 ? line : line.slice(0, i);
          let value = i === -1 ? "" : line.slice(i + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "event") event = value;
          else if (field === "data") data.push(value);   // 多行 data 要用 \n 拼回去
        }
      }
    }
    ```

=== "Python"

    ```python
    def parse_sse(lines):
        event, data = "message", []
        for raw in lines:
            line = raw.rstrip("\r\n")
            if line == "":                     # 空行 = 一个事件结束
                if data:
                    yield event, json.loads("\n".join(data))
                event, data = "message", []
            elif line.startswith(":"):         # 注释行
                continue
            else:
                field, _, value = line.partition(":")
                value = value.removeprefix(" ")
                if field == "event":
                    event = value
                elif field == "data":
                    data.append(value)          # 多行 data 要用 \n 拼回去
    ```

你可能会问：浏览器不是有 `EventSource` 吗，为什么还要自己解析？

因为 `EventSource` 只支持 GET，没法带请求体，也不能自定义 `x-api-key` 这类请求头。调 LLM API 都是 POST，所以前端实际上用的是 `fetch` + `ReadableStream`，自己按空行切事件。这里有一个坑：**网络 chunk 的边界和事件边界毫无关系**，一个 chunk 可能切在一个汉字的 UTF-8 字节中间。所以要先按字节缓冲、凑齐一行再解码：

=== "Node"

    ```ts
    function* linesFromChunks(chunks) {
      let buf = Buffer.alloc(0);
      for (const c of chunks) {
        buf = Buffer.concat([buf, c]);
        let nl;
        while ((nl = buf.indexOf(0x0a)) !== -1) {     // 按字节找 \n，凑齐一行再解码
          yield buf.subarray(0, nl).toString("utf8") + "\n";
          buf = buf.subarray(nl + 1);
        }
      }
    }
    ```

=== "Python"

    ```python
    def lines_from_chunks(chunks):
        buf = b""
        for c in chunks:
            buf += c
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                yield line.decode("utf-8") + "\n"
    ```

测试里把 fixture 切成每块 1、3、7、64 字节分别喂进去，拼出来的结果都一样。

## 事件序列：一个状态机

```d2
direction: down
start: "" {shape: circle; width: 16; height: 16; style.fill: "#333"}
end: "" {shape: circle; width: 16; height: 16; style.fill: "#333"; style.double-border: true}
message_start: message_start
content_block_start: content_block_start
content_block_delta: content_block_delta
content_block_stop: content_block_stop
message_delta: message_delta
message_stop: message_stop
note: "text_delta / input_json_delta /\nthinking_delta / signature_delta" {shape: page}
start -> message_start
message_start -> content_block_start
content_block_start -> content_block_delta
content_block_delta -> content_block_delta
content_block_delta -> content_block_stop
content_block_stop -> content_block_start: 下一个块
content_block_stop -> message_delta
message_delta -> message_stop
message_stop -> end
content_block_delta -- note {style.stroke-dash: 3}
```

把它想成在前端维护一个数组 `content`：

- `message_start`：拿到消息骨架，`content` 是空数组，`usage.input_tokens` 已经有了（输入是提前知道的）。
- `content_block_start`：往 `content` 里放一个新块，`index` 就是它的下标。
- `content_block_delta`：按 `index` 找到块，往里追加。文本块追加 `text_delta.text`；工具块追加 `input_json_delta.partial_json`。
- `content_block_stop`：这个块收尾。
- `message_delta`：**`stop_reason` 在这里才出现**，还有最终的 `output_tokens`（是累计值，直接覆盖，别累加）。
- `message_stop`：结束。

中间随时可能插进 `ping`（心跳），也可能来一个 `error` 事件（比如服务过载），所以流式代码一定要能处理「流到一半失败」。

一个类比：这像在看一场体育直播的文字解说。`message_start` 是「比赛开始」，每个 `content_block` 是一节比赛，`delta` 是一条条实时播报，`message_delta` 是终场哨响后报出的比分。

类比不成立的地方：直播的每条播报本身都是完整的句子，而 `input_json_delta` 的每个片段**单独看毫无意义**，`{"path": "ca` 不是任何合法的东西。

## 流式下怎么拼 tool_use 参数

这是本章最容易出错的地方。看上面的输出，`write_file` 的参数分 5 段到达，前 4 段拼起来都不是合法 JSON，只有最后一段到了才能解析。

=== "Node"

    ```ts
    if (d.type === "input_json_delta") {
      this.jsonBuf.set(i, this.jsonBuf.get(i) + d.partial_json);   // 只拼字符串，不解析
    }
    ...
    if (t === "content_block_stop") {
      if (this.jsonBuf.has(i)) {
        const raw = this.jsonBuf.get(i);
        this.jsonBuf.delete(i);
        this.message.content[i].input = raw ? JSON.parse(raw) : {};   // 到 stop 才解析
      }
    }
    ```

=== "Python"

    ```python
    if d["type"] == "input_json_delta":
        self._json_buf[i] += d["partial_json"]          # 只拼字符串，不解析
    ...
    if t == "content_block_stop":
        if i in self._json_buf:
            raw = self._json_buf.pop(i)
            self.message["content"][i]["input"] = json.loads(raw) if raw else {}   # 到 stop 才解析
    ```

你可能会问：如果我想在界面上实时显示「模型正在写的文件内容」，难道也要等到 stop？

显示可以不等，执行必须等。显示用的是**容错的 partial JSON 解析器**：对不完整的 JSON 尽量猜出一个部分对象（比如把 `{"path": "calc.py", "con` 解析成 `{"path": "calc.py"}`），只用于显示。真正执行工具，还是要等完整的输入。Anthropic Python SDK 内部就有这样的解析器：`stream` 里的 `input_json` 事件除了 `partial_json`，还带一个 `snapshot` 字段，是「当前已累积部分的解析结果」（见 `anthropic/lib/streaming/_types.py` 的 `InputJsonEvent`）。Node SDK 也一样：`stream.on("inputJson", (partialJson, jsonSnapshot) => ...)` 的第二个参数就是这个快照（见 `@anthropic-ai/sdk/lib/MessageStream.d.ts`）。

还有一个和延迟相关的开关：默认情况下，API 会把每个工具参数**缓冲并校验**后才开始发 `input_json_delta`，所以小参数看起来是一次性到的。在工具定义上设 `eager_input_streaming: true`，参数会边生成边推送，但服务端不再替你校验，拼出来的 JSON 可能是不完整（撞上 `max_tokens`）或非法的。这时执行前必须自己按 schema 校验，并先检查 `stop_reason` 是不是 `max_tokens`（依据：`claude-api` skill 的 tool-use 概念文档）。

还有两个和 SDK 对比时发现的细节：

- 真实 SDK 产出的事件里**没有 `ping`**，它把心跳吞掉了；Python SDK 还额外合成了 `text` 和 `input_json` 两种便利事件（每个 delta 后面跟一个）。Node SDK 的 `for await` 只给原始事件，便利事件要用 `stream.on("text")` / `stream.on("inputJson")` 订阅。
- SDK 的 `finalMessage()`（Python 是 `get_final_message()`）就是在做我们手写的 `Accumulator` 做的事。生产代码直接用它，别自己拼。

=== "Node"

    ```text
    $ node --test 'streaming/*.test.ts'
    ✔ tool 参数只在 content_block_stop 时拼成
    ✔ 任意切分网络 chunk 结果都一样
    ✔ SSE 多行 data 和注释行
    ✔ 和真实 SDK 的拼装结果一致
    ℹ pass 4
    ```

=== "Python"

    ```text
    $ uv run pytest -q streaming
    ....                                                                     [100%]
    4 passed in 0.39s
    ```

**回到主线**：流式不改变上下文里放什么，也不省 token。它改变的是**等待的体验**和**超时的风险**：长输出不再是一个十分钟不吭声的 HTTP 请求。顺带地，客户端随时掌握「已经生成到哪了」，才谈得上「生成到一半时打断」这种交互。

## 对照你的环境

- 你在 webapp 里接任何 LLM 流式接口，后端到浏览器之间的每一层都可能缓冲：Nginx 默认会缓冲代理响应，常见做法是加 `X-Accel-Buffering: no` 响应头或关掉 `proxy_buffering`；CDN 和 gzip 压缩也会攒够一批再发。症状是「本地是流式的，上线后变成一次性返回」。
- Claude Code 的 `claude -p --output-format stream-json` 也是一行一个 JSON 的流（第 6 章 SDK 就是读它）。加上 `--include-partial-messages` 会把部分消息块也吐出来，这正是本章这些 delta 事件在 CLI 层面的样子。

## 常见坑

1. **在 delta 里解析 tool 参数**。不到 `content_block_stop` 不保证是合法 JSON。
2. **把 `output_tokens` 累加**。`message_delta.usage.output_tokens` 是累计值。
3. **按 chunk 而不是按行解析**。chunk 可能切在事件中间、甚至切在一个汉字的字节中间。
4. **忘了流中途的 `error` 事件**。HTTP 状态码已经是 200 了，错误只能在流里发现。
5. **以为 `stop_reason` 在开头就有**。它在 `message_delta` 里，接近结尾才来。

## 练习

1. 给 `Accumulator` 加上 `thinking` 块的支持（`thinking_delta` 和 `signature_delta`），自己在 fixture 里构造一个 thinking 块验证。
2. 写一个「容错 partial JSON」函数：输入 `'{"path": "calc.py", "con'`，返回 `{"path": "calc.py"}`。用 fixture 的每一步做测试。
3. 开放题：如果前端要在 `write_file` 参数还在流式到达时就实时预览文件内容，同时保证最终执行的一定是完整参数，你会怎么设计前端状态？

## 延伸阅读

- Streaming Messages：<https://platform.claude.com/docs/en/build-with-claude/streaming>
- Tool use 概览（含工具参数流式相关说明的入口）：<https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview>
- SSE 规范（WHATWG）：<https://html.spec.whatwg.org/multipage/server-sent-events.html>
- 本库：[LLM 是怎么预测下一个 token 的](../p0-core/04-llm-token-prediction.md) · [Agent 循环的逐步输出](../p4-mini-cc/02-realtime-output.md) · 下一章 [动手开发 MCP 工具](./10-mcp-tool.md)

回到开头的问题：打字机效果不是前端演的，是模型真的一个 token 一个 token 生成、服务端用 SSE 一段一段推过来的。前端要做的，只是按 `index` 把它们拼回去，并且在 `content_block_stop` 之前别急着执行工具。
