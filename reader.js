import { el, icon, button, send, renderResult, loadingView, errorView, stopSpeech } from './lib/ui.js';
import { resultToText } from './lib/core.js';
import { EXAMPLE } from './lib/example.js';

const $ = id => document.getElementById(id);
const wide = new URLSearchParams(location.search).get('wide') === '1';
if (wide) { document.body.classList.add('wide'); $('expand').hidden = true; }
$('expand').append(icon('arrow')); $('settings').append(icon('settings')); $('export').append(icon('download')); $('search-icon').append(icon('search', 16));
$('settings').onclick = $('setup').onclick = () => send('OPEN_OPTIONS').catch(showInputError);
$('expand').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('reader.html?wide=1') });
let mode = 'translate', activeId = null, requestToken = 0, library = { saved: [], recent: [] }, currentTab = 'read';

function showInputError(error) { $('query-error').textContent = error.message; }
function setMode(value) {
  mode = value;
  for (const b of document.querySelectorAll('#query-form [data-mode]')) { b.classList.toggle('is-active', b.dataset.mode === mode); b.setAttribute('aria-pressed', String(b.dataset.mode === mode)); }
}
for (const b of document.querySelectorAll('#query-form [data-mode]')) b.onclick = () => setMode(b.dataset.mode);
for (const b of document.querySelectorAll('.sample-shortcuts [data-text]')) b.onclick = () => { $('query').value = b.dataset.text; updateCount(); setMode(b.dataset.mode); $('query').focus(); };
function updateCount() { const length = [...$('query').value].length; $('query-count').textContent = `${length} / 1600`; $('query-count').classList.toggle('is-over', length > 1600); }
$('query').oninput = () => { updateCount(); $('query-error').textContent = ''; };
$('query').onkeydown = event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); $('query-form').requestSubmit(); } };

function cancel() { requestToken++; if (activeId) send('CANCEL', { id: activeId }).catch(() => {}); activeId = null; $('query-submit').disabled = false; $('query-submit').textContent = '读一读 ↗'; }
function clearResult() { cancel(); stopSpeech(); $('result-area').replaceChildren(); $('result-area').hidden = true; $('welcome').hidden = false; $('query-heading').scrollIntoView({ block: 'start' }); }
function scrollToResult() { requestAnimationFrame(() => { if (currentTab === 'read' && !$('result-area').hidden) $('result-area').scrollIntoView({ block: 'start' }); }); }
function backLine(label, callback) {
  const row = el('div', 'back-line'); const back = button('返回', 'back', 'sw-text-button sw-inline'); back.onclick = callback;
  row.append(back, el('span', 'sw-muted sw-small', label)); return row;
}
function resultOptions(example = false) {
  return {
    example,
    onSave: async entry => { await send('SAVE_ENTRY', { id: entry.id }); await loadLibrary(); },
    onCopy: entry => navigator.clipboard.writeText(resultToText(entry)),
    onWord: (text, context) => { $('query').value = text; updateCount(); setMode('explain'); switchTab('read'); analyze(text, 'explain', context); }
  };
}
function displayEntry(entry, example = false) {
  stopSpeech(); $('welcome').hidden = true; $('result-area').hidden = false;
  $('result-area').replaceChildren(backLine(example ? '先看一则示例，再读你的诗文' : '译注已完成', clearResult), renderResult(entry, resultOptions(example)));
  scrollToResult();
}

async function analyze(text, selectedMode, context = '') {
  if (!text.trim()) { showInputError(new Error('先写下想读的字词或诗文。')); $('query').focus(); return; }
  if ([...text.trim()].length > 1600) { showInputError(new Error('一次最多 1600 字，请分段阅读。')); return; }
  cancel(); stopSpeech(); const token = ++requestToken; const id = crypto.randomUUID(); activeId = id;
  $('query-error').textContent = ''; $('query-submit').disabled = true; $('query-submit').textContent = '推敲中…';
  $('welcome').hidden = true; $('result-area').hidden = false;
  const cancelButton = button('取消查询', '', 'sw-text-button'); cancelButton.onclick = clearResult;
  $('result-area').replaceChildren(loadingView(text), cancelButton);
  scrollToResult();
  try {
    const entry = await send('ANALYZE', { text, mode: selectedMode, context, id });
    if (token !== requestToken) return;
    displayEntry(entry); await loadLibrary();
  } catch (error) {
    if (token !== requestToken) return;
    $('result-area').replaceChildren(backLine('稍作调整，再读一遍', clearResult), errorView(error, () => analyze(text, selectedMode, context)));
  } finally { if (token === requestToken) { activeId = null; $('query-submit').disabled = false; $('query-submit').textContent = '读一读 ↗'; } }
}
$('query-form').onsubmit = event => { event.preventDefault(); if (!activeId) analyze($('query').value, mode); };
$('example').onclick = () => { cancel(); displayEntry(EXAMPLE, true); };

