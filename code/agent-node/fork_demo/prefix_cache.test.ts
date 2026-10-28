import assert from "node:assert/strict";
import { test } from "node:test";

import * as prefixCache from "./prefix_cache.ts";

test("fork 命中缓存，几种变体都失效", () => {
  const rows = Object.fromEntries(prefixCache.run());
  assert.equal(rows["主会话第 N 轮（预热）"].cache_read, 0);
  const fork = rows["Fork：同 tools/system/历史 + 追加任务"];
  assert.ok(fork.cache_read / fork.total > 0.99);
  assert.equal(rows["Fork 但删掉 Bash 工具定义"].cache_read, 0); // tools 在最前，改了全挂
  const sysChanged = rows["Fork 但改了 system prompt"];
  assert.ok(sysChanged.cache_read < sysChanged.total * 0.01); // 只剩 tools 那一小段
  assert.equal(rows["全新 Sub Agent（自己的 system+tools，空历史）"].cache_read, 0);
});
