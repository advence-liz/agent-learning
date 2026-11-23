# Claude Code Harness 搭建指南（详实版）

**先在一个小项目里建立运行边界，再把可复用的配置打包。** 上下文告诉模型应该做什么；Skills、Subagents 和 MCP 扩展能力；Hooks 与权限在运行时执行规则；插件负责分发。本文保留逐层配置、进阶细节和端到端示例。想先理解软约束和硬约束的区别，可以从[《Harness Engineering 是什么》](../p3-agent-internals/12-harness-engineering.md)读起。

> **使用边界：** 示例面向虚构项目。复制前检查工具版本、权限和依赖。Hooks 是本地运行时检查，不代替沙箱、服务端授权或独立 CI 门禁。原稿提到的「原图」指其评析的旧架构示意，下面的勘误已列明具体问题，本章不转载该图。

## Harness = 用四个问题分清配置的职责



<div>
<span>结论先行</span>
        任何一个 Claude Code 项目的 harness，本质上只需要回答四个 MECE（相互独立、完全穷尽）的问题：① Claude 知道什么（Context）② Claude 会做什么（Capability）③ 按什么顺序做（Orchestration）④ 什么必须发生、什么绝不允许（Enforcement）。原图的五个"核心组件"只回答了①②③，④完全空缺——而④恰恰是本指南篇幅最长、demo 最多的部分，因为它是全文唯一"不讲道理、直接拦截"的一层。
</div>

<p>下面四条是支撑上面结论的一级论点，也对应左侧导航的四个分组，按这个顺序读下去，由浅入深：</p>

<ul>
<li><b>论点 1 · Context 层回答"知道什么"</b>——CLAUDE.md、Auto Memory、路径限定规则。特点：占用上下文、按作用域加载，但本质是"写给 Claude 看的说明书"，模型仍可能因权衡而偏离。</li>
<li><b>论点 2 · Capability + Orchestration 层回答"会做什么、按什么顺序"</b>——Skills 沉淀重复任务，Subagents 隔离上下文分工，Slash Commands 给固定流程一个触发入口。三者共同点：都要 Claude"愿意"去调用，本质仍是"建议"。</li>
<li><b>论点 3 · Enforcement 层回答"必须发生 / 绝不允许"</b>——Hooks 与 Permissions，是整套系统里唯一不依赖模型意愿、能物理拦截工具调用的一层。本指南会给出完整可运行的脚本。</li>
<li><b>论点 4 · Distribution 层回答"怎么规模化"</b>——Plugins + Marketplace，把前三层打包分发给团队，是最后一步，不是第一步。</li>
</ul>

<div>
<div>
<div><div>① Context 层</div><div>Claude 每次会话开始时知道什么</div></div>
<span>CLAUDE.md · Auto Memory</span>
</div>
<div>↓ 会话启动时加载</div>
<div>
<div><div>② Capability 层</div><div>Claude 具备哪些可调用的能力</div></div>
<span>Skills · Subagents · MCP Tools</span>
</div>
<div>↓ 按需被发现 / 被调用</div>
<div>
<div><div>Orchestration 层</div><div>按什么顺序、由谁来做</div></div>
<span>Slash Commands · Subagent 派发</span>
</div>
<div>↓ 每一次 tool call 都要经过这里 ↓</div>
<div>
<div><div>③ Enforcement 层</div><div>由运行时在事件上执行的检查</div></div>
<span>Hooks · Permissions</span>
</div>
<div>↓ 团队协作时</div>
<div>
<div><div>④ Distribution 层</div><div>这套配置怎么在团队里复用</div></div>
<span>Plugins · Marketplace</span>
</div>
</div>

<div>
<b>怎么读这份指南：</b>每一节都固定按"结论 → Level 1 基础 → Level 2 进阶 → Level 3 高阶/坑 → 实操 Demo"的顺序展开，由浅入深。赶时间只看每节的结论框和 Demo 就能跑起来；要抠细节再展开 Level 2、Level 3。
</div>

## CLAUDE.md


<span>Claude Code 原生识别</span>
<span>Context，非强制</span>

<div><span>结论先行</span>CLAUDE.md 是占用上下文、不能强制执行的指令：写得越少、约束力越强。它和一段很长的 system prompt 本质相同，能"说服"但不能"强制"——真正的强制永远在 Enforcement 层（见 Hooks 一节）。</div>

<span>Level 1 · 基础</span>
<p>最快的起步方式是用内置命令自动生成骨架：</p>
<div>
<div>terminal</div>
<pre><code>$ cd my-project
$ claude
&gt; /init</code></pre>

<div>Claude 会扫描项目结构、package.json / pyproject.toml 等文件，生成一份包含构建命令、目录结构、技术栈的初始 <code>CLAUDE.md</code>。</div>
</div>
<p>也可以完全手写，这是一份真实可用的最小模板：</p>
<div>
<div>terminal</div>
<pre><code>$ cat &gt; CLAUDE.md &lt;&lt; 'EOF'
# 项目规则

## 构建命令
- `pnpm dev`   启动开发服务器
- `pnpm test`  跑单测
- `pnpm build` 生产构建

## 硬性约定
- TypeScript strict 模式，禁止 any
- API 返回统一走 { data, error } 结构
- 数据库查询必须带 projection，禁止 select *
EOF</code></pre>

</div>

<span>Level 2 · 进阶</span>
<div>
<h3>三个作用域：内容读入上下文，不按键覆盖</h3>
<table>
<tr><th>位置</th><th>作用域</th></tr>
<tr><td><span>./CLAUDE.md</span></td><td>项目级，进版本库，团队共享</td></tr>
<tr><td><span>~/.claude/CLAUDE.md</span></td><td>个人级，跨所有项目生效</td></tr>
<tr><td>企业 managed 配置</td><td>组织级，由管理员分发；指令本身仍不等同于权限策略</td></tr>
</table>
<p>子目录里的嵌套 <code>CLAUDE.md</code> 也会被发现，但只在 Claude 实际访问该子目录下文件时才加载/重载；根目录的 CLAUDE.md 在 <code>/compact</code> 后会重新读取注入，嵌套的不会自动重注。</p>
</div>

