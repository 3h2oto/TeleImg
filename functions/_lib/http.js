export function json(data, init = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }

  return new Response(JSON.stringify(data), {
    ...init,
    headers
  });
}

export function text(body, init = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'text/plain; charset=utf-8');
  }

  return new Response(body, {
    ...init,
    headers
  });
}

export function redirect(url, status = 302, headers = undefined) {
  return new Response(null, {
    status,
    headers: {
      location: url,
      ...headers
    }
  });
}

export function badRequest(message) {
  return json({ error: message }, { status: 400 });
}

export function unauthorized(message = 'You need to login.', realm = 'TeleImg Dashboard') {
  return text(message, {
    status: 401,
    headers: {
      'cache-control': 'no-store',
      'www-authenticate': `Basic realm="${realm}", charset="UTF-8"`
    }
  });
}

export function methodNotAllowed(allowed) {
  return text('Method Not Allowed', {
    status: 405,
    headers: {
      allow: Array.isArray(allowed) ? allowed.join(', ') : allowed
    }
  });
}

export function serviceUnavailable(message) {
  return json({ error: message }, { status: 503 });
}
