# 工具设计：写给模型用的接口

> 本章不对应原站文章，是知识库的补充章节（独立原创）：讲怎么设计一组让模型用得顺手的工具，并用一个离线对照实验量一量「坏工具」和「好工具」各让模型多读了多少字。

> **一句话结论**：模型对一个工具的全部认知，就是它的名字、描述、参数 schema，以及调用后拿回来的那段文字。所以工具要按「模型要完成的任务」来设计：数量少、职责清楚，只返回下一步决策要用的信息，出错时告诉它怎么改，必须守住的规则写进代码。设计得好不好，用评测任务跑出来的选错率、调用次数和 token 消耗来判断。

## 接口都是对的，Agent 为什么还是绕了三圈？

假设你给 webapp 写了一个 MCP server，把后端的 REST 接口挨个包成了工具：`GET /users`、`GET /users/{id}/orders`、`POST /refunds`。在 Claude Code 里一试，它确实能调。

可是你让它「给张伟最近买的耳机退款」，它先拉了全量用户列表，再拉订单，然后对着退款接口试了三次参数才成功。最后你去后台一看：本该退 ¥899，实际退了 ¥8.99。

你可能会问：接口没问题，后端文档也齐全，到底哪里出了错？

问题在于这些接口是给写代码的人设计的。人有 IDE 跳转、有接口文档、能 `console.log` 看返回值；模型什么都没有，它只能看到你写进工具定义的那几行字。这一章换个角度：把工具当成一份**写给模型用的 API** 来设计。

## 模型的视野里只有四样东西

先看清楚模型和工具之间到底传了什么。

```d2
direction: down
def: "① 名字　② 描述　③ 参数 schema\n每次请求都发送"
model: "模型\n只能读上下文里的文字"
code: "你的代码（模型看不到）\n参数校验 · 业务规则 · 后端接口\n内部 ID · 单位换算 · 错误码"
res: "④ tool_result 文字（含 is_error）\n留在历史里，之后每轮都要重读"
def -> model
model -> code: "tool_use：名字 + 参数 JSON"
code -> res: "你决定回给它什么"
# 回环写成 model <- res，ELK 才不会把结果节点排到模型上面
model <- res: "下一轮"
```

图里「你的代码」那一块，模型一概看不到：数据库表结构、错误码的含义、金额是分还是元、哪些订单过了退款期。它能做的只有一件事：读这四样文字，然后预测下一步该调哪个工具、填什么参数。

打个比方：你在给一位电话客服设计工单系统。客服看不到数据库，只能看到屏幕上的按钮名、按钮旁的说明、表单字段，以及点完按钮后弹出的提示。按钮叫「POST /refunds」、字段叫 `amount`、出错弹一段堆栈，客服只能靠猜。

这个类比有一处不成立：真人客服会问旁边的同事，也会记住上周踩过的坑。模型每次只能看到当前上下文，描述写了什么，它就只知道什么。

**回到主线**：工具定义和工具结果都是塞进上下文的 token。设计工具，说白了就是决定往上下文里放哪些字。放对了，模型少走弯路、少读废话；放错了，花了 token 还把模型带偏。

## 粒度：按任务设计，不按接口一比一包装

后端接口按「资源」切分，是为了让人能自由组合。模型组合工具的成本却很高：每多一次调用，就多一次模型推理，中间结果还要在上下文里留到对话结束。

Anthropic 那篇工具设计文章里有个例子：日程场景下，与其给 `list_users`、`list_events`、`create_event` 三个工具，不如给一个 `schedule_event`，在工具内部完成查人、查空档、建日程。本章的退款例子也是这个思路：

| 坏工具集（照接口包装） | 好工具集（照任务设计） |
|---|---|
| `api_get_users`：返回全量用户 JSON | `webapp_find_orders`：按客户姓名或邮箱查订单，可按商品名过滤 |
| `api_get_orders`：要先拿到用户 ID | （合并进上一个工具） |
| `api_post_refunds`：要内部订单 ID、以分为单位的金额 | `webapp_refund_order`：订单号加原因，默认全额退款 |

你可能会问：那干脆合成一个 `webapp_refund_for_customer`，一步到位不是更好？

我不这么做。判断合还是拆，我用三条标准：

