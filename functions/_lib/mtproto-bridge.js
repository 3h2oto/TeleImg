import { buildMtprotoBridgeDownloadUrl, hasMtprotoBridgeConfig, isTelegramLargeFileError } from '../../shared/mtproto-bridge.js';

export { hasMtprotoBridgeConfig, isTelegramLargeFileError };

export async function buildMtprotoBridgeRedirect(config, key, metadata) {
  if (!hasMtprotoBridgeConfig(config) || !metadata?.telegram?.chatId || !metadata?.telegram?.messageId) {
    return null;
  }

  return buildMtprotoBridgeDownloadUrl({
    baseUrl: config.TG_MT_BRIDGE_URL,
    secret: config.TG_MT_BRIDGE_SECRET,
    key,
    fileName: metadata?.fileName || key,
    telegram: metadata.telegram
  });
}
