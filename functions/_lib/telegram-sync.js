import { TELEGRAM_SYNC_STATE_KEY, getRecord, normalizeMetadata, readInternalJson, writeInternalJson } from './kv.js';
import { buildTelegramRecordFromUpdate } from './telegram.js';

function meaningfulFileName(name, key) {
  return typeof name === 'string' && name.trim().length > 0 && name !== key;
}

function mergeMetadata(key, existing, incoming) {
  const existingMetadata = existing || {};
  const incomingMetadata = incoming || {};
  const existingTelegram = existingMetadata.telegram || null;
  const incomingTelegram = incomingMetadata.telegram || null;
  const mergedTelegram = existingTelegram || incomingTelegram
    ? { ...(existingTelegram || {}), ...(incomingTelegram || {}) }
    : null;

  return normalizeMetadata(key, {
    ...existingMetadata,
    ...incomingMetadata,
    ListType: existingMetadata.ListType ?? incomingMetadata.ListType,
    Label: existingMetadata.Label ?? incomingMetadata.Label,
    liked: existingMetadata.liked ?? incomingMetadata.liked,
    fileName: meaningfulFileName(existingMetadata.fileName, key)
      ? existingMetadata.fileName
      : (incomingMetadata.fileName || existingMetadata.fileName || key),
    fileSize: incomingMetadata.fileSize || existingMetadata.fileSize || 0,
    source: existingMetadata.source === 'web-upload' && incomingMetadata.source === 'telegram-app'
      ? existingMetadata.source
      : (incomingMetadata.source || existingMetadata.source || 'telegram-app'),
    caption: incomingMetadata.caption || existingMetadata.caption || '',
    uploader: incomingMetadata.uploader || existingMetadata.uploader || null,
    telegram: mergedTelegram
  });
}

export async function getTelegramSyncState(env) {
  const state = await readInternalJson(env, TELEGRAM_SYNC_STATE_KEY);
  return {
    offset: Number.isFinite(state?.offset) ? state.offset : 0,
    lastUpdateId: Number.isFinite(state?.lastUpdateId) ? state.lastUpdateId : null,
    lastWebhookAt: Number.isFinite(state?.lastWebhookAt) ? state.lastWebhookAt : null,
    lastSyncAt: Number.isFinite(state?.lastSyncAt) ? state.lastSyncAt : null
  };
}

async function saveTelegramSyncState(env, patch) {
  const current = await getTelegramSyncState(env);
  const next = {
    ...current,
    ...patch
  };
  await writeInternalJson(env, TELEGRAM_SYNC_STATE_KEY, next);
  return next;
}

export async function upsertTelegramRecord(env, update, options = {}) {
  const record = buildTelegramRecordFromUpdate(update, options);
  if (!record) {
    return { stored: false, created: false, reason: 'unsupported-update' };
  }

  const existing = await getRecord(env, record.key);
  const metadata = mergeMetadata(record.key, existing.metadata, record.metadata);
  await env.img_url.put(record.key, existing.value ?? '', { metadata });

  return {
    stored: true,
    created: !existing.metadata,
    key: record.key,
    metadata
  };
}

export async function processTelegramUpdates(env, updates, options = {}) {
  const mode = options.mode || 'poll';
  let processed = 0;
  let stored = 0;
  let created = 0;
  let skipped = 0;
  let lastUpdateId = null;
  const keys = [];

  for (const update of updates || []) {
    processed += 1;
    if (Number.isFinite(update?.update_id)) {
      lastUpdateId = lastUpdateId == null ? update.update_id : Math.max(lastUpdateId, update.update_id);
    }

    const result = await upsertTelegramRecord(env, update, {
      source: options.source || 'telegram-app',
      viaWebhook: mode === 'webhook'
    });

    if (result.stored) {
      stored += 1;
      if (result.created) {
        created += 1;
      }
      keys.push(result.key);
    } else {
      skipped += 1;
    }
  }

  const patch = { lastUpdateId, ...(mode === 'webhook' ? { lastWebhookAt: Date.now() } : { lastSyncAt: Date.now() }) };
  if (mode !== 'webhook' && lastUpdateId != null) {
    patch.offset = lastUpdateId + 1;
  }

  const syncState = processed > 0 || mode !== 'webhook'
    ? await saveTelegramSyncState(env, patch)
    : await getTelegramSyncState(env);

  return {
    processed,
    stored,
    created,
    skipped,
    lastUpdateId,
    keys,
    syncState
  };
}