- **中间结果需不需要模型做判断。** 用户 ID 只是为了下一步查订单，模型不需要对它做任何判断，所以查用户应该合进查订单。查到的订单列表就不一样了：哪一笔是「上个月底的耳机」，需要模型结合用户的话来判断，所以查订单和退款要分开。
- **有没有副作用。** 只读的工具调错了，代价是一点 token；会退钱的工具调错了，钱就真退出去了。读写分开，权限和确认流程也可以分开配置。
- **合并后参数会不会膨胀。** 如果合并到最后需要一个 `action` 字段，外加一堆「只在某个 action 下才有效」的参数，就说明合过头了。「Agent 构建指南」里讲过同一个问题：每个动作只列允许的参数，多余的字段会被模型乱填。

工具数量本身也有代价。官方文档给过两个量级：工具超过 30–50 个后，模型选对工具的能力会下降；同时挂 GitHub、Slack、Sentry、Grafana、Splunk 这类多个服务时，光工具定义就可能占掉约 55k token。所以工具不是越全越好，先挑出高频任务，把那几件事做好。

## 命名和描述：当成写给新同事的上手文档

**名字带命名空间。** 好工具集统一用 `webapp_` 前缀。工具一多，前缀能让模型分清相近的工具，比如 `webapp_find_orders` 和另一个 server 里的 `crm_find_orders`。

后面讲到工具搜索时，前缀还能让一次搜索命中同一组工具。Claude Code 给 MCP 工具加的 `mcp__<server>__<tool>` 前缀，起的也是这个作用。

**参数名自带含义和单位。** 本章开头那笔「退了 ¥8.99」的事故，就出在 `amount` 这个参数名上：后端要的是分，模型以为是元。好工具集改成 `amount_yuan`，并且「全额退款不要填」，单位换算交给代码去做。同理，`user` 不如 `user_id`，`id` 不如 `order_number`。

**描述要回答五个问题**：做什么、什么时候用、什么时候不用、参数怎么填（给出例子）、有什么副作用。好工具集里退款工具的描述是这样写的：

```text
给一笔订单发起退款，会真实退钱，调用前确认订单号和金额。
订单号必须来自 webapp_find_orders 的结果。不填 amount_yuan 就是全额退款。
已过退款期的订单会被拒绝，这时不要换参数重试，告诉用户需要人工客服处理。
```

对比一下 Claude Code 内置工具的描述风格（以下是我在本机一次会话里看到的版本，不同版本措辞会变）：Read 工具写明「`file_path` 必须是绝对路径」「默认最多读 2000 行」「已经知道要读哪一段时只读那一段」；Edit 工具写明「`old_string` 必须和文件内容完全一致并且唯一，否则编辑失败」「编辑前必须先在本会话里 Read 过这个文件」。

注意最后一条：它既写在描述里，Claude Code 的代码也真的会拒绝没读过就改的请求。描述负责让模型一开始就做对，代码负责万一没做对时拦住它。这就是下面「硬约束」那一节要讲的分工。

官方 tool use 文档还强调了一点：描述里要**明确写出什么时候该调用**，而不是只写这个工具能做什么。较新的 Opus 模型调用工具更谨慎，描述里写清触发条件，能明显提高「该调的时候调了」的比例。

## 返回值：只给下一步决策要用的信息

后端返回什么就原样转给模型，是最常见的偷懒做法。坏工具集的 `api_get_users` 一次返回 4415 字符的 JSON，里面有手机号、登录 IP、营销偏好，和「退耳机」没有任何关系。

好工具集的 `webapp_find_orders` 默认这样返回：

```text
张伟（user03@example.com）的订单，匹配「耳机」，共 2 笔，按下单时间倒序：
ORD-1042 · 2026-10-30 · 降噪耳机 Pro ×1 · ¥899.00 · 可退款
ORD-0987 · 2026-08-12 · 运动耳机 ×1 · ¥299.00 · 已过退款期
```

149 个字符，下一步需要的东西都在里面：哪一笔是上个月底的、能不能退、订单号是什么。这里有四个做法：

- **用有意义的名字代替不透明 ID。** 模型抄 `ORD-1042` 几乎不会抄错，抄 `ord_fdb5cb31-98ad` 这种串就容易出错，甚至凭空编一个。Anthropic 的文章提到，把 UUID 换成自然语言名称后，检索的准确率有提升。内部 ID 留在代码里，由工具自己完成映射。
- **把判断结果直接算好。** 「可退款 / 已过退款期」是代码拿日期比出来的，模型不用自己做日期运算。
- **提供 concise / detailed 两种格式。** 加一个 `response_format` 参数，默认简洁；需要物流单号、SKU 时再传 `detailed`。Anthropic 的文章里有一组数据：同一条结果，详细版 206 token，简洁版 72 token。
- **大结果分页或截断，并告诉模型怎么拿剩下的。** 只截不说，模型会以为自己看到的就是全部。分页时，末尾要给出能照着做的下一步：

