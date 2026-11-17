import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../lib/core.js';
import { EXAMPLE } from '../lib/example.js';
const id = 'extension-test';
const storage = {};
const session = {};
let activatedListener, updatedListener, removedListener, closedPanels = [];
let handler, accessLevel, allow = true, requestBody, requestCount = 0, panelOpened;
globalThis.chrome = {
  storage: {
    local: {
      async setAccessLevel(value) { accessLevel = value; },
      async get(keys) { return Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter(k => k in storage).map(k => [k, structuredClone(storage[k])])); },
      async set(value) { Object.assign(storage, structuredClone(value)); },
      async remove(key) { for (const name of Array.isArray(key) ? key : [key]) delete storage[name]; }
    },
    session: {
      async get(key) { return key in session ? { [key]: structuredClone(session[key]) } : {}; },
      async set(value) { Object.assign(session, structuredClone(value)); },
      async remove(key) { for (const name of Array.isArray(key) ? key : [key]) delete session[name]; }
    }
  },
  runtime: { id, getURL: path => `chrome-extension://${id}/${path}`, onInstalled: { addListener() {} }, onMessage: { addListener(fn) { handler = fn; } }, async openOptionsPage() {}, async getPlatformInfo() { return {}; } },
  contextMenus: { onClicked: { addListener() {} } },
  permissions: { async contains() { return allow; } },
  tabs: { onActivated: { addListener(fn) { activatedListener = fn; } }, onUpdated: { addListener(fn) { updatedListener = fn; } }, onRemoved: { addListener(fn) { removedListener = fn; } }, async sendMessage() {} },
  sidePanel: { async open(value) { panelOpened = value; }, async close(value) { closedPanels.push(value); } }
};
globalThis.fetch = async (_url, options) => { requestCount++; requestBody = JSON.parse(options.body); return Response.json({ choices: [{ message: { content: JSON.stringify(EXAMPLE.result) } }] }); };
await import('../background.js');
const page = { id, url: `chrome-extension://${id}/reader.html`, documentId: 'reader' };
const content = { id, url: 'https://page.test', tab: { id: 1 }, frameId: 0 };
const send = (message, sender = page) => new Promise(resolve => { assert.equal(handler(message, sender, resolve), true); });

