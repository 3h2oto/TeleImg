const ADMIN_BUS_KEY = '__teleimg_admin_bus__';

export const formatBytes = (value) => {
  const size = Number(value || 0);
  if (!size) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let current = size;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current.toFixed(current >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
};

export const formatTime = (value) => {
  const time = Number(value || 0);
  if (!time) return '未知时间';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(time));
};

export const isVideo = (name = '') => /\.(mp4|webm|mov|m4v)$/i.test(name);
export const isAudio = (name = '') => /\.(mp3|wav|ogg|m4a|flac)$/i.test(name);

export const normalizePath = (path) => {
  if (!path || path === '/') return '/';
  const parts = String(path).split('/').filter(Boolean);
  return parts.length ? `/${parts.join('/')}` : '/';
};

export const getParentPath = (path) => {
  const normalized = normalizePath(path);
  if (normalized === '/') return null;
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
};

export const getBaseName = (path) => {
  const normalized = normalizePath(path);
  if (normalized === '/') return '根目录';
  return normalized.slice(normalized.lastIndexOf('/') + 1);
};

export const joinPath = (parentPath, leaf) => {
  const cleanLeaf = String(leaf || '').trim().replace(/^\/+|\/+$/g, '');
  if (!cleanLeaf) {
    return normalizePath(parentPath);
  }
  return normalizePath(parentPath) === '/' ? `/${cleanLeaf}` : `${normalizePath(parentPath)}/${cleanLeaf}`;
};

export const davUrl = (path) => {
  const normalized = normalizePath(path);
  if (normalized === '/') return '/dav/';
  return `/dav/${normalized.slice(1).split('/').map((part) => encodeURIComponent(part)).join('/')}`;
};

export const buildBreadcrumbs = (path) => {
  const normalized = normalizePath(path);
  if (normalized === '/') {
    return [{ path: '/', label: '根目录' }];
  }

  const parts = normalized.split('/').filter(Boolean);
  const crumbs = [{ path: '/', label: '根目录' }];
  let current = '';
  parts.forEach((part) => {
    current += `/${part}`;
    crumbs.push({ path: current, label: part });
  });
  return crumbs;
};

export const matchesSearch = (item, search) => {
  if (!search) return true;
  const keyword = search.toLowerCase();
  const haystacks = [
    item.name,
    item.davPath,
    item.davName,
    item.metadata?.fileName,
    item.metadata?.caption,
    item.metadata?.uploader?.displayName,
    item.metadata?.telegram?.chatTitle,
    item.metadata?.telegram?.mediaKind,
    item.metadata?.source
  ].filter(Boolean).map((value) => String(value).toLowerCase());
  return haystacks.some((value) => value.includes(keyword));
};

function getInitialStateFromLocation() {
  const locationUrl = new URL(window.location.href);
  return {
    view: locationUrl.searchParams.get('view') === 'waterfall' ? 'waterfall' : 'grid',
    search: locationUrl.searchParams.get('search') || '',
    currentPath: normalizePath(locationUrl.searchParams.get('folder') || '/')
  };
}

function syncUrl(state) {
  const nextUrl = new URL(window.location.href);
  if (state.search) {
    nextUrl.searchParams.set('search', state.search);
  } else {
    nextUrl.searchParams.delete('search');
  }

  if (state.view && state.view !== 'grid') {
    nextUrl.searchParams.set('view', state.view);
  } else {
    nextUrl.searchParams.delete('view');
  }

  if (state.currentPath && state.currentPath !== '/') {
    nextUrl.searchParams.set('folder', state.currentPath);
  } else {
    nextUrl.searchParams.delete('folder');
  }

  history.replaceState({}, '', nextUrl);
}

function ensureExpandedAncestors(state, path) {
  let current = normalizePath(path);
  state.expandedFolders.add('/');
  while (current && current !== '/') {
    state.expandedFolders.add(current);
    current = getParentPath(current);
  }
}

function createUploadTask(file, currentPath) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    file,
    fileName: file.name,
    fileSize: Number(file.size || 0),
    contentType: file.type || 'application/octet-stream',
    path: currentPath,
    mode: null,
    sessionId: '',
    status: 'queued',
    phase: 'queued',
    progress: 0,
    uploadedBytes: 0,
    completedParts: 0,
    completedPartNumbers: [],
    totalParts: 1,
    retryCount: 0,
    error: '',
    result: null,
    canRetry: false,
    expiresAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

