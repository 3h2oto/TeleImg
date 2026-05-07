import { INTERNAL_KEY_PREFIX, readInternalJson } from './kv.js';

export const RUNTIME_CONFIG_KEY = `${INTERNAL_KEY_PREFIX}runtime-config`;
const RUNTIME_KEYS = [
  'BASIC_USER',
  'BASIC_PASS',
  'TG_Bot_Token',
  'TG_Chat_ID',
  'TG_WEBHOOK_SECRET',
  'TG_MT_BRIDGE_URL',
  'TG_MT_BRIDGE_SECRET',
  'PUBLIC_BASE_URL',
  'ModerateContentApiKey'
];

function fromEnv(env) {
  const result = {};
  for (const key of RUNTIME_KEYS) {
    if (env?.[key] !== undefined && env[key] !== null && env[key] !== '') {
      result[key] = String(env[key]);
    }
  }
  return result;
}

export async function getRuntimeConfig(env) {
  const envConfig = fromEnv(env);
  if (!env?.img_url) {
    return envConfig;
  }

  const kvConfig = await readInternalJson(env, RUNTIME_CONFIG_KEY).catch(() => null);
  if (!kvConfig || typeof kvConfig !== 'object') {
    return envConfig;
  }

  return {
    ...kvConfig,
    ...envConfig
  };
}

export async function getRuntimeValue(env, key) {
  const config = await getRuntimeConfig(env);
  return config?.[key];
}

export function sanitizeRuntimeInput(input) {
  const result = {};
  for (const key of RUNTIME_KEYS) {
    if (input?.[key] !== undefined && input[key] !== null && input[key] !== '') {
      result[key] = String(input[key]).trim();
    }
  }
  return result;
}
