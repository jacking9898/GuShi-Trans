import { DEFAULT_SETTINGS, AppError, cleanRequest, validateSettings, endpointFrom, analysisKey, requestPolicy } from './lib/core.js';
import { migrateSettings, validateConfiguration, resolveSettings, publicProviders, preferences } from './lib/providers.js';
import { queryAI } from './lib/ai.js';

const pending = new Map();
const panelRequests = new Map();
let panelSequence = 0;
let writeQueue = Promise.resolve();
// Keys and saved readings are available only to trusted extension pages / worker.
const ready = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const serial = fn => { const job = writeQueue.then(fn); writeQueue = job.catch(() => {}); return job; };
const trusted = sender => sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
const owner = sender => sender.tab ? `tab:${sender.tab.id}:${sender.frameId ?? 0}` : `page:${sender.documentId ?? sender.url}`;

function openReadingPanel(message, sender, reply) {
  try {
    if (sender.id !== chrome.runtime.id || !sender.tab || !Number.isInteger(sender.tab.windowId)) throw new AppError('DENIED', '此入口仅用于当前网页的阅读侧栏。');
    const request = cleanRequest(message);
    const version = Date.now() * 1000 + (++panelSequence % 1000);
    // Invoke synchronously in the user-gesture message listener. Awaiting storage
    // before open() can lose Chrome's transient user activation.
    const opening = chrome.sidePanel.open({ tabId: sender.tab.id });
    const storing = opening.then(() => ready).then(async () => {
      const settings = await getSettings(message.providerId);
      const { settingsRevision = 'initial' } = await chrome.storage.local.get('settingsRevision');
      if (!settings.enabled) throw new AppError('DISABLED', '划词功能已暂停。');
      if (!settings.includeContext) request.context = '';
      await chrome.storage.session.set({ [`readingPanel:${sender.tab.windowId}`]: {
        ...request, id: crypto.randomUUID(), version, tabId: sender.tab.id,
        providerId: settings.providerId, thinkingEnabled: requestPolicy(settings).thinking, fontSize: settings.fontSize, revision: settingsRevision,
        force: message.force === true
      } });
    });
    Promise.all([opening, storing]).then(async () => {
      await chrome.storage.session.set({ [`readingPanelOpen:${sender.tab.windowId}`]: true });
      reply({ ok: true, data: { opened: true } });
    }).catch(() => reply({ ok: false, error: { code: 'PANEL', message: '当前无法打开浏览器侧栏，将使用网页浮窗。' } }));
  } catch {
    reply({ ok: false, error: { code: 'PANEL', message: '当前无法打开浏览器侧栏，将使用网页浮窗。' } });
  }
  return true;
}

chrome.sidePanel?.onClosed?.addListener(info => {
  chrome.storage.session.remove(`readingPanelOpen:${info.windowId}`).catch(() => {});
  for (const [key, windowId] of panelRequests) if (windowId === info.windowId) pending.get(key)?.abort();
  chrome.tabs.query({ windowId: info.windowId }).then(tabs => Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type: 'READING_PANEL_CLOSED' })))).catch(() => {});
});
chrome.windows?.onRemoved?.addListener(windowId => {
  chrome.storage.session.remove([`readingPanel:${windowId}`, `readingPanelOpen:${windowId}`]).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const [mode, title] of [['translate', '拾文 · 翻译为白话'], ['explain', '拾文 · 解释字词与读音'], ['appreciate', '拾文 · 赏析这段诗文']]) {
      chrome.contextMenus.create({ id: mode, title, contexts: ['selection'], documentUrlPatterns: ['http://*/*', 'https://*/*'] });
    }
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!info.selectionText || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'CONTEXT_QUERY', text: info.selectionText, mode: info.menuItemId }, { frameId: info.frameId ?? 0 }).catch(async () => {
    // Old pages may not yet have a content script after installation/reload.
    await chrome.storage.session.set({ pendingQuery: { text: info.selectionText, mode: info.menuItemId } });
    await chrome.tabs.create({ url: chrome.runtime.getURL('reader.html?pending=1') });
  });
});

let migration;
async function getConfiguration() {
  if (!migration) migration = (async () => {
    const values = await chrome.storage.local.get(['configuration', 'settings']);
    if (!values.configuration) await chrome.storage.local.set({ configuration: migrateSettings(values.settings) });
    // The new configuration is durable before the legacy credential copy is removed.
    await chrome.storage.local.remove('settings');
  })().catch(error => { migration = null; throw error; });
  await migration;
  return (await chrome.storage.local.get('configuration')).configuration;
}
async function getSettings(providerId) { return resolveSettings(await getConfiguration(), providerId); }
async function storeConfiguration(configuration) {
  await chrome.storage.local.set({ configuration, settingsRevision: crypto.randomUUID() });
  await chrome.storage.session.remove('analysisCache');
}

