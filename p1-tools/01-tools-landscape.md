# 用 Codex 还是 Claude Code？

> 原文（免费）：[用 Codex 还是 Claude Code？](https://labuladong.online/zh/ai-coding/basics/tools-landscape/) —— 建议先读原文，本页是我的笔记

**一句话结论**：任何 AI 工具 = 「模型」×「Agent 工程（Harness）」，两者乘积决定体验；选工具时先看谁握着模型、再看谁把上下文工程做得好，而不是看界面形态。

## 核心要点

1. **一个公式看穿所有产品**。Coding Agent、AI 做 PPT、网页聊天机器人，底层都是「LLM + Agent 工程实现」。任意一项短板都会拖垮整体。
2. **研发成本不对称**。训练前沿模型极其烧钱，全球玩得起的公司屈指可数；写 Agent 本质是普通软件工程，门槛低，所以 Agent 产品遍地都是。
3. **握有模型的公司有结构性优势**。原文的推论：模型厂商以成本价用自己的模型，竞品得先买它的 API 再跟它竞争。Cursor、Copilot 这类「套壳」产品因此处境尴尬，还被迫在 token 上做妥协（例如更激进的上下文压缩）。
4. **三家前沿模型厂商各自都有 CLI / 桌面端**：OpenAI（GPT → Codex CLI / 桌面端）、Anthropic（Claude → Claude Code / Claude Desktop）、Google（Gemini → Gemini CLI / Antigravity IDE）。
5. **路线之争：Copilot 路线 vs Agent 路线**。Copilot 是「人写、AI 猜下一步（Tab 补全）」；Cursor 开启「AI 写、人 review」的 Agent 路线并胜出。
6. **Claude Code 证明了「不需要 IDE」**。终端里一个输入框 + 强模型 + 好的工程（系统提示词、工具链、上下文管理）就够了。之后 Codex CLI、Gemini CLI 跟进。
7. **2026 年作者的判断变化**：GPT 5.5 之后编程能力与 Claude 打平，作者把主力迁到 Codex 桌面端；高风险改动再让另一个 Agent 独立 review 或调 Claude 交叉检查——原文说这「往往能发现主 Agent 在原有上下文里遗漏的问题」。
8. **桌面端把 CLI 藏起来**，目标用户从开发者扩展到所有人（Cowork、computer use），但底层仍是同一套 Coding Agent + 模型。
9. **教学选型和使用选型可以不同**：作者日常用 Codex，但后续拆源码用 Claude Code，因为它是纯 CLI、工程结构清晰，适合当案例。

```d2
direction: right
model: "模型层\n（贵、少数厂商）" {
  gpt: GPT 系列
  claude: Claude 系列
  gemini: Gemini 系列
}
harness: "Agent 工程层\n（软件工程、门槛低）" {
  codex: "Codex CLI\n/ 桌面端"
  cc: "Claude Code\n/ Desktop"
  gcli: "Gemini CLI\n/ Antigravity"
  cursor: "Cursor / Copilot\n无自研前沿模型"
}
model.gpt -> harness.codex: 自家·成本价
model.claude -> harness.cc: 自家·成本价
model.gemini -> harness.gcli: 自家·成本价
model.gpt -> harness.cursor: 买 API {style.stroke-dash: 3}
model.claude -> harness.cursor: 买 API {style.stroke-dash: 3}
model.gemini -> harness.cursor: 买 API {style.stroke-dash: 3}
```

```d2
direction: down
title: "AI 编程工具演进（原文时间线）" {shape: text; near: top-center}
t1: "2021-06\nGitHub Copilot 预览（Tab 补全）"
t2: "2023-03\nCursor（IDE 内 Agent，AI 写人审）"
t3: "2025-02\nClaude Code（回到终端）"
t4: "2025-04\nCodex CLI 开源"
t5: "2025-06\nGemini CLI 开源"
t6: "2025-11\nAntigravity（Google AI IDE）"
t7: "2026\n桌面端 + computer use，面向非开发者"
t1 -> t2
t2 -> t3
t3 -> t4
t4 -> t5
t5 -> t6
t6 -> t7
```

> ⚠️ 勘误/补充：原文写「Claude 最新是 Sonnet 4.6 和 Opus 4.7」「Opus 4.7 (1M context)」。截至本笔记（2026-10），本机 Claude Code 2.1.306 的 `~/.claude/settings.json` 的 `modelSettings` 里配置的是 `claude-sonnet-5-5` / `claude-haiku-5-5`，当前会话运行在 `claude-opus-5-5`。模型版本号是本文最容易过时的部分，读的时候只需记住「Sonnet = 标准、Opus = 旗舰、Haiku = 轻量」这个分层。

### 📝 作者是怎么讲的

- **先立一条原理，再用它推结论。** 开头不急着比较工具，先给出「AI 工具 = LLM + Agent 工程」，接着推出一个判断：握有模型的公司做 Agent，别人很难竞争过它。后面谈 Cursor 为什么处境尴尬、厂商为什么都去做 CLI，都是这条原理的推论。这样整篇是一条推理链，不是一张功能对比表。你写选型文档也可以这样：先写清约束（比如成本结构、谁握着关键资源），再让结论顺着约束推出来。
- **按时间线讲演进，每个阶段只回答「谁是主力」。** Copilot（人写，AI 补全）→ Cursor（AI 写，人 review）→ Claude Code（扔掉 IDE，回到终端）→ 大厂跟进。每一段只抓住「写代码的主力换成了谁」这一个变量，读者很容易记住。这个手法适合给团队讲一项技术的来龙去脉。
- **先演示再评价。** 讲 Claude Code 那一段，先贴了一段终端里的真实交互（初始化 rust 项目、把 hello world 改成 hello rust），接着才解释为什么「回到黑漆漆的命令行」反而火了。读者先看到它有多简单，后面的论证就容易接受。
- **先说出读者的第一反应，再反驳它。** 原文写「很多人第一反应是」回到命令行很落后，然后给出模型能力、受众匹配两条理由。把读者的疑虑先说出来再回答，比正面论证更有说服力。
- **观点带时间戳，并且公开修正。** 先给出「2025 年最佳选择是 Claude Code」，再用「2026 年的变化」推翻自己，把迁移到 Codex 的三条理由（模型打平、产品体验、封号和价格）逐条列出。另外他明说：教程以后仍然拆 Claude Code 源码，因为它工程上简单。日常主力用什么、教学拿什么当案例，他分得很清楚。你写周报或复盘时可以学这一点：判断要写明在什么条件下成立，条件变了就明确改口。
- **结尾指向下一步的行动。** 收尾不做总结，直接说「接下来两篇」把两个工具都装上，读者读完就知道下一步做什么。

## 回到主线

本章是全库主线的「地图」：既然 LLM 只是「按已有 token 预测下一个 token」的模型，那么同一个模型套在不同产品里效果不同，差异全部来自 **Harness 如何组织上下文**——系统提示词写什么、给哪些工具、什么时候压缩、要不要开子 Agent 独立 review。原文提到 Cursor「更激进的上下文压缩」导致「没搞清楚需求就开干」，正是「上下文工程决定质量」的反面例子；作者「新开 Agent 独立 review」则是用**干净上下文**换可靠性，对应后面的 [Sub Agent](./10-sub-agent.md) 与 [Fork Agent](./11-fork-agent.md)。

## 对照你的环境

- 你本来就是「双模型」工作流：主力 Claude Code（2.1.306），Codex（codex-cli 0.153.4）作为异源臂——`codex-review`（后台单臂 `codex review`）和 `codex-cross-review`（Claude reviewer + Codex 并行、交叉裁决）两个 skill 就是原文「调 Claude 交叉检查」的工程化版本，只是方向反过来。
- 原文的论点「同一上下文里的主 Agent 会遗漏问题」，在你的 `~/.claude/agents/codex-review.md`（隔离上下文的 Codex 子 agent）里已经被落实成机制：审查者看不到写代码时的推理过程，只看 diff。
- 你的 `~/.claude/settings.json` 用 `CLAUDE_CODE_USE_VERTEX` 走 Google Cloud 渠道调 Claude——这正好印证「模型层与 Harness 层可分离」：Claude Code 这层 Harness 不变，模型供给方换成了 Vertex。

## 自测题

1. 为什么原文认为「掌握大模型的公司，真想做某领域 Agent 时没人竞争得过」？用成本结构解释。
2. Copilot 路线和 Agent 路线的核心区别是什么？Claude Code 在这两条路线中属于哪一条，它和 Cursor 的差别又在哪？
3. 你用 `codex-cross-review` 让 Codex 审 Claude 写的代码。从「上下文」的角度，说明它为什么比在同一个会话里让 Claude「再检查一遍」更容易发现问题。

<details>
<summary>参考答案</summary>

1. 模型厂商用自家模型是成本价，竞品必须按市场价买 API 再加上自己的利润；同等工程水平下，厂商的单位成本更低、还能针对自家产品调模型。竞品为了省钱往往还得在上下文上做妥协，进一步拉低质量。
2. Copilot 路线是人主导、AI 补全下一段；Agent 路线是 AI 主导写代码、人做 reviewer。Claude Code 属于 Agent 路线，和 Cursor 的区别只是形态：Cursor 把对话框放在 IDE 里，Claude Code 放在终端里，而且背后是自家模型。
3. 同一会话里的「再检查」，模型读到的上下文里已经有它自己的推理和结论，下一个 token 的预测会被这些内容带偏，倾向于确认自己。异源 review 的上下文里只有 diff 和审查指令，没有原作者的思路；模型也换了一家，偏差不同，所以遗漏更容易暴露。

</details>

## 相关章节

- [LLM 和 Agent 的核心术语和原理](../p0-core/01-llm-and-agent.md)
- [安装使用 Claude Code](./02-install-and-use.md) · [安装使用 Codex](./03-install-and-use.md) · [安装使用 OpenClaw](./04-install-and-use.md)
- [Sub Agent：上下文管理的艺术](./10-sub-agent.md) · [Fork Agent](./11-fork-agent.md)
- [Harness Engineering 是什么](../p3-agent-internals/12-harness-engineering.md)
- [其他主流 Agent SDK 对比](../p2-agent-basics/07-agent-sdk-comparison.md)