<details>
<summary>@import 语法实操：把原图的 harness/workflow.md 真正接进去</summary>
<div>
<p>原图的 <code>harness/workflow.md</code> 之所以不生效，是因为没有任何机制告诉 Claude Code 去读它。用 <code>@</code> 语法接进 CLAUDE.md 就能修好这一点：</p>
<div>
<div>CLAUDE.md</div>
<pre><code># 项目规则
@harness/workflow.md
@harness/orchestrator.md</code></pre>

</div>
<p>注意：<b>被 import 的文件依旧会在启动时整体加载进 context，并不会节省 token</b>，只是方便维护和分文件管理。可以在会话里用 <code>/context</code> 查看当前 context 占用，验证 import 的内容确实被计入。官方建议单个 CLAUDE.md（含 import 展开后）控制在 200 行以内，超长内容应该拆成 Skill 或下面的"路径限定规则"，而不是无脑塞进去。</p>
</div>
</details>

<details>
<summary>路径限定规则（Path-scoped Rules）实操</summary>
<div>
<p>位置：<span>.claude/rules/*.md</span>。默认无条件加载，等同于 CLAUDE.md 的一部分；只想在处理特定路径时才生效，加一个 <code>paths</code> 的 YAML frontmatter：</p>
<div>
<div>.claude/rules/api-conventions.md</div>
<pre><code>---
paths:
  - "src/api/**/*.ts"
---
所有 API handler 必须用 zod 校验入参，错误统一抛 ApiError，
禁止在 handler 里直接 catch 后吞掉异常。</code></pre>

<div>效果：编辑 <code>src/api/orders.ts</code> 时这条规则会被加载；编辑 <code>src/utils/date.ts</code> 时不会——这就是"挪到别处"的那个"别处"，比整篇塞进 CLAUDE.md 更精准。</div>
</div>
</div>
</details>

<details>
<summary>CLAUDE.local.md ——项目内的"个人纸条"</summary>
<div>
<p>和项目 CLAUDE.md 同级但应主动加入 <code>.gitignore</code>，适合放本机才有意义的东西：本地测试用的 URL、个人调试开关。共享维度是"项目内、仅自己"。</p>
</div>
</details>

<span>Level 3 · 高阶 / 常见坑</span>
<div>
<b>最常见的坑：把 CLAUDE.md 当成"知识库"无限堆内容。</b>官方明确指出，超过 200 行的 CLAUDE.md 会占用更多 context、并降低 Claude 对指令的遵从度——不是"多写不吃亏"，是"多写真的会变笨"。判断标准很简单：这条信息是"每次会话都用得到的硬事实"，还是"只在特定场景才相关的多步骤流程"？前者留在 CLAUDE.md，后者挪到 Skill 或路径限定规则。
</div>

<details>
<summary>Auto Memory（和 CLAUDE.md 是两套机制）</summary>
<div>
<p>Claude Code 还有一套独立的"自动记忆"：Claude 根据你的纠正和偏好自己写笔记，不需要你手动维护。CLAUDE.md 是你写给 Claude 的规则，Auto Memory 是 Claude 自己积累的经验。</p>
<p><b>精确存储路径：</b><span>~/.claude/projects/&lt;项目路径标识&gt;/memory/MEMORY.md</span>，外加按主题拆分的 <code>debugging.md</code> 等文件。以 git 仓库根目录来定位"项目"；启动时只加载 <code>MEMORY.md</code> 的前 200 行或 25 KB，以先到者为准。</p>
<p><b>能自定义吗：</b>内容可以，用 <code>/memory</code> 随时手动编辑或删减；<b>可通过 <code>autoMemoryDirectory</code> 配置存储目录</b>。</p>
<p><b>要不要进 git：</b>物理上就不在项目仓库里，天然不会被提交。想让某条 auto memory 全队共享，只能手动搬进项目 CLAUDE.md，或用下文 project 作用域的 Subagent Memory。</p>
</div>
</details>

