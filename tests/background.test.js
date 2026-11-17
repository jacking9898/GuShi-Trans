import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../lib/core.js';
import { EXAMPLE } from '../lib/example.js';
const id = 'extension-test';
const storage = {};
let handler, accessLevel, allow = true, requestBody, requestCount = 0;
globalThis.chrome = {
  storage: {
    local: {
      async setAccessLevel(value) { accessLevel = value; },
      async get(keys) { return Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter(k => k in storage).map(k => [k, structuredClone(storage[k])])); },
      async set(value) { Object.assign(storage, structuredClone(value)); },
      async remove(key) { delete storage[key]; }
    },
    session: { async get() { return {}; }, async remove() {} }
  },
  runtime: { id, getURL: path => `chrome-extension://${id}/${path}`, onInstalled: { addListener() {} }, onMessage: { addListener(fn) { handler = fn; } }, async openOptionsPage() {}, async getPlatformInfo() { return {}; } },
  contextMenus: { onClicked: { addListener() {} } },
  permissions: { async contains() { return allow; } }
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
  assert.equal((await send({ type: 'GET_SETTINGS' }, { ...page, tab: { id: 2 } })).data.apiKey, 'private-secret');
  assert.equal((await send({ type: 'GET_SETTINGS' }, { ...page, id: 'another-extension' })).error.code, 'DENIED');
});
test('permission denial prevents network requests and missing API key produces clear setup error', async () => {
  const count = requestCount; allow = false;
  assert.equal((await send({ type: 'ANALYZE', text: '学' })).error.code, 'PERMISSION'); assert.equal(requestCount, count);
  allow = true; storage.settings.apiKey = '';
  assert.equal((await send({ type: 'ANALYZE', text: '学' })).error.code, 'SETTINGS');
  storage.settings.apiKey = 'private-secret';
});
test('context is opt-in on the backend; page-supplied endpoint cannot redirect the API key', async () => {
  let fetchedURL; const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => { fetchedURL = url; return original(url, options); };
  const response = await send({ type: 'ANALYZE', text: '穷', context: 'nearby private text', endpoint: 'https://evil.test' }, content);
  assert(response.ok); assert.equal(JSON.parse(requestBody.messages[1].content).context, '未提供，请保留歧义。'); assert.equal(fetchedURL, 'https://api.deepseek.com/chat/completions');
  storage.settings.includeContext = true;
  await send({ type: 'ANALYZE', text: '穷', context: '水穷处' }, content);
  assert.equal(JSON.parse(requestBody.messages[1].content).context, '水穷处');
  globalThis.fetch = original;
});
test('paused selection queries blocked while manual trusted-page queries remain available', async () => {
  storage.settings.enabled = false;
  assert.equal((await send({ type: 'ANALYZE', text: '学' }, content)).error.code, 'DISABLED');
  assert((await send({ type: 'ANALYZE', text: '学' })).ok); storage.settings.enabled = true;
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
  const request = send({ type: 'ANALYZE', id: 'cancel-me', text: '学' }, content); await starting;
  await send({ type: 'CANCEL', id: 'cancel-me' }, { ...content, frameId: 1 });
  await send({ type: 'CANCEL', id: 'cancel-me' }, content);
  const response = await request; assert(!response.ok); assert.equal(response.error.code, 'TIMEOUT'); assert(!JSON.stringify(response).includes('internal secret'));
  globalThis.fetch = original;
});
test('raw provider failures cannot leak secrets through error responses', async () => {
  const original = globalThis.fetch; globalThis.fetch = async () => { throw new Error('private-secret'); };
  const response = await send({ type: 'ANALYZE', text: '学' }, content); assert.equal(response.error.code, 'NETWORK'); assert(!JSON.stringify(response).includes('private-secret'));
  globalThis.fetch = original;
});
test('an immediate cancellation during settings lookup stops before any network request', async () => {
  const count = requestCount;
  const request = send({ type: 'ANALYZE', id: 'early-cancel', text: '学' }, content);
  await send({ type: 'CANCEL', id: 'early-cancel' }, content);
  const response = await request; assert(!response.ok); assert.equal(response.error.code, 'CANCELLED'); assert.equal(requestCount, count);
});
