/**
 * 第 4 章：用普通数组从零走一遍「预测下一个 token」（Python 版用 numpy）。
 *
 * 1) 字符级 bigram：数数 → 概率分布 → temperature / top-k 采样 → 自回归生成
 * 2) 一个单头因果注意力：带 / 不带 KV cache 生成，结果逐位相同，但算 K/V 的乘加次数差一个数量级
 *
 * 离线运行： node core/next_token.ts
 */

type Vec = number[];
type Mat = number[][];

// 语料：一段 webapp 风格的 commit message（自己编的，够小，能手算）
export const CORPUS =
  "fix(webapp): 修复记录列表滚动卡顿\n" +
  "fix(webapp): 修复登录页按钮错位\n" +
  "feat(webapp): 新增记录列表导出进度条\n" +
  "feat(webapp): 新增会员额度提示\n" +
  "fix(webapp): 修复导出进度条闪烁\n" +
  "refactor(webapp): 拆分记录列表组件\n";

// ---------------- 0. 几个 numpy 的替身 ----------------

/** 可复现的随机数（mulberry32）。和 numpy 的 default_rng 不是同一个算法，所以同一个 seed 采样结果和 Python 版不同。 */
export function makeRng(seed: number) {
  let s = seed >>> 0;
  const random = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Box-Muller：两个均匀分布 → 一个正态分布
  const normal = (mean: number, std: number) => mean + std * Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  /** 按概率 p 抽一个下标（同 numpy 的 rng.choice(len(p), p=p)：累积分布上找第一个 > u 的位置）。 */
  const choice = (p: Vec) => {
    const u = random() * p.reduce((a, b) => a + b, 0);
    let acc = 0;
    for (let i = 0; i < p.length; i++) if ((acc += p[i]) > u) return i;
    return p.length - 1;
  };
  return { random, normal, choice };
}

const argmax = (x: Vec) => x.reduce((best, v, i) => (v > x[best] ? i : best), 0); // 并列时取第一个，同 np.argmax
/** 从大到小排序后的下标；JS 的 sort 是稳定的，并列时按词表顺序。 */
export const argsortDesc = (x: Vec) => x.map((_, i) => i).sort((a, b) => x[b] - x[a]);
const matmul = (a: Mat, b: Mat): Mat => a.map((row) => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));
const vecmat = (v: Vec, m: Mat): Vec => matmul([v], m)[0];

// ---------------- 1. bigram：最朴素的「下一个 token 预测器」 ----------------
export function buildVocab(text: string): [string[], Record<string, number>] {
  const itos = [...new Set(text)].sort(); // 按 UTF-16 码元排序；语料里都是 BMP 字符，和 Python 的 sorted 结果一致
  return [itos, Object.fromEntries(itos.map((c, i) => [c, i]))];
}

export function bigramCounts(text: string, stoi: Record<string, number>): Mat {
  const V = Object.keys(stoi).length;
  const counts: Mat = Array.from({ length: V }, () => new Array(V).fill(0));
  const chars = [...text];
  for (let i = 0; i + 1 < chars.length; i++) counts[stoi[chars[i]]][stoi[chars[i + 1]]] += 1;
  return counts;
}

/** log(计数 + 平滑) 当作 logits：数越多分越高。alpha 让没见过的组合也有一点点概率。 */
export function logitsFromCounts(counts: Mat, alpha = 0.01): Mat {
  return counts.map((row) => row.map((c) => Math.log(c + alpha)));
}

export function softmax(x: Vec): Vec {
  const max = Math.max(...x);
  const e = x.map((v) => Math.exp(v - max)); // 减最大值防溢出，不改变结果
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
}

export function nextTokenProbs(logitsRow: Vec, temperature = 1.0, topK?: number): Vec {
  if (temperature === 0) {
    // 约定：T=0 就是贪心，直接取最大
    const p = new Array(logitsRow.length).fill(0);
    p[argmax(logitsRow)] = 1.0;
    return p;
  }
  let x = logitsRow.map((v) => v / temperature);
  if (topK !== undefined && topK < x.length) {
    const keep = new Set(argsortDesc(x).slice(0, topK)); // 只留前 k 名（并列时按词表顺序取），其余概率置 0
    x = x.map((v, i) => (keep.has(i) ? v : -Infinity));
  }
  return softmax(x);
}

