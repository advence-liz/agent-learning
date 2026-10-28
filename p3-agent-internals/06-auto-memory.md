# Claude Code 自动记忆系统

> 对应原站：[Claude Code 自动记忆系统](https://labuladong.online/zh/ai-coding/claude-code/auto-memory/)（会员内容；本章为独立原创重写）

> **一句话结论**：Claude Code 的自动记忆就是一个目录里的一堆 markdown：模型在对话中随手用普通的 Write/Edit 写主题文件，并在 `MEMORY.md` 里加一行索引；下次开会话时只把索引的前 200 行或 25KB 放进上下文，正文等用到再读。

## 它为什么越用越懂你？

用了几个月 Claude Code，你大概有这种体验：早期你得反复交代「worktree 用 EnterWorktree，别 cd 进去」「提测要补 linear-watch」；后来不用说了，它自己就会这么做。

你可能会问：模型又没被微调，它是怎么「学会」的？

答案朴实得有点让人失望：它把你纠正它的话**记在了文件里**，下次开会话时把这些文件塞回上下文。模型并没有变，变的是上下文。

这一章就把这件事拆开：记在哪、谁来记、什么时候记、怎么读回来。

## 两套记忆：你写的和它写的

官方 memory 文档把记忆分成两套，并排放一起看最清楚：

| | CLAUDE.md | 自动记忆（auto memory） |
|---|---|---|
| 谁写 | 你 | Claude |
| 内容 | 指令和规则 | 学到的经验和模式 |
| 范围 | 项目 / 用户 / 组织 | 每个仓库一份，所有 worktree 共享 |
| 加载 | 每个会话全文加载 | 每个会话加载 `MEMORY.md` 前 200 行或 25KB |

文档还特意强调了一句：两者都是**上下文，不是强制配置**。想无论如何都挡住某个操作，要用 PreToolUse hook。这句话我们在 [Harness Engineering](12-harness-engineering.md) 那章还会回来。

### 存在哪

文档写的是 `~/.claude/projects/<project>/memory/`，`<project>` 由 git 仓库推出来，所以同一个仓库的所有 worktree 和子目录共用一个记忆目录。

我看了你本机：23 个项目目录下有 `memory/`。最大的一个有 137 个文件，`MEMORY.md` 139 行、23,388 字节。

### 长什么样

目录结构是「一个索引 + 一堆主题文件」：

```text
~/.claude/projects/<project>/memory/
├── MEMORY.md            # 索引：一行一条，每个会话都加载
├── feedback_xxx.md      # 一条记忆一个文件
├── project_yyy.md
└── reference_zzz.md
```

主题文件带 frontmatter。你本机文件的 frontmatter 字段是 `name`、`description`、`metadata`（下面有 `type`、`node_type`、`originSessionId`、`modified`）。`type` 的取值在你本机的分布是：`feedback` 59 个、`project` 39 个、`reference` 38 个。文档列的四种类型是 `user`、`feedback`、`project`、`reference`，你本机恰好一个 `user` 都没有。

文档对「什么不记」也说得很清楚：能从代码库推出来的（架构、文件路径、debug 的修法）不记，CLAUDE.md 里已经写了的不记，也不是每个会话都会记点什么。

## 写路径：就是普通的 Write 和 Edit

```d2
shape: sequence_diagram
u: 你
m: 模型
t: "Write / Edit 工具"
d: "memory/ 目录"
u -> m: "「worktree 一律用 EnterWorktree，别 cd 进去」"
m -> m: "这条将来还用得上吗？是 feedback 类"
m -> t: "Write(feedback_worktree.md, frontmatter + 正文)"
t -> d: "写入主题文件"
m -> t: "Edit(MEMORY.md, 追加一行索引)"
t -> d: "更新索引"
t -> m: "成功；若索引接近 200 行 / 25KB，附带「请精简」提醒" {style.stroke-dash: 3}
```

你可能会问：有没有一个专门的「记忆工具」？

从本机证据看，没有专用工具，用的就是 Write 和 Edit：

- 本机会话里，有 76 次 Write、23 次 Edit 的结果带一个 `memdirStamped` 字段。我推测这是 Claude Code 给「写进记忆目录」的操作打的标记。（推测，依据是字段名，没有文档。）
- 官方权限文档的「受保护路径」一节写着：`.claude` 下的写操作一般不会自动放行，但**项目 auto memory 目录里的 markdown 文件是例外**。专门开这个例外，说明模型确实是用普通写文件的方式写记忆。
- 文档还说，Claude 写完 `MEMORY.md` 后，Claude Code 会量一下它离 200 行 / 25KB 还有多远，接近上限就提醒模型精简（一条一行、细节挪进主题文件、合并或删掉过时条目）；超了上限，写入照样成功，但会返回一个错误让模型重写索引。

那「什么时候写、写什么」由谁决定？由模型自己判断，判断依据写在 Claude Code 给它的指令里。具体指令文本我没去抓，结构我推测是：记忆类型的定义 + 什么值得记 + 什么不该记 + 文件格式。（推测）

这就是它和 Codex 最大的不同：**边聊边记，记了马上生效**。你在这个会话里纠正它一次，它写进文件，下一个会话立刻就能读到。下一章你会看到 Codex 走的是完全相反的路线。

## 读路径：只读索引，正文按需取

新会话启动时，`MEMORY.md` 的前 200 行或前 25KB（先到哪个算哪个）被放进上下文，主题文件**不**加载。模型看到索引里某一行和当前任务相关，再用 Read 去读那个主题文件。

打个比方，这像图书馆的卡片目录。进门只看目录卡片（索引），要哪本书再去书架上取（Read 主题文件）。目录太厚就失去意义了，所以它限制在 200 行以内。

类比的局限在于：图书馆的目录是按固定规则编的，而这里的「目录」是模型自己写的一行描述。描述写得含糊，模型就想不到要去读那本书。所以每一行索引的 description 都很关键。

还有一个细节：子目录里的 CLAUDE.md 不在启动时加载，而是 Claude 读写那个目录下的文件时才加载。本机 jsonl 里有 194 条 `nested_memory` 类型的记录，内容里带着子目录 CLAUDE.md 的路径（比如 `apps/web/CLAUDE.md`），应该就是这个按需加载留下的痕迹。

回到主线：记忆系统让模型拥有「跨会话的上下文」。它的全部技巧在于**分层**：最常用的一小块（索引）每次都付费放进来，其余的用一次 Read 按需换取。这和 skill 的渐进式加载是同一个思路。

## 动手：最小的索引式记忆

=== "Node"

    ```ts
    import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";

    const [MAX_LINES, MAX_BYTES] = [200, 25_000];   // 官方文档：MEMORY.md 启动时只加载前 200 行或前 25KB

    /** 写路径：模型在对话中用普通的 Write/Edit 工具做两件事——写主题文件 + 在索引里加一行。 */
    function saveMemory(memDir: string, slug: string, name: string, description: string, mtype: string, body: string) {
      writeFileSync(join(memDir, `${slug}.md`), [
        "---",
        `name: ${name}`,
        `description: ${description}`,
        "metadata:",
        `  type: ${mtype}`,
        "---",
        body,
        "",
      ].join("\n"));
      appendFileSync(join(memDir, "MEMORY.md"), `- [${name}](${slug}.md) — ${description}\n`);
    }

    /** 读路径：新会话启动时只把索引截断后塞进上下文，主题文件留给模型按需 Read。 */
    function loadIndex(memDir: string): string {
      const raw = readFileSync(join(memDir, "MEMORY.md"), "utf8");
      const lines = raw.split(/(?<=\n)/), out: string[] = [];
      let size = 0;
      for (const line of lines.slice(0, MAX_LINES)) {
        if (size + Buffer.byteLength(line) > MAX_BYTES) break;
        out.push(line); size += Buffer.byteLength(line);
      }
      const dropped = lines.length - out.length;
      const note = dropped ? `\n(MEMORY.md truncated: ${dropped} more lines not loaded)` : "";
      return out.join("") + note;
    }

    const d = mkdtempSync(join(tmpdir(), "mem-"));
    writeFileSync(join(d, "MEMORY.md"), "# Memory Index\n\n");
    saveMemory(d, "test-before-deploy", "部署前跑测试", "部署前先 pnpm test，再 deploy", "feedback",
      "规则：部署前必须先跑 pnpm test。\n**Why:** 上次跳过测试导致线上白屏。\n**How to apply:** 用户说『部署』时自动先跑测试。");
    for (let i = 0; i < 250; i++) saveMemory(d, `note-${i}`, `笔记 ${i}`, "某个一次性事实", "project", "...");
    const ctx = loadIndex(d);
    const ls = ctx.split("\n");
    console.log(ls[0], "|", ls[2].slice(0, 40));
    console.log("entries loaded:", ls.filter((l) => l.startsWith("- [")).length, "/ 251 | tail:", ls.at(-1));
    console.log("topic file loaded at startup?", ctx.includes("How to apply"));
    ```

=== "Python"

    ```python
    import os, tempfile, textwrap

    MAX_LINES, MAX_BYTES = 200, 25_000        # 官方文档：MEMORY.md 启动时只加载前 200 行或前 25KB

    def save_memory(mem_dir, slug, name, description, mtype, body):
        """写路径：模型在对话中用普通的 Write/Edit 工具做两件事——写主题文件 + 在索引里加一行。"""
        with open(os.path.join(mem_dir, f"{slug}.md"), "w") as f:
            f.write(textwrap.dedent(f"""\
                ---
                name: {name}
                description: {description}
                metadata:
                  type: {mtype}
                ---
                {body}
                """))
        with open(os.path.join(mem_dir, "MEMORY.md"), "a") as f:
            f.write(f"- [{name}]({slug}.md) — {description}\n")

    def load_index(mem_dir):
        """读路径：新会话启动时只把索引截断后塞进上下文，主题文件留给模型按需 Read。"""
        raw = open(os.path.join(mem_dir, "MEMORY.md"), encoding="utf-8").read()
        lines, out, size = raw.splitlines(True), [], 0
        for line in lines[:MAX_LINES]:
            if size + len(line.encode()) > MAX_BYTES:
                break
            out.append(line); size += len(line.encode())
        dropped = len(lines) - len(out)
        note = f"\n(MEMORY.md truncated: {dropped} more lines not loaded)" if dropped else ""
        return "".join(out) + note

    d = tempfile.mkdtemp()
    open(os.path.join(d, "MEMORY.md"), "w").write("# Memory Index\n\n")
    save_memory(d, "test-before-deploy", "部署前跑测试", "部署前先 pnpm test，再 deploy", "feedback",
                "规则：部署前必须先跑 pnpm test。\n**Why:** 上次跳过测试导致线上白屏。\n**How to apply:** 用户说『部署』时自动先跑测试。")
    for i in range(250):
        save_memory(d, f"note-{i}", f"笔记 {i}", "某个一次性事实", "project", "...")
    ctx = load_index(d)
    print(ctx.splitlines()[0], "|", ctx.splitlines()[2][:40])
    print("entries loaded:", sum(l.startswith("- [") for l in ctx.splitlines()), "/ 251 | tail:", ctx.splitlines()[-1])
    print("topic file loaded at startup?", "How to apply" in ctx)
    ```

===! "Node"

    ```text
    ❯ node memory_demo.ts
    # Memory Index | - [部署前跑测试](test-before-deploy.md) — 部署前先
    entries loaded: 198 / 251 | tail: (MEMORY.md truncated: 53 more lines not loaded)
    topic file loaded at startup? false
    ```

=== "Python"

    ```text
    ❯ uv run python memory_demo.py
    # Memory Index | - [部署前跑测试](test-before-deploy.md) — 部署前先
    entries loaded: 198 / 251 | tail: (MEMORY.md truncated: 53 more lines not loaded)
    topic file loaded at startup? False
    ```

（纯本地运行，不调用模型。最后那行截断提示是我的玩具实现加的，Claude Code 是否给模型类似提示我没有验证。）

写了 251 条，启动时只有 198 条索引进了上下文（200 行减去标题和空行），后面 53 行直接看不见。主题文件里那段 **Why / How to apply** 也不在启动上下文里，要靠模型主动去读。

这说明了一件事：**索引超了上限，后面的记忆就等于不存在**。这也是 Claude Code 要主动提醒模型精简索引的原因。

## 对照你的环境

- 你最大的那个 `MEMORY.md` 是 23,388 字节，离 25KB 只差 1.6KB 左右。行数是 139，离 200 行还远，所以**先撞上的会是字节上限**。按文档的说法，接下来写记忆时 Claude 应该会收到精简提醒。可以考虑主动整理一次：一行索引尽量短，细节放进主题文件。
- 你在 CLAUDE.md 里给记忆定了位：「一次性事实、单轮教训 → memory，不进 git；`env/backup-memory.sh` 异地备份」。这和官方设计吻合：记忆是机器本地的，不跨机器同步，备份得自己做。
- 你的分层规则「每次都必须遵守的 → guardrails，多步流程 → skill，一次性事实 → memory」，本质上是在按「加载成本」分层：guardrails 每次全量注入，memory 只注入索引，skill 用到才加载。
- 官方文档说主会话的 auto memory **不会**加载进 subagent（fork 除外）。你常用 subagent 做调研，它们看不到你的记忆。需要的话，在派发 prompt 里把相关的那条记忆写进去。

## 回到开头的问题

它为什么越用越懂你？因为每次你纠正它，它就往 `memory/` 里写一个 markdown，在索引里加一行；下个会话开头，这份索引就在上下文里。模型没变，变的是它每次开工前读到的那页笔记。

## 常见坑

1. **索引写成正文**：一行索引塞一段话，很快撞到 25KB，后面的记忆全被截掉。
2. **description 写得太含糊**：模型从索引里看不出这条和当前任务相关，就不会去读主题文件。
3. **记了能从代码推出来的东西**：浪费索引行数，而且代码一改就过时。
4. **以为记忆是强制的**：它只是上下文。必须守住的规则交给 hook 或权限。
5. **跨机器以为会同步**：不会。记忆是机器本地的。

## 练习

1. 给上面的玩具加一个 `forget(slug)`：删主题文件，同时从索引里删掉那一行。
2. 写一个脚本扫描你本机某个 `memory/` 目录：找出索引里指向不存在文件的行，以及没有被索引引用的主题文件。（只读，不要改你的真实记忆。）
3. 开放题：「边聊边记」的好处是马上生效，坏处是可能把一次性的、甚至错误的结论记成长期经验。如果让你加一个「记忆审核」环节，你会放在写入时、读取时，还是定期批处理？各有什么代价？

## 延伸阅读

- 官方 memory 文档（CLAUDE.md 层级、auto memory）：https://code.claude.com/docs/en/memory
- 受保护路径与 auto memory 例外：https://code.claude.com/docs/en/permission-modes
- 本库：[上一章 上下文压缩](05-context-compaction.md)、[下一章 Codex 自动记忆](07-auto-memory.md)、[Skills 渐进式加载](../p1-tools/12-skills.md)、[mini Claude Code：长期记忆](../p4-mini-cc/12-memory.md)
