import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { onRequest as browseDav } from '../functions/api/manage/dav/browse.js';
import { onRequest as deleteKvRecord } from '../functions/api/manage/deleteKv/[id].js';
import { onRequest as deleteRecord } from '../functions/api/manage/delete/[id].js';
import { onRequest as editName } from '../functions/api/manage/editName/[id].js';
import { onRequest as list } from '../functions/api/manage/list.js';
import { __test as mtprotoUploadTest, onRequest as mtprotoUpload } from '../functions/api/manage/mtproto/upload.js';
import { onRequest as bridgeWarmup } from '../functions/api/manage/telegram/bridge-warmup.js';
import { onRequest as telegramStatus } from '../functions/api/manage/telegram/status.js';
import { onRequest as toggleLike } from '../functions/api/manage/toggleLike/[id].js';
import { getDavEntryKey } from '../functions/_lib/dav.js';
import { buildMtprotoDesiredDavPath } from '../functions/_lib/mtproto-upload.js';
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

  it('prefers fresh getWithMetadata over stale list metadata', async () => {
    const env = {
      img_url: createKv({
        'one.png': {
          fileName: 'fresh-name.png',
          TimeStamp: 2
        }
      })
    };

    const originalList = env.img_url.list.bind(env.img_url);
    env.img_url.list = async (options = {}) => {
      const page = await originalList(options);
      return {
        ...page,
        keys: page.keys.map((entry) => ({
          ...entry,
          metadata: entry.name === 'one.png'
            ? { ...(entry.metadata || {}), fileName: 'stale-name.png', TimeStamp: 1 }
            : entry.metadata
        }))
      };
    };

    const response = await list({
      env,
      request: new Request('https://example.com/api/manage/list?search=fresh-name')
    });

    const payload = await response.json();
    expect(payload.keys).toHaveLength(1);
    expect(payload.keys[0].metadata.fileName).toBe('fresh-name.png');
  });

  it('browses DAV folders with enriched file metadata', async () => {
    const env = {
      img_url: createKv({
        'key-1.jpg': {
          fileName: 'cover.jpg',
          fileSize: 12,
          TimeStamp: 2,
          telegram: { chatId: '-10001', messageId: 9, fileId: 'key-1' }
        },
        [getDavEntryKey('/albums')]: {
          value: JSON.stringify({
            kind: 'collection',
            path: '/albums',
            name: 'albums',
            createdAt: 1,
            updatedAt: 1
          })
        },
        [getDavEntryKey('/albums/cover.jpg')]: {
          value: JSON.stringify({
            kind: 'file',
            path: '/albums/cover.jpg',
            name: 'cover.jpg',
            storageKey: 'key-1.jpg',
            size: 12,
            contentType: 'image/jpeg',
            createdAt: 2,
            updatedAt: 2
          })
        }
      })
    };

    const response = await browseDav({
      env,
      request: new Request('https://example.com/api/manage/dav/browse?path=/albums')
    });

    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.path).toBe('/albums');
    expect(payload.counts.files).toBe(1);
    expect(payload.files[0].name).toBe('key-1.jpg');
    expect(payload.files[0].davPath).toBe('/albums/cover.jpg');
    expect(payload.files[0].metadata.fileName).toBe('cover.jpg');
    expect(payload.files[0].canDeleteTelegram).toBe(true);
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

  it('claims pending MTProto uploads into the requested DAV folder', async () => {
    const env = { img_url: createKv() };
    await processTelegramUpdates(env, [{
      update_id: 77,
      channel_post: {
        message_id: 51,
        date: 1710000100,
        chat: { id: -1002389146660, type: 'channel', title: 'This_Img_Servant' },
        document: {
          file_id: 'telegramMtprotoFileId12345678901234567890123456789',
          file_unique_id: 'unique-mtproto-1',
          file_name: 'movie.mp4',
          file_size: 4096,
          mime_type: 'video/mp4'
        }
      }
    }], { mode: 'webhook', source: 'telegram-app' });

    const storedKey = 'telegramMtprotoFileId12345678901234567890123456789.mp4';
    const existing = await env.img_url.getWithMetadata(storedKey);
    expect(existing?.metadata?.telegram?.messageId).toBe(51);

    const response = await mtprotoUpload({
      env: {
        TG_MT_BRIDGE_URL: 'https://bridge.example.com',
        TG_MT_BRIDGE_SECRET: 'secret',
        TG_Chat_ID: '-1002389146660',
        img_url: env.img_url
      },      
      request: new Request('https://example.com/api/manage/mtproto/upload', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          path: '/porn/白石なお',
          fileName: 'movie.mp4',
          contentType: 'video/mp4',
          upload: {
            chatId: '-1002389146660',
            messageId: 51,
            fileName: 'movie.mp4',
            fileSize: 4096,
            contentType: 'video/mp4',
            mediaKind: 'document'
          }
        })
      })
    });

    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.claimed).toBe(true);
    expect(payload.davPath).toBe('/porn/白石なお/movie.mp4');

    const browseResponse = await browseDav({
      env,
      request: new Request('https://example.com/api/manage/dav/browse?path=/porn/%E7%99%BD%E7%9F%B3%E3%81%AA%E3%81%8A')
    });
    const browsePayload = await browseResponse.json();
    expect(browsePayload.counts.files).toBe(1);
    expect(browsePayload.files[0].davPath).toBe('/porn/白石なお/movie.mp4');
  });

  it('prepares a direct signed MTProto upload URL for external bridges', async () => {
    global.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      expect(url).toBe('https://bridge.example.com/healthz');
      return new Response(JSON.stringify({
        ok: true,
        authorized: true
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const env = { img_url: createKv() };
    const response = await mtprotoUpload({
      env: {
        TG_MT_BRIDGE_URL: 'https://bridge.example.com',
        TG_MT_BRIDGE_SECRET: 'secret',
        TG_Chat_ID: '-1002389146660',
        img_url: env.img_url
      },
      request: new Request('https://example.com/api/manage/mtproto/upload?path=/albums&name=clip.mp4&size=12&type=video/mp4')
    });

    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.mode).toBe('direct');
    expect(payload.uploadUrl).toContain('https://bridge.example.com/telegram/upload?');
    expect(payload.chunkSize).toBeNull();
  });

  it('prepares a chunked upload for large files when the bridge backend is workers-free', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      freePlanReady: true,
      authorized: true
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));

    const env = { img_url: createKv() };
    const response = await mtprotoUpload({
      env: {
        TG_MT_BRIDGE_URL: 'https://bridge.example.com',
        TG_MT_BRIDGE_SECRET: 'secret',
        TG_Chat_ID: '-1002389146660',
        img_url: env.img_url
      },
      request: new Request(`https://example.com/api/manage/mtproto/upload?path=/albums&name=big.mp4&size=${mtprotoUploadTest.WORKERS_DIRECT_UPLOAD_LIMIT + 1}&type=video/mp4`)
    });

    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.mode).toBe('chunked');
    expect(payload.chunkSize).toBe(mtprotoUploadTest.WORKERS_CHUNK_SIZE);
    expect(payload.totalParts).toBeGreaterThan(1);
    expect(payload.uploadUrl).toContain('/telegram/upload/chunk?');
  });

  it('stores a pending MTProto DAV target when finalize runs before webhook metadata arrives', async () => {
    const env = { img_url: createKv() };
    const response = await mtprotoUpload({
      env: {
        TG_MT_BRIDGE_URL: 'https://bridge.example.com',
        TG_MT_BRIDGE_SECRET: 'secret',
        TG_Chat_ID: '-1002389146660',
        img_url: env.img_url
      },
      request: new Request('https://example.com/api/manage/mtproto/upload', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          path: '/albums',
          fileName: 'clip.mp4',
          contentType: 'video/mp4',
          upload: {
            chatId: '-1002389146660',
            messageId: 88,
            fileName: 'clip.mp4',
            fileSize: 12,
            contentType: 'video/mp4',
            mediaKind: 'document'
          }
        })
      })
    });

    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.pending).toBe(true);
    expect(payload.claimed).toBe(false);
    expect(payload.target.davPath).toBe(buildMtprotoDesiredDavPath('/albums', 'clip.mp4'));
  });


  it('deletes encoded slash keys via KV-only delete', async () => {
    const env = {
      img_url: createKv({
        'abc/def.txt': {
          fileName: 'abc/def.txt',
          TimeStamp: 1
        }
      })
    };

    const response = await deleteKvRecord({
      env,
      params: { id: 'abc%2Fdef.txt' },
      request: new Request('https://example.com/api/manage/deleteKv/abc%2Fdef.txt', { method: 'POST' })
    });

    const payload = await response.json();
    expect(payload.kvDeleted).toBe(true);
    expect(await env.img_url.getWithMetadata('abc/def.txt')).toBeNull();
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
      request: new Request('https://example.com/api/manage/delete/abc.png', { method: 'POST' })
    });

    const payload = await response.json();
    expect(payload.telegramDeleted).toBe(true);
    expect(await env.img_url.getWithMetadata('abc.png')).toBeNull();
  });

  it('includes worker bridge health in telegram status', async () => {
    global.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/getMe')) {
        return new Response(JSON.stringify({
          ok: true,
          result: { id: 1, username: 'bot', can_read_all_group_messages: true }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      if (url.includes('/getWebhookInfo')) {
        return new Response(JSON.stringify({
          ok: true,
          result: { url: 'https://teleimg.example/api/telegram/webhook', pending_update_count: 3 }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      if (url === 'https://bridge.example.com/healthz') {
        return new Response(JSON.stringify({
          ok: true,
          freePlanReady: true,
          connected: true,
          authorized: true,
          cachedPeers: 4,
          lastDownloadAt: 1234
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const response = await telegramStatus({
      env: {
        TG_Bot_Token: 'token',
        TG_MT_BRIDGE_URL: 'https://bridge.example.com',
        img_url: createKv()
      },
      request: new Request('https://example.com/api/manage/telegram/status')
    });

    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.bridge.configured).toBe(true);
    expect(payload.bridge.backend).toBe('workers-free');
    expect(payload.bridge.ok).toBe(true);
    expect(payload.bridge.host).toBe('bridge.example.com');
    expect(payload.bridge.health.connected).toBe(true);
    expect(payload.bridge.health.cachedPeers).toBe(4);
  });

  it('runs bridge warmup and returns bridge summary', async () => {
    global.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === 'https://bridge.example.com/healthz') {
        return new Response(JSON.stringify({
          ok: true,
          freePlanReady: true,
          connected: true,
          authorized: true,
          cachedPeers: 2
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const response = await bridgeWarmup({
      env: {
        TG_MT_BRIDGE_URL: 'https://bridge.example.com',
        img_url: createKv()
      },
      request: new Request('https://example.com/api/manage/telegram/bridge-warmup', { method: 'POST' })
    });

    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.bridge.ok).toBe(true);
    expect(payload.bridge.backend).toBe('workers-free');
    expect(payload.message).toContain('桥接在线');
  });
});
