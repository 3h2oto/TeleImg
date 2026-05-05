import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { onRequest } from '../functions/dav/[[path]].js';
import { createKv } from './helpers.js';

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn(async (input) => {
    const url = typeof input === 'string'
      ? input
      : (input?.url || (input instanceof URL ? input.toString() : ''));
    if (url.includes('/sendDocument')) {
      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 99,
          date: 1710000000,
          chat: { id: -10001, type: 'channel', title: 'Uploads' },
          document: {
            file_id: 'telegramFileId1234567890123456789012345678901234567',
            file_unique_id: 'unique1',
            file_name: 'hello.txt',
            file_size: 5,
            mime_type: 'text/plain'
          }
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (url.startsWith('https://example.com/file/')) {
      return new Response('hello', {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'content-length': '5'
        }
      });
    }

    if (url.includes('/deleteMessage')) {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    throw new Error(`unexpected fetch: ${url}`);
  });
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('WebDAV route', () => {
  it('supports OPTIONS and PROPFIND for created collections', async () => {
    const env = { img_url: createKv() };

    const optionsResponse = await onRequest({
      env,
      request: new Request('https://example.com/dav', { method: 'OPTIONS' })
    });
    expect(optionsResponse.status).toBe(204);
    expect(optionsResponse.headers.get('dav')).toBe('1');

    const mkcolResponse = await onRequest({
      env,
      request: new Request('https://example.com/dav/docs', { method: 'MKCOL' })
    });
    expect(mkcolResponse.status).toBe(201);

    const propfindResponse = await onRequest({
      env,
      request: new Request('https://example.com/dav', {
        method: 'PROPFIND',
        headers: { depth: '1' }
      })
    });
    expect(propfindResponse.status).toBe(207);
    const body = await propfindResponse.text();
    expect(body).toContain('/dav/');
    expect(body).toContain('/dav/docs/');
  });

  it('supports PUT, MOVE, GET and DELETE for files', async () => {
    const env = {
      TG_Bot_Token: 'token',
      TG_Chat_ID: '-10001',
      img_url: createKv()
    };

    const putResponse = await onRequest({
      env,
      request: new Request('https://example.com/dav/docs/hello.txt', {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: 'hello'
      })
    });
    expect(putResponse.status).toBe(201);

    const moveResponse = await onRequest({
      env,
      request: new Request('https://example.com/dav/docs/hello.txt', {
        method: 'MOVE',
        headers: { destination: 'https://example.com/dav/docs/renamed.txt' }
      })
    });
    expect(moveResponse.status).toBe(201);

    const getResponse = await onRequest({
      env,
      request: new Request('https://example.com/dav/docs/renamed.txt', {
        method: 'GET'
      })
    });
    expect(getResponse.status).toBe(200);
    expect(await getResponse.text()).toBe('hello');

    const deleteResponse = await onRequest({
      env,
      request: new Request('https://example.com/dav/docs/renamed.txt', {
        method: 'DELETE'
      })
    });
    expect(deleteResponse.status).toBe(204);

    const missingResponse = await onRequest({
      env,
      request: new Request('https://example.com/dav/docs/renamed.txt', {
        method: 'GET'
      })
    });
    expect(missingResponse.status).toBe(404);
  });
});