test('secrets are isolated; public preferences accessible but settings/library writes denied to content scripts', async () => {
  storage.settings = { ...DEFAULT_SETTINGS, apiKey: 'private-secret' };
  assert.deepEqual(accessLevel, { accessLevel: 'TRUSTED_CONTEXTS' });
  const publicData = await send({ type: 'PUBLIC_SETTINGS' }, content); assert(publicData.ok); assert(!JSON.stringify(publicData).includes('private-secret'));
  for (const type of ['GET_SETTINGS', 'LIBRARY', 'DELETE_KEY', 'SET_SETTINGS', 'REMOVE_SAVED']) assert.equal((await send({ type }, content)).error.code, 'DENIED');
  assert.equal((await send({ type: 'GET_SETTINGS' })).data.apiKey, 'private-secret');
  assert.equal(storage.settings, undefined); assert.equal(storage.configuration.providers[0].apiKey, 'private-secret');
  assert.equal((await send({ type: 'GET_SETTINGS' }, { ...page, tab: { id: 2 } })).data.apiKey, 'private-secret');
  assert.equal((await send({ type: 'GET_SETTINGS' }, { ...page, id: 'another-extension' })).error.code, 'DENIED');
});
test('side-panel handoff preserves current window and frame text without a premature AI request', async () => {
  const before = requestCount;
  const response = await send({ type: 'OPEN_READING_PANEL', text: '左右对照', context: '本地语境', mode: 'explain' }, { ...content, tab: { id: 1, windowId: 3 } });
  assert(response.ok); assert.deepEqual(panelOpened, { tabId: 1 });
  assert.equal(session['readingPanel:3'].text, '左右对照'); assert.equal(session['readingPanel:3'].mode, 'explain');
  assert.equal(session['readingPanel:3'].context, ''); assert.equal(session['readingPanel:3'].thinkingEnabled, false);
  assert.equal(requestCount, before);
});
test('a rejected native-panel open never dispatches a stale or duplicate query to another renderer', async () => {
  const original = chrome.sidePanel.open;
  const previous = structuredClone(session['readingPanel:3']);
  chrome.sidePanel.open = async () => { throw new Error('user gesture required'); };
  const response = await send({ type: 'OPEN_READING_PANEL', text: '不应派发', mode: 'translate' }, { ...content, tab: { id: 1, windowId: 3 } });
  assert(!response.ok); assert.equal(response.error.code, 'PANEL'); assert.deepEqual(session['readingPanel:3'], previous);
  chrome.sidePanel.open = original;
});
test('permission denial prevents network requests and missing API key produces clear setup error', async () => {
  const count = requestCount; allow = false;
  assert.equal((await send({ type: 'ANALYZE', text: '学' })).error.code, 'PERMISSION'); assert.equal(requestCount, count);
  allow = true; storage.configuration.providers[0].apiKey = '';
  assert.equal((await send({ type: 'ANALYZE', text: '学' })).error.code, 'SETTINGS');
  storage.configuration.providers[0].apiKey = 'private-secret';
});
test('context is opt-in on the backend; page-supplied endpoint cannot redirect the API key', async () => {
  let fetchedURL; const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => { fetchedURL = url; return original(url, options); };
  const response = await send({ type: 'ANALYZE', text: '穷', context: 'nearby private text', endpoint: 'https://evil.test' }, content);
  assert(response.ok); assert.equal(JSON.parse(requestBody.messages[1].content).context, '未提供，请保留歧义。'); assert.equal(fetchedURL, 'https://api.deepseek.com/chat/completions');
  storage.configuration.preferences.includeContext = true;
  await send({ type: 'ANALYZE', text: '穷', context: '水穷处' }, content);
  assert.equal(JSON.parse(requestBody.messages[1].content).context, '水穷处');
  globalThis.fetch = original;
});
test('paused selection queries blocked while manual trusted-page queries remain available', async () => {
  storage.configuration.preferences.enabled = false;
  assert.equal((await send({ type: 'ANALYZE', text: '学' }, content)).error.code, 'DISABLED');
  assert((await send({ type: 'ANALYZE', text: '学' })).ok); storage.configuration.preferences.enabled = true;
});
test('save only actual result IDs; deduplicate repeated saves and serialize concurrent storage mutations', async () => {
  assert.equal((await send({ type: 'SAVE_ENTRY', id: 'invented-result', result: { unsafe: true } }, content)).error.code, 'MISSING');
  const a = (await send({ type: 'ANALYZE', text: '蒹葭' })).data;
  const b = (await send({ type: 'ANALYZE', text: '彳亍' })).data;
  const responses = await Promise.all([send({ type: 'SAVE_ENTRY', id: a.id }, content), send({ type: 'SAVE_ENTRY', id: b.id }, content), send({ type: 'SAVE_ENTRY', id: a.id }, content)]);
  assert(responses.every(r => r.ok)); assert.equal(storage.saved.length, 2);
  await send({ type: 'REMOVE_SAVED', id: a.id }); assert.equal(storage.saved.length, 1);
  await send({ type: 'CLEAR_RECENT' }); assert(!storage.recent); assert.equal(storage.saved.length, 1);
});
test('cancel is scoped to the originating document and frame', async () => {
  const original = globalThis.fetch;
  let started;
  const starting = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    started(); signal.addEventListener('abort', () => reject(new DOMException('internal secret', 'AbortError')), { once: true });
  });
  const request = send({ type: 'ANALYZE', id: 'cancel-me', text: '取消测试' }, content); await starting;
  await send({ type: 'CANCEL', id: 'cancel-me' }, { ...content, frameId: 1 });
  await send({ type: 'CANCEL', id: 'cancel-me' }, content);
  const response = await request; assert(!response.ok); assert.equal(response.error.code, 'TIMEOUT'); assert(!JSON.stringify(response).includes('internal secret'));
  assert(!(session.analysisCache || []).some(item => item.entry.text === '取消测试'));
  globalThis.fetch = original;
});
test('raw provider failures cannot leak secrets through error responses', async () => {
  const original = globalThis.fetch; globalThis.fetch = async () => { throw new Error('private-secret'); };
  const response = await send({ type: 'ANALYZE', text: '网络失败测试' }, content); assert.equal(response.error.code, 'NETWORK'); assert(!JSON.stringify(response).includes('private-secret'));
  globalThis.fetch = original;
});
test('all reading modes reuse one successful result and cache hits remain saveable', async () => {
  const before = requestCount;
  const first = await send({ type: 'ANALYZE', text: '切换缓存测试', mode: 'translate' });
  const second = await send({ type: 'ANALYZE', text: '切换缓存测试', mode: 'explain' }, content);
  const third = await send({ type: 'ANALYZE', text: '切换缓存测试', mode: 'appreciate' });
  assert(first.ok && second.ok && third.ok); assert.equal(requestCount, before + 1);
  assert.equal(first.data.id, second.data.id); assert.equal(first.data.id, third.data.id);
  storage.recent = [];
  assert((await send({ type: 'SAVE_ENTRY', id: third.data.id }, content)).ok);
  assert(!JSON.stringify(session).includes('private-secret'));
});
test('context, model, endpoint, credentials and explicit regeneration cannot reuse an unrelated cache entry', async () => {
  const original = structuredClone(storage.configuration);
  const before = requestCount;
  const text = '缓存隔离测试';
  for (const context of ['上下文甲', '上下文乙']) assert((await send({ type: 'ANALYZE', text, context })).ok);
  for (const [key, value] of [['model', 'another-model'], ['baseUrl', 'https://another-provider.test/v1'], ['apiKey', 'another-secret']]) {
    storage.configuration.providers[0][key] = value; assert((await send({ type: 'ANALYZE', text, context: '上下文乙' })).ok);
  }
  assert((await send({ type: 'ANALYZE', text, context: '上下文乙', force: true })).ok);
  assert.equal(requestCount, before + 6);
  storage.configuration = original;
});
test('failed and cancelled generations are not cached; clearing recent readings clears temporary results', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { requestCount++; return new Response('failed', { status: 500 }); };
  const before = requestCount;
  assert(!(await send({ type: 'ANALYZE', text: '不缓存错误' })).ok);
  assert(!(await send({ type: 'ANALYZE', text: '不缓存错误' })).ok);
  assert.equal(requestCount, before + 2);
  globalThis.fetch = original;
  const a = await send({ type: 'ANALYZE', text: '清空缓存测试' }); assert(a.ok);
  await send({ type: 'CLEAR_RECENT' }); assert(!session.analysisCache);
  const b = await send({ type: 'ANALYZE', text: '清空缓存测试' }); assert(b.ok); assert.notEqual(a.data.id, b.data.id);
});
test('an immediate cancellation during settings lookup stops before any network request', async () => {
  const count = requestCount;
  const request = send({ type: 'ANALYZE', id: 'early-cancel', text: '学' }, content);
  await send({ type: 'CANCEL', id: 'early-cancel' }, content);
  const response = await request; assert(!response.ok); assert.equal(response.error.code, 'CANCELLED'); assert.equal(requestCount, count);
});
test('thinking and docked-reading switches persist and affect the actual DeepSeek request', async () => {
  const settings = { ...DEFAULT_SETTINGS, apiKey: 'private-secret', thinkingEnabled: true, dockedReading: true };
  assert((await send({ type: 'SET_SETTINGS', settings })).ok);
  assert.equal((await send({ type: 'GET_SETTINGS' })).data.thinkingEnabled, true);
  assert.equal((await send({ type: 'PUBLIC_SETTINGS' }, content)).data.thinkingEnabled, true);
  assert((await send({ type: 'ANALYZE', text: '开启深度思考测试' })).ok);
  assert.deepEqual(requestBody.thinking, { type: 'enabled' }); assert.equal(requestBody.max_tokens, 32768);
  settings.thinkingEnabled = false;
  assert((await send({ type: 'SET_SETTINGS', settings })).ok);
  assert.equal((await send({ type: 'GET_SETTINGS' })).data.thinkingEnabled, false);
  assert((await send({ type: 'ANALYZE', text: '关闭深度思考测试' })).ok);
  assert.deepEqual(requestBody.thinking, { type: 'disabled' }); assert.equal(requestBody.max_tokens, 8192);
});

