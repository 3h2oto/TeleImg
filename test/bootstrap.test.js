import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { onRequest as bootstrap } from '../functions/api/bootstrap/runtime-config.js';
import { onRequest as check } from '../functions/api/manage/check.js';
import { createKv } from './helpers.js';

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn(async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/getMe')) {
      return new Response(JSON.stringify({ ok: true, result: { id: 1, username: 'bot' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    if (url.includes('/getChat')) {
      return new Response(JSON.stringify({ ok: true, result: { id: -10001, title: 'Uploads', type: 'supergroup' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('runtime config bootstrap', () => {
  it('stores config in KV and enables auth checks', async () => {
    const env = { img_url: createKv() };

    const response = await bootstrap({
      env,
      request: new Request('https://teleimg.example/api/bootstrap/runtime-config', {
        method: 'POST',
        body: JSON.stringify({
          TG_Bot_Token: 'token',
          TG_Chat_ID: '-10001',
          BASIC_USER: 'admin',
          BASIC_PASS: 'secret'
        }),
        headers: { 'content-type': 'application/json' }
      })
    });

    expect(response.status).toBe(200);
    const checkResponse = await check({
      env,
      request: new Request('https://teleimg.example/api/manage/check')
    });
    expect(await checkResponse.text()).toBe('true');
  });
});
