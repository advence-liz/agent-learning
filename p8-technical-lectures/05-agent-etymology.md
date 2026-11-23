# Agent 的前世今生：自己行动，还是替人行动？

**「自己行动」说的是自主性，「替人行动」说的是委托关系。同一个 Agent 可以两者兼具，却不会因此获得无限的执行权。**

- [**一词两义**](#_1)：词源图把行动者与受托者分成两条线。
- [**职责不同，边界也不同**](#_3)：执行者有判断空间，委托方仍要设范围并验结果。
- [**LLM 让两种含义在更多任务上交汇**](#llm)：原型可以边查边决定下一步，权限仍由外部系统管。

<header>

<p>n. &nbsp;/ˈeɪdʒənt/ &nbsp;· 一个词，两个观察角度</p>
<div>
<b>*h₂eǵ-</b><span>→</span>拉丁 <b>agere</b>（驱动、引导、做）<span>→</span>现在分词 <b>agēns</b><span>→</span>宾格 <b>agentem</b><span>→</span>英语 <b>agent</b>
</div>
<p>
    词根说明「行动」如何进入这个词；自治和委托后来在不同领域各自发展。
</p>
</header>

<span id="root"></span>
<p>词根</p>


## agere：驱动，引导，做

<p>agent 来自拉丁语 <span>agere</span> 的现在分词 <span>agēns</span>，agere 的含义很宽——驱动、引导、执行、做。再往上可以追到原始印欧语词根 <span>*h₂eǵ-</span>，本义大约是「赶（牲畜）」，和希腊语 <span>ágein</span>、梵语 <span>ájati</span>、古诺斯语 <span>aka</span> 同源。</p>
<p>同一个词根在英语里还长出了一大家子：<code>act</code>、<code>agile</code>、<code>agenda</code>、<code>exact</code>、<code>examine</code>、<code>ambiguous</code>、<code>demagogue</code>。所以当你说 agent 的时候，你说的其实是「那个在驱动的东西」。</p>

<span id="split"></span>
<p>15 世纪起 · 义项分岔</p>


## 「行动者」见证更早，「受托代表」后来成为另一个义项

<p>关键不在词根，在于它进入英语之后各个义项被首次见证的时间。按辞典的排法：</p>

<div>
<div>
<div>late 15c.</div>
<div>行动者<span>one who acts —— 做出行动的一方</span></div>
</div>
<div>
<div>1550s</div>
<div>产生某种现象的自然力量或物质<span>今天的 reagent、chemical agent、cleaning agent</span></div>
</div>
<div>
<div>1590s</div>
<div>代理人、代表<span>受托替他人行事的那个</span></div>
</div>
<div>
<div>1861</div>
<div>代人办事的机构<span>agency 的商业含义定型</span></div>
</div>
<div>
<div>1916</div>
<div>特工、间谍<span>受托、隐蔽、有自己的判断——两种含义在这里交汇</span></div>
</div>
</div>

<p>这两支关注的是不同的问题：一支问行为由谁发起，一支问行为代表谁。两种用法后来并存；一个受托者也可以有自主判断。</p>

<div><p>今天遇到「什么才算 agent」的争论，先问双方在讨论自主程度，还是委托关系。两者都可能影响定义。</p></div>

<figure style="margin-inline:0">
<svg viewBox="0 0 680 406" role="img" aria-label="agent 一词的语义谱系图：拉丁语 agere 分出主体义与代理义两条线，分别流向哲学、计算机、经济学与商业法律，在 LLM agent 的语境下再次合流" style="background:#1c1916;display:block;max-width:100%;height:auto">
<title>agent 的语义谱系</title>
<defs>
<marker id="ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
</marker>
</defs>

<g>
<rect x="250" y="30" width="180" height="56" rx="6" fill="#2A2721" stroke="#4A453C" stroke-width="0.5"></rect>
<text x="340" y="50" text-anchor="middle" dominant-baseline="central" fill="#E8E2D3" font-family="JetBrains Mono, monospace" font-size="14" font-weight="500">agere</text>
<text x="340" y="69" text-anchor="middle" dominant-baseline="central" fill="#8A8378" font-family="Noto Sans SC, sans-serif" font-size="12">拉丁语：驱动、做</text>
</g>

<line x1="320" y1="86" x2="205" y2="116" stroke="#5E594F" stroke-width="1" marker-end="url(#ar)"></line>
<line x1="360" y1="86" x2="475" y2="116" stroke="#5E594F" stroke-width="1" marker-end="url(#ar)"></line>

<g>
<rect x="90" y="120" width="220" height="56" rx="6" fill="#282344" stroke="#6A5FA8" stroke-width="0.5"></rect>
<text x="200" y="140" text-anchor="middle" dominant-baseline="central" fill="#CEC7F4" font-family="Noto Sans SC, sans-serif" font-size="14" font-weight="500">主体义</text>
<text x="200" y="159" text-anchor="middle" dominant-baseline="central" fill="#A99BE8" font-family="Noto Sans SC, sans-serif" font-size="12">会自己行动的东西</text>
</g>

<g>
<rect x="370" y="120" width="220" height="56" rx="6" fill="#17352C" stroke="#3C7F68" stroke-width="0.5"></rect>
<text x="480" y="140" text-anchor="middle" dominant-baseline="central" fill="#A6E5CE" font-family="Noto Sans SC, sans-serif" font-size="14" font-weight="500">代理义</text>
<text x="480" y="159" text-anchor="middle" dominant-baseline="central" fill="#5DCAA5" font-family="Noto Sans SC, sans-serif" font-size="12">替别人行动的人</text>
</g>

<line x1="170" y1="176" x2="120" y2="206" stroke="#5E594F" stroke-width="1" marker-end="url(#ar)"></line>
<line x1="230" y1="176" x2="255" y2="206" stroke="#5E594F" stroke-width="1" marker-end="url(#ar)"></line>
<line x1="430" y1="176" x2="415" y2="206" stroke="#5E594F" stroke-width="1" marker-end="url(#ar)"></line>
<line x1="520" y1="176" x2="555" y2="206" stroke="#5E594F" stroke-width="1" marker-end="url(#ar)"></line>

<g>
<rect x="45" y="210" width="135" height="56" rx="6" fill="#221E38" stroke="#544A85" stroke-width="0.5"></rect>
<text x="112" y="230" text-anchor="middle" dominant-baseline="central" fill="#CEC7F4" font-family="Noto Sans SC, sans-serif" font-size="14" font-weight="500">哲学</text>
<text x="112" y="249" text-anchor="middle" dominant-baseline="central" fill="#9086C4" font-family="Noto Sans SC, sans-serif" font-size="12">能动性</text>
</g>
<g>
<rect x="195" y="210" width="135" height="56" rx="6" fill="#221E38" stroke="#544A85" stroke-width="0.5"></rect>
<text x="262" y="230" text-anchor="middle" dominant-baseline="central" fill="#CEC7F4" font-family="Noto Sans SC, sans-serif" font-size="14" font-weight="500">计算机</text>
<text x="262" y="249" text-anchor="middle" dominant-baseline="central" fill="#9086C4" font-family="JetBrains Mono, monospace" font-size="11">Actor / DAI</text>
</g>
<g>
<rect x="345" y="210" width="135" height="56" rx="6" fill="#152C25" stroke="#316354" stroke-width="0.5"></rect>
<text x="412" y="230" text-anchor="middle" dominant-baseline="central" fill="#A6E5CE" font-family="Noto Sans SC, sans-serif" font-size="14" font-weight="500">经济学</text>
<text x="412" y="249" text-anchor="middle" dominant-baseline="central" fill="#4E9E80" font-family="Noto Sans SC, sans-serif" font-size="12">委托代理</text>
</g>
<g>
<rect x="495" y="210" width="135" height="56" rx="6" fill="#152C25" stroke="#316354" stroke-width="0.5"></rect>
<text x="562" y="230" text-anchor="middle" dominant-baseline="central" fill="#A6E5CE" font-family="Noto Sans SC, sans-serif" font-size="14" font-weight="500">商业法律</text>
<text x="562" y="249" text-anchor="middle" dominant-baseline="central" fill="#4E9E80" font-family="Noto Sans SC, sans-serif" font-size="12">代理人、中介</text>
</g>

<line x1="112" y1="266" x2="252" y2="306" stroke="#5E594F" stroke-width="1" marker-end="url(#ar)"></line>
<line x1="262" y1="266" x2="312" y2="306" stroke="#5E594F" stroke-width="1" marker-end="url(#ar)"></line>
<line x1="412" y1="266" x2="372" y2="306" stroke="#5E594F" stroke-width="1" marker-end="url(#ar)"></line>
<line x1="562" y1="266" x2="428" y2="306" stroke="#5E594F" stroke-width="1" marker-end="url(#ar)"></line>

<g>
<rect x="230" y="310" width="220" height="56" rx="6" fill="#3A2A18" stroke="#8A6534" stroke-width="0.5"></rect>
<text x="340" y="330" text-anchor="middle" dominant-baseline="central" fill="#F0D4A8" font-family="JetBrains Mono, monospace" font-size="14" font-weight="500">LLM agent</text>
<text x="340" y="349" text-anchor="middle" dominant-baseline="central" fill="#E0A458" font-family="Noto Sans SC, sans-serif" font-size="12">两条语义合流</text>
</g>
</svg>
<figcaption>一个词根，两条分岔，四个学科，在当代 LLM Agent 的语境下再次合流</figcaption>
</figure>

<span id="philo"></span>
<p>主体义 · 哲学</p>


## 能动性：石头滚下山不算

<p>哲学取的是主体义。行动理论（action theory）里，<span>agency</span> 要区分的是「行动」和「单纯发生的事件」：石头滚下山不是 action，人走下山才是，差别在意向性——有没有一个「为了什么而做」的结构在里面。</p>
<p>这条线关心的问题是：什么东西配称为一个行为的<strong>发起点</strong>，而不只是因果链上的一环。它后来渗进认知科学、伦理学、责任归属，也渗进了今天关于「AI 有没有 agency」的讨论——那基本上是同一个老问题换了对象。</p>
<p>中文没有现成的对应词，所以「能动性 / 施事 / 主体」这一堆译法长期并存，这本身就是个信号。</p>

<span id="econ"></span>
<p>代理义 · 经济学 · 1973</p>


## 委托代理：把「替人行动」形式化

<p>经济学取的是代理义，并且把它做成了一个可以算的模型：principal-agent problem（Ross 1973、Jensen &amp; Meckling 1976）。</p>
<p>核心结构是三件事：</p>
<ul>
<li>委托人无法完全观察代理人的行为（信息不对称）</li>
<li>代理人有自己的目标函数，未必和委托人一致（激励不相容）</li>
<li>于是必须付出监督成本、约束成本，以及无论如何都消不掉的剩余损失</li>
</ul>
<p>这条线是四条里最被低估的。它给今天的权限、审批和审计提供了一个观察角度：委托方怎样限制行动范围、看见执行结果。模型与经济学里的代理人不完全相同，不能把所有对齐与安全问题都归结为激励冲突。经济学在五十年前就告诉过我们：<strong>这个问题没有零成本解，只有成本结构不同的解。</strong></p>

<span id="cs"></span>
<p>计算机 · 1973 – 1995</p>


## 从 Actor 到 agent

<p>计算机科学同时借了两边，但起点在主体义。可以举一个计算语境的早期用例： 1973 年 Hewitt、Bishop 和 Steiger 的 Actor 模型论文——他们把 actor 描述为一个「扮演某种角色的活跃 agent」。Actor 是收消息、做计算、发消息、创建新 actor，无共享状态。这是消息传递并发传统的一个早期节点，也为比较后来 Agent 的分工与协作提供了参照。</p>
<p>80 年代经 DAI（分布式人工智能）发酵，90 年代集中爆发：</p>
<ul>
<li><strong>Maes（1994）</strong>——interface agent、软件 agent，正好赶上 Web 起飞</li>
<li><strong>Wooldridge &amp; Jennings（1995）</strong>——经典四属性：autonomy、social ability、reactivity、proactiveness</li>
<li><strong>Russell &amp; Norvig（1995）</strong>——一般 agent 定义：通过传感器感知环境、通过执行器作用于环境；能控制设备的恒温器也符合这个宽口径</li>
<li><strong>BDI 架构、KQML / FIPA 通信协议、multi-agent systems</strong>——理论开始变成工程</li>
</ul>
<p>把这四条属性对着今天的 LLM agent 读一遍会有点毛骨悚然：autonomy 是模型自己决定下一步，social ability 比较接近多 agent 协作（MCP 连接应用和工具、资料，不是多 agent 通信协议），reactivity 是对工具返回值的响应，proactivity 是自己拆解并执行计划。<strong>这些维度仍可用来比较系统，但不表示新旧架构相同。</strong></p>

<span id="warning"></span>
<p>1995 · 一次没被听进去的警告</p>


## 「它可能会变成一个噪音词」

<p>Wooldridge 和 Jennings 在 1995 年那篇综述里就写过：如果不把定义问题讲清楚，agent 有可能沦为一个噪音词，被滥用和误用，最后让整个研究社区陷入混乱。</p>
<p>两年后，Franklin 和 Graesser 写了《Is It an Agent, or Just a Program?》，专门做了一个自治 agent 的分类法——之所以要写，正是因为这个词在 90 年代中期就已经泛滥到没有共识了。</p>
<p>三十年过去，同一件事在更大的规模上重演了一遍。已有的那些定义其实并不互相矛盾，它们只是站在不同的抽象层：一般 agent 定义可包含恒温器；当代「agentic AI」的产品语境则常指能调用工具、迭代处理任务的生成式系统。</p>
<p>Andrew Ng 在 2024 年提出的解法很务实：别争「是不是 agent」，改问「有多 agentic」——把一个二分谓词换成连续谱。这是一次体面的语用投降，也确实让讨论能继续下去了。</p>

<span id="llm"></span>
<p>2023 · 合流</p>


## LLM 让两个义项在更多任务中合流

<p>2022 年之后，ReAct、AutoGPT、Generative Agents（Park 等，2023）、Voyager 等研究和原型，让自然语言参与规划、工具调用与行动反馈。它们覆盖的能力各不相同。</p>
<p><strong>主体义和代理义并非第一次同时成立。</strong>前面提到的 Maes（1994）已经讨论主动为用户提供帮助的软件代理。LLM 让这种组合能用自然语言扩展到更多任务：系统在委托范围内自行选下一步，但执行权仍由外部系统约束。</p>
<p>词兜了两千年的圈子，在新的技术条件下，再次把「自己行动」和「替人办事」放到了一起。</p>

<span id="harness"></span>
<p>2025 – 2026 · 重心转移</p>


## Harness：讨论的重心从模型滑向笼子


如果说模型决定「下一步做什么」，Harness 就是让它在委托范围内做事的运行程序。上下文怎么准备、工具由谁执行、什么时候停止，统一在[《Agent 运行线路图》](01-agent-runtime-map.md#runtime-layers)展开。本篇接着问另一个问题：把任务委托出去以后，谁来限制执行范围？

<div><p>「agent」这个词的重心，正在从「模型有多聪明」滑向「你给它套了什么笼子」。</p></div>
<p>而笼子的设计问题，恰恰就是经济学那条线上的委托代理问题：在信息不对称、你无法逐步监督的前提下，怎么让受托方仍然做你想要的事。审批门是监督成本，权限最小化是约束成本，而无论如何都会漏掉的那部分，经济学管它叫剩余损失。</p>
<p>换句话说，两条分岔在当代 LLM 系统中再次合流之后，真正难的部分立刻回到了更古老的那一条上。</p>

<span id="chinese"></span>
<p>译名</p>


## 中文被迫选边，于是译名泄露了立场

<p>英语里两个义项挤在一个词里相安无事，中文没有这个奢侈，必须在翻译时选一边：</p>
<div>
<div><div>智能体</div><div>偏主体义<span>强调它是一个会自己行动的东西</span></div></div>
<div><div>代理</div><div>偏代理义<span>强调它是替人办事的</span></div></div>
<div><div>智能代理</div><div>两头都想占<span>90 年代软件 agent 时期的常见译法</span></div></div>
<div><div>能动者 / 施事</div><div>哲学语境<span>agency 译作能动性</span></div></div>
</div>
<p>所以读中文材料时有个小技巧：<strong>看作者用哪个译名，基本就能判断他站在哪条谱系上</strong>，以及他接下来要谈的是能力问题还是信任问题。</p>

<span id="refs"></span>
<p>来源</p>


## 参考文献

<ul>
<li><span>1973</span><span>Ross, S. — The Economic Theory of Agency<span>委托代理问题的早期形式化</span></span></li>
<li><span>1973</span><span>Hewitt, Bishop &amp; Steiger — A Universal Modular ACTOR Formalism for AI（IJCAI）<span>计算语境中的一个早期 agent 用例</span></span></li>
<li><span>1976</span><span>Jensen &amp; Meckling — Theory of the Firm<span>代理成本三分：监督、约束、剩余损失</span></span></li>
<li><span>1994</span><span>Maes, P. — Agents that Reduce Work and Information Overload<span>interface agent</span></span></li>
<li><span>1995</span><span>Wooldridge &amp; Jennings — Intelligent Agents: Theory and Practice<span>四属性定义，以及「噪音词」警告</span></span></li>
<li><span>1995</span><span>Russell &amp; Norvig — Artificial Intelligence: A Modern Approach<span>rational agent</span></span></li>
<li><span>1997</span><span>Franklin &amp; Graesser — Is It an Agent, or Just a Program?<span>自治 agent 分类法</span></span></li>
<li><span>2023</span><span>Park et al. — Generative Agents: Interactive Simulacra of Human Behavior<span>LLM agent 的标志性工作之一</span></span></li>
<li><span>—</span><span>Etymonline / Merriam-Webster / Wiktionary<span>词源与义项见证年代</span></span></li>
</ul>
<div>
    整理于 2026-08<br>
    义项年代以 Etymonline 所载首次见证为准，学界对个别年代有争议
</div>