test('multiple configurations persist independently; selecting never calls AI or clears completed cache', async () => {
  const configuration = structuredClone(storage.configuration);
  configuration.providers = ['deepseek', 'openai', 'qwen'].map((kind, i) => ({ id: kind, name: ['DeepSeek', 'OpenAI', '通义千问'][i], kind, baseUrl: ['https://api.deepseek.com', 'https://api.openai.com/v1', 'https://dashscope.aliyuncs.com/compatible-mode/v1'][i], model: ['deepseek-flash', 'gpt-4.1-mini', 'qwen-flash'][i], apiKey: `${kind}-test-secret`, thinkingEnabled: false, jsonMode: false }));
  configuration.activeProviderId = 'deepseek';
  const originalFetch = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, key: options.headers.Authorization }); return originalFetch(url, options); };
  assert((await send({ type: 'SET_CONFIGURATION', configuration })).ok);
  const results = [];
  for (const providerId of ['deepseek', 'openai', 'qwen']) {
    const count = calls.length;
    assert((await send({ type: 'SELECT_PROVIDER', providerId }, content)).ok); assert.equal(calls.length, count);
    const response = await send({ type: 'ANALYZE', text: '多服务隔离' }); assert(response.ok);
    results.push(response.data);
    assert.equal(response.data.providerId, providerId); assert.equal(calls.at(-1).key, `Bearer ${providerId}-test-secret`);
    assert((await send({ type: 'SAVE_ENTRY', id: response.data.id })).ok);
  }
  assert.equal(new Set(results.map(r => r.id)).size, 3);
  const count = calls.length;
  const cached = await send({ type: 'ANALYZE', providerId: 'deepseek', text: '多服务隔离' });
  assert(cached.ok); assert.equal(cached.data.id, results[0].id); assert.equal(calls.length, count);
  assert(!JSON.stringify(await send({ type: 'PUBLIC_SETTINGS' }, content)).includes('test-secret'));
  assert.equal((await send({ type: 'GET_CONFIGURATION' }, content)).error.code, 'DENIED');
  assert((await send({ type: 'DELETE_KEY', providerId: 'openai' })).ok);
  const saved = (await send({ type: 'GET_CONFIGURATION' })).data;
  assert.equal(saved.providers[1].apiKey, ''); assert.equal(saved.providers[0].apiKey, 'deepseek-test-secret'); assert.equal(saved.providers[2].apiKey, 'qwen-test-secret');
  assert.equal((await send({ type: 'ANALYZE', text: '无密钥', providerId: 'openai' })).error.code, 'SETTINGS');
  assert.equal((await send({ type: 'SELECT_PROVIDER', providerId: 'deleted' })).error.code, 'SETTINGS');
  assert.equal((await send({ type: 'ANALYZE', text: '不允许回退', providerId: 'deleted' })).error.code, 'SETTINGS');
  assert.equal(calls.length, count);
  globalThis.fetch = originalFetch;
});

