/**
 * 脱敏：落盘前把凭证从 header 和 body 里抹掉。
 *
 * 原则：宁可多抹不可漏抹。header 按名字整值替换；body 里再按正则兜底扫一遍
 * （防止有人把 key 塞进 metadata、或者 OAuth token 出现在别的字段里）。
 */

// 整值替换的 header（小写比较）
export const SENSITIVE_HEADERS = new Set([
  "x-api-key",
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "anthropic-admin-api-key",
]);

// body / 任意文本里的兜底模式：Anthropic key、Bearer token、通用 sk- 前缀
const PATTERNS = [
  /sk-ant-[A-Za-z0-9_\-]{8,}/g,
  /bearer\s+[A-Za-z0-9._\-]{12,}/gi,
  /\bsk-[A-Za-z0-9]{20,}/g,
];

export const MASK = "***REDACTED***";

/** 保留前 6 个字符方便你区分「用的是哪把 key」，其余全抹。 */
export function redactValue(value: string): string {
  if (value.length <= 10) return MASK;
  return value.slice(0, 6) + "…" + MASK;
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? redactValue(v) : v;
  }
  return out;
}

export function redactText(text: string): string {
  for (const p of PATTERNS) text = text.replace(p, MASK);
  return text;
}
