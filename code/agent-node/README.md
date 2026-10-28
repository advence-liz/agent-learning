# agent-node：配套代码的 Node（TypeScript）版

和 [`code/agent`](../agent) 一一对应，正文里的代码块默认展示这一版。`code/mini_cc-node` 按同样的约定写。

```bash
cd code/agent-node
npm ci
node coding_agent/demo.ts     # 离线 fake 模型，不需要 API key
npm test                      # node --test，全部离线
npm run typecheck             # tsc 只做类型检查，不产出文件
```

真实调用：把 `new FakeAnthropic(...)` 换成 `new Anthropic()`（读 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`），业务代码不用改。

## 约定

**运行方式**
- Node ≥ 24，直接 `node x.ts`（类型剥离），没有构建步骤。
- 相对导入写完整扩展名：`import { runAgent } from "./agent.ts"`。
- 只用可剥离的 TS 语法：不用 `enum`、`namespace`、构造函数参数属性（`tsconfig` 里开了 `erasableSyntaxOnly`）。
- 入口判断用 `if (import.meta.main) { ... }`，对应 Python 的 `if __name__ == "__main__":`。

**和 Python 版怎么对应**
- 目录名、文件名照搬 Python 版，方便对照：`coding_agent/agent.py` → `coding_agent/agent.ts`。
- 测试：`coding_agent/test_agent.py` → `coding_agent/agent.test.ts`；mini_cc 的 `tests/test_ch05_permissions.py` → `tests/ch05_permissions.test.ts`。
- 每个 Python 测试都要有对应的 `node:test` 用例，断言的意思一致。
- 标识符用 camelCase（`runAgent`、`maxTurns`）。发给 API 的字段保持原样（`tool_use_id`、`input_schema`、`max_tokens`），这是协议，不是命名风格。
- Python 的关键字参数 → 末尾一个 options 对象：`runAgent(client, task, cwd, { maxTurns: 3, log })`。
- 模型调用都是 `await client.messages.create(...)`，所以 agent 循环是 `async` 的。
- 注释密度、中文说法跟 Python 版一致；文件头注释写清「第几章、怎么运行」。

**模型和依赖**
- 离线一律用 [`fake_llm`](fake_llm/index.ts) 的 `FakeAnthropic` / `text()` / `toolUse()`，不发真实请求。
- 第三方库对照：

| Python | Node |
|---|---|
| `anthropic` | `@anthropic-ai/sdk` |
| `mcp` | `@modelcontextprotocol/sdk` + `zod` |
| `claude-agent-sdk` | `@anthropic-ai/claude-agent-sdk` |
| `langgraph` | `@langchain/langgraph` |
| `pydantic-ai` | `ai`（Vercel AI SDK，`ai/test` 里有 mock 模型）+ `zod` |
| `pydantic` | `zod` |
| `httpx` | 内置 `fetch` |
| `numpy` | 普通数组 |
| `rich` / `prompt_toolkit` | ANSI 转义 + `node:readline` |
| `pytest` | `node:test` + `node:assert/strict` |
| `subprocess` | `node:child_process` |
| `threading` / `queue` | `Promise`、`AbortController`、事件 |