test('switching provider during generation preserves the request snapshot and provenance', async () => {
  let release, started;
  const starting = new Promise(resolve => { started = resolve; });
  const original = globalThis.fetch;
  globalThis.fetch = async () => { started(); await new Promise(resolve => { release = resolve; }); return Response.json({ choices: [{ message: { content: JSON.stringify(EXAMPLE.result) } }] }); };
  const pending = send({ type: 'ANALYZE', providerId: 'deepseek', text: '切换中保持来源', force: true });
  await starting;
  assert((await send({ type: 'SELECT_PROVIDER', providerId: 'qwen' })).ok);
  release(); const response = await pending;
  assert(response.ok); assert.equal(response.data.providerId, 'deepseek'); assert.equal(response.data.providerName, 'DeepSeek');
  globalThis.fetch = original;
});

test('multi-provider saves require granted endpoint origins; revoked permissions also block cached results', async () => {
  const configuration = structuredClone(storage.configuration);
  const before = requestCount; allow = false;
  assert.equal((await send({ type: 'SET_CONFIGURATION', configuration })).error.code, 'PERMISSION');
  assert.deepEqual(storage.configuration, configuration);
  assert.equal((await send({ type: 'ANALYZE', providerId: 'deepseek', text: '切换中保持来源' })).error.code, 'PERMISSION');
  assert.equal(requestCount, before); allow = true;
  const invalid = structuredClone(configuration); invalid.providers[1].id = invalid.providers[0].id;
  assert.equal((await send({ type: 'SET_CONFIGURATION', configuration: invalid })).error.code, 'SETTINGS');
  assert.deepEqual(storage.configuration, configuration);
});

test('native-panel handoff keeps the explicitly selected provider instead of substituting the global default', async () => {
  const before = requestCount;
  const response = await send({ type: 'OPEN_READING_PANEL', text: '明确选择', providerId: 'deepseek' }, { ...content, tab: { id: 1, windowId: 3 } });
  assert(response.ok); assert.equal(session['readingPanel:3'].providerId, 'deepseek'); assert.equal(requestCount, before);
});

