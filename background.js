import { DEFAULT_SETTINGS, AppError, cleanRequest, validateSettings, endpointFrom } from './lib/core.js';
import { queryAI } from './lib/ai.js';

const pending = new Map();
let writeQueue = Promise.resolve();
// Keys and saved readings are available only to trusted extension pages / worker.
const ready = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const serial = fn => { const job = writeQueue.then(fn); writeQueue = job.catch(() => {}); return job; };
const trusted = sender => sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
const owner = sender => sender.tab ? `tab:${sender.tab.id}:${sender.frameId ?? 0}` : `page:${sender.documentId ?? sender.url}`;

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

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function analyze(message, sender) {
  const request = cleanRequest(message);
  const id = typeof message.id === 'string' ? message.id.slice(0, 100) : crypto.randomUUID();
  const key = `${owner(sender)}:${id}`;
  if (pending.size >= 5) throw new AppError('BUSY', '同时查询过多，请等待其他译注完成。');
  const controller = new AbortController();
  pending.get(key)?.abort(); pending.set(key, controller);
  const timeout = setTimeout(() => controller.abort(), 65000);
  // API activity keeps an active streaming task alive; stopped immediately after completion.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  try {
    const settings = validateSettings(await getSettings());
    if (!trusted(sender) && !settings.enabled) throw new AppError('DISABLED', '划词功能已暂停，可在拾文设置中重新开启。');
    if (!settings.includeContext) request.context = '';
    const { origin } = endpointFrom(settings.baseUrl);
    if (!(await chrome.permissions.contains({ origins: [origin] }))) throw new AppError('PERMISSION', '尚未授权 AI 接口，请到设置页点击“保存设置”完成授权。');
    if (controller.signal.aborted) throw new AppError('CANCELLED', '查询已取消。');
    const result = await queryAI(settings, request, controller.signal);
    if (controller.signal.aborted) throw new AppError('CANCELLED', '查询已取消。');
    const entry = { id: crypto.randomUUID(), text: request.text, mode: request.mode, result, createdAt: Date.now() };
    await serial(async () => {
      const { recent = [] } = await chrome.storage.local.get('recent');
      const next = [entry, ...recent.filter(x => x.text !== entry.text || x.mode !== entry.mode)].slice(0, 20);
      while (next.length > 1 && new TextEncoder().encode(JSON.stringify(next)).length > 1000000) next.pop();
      await chrome.storage.local.set({ recent: next });
    });
    return entry;
  } finally { clearTimeout(timeout); clearInterval(keepAlive); if (pending.get(key) === controller) pending.delete(key); }
}

async function handle(message, sender) {
  await ready;
  if (sender.id !== chrome.runtime.id) throw new AppError('DENIED', '无权访问。');
  switch (message?.type) {
    case 'PUBLIC_SETTINGS': {
      const settings = await getSettings();
      return { enabled: settings.enabled, includeContext: settings.includeContext, fontSize: settings.fontSize };
    }
    case 'ANALYZE': return analyze(message, sender);
    case 'CANCEL': pending.get(`${owner(sender)}:${String(message.id).slice(0, 100)}`)?.abort(); return true;
    case 'OPEN_OPTIONS': await chrome.runtime.openOptionsPage(); return true;
    case 'SAVE_ENTRY': return serial(async () => {
      // Only entries actually produced by this extension may be saved.
      const { recent = [], saved = [] } = await chrome.storage.local.get(['recent', 'saved']);
      const entry = recent.find(x => x.id === message.id) || saved.find(x => x.id === message.id);
      if (!entry) throw new AppError('MISSING', '这条译注已不在最近记录中，请重新查询后收藏。');
      const existing = saved.find(x => x.text === entry.text && x.mode === entry.mode);
      if (existing) return { saved: true, id: existing.id };
      if (saved.length >= 200) throw new AppError('LIMIT', '生词笺已满 200 条，请先导出并整理。');
      if (new TextEncoder().encode(JSON.stringify([entry, ...saved])).length > 7500000) throw new AppError('LIMIT', '生词笺存储空间不足，请先导出并整理部分收藏。');
      await chrome.storage.local.set({ saved: [entry, ...saved] });
      return { saved: true, id: entry.id };
    });
  }
  if (!trusted(sender)) throw new AppError('DENIED', '此操作只能在扩展页面进行。');
  switch (message.type) {
    case 'GET_SETTINGS': return getSettings();
    case 'SET_SETTINGS': {
      const settings = validateSettings(message.settings);
      if (!(await chrome.permissions.contains({ origins: [endpointFrom(settings.baseUrl).origin] }))) throw new AppError('PERMISSION', '请允许访问所填写的 AI 接口后再保存。');
      await serial(() => chrome.storage.local.set({ settings })); return true;
    }
    case 'LIBRARY': {
      const { recent = [], saved = [] } = await chrome.storage.local.get(['recent', 'saved']); return { recent, saved };
    }
    case 'REMOVE_SAVED': await serial(async () => {
      const { saved = [] } = await chrome.storage.local.get('saved');
      await chrome.storage.local.set({ saved: saved.filter(x => x.id !== message.id) });
    }); return true;
    case 'CLEAR_RECENT': await serial(() => chrome.storage.local.remove('recent')); return true;
    case 'DELETE_KEY': await serial(async () => {
      const settings = await getSettings(); settings.apiKey = '';
      await chrome.storage.local.set({ settings });
    }); return true;
    case 'PENDING_QUERY': {
      const { pendingQuery } = await chrome.storage.session.get('pendingQuery');
      await chrome.storage.session.remove('pendingQuery'); return pendingQuery || null;
    }
    default: throw new AppError('UNKNOWN', '不支持的操作。');
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  handle(message, sender).then(data => reply({ ok: true, data })).catch(error => {
    // Never echo provider bodies, exception strings, endpoints, or credentials to web pages.
    const safe = error instanceof AppError;
    const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    reply({ ok: false, error: { code: safe ? error.code : aborted ? 'TIMEOUT' : 'NETWORK', message: safe ? error.message : aborted ? '查询已取消或等待超时，请重试或换用响应更快的模型。' : '请求未完成，请检查网络和接口配置后重试。' } });
  });
  return true;
});