<div>
<h3>Context 层配置速查</h3>
<table>
<tr><th>机制</th><th>存储路径</th><th>进 Git？</th><th>共享维度</th></tr>
<tr><td>项目 CLAUDE.md</td><td><span>./CLAUDE.md</span></td><td>✅ 是</td><td>团队共享</td></tr>
<tr><td>个人 CLAUDE.md</td><td><span>~/.claude/CLAUDE.md</span></td><td>❌ 不在项目仓库内</td><td>仅自己，跨所有项目</td></tr>
<tr><td>CLAUDE.local.md</td><td><span>./CLAUDE.local.md</span></td><td>❌ 主动加入 .gitignore</td><td>仅自己，限当前项目</td></tr>
<tr><td>路径限定规则</td><td><span>.claude/rules/*.md</span></td><td>✅ 建议进</td><td>团队共享，可用 <code>paths</code> 限定触发范围</td></tr>
<tr><td>Auto Memory</td><td><span>~/.claude/projects/&lt;project&gt;/memory/</span></td><td>❌ 默认不在仓库内</td><td>仅自己这台机器</td></tr>
</table>
</div>

## Skills


<span>Claude Code 原生识别</span>

<div><span>结论先行</span>一个操作出现第三次，就该从"每次重新解释一遍"升级成一个 Skill——目录名即触发名，目录里必须有 <code>SKILL.md</code>，这是和原图出入最大的地方。</div>

<span>Level 1 · 基础</span>
<p>完整实操：从零建一个"生成 commit message"的 skill。</p>
<div>
<div>terminal</div>
<pre><code>$ mkdir -p .claude/skills/commit-message
$ cat &gt; .claude/skills/commit-message/SKILL.md &lt;&lt; 'EOF'
---
name: commit-message
description: 根据 git diff 生成符合 Conventional Commits 规范的提交信息。用户要求写 commit message 时使用。
---
## 步骤
1. 运行 `git diff --staged` 查看改动
2. 判断类型：feat / fix / refactor / docs / test / chore
3. 输出一行 &lt;type&gt;(&lt;scope&gt;): &lt;subject&gt;，subject 不超过 50 字符
EOF</code></pre>

</div>
<div>
<div>Claude Code 会话</div>
<pre><code>&gt; 帮我写个 commit message</code></pre>

<div>你会看到 Claude 先打印 <b>Launching skill: commit-message</b>，再照着步骤执行——这就是 skill 被自动触发的实际样子，全靠 <code>description</code> 写得够具体。</div>
</div>

<span>Level 2 · 进阶</span>
<div>
<h3>正确的目录结构（原图漏掉的一层嵌套）</h3>
<pre><code>.claude/skills/
└── code-review/          ← 目录名 = 触发这个 skill 的名字
    ├── SKILL.md           ← 必须，YAML frontmatter + 指令正文
    ├── references/        ← 可选，Claude 按需才读，不占常驻 context
    │   └── checklist.md
    ├── scripts/            ← 可选，可执行脚本
    │   └── run_lint.sh
    └── assets/             ← 可选，模板/静态文件</code></pre>

</div>

<details>
<summary>带 references + scripts 的完整示例</summary>
<div>
<div>
<div>.claude/skills/code-review/SKILL.md</div>
<pre><code>---
name: code-review
description: 审查最近的 diff 并按严重程度分类反馈。用户要求 review / 检查 / 审计代码时使用。
---
## 步骤
1. 运行 `git diff` 查看改动
2. 对照 references/checklist.md 逐项检查
3. 需要静态检查时运行 scripts/run_lint.sh
4. 按 Critical / Warning / Suggestion 三级分类给反馈</code></pre>

</div>
<div>
<div>.claude/skills/code-review/references/checklist.md</div>
<pre><code># 审查清单
- [ ] 是否有硬编码密钥/密码
- [ ] 错误处理是否完整
- [ ] 是否有对应的单测
- [ ] 数据库查询是否有 N+1</code></pre>

</div>
<p>这个 <code>checklist.md</code> 不会一开始就占用 context，只有 SKILL.md 正文里显式提到"对照 references/checklist.md"、且 Claude 判断需要时才会读取——这就是 progressive disclosure 的具体样子。</p>
</div>
</details>

<details>
<summary>限制触发方式：手动调用不等于预批准工具</summary>
<div>
<div>
<div>.claude/skills/deploy-staging/SKILL.md</div>
<pre><code>---
name: deploy-staging
description: 部署当前分支到 staging 环境
disable-model-invocation: true
---
部署到 staging，先跑 `pnpm build`，成功后执行 `./scripts/deploy.sh staging`。</code></pre>

</div>
<p><code>disable-model-invocation: true</code> 之后，Claude <b>不会</b>自动猜着用它，只有你手动敲 <code>/deploy-staging</code> 才会触发——有风险的操作（部署、发布）建议都这样收紧，避免 Claude"好心办坏事"式的自动调用。<code>allowed-tools</code> 是预批准，不是工具白名单；这里不预批准 Bash，实际调用仍受权限控制。</p>
</div>
</details>

<h3>常见来源：个人、项目和插件</h3>
<table>
<tr><th>类型</th><th>路径</th><th>进 Git？</th><th>共享范围</th></tr>
<tr><td>Personal</td><td><span>~/.claude/skills/</span></td><td>❌ 不在项目仓库内</td><td>只在你自己机器上，跨所有项目</td></tr>
<tr><td>Project</td><td><span>.claude/skills/</span></td><td>✅ 建议提交</td><td>团队共享</td></tr>
<tr><td>Plugin</td><td>插件包内 <code>skills/</code></td><td>✅ 随插件仓库（如 marketplace）版本控制</td><td>随插件安装分发</td></tr>
</table>

<p>企业、个人和项目 Skill 同名时，优先级为企业 &gt; 个人 &gt; 项目；插件 Skill 使用命名空间。上表不是优先级表。</p><span>Level 3 · 高阶 / 常见坑</span>
<div>
<b>Progressive Disclosure（渐进加载）三级火箭：</b>①会话开始只加载每个 skill 的 <code>name</code> + <code>description</code>；②判断相关时加载整篇 SKILL.md；③SKILL.md 里引用的 references/scripts 再按需加载。<b>description 写得越具体，触发越准</b>——"处理文档"这种描述基本等于没写。
</div>
<div>
        新增或编辑 Skill 后，先在新一次调用中确认正文；未发现时可用 <code>/reload-skills</code>。插件的 Hooks 或 MCP 配置变动用 <code>/reload-plugins</code>，并检查实际加载结果。
</div>

## Subagents


<span>Claude Code 原生识别</span>

<div><span>结论先行</span>建 subagent 不是为了"看起来分工明确"，唯一站得住脚的理由是<b>上下文隔离</b>：把会撑爆主会话 context 的探索/审查工作丢给一个独立 context window 的角色，主会话只收结果摘要。</div>

<span>Level 1 · 基础</span>
<p>历史用法：旧版可交互式创建。<a href="https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21198">2.1.198 已移除创建向导</a>；现行版本直接使用下方项目文件，也可用 <code>/agents</code> 查看已加载角色。</p>
<div>
<div>Claude Code 会话</div>
<pre><code>&gt; /agents</code></pre>

<div>选 <b>Create new agent</b> → <b>Project</b> → <b>Generate with Claude</b>，用一句话描述这个 agent 要做什么，Claude 会自动生成 description、system prompt，并让你勾选工具白名单。</div>
</div>
<p>手写等价文件：</p>
<div>
<div>.claude/agents/code-reviewer.md</div>
<pre><code>---
name: code-reviewer
description: 审查最近改动的代码质量与安全性，写完代码后主动使用
tools: Read, Grep, Glob, Bash
model: sonnet
---
你是一名资深代码审查员，专注于安全性、可读性与可维护性……</code></pre>

</div>
<div>
<div>Claude Code 会话</div>
<pre><code>&gt; 用 code-reviewer 看一下这次改动</code></pre>

<div>或者不点名，Claude 会根据 description 自动判断要不要委派——两种触发方式都存在。</div>
</div>

<span>Level 2 · 进阶</span>
<p>必填只有 <code>name</code>、<code>description</code>；常用字段：<code>tools</code>（限制工具访问面，最小权限原则）、<code>model</code>（别名 sonnet/opus/haiku/fable，或完整模型 ID）、<code>disallowedTools</code>、<code>skills</code>（预先注入指定 skill 内容）、<code>isolation: worktree</code>（隔离仓库副本）。</p>

<details>
<summary>isolation: worktree 实操——让 subagent 在隔离副本里搞风险操作</summary>
<div>
<div>
<div>.claude/agents/risky-refactor.md</div>
<pre><code>---
name: risky-refactor
description: 执行大范围重构，可能改动几十个文件
tools: Read, Write, Edit, Bash
isolation: worktree
---
在隔离的 worktree 里执行重构，改完跑一遍 `pnpm test`，全绿再汇报。</code></pre>

</div>
<p>这个 subagent 会在一份隔离的仓库副本里工作，不会污染你主会话正在编辑的文件；重构失败也不影响主分支状态。</p>
</div>
</details>

<table>
<tr><th>来源</th><th>路径</th><th>进 Git？</th><th>共享范围</th></tr>
<tr><td>Project</td><td><span>.claude/agents/</span>（沿目录向上逐级扫描，直到仓库根）</td><td>✅ 建议提交</td><td>团队共享</td></tr>
<tr><td>Personal</td><td><span>~/.claude/agents/</span></td><td>❌ 不在项目仓库内</td><td>仅自己，跨所有项目</td></tr>
<tr><td>Managed</td><td>组织下发目录，管理员配置</td><td>❌ 非 git，MDM/注册表统一下发</td><td>全组织，同名时覆盖项目/个人定义</td></tr>
<tr><td>Plugin</td><td>插件内置</td><td>✅ 随插件仓库版本控制</td><td>出于安全考虑，插件带的 subagent <b>不支持</b> <code>hooks</code>/<code>mcpServers</code>/<code>permissionMode</code> 字段</td></tr>
</table>

<div>内置已经有三个免配置的 subagent：<code>Explore</code>（只读、默认跑更便宜的模型，专门做代码库检索）、<code>Plan</code>（Plan Mode 下收集上下文）、<code>general-purpose</code>（兼具探索与修改）。不要一上来就自建一堆角色，先看这三个够不够。</div>

<span>Level 3 · 高阶：Subagent Memory</span>
<p>让某个角色跨会话积累经验——frontmatter 里的 <code>memory</code> 字段（v2.1.33 起支持，2026 年 2 月上线）。</p>

<div>
<h3>实操：一个会越用越懂项目的 code-reviewer</h3>
<div>
<div>.claude/agents/code-reviewer.md</div>
<pre><code>---
name: code-reviewer
description: 审查代码质量与最佳实践
tools: Read, Grep, Glob, Bash
memory: project
---
你是代码审查员。审查开始前，先检查自己的 memory 里是否已有相关模式/历史问题；
审查结束后，把新发现的模式、约定、反复出现的问题更新进 memory。</code></pre>

</div>
<p><b>第一次调用：</b>memory 目录是空的，审查完之后 Claude 主动写入 <code>MEMORY.md</code>："本项目 API 层反复出现未做入参校验的问题，已提醒 3 次。"</p>
<p><b>第二次调用（哪怕是几天后的新会话）：</b>system prompt 里会自动带上这条记录，Claude 上来就会重点扫一遍入参校验，而不是从零开始摸索这个项目的坏习惯。</p>
<div>重点：光声明 <code>memory: project</code> 不会让 Claude 自动养成"读写memory"的习惯，<b>必须在 system prompt 里显式提示</b>"开始前检查 memory，结束后更新 memory"，这是本例第一句和最后一句话在做的事。</div>
</div>

<h3>三种 scope，存储路径、Git、共享维度都不同</h3>
<table>
<tr><th>Scope</th><th>存储路径</th><th>进 Git？</th><th>共享范围</th><th>适合放什么</th></tr>
<tr><td><code>user</code></td><td><span>~/.claude/agent-memory/&lt;agent-name&gt;/</span></td><td>❌ 不在项目仓库内</td><td>仅自己，跨所有项目——推荐默认值</td><td>跨项目通用的经验</td></tr>
<tr><td><code>project</code></td><td><span>.claude/agent-memory/&lt;agent-name&gt;/</span></td><td>✅ 是</td><td>团队共享</td><td>本项目特有的架构决策、约定</td></tr>
<tr><td><code>local</code></td><td><span>.claude/agent-memory-local/&lt;agent-name&gt;/</span></td><td>❌ 应列入忽略规则</td><td>仅自己，限当前项目</td><td>个人私有笔记</td></tr>
</table>

<details>
<summary>运行时行为与不可自定义的边界</summary>
<div>
<ul>
<li>每次调用自动把 memory 目录下 <code>MEMORY.md</code> 的<b>前 200 行或 25KB（以较小者为准）</b>注入 system prompt，超出部分需要 Claude 自己拆分成主题文件。</li>
<li>只要设了 <code>memory</code> 字段，<code>Read</code>/<code>Write</code>/<code>Edit</code> 会<b>自动被授予</b>，不受 <code>tools</code> 字段限制——一个只给了 <code>Read, Grep</code> 的只读审查 agent，依然能写它自己的 memory 目录。</li>
<li>存储路径命名（<code>agent-memory/&lt;name&gt;</code>）固定，不可重命名或重定向。</li>
</ul>
</div>
</details>

<div>
<b>关键限制：Agent Memory 按角色隔离</b>：每个 subagent 的 memory 按名字彼此隔离——<code>code-reviewer</code> 的 memory 对 <code>test-runner</code> 不可见。如果希望多个角色共享经过复核的项目知识（例如不稳定测试的已知原因），原生 <code>memory</code> 字段做不到，只能（1）把这类知识写回项目 CLAUDE.md，或（2）约定多个 agent 读写同一份自定义共享文件（非原生行为）。
</div>

## Slash Commands


<span>Claude Code 原生识别</span>
<span>正在被 Skills 收编</span>

<div><span>结论先行</span>给一个固定流程一个"打字就能触发"的入口。当前状态：一个 command 文件和一个同名 Skill 产生同样的 <code>/name</code> 入口，两者都存在时 Skill 优先，官方建议新项目直接用 Skill。</div>

<span>Level 1 · 基础</span>
<div>
<div>.claude/commands/new-branch.md</div>
<pre><code>---
description: 根据 issue 号生成分支名并切换
---
git checkout -b feature/$ARGUMENTS</code></pre>

</div>
<div>
<div>Claude Code 会话</div>
<pre><code>&gt; /new-branch 1234</code></pre>

<div><code>$ARGUMENTS</code> 被替换成 <code>1234</code>，实际执行 <code>git checkout -b feature/1234</code>。</div>
</div>

<span>Level 2 · 存储与共享</span>
<table>
<tr><th>位置</th><th>进 Git？</th><th>共享范围</th></tr>
<tr><td><span>.claude/commands/</span></td><td>✅ 建议提交</td><td>团队共享，人人都能敲同一个 <code>/name</code></td></tr>
<tr><td><span>~/.claude/commands/</span></td><td>❌ 不在项目仓库内</td><td>仅自己，跨所有项目</td></tr>
</table>
<div>原图的 <code>harness/workflow.md</code> 想变成真正可重复触发的流程，比起写成一篇静态文档，更准确的落地方式就是上面这样做成一个 slash command（或更进一步做成一个 skill）。</div>

## Hooks


<span>Claude Code 原生识别</span>
<span>真正的强制执行</span>

<div><span>结论先行</span>Hooks 是整个 harness 里唯一能对 Claude 说"不"的地方——CLAUDE.md / Skills / Subagent 里写的都是"请这样做"，模型仍可能因为权衡、误解、上下文压力而不照做；Hooks 是在特定生命周期节点<b>强制</b>执行的脚本或判定，不依赖模型"愿不愿意"。这正是"verification loop 是 harness engineering 核心杠杆"这个判断的具体落地机制。</div>

<span>Level 1 · 基础：从一个桌面通知开始</span>
<p>最简单、零风险的 hook：Claude 需要你确认时弹一个系统通知。</p>
<div>
<div>.claude/settings.json</div>
<pre><code>{
  "hooks": {
    "Notification": [
      { "matcher": "permission_prompt", "hooks": [{ "type": "command", "command": "osascript -e 'display notification \"Claude 需要你确认\" with title \"Claude Code\"'" }] }
    ]
  }
}</code></pre>

<div>效果：Claude 暂停等你输入的那一刻，Mac 弹出系统通知——不涉及拦截，纯提醒，适合当作"第一个 hook"练手。</div>
</div>

<span>Level 2 · 进阶：真正的拦截与自动化</span>
<h4>Demo A — PreToolUse：用最小例子演示拒绝判定</h4>
<div>
<div>terminal</div>
<pre><code>$ mkdir -p .claude/hooks
$ cat &gt; .claude/hooks/guard-dangerous-bash.sh &lt;&lt; 'EOF'
#!/usr/bin/env bash
input=$(cat)
if ! cmd=$(printf '%s' "$input" | jq -er '.tool_input.command | strings'); then
  echo "无法读取 Bash 命令，拒绝本次调用。" &gt;&amp;2
  exit 2
fi
if echo "$cmd" | grep -qE 'rm -rf (/|~|\*)|DROP TABLE'; then
  echo "命中示例拦截规则，不执行该命令。" &gt;&amp;2
  exit 2
fi
exit 0
EOF
$ chmod +x .claude/hooks/guard-dangerous-bash.sh</code></pre>

</div>
<div>
<div>.claude/settings.json</div>
<pre><code>{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "bash \"${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-dangerous-bash.sh\"" }] }
    ]
  }
}</code></pre>

<div>效果：Claude 想执行 <code>rm -rf /</code> 时，工具调用会被<b>直接挡下</b>，Claude 收到 stderr 里的原因，转而尝试别的方式或向你确认——这一步不依赖 Claude"愿不愿意"听劝。</div>
</div>

<h4>Demo B — PostToolUse：写完文件自动跑 lint</h4>
<div>
<div>.claude/settings.json</div>
<pre><code>{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "bash \"${CLAUDE_PROJECT_DIR}/.claude/hooks/lint-edited-file.sh\"" }] }
    ]
  }
}</code></pre>

<div>作用：匹配的 Write/Edit 成功后，以本地安装的 ESLint 检查路径。Lint 失败可反馈给模型，不会回滚已写入的文件；其他文件类型略过。脚本按启动项目目录定位，但检查在工具所在工作目录执行，切换 checkout 时要确认 cwd。</div>
</div>

<p>保存为 <code>.claude/hooks/lint-edited-file.sh</code>。需要 Bash、jq 和项目已安装的 ESLint：</p>
<pre><code>#!/usr/bin/env bash
set -euo pipefail
input=$(cat)
file=$(jq -r '.tool_input.file_path // empty' &lt;&lt;&lt; "$input")
cwd=$(jq -r '.cwd // empty' &lt;&lt;&lt; "$input")
cd -- "${cwd:-$PWD}"
case "$file" in
  *.js|*.jsx|*.ts|*.tsx) pnpm exec eslint -- "$file" &gt;&amp;2 || exit 2 ;;
esac</code></pre>
<p>该拦截示例只是对少量字符串的教学演示，不能作为安全隔离。正则无法可靠理解任意 shell；实际边界应通过最小权限、沙箱、执行端授权和 CI 来实现。</p>
<h3>事件按节奏分三类</h3>
<table>
<tr><th>节奏</th><th>代表事件</th><th>典型用途</th></tr>
<tr><td>每次 session</td><td><code>SessionStart</code> / <code>SessionEnd</code></td><td>注入分支名等动态上下文、收尾清理</td></tr>
<tr><td>每个回合</td><td><code>UserPromptSubmit</code> / <code>Stop</code> / <code>StopFailure</code></td><td>结束前拦截"没跑测试就说完成"</td></tr>
<tr><td>每次工具调用</td><td><code>PreToolUse</code> / <code>PostToolUse</code></td><td>拦截危险命令、自动 lint/format、审计日志</td></tr>
</table>

<span>Level 3 · 高阶：把"应该做"变成"不做完不让走"</span>
<h4>Demo C — Stop hook：首次测试失败时反馈并阻止收尾</h4>
<p>这是全文最重要的一个 demo（需要 Bash、jq 和 pnpm）：把收尾前检查这类"skill 里写的自觉纪律"，升级成"由运行时执行的检查"。</p>
<div>
<div>terminal</div>
<pre><code>$ cat &gt; .claude/hooks/check-tests-passed.sh &lt;&lt; 'EOF'
#!/usr/bin/env bash
set -euo pipefail
input=$(cat)
active=$(jq -r '.stop_hook_active // false' &lt;&lt;&lt; "$input")
if [[ "$active" == true ]]; then
  exit 0  # 避免重复阻塞；CI 仍应独立判定
fi
cwd=$(jq -r '.cwd // empty' &lt;&lt;&lt; "$input")
cd -- "${cwd:-$PWD}"
if ! pnpm run test &gt;&amp;2; then
  echo '{"decision":"block","reason":"测试命令失败。请在同一工作目录手动运行 pnpm run test，查看失败并修复；未验证前不要报告完成。"}'
  exit 0
fi
exit 0
EOF
$ chmod +x .claude/hooks/check-tests-passed.sh</code></pre>

</div>
<div>
<div>.claude/settings.json</div>
<pre><code>{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "bash \"${CLAUDE_PROJECT_DIR}/.claude/hooks/check-tests-passed.sh\"" }] }
    ]
  }
}</code></pre>

<div>效果：正常回合准备结束时，Stop hook 运行非 watch 的 <code>pnpm run test</code>，与 Claude 有没有说「完成」无关。首次失败用 JSON <code>reason</code> 请求继续处理；退出 0 时不能靠 stderr 把失败详情反馈给模型，所以例子明确要求重跑。为防反复阻塞，重入时跳过，不保证第二次结束时测试已通过。<b>这就是原图"harness/workflow.md 写一句请测试通过"和这里的根本区别</b>：前者是请求，后者是运行时检查（不替代独立 CI）。</div>
</div>

<details>
<summary>五种 handler 类型（并非每个事件都支持全部类型）</summary>
<div>
<table>
<tr><th>类型</th><th>说明</th></tr>
<tr><td><code>command</code></td><td>执行一段 shell 脚本，从 stdin 读 JSON</td></tr>
<tr><td><code>http</code></td><td>POST 到一个 webhook，收 JSON 响应</td></tr>
<tr><td><code>prompt</code></td><td>让 Claude 自己评估一段判定 prompt，主要用在 <code>Stop</code>/<code>SubagentStop</code></td></tr>
<tr><td><code>agent</code></td><td>启动一个有独立上下文的验证 Agent；详见事件支持表</td></tr>
<tr><td><code>mcp_tool</code></td><td>直接调用某个已配置的 MCP 工具</td></tr>
</table>
</div>
</details>

<details>
<summary>控制方式：exit code 与 JSON 输出细节</summary>
<div>
<p><code>PreToolUse</code> 里 exit code <b>2</b> = 阻止这次工具调用并把 stderr 反馈给 Claude；更精细的控制用 JSON：</p>
<pre><code>{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "禁止直接修改 .env 文件"
  }
}</code></pre>
<p><code>permissionDecision</code> 取值 <code>allow</code> / <code>deny</code> / <code>ask</code>；<code>updatedInput</code> 还能在工具真正执行前改写它的参数。</p>
</div>
</details>

<details>
<summary>调试技巧：hook 没生效怎么排查</summary>
<div>
<div>
<div>terminal</div>
<pre><code># 查看当前生效的 hook 列表
&gt; /hooks

# 脱离 Claude Code，本地直接测试脚本逻辑
$ echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' \
  | .claude/hooks/guard-dangerous-bash.sh; echo "exit code: $?"</code></pre>

<div>先确认脚本本身逻辑对，再确认 settings.json 里的 matcher 拼写和事件名大小写正确——这两处是 hook"看起来配了但没生效"最常见的原因。</div>
</div>
</div>
</details>

<div>
        原图的 <code>harness/workflow.md</code>："写工作流文档" ≈ <i>request</i>（可被忽略）；Hooks ≈ <i>enforcement</i>（已配置且事件触发时由运行时执行）。这是原图"harness"概念里缺的最关键一块。
</div>

## Permissions（settings.json）


<span>Claude Code 原生识别</span>
<span>权限护栏</span>

<div><span>结论先行</span>Hooks 管"复杂判断"，Permissions 管"简单的能不能"——不需要写脚本、判定顺序固定为 deny → ask → allow，成本比 Hooks 低得多，应该最先配置。</div>

<span>Level 1 · 基础：先划安全底线</span>
<div>
<div>.claude/settings.json</div>
<pre><code>{
  "permissions": {
    "deny": ["Bash(rm -rf:*)", "Read(**/.env)", "Read(**/*secret*)"]
  }
}</code></pre>

<div>效果：命中这些工具规则的调用会被直接拒绝。它不是文件系统隔离；不要据此认为任意脚本都无法间接读取文件或删除数据。敏感文件应放在执行环境可访问范围之外，或由沙箱限制。</div>
</div>

<span>Level 2 · 进阶：allow / ask 组合</span>
<div>
<div>.claude/settings.json</div>
<pre><code>{
  "permissions": {
    "allow": ["Bash(npm run lint)", "Bash(git status)", "Edit(src/**)"],
    "deny": ["Bash(rm -rf:*)", "Read(**/.env)"],
    "ask": ["Bash(git push:*)"],
    "defaultMode": "default",
    "additionalDirectories": []
  }
}</code></pre>

