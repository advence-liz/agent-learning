/**
 * 补充章「工具设计」：量一量工具定义和工具结果占了多少上下文，以及带续取提示的截断。
 *
 * estimateTokens 只是粗估（ASCII 约 4 字符 1 token，中文等非 ASCII 约 1 字符 1 token），
 * 用来比较两套工具集的量级。要精确数字，用 client.messages.countTokens(...) 让接口自己数。
 */

export function estimateTokens(text: string): number {
  let ascii = 0;
  for (const ch of text) if (ch.charCodeAt(0) < 128) ascii++;
  return Math.ceil(ascii / 4 + ([...text].length - ascii));
}

/** 紧凑 JSON，和 Python 版 json.dumps(separators=(",", ":")) 逐字一致，字符数才能对得上。 */
export const dumps = (obj: unknown): string => JSON.stringify(obj);

/** 工具定义每次请求都会原样发给模型：名字、描述、schema 全算。 */
export function measureTools(tools: unknown[]): { chars: number; tokens: number } {
  const s = dumps(tools);
  return { chars: s.length, tokens: estimateTokens(s) };
}

/**
 * 把过长的工具结果截到 maxChars 以内（尽量按整行切），末尾告诉模型还剩多少、怎么拿剩下的。
 * 只截不提示，模型会以为自己看到的就是全部；提示里要给出能直接照做的下一步。
 */
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
  return (
    `${shown}\n…[结果已截断：只显示了前 ${shown.length} / ${text.length} 字符，` +
    `还剩 ${text.length - shown.length} 字符没给你看。${howToContinue}]`
  );
}
