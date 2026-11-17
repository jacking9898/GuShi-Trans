import { send, icon, el } from './lib/ui.js';
import { endpointFrom, supportsThinking } from './lib/core.js';
import { modelSettings } from './lib/models.js';
import { PRESETS, newProvider, validateConfiguration } from './lib/providers.js';
const $ = id => document.getElementById(id);
let configuration, savedConfiguration, editingId, loadedProfile, busy = false;
let modelGeneration = 0, activeModelId = null, modelTimer, modelIds = [];
$('privacy-icon').append(icon('leaf', 18));
function message(text, error = false) { $('settings-message').textContent = text; $('settings-message').classList.toggle('is-error', error); }
function profileValues() {
  return { id: editingId, name: $('profile-name').value, kind: $('provider').value, baseUrl: $('base-url').value, model: $('model').value, apiKey: $('api-key').value, jsonMode: $('json-mode').checked, thinkingEnabled: $('thinking-enabled').checked };
}
function capture() {
  if (editingId) configuration.providers = configuration.providers.map(p => p.id === editingId ? profileValues() : p);
  configuration.preferences = { enabled: $('enabled').checked, includeContext: $('include-context').checked, fontSize: $('large-font').checked ? 'large' : 'normal', dockedReading: $('docked-reading').checked };
}
function protectKey() {
  try {
    if (loadedProfile?.apiKey && endpointFrom($('base-url').value).origin !== endpointFrom(loadedProfile.baseUrl).origin && $('api-key').value === loadedProfile.apiKey) {
      $('api-key').value = ''; message('接口域名已变更，请填写对应服务商的密钥。');
    }
  } catch { /* Validation on save handles incomplete addresses. */ }
}
function resetModels() {
  ++modelGeneration; clearTimeout(modelTimer);
  if (activeModelId) send('CANCEL_MODELS', { id: activeModelId }).catch(() => {});
  activeModelId = null; modelIds = [];
  $('model-browser').hidden = true; $('available-models').replaceChildren(); $('model-search').value = '';
  $('fetch-models').disabled = false; $('fetch-models').textContent = '获取模型列表';
  $('models-status').classList.remove('is-error'); $('models-status').textContent = '填好地址与 Key 后，已授权的接口会自动加载模型。';
}
function renderModels() {
  const query = $('model-search').value.trim().toLowerCase();
  const filtered = modelIds.filter(id => id.toLowerCase().includes(query));
  const root = $('available-models'); root.replaceChildren();
  for (const id of filtered) { const option = el('option', '', id); option.value = id; root.append(option); }
  if (!filtered.length) { const option = el('option', '', '没有匹配的模型，仍可在上方手动填写'); option.disabled = true; root.append(option); }
  root.value = $('model').value; // Never silently replace the reader's configured model.
  $('models-count').textContent = `显示 ${filtered.length} / ${modelIds.length} 个模型`;
}
function queueModels() { clearTimeout(modelTimer); modelTimer = setTimeout(() => fetchModels(false, false), 250); }
async function fetchModels(manual = false, force = false) {
  clearTimeout(modelTimer);
  if (!configuration || !editingId || busy) return;
  let settings;
  try { protectKey(); settings = modelSettings(profileValues()); }
  catch (error) { if (manual) { $('models-status').textContent = error.message; $('models-status').classList.add('is-error'); } return; }
  if (activeModelId) send('CANCEL_MODELS', { id: activeModelId }).catch(() => {});
  const token = ++modelGeneration, id = crypto.randomUUID(); activeModelId = id;
  $('fetch-models').disabled = true; $('fetch-models').textContent = '获取中…';
  $('models-status').textContent = '正在读取当前服务的模型列表…'; $('models-status').classList.remove('is-error');
  try {
    const origins = [endpointFrom(settings.baseUrl).origin];
    // A new host needs a user gesture. Automatic loads only use already granted hosts.
    const allowed = manual ? await chrome.permissions.request({ origins }) : await chrome.permissions.contains({ origins });
    if (token !== modelGeneration) return;
    if (!allowed) { $('models-status').textContent = '点击“获取模型列表”并允许访问此接口域名后，即可加载。'; return; }
    const result = await send('LIST_MODELS', { id, settings, force });
    if (token !== modelGeneration) return;
    modelIds = result.models; $('model-search').value = ''; renderModels();
    $('model-browser').hidden = modelIds.length === 0;
    const missing = modelIds.length && !modelIds.includes($('model').value) ? ' 当前模型不在列表中，已保留原填写值。' : '';
    $('models-status').textContent = modelIds.length ? `已获取 ${modelIds.length} 个模型${result.cached ? '（最近缓存）' : ''}。${result.truncated ? '列表较长，显示前 2000 个。' : ''}${missing}` : '服务未返回可用模型，可继续手动填写模型 ID。';
  } catch (error) {
    if (token !== modelGeneration) return;
    $('model-browser').hidden = true;
    $('models-status').textContent = error.code === 'TIMEOUT' ? '获取模型列表超时，可点击重试或手动填写模型 ID。' : error.code === 'NETWORK' ? '未能连接模型列表接口，请检查地址和网络；仍可手动填写。' : error.message;
    $('models-status').classList.add('is-error');
  } finally {
    if (token === modelGeneration) { activeModelId = null; $('fetch-models').disabled = false; $('fetch-models').textContent = '刷新模型列表'; }
  }
}
$('fetch-models').onclick = () => fetchModels(true, true);
$('model-search').oninput = renderModels;
$('available-models').onchange = () => {
  if (!modelIds.includes($('available-models').value)) return;
  $('model').value = $('available-models').value; updateThinkingControl(); dirty();
};
for (const id of ['base-url', 'api-key']) {
  $(id).addEventListener('input', resetModels);
  $(id).addEventListener('change', queueModels);
}
window.addEventListener('pagehide', resetModels);
function updateThinkingControl() {
  const supported = supportsThinking(profileValues()); $('thinking-enabled').disabled = !supported;
  if (!supported) $('thinking-enabled').checked = false;
  $('thinking-help').textContent = supported ? '默认关闭，直接生成译注。开启后会增加等待时间和用量，仅影响这套配置。' : '此模型未提供可用的思考开关。OpenAI 预设使用无需推理的 gpt-4.1-mini；其他模型按服务商能力运行。';
}
function dirty() { $('dirty').textContent = '有未保存的修改'; $('test-connection').disabled = true; message(''); $('test-result').textContent = ''; }
function renderList() {
  const root = $('provider-list'); root.replaceChildren();
  for (const p of configuration.providers) {
    const b = el('button', 'provider-card'); b.type = 'button'; b.dataset.providerId = p.id;
    b.classList.toggle('is-active', p.id === editingId); b.setAttribute('aria-pressed', String(p.id === editingId));
    b.append(el('strong', '', p.name || '未命名配置'), el('span', 'sw-small sw-muted', `${p.model || '待填模型'}${p.id === configuration.activeProviderId ? ' · 默认' : ''}${p.apiKey ? '' : ' · 待填密钥'}`));
    b.onclick = () => { if (busy) return; protectKey(); capture(); fillProfile(p.id); };
    root.append(b);
  }
  $('provider-empty').hidden = configuration.providers.length > 0;
  $('provider-editor').hidden = !editingId; $('provider-editor').disabled = !editingId;
  $('make-default').disabled = !editingId || editingId === configuration.activeProviderId;
  $('remove-provider').disabled = !editingId;
  $('delete-key').disabled = !editingId;
}
function fillProfile(id) {
  resetModels();
  editingId = id; const p = configuration.providers.find(p => p.id === id);
  if (!p) { editingId = null; renderList(); return; }
  loadedProfile = structuredClone(p);
  $('profile-name').value = p.name; $('provider').value = p.kind;
  $('base-url').value = p.baseUrl; $('model').value = p.model; $('api-key').value = p.apiKey;
  $('api-key').type = 'password'; $('show-key').textContent = '显示'; $('show-key').setAttribute('aria-pressed', 'false'); $('show-key').setAttribute('aria-label', '显示 API Key');
  $('json-mode').checked = p.jsonMode; $('thinking-enabled').checked = p.thinkingEnabled;
  updateThinkingControl(); renderList();
  $('test-connection').disabled = !!$('dirty').textContent || !savedConfiguration?.providers.some(x => x.id === id && x.apiKey);
  queueModels();
}
function fill(value) {
  configuration = structuredClone(value); savedConfiguration = structuredClone(value);
  const prefs = value.preferences;
  $('enabled').checked = prefs.enabled; $('include-context').checked = prefs.includeContext; $('large-font').checked = prefs.fontSize === 'large'; $('docked-reading').checked = prefs.dockedReading;
  fillProfile(configuration.providers.some(p => p.id === editingId) ? editingId : configuration.activeProviderId);
}
$('settings-form').addEventListener('input', event => { if (event.target.id !== 'model-search') dirty(); });
$('add-provider').onclick = () => {
  if (busy) return;
  if (configuration.providers.length >= 20) { message('最多保存 20 套 AI 配置。', true); return; }
  protectKey(); capture(); const p = newProvider($('new-provider-kind').value); configuration.providers.push(p);
  if (!configuration.activeProviderId) configuration.activeProviderId = p.id;
  dirty(); fillProfile(p.id); $('profile-name').focus();
};
$('make-default').onclick = () => { if (busy) return; capture(); configuration.activeProviderId = editingId; dirty(); renderList(); };
$('remove-provider').onclick = () => {
  if (busy) return;
  capture(); configuration.providers = configuration.providers.filter(p => p.id !== editingId);
  if (configuration.activeProviderId === editingId) configuration.activeProviderId = configuration.providers[0]?.id || null;
  dirty(); fillProfile(configuration.activeProviderId); message('已从列表移除，保存设置后生效。');
};
$('provider').onchange = () => {
  resetModels();
  const preset = PRESETS[$('provider').value];
  $('api-key').value = ''; $('base-url').value = preset.baseUrl; $('model').value = preset.model;
  $('profile-name').value = preset.name; $('thinking-enabled').checked = false; $('json-mode').checked = false;
  updateThinkingControl(); dirty();
};
$('model').addEventListener('input', updateThinkingControl);
$('base-url').addEventListener('input', updateThinkingControl);
$('base-url').addEventListener('change', protectKey);
$('show-key').onclick = () => { const show = $('api-key').type === 'password'; $('api-key').type = show ? 'text' : 'password'; $('show-key').textContent = show ? '隐藏' : '显示'; $('show-key').setAttribute('aria-label', show ? '隐藏 API Key' : '显示 API Key'); $('show-key').setAttribute('aria-pressed', String(show)); };
function lock(value) {
  busy = value;
  for (const fieldset of document.querySelectorAll('#settings-form fieldset')) fieldset.disabled = value || !editingId;
  $('save').disabled = value; $('delete-key').disabled = value || !editingId; $('save').textContent = value ? '保存中…' : '保存设置';
}
$('settings-form').onsubmit = async event => {
  event.preventDefault(); if (busy) return;
  let value;
  try { protectKey(); capture(); value = validateConfiguration(configuration); } catch (error) { message(error.message, true); return; }
  lock(true);
  try {
    const origins = [...new Set(value.providers.filter(p => p.apiKey).map(p => endpointFrom(p.baseUrl).origin))];
    // Keep the permission request in the initiating user gesture.
    const granted = !origins.length || await chrome.permissions.request({ origins });
    if (!granted) { message('尚未授权接口访问。再次保存并允许访问后，即可使用。', true); return; }
    await send('SET_CONFIGURATION', { configuration: value }); $('dirty').textContent = ''; fill(value);
    message('设置已保存。每套配置独立保留，切换不会自动查询。');
  } catch (error) { message(error.message || '设置未保存，请重试。', true); }
  finally { lock(false); }
};
$('test-connection').onclick = async () => {
  if (busy) return;
  busy = true; $('test-connection').disabled = true; $('test-result').textContent = '正在用“学”验证当前已保存的配置…';
  try {
    const entry = await send('ANALYZE', { text: '学', mode: 'explain', providerId: editingId, id: crypto.randomUUID(), force: true });
    $('test-result').textContent = `连接成功。${entry.result.translation}`;
  } catch (error) { $('test-result').textContent = error.message; }
  finally { busy = false; $('test-connection').disabled = !!$('dirty').textContent; }
};
$('delete-key').onclick = async () => {
  if (busy || !editingId) return;
  try {
    await send('DELETE_KEY', { providerId: editingId }); resetModels(); $('api-key').value = '';
    for (const value of [configuration, savedConfiguration]) { const p = value.providers.find(p => p.id === editingId); if (p) p.apiKey = ''; }
    loadedProfile.apiKey = ''; $('test-connection').disabled = true; renderList(); message('当前配置的本机 API Key 已删除，其他配置不受影响。');
  } catch (error) { message(error.message, true); }
};
try { fill(await send('GET_CONFIGURATION')); } catch (error) { message(error.message, true); }
