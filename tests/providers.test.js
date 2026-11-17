import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, analysisKey, requestPolicy, supportsThinking } from '../lib/core.js';
import { newProvider, migrateSettings, validateConfiguration, resolveSettings, publicProviders, PRESETS } from '../lib/providers.js';
import { queryAI } from '../lib/ai.js';

const config = () => ({ version: 2, preferences: { enabled: true, includeContext: false, fontSize: 'large', dockedReading: true }, providers: ['deepseek', 'openai', 'qwen'].map(kind => ({ ...newProvider(kind, kind), apiKey: `${kind}-secret` })), activeProviderId: 'deepseek' });
test('legacy migration preserves custom endpoint, key, model and every preference without duplicating secrets', () => {
  const legacy = { ...DEFAULT_SETTINGS, apiKey: 'legacy-secret', baseUrl: 'https://custom.test/v1', model: 'custom-model', includeContext: true, enabled: false, thinkingEnabled: false, jsonMode: true, dockedReading: false, fontSize: 'large' };
  const configuration = migrateSettings(legacy);
  const resolved = resolveSettings(configuration);
  for (const key of Object.keys(legacy)) assert.equal(resolved[key], legacy[key]);
  assert.equal(configuration.providers[0].kind, 'custom');
  assert.equal(JSON.stringify(configuration).split('legacy-secret').length, 2);
  assert.equal(migrateSettings({}).providers[0].thinkingEnabled, false);
});
test('configuration validation normalizes profiles, supports keyless drafts and safe empty state', () => {
  const value = config(); value.providers[1].apiKey = ''; value.providers[0].name = '  日常阅读  ';
  const valid = validateConfiguration(value);
  assert.equal(valid.providers[0].name, '日常阅读'); assert.equal(valid.providers[1].apiKey, '');
  assert.deepEqual(validateConfiguration({ providers: [], activeProviderId: null }).providers, []);
  for (const change of [v => { v.providers[1].id = v.providers[0].id; }, v => { v.activeProviderId = 'unknown'; }, v => { v.providers[0].name = ''; }, v => { v.providers[1].apiKey = 'key\nheader'; }, v => { v.providers[2].baseUrl = 'http://remote.test'; }]) {
    const value = config(); change(value); assert.throws(() => validateConfiguration(value));
  }
});
test('public profiles contain only display metadata, and explicit unknown IDs cannot silently select another provider', () => {
  const value = config();
  const metadata = publicProviders(value);
  assert(!JSON.stringify(metadata).includes('secret')); assert(!JSON.stringify(metadata).includes('https://'));
  assert.equal(metadata.providers.length, 3); assert.equal(resolveSettings(value, 'qwen').apiKey, 'qwen-secret');
  assert.throws(() => resolveSettings(value, 'deleted'));
});
test('all three presets use isolated endpoint, model and Authorization; thinking is explicitly off when supported', async () => {
  for (const kind of ['deepseek', 'openai', 'qwen']) {
    const settings = resolveSettings(config(), kind);
    let call;
    await queryAI(settings, { text: '学', mode: 'explain' }, new AbortController().signal, async (url, options) => {
      call = { url, ...options, payload: JSON.parse(options.body) };
      return Response.json({ choices: [{ message: { content: '{"translation":"学习"}' } }] });
    });
    assert.equal(call.headers.Authorization, `Bearer ${kind}-secret`);
    assert.equal(call.url, `${PRESETS[kind].baseUrl}/chat/completions`);
    assert.equal(call.payload.model, PRESETS[kind].model);
    assert.equal(call.payload[kind === 'openai' ? 'max_completion_tokens' : 'max_tokens'], 8192);
    assert.equal(call.payload[kind === 'openai' ? 'max_tokens' : 'max_completion_tokens'], undefined);
    assert.equal(call.payload.enable_thinking, kind === 'qwen' ? false : undefined);
    assert.deepEqual(call.payload.thinking, kind === 'deepseek' ? { type: 'disabled' } : undefined);
  }
});
test('Qwen thinking is supported only for recognized official hosts and hybrid text models', () => {
  for (const baseUrl of ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1']) {
    const settings = { baseUrl, model: 'qwen-flash', thinkingEnabled: true };
    assert(supportsThinking(settings)); assert.equal(requestPolicy(settings).thinking, true); assert.equal(requestPolicy(settings).qwen, true);
  }
  for (const settings of [{ baseUrl: 'https://evil.maas.aliyuncs.com.evil.test', model: 'qwen-flash' }, { baseUrl: PRESETS.qwen.baseUrl, model: 'qwen3-coder-plus' }, { baseUrl: PRESETS.openai.baseUrl, model: 'gpt-4.1-mini' }]) assert(!supportsThinking(settings));
});
test('profile identity isolates cache entries even when endpoint, key and model coincide', async () => {
  const a = { ...DEFAULT_SETTINGS, apiKey: 'key', providerId: 'a' }, b = { ...a, providerId: 'b' };
  const query = { text: '学', context: '' };
  assert.notEqual(await analysisKey(a, query), await analysisKey(b, query));
});