</div>
<table>
<tr><th>defaultMode</th><th>行为</th></tr>
<tr><td><code>default</code></td><td>按工具的默认行为决定；很多读取不询问，修改或执行命令可能询问</td></tr>
<tr><td><code>acceptEdits</code></td><td>自动批准工作目录等授权范围内的常见文件编辑和部分文件命令；越界、受保护路径和多数其他命令仍需批准</td></tr>
<tr><td><code>dontAsk</code></td><td>不弹权限确认：原本需要询问的调用默认拒绝；本来就不需批准或已批准的调用仍可运行</td></tr>
</table>
<p>判定顺序固定为 <b>deny → ask → allow → defaultMode 兜底</b>，先匹配先生效，deny 永远优先。</p>

<span>Level 3 · 高阶：常用配置来源与冲突场景</span>
<div>
<h3>Hooks 和 Permissions 的常用配置来源（非完整优先级表）</h3>
<table>
<tr><th>层级</th><th>路径</th><th>进 Git？</th><th>共享维度</th></tr>
<tr><td>项目共享</td><td><span>.claude/settings.json</span></td><td>✅ 是</td><td>团队共享，所有人吃到同一套 hook/权限</td></tr>
<tr><td>项目个人覆盖</td><td><span>.claude/settings.local.json</span></td><td>❌ 确认仓库已忽略</td><td>仅自己，限当前项目</td></tr>
<tr><td>用户全局</td><td><span>~/.claude/settings.json</span></td><td>❌ 不在项目仓库内</td><td>仅自己，跨所有项目</td></tr>
<tr><td>组织管控</td><td>managed-settings.json（企业 MDM / 注册表下发）</td><td>❌ 非 git，管理员统一推送</td><td>全组织强制，本地/项目配置都无法覆盖其 deny 规则</td></tr>
</table>
<div>
<b>一个具体冲突场景：</b>项目 <code>settings.json</code> 里 <code>allow</code> 了 <code>Bash(git push:*)</code>，但组织级 <code>managed-settings.json</code> 里 <code>deny</code> 了同一模式——最终结果是<b>被拒绝</b>，因为 deny 优先级永远最高，任何下游层级都无法用 allow 覆盖上游的 deny。
</div>
</div>
<div>这一层建议在项目刚起步、还没有任何 skill/agent 之前就先定下来——原图把"规则"排在 agents/skills 之后才出现，顺序其实反了：安全底线应该最先划。</div>

