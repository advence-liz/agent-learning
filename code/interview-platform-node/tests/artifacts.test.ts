import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { S3Artifacts } from '../src/artifacts.ts';

const id = '2b561e58-a931-4c84-8df5-d46e30ad875b';
const key = `reports/${id}.md`;
const env = { S3_ENDPOINT: 'http://127.0.0.1:9000', S3_REGION: 'us-east-1', S3_BUCKET: 'reports', S3_ACCESS_KEY_ID: 'test', S3_SECRET_ACCESS_KEY: 'test-secret' };
function fixture(timeoutMs = 1000) {
  const objects = new Map<string, Buffer>();
  const calls: Array<PutObjectCommand | GetObjectCommand> = [];
  const client = { async send(command: PutObjectCommand | GetObjectCommand, options?: { abortSignal?: AbortSignal }) {
    options?.abortSignal?.throwIfAborted();
    calls.push(command);
    const k = command.input.Key!;
    if (command instanceof PutObjectCommand) {
      if (objects.has(k)) throw Object.assign(new Error('precondition'), { $metadata: { httpStatusCode: 412 } });
      objects.set(k, Buffer.from(command.input.Body as Uint8Array));
      return {};
    }
    const body = objects.get(k);
    if (!body) throw Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } });
    return { ContentLength: body.length, Body: (async function* () { yield body; })() };
  } } as unknown as Pick<S3Client, 'send'>;
  return { store: new S3Artifacts({ client, env, timeoutMs }), objects, calls };
}

test('conditional writes use deterministic UUID key, UTF-8 bytes and content SHA256', async () => {
  const { store, calls } = fixture();
  const markdown = '# 中文报告';
  const result = await store.put(id, markdown);
  assert.deepEqual(result, { key, sha256: createHash('sha256').update(markdown).digest('hex') });
  assert.equal(calls[0].input.Key, key);
  assert.equal((calls[0] as PutObjectCommand).input.IfNoneMatch, '*');
  assert.equal((calls[0] as PutObjectCommand).input.Metadata?.sha256, result.sha256);
  assert.equal(await store.get(key), markdown);
});

test('same content retry succeeds, different content is rejected without overwrite', async () => {
  const { store, objects } = fixture();
  assert.deepEqual(await store.put(id, 'same'), await store.put(id, 'same'));
  await assert.rejects(store.put(id, 'different'), /conflict/i);
  assert.equal(objects.get(key)?.toString(), 'same');
});

test('UUID and key validation rejects paths before contacting transport', async () => {
  const { store, calls } = fixture();
  for (const invalid of ['../escape', `${id}/x`, 'not-a-uuid', '', id.toUpperCase()]) {
    await assert.rejects(store.put(invalid, 'x'), /UUID/i);
  }
  for (const invalid of [id, `reports/../${id}.md`, `${key}/x`, `/${key}`, `reports/${id}.txt`]) {
    await assert.rejects(store.get(invalid), /key/i);
  }
  assert.equal(calls.length, 0);
});

test('64 KiB limit is measured in bytes on upload and streaming download', async () => {
  const { store, objects, calls } = fixture();
  await store.put(id, 'x'.repeat(65536));
  await assert.rejects(store.put(id, '中'.repeat(21846)), /64 KiB/i);
  assert.equal(calls.length, 1);
  objects.set(key, Buffer.alloc(65537));
  await assert.rejects(store.get(key), /64 KiB/i);
});

test('invalid UTF-8 is rejected rather than silently replaced', async () => {
  const { store, objects } = fixture();
  objects.set(key, Buffer.from([0xc3, 0x28]));
  await assert.rejects(store.get(key), /UTF-8/i);
});

test('caller cancellation and timeout bound even an unresponsive transport', async () => {
  const client = { send: () => new Promise(() => {}) } as unknown as Pick<S3Client, 'send'>;
  const store = new S3Artifacts({ env, client, timeoutMs: 20 });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.put(id, 'x', controller.signal), { name: 'AbortError' });
  await assert.rejects(store.get(key), { name: 'TimeoutError' });
  const active = new AbortController();
  const pending = store.get(key, active.signal);
  active.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('stream download has the same wall-clock deadline and cancels the body', async () => {
  let destroyed = false;
  const body = {
    destroy() { destroyed = true; },
    async *[Symbol.asyncIterator]() { yield Buffer.from('x'); await new Promise(() => {}); },
  };
  const client = { send: async () => ({ Body: body }) } as unknown as Pick<S3Client, 'send'>;
  const store = new S3Artifacts({ env, client, timeoutMs: 20 });
  await assert.rejects(store.get(key), { name: 'TimeoutError' });
  assert.equal(destroyed, true);
});

test('streaming limit holds without ContentLength and disposes the oversized body', async () => {
  let destroyed = false;
  const body = {
    destroy() { destroyed = true; },
    async *[Symbol.asyncIterator]() { yield Buffer.alloc(32768); yield Buffer.alloc(32769); },
  };
  const client = { send: async () => ({ Body: body }) } as unknown as Pick<S3Client, 'send'>;
  const store = new S3Artifacts({ env, client });
  await assert.rejects(store.get(key), /64 KiB/);
  assert.equal(destroyed, true);
});

test('conditional 409 reconciles actual bytes, never trusting metadata hash', async () => {
  const client = { send: async (command: PutObjectCommand | GetObjectCommand) => {
    if (command instanceof PutObjectCommand) throw Object.assign(new Error('raced'), { $metadata: { httpStatusCode: 409 } });
    return {
      Metadata: { sha256: createHash('sha256').update('new').digest('hex') },
      Body: (async function* () { yield Buffer.from('old'); })(),
    };
  } } as unknown as Pick<S3Client, 'send'>;
  const store = new S3Artifacts({ env, client });
  await assert.rejects(store.put(id, 'new'), /conflict/i);
  assert.deepEqual(await store.put(id, 'old'), { key, sha256: createHash('sha256').update('old').digest('hex') });
});

test('default transport refuses external endpoints and missing explicit configuration', () => {
  assert.throws(() => new S3Artifacts({ env: {} }), /S3_/);
  assert.throws(() => new S3Artifacts({ env: { ...env, S3_ENDPOINT: 'https://example.com' } }), /local/i);
  assert.throws(() => new S3Artifacts({ env: { ...env, S3_ENDPOINT: 'http://localhost@evil.example' } }), /local/i);
});
