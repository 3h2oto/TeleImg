import { describe, expect, it } from 'vitest';

import {
  buildMtprotoBridgeDownloadUrl,
  buildMtprotoBridgePayload,
  buildMtprotoBridgeUploadPayload,
  buildMtprotoBridgeUploadUrl,
  isMtprotoBridgeRequestExpired,
  isMtprotoBridgeUploadRequestExpired,
  signMtprotoBridgePayload,
  signMtprotoBridgeUploadPayload,
  verifyMtprotoBridgePayload,
  verifyMtprotoBridgeUploadPayload
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

  it('builds and verifies signed upload payloads', async () => {
    const payload = buildMtprotoBridgeUploadPayload({
      chatId: '-10001',
      fileName: 'demo.mp4',
      fileSize: 1234,
      contentType: 'video/mp4',
      sessionId: 'session-1',
      totalParts: 3,
      expiresAt: 1_800_000
    });

    expect(payload).toEqual({
      chatId: '-10001',
      name: 'demo.mp4',
      size: '1234',
      type: 'video/mp4',
      session: 'session-1',
      parts: '3',
      expires: '1800'
    });

    const signature = await signMtprotoBridgeUploadPayload('secret', payload);
    expect(signature).toBeTruthy();
    await expect(verifyMtprotoBridgeUploadPayload('secret', payload, signature)).resolves.toBe(true);
    await expect(verifyMtprotoBridgeUploadPayload('wrong', payload, signature)).resolves.toBe(false);
  });

  it('builds a signed chunked upload URL', async () => {
    const url = await buildMtprotoBridgeUploadUrl({
      baseUrl: 'https://bridge.example.com/base/',
      secret: 'secret',
      chatId: '-10099',
      fileName: 'Demo Video.mp4',
      fileSize: 999,
      contentType: 'video/mp4',
      sessionId: 'session-x',
      totalParts: 5,
      chunked: true,
      expiresAt: 10_000
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://bridge.example.com');
    expect(parsed.pathname).toBe('/telegram/upload/chunk');
    expect(parsed.searchParams.get('chatId')).toBe('-10099');
    expect(parsed.searchParams.get('name')).toBe('Demo Video.mp4');
    expect(parsed.searchParams.get('size')).toBe('999');
    expect(parsed.searchParams.get('session')).toBe('session-x');
    expect(parsed.searchParams.get('parts')).toBe('5');
    expect(parsed.searchParams.get('sig')).toBeTruthy();
  });

  it('detects expired signed upload payloads', () => {
    expect(isMtprotoBridgeUploadRequestExpired({ expires: '100' }, 101_000)).toBe(true);
    expect(isMtprotoBridgeUploadRequestExpired({ expires: '100' }, 99_000)).toBe(false);
  });
});
