import { icon, button, send, renderResult, loadingView, errorView, stopSpeech, providerPicker } from './lib/ui.js';
import { resultToText } from './lib/core.js';

const $ = id => document.getElementById(id);
const views = new Map(), scrollPositions = new Map();
let query = null, entry = null, error = null, mode = 'translate', activeId = null, generation = 0, windowKey, panelWindowId, lastVersion = 0;
let picker, selectedProviderId, providerData;
function updateProviders(data) {
  providerData = data; selectedProviderId = data.activeProviderId; picker?.update(data);
  if (data.fontSize) document.body.classList.toggle('sw-large', data.fontSize === 'large');
  const p = data.providers.find(p => p.id === selectedProviderId);
  if (query) query = { ...query, providerId: selectedProviderId, thinkingEnabled: p?.thinkingEnabled === true };
  $('panel-thinking').textContent = p?.thinkingEnabled ? '深度思考 · 开' : '直接译注 · 思考已关';
}
$('panel-settings').append(icon('settings'));
$('panel-settings').onclick = () => send('OPEN_OPTIONS').catch(showError);
$('panel-start').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('reader.html?wide=1') });

function setMode(value) {
  if (entry) scrollPositions.set(mode, $('panel-body').scrollTop);
  mode = value;
  for (const b of document.querySelectorAll('#panel-modes [data-mode]')) { b.classList.toggle('is-active', b.dataset.mode === mode); b.setAttribute('aria-pressed', String(b.dataset.mode === mode)); }
  stopSpeech();
  if (entry) showResult();
}
for (const b of document.querySelectorAll('#panel-modes [data-mode]')) b.onclick = () => setMode(b.dataset.mode);

function showError(value) {
  error = value;
  $('panel-body').replaceChildren(errorView(value, query ? () => analyze(true) : null));
}

function showResult() {
  if (!views.has(mode)) views.set(mode, renderResult(entry, {
    mode,
    onSave: e => send('SAVE_ENTRY', { id: e.id }),
    onCopy: e => navigator.clipboard.writeText(resultToText(e)),
    onRefresh: () => analyze(true),
    onWord: (text, context) => acceptQuery({ ...query, text, context, mode: 'explain', force: false }, true)
  }));
  $('panel-body').replaceChildren(views.get(mode)); $('panel-body').scrollTop = scrollPositions.get(mode) || 0;
}

function cancel() {
  ++generation;
  if (activeId) send('CANCEL', { id: activeId }).catch(() => {});
  activeId = null;
}

async function analyze(force = false) {
  if (!query) return;
  cancel(); stopSpeech(); entry = null; error = null; views.clear(); scrollPositions.clear();
  const token = ++generation, id = crypto.randomUUID(); activeId = id;
  $('panel-body').replaceChildren(loadingView(query.text, query.thinkingEnabled)); $('panel-body').scrollTop = 0;
  const cancelButton = button('取消查询', '', 'sw-text-button');
  cancelButton.onclick = () => { cancel(); showError(Object.assign(new Error('查询已取消。需要时可重新查询。'), { code: 'CANCELLED' })); };
  $('panel-body').append(cancelButton);
  try {
    const result = await send('ANALYZE', { id, text: query.text, context: query.context, mode, force, panelWindowId, providerId: query.providerId });
    if (token !== generation) return;
    entry = result; showResult();
  } catch (value) { if (token === generation) showError(value); }
  finally { if (activeId === id) activeId = null; }
}

function acceptQuery(value, local = false) {
  if (!value || (!local && value.version < lastVersion)) return;
  if (!local) lastVersion = value.version;
  const same = query && query.text.trim() === value.text.trim() && query.context === value.context && query.thinkingEnabled === value.thinkingEnabled && query.revision === value.revision && query.providerId === value.providerId;
  query = value;
  selectedProviderId = value.providerId;
  if (providerData) picker?.update({ ...providerData, activeProviderId: value.providerId });
  document.body.classList.toggle('sw-large', value.fontSize === 'large');
  $('panel-thinking').textContent = value.thinkingEnabled ? '深度思考 · 开' : '直接译注 · 思考已关';
  setMode(value.mode);
  if (same && !value.force && (entry || activeId || error)) return;
  analyze(value.force === true);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && windowKey && changes[windowKey]?.newValue) acceptQuery(changes[windowKey].newValue);
  if (area === 'local' && changes.configuration) {
    send('PUBLIC_SETTINGS').then(updateProviders).catch(showError);
    // Existing results and active requests keep their own provider provenance.
    // Selecting a new provider never generates or cancels a request.
  }
});
window.addEventListener('pagehide', () => { cancel(); stopSpeech(); });

try {
  const settings = await send('PUBLIC_SETTINGS');
  picker = providerPicker(settings, updateProviders); document.querySelector('.panel-intro').after(picker.root); updateProviders(settings);
  const currentWindow = await chrome.windows.getCurrent(); panelWindowId = currentWindow.id; windowKey = `readingPanel:${currentWindow.id}`;
  const values = await chrome.storage.session.get(windowKey);
  if (values[windowKey]) acceptQuery(values[windowKey]);
} catch (value) { showError(Object.assign(new Error('无法读取待查文字，请重新在网页中划词。'), { code: 'PANEL' })); }
