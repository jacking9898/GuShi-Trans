import { send, icon, el } from './lib/ui.js';
import { endpointFrom, supportsThinking } from './lib/core.js';
import { PRESETS, newProvider, validateConfiguration } from './lib/providers.js';
const $ = id => document.getElementById(id);
let configuration, savedConfiguration, editingId, loadedProfile, busy = false;
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
  editingId = id; const p = configuration.providers.find(p => p.id === id);
  if (!p) { editingId = null; renderList(); return; }
  loadedProfile = structuredClone(p);
  $('profile-name').value = p.name; $('provider').value = p.kind;
  $('base-url').value = p.baseUrl; $('model').value = p.model; $('api-key').value = p.apiKey;
  $('api-key').type = 'password'; $('show-key').textContent = '显示'; $('show-key').setAttribute('aria-pressed', 'false'); $('show-key').setAttribute('aria-label', '显示 API Key');
  $('json-mode').checked = p.jsonMode; $('thinking-enabled').checked = p.thinkingEnabled;
  updateThinkingControl(); renderList();
  $('test-connection').disabled = !!$('dirty').textContent || !savedConfiguration?.providers.some(x => x.id === id && x.apiKey);
}
function fill(value) {
  configuration = structuredClone(value); savedConfiguration = structuredClone(value);
  const prefs = value.preferences;
  $('enabled').checked = prefs.enabled; $('include-context').checked = prefs.includeContext; $('large-font').checked = prefs.fontSize === 'large'; $('docked-reading').checked = prefs.dockedReading;
  fillProfile(configuration.providers.some(p => p.id === editingId) ? editingId : configuration.activeProviderId);
}
$('settings-form').addEventListener('input', dirty);
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
    await send('DELETE_KEY', { providerId: editingId }); $('api-key').value = '';
    for (const value of [configuration, savedConfiguration]) { const p = value.providers.find(p => p.id === editingId); if (p) p.apiKey = ''; }
    loadedProfile.apiKey = ''; $('test-connection').disabled = true; renderList(); message('当前配置的本机 API Key 已删除，其他配置不受影响。');
  } catch (error) { message(error.message, true); }
};
try { fill(await send('GET_CONFIGURATION')); } catch (error) { message(error.message, true); }