async function remember(entry) {
  const { recent = [] } = await chrome.storage.local.get('recent');
  const next = [entry, ...recent.filter(x => x.id !== entry.id && (x.text !== entry.text || x.mode !== entry.mode || x.providerId !== entry.providerId))].slice(0, 20);
  while (next.length > 1 && new TextEncoder().encode(JSON.stringify(next)).length > 1000000) next.pop();
  await chrome.storage.local.set({ recent: next });
}

async function cacheEntry(key, entry) {
  const { analysisCache = [] } = await chrome.storage.session.get('analysisCache');
  const next = [{ key, entry }, ...analysisCache.filter(x => x.key !== key)].slice(0, 32);
  while (next.length > 1 && new TextEncoder().encode(JSON.stringify(next)).length > 1500000) next.pop();
  await chrome.storage.session.set({ analysisCache: next });
}

async function analyze(message, sender) {
  const request = cleanRequest(message);
  const id = typeof message.id === 'string' ? message.id.slice(0, 100) : crypto.randomUUID();
  const key = `${owner(sender)}:${id}`;
  if (pending.size >= 5) throw new AppError('BUSY', '同时查询过多，请等待其他译注完成。');
  const controller = new AbortController();
  pending.get(key)?.abort(); pending.set(key, controller);
  if (trusted(sender) && sender.url?.split('?')[0] === chrome.runtime.getURL('panel.html') && Number.isInteger(message.panelWindowId)) panelRequests.set(key, message.panelWindowId);
  let timeout = setTimeout(() => controller.abort(), 65000);
  // API activity keeps an active streaming task alive; stopped immediately after completion.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  try {
    const selected = await getSettings(message.providerId);
    const settings = { ...selected, ...validateSettings(selected) };
    if (requestPolicy(settings).thinking) { clearTimeout(timeout); timeout = setTimeout(() => controller.abort(), requestPolicy(settings).timeoutMs); }
    if (!trusted(sender) && !settings.enabled) throw new AppError('DISABLED', '划词功能已暂停，可在拾文设置中重新开启。');
    if (!settings.includeContext) request.context = '';
    const { origin } = endpointFrom(settings.baseUrl);
    if (!(await chrome.permissions.contains({ origins: [origin] }))) throw new AppError('PERMISSION', '尚未授权 AI 接口，请到设置页点击“保存设置”完成授权。');
    if (controller.signal.aborted) throw new AppError('CANCELLED', '查询已取消。');
    const cacheKey = await analysisKey(settings, request);
    const { analysisCache = [] } = await chrome.storage.session.get('analysisCache');
    const cached = !message.force && analysisCache.find(x => x.key === cacheKey)?.entry;
    if (controller.signal.aborted) throw new AppError('CANCELLED', '查询已取消。');
    if (cached) {
      await serial(async () => { await remember(cached); await cacheEntry(cacheKey, cached); });
      return cached;
    }
    const result = await queryAI(settings, request, controller.signal);
    if (controller.signal.aborted) throw new AppError('CANCELLED', '查询已取消。');
    const entry = { id: crypto.randomUUID(), text: request.text, mode: request.mode, providerId: settings.providerId, providerName: settings.providerName, model: settings.model, result, createdAt: Date.now() };
    await serial(async () => {
      await remember(entry);
      await cacheEntry(cacheKey, entry);
    });
    return entry;
  } finally { clearTimeout(timeout); clearInterval(keepAlive); if (pending.get(key) === controller) { pending.delete(key); panelRequests.delete(key); } }
}