```text
张伟（user03@example.com）的订单，共 6 笔，按下单时间倒序：
ORD-1042 · 2026-10-30 · 降噪耳机 Pro ×1 · ¥899.00 · 可退款
ORD-1038 · 2026-10-21 · 机械键盘 ×1 · ¥599.00 · 已过退款期
还有 4 笔没列出：传 offset=2 看下一页，或加 query 缩小范围。
```

Claude Code 对 MCP 工具结果也有类似的兜底：按官方文档，输出超过 10,000 token 时显示警告，默认最多 25,000 token（可以用 `MAX_MCP_OUTPUT_TOKENS` 调整）；工具没有声明自己的上限时，超过 50,000 字符的纯文本结果会存成文件。这是客户端的保底措施，你的工具不该依赖它，最好在自己这一层就把结果控制在合理大小。

还有一笔容易漏算的账：工具结果不是读一次就完了，它会一直留在历史里，**之后每一轮请求都要重新发送**。本章实验里，坏工具集的结果合计约 8 千字符，算上被反复发送的部分，累计发送了约 3.9 万字符。

## 错误信息要能指导下一步

工具执行失败时，回一个 `is_error: true` 的 `tool_result`，不要把这次调用直接丢掉。官方文档的说法是：写一段有信息量的错误说明，模型通常会据此换个做法，或者回头去问用户。

关键在「有信息量」这几个字。看看实验里两套工具各自回了什么。坏工具集把后端响应原样转给模型（节选）：

```text
HTTP 422 Unprocessable Entity
{"code":"E_REFUND_4003","trace":"RefundValidationError: E_REFUND_4003\n    at validateRefund (/srv/payments/refund.js:88:11)\n    ...
```

模型看不懂 `E_REFUND_4003` 是什么意思，只能猜。剧本里它先把原因换成 `defective`，又换成 `damaged`，第三次才碰对。好工具集回的是：

```text
参数有误，这次没有执行：
- order_number="1042" 格式不对。订单号，形如 ORD-1042，从 webapp_find_orders 的结果里原样复制，不要自己编
按上面逐条改好再调；不确定订单号就先调 webapp_find_orders。
```

一条好的错误信息有三个部分：**这次做没做**（「没有执行」，模型就知道不用担心重复退款）、**哪里错、正确的格式是什么**、**下一步做什么**。下一步大致分三类，要明确写出来：

| 错误类型 | 告诉模型 |
|---|---|
| 参数可以修正 | 正确的格式和例子，改完重试 |
| 缺少前置信息 | 先调哪个工具 |
| 业务上不允许（比如过了退款期） | **不要重试**，把情况告诉用户 |

第三类特别容易被忽略。如果只写「退款失败」，模型很可能换着参数一直试下去。「Agent 构建指南」里有一条相关的提醒：工具返回文字里的一句催促，就可能让模型开始重复调用。所以这类文字改动前，先用固定任务重放一遍，看看行为有没有变。

## 硬约束写进代码：校验在前，副作用在后

描述写得再好也只是软约束，模型照做的概率高，但不是百分之百。必须守住的规则要在代码里实现，[Agent 构建指南](../p3-agent-internals/13-agent-build-guide.md)「内核二：工具描述是软约束，硬约束要写在闸门里」专门讲过这一点，这里只补两点和工具设计直接相关的。

**第一，参数校验放在任何副作用之前。** 好工具集用一个 `checked()` 包装：参数不符合 schema 就直接返回错误，后端完全不会被调用。测试里专门断言了这一点：非法参数调用之后，没有一笔订单产生退款记录。

**第二，Claude API 有 strict 模式（strict tool use）。** 在工具定义的顶层加 `"strict": true`（和 `name`、`input_schema` 同级，不是加在 `tool_choice` 上），schema 里的对象要写 `additionalProperties: false` 并列出 `required`，接口就能保证模型给出的 `input` 严格符合 schema。

不过 strict 只管 schema 层面的约束。按 Claude 的参考文档，数值范围（`minimum` / `maximum`）、字符串长度这类约束不在 strict 的支持范围内；本章好工具集里的 `limit`、`amount_yuan` 范围如果要开 strict，就得挪到代码里校验。至于「订单号必须真实存在」「过了退款期不能退」这些业务规则，schema 本来就表达不了，只能写在代码里。

