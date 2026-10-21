# mem0 记忆库的实现思路

> 对应原站：[mem0 记忆库的实现思路](https://labuladong.online/zh/ai-coding/basics/mem0-memory/)（会员内容；本章为独立原创重写）

> **一句话结论**：mem0 是一个「会自己往里写的 RAG」：用 LLM 从对话里抽出一条条短事实，编码成向量存起来，用的时候按语义检索。它最有意思的地方是「新事实来了，旧事实怎么办」：v1 让 LLM 判 ADD / UPDATE / DELETE / NONE，当前的 v3 改成了只追加、靠检索排序，这次转向本身就是一堂设计课。

## 如果你要给自己的 Agent 加记忆

前两章拆的 Claude Code 和 Codex，记忆都是产品自带的，你拿不出来用。

假如你要给 webapp 的某个 AI 功能加「记住用户偏好」，比如用户说过「总结要用要点列表」「别用英文术语」，下次自动遵守。你会怎么做？

最直接的想法是把所有历史对话存下来，每次检索相关的几段塞进 prompt。这就是 [RAG](../p2-agent-basics/04-rag-principles.md)。

你可能会问：这不就够了吗？

不够。原始对话很啰嗦，「我其实更喜欢……嗯，算了，还是用列表吧」，检索出来一大段，真正有用的只有半句。更麻烦的是，用户的偏好会**变**：上个月说喜欢 Vim，这个月说改用 VS Code 了。两段对话都在库里，检索时两条都捞出来，模型该信哪个？

mem0 要解决的就是这两件事：**把对话提炼成短事实**，以及**处理事实之间的冲突**。

下面的代码和行为来自 `mem0ai/mem0` 仓库。为了讲清楚演进，我读了两个版本：v1 的最后一个发布 `v1.0.11`（2026-04-06）和当前 main（commit `2c81af3`，2026-10-20，包版本 2.2.1）。

## v1：两次 LLM 调用的流水线

v1 的 `Memory.add()`（`mem0/memory/main.py` 的 `_add_to_vector_store`）是一个很工整的四步流水线：

```mermaid
flowchart LR
    A[对话 messages] -->|LLM 调用 1：事实抽取| B["{'facts': ['叫小李', '喜欢用 Vim']}"]
    B -->|每条事实单独 embed| C[向量库检索：每条事实取 top 5 旧记忆]
    C --> D[UUID 换成 0,1,2... 临时编号]
    D -->|LLM 调用 2：对比新旧| E["[{id, text, event: ADD/UPDATE/DELETE/NONE}]"]
    E --> F[按 event 写向量库 + 写 SQLite history 表]
```

**第一步，抽事实。** 提示词让模型输出 `{"facts": [...]}`，few-shot 例子大概长这样：`{"facts" : ["Name is John", "Is a Software engineer"]}`。用户侧和 Agent 侧各有一套提示词（`USER_MEMORY_EXTRACTION_PROMPT` / `AGENT_MEMORY_EXTRACTION_PROMPT`），在 `mem0/configs/prompts.py`。

**第二步，找相关的旧记忆。** 每条新事实单独做 embedding，到向量库里按 `user_id / agent_id / run_id` 过滤，取最相似的 5 条，合并去重。

**第三步，一个防幻觉的小技巧。** 旧记忆的 id 是 UUID，又长又随机。直接给模型看，它在输出里抄 id 时很容易抄错一两位，然后你就会去 UPDATE 一条不存在的记忆。v1 的做法是：

```python
# mapping UUIDs with integers for handling UUID hallucinations
temp_uuid_mapping[str(idx)] = item["id"]
retrieved_old_memory[idx]["id"] = str(idx)
```

给模型看的是 0、1、2，模型输出的也是 0、1、2，程序再映射回真 UUID。这个技巧非常值得偷：**凡是要让模型引用一个程序里的 id，都给它一个短的临时编号。**

**第四步，让 LLM 当裁判。** `DEFAULT_UPDATE_MEMORY_PROMPT` 给模型四个选项：ADD 新增、UPDATE 修改、DELETE 删除、NONE 不动。输出形如 `{"memory": [{"id", "text", "event", "old_memory"}]}`，程序按 event 分派执行。每次变更都写进 SQLite 的 `history` 表（`mem0/memory/storage.py`），所以一条记忆被改过几次、每次改成什么都查得到。

打个比方，这像一个认真的档案管理员：每收到一份新材料，先摘要，再翻出旧档案里相关的几页，逐条判断是新增、修订还是作废。

## 动手：复刻 v1 流水线

下面用玩具 embedding（字符二元组词袋）和规则代替两次 LLM 调用，结构和 v1 一致：

```python
import hashlib, itertools, math
from collections import Counter

def embed(text):                                  # 玩具 embedding：字符二元组词袋
    return Counter(text[i:i + 2] for i in range(len(text) - 1))

def cos(a, b):
    dot = sum(a[k] * b[k] for k in a)
    return dot / (math.sqrt(sum(v * v for v in a.values())) * math.sqrt(sum(v * v for v in b.values())) or 1)

_ids = itertools.count(1)

class VectorStore:
    def __init__(self): self.rows = {}            # id -> {data, vec, user_id, hash}
    def search(self, q, user_id, limit=5):
        hits = [(cos(embed(q), r["vec"]), i) for i, r in self.rows.items() if r["user_id"] == user_id]
        return [{"id": i, "text": self.rows[i]["data"]} for s, i in sorted(hits, reverse=True)[:limit] if s > 0.2]

def fake_extract_facts(messages):                # 第 1 次 LLM 调用：对话 -> {"facts": [...]}
    return {"facts": [s.strip() for m in messages if m["role"] == "user"
                      for s in m["content"].replace("，", "。").split("。") if s.strip()]}

def fake_decide(old, facts):                     # 第 2 次 LLM 调用：旧记忆 + 新事实 -> ADD/UPDATE/DELETE/NONE
    out = []
    for f in facts:
        same = next((o for o in old if o["text"] == f), None)
        rel = next((o for o in old if cos(embed(o["text"]), embed(f)) > 0.6), None)  # 玩具规则：很像 = 同一主题
        if same:   out.append({"id": same["id"], "text": f, "event": "NONE"})
        elif rel and "不" in f and "不" not in rel["text"]:
            out.append({"id": rel["id"], "text": f, "event": "UPDATE", "old_memory": rel["text"]})
        else:      out.append({"id": "new", "text": f, "event": "ADD"})
    return {"memory": out}

def add_v1(store, history, messages, user_id):
    facts = fake_extract_facts(messages)["facts"]
    old = {}
    for f in facts:
        for m in store.search(f, user_id):
            old[m["id"]] = m
    temp = {str(i): real for i, real in enumerate(old)}                # UUID -> 0,1,2… 防止模型编造 id
    shown = [{"id": str(i), "text": old[real]["text"]} for i, real in enumerate(old)]
    for act in fake_decide(shown, facts)["memory"]:
        ev = act["event"]
        if ev == "ADD":
            mid = f"mem-{next(_ids):04d}-9f3c"            # 真实是 uuid4
            store.rows[mid] = {"data": act["text"], "vec": embed(act["text"]), "user_id": user_id,
                               "hash": hashlib.md5(act["text"].encode()).hexdigest()}
            history.append((mid, None, act["text"], "ADD"))
        elif ev == "UPDATE":
            mid = temp[act["id"]]
            history.append((mid, store.rows[mid]["data"], act["text"], "UPDATE"))
            store.rows[mid].update(data=act["text"], vec=embed(act["text"]))
        print(f"  {ev:<6} {act['text']}")

store, history = VectorStore(), []
print("turn 1"); add_v1(store, history, [{"role": "user", "content": "我叫小李，我喜欢用 Vim 写代码。"}], "u1")
print("turn 2"); add_v1(store, history, [{"role": "user", "content": "我叫小李。我现在不喜欢用 Vim 写代码了，改用 VS Code。"}], "u1")
print("search('用什么写代码'):", [m['text'] for m in store.search('用什么写代码', 'u1')])
print("history:"); [print("  ", h) for h in history]
```

```text
❯ uv run python mem0_v1_demo.py
turn 1
  ADD    我叫小李
  ADD    我喜欢用 Vim 写代码
turn 2
  NONE   我叫小李
  UPDATE 我现在不喜欢用 Vim 写代码了
  ADD    改用 VS Code
search('用什么写代码'): ['我现在不喜欢用 Vim 写代码了']
history:
   ('mem-0001-9f3c', None, '我叫小李', 'ADD')
   ('mem-0002-9f3c', None, '我喜欢用 Vim 写代码', 'ADD')
   ('mem-0002-9f3c', '我喜欢用 Vim 写代码', '我现在不喜欢用 Vim 写代码了', 'UPDATE')
   ('mem-0003-9f3c', None, '改用 VS Code', 'ADD')
```

（离线 fake 模型：事实抽取按句号切分，裁判用相似度规则。）

第二轮里，「我叫小李」和旧记忆一模一样，判 NONE；「不喜欢 Vim」和旧的「喜欢 Vim」很像但意思相反，判 UPDATE，history 表里留下了改前改后两个版本。

但你也看到一个问题：检索「用什么写代码」只捞回来「不喜欢 Vim」那条，「改用 VS Code」没捞到。因为抽事实时把一句话拆成了两条，两条之间的关联（「不用 Vim 了，**所以**改用 VS Code」）丢了。我的玩具 embedding 很弱，放大了这个问题，但真实系统里同样存在：**事实被拆得越碎，关系丢得越多。** 下一章的 Zep 就是冲着这一点去的。

## v3：不再让 LLM 当裁判

当前 main 的 `_add_to_vector_store` 里标着 `# === V3 PHASED BATCH PIPELINE ===`。v2.0.0（2026-04-14）的更新日志写的是「V3 memory pipeline, ADD-only extraction」，迁移文档也明说了：记忆条数会随时间增长而不是被合并，**由检索负责相关性排序**。

变化有这么几处：

- **一次 LLM 调用**：整段消息只做一次 embedding、检索 top 10 旧记忆，然后一次调用 `ADDITIVE_EXTRACTION_PROMPT`，开头就是「Your sole operation is ADD」。旧记忆只用来**去重和关联**，不再被修改或删除。
- **整数编号保留了**：注释写着「Map UUIDs to integers (anti-hallucination)」。好技巧不会被扔掉。
- **哈希去重**：新记忆算 MD5，和检索到的旧记忆、同批的其他新记忆比，一样就跳过。
- **实体链接改用 spaCy**：不再调 LLM 抽实体，用 `en_core_web_sm` 抽专有名词、话题等，存进一个单独的实体集合。
- **检索变成混合打分**：语义相似度 + BM25 关键词 + 实体加权，`score_and_rank` 合成一个分数。默认 `top_k=20`、`threshold=0.1`、`rerank=False`。
- **图记忆被移除**：v1 里基于 Neo4j 的 `graph_memory.py` 在 v2.0.0 被整体删掉了，开源版里由上面的实体集合替代，图能力挪到了托管平台。

你可能会问：让 LLM 判断「更新还是删除」不是更聪明吗？为什么要退回到只追加？

我的理解是三个原因：

1. **LLM 裁判会犯不可逆的错**。判错一次 DELETE，那条记忆就没了。只追加最多是多存了一条，可以靠检索排序和过期时间压下去。
2. **少一次 LLM 调用**。v1 每次 add 要两次调用，v3 只要一次，延迟和成本都直接减半。
3. **「冲突」其实是检索问题**。旧的「喜欢 Vim」和新的「不喜欢 Vim」都留着，检索时带上时间、按相关性排，模型自己能看出哪个是新的。

迁移文档里给了一组项目方自己的评测数字（LoCoMo、LongMemEval 都大幅提升），我没有复现，只能说项目方是这么报告的。

说实话，我觉得 v3 的方向是对的：**把「判断」从写入时挪到读取时**。写入时你不知道将来会怎么用，读取时有了具体问题，判断更准。这和上一章 Codex「写便条、等合并」的思路有异曲同工之处：都在避免当场做不可逆的整理。

## 几个实用细节

- **作用域**：`user_id / agent_id / run_id` 三选一至少一个，`search()` 不带就报错。用户传进来的自由 metadata 里如果有这几个键会被剥掉，防止有人把记忆写进别人的作用域。
- **`infer=False`**：不调 LLM，每条非 system 消息原样存成一条记忆。适合你已经有结构化事实、只想用它的存储和检索。
- **默认组件**：LLM 是 OpenAI `gpt-5-mini`，embedding 是 `text-embedding-3-small`，向量库是本地 Qdrant（`/tmp/qdrant`），历史在 `~/.mem0/history.db`。全都能换。

回到主线：mem0 往上下文里放的是「检索出来的几条短事实」，而不是整段历史。它用写入时的一次 LLM 调用（提炼），换读取时更少、更准的 token。v1 到 v3 的转变，是把「整理记忆」的成本和风险从写入挪到了读取。

## 对照你的环境

- 你自己的 Claude Code 记忆是**一条一个文件 + 一行索引**，本质是一个没有向量的 mem0：提炼靠模型、检索靠模型读索引。条数少的时候这样最好用；上了几百条，靠肉眼一样的「读索引」就会漏，那时才值得上向量检索。
- 那个整数编号的技巧，你在写 webapp 的 AI 功能时可以直接用：让模型从列表里挑东西时，给它 `[0] [1] [2]`，别给它后端的长 id。

## 回到开头的问题

给自己的 Agent 加偏好记忆，mem0 的答案是：别存原始对话，存提炼过的短事实；冲突别急着在写入时解决，留着历史，让检索和模型在用的时候判断。v1 那套「LLM 当裁判」的流水线依然值得读懂，因为它把记忆的四种操作讲得最清楚。

## 常见坑

1. **把 UUID 直接给模型**：它会抄错。用临时整数编号。
2. **事实拆得太碎**：因果关系丢了，检索时只捞回一半。
3. **让 LLM 做不可逆操作**：DELETE 判错就找不回来。至少留 history，或者改成软删除 / 只追加。
4. **作用域没隔离**：多用户场景下检索不带 `user_id` 过滤，就会把别人的偏好捞出来。
5. **看了旧教程**：网上很多 mem0 讲解基于 v1 的 ADD/UPDATE/DELETE，和当前 main 已经不一样了。

## 练习

1. 把上面的玩具改成 v3 风格：去掉 `fake_decide`，所有事实都 ADD，但用 MD5 去重；检索时按「相似度 + 新近程度」排序。比较「用什么写代码」的检索结果。
2. 给玩具加一个 `infer=False` 模式：不抽事实，整句存。比较两种模式下存储条数和检索质量。
3. 开放题：v1 在写入时整理，v3 在读取时整理，Codex 在下次启动时批量整理。如果是一个客服机器人，每天上万用户，你选哪种？为什么？

## 延伸阅读

- mem0 源码：https://github.com/mem0ai/mem0（`mem0/memory/main.py`、`mem0/configs/prompts.py`、`mem0/utils/scoring.py`）
- v2 → v3 迁移说明：仓库内 `docs/migration/oss-v2-to-v3.mdx`
- mem0 论文：*Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory*，arXiv:2504.19413
- 本库：[上一章 Codex 自动记忆](07-auto-memory.md)、[下一章 Zep](09-zep-memory.md)、[RAG 原理](../p2-agent-basics/04-rag-principles.md)、[动手实现 RAG](../p2-agent-basics/03-rag-qa-bot.md)
