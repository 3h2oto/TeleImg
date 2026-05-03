import { serviceUnavailable, unauthorized } from './http.js';

export function isDashboardEnabled(env) {
  return Boolean(env?.img_url);
}

export function isBasicAuthEnabled(env) {
  return typeof env?.BASIC_USER === 'string' && env.BASIC_USER.length > 0;
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

export function requireBasicAuth(context) {
  if (!isBasicAuthEnabled(context.env)) {
    return null;
  }

  const parsed = parseBasicAuth(context.request);
  if (!parsed.ok) {
    return unauthorized('You need to login.');
  }

  if (parsed.user !== context.env.BASIC_USER || parsed.pass !== context.env.BASIC_PASS) {
    return unauthorized('Invalid credentials.');
  }

  return null;
}

export function requireDashboardAccess(context) {
  return requireDashboard(context.env) ?? requireBasicAuth(context);
}
