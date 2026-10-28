# 用 Skills 定制你的 AI 工作流

> 对应原站：[用 Skills 定制你的 AI 工作流](https://labuladong.online/zh/ai-coding/claude-code/skills/)（会员内容；本章为独立原创重写）

> **一句话结论**：Skill 是一种分三层、按需进入上下文的提示词：frontmatter 里的 name 和 description 常驻，SKILL.md 正文在被调用时作为一条消息追加到对话末尾，支持文件只在模型主动 Read 时才进来。这种渐进式披露（progressive disclosure）让你能装几十个 skill，却只为当下用到的那一个付 token。

## 54 万字符去哪了

我在你机器上跑了一个统计。`~/.claude/skills` 下有 46 个 skill：

- SKILL.md 正文合计 562,277 字符。
- `references/`、`scripts/` 这些支持文件合计 873 KB。
- 常驻的 description 合计只有 12,999 字符。

你可能会问：正文加起来有一本小说那么长，为什么每次开新会话，上下文没被它们撑爆？

反过来还有一个问题：某个 skill 明明装着，为什么有时候 Claude 就是想不起来用它？

两个问题的答案都在「哪一层什么时候进上下文」。

## 三层披露：目录、正文、附录

打个比方：skill 体系像一个图书馆。

- 常驻的 description 是**目录卡片**，每张卡片写着书名和「什么时候该借这本」。
- SKILL.md 正文是**书本身**，借阅时才拿到桌上。
- `references/` 里的文件是**书后附录**，书里写着「详见附录 B」，你读到那里才会去翻。

这个比方在一个地方不成立：图书馆的卡片柜放不下时，管理员会告诉你；Claude Code 的目录超出预算时，是**悄悄地**把一部分卡片上的描述擦掉，只留下书名。后面讲常见坑时会再说到这一点。

```d2
shape: sequence_diagram
h: Claude Code
c: "上下文（messages）"
m: 模型
h -> c: "会话开始：注入 skill listing（每个 skill 一行 name + description）"
c."L1 常驻，所有轮次都在"
m -> h: "tool_use Skill(name=\"pr-summary\", args=\"develop\")"
h -> h: '读 SKILL.md → 替换 $ARGUMENTS → 先执行 !`cmd`'
h -> c: "追加一条消息：\"Base directory for this skill: …\" + 渲染后的正文"
c."L2 从这一刻起留在对话里"
m -> h: "tool_use Read(references/ui-checklist.md)"
h -> c: "tool_result：附录内容"
c."L3 只在模型决定要看时进来"
```

官方 skills 文档（<https://code.claude.com/docs/en/skills>）里，每一层的规则都写得很具体。

**L1：description 是写给模型看的触发器。** 每个 skill 的 `description` 和 `when_to_use` 合起来，在 listing 里最多保留 1,536 字符。整个 listing 有一个总预算，按「模型上下文窗口的 1%」缩放。

超出预算时，文档的说法是：从**最少被调用**的 skill 开始，砍掉它的 description，只保留名字。可以用 `skillListingBudgetFraction`（比如 `0.02` 表示 2%）或 `SLASH_COMMAND_TOOL_CHAR_BUDGET`（一个固定的字符数）调高预算，也可以在 `skillOverrides` 里把低优先级的 skill 设成 `"name-only"`。

设置了 `disable-model-invocation: true` 的 skill 不进 listing，模型看不到它，只能由你手动输入 `/name` 调用。

**L2：正文调用时才加载，加载后一直留着。** 文档原话是「the rendered SKILL.md content enters the conversation as a single message and stays there across later turns」。正文在送给模型之前会先做两种预处理：

- 参数替换：`$ARGUMENTS`、`$0`、`${CLAUDE_SKILL_DIR}` 等占位符会被替换成实际值。
- 命令执行：`` !`cmd` `` 形式的命令先在本地跑一遍，用输出替换掉占位符。任何一条命令失败，整个调用都会中止。

文档建议 SKILL.md 控制在 500 行以内，把细节挪到支持文件里。

**L3：支持文件不会自动加载。** SKILL.md 里只写「什么情况下去读哪个文件」，读不读由模型自己决定。`scripts/` 下的脚本是拿来执行的，执行时只有输出进上下文，脚本源码本身不进。

还有两个跨层的细节：

- **会话压缩之后**：Claude Code 会把每个已调用 skill 的最近一次调用重新挂回摘要后面，每个 skill 只保留前 5,000 token，所有 skill 合计不超过 25,000 token。所以最重要的指令要写在 SKILL.md 的最前面。
- **缓存**：prompt caching 文档说，skill 的内容是以消息形式追加到调用点的，「Nothing earlier in the conversation changes」，所以调用 skill 不会破坏缓存。唯一的例外是 frontmatter 里写了 `model` 字段：那一轮相当于切换了模型，会读不到缓存。

**回到主线**：上下文是有限的，每个 token 都会参与下一个 token 的预测。Skill 用一张很小的目录换来了一个很大的能力库：平时只付目录的钱，用到哪一本才把哪一本拿上桌。说穿了，它就是「先往 system 区放一份清单，等模型点名了，再往 messages 末尾追加一条消息」。

## 先跑起来：一个一百多行的 skill 加载器

[`code/agent-node/skills_demo/skill_loader.ts`](../code/agent-node/skills_demo/skill_loader.ts)（Python 版 [`skill_loader.py`](../code/agent/skills_demo/skill_loader.py)）把上面三层实现了一遍，`skills_demo/skills/` 下放了两个示例 skill：

- `pr-summary`：带参数、带 `` !`node --version` ``（Python 版是 `` !`python3 --version` ``）预处理、带一个 references 文件。
- `release-note`：设置了 `disable-model-invocation: true`。

真实输出，路径已缩写：

=== "Node"

    ```text
    $ node skills_demo/skill_loader.ts
    == L1 listing（常驻）==
    - pr-summary: 汇总当前分支相对 main 的改动并写成 PR 描述。触发：「写 PR 描述」「总结这次改动」。

    == L1 listing，上下文只有 1.5k token 时（预算 60 字符）==
    - pr-summary

    == L2 调用 /pr-summary develop 后追加的消息 ==
    Base directory for this skill: <skills_demo/skills>/pr-summary

    # PR 描述生成

    基线分支：develop（默认 main）

    ## 当前环境
    v24.14.1

    ## 步骤
    1. 读 `git diff develop...HEAD --stat` 看改动面。
    2. 按「动机 / 改动 / 验证」三段写。
    3. 涉及 UI 的改动，查 <skills_demo/skills>/pr-summary/references/ui-checklist.md。
    ```

=== "Python"

    ```text
    $ uv run python skills_demo/skill_loader.py
    == L1 listing（常驻）==
    - pr-summary: 汇总当前分支相对 main 的改动并写成 PR 描述。触发：「写 PR 描述」「总结这次改动」。

    == L1 listing，上下文只有 1.5k token 时（预算 60 字符）==
    - pr-summary

    == L2 调用 /pr-summary develop 后追加的消息 ==
    Base directory for this skill: <skills_demo/skills>/pr-summary

    # PR 描述生成

    基线分支：develop（默认 main）

    ## 当前环境
    Python 3.12.13

    ## 步骤
    1. 读 `git diff develop...HEAD --stat` 看改动面。
    2. 按「动机 / 改动 / 验证」三段写。
    3. 涉及 UI 的改动，查 <skills_demo/skills>/pr-summary/references/ui-checklist.md。
    ```

对照输出看这几点：

- `release-note` 没有出现在 listing 里，因为它是手动专用的。
- 预算缩小以后，`pr-summary` 的描述被砍掉，只剩名字，模型从此「不知道什么时候该用它」。
- 调用时，`$0` 变成了 `develop`，`` !`node --version` ``（`` !`python3 --version` ``）变成了真实的版本号，`${CLAUDE_SKILL_DIR}` 变成了绝对路径。
- 那个 references 文件**没有**被加载，正文里只给了它的路径。

调用这一步的代码只有一行，而且只追加，不改前面任何内容：

=== "Node"

    ```ts
    function invoke(messages, skills, name, args = "") {
      messages.push({ role: "user", content: renderBody(skills[name], args) });
    }
    ```

=== "Python"

    ```python
    def invoke(messages, skills, name, arguments=""):
        messages.append({"role": "user", "content": render_body(skills[name], arguments)})
    ```

`Base directory for this skill:` 这个前缀不是我编的。我在你本机的 jsonl 里看到了真实的结构，一次 skill 调用会产生三条记录：

1. 模型发出 `tool_use: Skill`。
2. 对应的 `tool_result` 内容是 `Launching skill: <name>`。
3. 紧接着一条 `isMeta: true` 的 user 消息，开头就是 `Base directory for this skill: …`，后面跟着正文。

此外，jsonl 里还有 `skill_listing` 类型的 attachment，字段有 `content`、`skillCount`、`isInitial`、`names`，这就是 L1 的那份目录。还有 `invoked_skills` 类型的 attachment，我**推测**它就是压缩后用来重新挂回 skill 的那份记录。依据是它只记录了已调用过的 skill 列表，和文档描述的压缩后重新挂载行为对得上，但我没有在一次压缩前后对比验证过。

测试：`node --test 'skills_demo/*.test.ts'`，结果 `ℹ pass 6`（Python 版 `uv run pytest -q skills_demo`，结果 `6 passed`），覆盖了这几种情况：

- 手动专用的 skill 不进 listing。
- 预算不够时只砍描述、不砍名字。
- 正文里没有参数占位符时，末尾自动追加 `ARGUMENTS: <value>`。
- 预处理命令失败时整个调用中止。
- 调用只追加消息，不改动已有消息。

统计你自己的 skill 目录，用 `node skills_demo/measure_real.ts`（Python 版 `uv run python skills_demo/measure_real.py`）。它只输出数字，不输出任何 skill 的内容。两版输出逐字一致（Node 版按 Unicode 码点数字符，和 Python 的 `len()` 对齐；直接用 `.length` 会把 emoji 算成 2 个）：

=== "Node"

    ```text
    $ node skills_demo/measure_real.ts
    skills: 46  (disable-model-invocation: 0, description 超 1536 字符: 0)
    L1 常驻 description 合计:    12,999 字符
    L2 SKILL.md 正文合计:       562,277 字符  (43x)
    L3 支持文件合计:            873,321 字节
    ```

=== "Python"

    ```text
    $ uv run python skills_demo/measure_real.py
    skills: 46  (disable-model-invocation: 0, description 超 1536 字符: 0)
    L1 常驻 description 合计:    12,999 字符
    L2 SKILL.md 正文合计:       562,277 字符  (43x)
    L3 支持文件合计:            873,321 字节
    ```

## 对照你的环境

- **43 倍。** 这是渐进式披露在你机器上的实测收益：如果把所有正文都写进 CLAUDE.md，常驻层要大 43 倍。这正是你 CLAUDE.md 原则 2「多步流程一律进 skill；常驻层只回答『走哪条轨』」能成立的原因。
- **12,999 字符的 description 会不会超预算？** 预算是「上下文窗口的 1%」，所以答案取决于你当前模型的窗口有多大。它的单位我按「字符」理解，因为用来覆盖它的环境变量 `SLASH_COMMAND_TOOL_CHAR_BUDGET` 是一个字符数，但这一点属于**推测**。最可靠的办法是在会话里看 `/context` 的 Skills 一行，或者跑 `/doctor` 看 listing 的估算成本。你的 description 普遍很长：`doc-narrative` 的 description 就把整套方法论压缩了进去。窗口小的模型上，最先被擦掉描述的会是那些不常用的 skill。
- **你的研发平台系列 skill 用了 `allowed-tools`。** 注意它的语义：它只是在**调用 skill 的那一轮**里免除权限确认，「The grant clears when you send your next message」。它不是这个 skill 的工具白名单，也不会限制模型使用别的工具。
- **命名规范。** 你 CLAUDE.md 里规定「带项目前缀 `<project>-<能力>`」，这对 L1 也有好处：名字永远不会被预算砍掉，即使描述被擦掉了，`webapp-` 这个前缀也还能给模型一点提示。

我的观点：**description 是整个 skill 里最值钱的一段文字，要当成检索用的 query 来写，而不是当成摘要来写。** 把用户真正会说的话放在最前面，比如「写周报」「查日志」「这个 bug 帮我看下」，因为模型拿来匹配的是用户的原话。文档在排障一节也是这么建议的：把关键用例放在最前面，因为每条描述最多只保留 1,536 字符。

至于那些「每次都必须成立」的规则，不要只写在 skill 正文里。正文加载之后会被后续对话不断稀释，压缩后也只剩前 5,000 token。这类规则要么放进 frontmatter 的 `hooks` 字段，要么直接做成 [hook](08-hooks.md)。

## 常见坑

1. **frontmatter 的 YAML 写错了。** 文档说，YAML 解析失败时，正文照样能加载，所以 `/name` 还能用，但 metadata 为空，模型匹配不到这个 skill 的描述。可以用 `claude plugin validate ~/.claude/skills` 检查。
2. **把关键指令放在 SKILL.md 的末尾。** 压缩后每个 skill 只保留前 5,000 token，末尾的指令最先丢。
3. **`` !`cmd` `` 里放了可能非零退出的命令。** 比如 `git diff` 在不是 git 仓库的目录下，整个 skill 调用直接中止。要在命令后面加 `|| true`。
4. **把 `context: fork` 当成「带着上下文去跑」。** 它其实是一个全新的子 agent，看不到你的对话，见 [Fork Agent](11-fork-agent.md)。
5. **在 skill frontmatter 里写 `model`。** 那一轮会变成切换模型，长会话的缓存全部读不到。

## 练习

1. 给 `skill_loader.ts`（`skill_loader.py`）加上 `user-invocable: false` 的支持：这样的 skill 不出现在 `/` 菜单里，但仍然在 listing 中，可以被模型调用。写一条测试（`node:test` 或 pytest），断言它和 `disable-model-invocation` 的效果正好相反。
2. 实现压缩后的重新挂载：给定一份「调用历史」，每个 skill 只保留最近一次调用的前 N 个字符，总量不超过 M，优先保留最近调用的。用 N=5000、M=25000 的比例缩小后做测试。
3. （开放题）你的 46 个 skill 里，哪 5 个的 description 最该重写？用 `measure_real.ts`（`measure_real.py`）找出最长的 description，判断它的前 200 个字符里有没有用户真正会说的那句话。如果要把其中一个的流程拆成「SKILL.md 导航 + references 细节」，你会怎么切分？

## 延伸阅读

- 官方 Skills：<https://code.claude.com/docs/en/skills>（frontmatter 全字段、预算、压缩后的行为、`context: fork`）
- 官方 Prompt caching：Invoking skills and commands：<https://code.claude.com/docs/en/prompt-caching>
- Skill authoring best practices：<https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices>
- 本库：[Hooks](08-hooks.md)、[Sub Agent](10-sub-agent.md)、[mini Claude Code：Skill](../p4-mini-cc/20-skill.md)、[MCP 工具](../p2-agent-basics/10-mcp-tool.md)
