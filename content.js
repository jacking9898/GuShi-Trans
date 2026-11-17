(() => {
  if (globalThis.__shiwenLoaded) return;
  globalThis.__shiwenLoaded = true;
  let ui, shadow, host, toolbar, dialog, body, modeBar, selectionData, activeId, disposed = false, initialization;
  let settings = { enabled: true, includeContext: false, fontSize: 'normal' };
  let generation = 0, selectionTimer, refreshTimer, opener, panelUnavailable = false;
  let picker;
  let queryKey = '', viewMode = 'translate', currentEntry = null, currentError = null;
  const views = new Map(), scrollPositions = new Map();
  const modeLabels = { translate: '白话翻译', explain: '字词解释', appreciate: '诗文赏析' };

  async function init() {
    if (!initialization) initialization = buildUI();
    return initialization;
  }

  async function buildUI() {
    ui = await import(chrome.runtime.getURL('lib/ui.js'));
    host = document.createElement('shiwen-reader');
    for (const [key, value] of Object.entries({ position: 'fixed', inset: '0', width: '100%', height: '100%', 'pointer-events': 'none', 'z-index': '2147483647', display: 'block', margin: '0', padding: '0', border: '0', transform: 'none', isolation: 'isolate' })) host.style.setProperty(key, value, 'important');
    shadow = host.attachShadow({ mode: 'closed' });
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = chrome.runtime.getURL('styles.css'); shadow.append(css);
    document.documentElement.append(host);
    toolbar = ui.el('div', 'sw sw-selection-toolbar'); toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', '拾文划词工具'); toolbar.hidden = true;
    const brand = ui.el('span', 'sw-toolbar-seal', '拾'); toolbar.append(brand);
    for (const [mode, text] of Object.entries(modeLabels)) {
      const b = ui.button(text, '', 'sw-toolbar-button'); b.onclick = () => showQuery(selectionData, mode); toolbar.append(b);
    }
    toolbar.addEventListener('mousedown', e => e.preventDefault());
    dialog = ui.el('section', 'sw sw-floating-dialog'); dialog.hidden = true;
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-label', '拾文 · 诗文译注'); dialog.tabIndex = -1;
    const top = ui.el('header', 'sw-floating-header');
    const brandText = ui.el('div', 'sw-inline'); brandText.append(ui.el('span', 'sw-seal sw-seal-small', '拾'), ui.el('strong', 'sw-brand-text', '拾文'), ui.el('span', 'sw-muted sw-small', '一字一句，皆有来处'));
    const controls = ui.el('div', 'sw-inline');
    const config = ui.button('设置', 'settings', 'sw-button sw-settings-link'); config.setAttribute('aria-label', '打开拾文设置'); config.title = '打开拾文设置'; config.onclick = () => ui.send('OPEN_OPTIONS').catch(() => {});
    const closeButton = ui.iconButton('关闭译注（Esc）', 'close'); closeButton.onclick = close;
    controls.append(config, closeButton); top.append(brandText, controls); dialog.append(top);
    picker = ui.providerPicker(settings, value => { settings = { ...settings, ...value, thinkingEnabled: value.providers.find(p => p.id === value.activeProviderId)?.thinkingEnabled === true }; }); dialog.append(picker.root);
    modeBar = ui.el('div', 'sw-modebar');
    for (const [mode, label] of Object.entries(modeLabels)) {
      const b = ui.button(label, '', 'sw-mode'); b.dataset.mode = mode; b.onclick = () => showQuery(selectionData, mode); modeBar.append(b);
    }
    body = ui.el('div', 'sw-floating-body'); dialog.append(modeBar, body); shadow.append(toolbar, dialog);
    shadow.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'Tab' && !dialog.hidden) {
        // Keep keyboard navigation inside the open reading panel.
        const focusable = [...dialog.querySelectorAll('button:not(:disabled), select:not(:disabled), a[href], summary')].filter(n => n.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1), current = shadow.activeElement;
        if (e.shiftKey && (current === first || current === dialog)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && current === last) { e.preventDefault(); first?.focus(); }
      }
    });
    applyFont();
  }

  function applyFont() { dialog?.classList.toggle('sw-large', settings.fontSize === 'large'); }

  async function refreshSettings() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'PUBLIC_SETTINGS' });
      if (response?.ok) {
        const changed = settings.revision && settings.revision !== response.data.revision;
        settings = response.data; applyFont(); picker?.update(settings);
        if (changed) { close(); queryKey = ''; currentEntry = null; currentError = null; views.clear(); scrollPositions.clear(); panelUnavailable = false; }
        if (!settings.enabled) { if (toolbar) toolbar.hidden = true; close(); }
      }
    } catch { disposed = true; close(); host?.remove(); }
  }
  refreshSettings();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSettings(); });

  function isEditable(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return !!element?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
  }

  function readSelection() {
    if (disposed || !settings.enabled || !document.hasFocus()) return null;
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || isEditable(selection.anchorNode) || isEditable(selection.focusNode)) return null;
    const text = selection.toString().trim();
    if (!text || [...text].length > 1600 || !/\p{Script=Han}/u.test(text)) return null;
    const range = selection.getRangeAt(0), rect = range.getBoundingClientRect();
    let context = '';
    if (settings.includeContext) {
      const parent = selection.anchorNode?.parentElement;
      // Only local surrounding prose. Do not include embedded editors or hidden fields.
      const block = parent?.closest('p,li,blockquote,pre') || parent;
      const copy = block?.cloneNode(true);
      copy?.querySelectorAll('input,textarea,select,script,style,[contenteditable],[role="textbox"],[hidden],[aria-hidden="true"]').forEach(n => n.remove());
      const raw = copy?.textContent || text;
      const index = raw.indexOf(text);
      context = index < 0 ? text : raw.slice(Math.max(0, index - 300), index + Math.min(text.length, 600) + 300).slice(0, 1200);
    }
    return { text, context, rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } };
  }

  async function updateSelection() {
    const data = readSelection();
    if (!data) { if (toolbar) toolbar.hidden = true; return; }
    await init();
    if (!settings.enabled || disposed) return;
    if (!dialog.hidden) return;
    selectionData = data;
    toolbar.hidden = false;
    const width = toolbar.getBoundingClientRect().width || 320;
    const top = data.rect.bottom + 8;
    toolbar.style.left = `${Math.max(8, Math.min(data.rect.left, innerWidth - width - 8))}px`;
    toolbar.style.top = `${Math.max(8, top + 44 > innerHeight ? data.rect.top - 50 : top)}px`;
  }

  function showResult() {
    if (!views.has(viewMode)) views.set(viewMode, ui.renderResult(currentEntry, {
      mode: viewMode,
      onWord: (text, context) => showQuery({ text, context }, 'explain'),
      onSave: e => ui.send('SAVE_ENTRY', { id: e.id }),
      onCopy: async e => navigator.clipboard.writeText(formatted(e)),
      onRefresh: () => showQuery(selectionData, viewMode, true)
    }));
    body.replaceChildren(views.get(viewMode)); body.scrollTop = scrollPositions.get(viewMode) || 0;
  }

  async function showQuery(data, mode = 'translate', force = false) {
    if (!data?.text || disposed) return;
    await init();
    if (!settings.enabled) return;
    const context = settings.includeContext ? data.context || '' : '';
    if (settings.dockedReading && (innerWidth >= 1024 || settings.sidePanelOpen || host.dataset.layout === 'sidepanel') && !panelUnavailable) {
      toolbar.hidden = true;
      try {
        await ui.send('OPEN_READING_PANEL', { text: data.text, context, mode, force, providerId: settings.activeProviderId });
        close(); settings.sidePanelOpen = true; host.dataset.layout = 'sidepanel'; return;
      } catch { panelUnavailable = true; }
    }
    host.dataset.layout = 'floating';
    const nextKey = JSON.stringify([data.text.trim(), context]);
    const same = nextKey === queryKey;
    if (same && currentEntry) scrollPositions.set(viewMode, body.scrollTop);
    viewMode = mode; ui.stopSpeech();
    selectionData = data; toolbar.hidden = true;
    if (dialog.hidden) opener = document.activeElement;
    const wasHidden = dialog.hidden;
    dialog.hidden = false;
    if (wasHidden) dialog.focus({ preventScroll: true });
    for (const b of modeBar.children) { b.classList.toggle('is-active', b.dataset.mode === mode); b.setAttribute('aria-pressed', String(b.dataset.mode === mode)); }
    if (same && !force) {
      if (currentEntry) { showResult(); return; }
      if (activeId) return; // Switching views never interrupts or duplicates this query.
      if (currentError) { body.replaceChildren(ui.errorView(currentError, () => showQuery(data, viewMode, true))); return; }
    }
    if (activeId) ui.send('CANCEL', { id: activeId }).catch(() => {});
    const token = ++generation;
    const id = crypto.randomUUID(); activeId = id; queryKey = nextKey;
    currentEntry = null; currentError = null; views.clear(); scrollPositions.clear();
    body.replaceChildren(ui.loadingView(data.text, settings.thinkingEnabled)); body.scrollTop = 0;
    const cancel = ui.button('取消查询', '', 'sw-text-button'); cancel.onclick = close; body.append(cancel);
    dialog.focus({ preventScroll: true });
    try {
      const entry = await ui.send('ANALYZE', { id, text: data.text, context, mode, force, providerId: settings.activeProviderId });
      if (token !== generation) return;
      currentEntry = entry; showResult();
    } catch (error) { if (token === generation) { currentError = error; body.replaceChildren(ui.errorView(error, () => showQuery(data, viewMode, true))); } }
    finally { if (activeId === id) activeId = null; }
  }

  function formatted(entry) {
    const r = entry.result;
    return [entry.text, r.notice, r.pinyin, r.translation, ...r.words.map(w => `${w.text}（${w.pinyin}）：${w.meaning}`), r.readingNote, r.origin, [r.source.title, r.source.author, r.source.dynasty, r.source.quote, r.source.note].filter(Boolean).join(' · '), r.appreciation, 'AI 译注，出处与字源待核对。'].filter(Boolean).join('\n\n');
  }

  function close() {
    ++generation;
    if (activeId && ui) ui.send('CANCEL', { id: activeId }).catch(() => {});
    activeId = null;
    if (dialog) dialog.hidden = true;
    if (toolbar) toolbar.hidden = true;
    ui?.stopSpeech();
    if (opener?.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
    opener = null;
  }

  document.addEventListener('mouseup', e => {
    if (e.composedPath().includes(host)) return;
    clearTimeout(selectionTimer); selectionTimer = setTimeout(updateSelection, 30);
  });
  document.addEventListener('keyup', e => {
    if (e.composedPath().includes(host)) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'Shift' || e.key.startsWith('Arrow')) { clearTimeout(selectionTimer); selectionTimer = setTimeout(updateSelection, 60); }
  });
  document.addEventListener('pointerdown', e => {
    if (!e.composedPath().includes(host) && toolbar) toolbar.hidden = true;
  });
  document.addEventListener('scroll', () => { if (toolbar) toolbar.hidden = true; }, { passive: true, capture: true });
  // Local storage is intentionally unavailable in content scripts. Refresh public prefs via worker.
  window.addEventListener('focus', () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshSettings, 80); });
  window.addEventListener('pagehide', close);
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message.type === 'READING_PANEL_CLOSED') { settings.sidePanelOpen = false; if (host) delete host.dataset.layout; return; }
    if (message.type !== 'CONTEXT_QUERY') return;
    if (isEditable(document.activeElement)) { reply({ ok: false }); return; }
    refreshSettings().then(() => showQuery({ text: message.text, context: readSelection()?.context || message.text }, Object.hasOwn(modeLabels, message.mode) ? message.mode : 'translate')).catch(() => {});
    reply({ ok: true });
  });
})();