顺带一提：Claude Opus 5.5、Claude Sonnet 5.5 等新模型已经不支持强制调用某个工具（`tool_choice` 设为 `any` 或 `tool` 会返回 400）。官方建议的替代做法是 `auto`，加上在提示词里点名要用的工具，再配合 `strict: true`。这也说明，工具的名字和描述写得清楚，现在比以前更重要。

## 工具多了：只常驻少数，其余按需加载

前面说过，几十个工具的定义每轮都要发送，挤占上下文，还会拉低选对工具的准确率。官方的解决办法是工具搜索（tool search）：把大部分工具标成延迟加载，模型需要时先搜索，搜到了再把完整定义加进上下文。

```d2
direction: down
req: "请求里的 tools 数组：每次都发送全部定义\n搜索工具 + 3–5 个高频工具常驻\n其余几十到上千个标 defer_loading: true"
ctx: "模型的上下文里\n一开始只有常驻的工具"
s: "模型调用搜索工具\n（服务端执行）"
r: "返回 tool_reference\n（默认最多 5 个）"
x: "接口把它们展开成完整定义、追加到上下文\n模型再调用搜到的工具"
req -> ctx
ctx -> s
s -> r
r -> x
```

以下几点都核对过 Claude 官方文档（2026 年 11 月的版本）：

- 搜索工具有两种：`tool_search_tool_regex_20251119`（模型写正则）和 `tool_search_tool_bm25_20251119`（模型写自然语言查询）。
- 需要延迟加载的工具，在定义上加 `defer_loading: true`。注意，被延迟的工具定义**仍然要在每次请求里完整发送**，`defer_loading` 只决定它们一开始进不进模型的上下文。
- 至少要有一个工具不延迟，通常就是搜索工具本身。全部标成延迟会返回 400。
- 搜索结果以 `tool_reference` 的形式返回，默认最多 5 个，由接口自动展开成完整定义。展开的定义是追加进去的，不替换前面的内容，所以不会让提示缓存失效。
- 文档建议：工具达到 10 个以上，或者工具定义超过 10k token 时考虑使用；最常用的 3–5 个工具保持常驻；工具名按服务加统一前缀，描述里写进用户描述任务时会用的关键词，方便被搜到。
- 也可以自己实现搜索（比如用 embedding 检索）：在你自己的搜索工具的 `tool_result` 里返回 `tool_reference` 块即可。

Claude Code 对 MCP 工具默认开启了工具搜索：按官方文档，会话开始时只加载 MCP 工具的名字和 server 的 instructions，完整定义等需要时再加载。环境变量 `ENABLE_TOOL_SEARCH` 可以调整这个行为：设成 `false` 就全部预先加载；设成 `auto` 则在工具定义总量低于上下文窗口的 10% 时预先加载，超过才启用搜索（`auto:N` 可以自定义这个百分比）。

所以写 MCP server 时，server 的 instructions 和工具描述的**开头几句**更重要了：搜索主要匹配这些文字，模型也是靠它们决定要不要去搜。

你可能已经发现，这和 [Skills](../p1-tools/12-skills.md) 是同一个思路：skill 的 description 常驻上下文，正文用到时才读。说穿了就是：**常驻的只放索引，详细内容按需加载**。

## 动手：同一个退款任务，两套工具

代码在 `code/agent-node/tool_design/`（Python 版在 `code/agent/tool_design/`）：

- `toolsets` 是一个假的 webapp 后端（12 个用户、张伟的 6 笔订单、一个会抛错的退款函数），以及建在它上面的两套工具。
- `budget` 负责统计字符数、粗估 token，以及截断结果。
- `compare` 是一个最小 agent 循环，加上两份剧本。

**先说清楚这个实验能证明什么。** 两条轨迹都是 `FakeAnthropic` 的剧本：模型调哪个工具、填什么参数，都是我写死的，用来演示「模型看到这样的工具和返回值，可能会怎么走」。它**不能**证明真实模型在坏工具集下就一定会猜三次。真实差异有多大，要用下文的评测方法去跑。

实验里真正客观的只有字符数：工具定义多长、每次结果多长、历史累计重复发送了多少，这些是代码实际算出来的，和剧本无关。

