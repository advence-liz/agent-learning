// Local-only infrastructure. No .env loading and no provider/model calls.
// node scripts/infra.ts up|check|observability|check-observability|stop-observability
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import pg from 'pg';

const root = fileURLToPath(new URL('..', import.meta.url));
const composeFile = fileURLToPath(new URL('../compose.yaml', import.meta.url));
function compose(args: string[]) {
  const result = spawnSync('docker', ['compose', '--project-name', 'interview-platform-jd-training-local', '--env-file', '/dev/null', '-f', composeFile, ...args], {
    cwd: root, stdio: 'inherit', timeout: 600_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'docker compose failed');
}
async function check() {
  const db = new pg.Client({ connectionString: 'postgres://agent_demo:local-demo-only@127.0.0.1:55432/agent_platform', connectionTimeoutMillis: 5000, query_timeout: 5000 });
  try {
    await db.connect();
    const { rows } = await db.query<{ version: string; database: string }>('SELECT version(), current_database() AS database');
    assert.match(rows[0]!.version, /PostgreSQL 16\./);
    assert.equal(rows[0]!.database, 'agent_platform');
    console.log(`PASS PostgreSQL 16: ${rows[0]!.database}`);
  } finally { await db.end(); }
  const client = new S3Client({
    endpoint: 'http://127.0.0.1:59000', region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: 'agent-demo-access', secretAccessKey: 'local-demo-only-storage' }, maxAttempts: 1,
  });
  const object = { Bucket: 'agent-reports', Key: `infra-probes/${randomUUID()}.txt` };
  const signal = AbortSignal.timeout(15_000);
  let created = false;
  try {
    await client.send(new PutObjectCommand({ ...object, Body: 'local-infra-probe', IfNoneMatch: '*' }), { abortSignal: signal });
    created = true;
    await assert.rejects(client.send(new PutObjectCommand({ ...object, Body: 'must-not-overwrite', IfNoneMatch: '*' }), { abortSignal: signal }),
      (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412);
    const result = await client.send(new GetObjectCommand(object), { abortSignal: signal });
    assert.equal(await result.Body!.transformToString(), 'local-infra-probe');
    console.log('PASS S3: conditional PUT, duplicate PUT=412, GET preserves original');
  } finally {
    if (created) await client.send(new DeleteObjectCommand(object), { abortSignal: AbortSignal.timeout(5000) });
    client.destroy();
  }
}
async function checkObservability() {
  const base = 'http://127.0.0.1:53000';
  const auth = `Basic ${Buffer.from('pk-lf-local-demo:sk-lf-local-demo').toString('base64')}`;
  const health = await fetch(`${base}/api/public/health`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(health.status, 200, await health.text());
  const traceId = randomUUID();
  const timestamp = new Date().toISOString();
  const response = await fetch(`${base}/api/public/ingestion`, {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ batch: [{ id: randomUUID(), timestamp, type: 'trace-create', body: { id: traceId, timestamp, name: 'local-infra-probe' } }] }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 207, await response.clone().text());
  const ingestion = await response.json() as { errors?: unknown[] };
  assert.deepEqual(ingestion.errors ?? [], []);
  // Queue acceptance is insufficient: wait for the worker to persist it in ClickHouse.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const trace = await fetch(`${base}/api/public/traces/${traceId}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(5000) });
    if (trace.status === 200) {
      const data = await trace.json() as { id: string };
      assert.equal(data.id, traceId);
      console.log(`PASS Langfuse ingestion + persisted trace GET: ${traceId}`);
      return;
    }
    assert.equal(trace.status, 404, await trace.text());
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Langfuse accepted ingestion but trace not persisted within 90 seconds');
}
const command = process.argv[2] ?? 'check';
try {
  if (command === 'up') { compose(['up', '-d', '--wait', '--wait-timeout', '120']); await check(); }
  else if (command === 'check') await check();
  else if (command === 'observability') {
    compose(['--profile', 'observability', 'up', '-d', '--wait', '--wait-timeout', '300']);
    await check(); await checkObservability();
  } else if (command === 'check-observability') await checkObservability();
  else if (command === 'stop-observability') compose(['--profile', 'observability', 'stop', 'langfuse-web', 'langfuse-worker', 'langfuse-postgres', 'clickhouse', 'redis']);
  else throw new Error('Usage: node scripts/infra.ts up|check|observability|check-observability|stop-observability');
} catch (error) { console.error(error); process.exitCode = 1; }
