import { describe, expect, it } from 'vitest';

import { onRequest } from '../functions/upload.js';

describe('/upload', () => {
  it('returns 503 when Telegram credentials are missing', async () => {
    const body = new FormData();
    body.append('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));

    const response = await onRequest({
      env: {},
      request: new Request('https://example.com/upload', {
        method: 'POST',
        body
      })
    });

    expect(response.status).toBe(503);
  });
});