export function generate(
  prompt: string,
  logits: Mat,
  itos: string[],
  stoi: Record<string, number>,
  n: number,
  { temperature = 1.0, topK, seed = 0 }: { temperature?: number; topK?: number; seed?: number } = {},
): string {
  const rng = makeRng(seed);
  const out = [...prompt];
  for (let i = 0; i < n; i++) {
    // 自回归：每生成一个就拼回去，再用它预测下一个
    const p = nextTokenProbs(logits[stoi[out.at(-1)!]], temperature, topK);
    const nxt = itos[rng.choice(p)];
    out.push(nxt);
    if (nxt === "\n") break;
  }
  return out.join("");
}

// ---------------- 2. 单头因果注意力 + KV cache ----------------
/** 一层、单头、随机权重的因果自注意力。只为对比计算量，不为生成好句子。 */
export class TinyAttention {
  d: number;
  emb: Mat;
  Wq: Mat;
  Wk: Mat;
  Wv: Mat;
  Wout: Mat;
  kvMacs = 0; // 计 K/V 投影的乘加次数：每个位置 2 × d × d

  constructor(vocab: number, d = 32, seed = 0) {
    const rng = makeRng(seed);
    const randn = (rows: number, cols: number, std: number): Mat =>
      Array.from({ length: rows }, () => Array.from({ length: cols }, () => rng.normal(0, std)));
    this.d = d;
    this.emb = randn(vocab, d, 1);
    [this.Wq, this.Wk, this.Wv] = [0, 1, 2].map(() => randn(d, d, d ** -0.5));
    this.Wout = randn(d, vocab, d ** -0.5);
  }

  private kv(x: Mat): [Mat, Mat] {
    this.kvMacs += 2 * x.length * this.d * this.d;
    return [matmul(x, this.Wk), matmul(x, this.Wv)];
  }

  private logitsLast(q: Vec, K: Mat, V: Mat): Vec {
    const att = softmax(K.map((k) => k.reduce((s, v, i) => s + v * q[i], 0) / Math.sqrt(this.d))); // 最后一个位置只看自己和前文 → 天然因果
    return vecmat(vecmat(att, V), this.Wout);
  }

  generate(ids: number[], n: number, useCache: boolean): number[] {
    ids = [...ids];
    let K: Mat | null = null;
    let V: Mat | null = null;
    for (let step = 0; step < n; step++) {
      if (!useCache || K === null) {
        const x = ids.map((i) => this.emb[i]); // 不用缓存：每步把整段重新投影一遍
        [K, V] = this.kv(x); //                    用缓存时，这里只在第一步执行 = prefill
      } else {
        const xNew = [this.emb[ids.at(-1)!]]; //   用缓存：只投影新来的那个 token = decode
        const [k, v] = this.kv(xNew);
        [K, V] = [[...K, ...k], [...V!, ...v]];
      }
      const q = vecmat(this.emb[ids.at(-1)!], this.Wq);
      ids.push(argmax(this.logitsLast(q, K, V!)));
      if (!useCache) K = V = null;
    }
    return ids;
  }
}

/** 解析式：生成 newTokens 个 token 时，K/V 投影一共做多少次乘加。 */
export function kvMacs(promptLen: number, newTokens: number, d: number, useCache: boolean): number {
  const perPos = 2 * d * d;
  if (useCache) return perPos * (promptLen + newTokens - 1);
  let sum = 0;
  for (let i = 0; i < newTokens; i++) sum += promptLen + i;
  return perPos * sum;
}

function bar(x: number, xmax: number, width = 40): string {
  return "█".repeat(Math.max(1, Math.round((width * x) / xmax)));
}

// ---------- 打印用的小工具（对应 Python 的 f-string 格式说明符） ----------
const comma = (n: number) => n.toLocaleString("en-US"); // {:,}
const sci = (n: number) => n.toExponential(2).replace(/e([+-])(\d)$/, "e$10$2"); // {:.2e}，指数补成两位
const pct = (x: number) => `${(x * 100).toFixed(1)}%`; // {:.1%}
const show = (c: string) => JSON.stringify(c); // 字符的可见形式，"\n" 显示成 "\n"

