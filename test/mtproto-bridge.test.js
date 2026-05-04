import { describe, expect, it } from 'vitest';

import {
  buildMtprotoBridgeDownloadUrl,
  buildMtprotoBridgePayload,
  isMtprotoBridgeRequestExpired,
  signMtprotoBridgePayload,
  verifyMtprotoBridgePayload
} from '../shared/mtproto-bridge.js';

describe('mtproto bridge helpers', () => {
  it('builds and verifies signed bridge payloads', async () => {
    const payload = buildMtprotoBridgePayload({
      key: 'abc.mp4',
      fileName: 'demo.mp4',
      telegram: {
        chatId: '-10001',
        messageId: 42
      },
      expiresAt: 1_800_000
    });

    expect(payload).toEqual({
      chatId: '-10001',
      messageId: '42',
      key: 'abc.mp4',
      name: 'demo.mp4',
      expires: '1800'
    });

    const signature = await signMtprotoBridgePayload('secret', payload);
    expect(signature).toBeTruthy();
    await expect(verifyMtprotoBridgePayload('secret', payload, signature)).resolves.toBe(true);
    await expect(verifyMtprotoBridgePayload('wrong', payload, signature)).resolves.toBe(false);
  });

  it('builds a signed bridge URL', async () => {
    const url = await buildMtprotoBridgeDownloadUrl({
      baseUrl: 'https://bridge.example.com/prefix/',
      secret: 'secret',
      key: 'demo.mp4',
      fileName: 'Demo Video.mp4',
      telegram: {
        chatId: '-10099',
        messageId: 9
      },
      expiresAt: 10_000
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://bridge.example.com');
    expect(parsed.pathname).toBe('/telegram/file');
    expect(parsed.searchParams.get('chatId')).toBe('-10099');
    expect(parsed.searchParams.get('messageId')).toBe('9');
    expect(parsed.searchParams.get('key')).toBe('demo.mp4');
    expect(parsed.searchParams.get('name')).toBe('Demo Video.mp4');
    expect(parsed.searchParams.get('sig')).toBeTruthy();
  });

  it('detects expired signed payloads', () => {
    expect(isMtprotoBridgeRequestExpired({ expires: '100' }, 101_000)).toBe(true);
    expect(isMtprotoBridgeRequestExpired({ expires: '100' }, 99_000)).toBe(false);
  });
});
