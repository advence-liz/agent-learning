import { createHash } from 'node:crypto';
import { startActiveObservation } from '@langfuse/tracing';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { Attributes, Span, SpanContext } from '@opentelemetry/api';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

type Labels = { runId: string; tenant: string };
type Telemetry = { shutdown(): Promise<void> };
const noop: Telemetry = { shutdown: async () => {} };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const resource = resourceFromAttributes({ 'service.name': 'interview-platform-node' });
let starting: Promise<Telemetry> | undefined;
let enabled = false;
let secrets: string[] = [];

function safeName(name: string): string {
  if (!/^[a-z][a-z0-9_.:-]{0,79}$/i.test(name) || /(?:sk-|pk-|bearer|api[_-]?key)/i.test(name) ||
      secrets.some(secret => name.includes(secret))) return 'redacted.operation';
  return name;
}

function safeContext(context: SpanContext): SpanContext {
  // TraceState is arbitrary remote text, not necessary for local correlation.
  return { traceId: context.traceId, spanId: context.spanId, traceFlags: context.traceFlags };
}

function safeSpan(span: ReadableSpan): ReadableSpan {
  const allowed: Attributes = {};
  const runId = span.attributes['app.run_id'];
  const tenant = span.attributes['app.tenant_hash'];
  const outcome = span.attributes['app.outcome'];
  const duration = span.attributes['app.duration_ms'];
  if (typeof runId === 'string' && UUID.test(runId)) allowed['app.run_id'] = runId;
  if (typeof tenant === 'string' && /^[0-9a-f]{64}$/.test(tenant)) allowed['app.tenant_hash'] = tenant;
  if (outcome === 'success' || outcome === 'error') allowed['app.outcome'] = outcome;
  if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) allowed['app.duration_ms'] = duration;
  allowed['langfuse.observation.type'] = span.attributes['langfuse.observation.type'] === 'generation' ? 'generation' : 'span';
  allowed['langfuse.observation.level'] = span.status.code === 2 ? 'ERROR' : 'DEFAULT';
  // This boundary owns root classification; no propagated trace metadata is accepted.
  if (!span.parentSpanContext) allowed['langfuse.internal.is_app_root'] = true;
  return {
    name: safeName(span.name), kind: span.kind, spanContext: () => safeContext(span.spanContext()),
    parentSpanContext: span.parentSpanContext ? safeContext(span.parentSpanContext) : undefined,
    startTime: span.startTime, endTime: span.endTime, duration: span.duration, ended: span.ended,
    attributes: allowed, status: { code: span.status.code }, events: [], links: [],
    resource, instrumentationScope: { name: 'interview-platform-node' },
    droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0,
  };
}

/** Call at process startup, before invoking agents. Missing configuration disables all export. */
export async function startTelemetry(): Promise<Telemetry> {
  if (starting) return starting;
  const { LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey, LANGFUSE_BASE_URL: baseUrl } = process.env;
  if (!publicKey?.trim() || !secretKey?.trim() || !baseUrl?.trim()) return noop;
  const url = new URL(baseUrl);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' || (!local && (process.env.ALLOW_EXTERNAL_TELEMETRY !== 'true' || url.protocol !== 'https:'))) {
    throw new Error('Telemetry URL must be local; external HTTPS requires ALLOW_EXTERNAL_TELEMETRY=true');
  }
  secrets = Object.entries(process.env)
    .filter(([key, value]) => /SECRET|TOKEN|PASSWORD|KEY/i.test(key) && value && value.length >= 4)
    .map(([, value]) => value!);
  starting = (async () => {
    const [{ NodeSDK }, { LangfuseSpanProcessor }] = await Promise.all([
      import('@opentelemetry/sdk-node'), import('@langfuse/otel'),
    ]);
    const exporter = new LangfuseSpanProcessor({
      publicKey, secretKey, baseUrl, mask: () => '[REDACTED]',
      mediaUploadEnabled: false, shouldExportSpan: () => true,
      environment: 'local', release: 'interview-platform-node', timeout: 5,
    });
    const privacyBoundary: SpanProcessor = {
      // Do not let the exporter inspect raw propagated attributes or retain ignored spans.
      onStart() {},
      onEnd(span) {
        // No HTTP/database/autoinstrumentation spans or untrusted third-party attributes.
        if (span.attributes['app.observed'] === true) exporter.onEnd(safeSpan(span));
      },
      forceFlush: () => exporter.forceFlush(),
      shutdown: () => exporter.shutdown(),
    };
    const sdk = new NodeSDK({
      spanProcessors: [privacyBoundary], resource, autoDetectResources: false,
      instrumentations: [], metricReaders: [], logRecordProcessors: [], textMapPropagator: null,
    });
    sdk.start();
    enabled = true;
    let shutdown: Promise<void> | undefined;
    return { shutdown() {
      if (!shutdown) {
        enabled = false;
        shutdown = sdk.shutdown();
      }
      return shutdown;
    } };
  })();
  try { return await starting; }
  catch (error) { starting = undefined; enabled = false; throw error; }
}

async function instrument<T>(type: 'span' | 'generation', name: string, labels: Labels, fn: () => Promise<T>): Promise<T> {
  if (!enabled) return fn();
  const callback = async (observation: { otelSpan: Span }): Promise<T> => {
    const span = observation.otelSpan;
    span.setAttributes({
      'app.observed': true,
      'app.run_id': UUID.test(labels.runId) ? labels.runId : 'invalid',
      'app.tenant_hash': createHash('sha256').update(labels.tenant).digest('hex'),
    });
    const started = performance.now();
    try {
      const result = await fn();
      span.setAttribute('app.outcome', 'success');
      span.setStatus({ code: 1 });
      return result;
    } catch (error) {
      span.setAttribute('app.outcome', 'error');
      span.setStatus({ code: 2 });
      // Preserve identity for callers; SDK error status messages are removed at export.
      throw error;
    } finally {
      span.setAttribute('app.duration_ms', performance.now() - started);
    }
  };
  return type === 'generation'
    ? startActiveObservation(safeName(name), callback, { asType: 'generation' })
    : startActiveObservation(safeName(name), callback, { asType: 'span' });
}

export async function observed<T>(name: string, attributes: Labels, fn: () => Promise<T>): Promise<T> {
  return instrument('span', name, attributes, fn);
}

/** Wrap the actual model invocation in middleware; no LangChain callback captures prompts. */
export async function observedGeneration<T>(name: string, attributes: Labels, fn: () => Promise<T>): Promise<T> {
  return instrument('generation', name, attributes, fn);
}