## MCP Servers


<span>Claude Code 原生识别</span>

<div><span>结论先行</span>用来对接外部系统；本身是能力扩展，真正的安全边界要靠 subagent 的 <code>tools</code>/<code>mcpServers</code> 字段配合收紧。</div>

<span>Level 1 · 基础（虚构地址和工具名，须按实际服务替换）</span>
<div>
<div>.mcp.json（项目根目录）</div>
<pre><code>{
  "mcpServers": {
    "exampleTracker": { "type": "http", "url": "https://mcp.example.com/api" }
  }
}</code></pre>

</div>
<table>
<tr><th>位置</th><th>进 Git？</th><th>共享维度</th></tr>
<tr><td><span>.mcp.json</span>（项目根目录）</td><td>✅ 建议提交</td><td>团队共享，人人连的是同一批 MCP server 定义</td></tr>
<tr><td><span>~/.claude.json</span> 里按项目路径配置的 <code>mcpServers</code></td><td>❌ 不在项目仓库内</td><td>仅自己这台机器，不要写入明文凭证</td></tr>
</table>

<span>Level 2 · 进阶：给 subagent 收紧 MCP 工具面</span>
<div>
<div>.claude/agents/ticket-checker.md</div>
<pre><code>---
name: ticket-checker
description: 只读检查 示例系统任务状态，不做任何修改
mcpServers: ["exampleTracker"]
tools: Read, mcp__exampleTracker__list_issues
---
只读查询示例系统任务状态，禁止创建/修改/删除任何工单。</code></pre>