function main(): void {
  const [itos, stoi] = buildVocab(CORPUS);
  const counts = bigramCounts(CORPUS, stoi);
  const logits = logitsFromCounts(counts);
  console.log(`词表大小 V=${itos.length}（字符级），bigram 计数矩阵 (${counts.length}, ${counts[0].length})，语料 ${[...CORPUS].length} 个字符\n`);

  for (const ctx of ["修", "录"]) {
    const row = counts[stoi[ctx]];
    const seen = argsortDesc(row).slice(0, 4).filter((i) => row[i]);
    console.log(`「${ctx}」后面出现过：` + seen.map((i) => `${show(itos[i])}×${row[i]}`).join("  "));
    for (const [T, k] of [[0, undefined], [0.5, undefined], [1.0, undefined], [1.5, undefined], [1.0, 2]] as const) {
      const p = nextTokenProbs(logits[stoi[ctx]], T, k);
      const top = argsortDesc(p).slice(0, 3);
      const desc = top.map((i) => `${show(itos[i])}:${p[i].toFixed(3)}`).join("  ");
      const rest = 1 - top.reduce((s, i) => s + p[i], 0);
      console.log(`  T=${String(T).padEnd(3)} topK=${String(k ?? "-").padEnd(4)}  ${desc}   （其余 ${Math.abs(rest).toFixed(3)}）`);
    }
    console.log();
  }

  console.log(`自回归生成（prompt="fix(webapp): "，每行一个随机种子）：`);
  for (const [T, k] of [[0, undefined], [0.7, 3], [1.5, undefined]] as const) {
    for (const seed of [1, 2]) {
      const s = generate("fix(webapp): ", logits, itos, stoi, 20, { temperature: T, topK: k, seed }).replace(/\n$/, "");
      console.log(`  T=${String(T).padEnd(3)} topK=${String(k ?? "-").padEnd(4)} seed=${seed}  ${s}`);
    }
  }
  console.log();

  const model = new TinyAttention(itos.length, 32);
  const promptIds = [...CORPUS].slice(0, 40).map((c) => stoi[c]);
  model.kvMacs = 0;
  const a = model.generate(promptIds, 20, false);
  const macsNocache = model.kvMacs;
  model.kvMacs = 0;
  const b = model.generate(promptIds, 20, true);
  const macsCache = model.kvMacs;
  console.log(`TinyAttention(d=32)：prompt 40 个 token，生成 20 个`);
  console.log(`  两种方式生成的 token 完全一致：${JSON.stringify(a) === JSON.stringify(b)}`);
  console.log(`  K/V 投影乘加次数：不用缓存 ${comma(macsNocache)}  用缓存 ${comma(macsCache)}（实测计数）`);
  console.log(`  与解析式一致：${macsNocache === kvMacs(40, 20, 32, false) && macsCache === kvMacs(40, 20, 32, true)}\n`);

  console.log("同一次请求内（KV cache）：d=4096，生成 200 个 token，K/V 投影乘加次数");
  for (const P of [1_000, 10_000, 100_000]) {
    const [nc, c] = [kvMacs(P, 200, 4096, false), kvMacs(P, 200, 4096, true)];
    console.log(`  P=${comma(P).padStart(7)}  无缓存 ${sci(nc)} ${bar(nc, nc)}`);
    console.log(`  ${"".padEnd(9)}  有缓存 ${sci(c)} ${bar(c, nc)}  省 ${comma(Math.round(nc / c))} 倍`);
  }
  console.log();
  console.log("跨请求（Prompt Cache）：第 2 轮请求复用前缀 P，只追加 Δ=2,000 个新 token，prefill 要投影的位置数");
  for (const P of [10_000, 100_000, 500_000]) {
    const [full, delta] = [P + 2_000, 2_000];
    console.log(`  前缀 P=${comma(P).padStart(7)}  不命中 ${comma(full).padStart(8)} ${bar(full, full)}`);
    console.log(`  ${"".padEnd(15)}  命中   ${comma(delta).padStart(8)} ${bar(delta, full)}  只算 ${pct(delta / full)}`);
  }
}

if (import.meta.main) main();