=== "Node"

    ```text
    $ cd code/agent-node && node tool_design/compare.ts
    —— 坏工具集：后端接口一比一包装 ——
    ❯ 张伟说上个月底买的耳机有问题，帮他退款。
    ⏺ api_get_users({})
    ✔ [{"id":"usr_30399c1e-4b7a-8f2d-3039a0b3e5","name":"李娜","emai…  （4415 字符）
    ⏺ api_get_orders({"user_id":"usr_6ca79c1e-4b7a-8f2d-d73ba0b3e5"})
    ✔ [{"id":"ord_fdb5cb31-98ad","number":"ORD-1042","user_id":"us…  （3038 字符）
    ⏺ api_post_refunds({"order_id":"ord_fdb5cb31-98ad","amount":899,"reason":"耳机有问题"})
    ✘ HTTP 422 Unprocessable Entity  （297 字符）
    ⏺ api_post_refunds({"order_id":"ord_fdb5cb31-98ad","amount":899,"reason":"defective"})
    ✘ HTTP 422 Unprocessable Entity  （297 字符）
    ⏺ api_post_refunds({"order_id":"ord_fdb5cb31-98ad","amount":899,"reason":"damaged"})
    ✔ {"id":"rfd_1042_1","order_id":"ord_fdb5cb31-98ad","amount_ce…  （143 字符）
    ⏺ 已为张伟的耳机订单提交退款，金额 899。
    [后端记录] ORD-1042 实付 ¥899.00，实际退了 ¥8.99

    —— 好工具集：按任务设计 ——
    ❯ 张伟说上个月底买的耳机有问题，帮他退款。
    ⏺ webapp_find_orders({"customer":"张伟","query":"耳机"})
    ✔ 张伟（user03@example.com）的订单，匹配「耳机」，共 2 笔，按下单时间倒序：  （149 字符）
    ⏺ webapp_refund_order({"order_number":"1042","reason":"damaged"})
    ✘ 参数有误，这次没有执行：  （131 字符）
    ⏺ webapp_refund_order({"order_number":"ORD-1042","reason":"damaged"})
    ✔ 已提交退款：ORD-1042 · 降噪耳机 Pro · 退 ¥899.00（全额）· 原因 damaged。预计 3–5…  （70 字符）
    ⏺ 已为张伟的降噪耳机 Pro（ORD-1042）提交全额退款 ¥899.00，3–5 个工作日原路退回。

    —— 对比（离线 fake 模型；轨迹是剧本，字符数是实算）——
    指标 | 坏工具集 | 好工具集
    模型调用 | 6 | 4
    工具调用（其中报错） | 5（2） | 3（1）
    工具定义，每次请求都带 | 502 字符 ≈126 tok | 1401 字符 ≈598 tok
    工具结果合计 | 8190 字符 ≈2288 tok | 350 字符 ≈198 tok
    各次请求累计发送 | 38867 字符 ≈10832 tok | 6383 字符 ≈2823 tok
    ```

=== "Python"

    ```text
    $ cd code/agent && uv run python -m tool_design.compare
    （输出与 Node 版逐字相同：两版用同一份数据和剧本，我用 diff 对过）
    ```

上面是离线 fake 模型的输出，后面还有三段（两条错误信息原文和一次截断演示），前文已经引用过。对比表里有三处值得看：

**第一，好工具集的定义反而更长。** 1401 字符对 502 字符，因为描述写得细。这笔开销是值得的：结果从 8190 字符降到 350 字符，累计发送量降到原来的约六分之一。工具定义写得精炼，和不写清楚，是两回事。

**第二，「退了 ¥8.99」是一个悄无声息的错误。** 坏工具集最后那次调用返回的是成功，模型也就报告「已退款」。参数名 `amount` 没写单位，这个问题在任何一次工具结果里都暴露不出来。好工具集用 `amount_yuan` 加上「全额不填」的约定，从接口设计上避开了这个坑。

**第三，好工具集也报了一次错。** 剧本里模型把订单号写成 `"1042"`，校验拦下后，错误信息直接告诉它正确的格式，下一次就改对了。好工具不是让模型永远不犯错，而是让它犯错后一步就能纠正。

token 那一列是粗估：ASCII 字符按 4 个算 1 token，中文按 1 个字算 1 token。只能用来比较量级。要精确数字，用 `client.messages.count_tokens(...)`（Node 版是 `countTokens`）让接口来算。

核心代码有三段。第一段是校验闸门：参数不合格就不执行，错误信息逐条写清怎么改。

=== "Node"

    ```ts
    export function checked(schema: Schema, fn: Handler): Handler {
      return (args) => {
        const problems = validate(schema, args);
        if (problems.length)
          throw new ToolError(
            formatToolError("参数有误，这次没有执行", problems, "按上面逐条改好再调；不确定订单号就先调 webapp_find_orders。"),
          );
        return fn(args);
      };
    }
    // validate() 产出的每一条都带「收到了什么、应该填什么」，例如：
    //   reason="耳机有问题" 不在可选值里，可选：damaged / not_as_described / no_longer_needed / other
    ```