test('model discovery is restricted to settings pages, including unsaved configuration previews', async () => {
  const message = { type: 'LIST_MODELS', id: 'catalog', settings: { baseUrl: 'https://catalog.test/v1', apiKey: 'catalog-secret' } };
  assert.equal((await send(message, content)).error.code, 'DENIED');
  assert.equal((await send(message, page)).error.code, 'DENIED');
  const original = globalThis.fetch, originalConfig = structuredClone(storage.configuration); let calls = 0;
  globalThis.fetch = async (url, options) => { calls++; assert.equal(url, 'https://catalog.test/v1/models'); assert.equal(options.headers.Authorization, 'Bearer catalog-secret'); return Response.json({ data: [{ id: 'model-a' }, { id: 'catalog-secret' }] }); };
  const optionsPage = { ...page, url: `chrome-extension://${id}/options.html`, documentId: 'options' };
  const a = await send(message, optionsPage); assert(a.ok); assert.deepEqual(a.data.models, ['model-a']);
  const b = await send(message, optionsPage); assert(b.ok); assert.equal(b.data.cached, true); assert.equal(calls, 1);
  assert.deepEqual(storage.configuration, originalConfig); assert(!JSON.stringify(a).includes('catalog-secret'));
  assert((await send({ ...message, force: true }, optionsPage)).ok); assert.equal(calls, 2);
  allow = false; assert.equal((await send(message, optionsPage)).error.code, 'PERMISSION'); assert.equal(calls, 2); allow = true;
  globalThis.fetch = original;
});
test('model discovery cancellation during permission lookup does not initiate network access', async () => {
  const optionsPage = { ...page, url: `chrome-extension://${id}/options.html`, documentId: 'options' };
  const before = requestCount;
  const job = send({ type: 'LIST_MODELS', id: 'cancel-catalog', settings: { baseUrl: 'https://catalog.test/v1', apiKey: 'catalog-secret' }, force: true }, optionsPage);
  await send({ type: 'CANCEL_MODELS', id: 'cancel-catalog' }, optionsPage);
  assert(!(await job).ok); assert.equal(requestCount, before);
});

test('switching to an unrelated tab closes and clears the old panel; updating other tabs does not', async () => {
  const source = { ...content, tab: { id: 10, windowId: 7 } };
  assert((await send({ type: 'OPEN_READING_PANEL', text: '仅此页面', providerId: 'deepseek' }, source)).ok);
  updatedListener(11, { status: 'loading' }, { id: 11, windowId: 7 });
  await send({ type: 'SAVE_ENTRY', id: 'barrier' });
  assert.equal(session['readingPanel:7'].text, '仅此页面');
  const before = closedPanels.length;
  activatedListener({ tabId: 11, windowId: 7 });
  await send({ type: 'SAVE_ENTRY', id: 'barrier' });
  assert.equal(session['readingPanel:7'], undefined); assert.equal(session['readingPanelOpen:7'], undefined);
  assert.equal(closedPanels.length, before + 1); assert.deepEqual(closedPanels.at(-1), { windowId: 7 });
});
test('same-tab navigation retires its panel, preserving other windows; a late open cannot repopulate stale text', async () => {
  const source = { ...content, tab: { id: 20, windowId: 8 } };
  assert((await send({ type: 'OPEN_READING_PANEL', text: '导航前', providerId: 'deepseek' }, source)).ok);
  assert((await send({ type: 'OPEN_READING_PANEL', text: '其他窗口', providerId: 'deepseek' }, { ...content, tab: { id: 30, windowId: 9 } })).ok);
  updatedListener(20, { status: 'loading' }, source.tab);
  await send({ type: 'SAVE_ENTRY', id: 'barrier' });
  assert.equal(session['readingPanel:8'], undefined); assert.equal(session['readingPanel:9'].text, '其他窗口');
  const original = chrome.sidePanel.open; let release;
  chrome.sidePanel.open = () => new Promise(resolve => { release = resolve; });
  const opening = send({ type: 'OPEN_READING_PANEL', text: '迟到的选文', providerId: 'deepseek' }, source);
  activatedListener({ tabId: 21, windowId: 8 });
  release(); assert(!(await opening).ok);
  await send({ type: 'SAVE_ENTRY', id: 'barrier' });
  assert.equal(session['readingPanel:8'], undefined); assert.equal(session['readingPanelOpen:8'], undefined);
  chrome.sidePanel.open = original;
});
test('leaving the source page cancels its in-flight panel query without caching stale completion', async () => {
  const source = { ...content, tab: { id: 40, windowId: 10 } };
  assert((await send({ type: 'OPEN_READING_PANEL', text: '页面待离开', providerId: 'deepseek' }, source)).ok);
  const original = globalThis.fetch; let started;
  const starting = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => { started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  const job = send({ type: 'ANALYZE', providerId: 'deepseek', text: '页面待离开', id: 'old-page', panelWindowId: 10 }, { ...page, url: `chrome-extension://${id}/panel.html`, documentId: 'panel' });
  await starting; removedListener(40, { windowId: 10 });
  assert(!(await job).ok); assert(!(session.analysisCache || []).some(x => x.entry.text === '页面待离开'));
  globalThis.fetch = original;
});
