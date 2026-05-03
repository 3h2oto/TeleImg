import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { onRequest as deleteRecord } from '../functions/api/manage/delete/[id].js';
import { onRequest as editName } from '../functions/api/manage/editName/[id].js';
import { onRequest as list } from '../functions/api/manage/list.js';
import { onRequest as toggleLike } from '../functions/api/manage/toggleLike/[id].js';
import { processTelegramUpdates } from '../functions/_lib/telegram-sync.js';
import { createKv } from './helpers.js';

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  }));
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('manage endpoints', () => {
  it('renames using ?newName=', async () => {
    const env = {
      img_url: createKv({
        'abc.png': { fileName: 'before.png', TimeStamp: 1 }
      })
    };

    const response = await editName({
      env,
      params: { id: 'abc.png' },
      request: new Request('https://example.com/api/manage/editName/abc.png?newName=after.png')
    });

    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.fileName).toBe('after.png');
  });

  it('toggles liked state', async () => {
    const env = {
      img_url: createKv({
        'abc.png': { fileName: 'file.png', liked: false, TimeStamp: 1 }
      })
    };

    const response = await toggleLike({
      env,
      params: { id: 'abc.png' },
      request: new Request('https://example.com/api/manage/toggleLike/abc.png')
    });

    const payload = await response.json();
    expect(payload.liked).toBe(true);
  });

  it('supports fuzzy search by fileName', async () => {
    const env = {
      img_url: createKv({
        'one.png': { fileName: 'cat-picture.png', TimeStamp: 1 },
        'two.png': { fileName: 'dog-picture.png', TimeStamp: 2 }
      })
    };

    const response = await list({
      env,
      request: new Request('https://example.com/api/manage/list?search=cat')
    });

    const payload = await response.json();
    expect(payload.keys).toHaveLength(1);
    expect(payload.keys[0].name).toBe('one.png');
  });

  it('syncs Telegram direct uploads into KV records', async () => {
    const env = { img_url: createKv() };
    const summary = await processTelegramUpdates(env, [{
      update_id: 42,
      message: {
        message_id: 7,
        date: 1710000000,
        caption: 'from telegram app',
        chat: { id: -10001, type: 'supergroup', title: 'Uploads' },
        from: { id: 9, first_name: 'Vic' },
        document: {
          file_id: 'telegramFileId1234567890123456789012345678901234567',
          file_unique_id: 'unique1',
          file_name: 'notes.pdf',
          file_size: 2048,
          mime_type: 'application/pdf'
        }
      }
    }], { mode: 'poll', source: 'telegram-app' });

    expect(summary.stored).toBe(1);
    const stored = await env.img_url.getWithMetadata('telegramFileId1234567890123456789012345678901234567.pdf');
    expect(stored.metadata.source).toBe('telegram-app');
    expect(stored.metadata.telegram.messageId).toBe(7);
  });

  it('deletes Telegram message and KV record when metadata exists', async () => {
    const env = {
      TG_Bot_Token: 'token',
      img_url: createKv({
        'abc.png': {
          fileName: 'abc.png',
          TimeStamp: 1,
          telegram: { chatId: '-10001', messageId: 99, fileId: 'fileId' }
        }
      })
    };

    const response = await deleteRecord({
      env,
      params: { id: 'abc.png' },
      request: new Request('https://example.com/api/manage/delete/abc.png')
    });

    const payload = await response.json();
    expect(payload.telegramDeleted).toBe(true);
    expect(await env.img_url.getWithMetadata('abc.png')).toBeNull();
  });
});
