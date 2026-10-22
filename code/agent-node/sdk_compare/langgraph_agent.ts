/**
 * 第 7 章：同一个任务用 LangGraph 写——把 agent 循环画成一张显式的状态图。
 *
 * LangGraph 不绑定模型：图里的节点就是普通函数。这里的 "llm" 节点用脚本扮演模型（离线），
 * 真实使用时在节点里调用 new Anthropic().messages.create(...) 或 @langchain/anthropic 即可。
 * node sdk_compare/langgraph_agent.ts
 */

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

type Msg = Record<string, any>;

export const FILES: Record<string, string> = { "calc.py": "def add(a, b):\n    return a - b\n" };
const SCRIPT: Msg[] = [
  { tool: "read_file", args: { path: "calc.py" } },
  { tool: "write_file", args: { path: "calc.py", content: "def add(a, b):\n    return a + b\n" } },
  { text: "已修复：a - b → a + b" },
];

const State = Annotation.Root({
  messages: Annotation<Msg[]>({ reducer: (a, b) => a.concat(b), default: () => [] }), // reducer：节点返回的列表会被「追加」
  step: Annotation<number>(),
});
type S = typeof State.State;

function llm(state: S) {
  const decision = SCRIPT[state.step];
  return { messages: [{ role: "assistant", ...decision }], step: state.step + 1 };
}

function tools(state: S) {
  const call = state.messages.at(-1)!;
  let out: string;
  if (call.tool === "read_file") {
    out = FILES[call.args.path];
  } else {
    FILES[call.args.path] = call.args.content;
    out = "ok";
  }
  return { messages: [{ role: "tool", content: out }] };
}

function route(state: S): "tools" | typeof END {
  // 条件边：这就是第 2 章 while 循环里那个 if
  return "tool" in state.messages.at(-1)! ? "tools" : END;
}

export const app = new StateGraph(State)
  .addNode("llm", llm)
  .addNode("tools", tools)
  .addEdge(START, "llm")
  .addConditionalEdges("llm", route, ["tools", END])
  .addEdge("tools", "llm")
  .compile();

if (import.meta.main) {
  for await (const event of await app.stream({ messages: [{ role: "user", content: "修好 calc.py" }], step: 0 })) {
    for (const [node, update] of Object.entries(event)) {
      console.log(`[${node}] ${JSON.stringify((update as { messages: Msg[] }).messages.at(-1))}`);
    }
  }
  console.log((await app.getGraphAsync()).drawMermaid());
}