=== "Python"

    ```python
    def checked(schema: dict[str, Any], fn: Callable[..., str]) -> Callable[..., str]:
        def run(**args: Any) -> str:
            problems = validate(schema, args)
            if problems:
                raise ToolError(format_tool_error("参数有误，这次没有执行", problems,
                                                  "按上面逐条改好再调；不确定订单号就先调 webapp_find_orders。"))
            return fn(**args)
        return run
    # validate() 产出的每一条都带「收到了什么、应该填什么」，例如：
    #   reason="耳机有问题" 不在可选值里，可选：damaged / not_as_described / no_longer_needed / other
    ```

第二段是退款工具的实现：模型只提供订单号和以元为单位的金额，内部 ID、单位换算、错误码翻译都在代码里完成。

=== "Node"

    ```ts
    const paid = order.payment.captured_cents;
    const cents = amount_yuan === undefined ? paid : Math.floor(amount_yuan * 100 + 0.5);
    try {
      backendRefund(order.id, cents, reason); // 模型只给订单号和元；内部 ID、分这些换算在代码里做
    } catch (e) {
      if (!(e instanceof BackendError)) throw e;
      if (e.code === "E_REFUND_4004")
        throw new ToolError(formatToolError(`${order_number} 不能自助退款`,
          [`已过退款期（截至 ${order.refundable_until}）`], "不要换参数重试。告诉用户这笔需要转人工客服处理。"));
      // 其余错误码翻译成改法；堆栈留给日志，不给模型
    }
    ```

=== "Python"

    ```python
    paid = order["payment"]["captured_cents"]
    cents = paid if amount_yuan is None else int(amount_yuan * 100 + 0.5)
    try:
        backend_refund(order["id"], cents, reason)  # 模型只给订单号和元；内部 ID、分这些换算在代码里做
    except BackendError as e:
        if e.code == "E_REFUND_4004":
            raise ToolError(format_tool_error(
                f"{order_number} 不能自助退款", [f"已过退款期（截至 {order['refundable_until']}）"],
                "不要换参数重试。告诉用户这笔需要转人工客服处理。")) from None
        # 其余错误码翻译成改法；堆栈留给日志，不给模型
    ```

第三段是通用的截断函数，可以挂在任何工具外面兜底：尽量按整行截断，末尾写明还剩多少、怎么继续拿。

=== "Node"

    ```ts
    export function truncateResult(text: string, maxChars: number, howToContinue: string): string {
      if (text.length <= maxChars) return text;
      const kept: string[] = [];
      let used = 0;
      for (const line of text.split("\n")) {
        const cost = line.length + (kept.length ? 1 : 0);
        if (used + cost > maxChars) break;
        kept.push(line);
        used += cost;
      }
      const shown = kept.length ? kept.join("\n") : text.slice(0, maxChars); // 第一行就超长时只能硬切
      return `${shown}\n…[结果已截断：只显示了前 ${shown.length} / ${text.length} 字符，` +
        `还剩 ${text.length - shown.length} 字符没给你看。${howToContinue}]`;
    }
    ```

=== "Python"

    ```python
    def truncate_result(text: str, max_chars: int, how_to_continue: str) -> str:
        if len(text) <= max_chars:
            return text
        kept: list[str] = []
        used = 0
        for line in text.split("\n"):
            cost = len(line) + (1 if kept else 0)
            if used + cost > max_chars:
                break
            kept.append(line)
            used += cost
        shown = "\n".join(kept) if kept else text[:max_chars]  # 第一行就超长时只能硬切
        return (f"{shown}\n…[结果已截断：只显示了前 {len(shown)} / {len(text)} 字符，"
                f"还剩 {len(text) - len(shown)} 字符没给你看。{how_to_continue}]")
    ```

测试锁住了这几件事：截断按整行切、提示里的数字正确；错误信息的格式；非法参数被拒绝且后端零副作用；后端错误码翻译成下一步，并且不带堆栈；concise / detailed / 翻页提示；两条轨迹的调用次数，以及坏工具集确实退成了 899 分。

