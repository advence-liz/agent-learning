import assert from "node:assert/strict";
import { test } from "node:test";

import { Chatbot } from "./bot.ts";
import { FakeAnthropic, text } from "../fake_llm/index.ts";

test("记忆就是 messages 数组", async () => {
  const client = new FakeAnthropic([text("你好小林"), text("你叫小林")]);
  const bot = new Chatbot(client, { system: "S" });
  await bot.send("我叫小林");
  await bot.send("我叫什么？");

  // 第二次请求时，模型看到的是完整历史：user / assistant / user
  const second = client.calls[1];
  assert.deepEqual(second.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(second.messages[0].content, "我叫小林");
  assert.equal(second.system, "S");
});

test("reset 之后什么都不记得", async () => {
  const client = new FakeAnthropic([text("a"), text("b")]);
  const bot = new Chatbot(client);
  await bot.send("我叫小林");
  bot.reset("你是一只猫");
  await bot.send("我叫什么？");
  assert.equal(client.calls[1].messages.length, 1); // 没有任何历史
  assert.equal(client.calls[1].system, "你是一只猫");
});