<div>效果：即使主会话连了能创建/关闭工单的完整示例 MCP，这个 subagent 也只能看到 <code>list_issues</code> 这一个工具——避免"查工单用的 subagent"手滑改了生产数据。</div>
</div>

## Plugins &amp; Marketplace


<span>Claude Code 原生识别</span>

<div><span>结论先行</span>把前三层（Context/Capability/Enforcement）打包成一个可安装单元，团队规模化复用的最后一步，不是第一步。</div>

<span>Level 1 · 基础：添加 marketplace 并安装插件</span>
<div>
<div>Claude Code 会话（虚构名称，须替换为已审阅的来源）</div>
<pre><code>&gt; /plugin marketplace add example-org/example-marketplace
&gt; /plugin install example-plugin@example-marketplace</code></pre>

<div>团队里其他人只要执行同样两条命令，就能拿到和你完全一致的 skills/agents/hooks 配置——这就是 Distribution 层要解决的问题。</div>
</div>

<span>Level 2 · 存储与共享</span>
<table>
<tr><th>部分</th><th>存储位置</th><th>进 Git？</th><th>共享维度</th></tr>
<tr><td>插件定义本身（plugin.json、skills/、agents/…）</td><td>marketplace 仓库（如 <code>example-marketplace</code>）</td><td>✅ 是——这就是它的分发机制</td><td>团队 / 全组织共享，改动通过 PR 走版本控制</td></tr>
<tr><td>本机的安装状态（装了哪些插件、版本号）</td><td><span>~/.claude/plugins/</span></td><td>❌ 不进 git，也不该手动删</td><td>仅自己这台机器</td></tr>
</table>

