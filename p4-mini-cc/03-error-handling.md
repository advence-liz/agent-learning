# Agent 的错误处理与重试

> 对应原站：[Agent 的错误处理与重试](https://labuladong.online/zh/ai-coding/coding-agent/error-handling/)（会员内容；本章为独立原创重写）

> **一句话结论**：agent 里的错误分三层处理——API 层能重试就重试，工具层把一切异常变成「错误结果」交还给模型，主循环兜底保证进程不退、历史合法。核心心法只有一句：**错误也是上下文**，大部分错误不该由程序处理，而该原样交给模型去处理。

## 那行 `Retrying in 4s · attempt 2/10` 是谁打的？

用 Claude Code 久了你一定见过这样一行：`API Error: 529 Overloaded`，下面跟着 `Retrying in … · attempt 2/…`，过几秒它自己就好了。

你可能会问：SDK 不是自带重试吗？Claude Code 为什么还要自己显示一遍？

这个问题背后，是 agent 错误处理的第一个设计决定：**重试要不要让人看见**。再往下追问，还有第二个：工具执行报错了，到底是程序的错，还是模型该处理的「信息」？

我们现在的 mini-cc 两个问题都没回答。API key 填错、网络抖一下、模型给了个错误的参数、命令超时——任何一个都会让进程直接抛异常退出，下午聊的上下文全部作废。

## 先跑起来看看

离线 fake 模型，剧本 `examples/ch03.json` 依次模拟：一次 529 过载、一次参数名写错、一次文件不存在、一次命令失败，最后一轮再来一次 401：

=== "Node"

    ```console
    $ printf '总结一下 README\n再说一遍\n/status\n' | node mini_cc/cli.ts --fake examples/ch03.json
    ❯ 总结一下 README
    ◇ system  项目说明 0 个文件、git 快照
    ◇ system  日期 2026-10-22
    模型请求失败：529 Overloaded；1.2s 后第 1/5 次重试
    ● 先读一下 README。
    ⏺ Read(README.md)
    ✘ Read -> <tool_use_error>InputValidationError: Read failed due to the following issues:
      The required parameter `file_path` is missing
      An unexpected parameter `path` was provided</tool_use_error>
    ● 参数名写错了，改成 file_path。
    ⏺ Read(README.md)
    ✘ Read -> <tool_use_error>Error: ENOENT: no such file or directory, open '/Users/me/agent-learn/code/mini
    ● 文件好像不存在，确认一下。
    ⏺ Bash(ls README.md)
    ✘ Bash -> [stderr]
      ls: README.md: No such file or directory
      [exit code 1]
    ● 项目根目录没有 README.md，需要我创建一个吗？
    ❯ 再说一遍
    ✗ 模型请求失败（auth）：401 invalid x-api-key
    ❯ /status
    model     claude-opus-5-5
    effort    medium
    cwd       /Users/me/agent-learn/code/mini_cc-node
    session   240b7c01-2a15-4df8-aa69-1a21073a1407
    mode      default
    allow     -
    reviewer  0 calls
    messages  9
    context   100 tokens（最近一次请求的输入）
    total     in 400 / out 80 / 4 requests
    ```

=== "Python"

    ```console
    $ printf '总结一下 README\n再说一遍\n/status\n' | uv run python -m mini_cc --fake examples/ch03.json
    ❯ 总结一下 README
    模型请求失败：529 Overloaded；1.4s 后第 1/5 次重试
    ● 先读一下 README。
    ⏺ Read(README.md)
    ✘ Read -> <tool_use_error>InputValidationError: Read failed due to the following issues:
      The required parameter `file_path` is missing</tool_use_error>
    ● 参数名写错了，改成 file_path。
    ⏺ Read(README.md)
    ✘ Read -> <tool_use_error>FileNotFoundError: [Errno 2] No such file or directory: '/Users/me/agent-learn/
    ● 文件好像不存在，确认一下。
    ⏺ Bash(ls README.md)
    ✘ Bash -> [stderr]
      ls: README.md: No such file or directory
      [exit code 1]
    ● 项目根目录没有 README.md，需要我创建一个吗？
    ❯ 再说一遍
    ✗ 模型请求失败（auth）：401 invalid x-api-key
    ❯ /status
    model     claude-opus-5-5
    ...
    messages  9
    total     in 400 / out 80 / 4 requests
    ```

五种错误，进程一次都没退。而且你注意到没有：三个 `✘` 之后，模型都**自己调整了做法**——参数名改对了、改用 `ls` 确认、最后反问用户。真模型就是这么用错误信息的。

## 三层防线

```d2
direction: down
l3: "第三层：主循环安全网 run_turn" {
  direction: down
  l1: "第一层：API 重试 _call_model" {
    m: "client.stream()"
    r: "退避 sleep → 重试"
    up: "向上抛"
    m -> r: "ModelError retryable"
    r -> m
    m -> up: "不可重试 / 次数用完"
  }
  l2: "第二层：工具防线\nToolRegistry.execute" {
    v: "① 参数校验"
    e1: "is_error 结果"
    x: "② tool.run()"
    e2: "is_error 结果"
    v -> e1: "不合法"
    v -> x
    x -> e2: "异常"
  }
  n: "Notice(error) + TurnEnd(error)"
  f: "finally: repair_history()"
  l1.up -> n
}
model: "作为 tool_result 交还模型"
l3.l2.e1 -> model
l3.l2.e2 -> model
```

图注：三层各管一类错误，**谁也不往上漏**。第一层处理「请求没送达」，第二层处理「工具干砸了」，第三层兜住所有意外，并且在 `finally` 里修好历史。

用医院打比方：第一层是挂号处——系统忙就让你过会儿再来；第二层是科室——检查结果异常不是医院的事故，是要交给医生（模型）判断的信息；第三层是急诊——什么情况都得接住，至少保证病人（会话）活着。

比方不成立的地方是：医院不会把「挂号失败」告诉医生，而我们的第一层确实对模型完全透明——重试成功的话，模型根本不知道刚才失败过。这是对的，因为那次失败不包含任何关于任务的信息。

**回到主线**：第一层的重试让上下文**保持原样**（失败的半截输出不进历史）；第二层把错误**写进上下文**（模型下一个 token 的预测就基于这条错误）。同样是错误，一个不该污染上下文，一个恰恰是上下文里最有价值的信息——分清这两类，就是这一章的全部。

## 第一层：API 请求重试

### 先把 SDK 的重试关掉

`mini_cc/model.ts:AnthropicClient.constructor`（Python 版 `model.py:AnthropicClient.__init__`）：

=== "Node"

    ```ts
    this.sdk = sdkClient ?? new Anthropic({ maxRetries: 0 });
    ```

=== "Python"

    ```python
    self._sdk = sdk_client or anthropic.Anthropic(max_retries=0)
    ```

你可能会问：SDK 默认对 408/409/429/5xx 和连接错误重试 2 次，白送的功能为什么不要？

因为它是**静默**的。SDK 在内部重试时，循环和 UI 什么都看不到，用户只觉得「卡住了」。agent 场景下一次请求可能本来就要跑几十秒，用户分不清是模型在想还是网络在重试。所以重试上移到循环里，每次都发一个 `Notice` 事件——这也就回答了开头那个问题：Claude Code 显示 `Retrying in … · attempt n/m`，本机二进制里能看到这个字符串，以及控制次数的环境变量 `CLAUDE_CODE_MAX_RETRIES`。

### 把 SDK 异常翻译成一种

`mini_cc/model.ts:toModelError`（Python 版 `model.py:to_model_error`）把五花八门的 SDK 异常收敛成一个 `ModelError(retryable, kind, status, retry_after)`。判断顺序从具体到宽泛：

=== "Node"

    ```ts
    if (e instanceof APIConnectionError)                 // 网络错误（含超时）没有状态码，先判
      return new ModelError(`network: ${e.message}`, { retryable: true, kind: "network" });
    if (e instanceof APIError && typeof e.status === "number") {
      const status = e.status;
      const retryable = [408, 409, 429].includes(status) || status >= 500;   // 529 overloaded 也在这里
      ...
    }
    if (e instanceof SyntaxError)
      // eager_input_streaming 下 SDK 用 JSON.parse 解析不了工具参数，会从流迭代器里抛 SyntaxError
      return new ModelError(`invalid tool input json: ${e.message}`, { retryable: true, kind: "invalid_json" });
    ```

=== "Python"

    ```python
    if isinstance(e, anthropic.APIStatusError):
        status = e.status_code
        retryable = status in (408, 409, 429) or status >= 500   # 529 overloaded 也在这里
        ...
    if isinstance(e, (anthropic.APITimeoutError, anthropic.APIConnectionError)):
        return ModelError(..., retryable=True, kind="network")
    if isinstance(e, ValueError):
        # eager_input_streaming 下 SDK 解析不了工具参数 JSON，会从流迭代器里抛 ValueError
        return ModelError(..., retryable=True, kind="invalid_json")
    ```

401（key 错了）、400（请求格式错了）重试多少次结果都一样，立刻失败。最后那条 `ValueError`（Node 版是 `SyntaxError`）是上一章埋的伏笔：开了 `eager_input_streaming` 之后，偶尔会收到完全解析不了的工具参数 JSON，这时还没有完整的 `tool_use` 块可以回填错误，唯一的办法是**重发这一轮**。

### 退避和「半截输出」

`mini_cc/retry.ts:RetryPolicy.delay`（Python 版 `retry.py:RetryPolicy.delay`）：有 `retry-after` 头就听服务端的，否则 `1s, 2s, 4s, 8s…` 指数增长再加一点随机抖动（jitter），上限 30 秒。抖动是为了避免一大批客户端在同一时刻一起重试，再把服务打挂一次。

重试循环在 `mini_cc/loop.py:Agent._call_model`：

=== "Node"

    ```ts
    let attempt = 0;
    for (;;) {
      let streamed = false;
      try {
        for await (const ev of this.client.stream(this.request())) {
          if (ev.type !== "MessageDone") streamed = true;
          yield ev;
        }
        return;
      } catch (e) {
        if (!(e instanceof ModelError)) throw e;
        attempt++;
        if (!this.retry.shouldRetry(attempt, e)) throw e;
        const delay = this.retry.delay(attempt, e);
        const cut = streamed ? "（上面的输出不完整，已丢弃）" : "";
        yield notice(`${cut}模型请求失败：${e.message}；${delay.toFixed(1)}s 后第 ${attempt}/${this.retry.maxRetries} 次重试`, "warn");
        await this.sleep(delay);
      }
    }
    ```

=== "Python"

    ```python
    attempt = 0
    while True:
        streamed = False
        try:
            for ev in self.client.stream(self._request()):
                if not isinstance(ev, MessageDone):
                    streamed = True
                yield ev
            return
        except ModelError as err:
            attempt += 1
            if not self.retry.should_retry(attempt, err):
                raise
            delay = self.retry.delay(attempt, err)
            cut = "（上面的输出不完整，已丢弃）" if streamed else ""
            yield Notice(f"{cut}模型请求失败：{err}；{delay:.1f}s 后第 {attempt}/{self.retry.max_retries} 次重试", "warn")
            self.sleep(delay)
    ```

为什么重试是安全的？因为上一章定下的规矩：**历史只在 `MessageDone` 之后才写入**。网络在流到一半时断开，已经流出去的半截文字只上了屏幕，没进 `self.messages`。重试时请求和上一次一字不差，UI 补一句「上面的输出不完整」就行。

`self.sleep` 是可注入的，测试里换成一个记录器，所以 6 次重试的测试瞬间跑完。

## 第二层：工具执行的两道防线

`mini_cc/tools/registry.ts:ToolRegistry.execute`（Python 版 `registry.py:ToolRegistry.execute`）：

=== "Node"

    ```ts
    const tool = this.tools.get(name);
    if (tool === undefined)
      return toolError(`Error: No such tool available: ${name}. Available: ...`);
    // 防线 1：参数校验
    const errors = validate(args, tool.inputSchema);
    if (errors.length)
      return toolError(`InputValidationError: ${name} failed due to the following issues:\n` + errors.join("\n"));
    // 防线 2：执行期异常（同步抛的、异步 reject 的都在这里接住）
    let result: ToolResult;
    try {
      result = await tool.run(args, ctx);
    } catch (e) {
      return toolError(`${e.name}: ${e.message}`);
    }
    return truncate(result, maxOutput);
    ```

=== "Python"

    ```python
    tool = self._tools.get(name)
    if tool is None:
        return tool_error(f"Error: No such tool available: {name}. Available: ...")
    # 防线 1：参数校验
    errors = validate(args, tool.input_schema)
    if errors:
        return tool_error(f"InputValidationError: {name} failed due to the following issues:\n" + "\n".join(errors))
    # 防线 2：执行期异常
    try:
        result = tool.run(args, ctx)
    except Exception as e:
        return tool_error(f"{type(e).__name__}: {e}")
    return truncate(result, max_output)
    ```

**防线 1：执行前校验。** `mini_cc/tools/validate.py` 是一个五十行的 JSON Schema 子集校验器，查 `type / required / enum / additionalProperties / items`。为什么不直接信模型？上一章开了 `eager_input_streaming`，服务端就不再校验参数；就算没开，模型也会写错参数名（演示里的 `path` vs `file_path`）。不校验的话，错误会变成工具内部一个莫名其妙的 `KeyError: 'file_path'`，模型很难看懂。

**防线 2：执行期兜底。** 文件不存在、除零、编码错误……工具里任何异常都变成 `is_error: true` 的 `tool_result`，**绝不往外抛**。

两道防线的产出都用 `<tool_use_error>…</tool_use_error>` 包起来，这是照抄 Claude Code 的格式——你本机的会话记录（`~/.claude/projects/*/*.jsonl`）里能搜到大量这样的结果，比如 `<tool_use_error>InputValidationError: Write failed due to the following issues: The required parameter `content` is missing</tool_use_error>`。包一层的好处是模型能分清「工具调用本身失败」和「命令输出里恰好有 error 字样」。

还有两个小防护：

- `Bash` 超时（`subprocess.TimeoutExpired`；Node 版是计时器到点后把子进程组整个杀掉）返回已产生的部分输出加 `[timed out after Ns]`。
- 输出超过 `settings.max_tool_output`（默认 3 万字符）就截断并注明。一条 `cat` 一个 2MB 的日志能把上下文直接撑爆，而这个错误要到**下一次请求**才会以 400 的形式出现，那时已经很难定位了。

说穿了，第二层就是**把 `raise` 改成 `return`**：异常不再是程序的控制流，而是给模型看的一段文本。

## 第三层：主循环安全网

`mini_cc/loop.ts:Agent.runTurn`（Python 版 `loop.py:Agent.run_turn`）现在只是一层壳，真正的循环搬进了 `_loop()`：

=== "Node"

    ```ts
    async *runTurn(prompt: string | Block[]): AsyncGenerator<Event> {
      this.messages.push({ role: "user", content: prompt });
      try {
        yield* this.loop();
      } catch (err) {
        if (err instanceof ModelError) yield notice(`模型请求失败（${err.kind}）：${err.message}`, "error");
        else yield notice(`内部错误：${err.name}: ${err.message}`, "error");  // 我们自己代码里的 bug 也不能让 REPL 退出
        yield turnEnd("error", "");
      } finally {
        this.repairHistory();             // 包括 Ctrl+C（调用方提前结束了 for await）
      }
    }
    ```

=== "Python"

    ```python
    def run_turn(self, prompt):
        self.messages.append({"role": "user", "content": prompt})
        try:
            yield from self._loop()
        except ModelError as err:
            yield Notice(f"模型请求失败（{err.kind}）：{err}", "error")
            yield TurnEnd("error", "")
        except Exception as err:            # 我们自己代码里的 bug 也不能让 REPL 退出
            yield Notice(f"内部错误：{type(err).__name__}: {err}", "error")
            yield TurnEnd("error", "")
        finally:
            self.repair_history()           # 包括 Ctrl+C
    ```

`finally` 里的 `repair_history()` 是这一层最关键的一行。API 有一条硬规定：**每个 `tool_use` 后面必须紧跟对应的 `tool_result`**。如果用户在工具跑到一半时按了 Ctrl+C（生成器被 `close()`，或者 `KeyboardInterrupt` 穿过生成器；Node 版是 `for await` 里 `break`，等价于调用生成器的 `return()`，同样会跑 `finally`），历史最后一条就是一个悬空的 `tool_use`，下一次请求必然 400——而且会一直 400，这个会话就废了。`repair_history()` 发现悬空的 `tool_use`，就补一条 `"Interrupted by user before this tool finished."` 的错误结果。

Claude Code 也有同样的机制，二进制里能看到它补的文案：`[Request interrupted by user for tool use]`。

`_loop()` 里还处理了几个特殊的 `stop_reason`：

| stop_reason | 处理 |
|---|---|
| `max_tokens` 且有 `tool_use` | **不执行**（参数可能被截断，执行一个写了半截的 `Write` 比不执行危险得多），补错误结果让模型分块重来 |
| `refusal` | 安全分类器拒答，结束本轮并提示 |
| `pause_turn` | 服务端工具跑太久时会暂停，原样续上（我们暂时没有服务端工具） |

关于 `refusal`：`AnthropicClient` 默认开启了**服务端 fallback**——走 `client.beta.messages.stream(..., betas=["server-side-fallback-2026-07-01"], fallbacks="default")`，模型因安全分类器拒答时，API 会在同一次调用里按拒答类别换一个模型重跑。这是 claude-api 文档对 `claude-opus-5-5` 的默认建议。如果你走的中转站（`ANTHROPIC_BASE_URL`）不认这个 beta，设 `MINI_CC_FALLBACKS=0` 关掉。

最后，`cli.py:App.handle_line` 接住 `KeyboardInterrupt`，打印「已中断」，回到输入提示符。（Node 版没有 `KeyboardInterrupt`：REPL 收到 Ctrl+C 时让 `App` 中止这一轮——正在跑的 Bash 被杀掉、`for await` 退出——再打印同一句话。）

还有一个细节：401 那一轮失败后，历史末尾留下一条孤零零的 user 消息「再说一遍」。下一次输入会形成两条连续的 user 消息——这是合法的，API 会把连续同角色消息合并成一个 turn。所以我没有回滚它：用户修好 key 后说一句「继续」，模型能看到完整的意图。

## 测试

`tests/ch03_errors.test.ts`（Python 版 `tests/test_ch03_errors.py`），16 个测试按三层组织：

- 第一层：两次 529 后成功、退避增长与 `retry-after`、401 立即失败且 REPL 还能继续用、重试次数用尽、**流到一半断开后历史里只有完整的那次回答**、SDK 异常翻译（用 `httpx2.Response(529, headers={"retry-after": "3"})` 构造真实的 `APIStatusError`；Node 版用 `APIError.generate(529, …, new Headers({"retry-after": "3"}))`）、fallback 参数、`ValueError` 可重试。
- 第二层：除零异常、参数类型错误、未知工具、`Bash` 超时、超长输出截断。
- 第三层：`max_tokens` 截断的 `Write` 不执行、`refusal`、**模拟 Ctrl+C 后历史被修复**、我们自己代码抛 `KeyError` 也不逃逸。

=== "Node"

    ```console
    $ cd /Users/me/agent-learn/code/mini_cc-node && node --test 'tests/ch0[1-3]*.test.ts'
    ℹ tests 30
    ℹ suites 0
    ℹ pass 30
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 2382.33725
    ```

=== "Python"

    ```console
    $ cd /Users/me/agent-learn/code/mini_cc && uv run pytest -q
    ..............................                                           [100%]
    30 passed in 1.44s
    ```

## 回到开头

那行 `Retrying in … · attempt n/m` 为什么要 Claude Code 自己打？因为重试必须**被看见**，而 SDK 的重试是看不见的。

工具报错是谁的事？是模型的事。程序只负责两件事：别让异常把进程带走，以及把错误原原本本地写进上下文。剩下的，交给那个最擅长读错误信息的家伙。

## 和真实 Claude Code 的差异

- Claude Code 的重试次数、超时可以用 `CLAUDE_CODE_MAX_RETRIES`、`API_TIMEOUT_MS` 环境变量调（本机二进制中可见这两个变量名）；mini-cc 用 `Settings.max_retries` 等字段。
- Claude Code 有 `StopFailure` 这个 hook 事件（你配过）。按官方 hooks 文档的描述，它在「一轮因 API 错误而结束」时触发——也就是说 Claude Code 把这件事当作可被外部订阅的事件。mini-cc 只发一个 `Notice`。
- Claude Code 对 `Edit` 失败有非常细的提示，比如找不到 `old_string` 时会说明它还尝试过替换 `\uXXXX` 转义——我们在第 7 章做编辑工具时会学这一招。

## 对照你的环境

- 你配了 `StopFailure` hook：对应到 mini-cc，它的位置就在第三层的 `except ModelError` 分支——API 错误导致一轮结束的那一刻。
- 你的 CLAUDE.md 里写过「先调研再修复：第一次修复失败后立即停下调研」。有意思的是，这正是我们对**不可重试错误**的处理哲学：401 重试一百次也没用，该做的是停下来把信息交给能判断的人。

## 常见坑

1. **对 4xx 也重试**。400/401/403/404 重试只会浪费时间，还可能触发限流。
2. **SDK 重试和自己的重试叠加**。默认 2 次 × 你的 5 次 = 最多 18 次请求，等待时间成倍放大。用了自己的重试就把 `max_retries=0`。
3. **把工具异常往外抛**。一次 `FileNotFoundError` 就结束整轮，模型失去了「换个路径试试」的机会。
4. **忘记修悬空的 `tool_use`**。Ctrl+C 之后整个会话永久 400——这是最隐蔽的一种「崩溃」，进程活着，但会话死了。
5. **重试时历史里留着上次的半截 assistant 消息**。坚持「`MessageDone` 之后才写历史」这一条，就不会有这个问题。

## 练习

1. 给 `RetryPolicy` 加一个总时长上限（比如 2 分钟），超过就放弃，哪怕次数没用完。写测试时注意 `sleep` 是注入的，时间要怎么「模拟」？
2. 现在超长输出是简单地截掉尾部。改成「保留头 2/3 和尾 1/3、中间省略」，因为编译错误和测试失败的关键信息常在末尾。
3. 开放题：连续三次 529 之后，要不要自动换到 `claude-sonnet-5-5` 继续？换模型对 thinking 块、prompt cache 分别有什么影响？（提示：claude-api 文档提到 thinking 块与模型绑定，cache 也按模型隔离。）

## 延伸阅读

- 错误码与重试建议：<https://platform.claude.com/docs/en/api/errors>
- Refusals 与 fallback：<https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback>
- 本系列：上一章 [逐步输出](02-realtime-output.md)、[用 Hooks 给 Claude Code 加规矩](../p1-tools/08-hooks.md)、下一章 [持久化聊天记录](04-resume.md)