function switchTab(tab) {
  currentTab = tab; stopSpeech();
  $('read-view').hidden = tab !== 'read'; $('saved-view').hidden = tab !== 'saved';
  for (const name of ['read', 'saved']) { $(`${name}-tab`).classList.toggle('is-active', name === tab); $(`${name}-tab`).setAttribute('aria-pressed', String(name === tab)); }
  if (tab === 'saved') { $('saved-detail').hidden = true; $('saved-list').hidden = false; renderSaved(); }
}
$('read-tab').onclick = () => switchTab('read'); $('saved-tab').onclick = () => { switchTab('saved'); loadLibrary().catch(e => { $('library-message').textContent = e.message; }); };

async function loadLibrary() { library = await send('LIBRARY'); $('saved-count').textContent = library.saved.length; renderRecent(); if (currentTab === 'saved') renderSaved(); }
function renderRecent() {
  const root = $('recent'); root.replaceChildren();
  if (!library.recent.length) return;
  const head = el('div', 'sw-between'); head.append(el('span', 'sw-muted sw-small', '最近读过'));
  const clear = button('清空记录', '', 'sw-text-button'); clear.onclick = async () => { try { await send('CLEAR_RECENT'); await loadLibrary(); } catch (e) { showInputError(e); } }; head.append(clear); root.append(head);
  for (const entry of library.recent.slice(0, 4)) {
    const row = button('', '', 'recent-row'); const time = el('time', '', new Date(entry.createdAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }));
    row.append(el('span', '', entry.text), time); row.onclick = () => { cancel(); displayEntry(entry); }; root.append(row);
  }
}
function renderSaved() {
  const root = $('saved-list'); root.replaceChildren(); const query = $('saved-search').value.trim().toLowerCase();
  const entries = library.saved.filter(entry => (entry.text + entry.result.translation).toLowerCase().includes(query));
  $('export').disabled = !library.saved.length;
  if (!entries.length) {
    const empty = el('div', 'empty-state'); empty.append(icon('bookmark', 32), el('h2', '', query ? '还没找到这句' : '让遇见的字，留下来'), el('p', '', query ? '换个字词再找找，或清空搜索查看全部收藏。' : '查询后点击书签图标，把生字、好句和译注收入你的生词笺。'));
    const start = button(query ? '清空搜索' : '去读一段', '', 'sw-button sw-primary'); start.onclick = () => { if (query) { $('saved-search').value = ''; renderSaved(); } else switchTab('read'); }; empty.append(start); root.append(empty); return;
  }
  for (const entry of entries) {
    const card = el('article', 'saved-card'), head = el('div', 'saved-card-head');
    const open = button(entry.text, '', 'saved-open'); open.onclick = () => {
      $('saved-list').hidden = true; $('saved-detail').hidden = false;
      $('saved-detail').replaceChildren(backLine('收藏的译注', () => { stopSpeech(); $('saved-detail').hidden = true; $('saved-list').hidden = false; }), renderResult(entry, resultOptions()));
    };
    const remove = button('', 'trash', 'sw-icon-button'); remove.setAttribute('aria-label', `移除收藏：${entry.text.slice(0, 20)}`); remove.title = '移除收藏';
    remove.onclick = async () => { remove.disabled = true; try { await send('REMOVE_SAVED', { id: entry.id }); await loadLibrary(); $('library-message').textContent = '已移除这条收藏，最近阅读记录不受影响。'; } catch (e) { remove.disabled = false; $('library-message').textContent = e.message; } };
    head.append(open, remove); card.append(head, el('p', '', entry.result.translation)); root.append(card);
  }
}
$('saved-search').oninput = () => { $('saved-detail').hidden = true; $('saved-list').hidden = false; renderSaved(); };
$('export').onclick = () => {
  if (!library.saved.length) return;
  const blob = new Blob([JSON.stringify({ app: '拾文', version: 1, exportedAt: new Date().toISOString(), entries: library.saved }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `拾文-生词笺-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
};
window.addEventListener('pagehide', () => { cancel(); stopSpeech(); });

async function init() {
  try {
    const settings = await send('GET_SETTINGS'); $('setup-banner').hidden = !!settings.apiKey;
    document.body.classList.toggle('sw-large', settings.fontSize === 'large');
    await loadLibrary();
    if (new URLSearchParams(location.search).get('pending') === '1') {
      const pending = await send('PENDING_QUERY');
      if (pending) { $('query').value = pending.text; updateCount(); setMode(pending.mode); analyze(pending.text, pending.mode); }
    }
  } catch (error) { showInputError(error); }
}
init();
