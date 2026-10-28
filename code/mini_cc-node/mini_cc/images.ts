/**
 * 图片输入（第 19 章）：把图片文件变成 API 的 image 内容块。
 *
 * 数字都来自 Claude 官方 vision 文档：
 * - 格式：JPEG / PNG / GIF / WebP（按文件头判断，不信扩展名）
 * - 单张上限：直连 API 时 base64 后 10MB；尺寸不超过 8000×8000 px
 * - 费用：每 28×28 像素一个 visual token；高分辨率档（Claude 4.7 及以后，含 claude-opus-5-5）长边超过 2576px
 *   或超过 4784 个 visual token 时，服务端会等比缩小
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import { expandUser, realResolve } from "./tools/base.ts";

export const EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
export const MAX_BASE64_BYTES = 10 * 1024 * 1024;
export const MAX_DIMENSION = 8000;
export const MAX_LONG_EDGE = 2576; // 高分辨率档
export const MAX_VISUAL_TOKENS = 4784;

const startsWith = (data: Uint8Array, sig: number[] | string, at = 0): boolean => {
  const bytes = typeof sig === "string" ? [...sig].map((c) => c.charCodeAt(0)) : sig;
  return data.length >= at + bytes.length && bytes.every((b, i) => data[at + i] === b);
};

export function sniff(data: Uint8Array): string | null {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(data, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(data, "GIF87a") || startsWith(data, "GIF89a")) return "image/gif";
  if (startsWith(data, "RIFF") && startsWith(data, "WEBP", 8)) return "image/webp";
  return null;
}

function jpegSize(data: Buffer): [number, number] | null {
  let i = 2;
  while (i + 9 < data.length) {
    if (data[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = data[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = data.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) { // SOFn：帧头里有宽高
      const h = data.readUInt16BE(i + 5);
      const w = data.readUInt16BE(i + 7);
      return [w, h];
    }
    i += 2 + length;
  }
  return null;
}

/** [media_type, 宽, 高]。只解析文件头，不解码像素（所以不需要图像库）。 */
export function imageInfo(input: Uint8Array): [string, number, number] | null {
  const data = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const media = sniff(data);
  let size: [number, number] | null = null;
  if (media === "image/png" && data.length >= 24) {
    size = [data.readUInt32BE(16), data.readUInt32BE(20)];
  } else if (media === "image/jpeg") {
    size = jpegSize(data);
  } else if (media === "image/gif" && data.length >= 10) {
    size = [data.readUInt16LE(6), data.readUInt16LE(8)];
  } else if (media === "image/webp" && data.length >= 30) {
    const kind = data.subarray(12, 16).toString("latin1");
    if (kind === "VP8X") {
      size = [data.readUIntLE(24, 3) + 1, data.readUIntLE(27, 3) + 1];
    } else if (kind === "VP8 ") {
      size = [data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff];
    } else if (kind === "VP8L") {
      const b = data.readUInt32LE(21);
      size = [(b & 0x3fff) + 1, ((b >>> 14) & 0x3fff) + 1];
    }
  }
  if (media === null || size === null) return null;
  return [media, size[0], size[1]];
}

/** Python 的 round()：银行家舍入（.5 取偶数），和 Python 版算出的数一致。 */
function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** 服务端缩放后的 visual token 数（近似复现文档的规则：先压长边，再压总 token 数）。 */
export function estimateVisualTokens(w: number, h: number): number {
  let s = Math.min(1.0, MAX_LONG_EDGE / Math.max(w, h));
  let w2 = Math.max(1, pyRound(w * s));
  let h2 = Math.max(1, pyRound(h * s));
  let tokens = Math.ceil(w2 / 28) * Math.ceil(h2 / 28);
  while (tokens > MAX_VISUAL_TOKENS) {
    s = Math.sqrt(MAX_VISUAL_TOKENS / tokens) * 0.999;
    w2 = Math.max(1, Math.trunc(w2 * s));
    h2 = Math.max(1, Math.trunc(h2 * s));
    tokens = Math.ceil(w2 / 28) * Math.ceil(h2 / 28);
  }
  return tokens;
}

export class ImageError extends Error {
  override name = "ImageError";
}

export class ImageMeta {
  media: string;
  width: number;
  height: number;
  size: number; // 字节
  tokens: number; // 估算的 visual token

  constructor(media: string, width: number, height: number, size: number, tokens: number) {
    this.media = media;
    this.width = width;
    this.height = height;
    this.size = size;
    this.tokens = tokens;
  }

  get short(): string {
    return this.media.split("/")[1];
  }

  note(): string {
    return `${this.short}, ${this.width}x${this.height}, ${Math.floor(this.size / 1024) || 1}KB, ≈${this.tokens} visual tokens`;
  }
}

export type ImageBlock = { type: "image"; source: { type: "base64"; media_type: string; data: string } };

/** 读图片 → [image 内容块, 元信息]。不合规的图片抛 ImageError，说明原因（给模型看）。 */
export function loadImage(path: string): [ImageBlock, ImageMeta] {
  const data = readFileSync(path);
  const name = basename(path);
  const info = imageInfo(data);
  if (info === null) throw new ImageError(`${name} is not a supported image (JPEG, PNG, GIF or WebP).`);
  const [media, w, h] = info;
  if (Math.max(w, h) > MAX_DIMENSION) {
    throw new ImageError(`${name} is ${w}x${h}; images must be at most ${MAX_DIMENSION}x${MAX_DIMENSION} px. ` +
      "Resize it first (e.g. `sips -Z 2576 file.png` on macOS).");
  }
  const b64 = data.toString("base64");
  if (b64.length > MAX_BASE64_BYTES) {
    throw new ImageError(`${name} is ${Math.floor(data.length / 1024)}KB (${Math.floor(b64.length / 1024)}KB as base64); ` +
      "the API limit is 10MB per image. Compress or resize it first.");
  }
  const meta = new ImageMeta(media, w, h, data.length, estimateVisualTokens(w, h));
  return [{ type: "image", source: { type: "base64", media_type: media, data: b64 } }, meta];
}

export function isImagePath(path: string): boolean {
  return EXTENSIONS.has(extname(path).toLowerCase()) && existsSync(path) && statSync(path).isFile();
}

// 拖进终端的路径：macOS Terminal / iTerm 会把空格转义成「\ 」，有的终端会加引号
const QUOTED = /(['"])(.+?)\1/g;
const BARE = /((?:~|\/|\.{1,2}\/)(?:\\ |[^\s'"])+)/g;

/** 找出输入里「存在的图片文件路径」（绝对路径、~、./ 开头，或带引号）。 */
export function findImagePaths(text: string, cwd: string): string[] {
  const found: string[] = [];
  const candidates = [...[...text.matchAll(QUOTED)].map((m) => m[2]), ...[...text.matchAll(BARE)].map((m) => m[1])];
  for (const raw of candidates) {
    let p = expandUser(raw.replaceAll("\\ ", " "));
    p = isAbsolute(p) ? p : join(cwd, p);
    if (isImagePath(p) && !found.map(realResolve).includes(realResolve(p))) found.push(p);
  }
  return found;
}
