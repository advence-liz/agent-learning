/**
 * 把 Messages API 的 SSE 流解析成事件，并重组出最终的 message 对象。
 *
 * SSE 帧格式：若干行 `event: xxx` / `data: {...}`，以空行分隔。
 * Messages API 的事件序列：
 *   message_start → (content_block_start → content_block_delta* → content_block_stop)* → message_delta → message_stop
 * 中间可能穿插 ping、error。
 */

export type SSEEvent = { event: string; data: any };

/** 返回 [{event: string, data: obj|string}, ...]。 */
export function parseSse(raw: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  let event: string | null = null;
  let dataLines: string[] = [];
  for (const line of [...raw.split(/\r\n|\r|\n/), ""]) {
    if (line === "") {
      if (event !== null || dataLines.length) {
        const data = dataLines.join("\n");
        let obj: any;
        try {
          obj = JSON.parse(data);
        } catch {
          obj = data;
        }
        events.push({ event: event ?? "message", data: obj });
      }
      event = null;
      dataLines = [];
    } else if (line.startsWith(":")) {
      continue; // 注释行
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  return events;
}

/** 把增量事件拼回一个完整的 assistant message（和非流式响应同形）。 */
export function assembleMessage(events: Iterable<SSEEvent>): Record<string, any> | null {
  let msg: Record<string, any> | null = null;
  const partialJson = new Map<number, string>();
  for (const ev of events) {
    const d = ev.data;
    if (d === null || typeof d !== "object" || Array.isArray(d)) continue;
    const t = d.type;
    if (t === "message_start") {
      msg = { ...d.message, content: [...(d.message.content ?? [])] };
    } else if (msg === null) {
      continue;
    } else if (t === "content_block_start") {
      msg.content.push({ ...d.content_block });
    } else if (t === "content_block_delta") {
      const block = msg.content[d.index];
      const delta = d.delta;
      const dt = delta.type;
      if (dt === "text_delta") {
        block.text = (block.text ?? "") + delta.text;
      } else if (dt === "thinking_delta") {
        block.thinking = (block.thinking ?? "") + delta.thinking;
      } else if (dt === "signature_delta") {
        block.signature = delta.signature;
      } else if (dt === "input_json_delta") {
        partialJson.set(d.index, (partialJson.get(d.index) ?? "") + delta.partial_json);
      }
    } else if (t === "content_block_stop") {
      const i = d.index;
      if (partialJson.has(i)) {
        const s = partialJson.get(i)!;
        partialJson.delete(i);
        try {
          msg.content[i].input = JSON.parse(s || "{}");
        } catch {
          msg.content[i].input_raw = s;
        }
      }
    } else if (t === "message_delta") {
      Object.assign(msg, d.delta ?? {});
      if ("usage" in d) msg.usage = { ...(msg.usage ?? {}), ...d.usage };
    }
  }
  return msg;
}
