import { serviceUnavailable, unauthorized } from './http.js';
import { getRuntimeConfig } from './runtime-config.js';

export function isDashboardEnabled(env) {
  return Boolean(env?.img_url);
}

export function requireDashboard(env) {
  if (!isDashboardEnabled(env)) {
    return serviceUnavailable('Dashboard is disabled. Bind the img_url KV namespace first.');
  }

  return null;
}

export function parseBasicAuth(request) {
  const header = request.headers.get('authorization');
  if (!header) {
    return { ok: false, reason: 'missing' };
  }

  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) {
    return { ok: false, reason: 'malformed' };
  }

  try {
    const decoded = atob(encoded);
    const separator = decoded.indexOf(':');
    if (separator < 0) {
      return { ok: false, reason: 'malformed' };
    }

    return {
      ok: true,
      user: decoded.slice(0, separator),
      pass: decoded.slice(separator + 1)
    };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

export async function isBasicAuthEnabled(env) {
  const config = await getRuntimeConfig(env);
  return typeof config?.BASIC_USER === 'string' && config.BASIC_USER.length > 0;
}

export async function requireBasicAuth(context) {
  const config = await getRuntimeConfig(context.env);
  if (typeof config?.BASIC_USER !== 'string' || config.BASIC_USER.length === 0) {
    return null;
  }

  const parsed = parseBasicAuth(context.request);
  if (!parsed.ok) {
    return unauthorized('You need to login.');
  }

  if (parsed.user !== config.BASIC_USER || parsed.pass !== config.BASIC_PASS) {
    return unauthorized('Invalid credentials.');
  }

  return null;
}

export async function requireDashboardAccess(context) {
  return requireDashboard(context.env) ?? await requireBasicAuth(context);
}