<span>Level 3 · 高阶：安全边界</span>
<div>出于安全考虑，<b>插件里的 subagent 不支持 <code>hooks</code> / <code>mcpServers</code> / <code>permissionMode</code> 这几个 frontmatter 字段</b>——别人发布到 marketplace 的插件，不能通过它自带的 subagent 偷偷给你的项目挂一个 hook 或悄悄接一个 MCP server。排查 org-wide 分享问题时，这条安全限制是一个值得先排除的可能原因。</div>

## 端到端 Demo：把测试失败反馈接回 Agent



<div><span>结论先行</span>单独一个 Skill、一篇 CLAUDE.md 规则，都只是"建议"；只有把 Context、Capability、Enforcement 三层组合起来，才是原图想描述、但没有实现出来的那个"真 harness"。下面用五个文件完整拼出这个闭环。</div>

<p>示例要求项目已有 pnpm 测试和 lint 命令、Bash 与 jq。Stop 钩子用于反馈首次测试失败，重入时不再重复阻塞；合并仍由独立 CI 门禁决定。</p><h3>目录结构</h3>
<pre><code>my-project/
├── CLAUDE.md                              ← ① Context：声明规则
├── .claude/
│   ├── skills/
│   │   └── run-full-check/SKILL.md        ← ② Capability：把"跑测试+lint"沉淀成技能
│   ├── agents/
│   │   └── code-gen.md                    ← ② Capability：负责写代码的角色，带 project memory
│   ├── hooks/
│   │   └── check-tests-passed.sh          ← ③ Enforcement：物理拦截
│   └── settings.json                      ← ③ Enforcement：接线 + 权限护栏</code></pre>

<h4>① Context：CLAUDE.md 声明规则</h4>
<div>
<div>CLAUDE.md</div>
<pre><code># 项目规则
## 硬性约定
- 任何代码改动，必须在收尾前跑通 `pnpm test` 和 `pnpm lint`
- 相关技能：run-full-check</code></pre>

</div>

<h4>② Capability：把检查动作沉淀成 Skill，把写代码的角色配上 memory</h4>
<div>
<div>.claude/skills/run-full-check/SKILL.md</div>
<pre><code>---
name: run-full-check
description: 改完代码后运行完整校验（测试+lint）。收尾前使用。
---
1. 运行 `pnpm lint --fix`
2. 运行 `pnpm test`
3. 两者都通过才可以汇报"完成"</code></pre>

