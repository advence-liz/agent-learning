# 大模型的能力边界：论文、评测与现实各能说明什么？

<span id="top"></span>

**模型能做、系统做得稳、业务值得用，是三个不同的判断。** 定理划的是特定假设下的边界；评测提供观察，不是生产承诺。要决定能不能委托，还得看真实验收和错误代价。

- [**定理论证有适用范围**](#c2)：固定深度、有限精度下的结果，不能直接套到带工具的多轮系统。
- [**四层证据不能互相换算**](#c7)：基准、交付物、对照试验和就业数据，问的是不同问题。
- [**验收有用，但也有边界**](#c8)：能验证的任务更适合先试；超出已测分布时，应保留复核或人工接手。

```d2
direction: down
question: 这项任务能交给 AI 吗？
theory: "理论\n哪些条件下受限？"
evidence: "评测与观察\n哪些任务实际测过？"
practice: "本地验收\n质量与错误代价可接受吗？"
question -> theory: 看推导前提
question -> evidence: 看指标和分母
question -> practice: 看试点与风险
```

**读图：** 三条线是三类检查，不是从某个跑分直接推出「可以上线」。

> 本文以 2026 年 8 月版为底稿，11 月核对了理论前提、评测读法与就业证据。正文的数据按各自日期和样本解读；同期案例另见[《AI 行业进展与代表应用》](10-ai-industry-watch.md)。

<details>
<summary>展开十章论证路线</summary>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>全文推理链 · 十章如何递进</div>
<ol>
<li><b>第一章</b>确立起点：经验规律和机制解释是两回事。<span>← 既然"为什么行"说不清，就只能退而求其次问"哪里不行"——</span></li>
<li><b>第二、三、四章</b>依次立起三堵墙：<b>算不动</b>（计算结构限制）、<b>不知道</b>（信息限制：统计下限 + 考核放大两个机制）、<b>学不会</b>（训练限制）。三堵墙性质不同、绕法不同。<span>← 但这三堵墙有个共同盲区——</span></li>
<li><b>第五章</b>指出盲区：不能把针对特定模型的结果直接外推到带工具的系统。<span>← 不能外推的地方，需要系统级证据——</span></li>
<li><b>第六章</b>确认现实的认识论方向是反的：能力先出现，解释后补上。</li>
<li><b>第七章</b>对照四层证据，区分模型能力、交付质量、流程收益和就业观测。<span>← 它们不能换算成彼此——</span></li>
<li><b>第八章</b>给出机制：验证替代理解。用它解释为什么一些可验收任务适合先委托，以及为什么基准成绩不能直接换算成净收益。<span>← 但这个机制有个结构性代价——</span></li>
<li><b>第九章</b>刻画代价：测试结论有适用范围，未覆盖的场景仍需要监测和接管。</li>
<li><b>第十章</b>把以上全部收拢成可以直接用的判据和建议。</li>
</ol>
</div>

</details>

## <span>上篇 · 第一章</span>经验规律能预测表现，不能代替机制解释 { #c1 }

<p>经验规律和机制研究可以互相补充，但下文列举的现象还不能用一个通用机制解释。接下来三章换一个问题：在什么假设下，哪些限制可以被证明或观察到？</p>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>本卡片解释 → <b>第一章总论点</b>：四大能力来源全是"先观测、后解释"，且至今没有公认解释</div>
<h5>我们知道加大投入会变强，但不知道为什么，也不知道会强在哪</h5>
<p>大模型有四件让人惊讶的事：投入越多越强（规模律）；给几个例子就会做新任务（上下文学习）；某些能力到一定规模突然出现（涌现）；用人的反馈一调就变听话（RLHF）。</p>
<p><b>这四件事全都是先被观察到、事后才有人试图解释的，而且没有一条有公认的解释。</b>规模律是拿很多次实验结果<b>拟合</b>出来的曲线，不是从原理推导的——所以后来有人换了更好的实验方法，曲线参数就变了。</p>
<p>"没有理论支撑"最朴素的含义：我们手里是<b>经验规律</b>，不是<b>定律</b>。经验规律能告诉你"再投十倍算力，误差大概降到多少"，但没法告诉你"它会因此学会什么新本事"。</p>
</div>

#### 1.1 规模律：一条拟合出来的幂律

<p><span>Scaling law（<span><b>Scaling law（规模律）</b>：模型的预测误差随参数量、数据量、算力呈"幂律"下降的经验关系。从大量实验里拟合出来，不是从原理推出来。</span>）</span> 由 Kaplan 等（OpenAI, 2020）提出，被 Hoffmann 等的 Chinchilla（DeepMind, 2022）修正。它跨多个数量级惊人一致，是该领域最可靠的预测工具。<b>但两代结论的指数不一致</b>（<code>N∝C^0.73</code> vs <code>N∝C^0.50</code>），Pearce &amp; Song（2024）指出差异源于实验方法。<b>一个能被"更好的实验方法"改写指数的规律，是拟合而非第一性原理。</b></p>

#### 1.2 上下文学习：最好的解释也只是候选

<p><span>ICL（<span><b>In-context learning（上下文学习）</b>：不更新任何参数，仅凭 prompt 里的几个例子就学会一个新任务。训练时没人教过它这样做。</span>）</span> 最有影响力的解释是 Xie 等（Stanford, 2021）的隐式贝叶斯推断框架，但只在合成数据集上验证过，另有"梯度下降元优化""归纳头"等竞争解释。<b>至今没有公认机制。</b></p>

#### 1.3 涌现：可能是评分方式造成的假象 <span>争议中</span>

<p>Schaeffer 等（NeurIPS 2023 杰出论文《Are Emergent Abilities a Mirage?》）证明：只要把"全对才得分"的评分换成连续度量，那些看似突然的能力跳变就变成平滑可预测的曲线。该文并未否认所有涌现，学界未达成共识——<b>连"能力是否真的会突然涌现"都还在争论，遑论解释它。</b></p>

#### 1.4 RLHF：为什么有效，是空白

<p><span>RLHF（<span><b>RLHF（基于人类反馈的强化学习）</b>：用人类偏好训练一个"评分员"，再用它微调模型，使其听话、有用。</span>）</span> 工程上极其有效，理论上是空白。反而有反向发现：OpenAI（2025）指出当前评测体系<b>奖励猜测、惩罚说不知道</b>，可能加剧幻觉——这套流水线的效果连方向都未必单调。（该机制在 3.3 展开。）</p>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em"><div>承上启下</div><p>既然"为什么行"没有答案，理论能做的就只剩一件事：<b>划出"哪里一定不行"。</b>接下来三章就是三堵这样的墙，按性质分开：第二章是<b>计算结构</b>的墙（算不动），第三章是<b>信息</b>的墙（不知道），第四章是<b>训练</b>的墙（学不会）。区分它们不是学术洁癖——三堵墙的绕法完全不同。</p></div>

## <span>上篇 · 第二章</span>墙一 · 算不动：表达力被锁在 TC⁰ { #c2 }

<p>本章任务：讲清楚第一堵墙——为什么某些"必须一步等一步"的计算，裸模型结构上就做不了；这个限制从哪来（2.1–2.2）；以及由它直接推出的两个重要结论（2.3–2.4）。这是全文理论最扎实的一章。</p>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>本卡片解释 → <b>2.1 定理内容</b>："常数深度 + 层内并行 + 有限精度 ⇒ 锁进 TC⁰"这句话到底在说什么</div>
<h5>比喻：一条工序数量固定的流水线</h5>
<p>大模型像一个车间流水线，有三个死板的特点——<b>注意，这三个特点正好对应下文定理的三个成分</b>：</p>
<ul>
<li><b>工序数量写死</b>（对应成分①"常数深度"）：永远只有 96 道工序，简单活复杂活都只能过 96 道。</li>
<li><b>同一道工序的工人必须同时开工、不能互相等</b>（对应成分②"层内并行"）：张三不能等李四算完再动手。这是为了快。</li>
<li><b>每个工人只会简单算术、且算盘位数有限</b>（对应成分③"有限精度"）：加减、平均、数多数派。</li>
</ul>
<p><b>什么活干不了？天生"必须一步等一步"的活。</b>比如给一张地图问"从 A 城能不能走到 Z 城"：从 A 出发看能到哪几个城，再从那几个城往外推——第二步必须等第一步。若这条路需要推 200 步而流水线只有 96 道工序，这条逐轮搜索的算法就不能原样跑完。这里是比喻，不是对 200 步地图题的数学下界；困难是随输入变大、能否用固定深度对所有输入求解。</p>
<p>把流水线<b>加宽</b>（更大的模型、更多工人）解决不了这个问题，因为缺的不是人手，是轮次。这一点在 2.3 和 2.4 会正式展开。</p>
</div>

### 2.1 定理的三个成分——缺任何一个，结论都不成立 { #c2a }

<p>这堵墙对应的理论叫<b>电路复杂度</b>（circuit complexity），代表工作是 Merrill &amp; Sabharwal 系列（Allen AI / NYU, 2022–2024）。结论是：裸 Transformer（不写中间推理步、读完输入就作答）落在 <span>TC⁰（<span><b>TC⁰</b>（读作 TC zero / TC 零）：常数深度、多项式规模、含阈值门的电路能解决的问题类。直观理解为"层数固定、极度可并行的浅层计算"。T = Threshold（阈值），上标 0 = 常数深度。</span>）</span> 这个复杂度类之内。证明需要<b>同时</b>满足三条：</p>

<table>
<tr><th>成分</th><th>Transformer 的事实</th><th>在证明中的作用</th><th>流水线比喻</th></tr>
<tr><td><b>① 常数深度</b></td><td>层数固定（如 96 层），不随输入长度增长</td><td>直接对应"常数深度电路"</td><td>工序数写死</td></tr>
<tr><td><b>② 层内并行</b></td><td>注意力本质是<b>加权平均</b>——对所有位置一次性并行聚合，不是逐位置串行扫描；加权平均恰好是 TC⁰ 内的运算</td><td>保证每一层可被一层阈值电路模拟</td><td>工人同时开工、不能互相等</td></tr>
<tr><td><b>③ 有限精度</b></td><td>每个数只有 O(log n) 位（现实下限：光给 n 个位置编号就要 log n 位）</td><td><b>最容易被忽略但是硬前提</b>：若允许无限精度，一次乘法就能编码任意长的计算，整个上界立刻崩掉</td><td>算盘位数有限</td></tr>
</table>

<p>三条合起来：每一层都能被常数深度阈值电路模拟，常数个 TC⁰ 电路串起来还是 TC⁰。<b>这是证明的骨架</b>——严格证明的主要技术工作量在于验证"有限精度的加权求和、softmax 等运算确实能用常数深度阈值电路实现"，这正是 Merrill &amp; Sabharwal 系列论文的核心内容。</p>
<p><b>条件性推论——部分问题未必能由这类模型普遍求解：</b>例如模拟有限自动机（<span>NC¹（<span><b>NC¹</b>（NC one）：对数深度电路能解决的类，被认为严格大于 TC⁰。N C 来自 Nick's Class（以学者 Nick Pippenger 命名）。</span>）</span>-完全）、判断有向图连通性、解线性方程组、置换合成、求值任意布尔公式。<b>严格结论取决于具体问题的复杂度、归约以及未证明的复杂度类分离；不能仅从「有一种算法需要串行」推出任何算法都需要串行。参见 <a href="https://arxiv.org/abs/2207.00729">Merrill 与 Sabharwal 的 log-precision Transformer 论文</a>。</b></p>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>前提声明 <span>条件性</span></div>
<p>所有"做不到"都依赖尚未证明的数学猜想（<code>TC⁰ ≠ NC¹</code> 等）。这些猜想被复杂度理论界广泛相信（可信度接近 P≠NP），但从未被证明。<b>这是全文理论最坚硬的部分，但依然是"有条件的坚硬"。</b></p>
</div>

### 2.2 上限从哪来：它是"可训练性"的账单 { #c2b }

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>本卡片解释 → <b>2.2 论点</b>：成分①②不是设计失误，而是一笔明码标价的交换——拿表达力换训练速度</div>
<h5>为什么要把流水线设计成"不能互相等"？因为要快</h5>
<p>回头看三个成分，②（并行）是因，①（浅）是果：</p>
<ul>
<li>训练这么大的模型，唯一可行的办法是让所有位置<b>同时算</b>。一旦要求"同时算、互不等待"，层内就做不了串行推理（成分②成立）。</li>
<li>又因为每层都是全量计算，深度每加一层、训练成本就涨一截——所以层数不敢堆太多，保持常数（成分①成立）。</li>
</ul>
<p><b>所以 TC⁰ 上限不是缺陷，是账单：拿表达力，换来了"训得动"。</b>这笔账的两个直接后果，就是接下来的推论 A 和推论 B。</p>
</div>

### 2.3 推论 A：换架构没用——限制不属于 Transformer { #c2c }

<p>既然上限来自"为了可训练而并行"，那么<b>任何</b>做了同样交换的架构都要付同一份账单。这个推论被正面验证了：</p>
<p>Mamba/S4 这类<span>状态空间模型（<span><b>SSM（State-Space Model）</b>：类 RNN 的序列模型，宣传点是"有状态、能顺着往下推"，看起来正好补上 Transformer 的短板。但为了训得动，它把递归改写成了可并行的扫描形式。</span>）</span>号称"有状态、能顺着推"。Merrill、Petty、Sabharwal（《The Illusion of State in State-Space Models》, ICML 2024）证明：<b>它们同样落在 TC⁰ 内</b>，同样做不了置换合成，无法可靠追踪棋局、求值代码、在长篇叙事里追踪实体——因为它们为了可训练，把递归改写成了可并行的扫描形式，正好触发了同一笔账。</p>
<p>老式 RNN 真的一步等一步，确实不受此限——代价是无法在今天的规模上训练。<b>这不是哪家公司技术不行，是跑不掉的权衡。</b></p>

### 2.4 推论 B：写草稿有用——到时间维度上买深度 { #c2d }

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>本卡片解释 → <b>2.4 论点</b>：思维链（CoT）为什么真的提升计算能力，以及为什么行业从"堆参数"转向"堆思考时间"</div>
<h5>层数维度的深度买不起了，就到时间维度上买</h5>
<p>加深流水线要重新建厂（重训模型、训练成本暴涨）。但有个便宜的办法：<b>把出口的半成品接回入口，再过一遍。</b></p>
<p>这就是模型写"思考过程"在计算上的本质：每写一段草稿再读回去，就等于多过了一遍这 96 道工序。<b>草稿越长，等效工序越多，能干的活越难。</b></p>
<p>这也解释了两个行业现象：① 推理模型的成本花在<b>推理阶段</b>而不是训练阶段——同一笔"深度账单"换了个地方付；② 2024 年前后行业集体从"堆参数"（加宽，不改上限）转向"堆思考时间"（加串行轮次，真正抬上限）。</p>
</div>

<p>形式结果（Merrill &amp; Sabharwal, ICLR 2024）是一道阶梯：</p>

<figure style="margin-inline:0">
<div>图 1 — 草稿长度 → 可达计算能力（推论 B 的正式版本）</div>
<svg viewBox="0 0 800 270" role="img" aria-label="思维链步数与复杂度阶梯" style="background:#171c25;display:block;max-width:100%;height:auto">
<line x1="60" y1="228" x2="760" y2="228" stroke="#222B37" stroke-width="1"></line>
<text x="60" y="252" fill="#a8b3c1" font-size="10.5" font-family="system-ui, sans-serif">允许写的草稿长度 →</text>
<text x="60" y="30" fill="#a8b3c1" font-size="10.5" font-family="system-ui, sans-serif">↑ 能处理的问题难度</text>
<rect x="70" y="180" width="140" height="42" rx="2" fill="#1A212C" stroke="#3A4553"></rect>
<text x="140" y="199" text-anchor="middle" fill="#ffffff" font-size="13" font-family="system-ui, sans-serif" font-weight="600">不写草稿</text>
<text x="140" y="215" text-anchor="middle" fill="#a8b3c1" font-size="10.5" font-family="system-ui, sans-serif">锁在 TC⁰</text>
<rect x="232" y="138" width="140" height="42" rx="2" fill="#1A212C" stroke="#3A4553"></rect>
<text x="302" y="157" text-anchor="middle" fill="#ffffff" font-size="13" font-family="system-ui, sans-serif" font-weight="600">写 log n 步</text>
<text x="302" y="173" text-anchor="middle" fill="#a8b3c1" font-size="10.5" font-family="system-ui, sans-serif">几乎没提升</text>
<rect x="394" y="94" width="150" height="42" rx="2" fill="#141F1D" stroke="#57A08F"></rect>
<text x="469" y="113" text-anchor="middle" fill="#ffffff" font-size="13" font-family="system-ui, sans-serif" font-weight="600">写 n 步（线性）</text>
<text x="469" y="129" text-anchor="middle" fill="#57A08F" font-size="10.5" font-family="system-ui, sans-serif">质变点</text>
<rect x="566" y="48" width="160" height="42" rx="2" fill="#231F14" stroke="#D8B740"></rect>
<text x="646" y="67" text-anchor="middle" fill="#ffffff" font-size="13" font-family="system-ui, sans-serif" font-weight="600">写多项式步</text>
<text x="646" y="83" text-anchor="middle" fill="#D8B740" font-size="10.5" font-family="system-ui, sans-serif">上限 = P，到顶了</text>
<polyline points="140,178 140,162 302,162 302,118 469,118 469,72 646,72" fill="none" stroke="#D8B740" stroke-width="1.5" stroke-dasharray="3 3" opacity=".6"></polyline>
</svg>
<figcaption>注意两点：① 阶梯顶端是 <b>P</b>（多项式时间可解），不是"一切"——P 之外还有大量问题永远在外面；② 草稿不是免费的：Li 等（2024）证明 log n 步完全不增加表达力，Bavandpour 等（2025）证明奇偶校验、乘法、求中位数都需要与输入等长的草稿。</figcaption>
</figure>

### 2.5 澄清：图灵完备为什么不算数 { #c2e }

<p>常被引用的"Transformer 图灵完备"（Pérez 等, 2019/2021）依赖的前提是<b>无限精度实数运算</b>——它恰好把 2.1 表格里的<b>成分③</b>抽掉了。真实硬件是有限精度浮点数，前提不成立，所以该结果描述的是一台物理上不存在的机器。<b>凡是用"图灵完备"论证大模型能力无上限的说法，都可据此排除。</b></p>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em"><div>承上启下</div><p>墙一说的是"<b>算不动</b>"——即使信息都在手上，某些计算轮次不够就是做不完。下一堵墙性质完全不同：<b>信息根本不在手上</b>。区分两者很重要，因为墙一可以靠加草稿绕过，墙二加多少算力都没用。</p></div>

## <span>上篇 · 第三章</span>墙二 · 不知道：幻觉在数学上躲不掉 { #c3 }

<p>本章任务：立起第二堵墙——"一本正经地胡说"不是能修好的 bug，它有数学下界；并指出它唯一的绕道。</p>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>本卡片解释 → <b>3.1 统计下界</b>（Kalai &amp; Vempala 的"校准即注定"）：为什么幻觉率有个跟努力无关的下限</div>
<h5>比喻：一个见闻有限但诚实的传记作家</h5>
<p>他读过大量人物资料，现在的任务是写出<b>世上所有人</b>的生日。注意：他不是在"查资料复述"，而是在<b>下笔生成</b>——这个区别是本比喻成立的关键。</p>
<ul>
<li>有些人的生日他在资料里见过很多遍，写起来很稳。</li>
<li>但资料里有 <b>20% 的生日只出现过一次</b>。按统计学的经典结论（Good-Turing 估计），这恰好提示他：世上还有大约同样多的人，其生日<b>根本不在他的资料里</b>。</li>
</ul>
<p><b>诚实（也就是"校准"）反而害了他</b>：诚实要求他承认那些没见过的人存在、并照样给出日期——而他能做的只有按"生日长什么样"的规律，编一个像样的日期。这些日期几乎全是错的。</p>
<p><b>所以他的错误率下限 ≈ "只见过一次"的资料占比。</b>跟他聪不聪明、多读几遍都无关——信息本身不在那儿。</p>
<p><b>这个定理最反直觉的地方：</b>幻觉不是模型"没学好"的产物，恰恰是它"学得诚实"（校准良好）的必然产物。一个从不幻觉的模型，反而一定是不校准的——它对没见过的世界过度自信地闭嘴了。唯一的逃法是允许拒答，但见下一张卡片：我们的考核方式恰恰在惩罚拒答。</p>
</div>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>本卡片解释 → <b>3.3 放大机制</b>（OpenAI 2025 论文的另一半，呼应第一章 1.4）：为什么事后训练和评测会让幻觉更严重</div>
<h5>比喻：只按答对给分的考试</h5>
<p>学生遇到不会的题：留白必然零分，蒙一个还有期望分。<b>评分方式在奖励猜测</b>，于是理性策略就是永远作答、绝不留白。</p>
<p>当前主流评测和事后训练正是这样一场考试——它们把 3.1 里那个"允许拒答"的唯一逃生口也堵上了。注意这张卡片和上一张说的是<b>两个不同机制</b>：3.1 是统计下限（数据决定），3.3 是行为放大（考核方式决定）。业内常把两者混为一谈，本文档刻意分开。</p>
</div>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>本卡片解释 → <b>3.2 归约下界</b>（OpenAI 2025 论文的前一半，"生成比判别难"）：为什么即使训练数据完美，张口说真话也必然出错</div>
<h5>比喻：认出赝品，比自己画出真迹容易</h5>
<p>"判断一句话是不是真的"和"生成一句真话"是两件难度不同的事，后者严格更难——这可以被形式化证明（生成错误率 ≥ 2 × 判别错误率 − 校准项）。</p>
<p>所以只要"分辨真假"这件事本身有难度，"张口就是真话"就必然出错。<b>这不是工程没做好，是数学。</b></p>
</div>

#### 三个层层递进的正式结果

<table>
<tr><th>结果</th><th>出处</th><th>内容</th></tr>
<tr><td><b>对角化论证</b></td><td>Xu, Jain, Kankanhalli（NUS），arXiv 2401.11817, 2024</td><td>任何可枚举的模型集合，必然对某个真值函数产生幻觉。与架构、算法、数据都无关。</td></tr>
<tr><td><b>校准即注定</b></td><td>Kalai &amp; Vempala，STOC 2024</td><td>概率<span>校准（<span><b>校准</b>：模型说 70% 把握时，约 70% 情况下真的对。</span>）</span>良好的模型，幻觉率下界 ≈ <span>missing mass（<span><b>missing mass（缺失质量）</b>：有限样本中尚未观察到的事实的总概率。</span>）</span>（满足论文假设时，可用样本单例率估计）。即"传记作家"卡片的正式版。</td></tr>
<tr><td><b>生成比判别难</b></td><td>Kalai, Nachum, Vempala, Zhang（OpenAI），2025；Nature 2026</td><td>生成错误率 ≥ 2 × 判别错误率 − 校准项，即"认赝品"卡片的正式版；同一论文的另一半指出评测体系奖励猜测、惩罚拒答，即"考试"卡片的正式版（3.3）。</td></tr>
</table>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>这堵墙的性质与唯一绕道</div>
<p><b>与墙一的本质区别：墙一是算力问题（加草稿可绕），墙二是信息问题（加多少算力都没用）。</b>唯一出路是<b>信息绕道</b>——从外部把信息拿进来。这正是检索（RAG）、工具调用存在的理由：不是优化手段，是绕过定理前提的唯一方式。</p>
<p>批评意见也应记录：有后续工作（arXiv 2502.12187）指出对角化结论在实践层面近乎空洞——数据质量够好时，幻觉率可压到统计上可忽略。</p>
</div>

## <span>上篇 · 第四章</span>墙三 · 学不会：会表示 ≠ 学得到 { #c4 }

<p>本章任务：立起第三堵墙——即使某个能力在参数空间里"存在"，训练也未必找得到它；并给出组合推理失败的三组实证。</p>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>本卡片解释 → <b>4.1 论点</b>：为什么"万能逼近定理"不能用来论证大模型什么都能做</div>
<h5>比喻："这架钢琴能弹出那首曲子"，不等于"我能学会弹它"</h5>
<p>万能逼近定理说的是：足够大的神经网络<b>存在一组参数</b>能逼近任意函数。但"存在"和"学得到"是两回事——钢琴上确实存在一组按键顺序能弹出那首曲子，这不代表你能学会。</p>
<p><b>训练能不能在合理的时间和数据里找到那组参数，是完全独立的另一个问题，而且往往才是真正的瓶颈。</b>下面三组实证测的就是这个瓶颈。</p>
</div>

#### 三组实证：组合推理的系统性失败 <span>实测</span>

<ul>
<li><b>Faith and Fate</b>（Dziri 等, NeurIPS 2023）：把组合任务建模成计算图，发现 Transformer 把多步推理<b>塌缩成"线性化子图匹配"</b>——本质是模式匹配，误差随任务深度和宽度指数累积。标志性数字：GPT-4 三位数 × 三位数乘法正确率仅约六成（论文报告约 59%，随实验设置有浮动）。<b>这解释了"能做三位数乘法却在五位数上崩"——不是没学好，是机制上的。</b></li>
<li><b>反转诅咒</b>（Berglund 等, ICLR 2024）：学过"A 是 B"的模型不会自动推出"B 是 A"，且正确答案的概率不高于随机。</li>
<li><b>GSM-Symbolic</b>（Mirzadeh 等, Apple, ICLR 2025）：要区分数字变体与加入无关条件的 NoOp。<a href="https://arxiv.org/html/2410.05229">论文表 1</a>中，GPT-4o 在数字变体设置约 94.9%，加无关句的 NoOp 约 63.1%。这说明部分模型和题型对无关条件敏感，不是说单改数字就普遍大跌。</li>
</ul>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em"><div>三堵墙小结 · 并承上启下</div>
<table>
<tr><th>墙</th><th>性质</th><th>绕法</th></tr>
<tr><td>墙一 · 算不动</td><td>计算结构限制（轮次不够）</td><td>加草稿 / 接工具</td></tr>
<tr><td>墙二 · 不知道</td><td>信息限制（数据里没有）</td><td>检索 / 外部信息，别无他法</td></tr>
<tr><td>墙三 · 学不会</td><td>训练限制（存在但找不到）</td><td>可能靠更好的数据配方、训练方法缓解</td></tr>
</table>
<p>三堵墙立完了。但请注意它们的共同点：<b>约束对象都是"单次问答的裸模型"。</b>这个共同点正是下一章要指出的巨大盲区。</p></div>

## <span>上篇 · 第五章</span>单模型的限制不能直接推出整个 Agent 的上限 { #c5 }

<p>本章任务：完成上篇——指出为什么就算三堵墙全部成立，也回答不了"AI 能不能替代一个人的工作"。这是全文承前启后的关键一章。</p>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>本卡片解释 → <b>第五章总论点</b>：理论与"agent 替代人类"之间存在三个层面的错配，所以理论既不能证明能、也不能证明不能</div>
<h5>定理有适用对象，岗位替代需要另外的证据</h5>
<p>三个错配，逐条看：</p>
<ul>
<li><b>错配一：单步 vs 连续。</b>单次问答与连续任务需要不同的成功判据。把每步简化成固定且独立的失败概率，可以说明多步错误如何累积，却不足以描述能复核、纠错和重试的流程。</li>
<li><b>错配二：题目没法出。</b>理论要证明什么，得先有精确定义的问题。"当一名合格的初级工程师"没有精确定义——没有标准输入，没有正确性判据。<b>要做形式化或实证比较，得先把岗位拆成任务、验收标准与约束。</b></li>
<li><b>错配三：管的对象不对。</b>理论管"裸模型"，实际部署的是"模型 + 工具 + 验证 + 重试"的系统。代码解释器可在运行预算内执行模型单次前向计算之外的步骤，但系统仍可能选错工具、传错参数或误读结果。用裸模型的上限去判定带工具系统的能力，是范畴错误。</li>
</ul>
<p><b>结论：这些特定结果不能单独回答 Agent 能否承担一个岗位。</b>评估完整系统，还要验证它能否在具体任务中交付、恢复和接受监督。</p>
</div>

## <span>下篇 · 第六章</span>箭头是反的：能力先出现，解释后补上 { #c6 }

<p>本章任务：确认下篇的认识论前提——大模型领域的推理方向是"现实→理论"，与常规科学相反。这决定了后面所有证据的性质：观测，而非推导。</p>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>本卡片解释 → <b>第六章总论点</b>：时间顺序证明推理箭头是反的；"逆向工程"这个词本身就是证据</div>
<h5>正常的科学先有理论再造东西。这次反过来了。</h5>
<p>造桥先算力学，造芯片先有电路理论——理论预测现实是常规顺序。大模型是倒的：<b>能力先被撞见，解释后来补上。</b>"给几个例子就会做新任务"是 GPT-3 论文里报告的<b>意外发现</b>；"写思考过程会变聪明"是工程实践先发现有效，理论解释（就是第二章那个阶梯）晚了将近两年。</p>
<p>最有说服力的证据：研究模型内部的那门学问，方法就叫<b>逆向工程</b>——而你只会对<b>不是自己设计的东西</b>做逆向工程。模型参数是算法从数据里搜出来的，从来没有设计图纸。</p>
</div>

<figure style="margin-inline:0">
<div>图 2 — 两种认识论方向（第六章总论点图示）</div>
<svg viewBox="0 0 780 200" role="img" aria-label="理论到现实与现实到理论的对比" style="background:#171c25;display:block;max-width:100%;height:auto">
<text x="20" y="24">常规科学（理想顺序）</text>
<rect x="20" y="36" width="130" height="34" rx="2" fill="#1A212C" stroke="#57A08F"></rect><text x="85" y="58" text-anchor="middle">第一性原理</text>
<path d="M158,53 L206,53" stroke="#57A08F" stroke-width="1.5" marker-end="url(#g1)"></path>
<rect x="214" y="36" width="130" height="34" rx="2" fill="#1A212C" stroke="#57A08F"></rect><text x="279" y="58" text-anchor="middle">做出预测</text>
<path d="M352,53 L400,53" stroke="#57A08F" stroke-width="1.5" marker-end="url(#g1)"></path>
<rect x="408" y="36" width="130" height="34" rx="2" fill="#1A212C" stroke="#57A08F"></rect><text x="473" y="58" text-anchor="middle">实验验证</text>
<line x1="20" y1="100" x2="760" y2="100" stroke="#222B37"></line>
<text x="20" y="130" fill="#C4553F">大模型（实际顺序）</text>
<rect x="20" y="142" width="150" height="34" rx="2" fill="#241A1A" stroke="#C4553F"></rect><text x="95" y="164" text-anchor="middle">工程上撞见能力</text>
<path d="M178,159 L226,159" stroke="#C4553F" stroke-width="1.5" marker-end="url(#g2)"></path>
<rect x="234" y="142" width="150" height="34" rx="2" fill="#241A1A" stroke="#C4553F"></rect><text x="309" y="164" text-anchor="middle">先部署，再测量</text>
<path d="M392,159 L440,159" stroke="#C4553F" stroke-width="1.5" marker-end="url(#g2)"></path>
<rect x="448" y="142" width="170" height="34" rx="2" fill="#241A1A" stroke="#C4553F"></rect><text x="533" y="164" text-anchor="middle">事后逆向工程解释</text>
<defs>
<marker id="g1" markerWidth="7" markerHeight="7" refX="5" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 Z" fill="#57A08F"></path></marker>
<marker id="g2" markerWidth="7" markerHeight="7" refX="5" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 Z" fill="#C4553F"></path></marker>
</defs>
</svg>
<figcaption>下面这条路径不是不严谨，而是换了一种可靠性来源——第八章会给出这个替代机制。</figcaption>
</figure>

#### 6.1 逆向工程做到什么程度了？很谦卑 <span>实测</span>

<ul>
<li><span>SAE / 字典学习（<span><b>稀疏自编码器</b>：试图把模型内部纠缠的信号拆成能命名的"特征"。因为概念数远多于神经元数，多个概念挤在同一批神经元里（叫"叠加"），没法直接读。</span>）</span>：DeepMind 团队 <b>2025 年 3 月宣布降低该方向优先级</b>——下游任务上打不过更简单的基线，并推测"领域在它上面投入过度"。</li>
<li><span>归因图 / 电路追踪（<span><b>attribution graph / circuit tracing</b>：为单条输入画出模型内部信息流的因果图。</span>）</span>：Anthropic（2025）坦承<b>在对 Claude 3.5 Haiku 尝试的提示中，约四分之一让作者主观认为获得满意洞见</b>。</li>
<li>《Open Problems in Mechanistic Interpretability》（18 家机构 29 位研究者）承认<b>部分查询在理论上就不可解</b>。</li>
</ul>

#### 6.2 理论猜对过的，全是"此路不通"

<ul>
<li><b>"只有加串行步数才能突破上限"</b>（第二章推论 B）早于推理模型爆发，后来兑现。<span>兑现</span></li>
<li><b>Chollet 的 ARC 预言</b>（2019）：纯扩规模解决不了全新抽象推理。该预言顶住约 5 万倍规模扩张（GPT-3 得 0%，GPT-4.5 约 10%，人类 95%+），直到测试时自适应出现；ARC-AGI-2 的 <a href="https://arcprize.org/blog/arc-prize-2025-results-analysis">2025 私有竞赛冠军</a>约 24%；ARC-AGI-3 的 <a href="https://arcprize.org/blog/arc-agi-3-launch">2026 年 3 月发布快照</a>中，所报 AI 成绩不到 1%。后续成绩要按评测版本与运行框架分开，不能用发布快照代替现状。</li>
<li><b>幻觉定理</b>（第三章）预言"靠更多训练消除幻觉"会失败——持续兑现。<span>兑现</span></li>
</ul>
<p><b>注意共性：理论成功的预测全是负向的，它从未成功预测过"什么行"。</b>它是一张负片。</p>

## <span>下篇 · 第七章</span>四层证据：基准能力不能换算成岗位替代 { #c7 }

<p>本章任务：区分从模型能力到实际就业的四类证据。它们使用不同任务、样本、指标和分母，不是同一效应的四次测量。</p>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>本卡片解释 → <b>第七章总论点</b>：为什么四种证据不能直接相减</div>
<h5>基准擅长回答「能做吗」，不是「省多少」</h5>
<p>测"AI 是不是在替代人"有四种办法：测能力上限（最像实验室）、测交付物质量、做对照试验、看真实就业数据（最像真实世界）。<b>每层能回答的问题不同，不能把数字排成一条递减曲线。</b></p>
<p>这四层之间隔着规格、复核、集成等真实工序；第八章讨论这些成本，但不能拿四层数字的差值去计算成本。</p>
</div>

<figure style="margin-inline:0">
<div>图 3 — 四层证据金字塔（第七章结构图）</div>
<svg viewBox="0 0 780 330" role="img" aria-label="四层证据金字塔" style="background:#171c25;display:block;max-width:100%;height:auto">
<polygon points="390,16 258,96 522,96" fill="#231F14" stroke="#D8B740"></polygon>
<text x="390" y="56" text-anchor="middle" fill="#ffffff" font-size="13" font-family="system-ui, sans-serif" font-weight="600">① 能力上限代理</text>
<text x="390" y="78" text-anchor="middle" font-size="11">任务时长每约 7 个月翻倍（最亮眼）</text>
<polygon points="256,101 524,101 578,171 202,171" fill="#1A212C" stroke="#57A08F"></polygon>
<text x="390" y="132" text-anchor="middle" fill="#ffffff" font-size="13" font-family="system-ui, sans-serif" font-weight="600">② 交付物评估</text>
<text x="390" y="154" text-anchor="middle" font-size="11">接近专家水平，但交付物由专家盲评；另对落败结果复评</text>
<polygon points="200,176 580,176 634,246 146,246" fill="#1A212C" stroke="#7E8B9C"></polygon>
<text x="390" y="207" text-anchor="middle" fill="#ffffff" font-size="13" font-family="system-ui, sans-serif" font-weight="600">③ 随机对照试验</text>
<text x="390" y="229" text-anchor="middle" font-size="11">资深开发者用了 AI 反而慢 19%</text>
<polygon points="144,251 636,251 690,318 90,318" fill="#241A1A" stroke="#C4553F"></polygon>
<text x="390" y="282" text-anchor="middle" fill="#ffffff" font-size="13" font-family="system-ui, sans-serif" font-weight="600">④ 真实就业数据（最保守）</text>
<text x="390" y="304" text-anchor="middle" font-size="11">22–25 岁高暴露组就业增长较慢；不是因果估计</text>
<text x="762" y="60" text-anchor="end" fill="#a8b3c1" font-size="10.5" font-family="system-ui, sans-serif">任务成绩</text>
<text x="762" y="310" text-anchor="end" fill="#a8b3c1" font-size="10.5" font-family="system-ui, sans-serif">就业观测</text>
</svg>
<figcaption>四层全部是<b>观测</b>，没有一层是从理论推导出来的——这正是第六章"箭头是反的"在证据层面的体现。</figcaption>
</figure>

### 7.1 第一层 · 能力代理：METR 任务时长 <span>实测</span> { #c7a }

<p><span>Time horizon（<span><b>time horizon（任务时长视界）</b>：AI 能以某成功率完成的任务，折算成"人类专家要花多久"。</span>）</span>（METR, 2025）：以 50% 成功率衡量，模型能自主完成的任务时长<b>六年来每约 7 个月翻一番</b>，2024 年后可能加速到 3–4 个月。2026 年 3 月的评测方法说明以 Claude Opus 4.6 为例： 的 <b>50% horizon 约 12 小时</b>，同一模型 <b>80% horizon 只有约 70 分钟</b>。</p>

<table>
<caption>同一模型、同一版任务集：提高成功率要求，时长估计会变短</caption>
<thead><tr><th>成功率口径</th><th>时长视界点估计</th><th>这个时长怎么读</th></tr></thead>
<tbody>
<tr><td>50%</td><td>约 12 小时</td><td>按拟合，在人类专家约用 12 小时的任务难度处，模型成功率约一半。</td></tr>
<tr><td>80%</td><td>约 70 分钟</td><td>把要求提高到八成，拟合对应的任务时长约为 70 分钟。</td></tr>
</tbody></table>

<p>这两个历史点估计是同一设置下的对照，约差 10 倍，不是两个模型的排名；时间是人类完成任务的基准，不是模型可连续工作的时长。<a href="https://metr.org/notes/2026-03-20-impact-of-modelling-assumptions-on-time-horizon-results/">METR 的方法检验</a>显示拟合和任务选择都能改变数字。<a href="https://metr.org/notes/2026-01-22-time-horizon-limitations/">其使用说明</a>也强调，可靠性要求不能从基准自动外推：生产门槛要看本地验收、复核和错误成本。</p>

### 7.2 第二层 · 交付物：GDPval <span>实测</span> { #c7b }

<p><span>GDPval（<span><b>GDPval</b>：OpenAI 的评测，用真实职业交付物（报告、表格、幻灯片）测模型是否达到专家水平。</span>）</span>（OpenAI, 2025）：美国 GDP 前九大行业、44 个职业、1320 项任务，平均 14 年经验的从业者出题，领域专家<b>盲评</b>。<a href="https://arxiv.org/html/2510.04374">论文</a>公开的 gold 子集有 220 项；Opus 4.1 在该子集相对专家的<b>胜或平为 47.6%</b>，GPT-4o 的 12.5% 是<b>胜率</b>，不能当同一指标比较。约 29% 指对 GPT-5 初评落败样本复评时判为糟糕或灾难性的比例，不是全部交付物的失败率。计入人工复核和重试后约 1.39 倍的提速，是 GPT-5 的<b>情景估算</b>，不是生产现场实测。</p>

### 7.3 第三层 · 因果：对照试验 <span>实测</span> { #c7c }

<p><span>RCT（<span><b>RCT（随机对照试验）</b>：把任务随机分配到"允许使用/不允许使用"条件后比较，衡量因果的黄金标准。</span>）</span>（METR, 2025）：16 名资深开源开发者，在他们平均维护五年的仓库里完成 246 项真实任务。</p>
<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>39 个百分点的感知—现实鸿沟</div>
<p>事前预测提速 <b>+24%</b> → 实测<b>拖慢 19%</b> → 事后自评仍认为提速了 <b>20%</b>。经济学家预测 +39%、机器学习专家预测 +38%，全部错向。</p>
</div>
<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>适用范围 <span>必读</span></div>
<p>N=16、场景特殊（资深者 + 极熟悉的成熟仓库）、2025 年初的工具；METR 已标为"历史性"。<a href="https://metr.org/blog/2026-02-24-uplift-update/">METR 2026 年 2 月跟进</a>的部分点估计转为提速，但样本与任务选择、并行使用 Agent 和计时方式使效应难以量化。<b>不能外推到初级开发者、全新项目、最新模型——同样，坊间"提速 90%"也不能外推。</b></p>
</div>
<p><b>McKinsey 补充</b>（2023，受控实验室）：常规任务省时显著（文档 45–50%、新代码 35–45%、重构 20–30%），<b>高复杂度任务省时不到 10%</b>。两项研究的任务和参与者并不相同。复杂度、仓库熟悉度、返工与复核方式都是试点里要单独记录的变量。</p>

### 7.4 第四层 · 就业：煤矿里的金丝雀 <span>实测</span> { #c7d }

<p>Brynjolfsson、Chandar、Chen 使用美国 ADP 工资单研究就业变化。<a href="https://digitaleconomy.stanford.edu/app/uploads/2026/08/Canaries_August2026.pdf">2026 年 8 月版工作论文</a>的分析面板每月约有 350 万至 500 万名劳动者。截至 2026 年 6 月，22–25 岁高 AI 暴露职业的就业相对同龄较低暴露组的增长基准低约 <b>19%</b>（描述性差距）；不是被裁掉 19%，也不是 AI 单独造成的因果估计。旧版引用的 13% 和约 16% 来自不同截点，不是同一估计的上下限。</p>
<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>年轻劳动者的观察差距不能推成全年龄就业结论</div>
<p>作者进一步考察了招聘、离职及 AI 倾向「自动化」或「增强」的职业差异。即使加入控制变量，面板数据仍不是随机试验；读到的是<b>相关性和人群差异</b>，不能据此给出所有行业的裁员率。</p>
</div>

## <span>下篇 · 第八章</span>机制：验证替代理解 { #c8 }

<p>本章任务：解释可验收性为何有助于委托任务、为何部分编程任务适合先试，以及规格、验证和集成如何影响净收益。这些是部署机制，不是解释全部就业变化的因果模型。</p>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>本卡片解释 → <b>8.1 核心命题</b>：替代边界由"验证器可得性 × 规格可写性"决定，而非认知难度</div>
<h5>比喻：判卷有多贵，决定了这份工作会不会被接手</h5>
<p>两种作业：<b>数学题</b>有标准答案，判卷免费，机器一秒判一万份；<b>作文</b>没有标准答案，判卷得请人读，慢且有分歧。</p>
<p>关键一步：<b>如果判卷免费，"会不会做"的重要性就大大下降</b>——让它做 20 遍，自动挑出对的那份。单次正确率 30%，试 20 次也几乎必中。但判卷贵，这招就废了：没法写 20 篇作文请 20 个老师读，它必须<b>一次写对</b>，要求高得多。</p>
<p><b>代码正好是"判卷免费"的作业</b>：编译器告诉你能不能跑，测试告诉你对不对，错了就撤销重来。所以 AI 写代码不需要每次都对，只需要"能试出对的"。这产生一个反直觉结论：看起来更难的（数学证明、算法竞赛）反而先被攻克，因为有标准答案；看起来简单的（判断客户投诉怎么处理）反而抗替代，因为没人能便宜地判对错。<b>难易在机器眼里，跟在人眼里不是一回事。</b></p>
</div>

#### 8.1 核心命题与它的名字

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>命题</div>
<p>替代边界 = <b>验证器可得性 × 规格可写性</b>，与认知难度无关（可称为<b>莫拉维克悖论的验证器版本</b>）。支撑体制运转的机制叫<b>验证替代理解</b>：如同医学在不懂药理机制的年代靠随机对照试验建立可靠性——不懂它为什么对，但能测它对不对，于是敢用。</p>
<p><b>业内对应物与出处属性声明：</b>这个命题的前半部分在业内有明确表述——Jason Wei（OpenAI）2025 年提出<b>"验证的不对称性"与 Verifier's Law</b>：训练 AI 解决一个任务的难易程度，与该任务的可验证程度成正比；强化学习社区的共识"可验证奖励（RLVR）是推理模型成功的前提"说的也是同一件事，这解释了为什么数学和代码是进展最快的领域。<b>但把它进一步延伸到"劳动替代边界"（本章 8.2、8.3），是本文档基于第七章证据的综合推断，属于有依据的假说，不是已被证明的结论</b>——这是全文中推断成分最重的一环，特此标明。</p>
</div>

#### 8.2 用命题解释第一件事：为什么是编程（六个条件全中）

<ul>
<li><b>验证器免费快速可靠</b>——编译器、测试、CI/CD 是现成的自动裁判。</li>
<li><b>训练数据自带监督信号</b>——GitHub 上代码 + issue + PR review + 测试结果，强化学习要的奖励是现成的。</li>
<li><b>交付物是纯文本</b>——模型的原生输出形态。</li>
<li><b>错误成本近零可回滚</b>——git revert、灰度发布，试 20 次的代价只是算力。</li>
<li><b>工作流本来就为"不可靠生产者"设计</b>——code review、CI 本是防<b>人</b>出错的，AI 接入直接继承这套免疫系统。</li>
<li><b>任务粒度可切分</b>——一个函数、一个 bug，恰好落在 7.1 那个时长视界的舒适区。</li>
</ul>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>本卡片解释 → <b>8.2 的对照组</b>：为什么律师、医生没被以同样速度替代</div>
<h5>不是因为更难，是因为没有编译器</h5>
<p>律师的工作流里没有编译器，会计的工作流里没有 CI，医生的诊断没有单元测试。他们的可靠性靠<b>执照、责任制、职业规范</b>——这些机制<b>无法容纳一个不承担责任的生产者</b>。障碍不在能力，在结构。</p>
</div>

<figure style="margin-inline:0">
<div>图 5 — 替代速度矩阵（8.1 命题图示）</div>
<svg viewBox="0 0 640 420" role="img" aria-label="验证器可得性与规格可写性的四象限" style="background:#171c25;display:block;max-width:100%;height:auto">
<text x="330" y="404" text-anchor="middle" fill="#a8b3c1" font-size="10.5" font-family="system-ui, sans-serif">规格可写性：这活能不能提前说清楚要什么 →</text>
<text x="26" y="210" text-anchor="middle" transform="rotate(-90 26,210)" fill="#a8b3c1" font-size="10.5" font-family="system-ui, sans-serif">验证器可得性：干完了好不好判对错 →</text>
<rect x="330" y="52" width="248" height="150" fill="#231F14" stroke="#D8B740"></rect>
<text x="454" y="106" text-anchor="middle" fill="#ffffff" font-size="13" font-family="system-ui, sans-serif" font-weight="600">最先被替代</text>
<text x="454" y="132" text-anchor="middle" font-size="11.5">编程、数据处理、格式转换、</text>
<text x="454" y="150" text-anchor="middle" font-size="11.5">翻译、有标准答案的分析</text>
<text x="454" y="176" text-anchor="middle" fill="#D8B740" font-size="10.5" font-family="system-ui, sans-serif">正在发生</text>
<rect x="80" y="52" width="248" height="150" fill="#1A212C" stroke="#57A08F"></rect>
<text x="204" y="106" text-anchor="middle" fill="#ffffff" font-size="13" font-family="system-ui, sans-serif" font-weight="600">半自动</text>
<text x="204" y="132" text-anchor="middle" font-size="11.5">能判好坏，但难写清要求：</text>
<text x="204" y="150" text-anchor="middle" font-size="11.5">设计、创意、文案</text>
<text x="204" y="176" text-anchor="middle" fill="#57A08F" font-size="10.5" font-family="system-ui, sans-serif">人给方向，AI 出稿</text>
<rect x="330" y="206" width="248" height="150" fill="#1A212C" stroke="#7E8B9C"></rect>
<text x="454" y="260" text-anchor="middle" fill="#ffffff" font-size="13" font-family="system-ui, sans-serif" font-weight="600">慢</text>
<text x="454" y="286" text-anchor="middle" font-size="11.5">要求清楚，但难判对错：</text>
<text x="454" y="304" text-anchor="middle" font-size="11.5">医疗诊断、法律意见</text>
<text x="454" y="330" text-anchor="middle" fill="#a8b3c1" font-size="10.5" font-family="system-ui, sans-serif">卡在验证，不是卡在能力</text>
<rect x="80" y="206" width="248" height="150" fill="#241A1A" stroke="#C4553F"></rect>
<text x="204" y="260" text-anchor="middle" fill="#ffffff" font-size="13" font-family="system-ui, sans-serif" font-weight="600">最难被替代</text>
<text x="204" y="286" text-anchor="middle" font-size="11.5">管理、谈判、护理、</text>
<text x="204" y="304" text-anchor="middle" font-size="11.5">开放式研究与判断</text>
<text x="204" y="330" text-anchor="middle" fill="#C4553F" font-size="10.5" font-family="system-ui, sans-serif">结构性缺陷，非暂时滞后</text>
</svg>
<figcaption>四个象限跟"认知难度"没有关系——数学证明在右上，处理客户投诉在左下。</figcaption>
</figure>

#### 8.3 用命题解释第二件事：第七章的缩水去哪了

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>规格化、验证和集成要单独核算</div>
<p>GDPval（7.2）测的是：给一份专家写好的完整规格，模型能不能交出合格作品。RCT（7.3）测的是：真实工作流的净效应——包括把问题想清楚、判断输出对不对、集成进既有系统。<b>规格、复核与集成本身就是资深工程师的工作；它们解释了为什么基准结果不等于流程收益，但两项研究不能直接相减来量化这些成本。</b></p>
</div>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>本卡片解释 → <b>8.3 的推论</b>：为什么被击中的偏偏是初级岗位（对应 7.4 的就业数据）</div>
<h5>初级岗位不是"比较容易被替代"，是被精确击中了</h5>
<p>初级工程师的价值命题就是<b>"给我明确的任务，我能干完"</b>——恰好就是"规格可写 + 结果可验证"的定义。资深者没被替代，<b>不是因为代码写得更漂亮</b>，而是因为他们的实际工作是<b>写规格、判断验证结果</b>——正是上面那个差额本身。</p>
<p><b>恶性循环：</b>初级岗位是培养资深能力的唯一通道。今天削掉的入门岗，是十年后资深者的成长阶梯。入口关闭后，"写规格和判断验证"的能力从哪来，是没有答案的开放问题。</p>
</div>

## <span>下篇 · 第九章</span>风险：验证覆盖不到的地方，仍要监测和接管 { #c9 }

<p>试验或回归集提供的是特定样本与条件下的证据。要外推到新场景，需要另外说明哪些前提仍成立，并保留监测和接管手段。</p>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>本卡片解释 → <b>9.1 历史对比</b>：这次的"工程先于科学"与蒸汽机时代有一个本质差别</div>
<h5>工程先于科学是常态，但这次连图纸都没有</h5>
<p>蒸汽机比热力学早一百年，飞机比空气动力学早，阿司匹林用了近百年才明机制——<b>先造出来再搞懂，历史上很常见</b>。但有个关键差别：<b>蒸汽机的制造者完全理解自己的机器</b>，每个齿轮都是他画的图纸，他只是不懂背后的普适定律。</p>
<p>大模型的参数是算法从数据里<b>搜索</b>出来的，没有任何人设计过它的内部结构。<b>"设计层面的理解"从第一天起就不存在。</b>这也是第六章"逆向工程"一词的最终解释。</p>
</div>

<table>
<tr><th>案例</th><th>工程</th><th>理论</th><th>制造者对造物的理解</th></tr>
<tr><td>蒸汽机 → 热力学</td><td>1712</td><td>1824 卡诺</td><td><b>完全理解自己的机器</b>，只是不懂普适定律</td></tr>
<tr><td>飞行 → 空气动力学</td><td>1903</td><td>随后系统化</td><td>亲手设计每个部件</td></tr>
<tr><td>阿司匹林 → 机制</td><td>1899 上市</td><td>1970 年代</td><td>配方明确、可复现</td></tr>
<tr><td><b>大模型 → ？</b></td><td>2018+ 部署</td><td><b>缺失</b></td><td><b>从一开始就不存在</b>：参数是搜出来的</td></tr>
</table>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>失效模式 · 全文最重要的风险论断</div>
<ul>
<li>已测场景的结果能支持相似条件下的判断，不保证每个输入都能成功。</li>
<li>输入、工具或流程变化时，要重新检查验收条件和失败类型。</li>
<li>形式保证也以其前提为限；未覆盖的行为不能靠一句「测试通过」兜底。</li>
<li><b>结论：对于尚未覆盖的风险，保留监测、停止执行和人工接管。</b></li>
</ul>
<p>METR 观察到的早期形态（对应 7.1）：horizon 翻倍，但失败方式更复杂、每次人工干预需要的人力反而上升。<b>能力提升不自动带来可控性提升。</b></p>
</div>

## <span>终章 · 第十章</span>三问判据与分角色建议 { #c10 }

<p>本章任务：把前九章收拢成可直接使用的工具。判据来自第八章的命题，阈值来自第七章的数据，警惕来自第九章的风险。</p>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>本卡片对应 → <b>第八章命题的应用版</b>：三个问题判断一份工作会不会被替代</div>
<h5>三个问题，比"这活需要多少智力"可靠得多</h5>
<ol>
<li><b>产出能不能便宜地判断对错？</b>（有没有编译器式的裁判——验证器可得性）</li>
<li><b>要求能不能在开工前写清楚？</b>（规格可写性）</li>
<li><b>做错了能不能低成本回滚？</b>（错误代价）</li>
</ol>
<p><b>三个都是"能"——它已经在被替代了</b>，只是当事人可能还没感觉到（记得 7.3 那 39 个百分点的感知差，就是在专业人士身上测出来的）。<b>有任何一个是"否"——那才是真正的硬边界</b>，而且不会因为模型变强而消失，因为它不是能力问题。</p>
</div>

<div style="border-inline-start:0.2rem solid currentColor;padding-inline-start:0.75rem;margin-block:1em">
<div>本卡片对应 → <b>7.3 感知偏差数据的应用版</b>：自我校准</div>
<h5>一个自我校准的问题</h5>
<p><b>你上一次发现 AI 犯错，是靠自己当场判断出来的，还是靠外部反馈告诉你的？</b>（测试失败、同事指出、线上报错、事后发现）</p>
<p>如果多数是后者，你对 AI 能力的估计几乎肯定<b>偏高</b>——你看到的只是碰巧被外部机制捕获的错误，不是错误的真实分布。"感觉 AI 没有局限"的体验，很大程度上就是这个采样偏差的产物。</p>
</div>

#### 10.1 给技术与工程决策者

<ol>
<li><b>立即</b>——用图 5 的矩阵筛选落地场景：优先右上象限，低验证 + 高风险场景保留人类终审。<b>阈值</b>：任务若无法建立"成本低于人工复核"的自动验证器，不做全自动化。（依据：第八章）</li>
<li><b>6 个月</b>——用对照测量而非满意度调查衡量提效。<b>阈值</b>：受控测量显示净提速<b>且缺陷率不升</b>，才扩大投入。（依据：7.3 的 39 个百分点）</li>
<li><b>持续</b>——50% 和 80% horizon 都不是产能规划值。对真实任务单独定义合格率、尾部错误和人工复核要求；可靠性门槛由风险与失败代价决定。（依据：7.1）</li>
</ol>

#### 10.2 给企业与人才决策者

<ol>
<li><b>立即</b>——不要因短期成本削光初级岗：<b>把初级岗当人才管线投资计入 ROI</b>。"写规格、判断验证结果"这项能力目前只有一条培养路径。（依据：8.3）</li>
<li><b>6–12 个月</b>——把初级人才重新定位到规格与验证上，而非执行上——这是当前 AI 最弱处，也是资深工作的本质。（依据：8.3）</li>
</ol>

#### 10.3 给政策与研究决策者

<ol>
<li><b>持续监测入门端就业。</b>同时跟踪不同年龄、职业和地区的招聘、离职和就业总量，并与其他数据源对照。若差距扩到更多组，先检查劳动力需求等解释，再判断是否与 AI 有关。（依据：7.4）</li>
<li><b>为分布外失效建立披露与审计机制</b>——理论保证缺失时，唯一防线是把失效快速反馈进验证体系。（依据：第九章）</li>
</ol>

## <span>附录 A</span>局限与争议 { #a1 }

<ul>
<li><b>复杂度结果的条件性</b>（第二章）——所有"做不到"依赖 <code>TC⁰ ≠ NC¹</code> 等未证明猜想，一旦坍缩全部失效。</li>
<li><b>幻觉定理的口径</b>（第三章）——对角化是"形式世界存在性"，有批评（arXiv 2502.12187）指出实践上幻觉可压到可忽略；统计下界主要对基座模型和任意事实强成立，检索可大幅改变结论。</li>
<li><b>对照试验</b>（7.3）——N=16、场景特殊、2025 年初工具；2026 跟进翻转但有严重选择效应。不可外推。</li>
<li><b>就业数据是相关而非因果</b>（7.4）——招聘周期、离岸外包和职业构成等因素都可能改变观察结果。</li>
<li><b>GDPval 由 OpenAI 自建</b>（7.2）——以静态交付物为主、非交互；"胜或平"含平局。</li>
<li><b>时长视界的置信区间</b>（7.1）——Opus 4.6 的 50% horizon 点估计约 12 小时但区间极宽（任务集高端接近饱和）；80% 点估计约 70 分钟，也受拟合方式影响。</li>
<li><b>比喻的边界</b>（第三章）——早期版本曾用"背电话簿"作比：该比喻描述的是记忆检索，而定理说的是概率生成，字面逻辑下反而不成立（背诵者可零出错），已替换为保留"生成 + 校准"机制的"传记作家"比喻。所有比喻只保证机制对应，不保证数值精确。</li>
<li><b>验证器框架的出处属性</b>（第八章）——"可验证性决定进展速度"是业内已有表述（Jason Wei 的 Verifier's Law、RLVR 共识）；将其延伸为"劳动替代边界"是本文档的综合推断，非已证结论。</li>
<li><b>唯象模型提示</b>（第五章）——"每步固定失败率""视界直线外推"都是经验拟合而非定理，外推需谨慎。</li>
</ul>

## <span>附录 B</span>术语表 { #a2 }

<dl>
<div><dt>TC⁰（读作 TC zero / TC 零）</dt><dd>常数深度、多项式规模、含阈值门的电路能解决的问题类。T = Threshold（阈值电路），上标 0 = 常数深度。"层数固定、极度可并行的浅层计算"。裸 Transformer 与 SSM 被锁在此类。</dd></div>
<div><dt>AC⁰ ⊂ TC⁰ ⊂ NC¹</dt><dd>由浅到深的三个电路类。AC⁰ 只有基本逻辑门；TC⁰ 多了阈值门；NC¹（NC one，Nick's Class，以学者 Nick Pippenger 命名）是对数深度、能模拟自动机。读法：上标数字表示电路深度量级——0 是常数深度，1 是对数深度。</dd></div>
<div><dt>电路复杂度</dt><dd>用"电路的深度和规模"给问题难度分类的理论框架。本文"工序数"比喻的正式对应物。</dd></div>
<div><dt>Scaling law（规模律）</dt><dd>预测误差随参数、数据、算力呈幂律下降的<b>经验</b>关系。能预测误差，不能预测具体能力。</dd></div>
<div><dt>ICL（上下文学习）</dt><dd>不更新参数、仅凭 prompt 里的例子学会新任务。</dd></div>
<div><dt>涌现</dt><dd>小模型不会、大模型突然会的能力。是否真实存在尚有争议——可能是评分方式的假象。</dd></div>
<div><dt>RLHF</dt><dd>用人类偏好训练评分员再微调模型。工程有效，理论空白。</dd></div>
<div><dt>CoT（思维链）</dt><dd>先写中间推理步骤再作答。在计算上等于"到时间维度上买深度"（2.4）。</dd></div>
<div><dt>SSM（状态空间模型）</dt><dd>S4、Mamba 类模型。为可训练把递归改成并行扫描，因此同受 TC⁰ 限制（2.3）。</dd></div>
<div><dt>幻觉</dt><dd>自信地生成看似合理却错误的内容。有数学下界（第三章）。</dd></div>
<div><dt>校准</dt><dd>模型说 70% 把握时约 70% 情况真的对。</dd></div>
<div><dt>missing mass</dt><dd>样本未见事件的总概率质量。在适用条件下，可用只观察到一次的频次估计它。</dd></div>
<div><dt>万能逼近定理</dt><dd>足够大的网络能逼近任意函数——存在性结论，不保证学得到（第四章）。</dd></div>
<div><dt>SAE / 叠加</dt><dd>叠加：多个概念挤在同一批神经元里；SAE：试图拆开它们的方法（6.1）。</dd></div>
<div><dt>归因图 / 电路追踪</dt><dd>为单条输入还原内部因果路径的方法，约 1/4 是特定模型与作者所选示例中的主观评价（6.1）。</dd></div>
<div><dt>time horizon</dt><dd>AI 以某成功率能完成的任务折算成人类所需时长（7.1）。</dd></div>
<div><dt>test-time compute</dt><dd>推理阶段花更多算力提升表现，即 2.4 说的"换个维度买深度"。</dd></div>
<div><dt>RCT</dt><dd>随机对照试验，衡量因果的黄金标准（7.3）。</dd></div>
<div><dt>ARC-AGI</dt><dd>Chollet 的基准，考察对全新规则的少样本归纳（6.2）。</dd></div>
<div><dt>莫拉维克悖论（验证器版本）</dt><dd>机器眼中的难易取决于可验证性与规格可写性，而非认知难度（8.1）。</dd></div>
<div><dt>金字塔原理</dt><dd>结论先行、以上统下、归类分组、逻辑递进——本文档的组织方式。</dd></div>
</dl>

## <span>附录 C</span>参考文献 { #a3 }

#### 能力来源（第一章）

<ol>
<li>Kaplan et al., "Scaling Laws for Neural Language Models," OpenAI, 2020.</li>
<li>Hoffmann et al., "Training Compute-Optimal LLMs (Chinchilla)," DeepMind, 2022；Pearce &amp; Song, arXiv:2406.12907, 2024.</li>
<li>Xie et al., "An Explanation of In-context Learning as Implicit Bayesian Inference," arXiv:2111.02080, 2021.</li>
<li>Schaeffer, Miranda, Koyejo, "Are Emergent Abilities of LLMs a Mirage?" NeurIPS 2023, arXiv:2304.15004.</li>
</ol>

#### 墙一 · 表达力（第二章）

<ol start="5">
<li>Merrill &amp; Sabharwal, "The Expressive Power of Transformers with Chain of Thought," ICLR 2024, arXiv:2310.07923；"Saturated Transformers are Constant-Depth Threshold Circuits," TACL 2022.</li>
<li>Li et al., 2024（CoT 步数下界）；Bavandpour et al., 2025（parity/乘法/中位数 Ω(n) 步）。</li>
<li>Merrill, Petty, Sabharwal, "The Illusion of State in State-Space Models," ICML 2024, arXiv:2404.08819.</li>
<li>Pérez et al., "On the Turing Completeness of Modern Neural Network Architectures," 2019/2021.</li>
</ol>

#### 墙二、墙三 · 幻觉与可学习性（第三、四章）

<ol start="9">
<li>Xu, Jain, Kankanhalli, "Hallucination is Inevitable," arXiv:2401.11817, 2024.</li>
<li>Kalai &amp; Vempala, "Calibrated Language Models Must Hallucinate," STOC 2024, arXiv:2311.14648.</li>
<li>Kalai, Nachum, Vempala, Zhang, "Why Language Models Hallucinate," arXiv:2509.04664, 2025；Nature 653, 2026.</li>
<li>Kalavasis, Mehrotra, Velegkas, "On the Limits of Language Generation," STOC 2025.</li>
<li>Dziri et al., "Faith and Fate," NeurIPS 2023, arXiv:2305.18654.</li>
<li>Berglund et al., "The Reversal Curse," ICLR 2024, arXiv:2309.12288.</li>
<li>Mirzadeh et al., "GSM-Symbolic," Apple, ICLR 2025, arXiv:2410.05229.</li>
</ol>

#### 可解释性（第六章）

<ol start="16">
<li>Smith, Rajamanoharan, Conmy, Nanda et al., "Negative Results for SAEs," DeepMind, 2025-03.</li>
<li>Lindsey, Ameisen, Batson et al., "Circuit Tracing" &amp; "On the Biology of a Large Language Model," Anthropic, 2025.</li>
</ol>

#### 现实证据（第七章）

<ol start="18">
<li>Kwa et al. (METR), arXiv:2503.14499, 2025；"Time Horizon 1.1," 2026-01；"Clarifying limitations of time horizon," 2026-01.</li>
<li>Becker, Rush, Barnes, Rein (METR), arXiv:2507.09089, 2025；"Changing our Developer Productivity Experiment Design," 2026-02.</li>
<li>McKinsey Digital, "Unleashing Developer Productivity with Generative AI," 2023-06.</li>
<li>Patwardhan et al. (OpenAI), "GDPval," arXiv:2510.04374, 2025.</li>
<li>Brynjolfsson, Chandar, Chen, "Canaries in the Coal Mine?" Stanford Digital Economy Lab, 2025；2026-02 更新.</li>
<li>Chollet, "On the Measure of Intelligence," 2019；ARC Prize Foundation, ARC-AGI-1/2/3, 2019–2026.</li>
</ol>

<hr>
<p>本文档为研究性综述。所有量化结论附来源与适用范围；争议处采用最保守可核实表述。术语解释以帮助非专业读者为目的，严格定义请回溯原始论文。</p>
