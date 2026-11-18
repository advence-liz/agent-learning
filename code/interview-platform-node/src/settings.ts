import { parseEnv } from 'node:util';
import { check } from './domain.ts';

const publicCredentials: Record<string, string> = {
  S3_ACCESS_KEY_ID: 'agent-demo-access', S3_SECRET_ACCESS_KEY: 'local-demo-only-storage',
  LANGFUSE_PUBLIC_KEY: 'pk-lf-local-demo', LANGFUSE_SECRET_KEY: 'sk-lf-local-demo',
  GATEWAY_TOKEN: 'demo-gateway-local', API_TOKEN_ALPHA: 'demo-alpha', API_TOKEN_BETA: 'demo-beta',
};
const settings = new Set(['DATABASE_URL', 'S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'LANGFUSE_BASE_URL', 'PROMPT_NAME', 'PROMPT_VERSION', 'PORT', 'GATEWAY_PORT', 'MODEL_GATEWAY_URL', 'MODEL_MODE', 'ALLOW_LIVE_MODEL', 'ALLOW_EXTERNAL_DATABASE', 'ALLOW_EXTERNAL_GATEWAY', 'ALLOW_EXTERNAL_TELEMETRY', 'ALLOW_EXTERNAL_STORAGE']);

/** Parse settings without ever accepting real credentials from dotenv files. Shell values win. */
export function loadLocalSettings(files: string[], inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const values: Record<string, string> = {};
  for (const content of files) for (const [name, value] of Object.entries(parseEnv(content))) {
    if (!value) continue;
    if (name in publicCredentials) check(value === publicCredentials[name], 'SECRETS_MUST_COME_FROM_SHELL');
    else {
      check(!/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/.test(name), 'SECRETS_MUST_COME_FROM_SHELL');
      check(settings.has(name), 'UNKNOWN_LOCAL_SETTING');
    }
    if (name === 'DATABASE_URL') {
      const url = new URL(value);
      check(!url.password || (url.username === 'agent_demo' && url.password === 'local-demo-only' && ['127.0.0.1', 'localhost'].includes(url.hostname)), 'SECRETS_MUST_COME_FROM_SHELL');
    }
    values[name] = value;
  }
  const shell = Object.fromEntries(Object.entries(inherited).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return { ...values, ...shell };
}
