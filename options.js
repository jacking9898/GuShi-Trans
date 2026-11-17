import { send, icon } from './lib/ui.js';
import { validateSettings, endpointFrom } from './lib/core.js';
const $ = id => document.getElementById(id);
let savedSettings, busy = false;
$('privacy-icon').append(icon('leaf', 18));

function message(text, error = false) { $('settings-message').textContent = text; $('settings-message').classList.toggle('is-error', error); }
function values() {
  return { baseUrl: $('base-url').value, model: $('model').value, apiKey: $('api-key').value, enabled: $('enabled').checked, includeContext: $('include-context').checked, fontSize: $('large-font').checked ? 'large' : 'normal', jsonMode: $('json-mode').checked };
}
function dirty() { $('dirty').textContent = '有未保存的修改'; $('test-connection').disabled = true; message(''); $('test-result').textContent = ''; }
function fill(settings) {
  $('base-url').value = settings.baseUrl; $('model').value = settings.model; $('api-key').value = settings.apiKey;
  $('enabled').checked = settings.enabled; $('include-context').checked = settings.includeContext; $('large-font').checked = settings.fontSize === 'large'; $('json-mode').checked = settings.jsonMode;
  $('provider').value = settings.baseUrl.replace(/\/$/, '') === 'https://api.deepseek.com' ? 'deepseek' : 'custom';
  $('test-connection').disabled = !settings.apiKey;
}
$('settings-form').addEventListener('input', dirty);
$('provider').onchange = () => {
  $('api-key').value = '';
  if ($('provider').value === 'deepseek') { $('base-url').value = 'https://api.deepseek.com'; $('model').value = 'deepseek-chat'; }
  else { $('base-url').value = ''; $('model').value = ''; $('base-url').focus(); }
  dirty();
};
$('base-url').addEventListener('change', () => {
  try {
    if (savedSettings?.apiKey && endpointFrom($('base-url').value).origin !== endpointFrom(savedSettings.baseUrl).origin && $('api-key').value === savedSettings.apiKey) {
      $('api-key').value = ''; message('接口域名已变更，请填写对应服务商的密钥。');
    }
  } catch { /* Complete validation happens on submit. */ }
});
$('show-key').onclick = () => { const show = $('api-key').type === 'password'; $('api-key').type = show ? 'text' : 'password'; $('show-key').textContent = show ? '隐藏' : '显示'; $('show-key').setAttribute('aria-label', show ? '隐藏 API Key' : '显示 API Key'); $('show-key').setAttribute('aria-pressed', String(show)); };

$('settings-form').onsubmit = async event => {
  event.preventDefault(); if (busy) return;
  let settings;
  try { settings = validateSettings(values()); } catch (error) { message(error.message, true); return; }
  busy = true; $('save').disabled = true; $('save').textContent = '保存中…';
  try {
    // This is the first asynchronous call in a user gesture; do not move it behind a message/read.
    const granted = await chrome.permissions.request({ origins: [endpointFrom(settings.baseUrl).origin] });
    if (!granted) { message('尚未授权接口访问。再次保存并允许访问后，即可使用。', true); return; }
    await send('SET_SETTINGS', { settings }); savedSettings = settings; $('dirty').textContent = ''; $('test-connection').disabled = false;
    message('设置已保存，可以开始阅读了。');
  } catch (error) { message(error.message || '设置未保存，请重试。', true); }
  finally { busy = false; $('save').disabled = false; $('save').textContent = '保存设置'; }
};

$('test-connection').onclick = async () => {
  if (busy) return;
  busy = true; $('test-connection').disabled = true; $('test-result').textContent = '正在用“学”验证已保存的接口…';
  try {
    const entry = await send('ANALYZE', { text: '学', mode: 'explain', id: crypto.randomUUID() });
    $('test-result').textContent = `连接成功。${entry.result.translation}`;
  } catch (error) { $('test-result').textContent = error.message; }
  finally { busy = false; $('test-connection').disabled = !!$('dirty').textContent; }
};
$('delete-key').onclick = async () => {
  if (busy) return;
  try { await send('DELETE_KEY'); $('api-key').value = ''; if (savedSettings) savedSettings.apiKey = ''; $('test-connection').disabled = true; message('本机 API Key 已删除。'); }
  catch (error) { message(error.message, true); }
};
async function init() {
  try { savedSettings = await send('GET_SETTINGS'); fill(savedSettings); }
  catch (error) { message(error.message, true); }
}
init();
