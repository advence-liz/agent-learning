import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface ArtifactStore {
  put(runId: string, markdown: string, signal?: AbortSignal): Promise<{ key: string; sha256: string }>;
  get(key: string, signal?: AbortSignal): Promise<string>;
}

const MAX_BYTES = 64 * 1024;
// Canonical lowercase spelling makes one UUID map to exactly one key.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^reports\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

type Options = {
  client?: Pick<S3Client, 'send'>;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

function abortable<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(task).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class S3Artifacts implements ArtifactStore {
  private readonly client: Pick<S3Client, 'send'>;
  private readonly bucket: string;
  private readonly timeoutMs: number;

  constructor(options: Options = {}) {
    const env = options.env ?? process.env;
    const required = (name: string) => {
      const value = env[name];
      if (!value?.trim()) throw new Error(`Missing ${name}`);
      return value;
    };
    const endpoint = new URL(required('S3_ENDPOINT'));
    const local = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1';
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || endpoint.pathname !== '/' ||
      (!local && (env.ALLOW_EXTERNAL_STORAGE !== 'true' || endpoint.protocol !== 'https:'))) {
      throw new Error('S3 endpoint must be local; external HTTPS requires ALLOW_EXTERNAL_STORAGE=true');
    }
    this.bucket = required('S3_BUCKET');
    const region = required('S3_REGION');
    const credentials = { accessKeyId: required('S3_ACCESS_KEY_ID'), secretAccessKey: required('S3_SECRET_ACCESS_KEY') };
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new Error('timeoutMs must be between 1 and 120000');
    }
    this.client = options.client ?? new S3Client({ endpoint: endpoint.href, region, credentials, forcePathStyle: true, maxAttempts: 3 });
  }

  private async bounded<T>(signal: AbortSignal | undefined, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    const timeout = new AbortController();
    // A referenced timer also bounds injected transports that leave no active handles.
    const timer = setTimeout(() => timeout.abort(new DOMException('S3 operation timed out', 'TimeoutError')), this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try { return await abortable(() => task(combined), combined); }
    finally { clearTimeout(timer); }
  }

  async put(runId: string, markdown: string, signal?: AbortSignal): Promise<{ key: string; sha256: string }> {
    if (!UUID.test(runId)) throw new Error('runId must be a canonical lowercase UUID');
    const bytes = Buffer.from(markdown, 'utf8');
    if (bytes.length > MAX_BYTES) throw new Error('Artifact exceeds 64 KiB');
    const key = `reports/${runId}.md`;
    const sha256 = hash(bytes);
    return this.bounded(signal, async (combined) => {
      try {
        await this.client.send(new PutObjectCommand({
          Bucket: this.bucket, Key: key, Body: bytes, ContentLength: bytes.length,
          ContentType: 'text/markdown; charset=utf-8', Metadata: { sha256 }, IfNoneMatch: '*',
        }), { abortSignal: combined });
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
        // Never retry unconditionally: a concurrent writer may already own the key.
        if (status !== 412 && status !== 409) throw error;
        const existing = await this.download(key, combined);
        if (hash(existing) !== sha256) throw new Error('Artifact conflict: runId already has different content');
      }
      return { key, sha256 };
    });
  }

  async get(key: string, signal?: AbortSignal): Promise<string> {
    if (!KEY.test(key)) throw new Error('Invalid artifact key');
    const bytes = await this.bounded(signal, (combined) => this.download(key, combined));
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('Artifact contains invalid UTF-8'); }
  }

  private async download(key: string, signal: AbortSignal): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
    const body = result.Body;
    if (!body || !(Symbol.asyncIterator in body)) throw new Error('Missing streaming S3 body');
    const stream = body as AsyncIterable<Uint8Array> & { destroy?: () => void };
    const destroy = () => stream.destroy?.();
    signal.addEventListener('abort', destroy, { once: true });
    try {
      signal.throwIfAborted();
      if ((result.ContentLength ?? 0) > MAX_BYTES) throw new Error('Artifact exceeds 64 KiB');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        signal.throwIfAborted();
        size += chunk.byteLength;
        if (size > MAX_BYTES) throw new Error('Artifact exceeds 64 KiB');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks, size);
    } finally {
      signal.removeEventListener('abort', destroy);
      destroy();
    }
  }
}
