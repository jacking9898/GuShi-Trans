import test from 'node:test';
import assert from 'node:assert/strict';
import { modelSettings, modelsEndpoint, modelsKey, queryModels } from '../lib/models.js';

const settings = modelSettings({ baseUrl: 'https://api.openai.com/v1', apiKey: 'private-test-secret' });
const response = data => Response.json({ data: data.map(id => ({ id })) });
test('normalizes model URLs for all providers, full chat endpoints, gateway prefixes and local ports', () => {
  for (const [base, expected] of [
    ['https://api.openai.com/v1', 'https://api.openai.com/v1/models'],
    ['https://api.deepseek.com', 'https://api.deepseek.com/models'],
    ['https://api.deepseek.com/v1/chat/completions', 'https://api.deepseek.com/v1/models'],
    ['http://localhost:4521/custom/v1/', 'http://localhost:4521/custom/v1/models']
  ]) assert.equal(modelsEndpoint(base).url.href, expected);
  for (const base of ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1']) {
    const { url, qwen } = modelsEndpoint(base); assert(qwen); assert.equal(url.pathname, '/api/v1/models'); assert.equal(url.searchParams.get('page_no'), '1');
  }
  assert.equal(modelsEndpoint('https://workspace.cn-beijing.maas.aliyuncs.com.evil.test/v1').qwen, false);
});
test('catalog settings do not require a saved model but reject unsafe URLs and invalid keys', () => {
  assert.equal(modelSettings({ baseUrl: settings.baseUrl, apiKey: '  key  ' }).apiKey, 'key');
  for (const value of [{ ...settings, apiKey: '' }, { ...settings, apiKey: 'secret\nheader' }, { ...settings, baseUrl: 'http://remote.test' }, { ...settings, baseUrl: 'https://user:secret@api.test' }, { ...settings, baseUrl: 'https://api.test?key=secret' }]) assert.throws(() => modelSettings(value));
});
test('catalog requests use GET, isolated Authorization and no selected text, cookie or request body', async () => {
  let calls = 0;
  const result = await queryModels(settings, new AbortController().signal, async (url, options) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/models'); assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
    assert.deepEqual(options.headers, { Authorization: 'Bearer private-test-secret' }); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
    return response(['gpt-6-luna', 'gpt-4.1-mini', 'gpt-6-luna']);
  });
  assert.equal(calls, 1); assert.deepEqual(result, { models: ['gpt-4.1-mini', 'gpt-6-luna'], truncated: false });
});
test('model IDs are bounded and sanitized; malicious markup, metadata and reflected keys are omitted', async () => {
  const result = await queryModels(settings, new AbortController().signal, async () => Response.json({ data: [{ id: 'safe/model:latest' }, { id: '<img onerror=alert(1)>' }, { id: 'private-test-secret' }, { id: 'x'.repeat(151) }, { id: 'safe/model:latest', secret: settings.apiKey }], secret: settings.apiKey }));
  assert.deepEqual(result.models, ['safe/model:latest']); assert(!JSON.stringify(result).includes(settings.apiKey));
});
test('DashScope catalog pagination follows same-host page numbers and native schema', async () => {
  const requested = [];
  const result = await queryModels({ ...settings, baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' }, new AbortController().signal, async url => {
    const value = new URL(url); requested.push(value.href);
    assert.equal(value.hostname, 'workspace.cn-beijing.maas.aliyuncs.com'); assert.equal(value.pathname, '/api/v1/models');
    return Response.json({ success: true, output: { total: 3, page_size: 2, models: value.searchParams.get('page_no') === '1' ? [{ model: 'qwen-flash' }, { model: 'qwen-plus' }] : [{ model: 'qwen3.8-max' }] } });
  });
  assert.equal(requested.length, 2); assert.deepEqual(result.models, ['qwen-flash', 'qwen-plus', 'qwen3.8-max']);
});
test('catalog failures and unsupported services preserve safe, actionable manual-entry errors', async () => {
  for (const status of [401, 403, 404, 405, 429, 500]) {
    let calls = 0;
    await assert.rejects(queryModels(settings, new AbortController().signal, async () => { calls++; return new Response('private-test-secret', { status }); }), error => error.code === 'MODELS_API' && !error.message.includes(settings.apiKey));
    assert.equal(calls, 1);
  }
  for (const data of [{ random: 'secret' }, { success: false, message: 'private-test-secret' }]) await assert.rejects(queryModels(settings, new AbortController().signal, async () => Response.json(data)), error => error.code === 'MODELS_FORMAT' && !error.message.includes(settings.apiKey));
  assert.deepEqual((await queryModels(settings, new AbortController().signal, async () => response([]))).models, []);
});
test('catalog response size and model counts are bounded', async () => {
  let canceled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2000001)); }, cancel() { canceled = true; } });
  await assert.rejects(queryModels(settings, new AbortController().signal, async () => new Response(stream)), error => error.code === 'MODELS_LIMIT'); assert(canceled);
  const result = await queryModels(settings, new AbortController().signal, async () => response(Array.from({ length: 2001 }, (_, i) => `model-${i}`)));
  assert.equal(result.models.length, 2000); assert.equal(result.truncated, true);
});
test('catalog abort is respected and cache keys isolate endpoints and credentials', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(queryModels(settings, controller.signal, async (_url, { signal }) => { signal.throwIfAborted(); return response([]); }), error => error.name === 'AbortError');
  assert.notEqual(await modelsKey(settings), await modelsKey({ ...settings, apiKey: 'other-secret' }));
  assert.notEqual(await modelsKey(settings), await modelsKey({ ...settings, baseUrl: 'https://other.test/v1' }));
  assert.equal(await modelsKey(settings), await modelsKey({ ...settings, baseUrl: 'https://api.openai.com/v1/chat/completions' }));
});
