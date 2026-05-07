import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:sockets', () => ({
  connect: vi.fn()
}), { virtual: true });

vi.mock('telegram', () => {
  class SaveBigFilePart {
    constructor(values) {
      Object.assign(this, values);
    }
  }

  class InputFileBig {
    constructor(values) {
      Object.assign(this, values);
    }
  }

  return {
    Api: {
      upload: {
        SaveBigFilePart
      },
      InputFileBig
    },
    TelegramClient: class TelegramClient {},
    utils: {
      getAppropriatedPartSize: () => 1
    }
  };
});

vi.mock('telegram/sessions/index.js', () => ({
  StringSession: class StringSession {}
}));

const { MtprotoBridgeDO } = await import('../workers-mtproto-bridge/src/index.js');

function createChunkUrl({ session = 'session-1', fileSize = 3000, totalParts = 3, part = 0 } = {}) {
  return new URL(`https://example.com/telegram/upload/chunk?chatId=-10001&session=${session}&name=demo.mp4&size=${fileSize}&type=video/mp4&parts=${totalParts}&part=${part}${part === totalParts - 1 ? '&final=1' : ''}`);
}

function createChunkRequest(size, fillByte) {
  return new Request('https://example.com/telegram/upload/chunk', {
    method: 'POST',
    body: new Uint8Array(size).fill(fillByte)
  });
}

function createBridgeHarness() {
  const invokeCalls = [];
  const sendFileCalls = [];
  const bridge = new MtprotoBridgeDO({}, {});

  bridge.getClient = vi.fn(async () => ({
    invoke: vi.fn(async (request) => {
      invokeCalls.push({
        filePart: request.filePart,
        bytes: Buffer.from(request.bytes)
      });
      return true;
    }),
    sendFile: vi.fn(async (entity, payload) => {
      sendFileCalls.push({ entity, payload });
      return {
        chatId: {
          toString: () => '-10001'
        },
        id: 77
      };
    })
  }));

  bridge.resolveEntity = vi.fn(async () => ({ kind: 'chat-entity' }));

  return {
    bridge,
    invokeCalls,
    sendFileCalls
  };
}

describe('workers mtproto bridge chunk uploads', () => {
  it('accepts out-of-order browser chunks and finalizes exactly once', async () => {
    const { bridge, invokeCalls, sendFileCalls } = createBridgeHarness();

    const secondResponse = await bridge.handleChunkUpload(createChunkRequest(1000, 0x62), createChunkUrl({ part: 1 }));
    const secondPayload = await secondResponse.json();
    expect(secondResponse.status).toBe(200);
    expect(secondPayload.complete).toBe(false);
    expect(secondPayload.receivedParts).toBe(1);
    expect(secondPayload.flushedParts).toBe(0);
    expect(invokeCalls).toHaveLength(0);

    const firstResponse = await bridge.handleChunkUpload(createChunkRequest(1000, 0x61), createChunkUrl({ part: 0 }));
    const firstPayload = await firstResponse.json();
    expect(firstResponse.status).toBe(200);
    expect(firstPayload.complete).toBe(false);
    expect(firstPayload.receivedParts).toBe(2);
    expect(firstPayload.flushedParts).toBe(2);

    const finalResponse = await bridge.handleChunkUpload(createChunkRequest(1000, 0x63), createChunkUrl({ part: 2 }));
    const finalPayload = await finalResponse.json();
    expect(finalResponse.status).toBe(201);
    expect(finalPayload.complete).toBe(true);
    expect(finalPayload.upload.messageId).toBe(77);
    expect(invokeCalls.length).toBeGreaterThan(0);
    expect(invokeCalls[0]?.filePart).toBe(0);
    expect(sendFileCalls).toHaveLength(1);

    const duplicateResponse = await bridge.handleChunkUpload(createChunkRequest(1000, 0x63), createChunkUrl({ part: 2 }));
    const duplicatePayload = await duplicateResponse.json();
    expect(duplicateResponse.status).toBe(200);
    expect(duplicatePayload.complete).toBe(true);
    expect(duplicatePayload.duplicate).toBe(true);
    expect(duplicatePayload.upload.messageId).toBe(77);
    expect(sendFileCalls).toHaveLength(1);
  });
});