const UPLOAD_URL_REFRESH_WINDOW_MS = 45 * 1000;
const DEFAULT_CHUNK_UPLOAD_CONCURRENCY = 6;

function uploadExpiresAtMs(taskOrPrepared) {
  const expiresAt = Number(taskOrPrepared?.expiresAt || 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    return 0;
  }
  return expiresAt * 1000;
}

function shouldRefreshUploadSignature(taskOrPrepared) {
  const expiresAt = uploadExpiresAtMs(taskOrPrepared);
  if (!expiresAt) {
    return false;
  }
  return (expiresAt - Date.now()) <= UPLOAD_URL_REFRESH_WINDOW_MS;
}

function isExpiredUploadErrorMessage(message) {
  return /signed upload url has expired/i.test(String(message || ''));
}

function getChunkBounds(part, chunkSize, fileSize) {
  const start = part * chunkSize;
  const end = Math.min(fileSize, start + chunkSize);
  return {
    start,
    end,
    size: Math.max(0, end - start)
  };
}

function normalizeCompletedPartNumbers(parts, totalParts) {
  if (!Array.isArray(parts) || totalParts <= 0) {
    return [];
  }

  return [...new Set(parts
    .map((value) => Number.parseInt(String(value ?? ''), 10))
    .filter((value) => Number.isFinite(value) && value >= 0 && value < totalParts))]
    .sort((left, right) => left - right);
}

