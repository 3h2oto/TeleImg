import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { onRequest } from '../functions/file/[id].js';
import { createKv } from './helpers.js';

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn(async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    return new Response('payload', {
      status: 200,
      headers: {
        'content-type': url.endsWith('.mp4') ? 'video/mp4' : 'image/png'
      }
    });
  });
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('/file/[id]', () => {
  it('redirects blocked records', async () => {
    const env = {
      img_url: createKv({
        'blocked.png': { ListType: 'Block', fileName: 'blocked.png', TimeStamp: 1 }
      })
    };

    const response = await onRequest({
      env,
      params: { id: 'blocked.png' },
      request: new Request('https://teleimg.example/file/blocked.png')
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://teleimg.example/block-img');
  });

  it('redirects to whitelist page when whitelist mode is on', async () => {
    const env = {
      WhiteList_Mode: 'true',
      img_url: createKv({
        'pending.png': { ListType: 'None', fileName: 'pending.png', TimeStamp: 1 }
      })
    };

    const response = await onRequest({
      env,
      params: { id: 'pending.png' },
      request: new Request('https://teleimg.example/file/pending.png')
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://teleimg.example/whitelist-on');
  });

  it('bypasses moderation rules for admin preview requests', async () => {
    const env = {
      img_url: createKv({
        'blocked.png': { ListType: 'Block', fileName: 'blocked.png', TimeStamp: 1 }
      })
    };

    const request = new Request('https://teleimg.example/file/blocked.png', {
      headers: {
        referer: 'https://teleimg.example/admin.html'
      }
    });

    const response = await onRequest({ env, params: { id: 'blocked.png' }, request });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('payload');
  });

  it('surfaces Telegram large-file errors instead of pretending the file is missing', async () => {
    const key = 'BAACAgEAAyEFAASOZ3wkAAMjafhWhh_XrMSN9CJ6p8Wk3VTLnCQAAgYGAAJ3jsFHJ97vQKEUt7g7BA.mp4';
    global.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/bottoken/getFile')) {
        return new Response(JSON.stringify({
          ok: false,
          error_code: 400,
          description: 'Bad Request: file is too big'
        }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        });
      }

      throw new Error(`unexpected upstream fetch: ${url}`);
    });

    const env = {
      TG_Bot_Token: 'token',
      img_url: createKv({
        [key]: {
          TimeStamp: 1,
          fileName: 'big.mp4',
          fileSize: 665750777,
          source: 'telegram-app',
          telegram: {
            chatId: '-10001',
            messageId: 35,
            fileId: key.replace(/\.mp4$/, '')
          }
        }
      })
    };

    const response = await onRequest({
      env,
      params: { id: key },
      request: new Request(`https://teleimg.example/file/${key}`)
    });

    expect(response.status).toBe(413);
    const body = await response.text();
    expect(body).toContain('Telegram Bot API cannot serve this file');
    expect(body).toContain('file is too big');
  });
});
