import { loadSystemPrompt } from './prompts.ts';
import { check, localURL } from './domain.ts';
import { boundedText } from './http.ts';

export async function seedLocalPrompt(options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}): Promise<number> {
  const env = options.env ?? process.env;
  // 仅允许本机教学项目，不向远端项目写入 Prompt。
  const base = localURL(env.LANGFUSE_BASE_URL ?? 'http://127.0.0.1:53000');
  const publicKey = env.LANGFUSE_PUBLIC_KEY ?? 'pk-lf-local-demo';
  const secret = env.LANGFUSE_SECRET_KEY ?? 'sk-lf-local-demo';
  const name = env.PROMPT_NAME ?? 'research-system'; check(/^[a-zA-Z0-9_-]+$/.test(name), 'INVALID_PROMPT_NAME');
  const { text } = await loadSystemPrompt({ env: {} });
  const headers = { Authorization: `Basic ${Buffer.from(`${publicKey}:${secret}`).toString('base64')}`, 'Content-Type': 'application/json' };
  const signal = AbortSignal.timeout(10_000);
  const url = new URL(`/api/public/v2/prompts/${name}`, base); url.searchParams.set('label', 'latest');
  const latest = await (options.fetch ?? fetch)(url, { headers, signal, redirect: 'error' });
  let version: number | undefined;
  if (latest.ok) {
    const current = JSON.parse(await boundedText(latest, signal)) as { prompt: string; version: number };
    if (current.prompt === text) version = current.version;
  } else { void latest.body?.cancel().catch(() => {}); check(latest.status === 404, `PROMPT_HTTP_${latest.status}`); }
  if (version === undefined) {
    const response = await (options.fetch ?? fetch)(new URL('/api/public/v2/prompts', base), { method: 'POST', headers, body: JSON.stringify({ name, type: 'text', prompt: text }), signal, redirect: 'error' });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); check(false, `PROMPT_HTTP_${response.status}`); }
    version = (JSON.parse(await boundedText(response, signal)) as { version: number }).version;
  }
  check(Number.isSafeInteger(version) && version! > 0, 'INVALID_PROMPT_VERSION'); return version!;
}
