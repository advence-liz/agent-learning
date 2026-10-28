/** 第 19 章：图片输入（@ 引用 / 拖进终端的路径 / Read 读图片）。 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import type { Settings } from "../mini_cc/config.ts";
import { estimateVisualTokens, findImagePaths, imageInfo, sniff } from "../mini_cc/images.ts";
import { type Block, call, say } from "../mini_cc/model.ts";
import { cleanupTmp, makeApp, makeSettings, tmpPath } from "./conftest.ts";

let settings: Settings;
beforeEach(() => (settings = makeSettings()));
afterEach(cleanupTmp);

const u32be = (...ns: number[]) => Buffer.concat(ns.map((n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}));
const u16 = (le: boolean, ...ns: number[]) => Buffer.concat(ns.map((n) => {
  const b = Buffer.alloc(2);
  if (le) b.writeUInt16LE(n);
  else b.writeUInt16BE(n);
  return b;
}));

/** 纯标准库生成一张 w×h 的灰色 PNG（测试用，不依赖图像库）。 */
function png(w: number, h: number): Buffer {
  const chunk = (t: string, d: Buffer) => {
    const td = Buffer.concat([Buffer.from(t, "latin1"), d]);
    return Buffer.concat([u32be(d.length), td, u32be(crc32(td))]);
  };
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w, 0x80)])));
  const ihdr = Buffer.concat([u32be(w, h), Buffer.from([8, 0, 0, 0, 0])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function jpegHeader(w: number, h: number): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), u16(false, 16), Buffer.from("JFIF\0", "latin1"), Buffer.alloc(9),
    Buffer.from([0xff, 0xc0]), u16(false, 17), Buffer.from([8]), u16(false, h, w), Buffer.alloc(10)]);
}

const le3 = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);

test("识别格式与尺寸", () => {
  assert.deepEqual(imageInfo(png(30, 20)), ["image/png", 30, 20]);
  assert.deepEqual(imageInfo(jpegHeader(640, 480)), ["image/jpeg", 640, 480]);
  assert.deepEqual(imageInfo(Buffer.concat([Buffer.from("GIF89a"), u16(true, 12, 7), Buffer.alloc(20)])), ["image/gif", 12, 7]);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8X"), Buffer.alloc(8), le3(99), le3(49)]);
  assert.deepEqual(imageInfo(webp), ["image/webp", 100, 50]);
  assert.equal(sniff(Buffer.from("%PDF-1.7")), null);
});

test("visual token 估算和文档的表一致", () => {
  // 官方 vision 文档的高分辨率档示例：1000² → 1296，1920×1080 → 2691，4K → 缩到 2576×1449 → 4784
  assert.equal(estimateVisualTokens(1000, 1000), 1296);
  assert.equal(estimateVisualTokens(1920, 1080), 2691);
  assert.equal(estimateVisualTokens(3840, 2160), 4784);
});

test("识别拖进终端的路径", () => {
  const dir = tmpPath();
  const p = join(dir, "my shot.png");
  writeFileSync(p, png(2, 2));
  const escaped = p.replaceAll(" ", "\\ ");
  assert.deepEqual(findImagePaths(`${escaped} 这个按钮为什么错位`, dir), [p]);
  assert.deepEqual(findImagePaths(`'${p}' 看看`, dir), [p]);
  assert.deepEqual(findImagePaths("没有图片 /nope.png", dir), []);
});

test("@ 引用的图片排在原话之前", async () => {
  writeFileSync(join(settings.cwd, "shot.png"), png(40, 30));
  const { app, client, ui } = makeApp(settings, [say("按钮右边距多了 8px")]);
  await app.handleLine("@shot.png 这个按钮为什么错位");
  const content = client.requests[0].messages[0].content as Block[];
  const kinds = content.map((b) => b.type);
  const img = content.find((b) => b.type === "image")!;
  assert.ok(kinds.indexOf("image") < kinds.length - 1 && content.at(-1)!.text === "@shot.png 这个按钮为什么错位");
  assert.equal(img.source.media_type, "image/png");
  assert.deepEqual(Buffer.from(img.source.data, "base64"), readFileSync(join(settings.cwd, "shot.png")));
  assert.ok(ui.text.includes("已附加 @shot.png（图片 png 40×30"));
});

test("拖进来的路径也会附加", async () => {
  const shot = join(settings.cwd, "Screen Shot.png");
  writeFileSync(shot, png(10, 10));
  const { app, client } = makeApp(settings, [say("ok")]);
  await app.handleLine(shot.replaceAll(" ", "\\ ") + " 对比一下设计稿");
  assert.ok((client.requests[0].messages[0].content as Block[]).some((b) => b.type === "image"));
});

test("Read 读图片返回 image 块", async () => {
  writeFileSync(join(settings.cwd, "ui.png"), png(16, 16));
  const { app, client, ui } = makeApp(settings, [call("Read", { file_path: "ui.png" }), say("看到了")]);
  await app.handleLine("读一下 ui.png");
  const result = (client.requests[1].messages.at(-1)!.content as Block[])[0];
  assert.ok(!result.is_error);
  assert.deepEqual(result.content.map((b: Block) => b.type), ["text", "image"]);
  assert.ok(result.content[0].text.includes("ui.png") && result.content[0].text.includes("16x16"));
  assert.ok(ui.text.includes("✔ Read -> Image: ui.png") && ui.text.includes("[image]"));
});

test("扩展名不对、尺寸超限", async () => {
  writeFileSync(join(settings.cwd, "fake.png"), Buffer.concat([jpegHeader(10, 10), Buffer.alloc(100)]));
  let big = png(1, 1);
  big = Buffer.concat([big.subarray(0, 16), u32be(9000, 10), big.subarray(24)]); // 改 IHDR：声称 9000×10
  writeFileSync(join(settings.cwd, "huge.png"), big);
  const { app, client } = makeApp(settings, [call("Read", { file_path: "fake.png" }), call("Read", { file_path: "huge.png" }), say("ok")]);
  await app.handleLine("读两张图");
  const first = (client.requests[1].messages.at(-1)!.content as Block[])[0].content;
  assert.equal(first[1].source.media_type, "image/jpeg"); // 按文件头，不按扩展名
  const second = (client.requests[2].messages.at(-1)!.content as Block[])[0];
  assert.ok(second.is_error && second.content.includes("8000"));
});

test("/context 单独统计图片", async () => {
  writeFileSync(join(settings.cwd, "a.png"), png(1000, 1000));
  const { app, ui } = makeApp(settings, [say("ok")]);
  await app.handleLine("@a.png 看看");
  await app.handleLine("/context");
  assert.ok(ui.text.includes("1 张图片") && ui.text.includes("1296"));
});