=== "Node"

    ```text
    code/agent-node/tool_design/budget.ts            estimateTokens / measureTools / truncateResult
    code/agent-node/tool_design/toolsets.ts          假后端 + 坏工具集 + 好工具集 + validate / checked
    code/agent-node/tool_design/compare.ts           runAgent（带统计）+ 两份剧本
    code/agent-node/tool_design/tool_design.test.ts  13 个用例
    $ cd code/agent-node && node --test tool_design/tool_design.test.ts
    ℹ tests 13
    ℹ pass 13
    ```

=== "Python"

    ```text
    code/agent/tool_design/budget.py                 estimate_tokens / measure_tools / truncate_result
    code/agent/tool_design/toolsets.py               假后端 + 坏工具集 + 好工具集 + validate / checked
    code/agent/tool_design/compare.py                run_agent（带统计）+ 两份剧本
    code/agent/tool_design/test_tool_design.py       同样 13 个用例
    $ cd code/agent && uv run pytest -q tool_design
    13 passed
    ```

## 怎么判断工具设计得好不好

前面这些原则都只是假设，要用评测来验证。思路和 [Agent 评测实践指南](../p3-agent-internals/14-agent-eval-guide.md)一样：准备一组贴近真实使用的任务，每条跑多次，看最终状态和调用轨迹。评测方法论那一章已经讲透了，这里只列针对工具的几个指标：

| 指标 | 怎么算 | 出问题时通常意味着 |
|---|---|---|
| 工具选错率 | 调了不该调的，或该调的没调 | 名字或描述有歧义、工具职责重叠 |
| 参数错误率 | `is_error` 里属于参数校验失败的比例 | 描述没写清格式，或者缺少例子 |
| 每个任务的调用次数 | 完成一条任务一共调了几次工具 | 粒度太细，或者缺少分页 / 过滤参数 |
| 每个任务的 token | 工具定义 + 工具结果 + 输出 | 返回值太啰嗦，或者工具太多 |
| 任务成功率 | 最终状态对不对（钱退了没有、退了多少） | 以上问题的总和 |

Anthropic 的文章里有两条观察和这张表对得上：大量重复调用，往往说明需要加分页或调整结果大小的上限；大量参数错误，往往说明描述不够清楚。他们还有一个很实用的做法：把评测的完整对话记录贴给 Claude Code，让它对照着改工具描述，再用留出的测试集确认没有过拟合。

改描述就是改行为，所以和改 prompt 一样要跑评测才能上线。本章的剧本测试只能锁住「代码按设计工作」，锁不住「模型会不会照描述做」。

## 对照你的环境

- **你的 40 多个 skill，description 就是工具描述。** Claude Code 常驻的只有每个 skill 的 description，模型靠它决定加载哪个 skill。本章「描述要回答五个问题」同样适用：写清什么时候用、什么时候不用，比写清它能做什么更重要。
- **你在 [动手开发 MCP 工具](./10-mcp-tool.md) 里写的 `search_notes` / `read_note`。** 可以按本章的标准检查一遍：有没有命名空间前缀？`search_notes` 搜不到时，有没有提示换关键词？`read_note` 的文件太长时，有没有截断，并告诉模型怎么读后面的部分？
- **你的 PreToolUse hook 就是「硬约束写进代码」。** 工具描述里写「别碰生产环境」是软约束，hook 按 `mcp__deploy__rollback` 这样的工具名拦下来才是硬约束。
- **Claude Code 的 MCP 工具搜索默认开启。** 你挂了 Linear、Notion、chrome-devtools 等好几个 server，平时并不会每轮都付全部工具定义的 token。如果想看预先加载会怎样，可以用 `ENABLE_TOOL_SEARCH=false claude` 启动一次，对比 `/context` 里的工具占用。

## 回到开头的问题

接口都是对的，Agent 为什么还是绕了三圈、退错了钱？因为那组接口是给人写的：要先拿用户 ID 再查订单，金额单位没写在参数名上，出错只回一个错误码加堆栈。人可以查文档、能看到这些上下文，模型看不到。

换成按任务设计的两个工具后，模型要读的字从 8 千多降到 350，参数写错时一句话就能纠正，单位错误从接口设计上就不可能发生。

**回到主线**：工具设计就是决定往上下文里放什么字。名字、描述、schema 决定模型能不能选对；返回值决定它下一步看到什么、要为多少 token 付费；错误信息决定它出错后能不能一步改对。字放对了，模型在有限的上下文里就能把事做对，而且花的 token 更少。

## 常见坑

