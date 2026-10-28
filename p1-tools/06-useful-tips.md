# Claude Code 的常用技巧

> 原文（免费）：[Claude Code 的常用技巧](https://labuladong.online/zh/ai-coding/claude-code/useful-tips/) —— 建议先读原文，本页是我的笔记

**一句话结论**：这些技巧全是在管同一件事，就是**上下文里该放什么、什么时候清掉、出错了怎么退回去**。CLAUDE.md 和 memory 负责「预装」，/clear、/compact 和 Esc 负责「清理和纠偏」，rewind 和 resume 负责「存档和读档」。

## 核心要点

1. **CLAUDE.md 是你写的、每轮都会带上的系统提示词补丁**。它分四层：用户级 `~/.claude/CLAUDE.md`、项目级 `./CLAUDE.md`、个人本地版 `CLAUDE.local.md`（放进 .gitignore）、子目录 CLAUDE.md（读到那个目录的文件时才按需加载）。原文的建议是「越短越好」，因为每多一行都会挤占别的行的注意力。
2. **该写的是 Claude 猜不到的东西**：内部命令、反直觉的约定、隐含约束。读代码就能看出来的、经常变的、正确的废话都别写。实用的循环是：发现它反复犯同一个错，就加一条规则。
3. **Auto memory 是 Claude 写给自己的笔记**，放在 `~/.claude/projects/<编码后的项目路径>/memory/`。启动时只加载 `MEMORY.md` 这个索引（原文说上限是前 200 行或 25KB），topic 文件等需要时再读。这和 Skills 的渐进式加载是同一个思路。
4. **memory 跟着路径走，不跟着项目走**。目录改名或挪位置，之前攒的记忆就找不到了；它也不跨机器同步。
5. **/clear 是最便宜的「上下文卫生」**。换任务就清，旧上下文既费 token 又会干扰判断。/compact 是有损压缩，可以带参数说明想侧重保留什么，但没法精确裁剪。
6. **Esc 一次是打断，Esc 两次（/rewind）是读档**。每提交一条 prompt 就会自动存一个 checkpoint，回退时对话和文件快照一起退。要注意 checkpoint 只追踪 Edit/Write 工具改的文件，`rm`、`mv` 这类 bash 改动回不去；它也不能代替 git。
7. **一个任务开一个会话**：用 `claude -c` 续上当前目录最近的会话，用 `claude -r` 挑一个会话，用 /rename（或启动时 `-n`）给会话起名字。这其实是把「会话」当成上下文的分支来管理。
8. **权限模式决定的是「每一步要不要人确认」**：Shift+Tab 循环切换，plan 模式只读，先出方案再动手。`--dangerously-skip-permissions` 和 `--permission-mode auto` 是两种不同程度的放权。
9. **几个提效小招**：`@文件` 直接把文件内容塞进上下文，省掉一轮搜索；Ctrl+G 用外部编辑器写长 prompt；/simplify 做改后自审；/insights 生成会话使用报告。

```d2
direction: down
pre: "启动时预装\n（每轮都付费）" {
  a1: "~/.claude/\nCLAUDE.md"
  a2: "./CLAUDE.md /\nCLAUDE.local.md"
  a3: "memory/MEMORY.md\n索引"
}
lazy: 按需加载 {
  b1: "子目录\nCLAUDE.md"
  b2: "memory/*.md\ntopic"
  b3: "@file"
}
ctx: 上下文窗口 {shape: circle}
e: 新会话
cp: "checkpoint\n~/.claude/file-history" {shape: cylinder}
pre.a1 -> ctx
pre.a2 -> ctx
pre.a3 -> ctx
lazy.b1 -> ctx: 读到该目录时 {style.stroke-dash: 3}
lazy.b2 -> ctx: "Claude 判断需要时" {style.stroke-dash: 3}
lazy.b3 -> ctx: 用户显式 {style.stroke-dash: 3}
ctx -> ctx: "/compact 有损压缩"
ctx -> e: "/clear 清空"
ctx -> cp: "每条 prompt 自动存"
cp -> ctx: "Esc Esc / rewind"
```

```d2
direction: down
start: "" {shape: circle; width: 16; height: 16; style.fill: "#333"}
manual: manual
acceptEdits: acceptEdits
plan: plan
note_plan: "只读，先出计划\n确认后才执行" {shape: page}
note_manual: 每次写文件或跑命令都问 {shape: page}
start -> manual: 启动默认
manual -> acceptEdits: "Shift+Tab"
acceptEdits -> plan: "Shift+Tab"
plan -> manual: "Shift+Tab"
plan -- note_plan {style.stroke-dash: 3}
note_manual -- manual {style.stroke-dash: 3}
```

（这张图只画了原文提到的三种模式。启用了 auto 或 bypassPermissions 之后，Shift+Tab 的循环里也会出现它们，具体顺序以你本机状态栏的显示为准。）

### 📝 作者是怎么讲的

- **开场先降低预期，再给阅读方法。** 第一段就讲明「不用全部记住，读一遍知道有哪些招，用到再回来查」，等于告诉读者这是一篇查阅手册，不必逐条背。为什么有效：技巧清单很容易让人觉得负担重，先把预期放低，读者才看得下去。借用：你写 skill 的 README 或团队速查页时，第一句就说「这页怎么用」。
- **每个机制先给一句大白话，再讲细节。** CLAUDE.md 一节先说它就是把「每次都得重复交代一遍的话」写进文件，然后才列四个加载位置、写什么、不写什么。为什么有效：读者先有一个钩子，后面的规则都能挂上去。借用：介绍 inject-guardrails.sh 这类东西时，第一句先说「它解决什么烦恼」，再讲 hook 事件和路由表。
- **用对比表区分容易混淆的一对概念。** CLAUDE.md 和 auto memory 用「谁写 / 写什么 / 什么时候写」三行对照。为什么有效：两个都叫「记忆」，并排比一遍，边界就清楚了。借用：skill 和 CLAUDE.md、hook 和规则，这类成对的概念都可以这样一张表讲完。
- **用「我的习惯」给出观点和理由。** 文中好几处是作者自己的做法：反复犯的错就补一条进 CLAUDE.md，每个待办开一个独立会话、像 git 分支一样管理。哪种场景该开 plan、哪种不必开，也直接给了判断。为什么有效：只罗列功能不告诉读者怎么选，读者还是不会用；有观点才有取舍。借用：你写个人工作环境文档时，多写「我为什么这么配」，少写「有哪些选项」。
- **用一个小场景演示，再拆规则。** 讲 Esc 打断时先放一段三行的「我 / Claude / 我按 Esc」小剧本，然后才讲 rewind 和 checkpoint 的两个坑。为什么有效：交互类功能光用文字描述很抽象，演示一下读者马上能代入。
- **结尾把全篇收成一段口诀。** 最后用一段话把 CLAUDE.md、memory、/clear、Esc、rewind、plan 串成一套日常习惯，并落到「控制上下文和 token 消耗」上。借用：技巧类文档最后加一段「一句话串起来」，比再列一遍要点更好记。

## ⚠️ 勘误 / 补充

本机 `claude --version` 的结果是 `2.1.306`。以下结论来自本机 `claude --help` 和对二进制里字符串的检索。

- **模型名过时**：原文说 /model 的默认值「一般是 Sonnet 4.6 或 Opus 4.7」。现在的模型是 `claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5`。你的 `~/.claude/settings.json` 里写的是 `"model": "sonnet"` 和 `"effortLevel": "high"`（这里用的是别名，会解析到当前的 Sonnet）。
- **权限模式名有变化**：原文写的是 `default / acceptEdits / plan`。在 2.1.306 里，`--permission-mode` 的可选值是 `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`，也就是原来的 `default` 在 CLI 里显示为 `manual`。另外还多了 `dontAsk`（不弹窗，未放行的操作直接拒绝），以及 `bypassPermissions`（等价于 `--dangerously-skip-permissions`）。
- **`--dangerously-skip-permissions` 的官方措辞更严**：`--help` 里写的是 "Recommended only for sandboxes with no internet access"，比原文说的「开发机也可以」更保守。
- **/insights 分析的范围**：原文说它生成「当前项目的使用报告」，而内置命令的描述是 "Generate a report analyzing your Claude Code sessions"，分析的是你的会话，不只限于一个项目。它受策略开关 `allow_insights` 控制。
- **补充几个新 flag**：`-n/--name`（启动时就给会话命名，名字会显示在 /resume 选择器里）、`--fork-session`（resume 时分叉出一个新的 session ID）、`--from-pr`（按 PR 恢复关联的会话）、`-w/--worktree`（直接在新的 git worktree 里开会话）。
- **checkpoint 保留 30 天**：这对应 settings 里的 `cleanupPeriodDays`（默认 30），它同时控制 transcript 的清理。文件快照存在 `~/.claude/file-history/<sessionId>/`，本机能看到 `<hash>@v1`、`<hash>@v2` 这样按版本命名的备份。

## 回到主线

LLM 每一轮都要把上下文重新算一遍，所以「上下文里放什么」直接决定效果和成本。这篇讲的技巧可以分成三类：**预装**（CLAUDE.md、MEMORY.md 索引，这是固定成本）、**按需注入**（@file、子目录 CLAUDE.md、memory topic，这是可变成本）和**清理与回滚**（/clear、/compact、rewind）。读完这篇，后面的 [上下文压缩](../p3-agent-internals/05-context-compaction.md)、[自动记忆](../p3-agent-internals/06-auto-memory.md) 和 [rewind 实现](../p4-mini-cc/13-rewind.md) 都可以看成是在拆解这三个动作是怎么实现的。

## 对照你的环境

- **你已经把这套做到了工程化**。你的 `~/.claude/CLAUDE.md` 开头那条「常驻层是稀缺资源，每加一行都在和别的行抢注意力」，和原文「CLAUDE.md 越短越好」说的是同一件事。你又往前走了一步：带场景的规则不放进 CLAUDE.md，而是交给 SessionStart hook `~/.claude/bin/inject-guardrails.sh` 按 cwd 注入。这相当于自己实现了「子目录 CLAUDE.md 按需加载」，而且粒度更细，可以按公司层和项目层累积注入。
- **memory**：本机 `~/.claude/projects/-Users-me-work-ai-coding/memory/` 下有 91 个文件，`MEMORY.md` 有 98 行，没超过 200 行的上限。等它涨到接近 200 行，末尾的索引条目就不会自动进上下文了，所以值得定期整理。你的 `env/backup-memory.sh` 解决的正是原文说的「memory 不跨机器」这个问题。
- **权限**：你的 `settings.json` 里 `permissions.defaultMode` 是 `bypassPermissions`，同时开着 `skipDangerousModePermissionPrompt`。所以真正把关的不是权限模式，而是 PreToolUse hook，比如 `enforce-worktree.py`（拦 Bash）和团队平台的发布检查脚本（拦发布）。这正对应你 CLAUDE.md 里的原则：「工具链能强制的就别写进上下文」。
- **会话即分支**：你 CLAUDE.md 里「代码变更默认走独立 worktree」的做法，配合 `claude -w`、`-n`，就是原文「一个待办一个会话」的加强版，连文件系统也一起隔离了。

## 自测题

1. 你在 `/Users/me/work/webapp` 攒了很多 memory，后来把仓库挪到了 `/Users/me/code/webapp`。为什么 memory「消失」了？怎么找回来？
2. Claude 通过 Bash 执行了 `sed -i` 改坏了一个文件，你按两下 Esc 回退到上一个 checkpoint，文件能恢复吗？为什么？
3. 一条规则「webapp 的文案必须写进翻译平台的 webapp 项目」，应该放进用户级 CLAUDE.md、项目 CLAUDE.md，还是按 cwd 注入的 guardrails？依据是什么？

<details><summary>参考答案</summary>

1. memory 目录名是由项目的绝对路径编码出来的（把 `/` 等字符换成 `-`）。路径变了，Claude 就会去找 `-Users-me-code-webapp/memory/`，旧目录 `-Users-me-work-webapp/memory/` 还在，只是不会再被加载。把旧目录里的文件拷到新目录下就能找回来。
2. 不一定能。checkpoint 只追踪 Edit/Write 等文件编辑工具产生的改动，Bash 命令改的文件不在快照里。对话可以退回去，那个文件不会恢复，只能靠 git 恢复。
3. 放进按 cwd 注入的项目层 guardrails。这条规则只在 webapp 目录下成立，放进用户级会污染兄弟项目，比如另一个 H5 应用的文案在另一个项目里。如果所有协作者都需要它，也可以放进 webapp 子目录的 CLAUDE.md，但你的环境选的是个人层的 hook 注入，这样不用往团队仓库里塞东西。

</details>

## 相关章节

- [安装使用 Claude Code](./02-install-and-use.md)
- [你的聊天记录存在哪](./07-session-storage.md)：`-c`、`-r` 读的到底是什么
- [用 Hooks 给 Claude Code 加规矩](./08-hooks.md)
- [用 Skills 定制你的 AI 工作流](./12-skills.md)
- [如何实现上下文压缩](../p3-agent-internals/05-context-compaction.md) · [Claude Code 自动记忆系统](../p3-agent-internals/06-auto-memory.md) · [Plan Mode 是怎么实现的](../p3-agent-internals/11-plan-mode.md) · [权限检查](../p3-agent-internals/10-permission-check.md)
- [支持 rewind 回退对话和代码](../p4-mini-cc/13-rewind.md) · [支持 compact 压缩上下文](../p4-mini-cc/14-compact.md)
