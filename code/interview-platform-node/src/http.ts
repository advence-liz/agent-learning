import { check } from './domain.ts';

/** Bound bytes while reading, not after buffering. Cancellation also bounds noncooperative test transports. */
export async function boundedText(response: Response, signal: AbortSignal, limit = 128 * 1024): Promise<string> {
  signal.throwIfAborted();
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0; let complete = false;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try {
    signal.throwIfAborted();
    while (true) {
      const { value, done } = await Promise.race([reader.read(), cancelled]);
      if (done) { complete = true; break; }
      total += value.byteLength; check(total <= limit, 'RESPONSE_TOO_LARGE'); chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
    if (!complete) void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* abort may leave a transport read pending until cancel settles */ }
  }
}