</div>
<div>
<div>.claude/agents/code-gen.md</div>
<pre><code>---
name: code-gen
description: 负责具体功能实现
tools: Read, Write, Edit, Bash
memory: project
skills: [run-full-check]
---
实现功能前先看 memory 里记录的历史坑；实现完按预载的 run-full-check 步骤自查。</code></pre>

</div>

<h4>③ Enforcement：把首次测试失败反馈给模型</h4>
<div>
<div>.claude/hooks/check-tests-passed.sh</div>
<pre><code>#!/usr/bin/env bash
set -euo pipefail
input=$(cat)
active=$(jq -r '.stop_hook_active // false' &lt;&lt;&lt; "$input")
if [[ "$active" == true ]]; then
  exit 0  # 避免重复阻塞；CI 仍应独立判定
fi
cwd=$(jq -r '.cwd // empty' &lt;&lt;&lt; "$input")
cd -- "${cwd:-$PWD}"
if ! pnpm run test &gt;&amp;2; then
  echo '{"decision":"block","reason":"测试命令失败。请在同一工作目录手动运行 pnpm run test，查看失败并修复；未验证前不要报告完成。"}'
  exit 0
fi
exit 0</code></pre>

</div>
<div>
<div>.claude/settings.json</div>
<pre><code>{
  "permissions": {
    "deny": ["Bash(rm -rf:*)", "Read(**/.env)"]
  },
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "bash \"${CLAUDE_PROJECT_DIR}/.claude/hooks/check-tests-passed.sh\"" }] }]
  }
}</code></pre>

</div>

<div>
<h3>运行效果对比</h3>
<div>
<div><div>只有原图那种"假 harness"</div>Claude 写完代码，CLAUDE.md 里写了"必须测试通过"，但 Claude 因为上下文压力或误判提前汇报"完成"——测试其实是红的，你隔天才发现。</div>
<div><div>加上 Enforcement 层的"真 harness"</div>正常回合准备结束时，Stop hook 运行 <code>pnpm run test</code>；首次失败会通过 <code>reason</code> 要求模型重新查看和修复；不要把之后的文字汇报当作测试凭据，合并仍以独立 CI 结果为准。</div>
</div>
<p>这五个文件分别对应总论里的三个论点：CLAUDE.md 是①、skill 和 agent 是②、hook 和 settings.json 是③——原图只画出了①和②，这也是为什么原图搭出来的东西"看着像 harness，用起来不卡人"。</p>
</div>

## 搭建顺序（修正版 8 步）


<p>相比原图"目标 → 重复任务 → agents → skills → workflow → 规则 → workspace → 生成"，调整了两处关键顺序：<b>安全护栏提前</b>，以及<b>补上原图完全没有的 Hooks 一步</b>。</p>
<ol>
<li><b>定目标 + 识别真正重复发生的任务</b><span>和原图一致，这一步没错——没有真实重复出现的任务，做 skill/agent 就是过度工程。</span></li>
<li><b>写一份 &lt;200 行的最小 CLAUDE.md</b><span>只写"每次会话都用得到"的事实；多步骤流程或只在部分场景生效的内容挪到 skill 或路径限定规则。</span></li>
<li><b>先划安全底线：settings.json 的 deny 清单</b><span>在建任何 agent/skill 之前，写明工具层要拦的动作；系统级边界另用沙箱和执行端授权。</span></li>
<li><b>把重复任务沉淀成 Skills</b><span>一个 skill 一个目录 + SKILL.md，description 写清楚触发时机。</span></li>
<li><b>确有必要隔离上下文/分角色时，才建 Subagents</b><span>多数场景 Skill 已经够用；只有需要独立 context window 或明确权限隔离时才升级。</span></li>
<li><b>需要固定触发入口的流程，做成 Slash Command / 编排型 Skill</b><span>取代"写一篇 workflow.md 指望 Claude 主动去读"的做法。</span></li>
<li><b>加 Hooks，把"应该做"变成"必须做"</b><span>原图完全没有这一步，却是 harness 和普通 prompt 工程的分水岭。</span></li>
<li><b>需要团队复用时，打包成 Plugin 发布到 Marketplace</b><span>最后一步，先把单个项目里的 harness 跑顺，再规模化分发。</span></li>
</ol>

## 勘误：原图 vs 准确版


<div>
<div><div>原图</div><code>harness/workflow.md</code>、<code>orchestrator.md</code> 作为独立目录</div>
<div><div>准确版</div>这不是 Claude Code 识别的路径。要么用 <code>@path</code> 显式接入 CLAUDE.md，要么做成 Slash Command / Skill 才有真实触发入口</div>
</div>
<div>
<div><div>原图</div><code>skills/</code> 下平铺 <code>.md</code> 文件</div>
<div><div>准确版</div>一个 skill 一个目录，目录内必须有 <code>SKILL.md</code>；可选 <code>scripts/</code> <code>references/</code> <code>assets/</code></div>
</div>
<div>
<div><div>原图</div>把"规则"排在 agents/skills 之后</div>
<div><div>准确版</div>安全护栏（<code>settings.json</code> 的 deny 清单）应该在建任何 agent/skill 之前先定</div>
</div>
<div>
<div><div>原图</div>"harness = 文档" 的隐含定义</div>
<div><div>准确版</div>Hooks + Permissions 才是让规则从"建议"变成"强制"的机制；是否构成安全边界，还要看权限配置与执行环境</div>
</div>
<div>
<div><div>原图</div>把 <code>_workspace/</code> 列为 5 个"核心组件"之一</div>
<div><div>准确版</div>这只是人为约定的产物存放目录，Claude Code 不会特殊识别，不该和 CLAUDE.md/Skills/Hooks 这些原生机制并列</div>
</div>

## 官方配置参考

- [项目规则与自动记忆](https://code.claude.com/docs/en/memory) · [Skills](https://code.claude.com/docs/en/skills) · [Subagents](https://code.claude.com/docs/en/sub-agents)
- [Hooks](https://code.claude.com/docs/en/hooks) · [权限](https://code.claude.com/docs/en/permissions) · [MCP](https://code.claude.com/docs/en/mcp) · [插件](https://code.claude.com/docs/en/plugins)