async function handle(message, sender) {
  await ready;
  if (sender.id !== chrome.runtime.id) throw new AppError('DENIED', '无权访问。');
  switch (message?.type) {
    case 'PUBLIC_SETTINGS': {
      const configuration = await getConfiguration();
      const settings = configuration.providers.length ? resolveSettings(configuration) : { ...DEFAULT_SETTINGS, ...configuration.preferences };
      const { settingsRevision = 'initial' } = await chrome.storage.local.get('settingsRevision');
      const openKey = `readingPanelOpen:${sender.tab?.windowId}`;
      const panelState = sender.tab ? await chrome.storage.session.get(openKey) : {};
      return { ...publicProviders(configuration), enabled: settings.enabled, includeContext: settings.includeContext, fontSize: settings.fontSize, thinkingEnabled: requestPolicy(settings).thinking, dockedReading: settings.dockedReading, sidePanelOpen: panelState[openKey] === true, revision: settingsRevision };
    }
    case 'SELECT_PROVIDER': return serial(async () => {
      if (typeof message.providerId !== 'string') throw new AppError('SETTINGS', '请选择已保存的 AI 配置。');
      const configuration = await getConfiguration();
      resolveSettings(configuration, message.providerId);
      configuration.activeProviderId = message.providerId;
      await chrome.storage.local.set({ configuration });
      return publicProviders(configuration);
    });
    case 'ANALYZE': return analyze(message, sender);
    case 'CANCEL': pending.get(`${owner(sender)}:${String(message.id).slice(0, 100)}`)?.abort(); return true;
    case 'OPEN_OPTIONS': await chrome.runtime.openOptionsPage(); return true;
    case 'SAVE_ENTRY': return serial(async () => {
      // Only entries actually produced by this extension may be saved.
      const { recent = [], saved = [] } = await chrome.storage.local.get(['recent', 'saved']);
      const { analysisCache = [] } = await chrome.storage.session.get('analysisCache');
      const entry = recent.find(x => x.id === message.id) || saved.find(x => x.id === message.id) || analysisCache.find(x => x.entry.id === message.id)?.entry;
      if (!entry) throw new AppError('MISSING', '这条译注已不在最近记录中，请重新查询后收藏。');
      const existing = saved.find(x => x.text === entry.text && x.mode === entry.mode && x.providerId === entry.providerId);
      if (existing) return { saved: true, id: existing.id };
      if (saved.length >= 200) throw new AppError('LIMIT', '生词笺已满 200 条，请先导出并整理。');
      if (new TextEncoder().encode(JSON.stringify([entry, ...saved])).length > 7500000) throw new AppError('LIMIT', '生词笺存储空间不足，请先导出并整理部分收藏。');
      await chrome.storage.local.set({ saved: [entry, ...saved] });
      return { saved: true, id: entry.id };
    });
  }
  if (!trusted(sender)) throw new AppError('DENIED', '此操作只能在扩展页面进行。');
  switch (message.type) {
    case 'GET_CONFIGURATION': return getConfiguration();
    case 'GET_SETTINGS': return getSettings(message.providerId);
    case 'SET_CONFIGURATION': {
      const configuration = validateConfiguration(message.configuration);
      const origins = [...new Set(configuration.providers.filter(p => p.apiKey).map(p => endpointFrom(p.baseUrl).origin))];
      if (origins.length && !(await chrome.permissions.contains({ origins }))) throw new AppError('PERMISSION', '请允许访问已配置的 AI 接口后再保存。');
      await getConfiguration();
      await serial(() => storeConfiguration(configuration)); return true;
    }
    case 'SET_SETTINGS': {
      const settings = validateSettings(message.settings);
      if (!(await chrome.permissions.contains({ origins: [endpointFrom(settings.baseUrl).origin] }))) throw new AppError('PERMISSION', '请允许访问所填写的 AI 接口后再保存。');
      await serial(async () => {
        const configuration = await getConfiguration();
        const selected = resolveSettings(configuration);
        configuration.providers = configuration.providers.map(p => p.id === selected.providerId ? { ...p, ...Object.fromEntries(['baseUrl', 'model', 'apiKey', 'jsonMode', 'thinkingEnabled'].map(key => [key, settings[key]])) } : p);
        configuration.preferences = preferences(settings);
        await storeConfiguration(configuration);
      }); return true;
    }
    case 'LIBRARY': {
      const { recent = [], saved = [] } = await chrome.storage.local.get(['recent', 'saved']); return { recent, saved };
    }
    case 'REMOVE_SAVED': await serial(async () => {
      const { saved = [] } = await chrome.storage.local.get('saved');
      await chrome.storage.local.set({ saved: saved.filter(x => x.id !== message.id) });
    }); return true;
    case 'CLEAR_RECENT': await serial(async () => { await chrome.storage.local.remove('recent'); await chrome.storage.session.remove('analysisCache'); }); return true;
    case 'DELETE_KEY': await serial(async () => {
      const configuration = await getConfiguration();
      const selected = resolveSettings(configuration, message.providerId);
      configuration.providers.find(p => p.id === selected.providerId).apiKey = '';
      await storeConfiguration(configuration);
    }); return true;
    case 'PENDING_QUERY': {
      const { pendingQuery } = await chrome.storage.session.get('pendingQuery');
      await chrome.storage.session.remove('pendingQuery'); return pendingQuery || null;
    }
    default: throw new AppError('UNKNOWN', '不支持的操作。');
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === 'OPEN_READING_PANEL') return openReadingPanel(message, sender, reply);
  handle(message, sender).then(data => reply({ ok: true, data })).catch(error => {
    // Never echo provider bodies, exception strings, endpoints, or credentials to web pages.
    const safe = error instanceof AppError;
    const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    reply({ ok: false, error: { code: safe ? error.code : aborted ? 'TIMEOUT' : 'NETWORK', message: safe ? error.message : aborted ? '查询已取消或等待超时，请重试或换用响应更快的模型。' : '请求未完成，请检查网络和接口配置后重试。' } });
  });
  return true;
});
