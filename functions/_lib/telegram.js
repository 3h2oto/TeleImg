const TELEGRAM_PREFIX_RE = /^[A-Za-z0-9_-]{40,}$/;

function withoutExtension(key) {
  const index = key.lastIndexOf('.');
  return index > 0 ? key.slice(0, index) : key;
}

export function inferExtension(file) {
  const original = typeof file?.name === 'string' ? file.name : '';
  const extension = original.includes('.') ? original.split('.').pop() : '';
  const cleaned = String(extension || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  return cleaned || inferExtensionFromMime(file?.type);
}

function inferExtensionFromMime(mimeType) {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'video/mp4':
      return 'mp4';
    case 'audio/mpeg':
      return 'mp3';
    default:
      return 'bin';
  }
}

export function selectUploadEndpoint(file) {
  if (file.type.startsWith('image/')) return ['photo', 'sendPhoto'];
  if (file.type.startsWith('audio/')) return ['audio', 'sendAudio'];
  if (file.type.startsWith('video/')) return ['video', 'sendVideo'];
  return ['document', 'sendDocument'];
}

export function extractUploadedFileId(response) {
  if (!response?.ok || !response?.result) {
    return null;
  }

  const payload = response.result;
  if (Array.isArray(payload.photo) && payload.photo.length > 0) {
    return payload.photo.reduce((largest, current) => {
      return (largest.file_size || 0) > (current.file_size || 0) ? largest : current;
    }).file_id;
  }

  return payload.document?.file_id || payload.video?.file_id || payload.audio?.file_id || null;
}

export function isTelegramFileKey(key) {
  return TELEGRAM_PREFIX_RE.test(withoutExtension(key));
}

export function buildLegacyTelegraphUrl(key, search = '') {
  return `https://telegra.ph/file/${encodeURIComponent(key)}${search}`;
}

export async function lookupTelegramFilePath(env, fileId) {
  const url = `https://api.telegram.org/bot${env.TG_Bot_Token}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const response = await fetch(url);

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  return data?.ok ? data?.result?.file_path ?? null : null;
}

export function getTelegramFileId(key) {
  return withoutExtension(key);
}
