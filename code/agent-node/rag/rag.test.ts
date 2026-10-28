import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { DOCS, Index, answer, buildPrompt, chunkMarkdown } from "./rag.ts";
import { FakeAnthropic, text } from "../fake_llm/index.ts";

test("每块都带文档标题", () => {
  const chunks = chunkMarkdown(join(DOCS, "refund.md"));
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((c) => c.text.startsWith("【退款政策】")));
});

test("检索 top-1 命中正确文档", () => {
  const idx = Index.fromDir();
  const cases: Record<string, string> = {
    会员多少钱: "membership.md",
    能不能导出我的数据: "export.md",
    忘记密码怎么办: "account.md",
    蓝牙连不上: "device.md",
    可以退钱吗: "refund.md",
    支持日语吗: "recognition.md",
  };
  for (const [q, src] of Object.entries(cases)) {
    assert.ok(idx.search(q, 1)[0][1].source.startsWith(src), q);
  }
});

test("prompt 里只有 top-k 段资料", async () => {
  const idx = Index.fromDir();
  const client = new FakeAnthropic([text("39 元 [1]")]);
  const [reply, hits] = await answer(client, idx, "会员多少钱", 2);
  const sent = client.calls[0].messages[0].content as string;
  assert.equal(sent.split("<doc ").length - 1, 2);
  assert.match(client.calls[0].system as string, /资料中没有相关说明/);
  assert.equal(reply, "39 元 [1]");
  assert.ok(buildPrompt("q", hits).endsWith("问题：q"));
});
