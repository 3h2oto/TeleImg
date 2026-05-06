import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { onRequest } from '../functions/dav/[[path]].js';
import { listRecords } from '../functions/_lib/kv.js';
import { getDavEntryKey, getDavTombstoneKey } from '../functions/_lib/dav.js';
import { createKv } from './helpers.js';

const originalFetch = global.fetch;

beforeEach(() => {
  let uploadCount = 0;
  global.fetch = vi.fn(async (input) => {
    const url = typeof input === 'string'
      ? input
      : (input?.url || (input instanceof URL ? input.toString() : ''));
    if (url.includes('/sendDocument')) {
      uploadCount += 1;
      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 99 + uploadCount,
          date: 1710000000,
          chat: { id: -10001, type: 'channel', title: 'Uploads' },
          document: {
            file_id: `telegramFileId123456789012345678901234567890123456${uploadCount}`,
            file_unique_id: `unique${uploadCount}`,
            file_name: 'hello.txt',
            file_size: 14,
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
  it('projects existing TeleImg records into DAV root', async () => {
    const env = {
      img_url: createKv({
        'telegram-file-id-1.jpg': {
          fileName: 'existing-photo.jpg',
          fileSize: 123,
          TimeStamp: 10
        }
      })
    };

    const propfindResponse = await onRequest({
      env,
      request: new Request('https://example.com/dav', {
        method: 'PROPFIND',
        headers: { depth: '1' }
      })
    });

    expect(propfindResponse.status).toBe(207);
    const body = await propfindResponse.text();
    expect(body).toContain('/dav/existing-photo.jpg');

    const getResponse = await onRequest({
      env,
      request: new Request('https://example.com/dav/existing-photo.jpg', {
        method: 'GET'
      })
    });
    expect(getResponse.status).toBe(200);
    expect(await getResponse.text()).toBe('hello');
  });

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

  it('supports PUT, COPY, MOVE, GET and DELETE for files', async () => {
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

    const copyResponse = await onRequest({
      env,
      request: new Request('https://example.com/dav/docs/hello.txt', {
        method: 'COPY',
        headers: { destination: 'https://example.com/dav/docs/copied.txt' }
      })
    });
    expect(copyResponse.status).toBe(201);

    const originalEntry = JSON.parse(await env.img_url.get(getDavEntryKey('/docs/hello.txt')));
    const copiedEntry = JSON.parse(await env.img_url.get(getDavEntryKey('/docs/copied.txt')));
    expect(originalEntry.storageKey).not.toBe(copiedEntry.storageKey);

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
      request: new Request('https://example.com/dav/docs/copied.txt', {
        method: 'GET'
      })
    });
    expect(getResponse.status).toBe(200);
    expect(await getResponse.text()).toBe('hello');

    const movedGetResponse = await onRequest({
      env,
      request: new Request('https://example.com/dav/docs/renamed.txt', {
        method: 'GET'
      })
    });
    expect(movedGetResponse.status).toBe(200);
    expect(await movedGetResponse.text()).toBe('hello');

    const deleteCopiedResponse = await onRequest({
      env,
      request: new Request('https://example.com/dav/docs/copied.txt', {
        method: 'DELETE'
      })
    });
    expect(deleteCopiedResponse.status).toBe(204);

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

  it('keeps projected root moves in sync with admin metadata and hides the old path', async () => {
    const env = {
      TG_Bot_Token: 'token',
      TG_Chat_ID: '-10001',
      img_url: createKv({
        'photo-1777973665-36.jpg': {
          fileName: 'photo-1777973665-36.jpg',
          fileSize: 175000,
          TimeStamp: 1710001000
        }
      })
    };

    const initialList = await onRequest({
      env,
      request: new Request('https://example.com/dav', {
        method: 'PROPFIND',
        headers: { depth: '1' }
      })
    });
    expect(initialList.status).toBe(207);
    expect(await initialList.text()).toContain('/dav/photo-1777973665-36.jpg');

    const moveResponse = await onRequest({
      env,
      request: new Request('https://example.com/dav/photo-1777973665-36.jpg', {
        method: 'MOVE',
        headers: {
          destination: 'https://example.com/dav/crabsoft.jpg'
        }
      })
    });
    expect(moveResponse.status).toBe(201);

    const records = await listRecords(env, { limit: 10 });
    expect(records.keys).toHaveLength(1);
    expect(records.keys[0].name).toBe('photo-1777973665-36.jpg');
    expect(records.keys[0].metadata.fileName).toBe('crabsoft.jpg');

    const rootAfterMove = await onRequest({
      env,
      request: new Request('https://example.com/dav', {
        method: 'PROPFIND',
        headers: { depth: '1' }
      })
    });
    expect(rootAfterMove.status).toBe(207);
    const rootBody = await rootAfterMove.text();
    expect(rootBody).toContain('/dav/crabsoft.jpg');
    expect(rootBody).not.toContain('/dav/photo-1777973665-36.jpg');

    const oldPathDelete = await onRequest({
      env,
      request: new Request('https://example.com/dav/photo-1777973665-36.jpg', {
        method: 'DELETE'
      })
    });
    expect(oldPathDelete.status).toBe(404);

    const newPathDelete = await onRequest({
      env,
      request: new Request('https://example.com/dav/crabsoft.jpg', {
        method: 'DELETE'
      })
    });
    expect(newPathDelete.status).toBe(204);
  });

  it('prunes stale duplicate DAV aliases before listing or deleting', async () => {
    const storageKey = 'photo-1777973665-36.jpg';
    const env = {
      TG_Bot_Token: 'token',
      TG_Chat_ID: '-10001',
      img_url: createKv({
        [storageKey]: {
          fileName: 'crabsoft.jpg',
          fileSize: 175000,
          TimeStamp: 1710001000
        },
        [getDavEntryKey('/photo-1777973665-36.jpg')]: {
          value: JSON.stringify({
            kind: 'file',
            path: '/photo-1777973665-36.jpg',
            name: 'photo-1777973665-36.jpg',
            storageKey,
            size: 175000,
            contentType: 'image/jpeg',
            createdAt: 1710001000,
            updatedAt: 1710001000
          })
        },
        [getDavEntryKey('/crabsoft.jpg')]: {
          value: JSON.stringify({
            kind: 'file',
            path: '/crabsoft.jpg',
            name: 'crabsoft.jpg',
            storageKey,
            size: 175000,
            contentType: 'image/jpeg',
            createdAt: 1710001001,
            updatedAt: 1710001002
          })
        }
      })
    };

    const rootResponse = await onRequest({
      env,
      request: new Request('https://example.com/dav', {
        method: 'PROPFIND',
        headers: { depth: '1' }
      })
    });
    expect(rootResponse.status).toBe(207);
    const rootBody = await rootResponse.text();
    expect(rootBody).toContain('/dav/crabsoft.jpg');
    expect(rootBody).not.toContain('/dav/photo-1777973665-36.jpg');

    const oldPathDelete = await onRequest({
      env,
      request: new Request('https://example.com/dav/photo-1777973665-36.jpg', {
        method: 'DELETE'
      })
    });
    expect(oldPathDelete.status).toBe(404);

    const newPathDelete = await onRequest({
      env,
      request: new Request('https://example.com/dav/crabsoft.jpg', {
        method: 'DELETE'
      })
    });
    expect(newPathDelete.status).toBe(204);
  });

  it('drops ghost DAV aliases whose backing Telegram key was only resurrected by file access', async () => {
    const storageKey = 'BQACAgEAAyEGAASOZ3wkAAMqaft4N_wLE7pymfBTuT3HYAcMwhIAAp4IAAK9l9hHk8sxoOTIB4Y7BA.txt';
    const ghostPath = '/dav-http-probe-1778087990.txt';
    const env = {
      img_url: createKv({
        [storageKey]: {
          fileName: storageKey,
          fileSize: 0,
          TimeStamp: 1778090629334,
          source: 'unknown'
        },
        [getDavEntryKey(ghostPath)]: {
          value: JSON.stringify({
            kind: 'file',
            path: ghostPath,
            name: 'dav-http-probe-1778087990.txt',
            storageKey,
            size: 17,
            contentType: 'text/plain',
            createdAt: 1778088004294,
            updatedAt: 1778088004294
          })
        }
      })
    };

    const rootResponse = await onRequest({
      env,
      request: new Request('https://example.com/dav', {
        method: 'PROPFIND',
        headers: { depth: '1' }
      })
    });
    expect(rootResponse.status).toBe(207);
    const rootBody = await rootResponse.text();
    expect(rootBody).not.toContain('/dav/dav-http-probe-1778087990.txt');
    expect(await env.img_url.getWithMetadata(storageKey)).toBeNull();
    expect(await env.img_url.get(getDavEntryKey(ghostPath))).toBeNull();
  });

  it('suppresses tombstoned DAV paths even if stale storage metadata is still visible', async () => {
    const storageKey = 'BQACAgEAAyEGAASOZ3wkAAMtaft6F-ANezHGnmd2H_6l17axrzwAAqMIAAK9l9hHzOJE85QPWYM7BA.txt';
    const path = '/dav-inspect-1778088468.txt';
    const tombstoneAt = Date.now();
    const env = {
      img_url: createKv({
        [storageKey]: {
          fileName: 'dav-inspect-1778088468.txt',
          fileSize: 17,
          TimeStamp: 1778088471584,
          source: 'web-upload',
          telegram: {
            chatId: '-10001',
            messageId: 45,
            fileId: storageKey.replace(/\.txt$/, '')
          }
        },
        [getDavEntryKey(path)]: {
          value: JSON.stringify({
            kind: 'file',
            path,
            name: 'dav-inspect-1778088468.txt',
            storageKey,
            size: 17,
            contentType: 'text/plain',
            createdAt: 1778088471584,
            updatedAt: 1778091607465
          })
        },
        [getDavTombstoneKey(path)]: {
          value: JSON.stringify({
            path,
            createdAt: tombstoneAt,
            expiresAt: tombstoneAt + 15 * 60 * 1000
          })
        }
      })
    };

    const exactResponse = await onRequest({
      env,
      request: new Request('https://example.com/dav/dav-inspect-1778088468.txt', {
        method: 'PROPFIND',
        headers: { depth: '0' }
      })
    });
    expect(exactResponse.status).toBe(404);

    const rootResponse = await onRequest({
      env,
      request: new Request('https://example.com/dav', {
        method: 'PROPFIND',
        headers: { depth: '1' }
      })
    });
    expect(rootResponse.status).toBe(207);
    const rootBody = await rootResponse.text();
    expect(rootBody).not.toContain('/dav/dav-inspect-1778088468.txt');
  });
});