export function ensureAdminBus() {
  if (typeof window === 'undefined') {
    return null;
  }

  if (window[ADMIN_BUS_KEY]) {
    return window[ADMIN_BUS_KEY];
  }

  const initial = getInitialStateFromLocation();
  const subscribers = new Set();
  const state = {
    ...initial,
    currentBrowse: null,
    currentItems: [],
    favoriteItems: [],
    folderCache: new Map(),
    expandedFolders: new Set(['/']),
    selectedKey: null,
    telegramStatus: null,
    uploadTasks: [],
    statusMessage: '正在加载...',
    statusTone: 'busy'
  };

  let started = false;
  let startPromise = null;

  const notify = () => {
    subscribers.forEach((callback) => callback(state));
  };

  const setStatus = (message, tone = 'idle') => {
    state.statusMessage = message;
    state.statusTone = tone;
    notify();
  };

  const getUploadTasks = () => [...state.uploadTasks].sort((left, right) => right.updatedAt - left.updatedAt);

  const replaceUploadTask = (taskId, updater) => {
    const index = state.uploadTasks.findIndex((task) => task.id === taskId);
    if (index < 0) {
      return null;
    }

    const current = state.uploadTasks[index];
    const next = {
      ...current,
      ...(typeof updater === 'function' ? updater(current) : updater),
      updatedAt: Date.now()
    };
    state.uploadTasks.splice(index, 1, next);
    notify();
    return next;
  };

  const appendUploadTask = (task) => {
    state.uploadTasks.unshift(task);
    if (state.uploadTasks.length > 12) {
      state.uploadTasks.length = 12;
    }
    notify();
    return task;
  };

  const removeUploadTask = (taskId) => {
    const index = state.uploadTasks.findIndex((task) => task.id === taskId);
    if (index >= 0) {
      state.uploadTasks.splice(index, 1);
      notify();
    }
  };

  const getFilteredItems = () => state.currentItems.filter((item) => matchesSearch(item, state.search));
  const getSelectedItem = () => state.currentItems.find((item) => item.name === state.selectedKey) || null;

  const selectItem = (key) => {
    state.selectedKey = key || null;
    notify();
  };

  const selectFirstVisible = () => {
    const [first] = getFilteredItems();
    state.selectedKey = first?.name || null;
  };

  const fetchTelegramStatus = async () => {
    const response = await fetch('/api/manage/telegram/status');
    const payload = await response.json().catch(() => ({ error: '无法解析 Telegram 状态。' }));
    if (!response.ok) {
      throw new Error(payload?.error || '获取 Telegram 状态失败。');
    }
    state.telegramStatus = payload;
    notify();
    return payload;
  };

  const fetchFavorites = async () => {
    const response = await fetch('/api/manage/favorites?limit=24', {
      headers: { accept: 'application/json' }
    });
    const payload = await response.json().catch(() => ({ error: '无法解析收藏列表。' }));
    if (!response.ok) {
      throw new Error(payload?.error || '获取收藏列表失败。');
    }
    state.favoriteItems = Array.isArray(payload.items) ? payload.items : [];
    notify();
    return state.favoriteItems;
  };

  const postJson = async (path) => {
    const response = await fetch(path, { method: 'POST' });
    const payload = await response.json().catch(() => ({ error: '无法解析接口返回。' }));
    if (!response.ok) {
      throw new Error(payload?.error || payload?.hint || '操作失败。');
    }
    return payload;
  };

  const fetchFolderBrowse = async (path, { force = false } = {}) => {
    const normalized = normalizePath(path);
    if (!force && state.folderCache.has(normalized)) {
      return state.folderCache.get(normalized);
    }

    const response = await fetch(`/api/manage/dav/browse?path=${encodeURIComponent(normalized)}`, {
      headers: { accept: 'application/json' }
    });
    const payload = await response.json().catch(() => ({ error: '无法解析目录响应。' }));
    if (!response.ok) {
      throw new Error(payload?.error || '目录加载失败。');
    }

    state.folderCache.set(normalized, payload);
    return payload;
  };

  const openFolder = async (path, { force = false, silent = false } = {}) => {
    const normalized = normalizePath(path);
    if (!silent) {
      setStatus(`正在加载目录 ${normalized} ...`, 'busy');
    }

    const payload = await fetchFolderBrowse(normalized, { force });
    state.currentPath = normalized;
    state.currentBrowse = payload;
    state.currentItems = payload.files || [];
    ensureExpandedAncestors(state, normalized);

    if (!state.currentItems.some((item) => item.name === state.selectedKey)) {
      selectFirstVisible();
    }

    syncUrl(state);
    notify();
    if (!silent) {
      setStatus(`目录 ${normalized} 已加载。`, 'success');
    }
    return payload;
  };

  const bootstrapFolders = async () => {
    await fetchFolderBrowse('/', { force: true });
    if (state.currentPath === '/') {
      await openFolder('/', { force: true, silent: true });
      return;
    }

    const ancestors = [];
    let current = getParentPath(state.currentPath);
    while (current && current !== '/') {
      ancestors.unshift(current);
      current = getParentPath(current);
    }

    for (const ancestor of ancestors) {
      await fetchFolderBrowse(ancestor, { force: true });
    }

    await openFolder(state.currentPath, { force: true, silent: true });
  };

  const start = async () => {
    if (started) {
      return startPromise;
    }

    started = true;
    startPromise = Promise.allSettled([
      fetchTelegramStatus(),
      bootstrapFolders(),
      fetchFavorites()
    ]).then(async (results) => {
      const folderResult = results[1];
      if (folderResult.status === 'rejected') {
        state.currentPath = '/';
        await openFolder('/', { force: true, silent: true }).catch(() => {});
      }

      if (!getSelectedItem()) {
        selectFirstVisible();
      }

      const rejected = results.find((item) => item.status === 'rejected');
      if (rejected) {
        const reason = rejected.reason instanceof Error ? rejected.reason.message : '初始化失败。';
        setStatus(reason, 'error');
      } else {
        setStatus(`目录 ${state.currentPath} 已加载。`, 'success');
      }
    });

    return startPromise;
  };

  const setSearch = (value) => {
    state.search = String(value || '').trim();
    if (!getFilteredItems().some((item) => item.name === state.selectedKey)) {
      selectFirstVisible();
    }
    syncUrl(state);
    notify();
  };

  const toggleView = () => {
    state.view = state.view === 'grid' ? 'waterfall' : 'grid';
    syncUrl(state);
    notify();
  };

  const refreshCurrentFolder = async () => {
    state.folderCache.delete(state.currentPath);
    const parentPath = getParentPath(state.currentPath);
    if (parentPath) {
      state.folderCache.delete(parentPath);
    }
    await openFolder(state.currentPath, { force: true });
  };

  const toggleFolderExpanded = async (path) => {
    const normalized = normalizePath(path);
    if (state.expandedFolders.has(normalized)) {
      state.expandedFolders.delete(normalized);
      notify();
      return;
    }

    state.expandedFolders.add(normalized);
    notify();
    await fetchFolderBrowse(normalized, { force: false });
    notify();
  };

  const createFolder = async (folderName) => {
    const leaf = String(folderName || '').trim().replace(/^\/+|\/+$/g, '');
    if (!leaf) {
      throw new Error('目录名不能为空。');
    }

    const response = await fetch(davUrl(joinPath(state.currentPath, leaf)), {
      method: 'MKCOL'
    });

    if (!response.ok) {
      const message = await response.text().catch(() => '创建目录失败。');
      throw new Error(message || '创建目录失败。');
    }

    state.folderCache.delete(state.currentPath);
    await openFolder(state.currentPath, { force: true });
    setStatus(`目录 ${leaf} 已创建。`, 'success');
  };

  const deleteCurrentFolder = async () => {
    if (state.currentPath === '/') {
      throw new Error('根目录不能删除。');
    }

    const currentPath = state.currentPath;
    const parentPath = getParentPath(currentPath) || '/';
    const response = await fetch(davUrl(currentPath), { method: 'DELETE' });
    if (!response.ok) {
      const message = await response.text().catch(() => '删除目录失败。');
      throw new Error(message || '删除目录失败。');
    }

    state.folderCache.delete(currentPath);
    state.folderCache.delete(parentPath);
    state.expandedFolders.delete(currentPath);
    await openFolder(parentPath, { force: true });
    setStatus(`目录 ${currentPath} 已删除。`, 'success');
  };

  const moveDavFile = async (item, nextName) => {
    const currentPath = item.davPath || joinPath(state.currentPath, item.davName || item.metadata?.fileName || item.name);
    const parentPath = getParentPath(currentPath) || '/';
    const destinationPath = joinPath(parentPath, nextName);
    const response = await fetch(davUrl(currentPath), {
      method: 'MOVE',
      headers: {
        destination: new URL(davUrl(destinationPath), window.location.origin).toString()
      }
    });

    if (!response.ok) {
      const message = await response.text().catch(() => 'DAV 重命名失败。');
      throw new Error(message || 'DAV 重命名失败。');
    }

    state.folderCache.delete(parentPath);
    await openFolder(parentPath, { force: true });
    await fetchFavorites().catch(() => {});
    setStatus('文件名已更新。', 'success');
  };

  const performItemAction = async (action, key) => {
    const current = state.currentItems.find((item) => item.name === key)
      || state.favoriteItems.find((item) => item.name === key);
    if (!current) {
      throw new Error('找不到当前文件。');
    }

    if (action === 'delete' && current.davPath) {
      const response = await fetch(davUrl(current.davPath), { method: 'DELETE' });
      if (!response.ok) {
        const message = await response.text().catch(() => '真实删除失败。');
        throw new Error(message || '真实删除失败。');
      }

      state.folderCache.delete(state.currentPath);
      await openFolder(state.currentPath, { force: true });
      await fetchFavorites().catch(() => {});
      setStatus('真实删除完成。', 'success');
      return;
    }

    const endpoint = {
      like: 'toggleLike',
      delete: 'delete',
      'delete-kv': 'deleteKv'
    }[action];

    if (!endpoint) {
      throw new Error('未知操作。');
    }

    const response = await fetch(`/api/manage/${endpoint}/${encodeURIComponent(key)}`, { method: 'POST' });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error || `${action} 失败。`);
    }

    const message = payload?.warning || payload?.message || (action === 'delete-kv' ? '仅删 KV 完成。' : `${action} 完成。`);
    state.folderCache.delete(state.currentPath);
    await openFolder(state.currentPath, { force: true });
    await fetchFavorites().catch(() => {});
    setStatus(message, payload?.warning ? 'busy' : 'success');
  };

  const triggerTelegramAction = async (action) => {
    if (action === 'telegram-status') {
      setStatus('正在获取 Telegram 状态...', 'busy');
      await fetchTelegramStatus();
      setStatus('Telegram 状态已刷新。', 'success');
      return;
    }

    if (action === 'bridge-warmup') {
      setStatus('正在执行桥接自检...', 'busy');
      const payload = await postJson('/api/manage/telegram/bridge-warmup');
      await fetchTelegramStatus();
      setStatus(payload?.message || '桥接自检完成。', payload?.bridge?.ok ? 'success' : 'busy');
      return;
    }

    if (action === 'telegram-sync') {
      setStatus('正在同步 Telegram 直传更新...', 'busy');
      const payload = await postJson('/api/manage/telegram/sync');
      await fetchTelegramStatus();
      state.folderCache.delete('/');
      await openFolder('/', { force: true, silent: true });
      setStatus(`同步完成：抓取 ${payload.fetched} 条，写入 ${payload.stored} 条。`, 'success');
      return;
    }

    if (action === 'telegram-webhook') {
      setStatus('正在配置 Telegram webhook...', 'busy');
      const payload = await postJson('/api/manage/telegram/webhook');
      state.telegramStatus = {
        bot: null,
        webhook: payload.webhookInfo,
        syncState: { offset: null, lastWebhookAt: Date.now(), lastSyncAt: null }
      };
      notify();
      await fetchTelegramStatus();
      setStatus(`Webhook 已配置到 ${payload.webhookUrl}`, 'success');
    }
  };

  const copyFileUrl = async (key) => {
    await navigator.clipboard.writeText(`${window.location.origin}/file/${key}`);
    setStatus(`已复制 ${key}。`, 'success');
  };

  const parseResponsePayload = async (response, fallbackMessage) => {
    const raw = await response.text();
    try {
      return JSON.parse(raw);
    } catch {
      return {
        error: raw?.trim() || fallbackMessage
      };
    }
  };

  const prepareMtprotoUpload = async (task, { reuseSession = false } = {}) => {
    const query = new URLSearchParams({
      path: task.path,
      name: task.fileName,
      size: String(task.fileSize),
      type: task.contentType
    });
    if (reuseSession && task.sessionId) {
      query.set('session', task.sessionId);
    }

    const prepareResponse = await fetch(`/api/manage/mtproto/upload?${query.toString()}`, {
      headers: {
        accept: 'application/json'
      }
    });
    const prepared = await parseResponsePayload(prepareResponse, '无法解析 MTProto 上传预签名返回。');
    if (!prepareResponse.ok) {
      throw new Error(prepared?.error || 'MTProto 上传准备失败。');
    }
    return prepared;
  };

  const refreshPreparedUpload = async (taskId, task, options = {}) => {
    replaceUploadTask(taskId, {
      phase: 'refreshing-signature',
      status: 'uploading',
      canRetry: false
    });
    const prepared = await prepareMtprotoUpload(task, options);
    replaceUploadTask(taskId, {
      sessionId: prepared.sessionId || task.sessionId || '',
      expiresAt: prepared.expiresAt || null,
      phase: 'uploading',
      status: 'uploading'
    });
    return prepared;
  };

  const uploadViaMtprotoDirect = async (prepared, task) => {
    let activePrepared = prepared;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0 || shouldRefreshUploadSignature(activePrepared)) {
        activePrepared = await refreshPreparedUpload(task.id, task, { reuseSession: false });
      }

      const response = await fetch(activePrepared.uploadUrl, {
        method: 'POST',
        mode: 'cors',
        headers: task.contentType ? { 'content-type': task.contentType } : undefined,
        body: task.file
      });

      const payload = await parseResponsePayload(response, '无法解析 MTProto bridge 上传返回。');
      if (response.ok) {
        replaceUploadTask(task.id, {
          uploadedBytes: task.fileSize,
          progress: 0.96,
          phase: 'finalizing',
          expiresAt: activePrepared.expiresAt || null
        });
        return payload;
      }

      const errorMessage = payload?.error || 'MTProto bridge 直传失败。';
      if (attempt === 0 && isExpiredUploadErrorMessage(errorMessage)) {
        continue;
      }
      throw new Error(errorMessage);
    }

    throw new Error('MTProto bridge 直传失败。');
  };

  const uploadViaMtprotoChunked = async (prepared, task, { startPart = 0 } = {}) => {
    const chunkSize = Number(prepared.chunkSize || 0);
    if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
      throw new Error('分块上传参数无效。');
    }

    const totalParts = Number(prepared.totalParts || Math.max(1, Math.ceil(task.fileSize / chunkSize)));
    const parallelChunks = Math.max(1, Math.min(
      Number(prepared.parallelChunks || DEFAULT_CHUNK_UPLOAD_CONCURRENCY) || DEFAULT_CHUNK_UPLOAD_CONCURRENCY,
      6,
      totalParts
    ));
    const resumedParts = normalizeCompletedPartNumbers(task.completedPartNumbers, totalParts);
    const completedSet = new Set(resumedParts);
    let completedBytes = resumedParts.reduce((sum, part) => sum + getChunkBounds(part, chunkSize, task.fileSize).size, 0);
    let finalPayload = null;
    let activePrepared = prepared;
    let refreshPromise = null;
    let nextQueueIndex = 0;
    let fatalError = null;
    const inFlightControllers = new Set();
    const pendingParts = [];

    for (let part = startPart; part < totalParts; part += 1) {
      if (!completedSet.has(part)) {
        pendingParts.push(part);
      }
    }

    replaceUploadTask(task.id, {
      mode: 'chunked',
      totalParts,
      sessionId: prepared.sessionId || task.sessionId || '',
      expiresAt: prepared.expiresAt || null,
      phase: 'uploading',
      status: 'uploading',
      canRetry: false,
      completedParts: completedSet.size,
      completedPartNumbers: [...completedSet],
      uploadedBytes: completedBytes
    });

    const refreshSignedUpload = async () => {
      if (!refreshPromise) {
        refreshPromise = (async () => {
          const refreshed = await refreshPreparedUpload(task.id, {
            ...task,
            sessionId: activePrepared.sessionId || task.sessionId || ''
          }, { reuseSession: true });
          activePrepared = refreshed;
          return refreshed;
        })().finally(() => {
          refreshPromise = null;
        });
      }
      return refreshPromise;
    };

    const buildChunkUrl = (currentPrepared, part) => {
      const chunkUrl = new URL(currentPrepared.uploadUrl);
      chunkUrl.searchParams.set('part', String(part));
      chunkUrl.searchParams.set('totalParts', String(totalParts));
      if (part === totalParts - 1) {
        chunkUrl.searchParams.set('final', '1');
      }
      return chunkUrl;
    };

    const sendChunkPart = async (part) => {
      let currentPrepared = activePrepared;
      if (shouldRefreshUploadSignature(currentPrepared)) {
        currentPrepared = await refreshSignedUpload();
      }

      const { start, end, size } = getChunkBounds(part, chunkSize, task.fileSize);
      const chunk = task.file.slice(start, end);
      let chunkUrl = buildChunkUrl(currentPrepared, part);

      setStatus(`正在分块上传 ${task.fileName}：${part + 1}/${totalParts} ...`, 'busy');
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const controller = new AbortController();
        inFlightControllers.add(controller);
        let response;
        try {
          response = await fetch(chunkUrl.toString(), {
            method: 'POST',
            mode: 'cors',
            headers: task.contentType ? { 'content-type': task.contentType } : undefined,
            body: chunk,
            signal: controller.signal
          });
        } catch (error) {
          if (fatalError) {
            throw fatalError;
          }
          throw error;
        } finally {
          inFlightControllers.delete(controller);
        }

        const payload = await parseResponsePayload(response, '无法解析 MTProto 分块上传返回。');
        if (response.ok) {
          return { payload, size };
        }
        const errorMessage = payload?.error || `MTProto 分块上传失败（part ${part + 1}/${totalParts}）。`;
        if (attempt === 0 && isExpiredUploadErrorMessage(errorMessage)) {
          currentPrepared = await refreshSignedUpload();
          chunkUrl = buildChunkUrl(currentPrepared, part);
          continue;
        }
        throw new Error(errorMessage);
      }

      throw new Error(`MTProto 分块上传失败（part ${part + 1}/${totalParts}）。`);
    };

    const uploadWorker = async () => {
      while (!fatalError) {
        const queueIndex = nextQueueIndex;
        if (queueIndex >= pendingParts.length) {
          return;
        }
        nextQueueIndex += 1;
        const part = pendingParts[queueIndex];

        try {
          const result = await sendChunkPart(part);
          if (completedSet.has(part)) {
            continue;
          }

          completedSet.add(part);
          completedBytes += result.size;
          if (result.payload?.upload) {
            finalPayload = result.payload;
          }

          replaceUploadTask(task.id, {
            completedParts: completedSet.size,
            completedPartNumbers: [...completedSet].sort((left, right) => left - right),
            uploadedBytes: completedBytes,
            progress: Math.min(0.94, completedBytes / Math.max(task.fileSize, 1) * 0.94),
            expiresAt: activePrepared.expiresAt || null
          });
        } catch (error) {
          if (!fatalError) {
            fatalError = error instanceof Error ? error : new Error(String(error || 'MTProto 分块上传失败。'));
            inFlightControllers.forEach((controller) => controller.abort());
          }
          return;
        }
      }
    };

    if (!pendingParts.length && completedSet.size === totalParts) {
      const probePart = resumedParts[resumedParts.length - 1] ?? Math.max(0, totalParts - 1);
      const result = await sendChunkPart(probePart);
      if (result?.payload?.upload) {
        finalPayload = result.payload;
      }
    }

    await Promise.allSettled(Array.from({
      length: Math.max(1, Math.min(parallelChunks, pendingParts.length || 1))
    }, () => uploadWorker()));

    if (fatalError) {
      throw fatalError;
    }

    if (!finalPayload?.upload) {
      throw new Error('MTProto 分块上传没有返回最终消息信息。');
    }

    return finalPayload;
  };

  const finalizeMtprotoUpload = async (task, bridgePayload) => {
      const finalizeResponse = await fetch('/api/manage/mtproto/upload', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          path: task.path,
          fileName: task.fileName,
          contentType: task.contentType,
          upload: bridgePayload.upload
        })
      });
      const payload = await parseResponsePayload(finalizeResponse, '无法解析 MTProto 上传 finalize 返回。');
      if (!finalizeResponse.ok) {
        throw new Error(payload?.error || 'MTProto 上传收尾失败。');
      }
      return payload;
  };

  const openFavoriteItem = async (item, { openFile = false } = {}) => {
    if (!item) return;

    if (item.folderPath) {
      await openFolder(item.folderPath, { force: true });
      selectItem(item.name);
    }

    if (openFile) {
      window.open(item.url, '_blank', 'noopener,noreferrer');
    }
  };

  const refreshFolderAfterUpload = async (task) => {
    state.folderCache.delete(task.path);
    const parentPath = getParentPath(task.path);
    if (parentPath) {
      state.folderCache.delete(parentPath);
    }
    await openFolder(task.path, { force: true, silent: true });
  };

  const runUploadTask = async (taskId, { resume = false } = {}) => {
    const task = state.uploadTasks.find((item) => item.id === taskId);
    if (!task) {
      throw new Error('上传任务不存在。');
    }

    const retryCount = resume ? task.retryCount + 1 : task.retryCount;
    replaceUploadTask(taskId, (current) => ({
      status: 'preparing',
      phase: 'preparing',
      error: '',
      canRetry: false,
      retryCount,
      progress: resume ? current.progress : 0,
      uploadedBytes: resume ? current.uploadedBytes : 0,
      completedParts: resume ? current.completedParts : 0,
      completedPartNumbers: resume ? normalizeCompletedPartNumbers(current.completedPartNumbers, current.totalParts) : []
    }));

    try {
      setStatus(`正在通过 MTProto 上传：${task.fileName} ...`, 'busy');
      const prepared = await prepareMtprotoUpload(task, { reuseSession: resume && task.mode === 'chunked' && Boolean(task.sessionId) });
      replaceUploadTask(taskId, {
        mode: prepared.mode,
        sessionId: prepared.sessionId || task.sessionId || '',
        totalParts: Number(prepared.totalParts || 1),
        expiresAt: prepared.expiresAt || null,
        status: 'uploading',
        phase: 'uploading'
      });

      const bridgePayload = prepared.mode === 'chunked'
        ? await uploadViaMtprotoChunked(prepared, state.uploadTasks.find((item) => item.id === taskId), {
            startPart: 0
          })
        : await uploadViaMtprotoDirect(prepared, state.uploadTasks.find((item) => item.id === taskId));

      replaceUploadTask(taskId, {
        status: 'finalizing',
        phase: 'finalizing',
        progress: 0.97
      });
      const payload = await finalizeMtprotoUpload(state.uploadTasks.find((item) => item.id === taskId), bridgePayload);

      replaceUploadTask(taskId, {
        status: payload?.pending ? 'pending' : 'success',
        phase: payload?.pending ? 'pending' : 'success',
        progress: payload?.pending ? 0.99 : 1,
        uploadedBytes: task.fileSize,
        completedParts: Number(prepared.totalParts || 1),
        completedPartNumbers: [],
        result: payload,
        canRetry: false
      });

      await refreshFolderAfterUpload(state.uploadTasks.find((item) => item.id === taskId));
      await fetchFavorites().catch(() => {});

      if (payload?.pending) {
        setStatus(`已提交 ${task.fileName} 到 Telegram，等待 webhook 收录到 ${task.path} ...`, 'busy');
        window.setTimeout(() => {
          void refreshCurrentFolder().catch(() => {});
        }, 2500);
      } else {
        setStatus(`MTProto 上传完成：${task.fileName}`, 'success');
      }

      return payload;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'MTProto 上传失败。';
      replaceUploadTask(taskId, (current) => ({
        status: 'error',
        phase: 'error',
        error: message,
        canRetry: true,
        expiresAt: /expired/i.test(message) ? Date.now() - 1 : current.expiresAt
      }));
      setStatus(message, 'error');
      throw error;
    }
  };

  const uploadViaMtproto = async (fileList) => {
    const files = Array.from(fileList || []).filter((file) => file instanceof File);
    if (!files.length) {
      return { uploaded: 0, files: [] };
    }

    const results = [];
    for (const file of files) {
      const task = appendUploadTask(createUploadTask(file, state.currentPath));
      const result = await runUploadTask(task.id).catch((error) => ({
        error: error instanceof Error ? error.message : 'MTProto 上传失败。'
      }));
      results.push(result);
    }

    return {
      uploaded: results.filter((item) => !item?.error).length,
      files: results
    };
  };

  const retryUploadTask = async (taskId) => {
    const task = state.uploadTasks.find((item) => item.id === taskId);
    if (!task) {
      throw new Error('上传任务不存在。');
    }

    const resumable = task.mode === 'chunked' && task.sessionId && task.completedParts > 0 && task.completedParts < task.totalParts;
    return runUploadTask(taskId, { resume: Boolean(resumable) });
  };

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const scrollToBottom = () => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  };

  const openSelectedItem = () => {
    const selected = getSelectedItem();
    if (!selected) return;
    window.open(selected.url, '_blank', 'noopener,noreferrer');
  };

  const navigateSelection = (delta) => {
    const items = getFilteredItems();
    if (!items.length) return;
    const currentIndex = items.findIndex((item) => item.name === state.selectedKey);
    const nextIndex = currentIndex < 0 ? 0 : Math.max(0, Math.min(items.length - 1, currentIndex + delta));
    state.selectedKey = items[nextIndex]?.name || null;
    notify();
  };

  const bus = {
    state,
    subscribe(callback) {
      subscribers.add(callback);
      callback(state);
      return () => subscribers.delete(callback);
    },
    notify,
    start,
    setStatus,
    setSearch,
    toggleView,
    refreshCurrentFolder,
    openFolder,
    fetchFolderBrowse,
    toggleFolderExpanded,
    createFolder,
    deleteCurrentFolder,
    moveDavFile,
    performItemAction,
    triggerTelegramAction,
    copyFileUrl,
    uploadViaMtproto,
    retryUploadTask,
    removeUploadTask,
    getUploadTasks,
    fetchFavorites,
    openFavoriteItem,
    scrollToTop,
    scrollToBottom,
    selectItem,
    getFilteredItems,
    getSelectedItem,
    openSelectedItem,
    navigateSelection
  };

  window[ADMIN_BUS_KEY] = bus;
  return bus;
}