test('Qwen opt-in uses enable_thinking and never emits DeepSeek thinking parameters', async () => {
  const settings = { ...resolveSettings(config(), 'qwen'), thinkingEnabled: true };
  let payload;
  await queryAI(settings, { text: '学', mode: 'explain' }, new AbortController().signal, async (_url, options) => {
    payload = JSON.parse(options.body);
    return Response.json({ choices: [{ message: { content: '{"translation":"学习"}' } }] });
  });
  assert.equal(payload.enable_thinking, true); assert.equal(payload.thinking, undefined); assert.equal(payload.max_tokens, 32768);
});

test('GPT-6 Luna regression: official OpenAI rejects legacy max_tokens; supported payload uses max_completion_tokens and explicit none/medium', async () => {
  const settings = { ...resolveSettings(config(), 'openai'), model: 'gpt-6-luna' };
  assert(supportsThinking(settings));
  for (const thinkingEnabled of [false, true]) {
    let calls = 0;
    const actual = await queryAI({ ...settings, thinkingEnabled }, { text: '学', mode: 'explain' }, new AbortController().signal, async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      if ('max_tokens' in body) return Response.json({ error: { code: 'unsupported_parameter', param: 'max_tokens', message: 'Unsupported parameter: max_tokens' } }, { status: 400 });
      assert.equal(body.max_completion_tokens, thinkingEnabled ? 32768 : 8192);
      assert.equal(body.reasoning_effort, thinkingEnabled ? 'medium' : 'none');
      assert.equal(body.thinking, undefined); assert.equal(body.enable_thinking, undefined);
      return Response.json({ choices: [{ message: { content: '{"translation":"学习"}' } }] });
    });
    assert.equal(actual.translation, '学习'); assert.equal(calls, 1);
  }
});
test('unrecognized models and custom gateways do not receive a guessed reasoning_effort', async () => {
  for (const settings of [{ ...resolveSettings(config(), 'openai'), model: 'gpt-4.1-mini' }, { ...resolveSettings(config(), 'openai'), model: 'unknown-future-model' }, { ...resolveSettings(config(), 'openai'), model: 'gpt-6-luna', baseUrl: 'https://gateway.test/v1' }]) {
    assert(!supportsThinking(settings));
    await queryAI(settings, { text: '学' }, new AbortController().signal, async (_url, options) => {
      assert.equal(JSON.parse(options.body).reasoning_effort, undefined);
      return Response.json({ choices: [{ message: { content: '{"translation":"学习"}' } }] });
    });
  }
});
test('OpenAI thinking changes affect the cache policy and validation while remaining disabled by default', async () => {
  const settings = { ...resolveSettings(config(), 'openai'), model: 'gpt-6-luna' };
  assert.equal(requestPolicy(settings).thinking, false);
  assert.notEqual(await analysisKey(settings, { text: '学' }), await analysisKey({ ...settings, thinkingEnabled: true }, { text: '学' }));
});
