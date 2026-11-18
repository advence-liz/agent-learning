import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const moduleUrl = new URL('../src/observability.ts', import.meta.url).href;
function isolated(script: string, env: Record<string, string> = {}) {
  return execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    const seen = []; let config; let stopped = 0;
    const { LangfuseSpanProcessor: ActualProcessor } = await import('@langfuse/otel');
    mock.module('@langfuse/otel', { exports: {
      LangfuseSpanProcessor: class extends ActualProcessor {
        constructor(options) {
          config = options;
          super({ ...options, exporter: {
            export(spans, callback) { seen.push(...spans); callback({ code: 0 }); },
            shutdown() { stopped++; return Promise.resolve(); },
          } });
        }
      }
    } });
    const { startTelemetry, observed, observedGeneration } = await import(${JSON.stringify(moduleUrl)});
    ${script}
  `], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10000, env: {
    PATH: process.env.PATH, HOME: process.env.HOME,
    OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none',
    ...env,
  } });
}
const configured = {
  LANGFUSE_PUBLIC_KEY: 'pk-lf-unit-test', LANGFUSE_SECRET_KEY: 'sk-lf-super-secret',
  LANGFUSE_BASE_URL: 'http://127.0.0.1:3000',
};
const attrs = `{ runId: '2b561e58-a931-4c84-8df5-d46e30ad875b', tenant: 'tenant-1' }`;

test('missing any Langfuse setting is a no-op and observed preserves return/error', () => {
  for (const missing of Object.keys(configured)) {
    const env = { ...configured, [missing]: '' };
    isolated(`
      const handle = await startTelemetry();
      assert.equal(await observed('report.run', ${attrs}, async () => 42), 42);
      const error = new Error('original');
      await assert.rejects(observed('report.run', ${attrs}, async () => { throw error; }), e => e === error);
      await handle.shutdown(); assert.equal(config, undefined);
    `, env);
  }
});

test('external endpoint requires exact opt-in; malformed URL credentials are refused', () => {
  for (const url of ['https://example.com', 'http://localhost.evil.example', 'http://localhost@evil.example', 'file:///tmp/data']) {
    isolated(`await assert.rejects(startTelemetry(), /telemetry|URL|local/i); assert.equal(config, undefined);`, { ...configured, LANGFUSE_BASE_URL: url });
  }
  isolated(`const h = await startTelemetry(); assert.ok(config); await h.shutdown();`, {
    ...configured, LANGFUSE_BASE_URL: 'https://example.com', ALLOW_EXTERNAL_TELEMETRY: 'true',
  });
});

test('real OTel spans capture outcome and duration but never input/output/error text or secrets', () => {
  isolated(`
    const handle = await startTelemetry();
    assert.equal(config.publicKey, process.env.LANGFUSE_PUBLIC_KEY);
    assert.equal(config.secretKey, process.env.LANGFUSE_SECRET_KEY);
    assert.equal(config.baseUrl, process.env.LANGFUSE_BASE_URL);
    const payload = { prompt: 'private prompt', key: process.env.LANGFUSE_SECRET_KEY };
    assert.equal(await observed('report.run', ${attrs}, async () => payload), payload);
    const error = new Error('private prompt ' + process.env.LANGFUSE_SECRET_KEY);
    await assert.rejects(observed('report.fail', ${attrs}, async () => { throw error; }), e => e === error);
    await handle.shutdown(); await handle.shutdown();
    assert.equal(stopped, 1);
    assert.equal(seen.length, 2);
    const serialized = JSON.stringify(seen.map(s => ({name:s.name, attributes:s.attributes, events:s.events, status:s.status})));
    assert.ok(!serialized.includes('private prompt'));
    assert.ok(!serialized.includes(process.env.LANGFUSE_SECRET_KEY));
    assert.ok(!serialized.includes('tenant-1'));
    assert.equal(seen[0].attributes['app.outcome'], 'success');
    assert.equal(seen[1].attributes['app.outcome'], 'error');
    assert.ok(seen[0].attributes['app.duration_ms'] >= 0);
    assert.equal(config.mask({data:'secret prompt'}), '[REDACTED]');
  `, configured);
});

test('span export boundary drops arbitrary input, output, metadata, exception events and key-like names', () => {
  isolated(`
    const handle = await startTelemetry();
    await observed('sk-lf-super-secret', { runId: 'untrusted prompt', tenant: 'sk-lf-super-secret' }, async () => 'secret output');
    await handle.shutdown();
    const serialized = JSON.stringify(seen.map(s => ({name:s.name, attributes:s.attributes, events:s.events, status:s.status})));
    assert.ok(!serialized.includes('sk-lf-super-secret'));
    assert.ok(!serialized.includes('untrusted prompt'));
    assert.ok(!serialized.includes('secret output'));
  `, configured);
});

test('generation middleware preserves parent trace while dropping adversarial attributes and events', () => {
  isolated(`
    const { trace } = await import('@opentelemetry/api');
    const handle = await startTelemetry();
    await observed('report.run', ${attrs}, () => observedGeneration('model.call', ${attrs}, async () => {
      const span = trace.getActiveSpan();
      span.setAttributes({
        'langfuse.trace.input': 'private prompt',
        'langfuse.trace.output': 'private prompt',
        'langfuse.trace.metadata': 'private prompt',
        'langfuse.observation.metadata.secret': 'private prompt',
        'app.run_id': 'private prompt', 'app.tenant_hash': 'private prompt',
        'app.outcome': 'private prompt', 'app.duration_ms': 'private prompt',
      });
      span.addEvent('private prompt', { key: 'private prompt' });
      return 'private prompt';
    }));
    await handle.shutdown();
    assert.equal(seen.length, 2);
    assert.equal(seen[0].attributes['langfuse.observation.type'], 'generation');
    assert.equal(seen[0].spanContext().traceId, seen[1].spanContext().traceId);
    assert.equal(seen[0].parentSpanContext.spanId, seen[1].spanContext().spanId);
    assert.ok(!JSON.stringify(seen.map(s => ({attributes:s.attributes,events:s.events}))).includes('private prompt'));
  `, configured);
});

test('startTelemetry is idempotent for overlapping callers', () => {
  assert.equal(isolated(`
    const [a,b] = await Promise.all([startTelemetry(), startTelemetry()]);
    assert.equal(a,b); await a.shutdown(); await b.shutdown(); assert.equal(stopped,1);
    console.log('ok');
  `, configured).trim(), 'ok');
});
