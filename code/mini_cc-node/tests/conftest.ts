/**
 * 测试公共件（对应 Python 版 tests/conftest.py 的 fixture）。
 *
 * node:test 没有 fixture，每个测试文件这样用：
 *     let settings: Settings;
 *     beforeEach(() => (settings = makeSettings()));
 *     afterEach(cleanupTmp);
 *     const { app, client } = makeApp(settings, [say("hi")]);
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../mini_cc/cli.ts";
import { Settings } from "../mini_cc/config.ts";
import { type Block, FakeClient, type ModelClient, type Script } from "../mini_cc/model.ts";
import { BufferUI } from "../mini_cc/ui.ts";

const created: string[] = [];

/** 一个新的临时目录（已 realpath：macOS 的 /var → /private/var，和代码里 realResolve 的结果对得上）。 */
export function tmpPath(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "mini-cc-test-")));
  created.push(d);
  return d;
}

export function cleanupTmp(): void {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** tmp 下的项目目录和 home（同 Python 的 settings fixture）。 */
export function makeSettings(): Settings {
  const root = tmpPath();
  const proj = join(root, "proj");
  mkdirSync(proj);
  return new Settings({ cwd: proj, home: join(root, "home") });
}

/** 同 Python 的 make_app(*script, reviewer_client=None)：返回 App 和它的 FakeClient；UI 是 BufferUI。 */
export function makeApp(settings: Settings, script: Script[] = [], kw: { reviewerClient?: ModelClient } = {}): { app: App; client: FakeClient; ui: BufferUI } {
  const client = new FakeClient(script);
  const ui = new BufferUI();
  const app = new App(settings, client, { ui, ...kw });
  return { app, client, ui };
}

/** 把一个异步生成器收集成数组（Python 里的 list(gen)）。 */
export async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

const SESSION_CONTEXT = ["# Project instructions", "# Current date"];

/**
 * 去掉第 9 章自动注入的会话级上下文（项目说明、日期），方便早期章节的测试只关注自己的内容。
 * 剩下只有一个纯文本块时直接返回字符串。
 */
export function withoutSessionContext(content: string | Block[]): string | Block[] {
  if (typeof content === "string") return content;
  const kept = content.filter((b) => !(b.type === "text" && b.text.startsWith("<system-reminder>") &&
    SESSION_CONTEXT.some((h) => b.text.includes(h))));
  if (kept.length === 1 && kept[0].type === "text") return kept[0].text;
  return kept;
}
