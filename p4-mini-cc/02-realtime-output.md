# Agent 循环的逐步输出

> 对应原站：[Agent 循环的逐步输出](https://labuladong.online/zh/ai-coding/coding-agent/realtime-output/)（会员内容；本章为独立原创重写）

> **一句话结论**：把 agent 循环从「跑完再返回」改成「生成器，每发生一件事就 yield 一个事件」，UI 边收边画——实时输出顺带把循环拆成了可以插钩子的节点，后面的权限、重试、注入全都挂在这些节点上。

## 为什么屏幕上少了一句话

上一章结尾留了个现象：剧本里模型在调 `Bash` 之前说了一句「我先看看目录。」，终端上却没有。

你可能会问：这不就是少打印了一行吗，有那么要紧？

在演示里不要紧，在真实使用里很要紧。真模型做一个稍复杂的任务，一轮可能有十几次工具调用、几分钟时长。阻塞式的 `run()` 在这几分钟里终端一片空白，最后一口气吐出一堆东西。你没法在它读错文件的第一秒按 Ctrl+C，也看不到它「为什么」要跑那条命令。

用 Claude Code 时你习惯的体验是：思考摘要一行行冒出来，`⏺ Bash(npm test)` 出现，紧接着结果折叠显示。这种体验的前提是**循环本身是可观察的**。

## 先跑起来看看

离线 fake 模型（`examples/ch02.json`：两次 `Bash`，最后一次回复带一段 thinking）：

=== "Node"

    ```console
    $ printf 'agent 循环写在哪个文件？\n' | node mini_cc/cli.ts --fake examples/ch02.json
    ❯ agent 循环写在哪个文件？
    ◇ system  项目说明 0 个文件、git 快照
    ◇ system  日期 2026-10-22
    ● 我先看看包里有哪些模块。
    ⏺ Bash(ls mini_cc)
    ✔ Bash -> attachments.ts
      auto_mode.ts
      cli.ts  …(+12 lines)
    ● 循环在 loop.ts，看看它多长。
    ⏺ Bash(wc -l mini_cc/loop.ts)
    ✔ Bash ->      329 mini_cc/loop.ts
    ✻ 用户想知道循环在哪，两次工具调用已经足够回答。
    ● agent 循环在 mini_cc/loop.ts，核心是 Agent.runTurn 这个异步生成器。
    ```

=== "Python"

    ```console
    $ printf 'agent 循环写在哪个文件？\n' | uv run python -m mini_cc --fake examples/ch02.json
    ❯ agent 循环写在哪个文件？
    ● 我先看看包里有哪些模块。
    ⏺ Bash(ls mini_cc)
    ✔ Bash -> __init__.py
      __main__.py
      __pycache__  …(+7 lines)
    ● 循环在 loop.py，看看它多长。
    ⏺ Bash(wc -l mini_cc/loop.py)
    ✔ Bash ->      125 mini_cc/loop.py
    ✻ 用户想知道循环在哪，两次工具调用已经足够回答。
    ● agent 循环在 mini_cc/loop.py，核心是 Agent.run_turn 这个生成器。
    ```

`●` 是模型文本，`✻` 是思考摘要，`⏺` 是工具调用，`✔`/`✘` 是工具返回（只预览前 3 行）。在真终端里，`●` 后面的字是 4 个字符一组「流」出来的（`FakeClient.CHUNK = 4`），管道输出看不出这个效果。

## 原理：两层流

这里其实有两层「流」，别混在一起：

```d2
shape: sequence_diagram
ui: "ConsoleUI"
l: "Agent.run_turn（生成器）"
m: "ModelClient.stream"
t: "Tool.run"
ui -> l: "for ev in run_turn(prompt)"
l -> m: "stream(request)"
m -> l: "ThinkingDelta / TextDelta …（token 级）" {style.stroke-dash: 3}
l -> ui: "原样 yield，UI 立刻打印" {style.stroke-dash: 3}
m -> l: "MessageDone(content, stop_reason)" {style.stroke-dash: 3}
l -> ui: "ToolStart" {style.stroke-dash: 3}
l -> t: "run(args)"
t -> l: "ToolResult" {style.stroke-dash: 3}
l -> ui: "ToolEnd" {style.stroke-dash: 3}
l -> m: "下一次 stream(...)"
m -> l: "… MessageDone(end_turn)" {style.stroke-dash: 3}
l -> ui: "TurnEnd" {style.stroke-dash: 3}
```

图注：内层是**模型的 token 流**（SSE 事件 → `TextDelta`），外层是**循环的步骤流**（工具开始/结束、一轮结束）。`run_turn` 把两层合并成一条事件序列交给 UI。

打个比方：以前的 `run()` 像寄快递——打包好了一次性送达；现在的 `run_turn()` 像直播——发生什么播什么。这个比方不成立的地方在于：直播没法「撤回」，而我们的历史记录（`self.messages`）**只在一次模型调用完整结束后**才写入。流出去的增量只是给人看的，下一章断网重试时，这个区分就是能安全重试的关键。

你可能会问：Python 为什么用生成器，而不是回调 `on_text=...`？

两个理由（Node 版用异步生成器，理由完全一样）。第一，生成器是**惰性**的：调用方不 `next()`，循环就停在那里——这让「暂停下来问用户要不要放行这个工具」（第 5 章）变得自然。第二，事件是**数据**：测试可以 `list(run_turn(...))` 直接断言事件顺序，持久化可以订阅同一条流。

**回到主线**：这一章没有改变上下文里的任何一个 token。它改的是「人能不能看着上下文一点点长出来」。可观察性本身不省 token，但它让你能在模型跑偏的第一时间打断，省下的是**后面那一大串本不该发生的上下文**。

## 把阻塞调用拆开

### 模型层：`create()` 变 `stream()`

`mini_cc/model.ts`（Python 版 `model.py`）的协议从第 1 章的 `create(req) -> ModelResponse` 换成：

=== "Node"

    ```ts
    interface ModelClient {
      model: string;
      stream(req: ModelRequest): AsyncIterable<ModelEvent>;
      // ModelEvent = TextDelta | ThinkingDelta | MessageDone，最后一个一定是 MessageDone
    }
    ```

=== "Python"

    ```python
    class ModelClient(Protocol):
        model: str
        def stream(self, req: ModelRequest) -> Iterator[ModelEvent]: ...
        # ModelEvent = TextDelta | ThinkingDelta | MessageDone，最后一个一定是 MessageDone
    ```

真实实现 `AnthropicClient.stream()` 用的是 SDK 的 `messages.stream()` 辅助方法——它帮我们把 SSE 的 `content_block_delta` 累积好，循环里只看高层事件（Node 版 SDK 同样会累积出 `finalMessage()`，但 `for await` 迭代出的是原始 SSE 事件，所以要自己挑出 `text_delta` / `thinking_delta`）：

=== "Node"

    ```ts
    async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
      const s = this.sdk.messages.stream(this.kwargs(req));
      for await (const ev of s) {                  // 迭代出来的是原始 SSE 事件
        if (ev.type !== "content_block_delta") continue;
        if (ev.delta.type === "text_delta") yield { type: "TextDelta", text: ev.delta.text };
        else if (ev.delta.type === "thinking_delta") yield { type: "ThinkingDelta", text: ev.delta.thinking };
      }
      const final = await s.finalMessage();
      yield { type: "MessageDone", content: final.content,
              stopReason: final.stop_reason, usage: final.usage };
    }
    ```

=== "Python"

    ```python
    def stream(self, req):
        with self._sdk.messages.stream(**self._kwargs(req)) as s:
            for ev in s:
                if ev.type == "text":
                    yield TextDelta(ev.text)
                elif ev.type == "thinking":
                    yield ThinkingDelta(ev.thinking)
            final = s.get_final_message()
        yield MessageDone(content=[b.to_dict() for b in final.content],
                          stop_reason=final.stop_reason, usage=final.usage.to_dict())
    ```

`_kwargs()` 里有两个和流式相关的细节：

- `thinking={"type": "adaptive", "display": "summarized"}`。`claude-opus-5-5` 的思考永远开着（显式关掉会 400），但 `display` 默认是 `"omitted"`——思考块的文本是空字符串。不改成 `summarized`，用户看到的就是「一段长时间的停顿，然后突然出字」。
- 每个工具加上 `eager_input_streaming: True`。比如 `Write` 要写一个 500 行的文件，参数会边生成边流过来，而不是等服务端缓冲完一次性到达。代价是**服务端不再校验参数**，所以下一章要在执行工具前自己做校验。

不需要中间过程的地方（auto 模式的审查员、压缩摘要）用 `complete(client, req)`，它只是把流消费完、返回 `MessageDone`。

### 循环层：`run()` 变 `run_turn()`

`mini_cc/loop.ts:Agent.runTurn`（Python 版 `loop.py:Agent.run_turn`；Node 版是 `async function*`，调用方用 `for await` 消费）：

=== "Node"

    ```ts
    async *runTurn(prompt: string | Block[]): AsyncGenerator<Event> {
      this.messages.push({ role: "user", content: prompt });
      for (let i = 0; i < this.settings.maxIterations; i++) {
        let done: MessageDone | null = null;
        for await (const ev of this.callModel()) {
          if (ev.type === "MessageDone") done = ev;
          else yield ev;                           // token 级增量，原样转发
        }
        this.usage.add(done!.usage);
        this.messages.push({ role: "assistant", content: done!.content });
        const toolUses = done!.content.filter((b) => b.type === "tool_use");
        if (done!.stopReason !== "tool_use" || !toolUses.length) {
          yield turnEnd(done!.stopReason, done!.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
          return;
        }
        yield* this.runTools(toolUses);            // 每个工具 yield ToolStart / ToolEnd
      }
      yield turnEnd("max_iterations", "[stopped: max_iterations reached]");
    }
    ```

=== "Python"

    ```python
    def run_turn(self, prompt):
        self.messages.append({"role": "user", "content": prompt})
        for _ in range(self.settings.max_iterations):
            done = None
            for ev in self._call_model():
                if isinstance(ev, MessageDone):
                    done = ev
                else:
                    yield ev                      # token 级增量，原样转发
            self.usage.add(done.usage)
            self.messages.append({"role": "assistant", "content": done.content})
            tool_uses = [b for b in done.content if b["type"] == "tool_use"]
            if done.stop_reason != "tool_use" or not tool_uses:
                yield TurnEnd(done.stop_reason, "".join(b["text"] for b in done.content if b["type"] == "text"))
                return
            yield from self._run_tools(tool_uses)   # 每个工具 yield ToolStart / ToolEnd
        yield TurnEnd("max_iterations", "[stopped: max_iterations reached]")
    ```

和第 1 章对比，结构一模一样，只是把「攒起来」换成了「yield 出去」。说穿了就是**把 return 改成 yield**。

我刻意把一次模型调用包成 `_call_model()`、把工具执行包成 `_run_tools()`。现在它们只是转发，但它们就是后面几章的插槽：

| 节点 | 谁会挂上来 |
|---|---|
| `_call_model` | 第 3 章重试；第 9 章请求前注入提醒；第 14 章压缩 |
| `_run_tools` 每个工具执行前 | 第 3 章参数校验；第 5–6 章权限；第 21 章 plan 模式 |
| `run_turn` 结束 | 第 4 章落盘 |

事件类型在 `mini_cc/events.py`：`ToolStart`、`ToolEnd`、`Notice`、`TurnEnd`，加上从模型层透传的 `TextDelta` / `ThinkingDelta`。

### UI 层：一个小状态机

`mini_cc/ui.ts:BufferUI.render`（Python 版 `ui.py:BufferUI.render`）要处理的唯一难点是：连续的 `TextDelta` 要拼在同一行，遇到别的事件时先换行。所以它记住「当前正在流的是哪种块」：

=== "Node"

    ```ts
    render(ev: Event): void {
      switch (ev.type) {
        case "TextDelta":
          this.startStream("text", "● ");        // 块类型变了才另起一行
          this.write(ev.text);
          break;
        case "ToolStart":
          this.info(`⏺ ${ev.summary}`);           // info() 会先 endStream()
          break;
        // ...
      }
    }
    ```

=== "Python"

    ```python
    def render(self, ev):
        if isinstance(ev, TextDelta):
            self._start_stream("text", "● ")   # 块类型变了才另起一行
            self._write(ev.text)
        elif isinstance(ev, ToolStart):
            self.info(f"⏺ {ev.summary}")        # info() 会先 _end_stream()
        ...
    ```

`ConsoleUI` 继承同一个状态机，只是把每次 `_emit/_write` 立刻打印到终端。测试用 `BufferUI`，真终端用 `ConsoleUI`，两者画出的内容逐字一致——这也是为什么上面那段演示输出能直接作为测试断言的依据。

## 测试

`tests/ch02_streaming.test.ts`（Python 版 `tests/test_ch02_streaming.py`）：

- `test_event_order`：思考 → 文本 → `ToolStart` → `ToolEnd` → `TurnEnd` 的顺序。
- `test_deltas_arrive_before_tool_runs`：取出第一个事件时，探针工具还没执行——证明生成器是惰性的。
- `test_intermediate_text_is_shown`：第 1 章丢掉的那句话现在出现在 `⏺` 之前。
- `test_anthropic_adapter_converts_stream`：用 `tests/sdk_stub.ts`（Python 版 `tests/sdk_stub.py`）里的假 SDK 对象测 `AnthropicClient`：事件转换、thinking 块保留 `signature`、工具带 `eager_input_streaming`。**不联网**也能测真实适配层。

=== "Node"

    ```console
    $ cd /Users/me/agent-learn/code/mini_cc-node && node --test 'tests/ch0[1-2]*.test.ts'
    ℹ tests 14
    ℹ suites 0
    ℹ pass 14
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 688.478416
    ```

=== "Python"

    ```console
    $ cd /Users/me/agent-learn/code/mini_cc && uv run pytest -q
    ..............                                                           [100%]
    14 passed in 0.56s
    ```

## 和真实 Claude Code 的差异

- Claude Code 是 TypeScript 写的（本机 2.1.306 的二进制是 Bun 打包的，`strings` 能看到 `$bunfs` 路径），终端 UI 用 Ink。思路相同：循环产出消息流，UI 订阅。它的 `-p --output-format stream-json` 把这条流直接以 JSON 行输出，SDK 集成消费的就是它。
- mini-cc 只流文本和思考，工具参数的流式片段（`input_json` 事件）直接丢弃。
- mini-cc 的工具严格按顺序执行。Claude Code 会并发执行工具——本机二进制里能看到控制并发度的环境变量 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`。哪些工具能并发、并发后事件怎么排序，留作练习 2。

## 回到那句消失的话

现在回头看开头的问题：「我先看看目录。」去哪了？它一直在 `resp.content` 里，只是第 1 章的 `run()` 只把**最后一次**回复的文本交给了 UI。改成事件流以后，每一次回复的每一个文本块都会经过 UI，那句话自然就回来了。

问题的根源不是「少打印了一行」，而是循环对外只暴露了终点。暴露过程，这一章就做完了。

## 对照你的环境

- 你的 `PreToolUse` / `PostToolUse` hook 挂的位置，正好就是本章 `_run_tools` 里 `ToolStart` 和 `ToolEnd` 的位置。现在你能看到这两个节点在循环里的真实形态：hook 本质是在 `yield ToolStart` 之后、`tool.run()` 之前同步跑一段外部命令。
- 你用 `claude --bg` 跑后台会话、`claude attach` 接上去看——之所以能「接上去」，是因为输出是一条持续的事件流，而不是结束时一次性的结果。

## 常见坑

1. **在流的过程中就往 `messages` 里写**。断网时历史里会留下半截 assistant 消息，下一次请求直接 400。只在 `MessageDone` 之后写。
2. **thinking 用默认 display**。Opus 5.5 的思考块文本默认为空，UI 上只会看到长时间无输出。
3. **以为 `eager_input_streaming` 免费**。它关闭了服务端参数校验，SDK 的宽容 JSON 解析器可能返回被截断的参数——必须自己校验（下一章）。
4. **Rich 的 markup 吃掉方括号**。模型输出里的 `[stderr]` 会被当成样式标签；`ConsoleUI` 打印时一律 `markup=False`。（Node 版直接写 ANSI 转义码，没有这层解析。）
5. **测试里用 `ConsoleUI`**。终端宽度、颜色码会让断言变脆；测试用 `BufferUI`。

## 练习

1. 给 `ToolEnd` 加一个 `duration_ms` 字段，UI 在 `✔` 那一行末尾显示耗时。
2. 让 `_run_tools` 对一组**全部只读**的工具调用并发执行（`concurrent.futures`），但事件依然按原顺序 yield。写一个测试证明总耗时小于串行。
3. 开放题：Claude Code 的 `stream-json` 输出能被另一个程序消费。为 mini-cc 设计一个 `--output-format jsonl`：每个事件一行 JSON。哪些事件该输出，哪些（比如 4 个字符的 `TextDelta`）应该合并？

## 延伸阅读

- Streaming Messages：<https://platform.claude.com/docs/en/build-with-claude/streaming>
- Adaptive thinking 与 display：<https://platform.claude.com/docs/en/build-with-claude/extended-thinking>
- 本系列：[详解 LLM API 的流式响应模式](../p2-agent-basics/09-streaming-response.md)、上一章 [命令系统](01-cli.md)、下一章 [错误处理与重试](03-error-handling.md)