- **把后端接口一比一包装成工具。** 中间结果全部经过模型，多推理好几轮，还要额外保存一堆它用不上的 ID。先问「模型要完成什么任务」，再决定工具的边界。
- **参数名不带单位和格式。** `amount`、`date`、`id` 这类名字最容易出现悄无声息的错误：调用成功了，但意思错了。用 `amount_yuan`、`date_iso`、`order_number`，并在描述里给例子。
- **原样返回后端的大 JSON 或堆栈。** 每一个字都会留在历史里，之后每轮重复发送。工具负责把结果翻译成模型能直接用的文字，堆栈写进日志。
- **截断了却不告诉模型。** 模型会把看到的部分当成全部，直接得出错误结论。截断时要写明还剩多少、用什么参数继续拿。
- **只在描述里写规则，代码不拦。** 「必须先查订单号」「过期不能退」这类规则，要在执行副作用之前用代码检查。strict 模式只保证参数符合 schema，保证不了业务规则。

## 练习

**1.** 给 `webapp_find_orders` 加一个 `status` 过滤参数（可选值 `refundable` / `all`，默认 `all`）。传 `refundable` 时只列出还能退款的订单。要求非法取值时，错误信息能列出可选值。

<details>
<summary>提示</summary>

两处改动：`FIND_ORDERS_SCHEMA` 加一个带 `enum` 的属性，`findOrders` / `find_orders` 里按 `TODAY <= refundable_until` 过滤。`validate` 已经支持 `enum`，非法取值的错误信息不用另写。测试可以写两条：`status="refundable"` 时只出现 `ORD-1042`；`status="open"` 时抛出 `ToolError`，消息里包含「可选：refundable / all」。还要检查 `additionalProperties: false` 是否依然生效：传一个拼错的 `stauts` 应该被拒绝。

</details>

**2.** 坏工具集里 `amount` 没写单位，导致退了 ¥8.99。不改模型剧本，只改工具，让这个错误要么被拦下，要么根本不可能发生。至少给出两种方案，并说明各自的取舍。

<details>
<summary>提示</summary>

方案 A：保留 `amount`，在描述和参数描述里写清「单位：分，例如 ¥899 填 89900」。这仍然是软约束，模型照做的概率提高了，但不能保证。方案 B：改名为 `amount_yuan`，在代码里换算成分，这就是好工具集的做法，从接口上消除了歧义。方案 C：加一道代码闸门，部分退款金额低于实付金额的 5% 时拒绝，并提示「看起来像把元当成了分，请确认」。这能拦住一部分错误，但会误伤真实的小额部分退款。可以写一条测试：用剧本的第 3 步参数调用，断言要么报错，要么退款金额是 89900。

</details>

**3.** 开放题：挑一个你常用的 MCP server（比如 Linear 或 Notion），用 `/mcp` 或 `/context` 看它暴露了多少个工具、占了多少上下文。如果你来重新设计，会合并哪些、拆开哪些、改哪些名字？怎么证明改完更好？

<details>
<summary>提示</summary>

先列出最常做的 5 件事（比如「查我名下的 issue」「把 issue 改成待验证」「加一条评论」），看每件事要调几个工具、中间要不要搬运 ID。然后用本章的三条标准判断合还是拆：中间结果需不需要模型做判断、有没有副作用、合并后参数会不会膨胀。验证不能凭感觉：把这 5 件事写成评测任务，每条跑几次，对比改造前后的调用次数、参数错误率和 token，方法见 [Agent 评测实践指南](../p3-agent-internals/14-agent-eval-guide.md)。别人的 server 改不了源码，可以自己写一个薄封装的 MCP server 做对照。

</details>

## 延伸阅读

- [Anthropic：Writing effective tools for agents — with agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Claude 文档：Tool use 概览](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview) · [定义工具](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) · [处理工具调用](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
- [Claude 文档：Strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use)
- [Claude 文档：Tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- [Claude Code 文档：MCP（工具搜索与输出上限）](https://code.claude.com/docs/en/mcp)
- 本库：[动手实现一个 Coding Agent](./02-coding-agent.md) · [动手开发 MCP 工具](./10-mcp-tool.md) · [Skills](../p1-tools/12-skills.md) · [Agent 构建指南](../p3-agent-internals/13-agent-build-guide.md) · [Agent 评测实践指南](../p3-agent-internals/14-agent-eval-guide.md)
- 本库：上一章 [拆解 MCP 通信协议](./11-mcp-protocol.md)
- 下一部分：[第 3 部分 · 工业级 Agent](../p3-agent-internals/01-http-analyzer.md)，带着自己写过的零件，去抓包拆 Claude Code
