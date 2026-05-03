import { describe, expect, it } from 'vitest';

import { onRequest as editName } from '../functions/api/manage/editName/[id].js';
import { onRequest as list } from '../functions/api/manage/list.js';
import { onRequest as toggleLike } from '../functions/api/manage/toggleLike/[id].js';
import { createKv } from './helpers.js';

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
});
