const NS = 'http://www.w3.org/2000/svg';
const paths = {
  arrow: 'M7 17 17 7M7 7h10v10',
  close: 'm6 6 12 12M6 18 18 6',
  book: 'M12 6c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v15',
  sound: 'm11 5-6 4H2v6h3l6 4V5Zm5 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14',
  bookmark: 'M6 3h12v18l-6-4-6 4V3Z',
  check: 'm5 12 4 4L19 6',
  copy: 'M9 9h11v12H9V9Zm6-4V2H3v13h3',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-6v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
  search: 'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM16 16l5 5',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  leaf: 'M20 3C9 2 3 6 4 13s11 10 16-10ZM4 21 15 10',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  back: 'm14 6-6 6 6 6',
  refresh: 'M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3'
};

export function icon(name, size = 18) {
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const path = document.createElementNS(NS, 'path'); path.setAttribute('d', paths[name] || paths.book); svg.append(path); return svg;
}

export function el(tag, className = '', text = '') {
  const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node;
}

export function button(label, name, className = 'sw-button') {
  const node = el('button', className); node.type = 'button';
  if (name) node.append(icon(name)); if (label) node.append(document.createTextNode(label));
  return node;
}

export function iconButton(label, name) {
  const node = button('', name, 'sw-icon-button'); node.setAttribute('aria-label', label); node.title = label; return node;
}

export async function send(type, payload = {}) {
  let response;
  try { response = await chrome.runtime.sendMessage({ type, ...payload }); }
  catch { throw Object.assign(new Error('扩展连接已断开，请刷新网页后重试。'), { code: 'CONNECTION' }); }
  if (!response?.ok) throw Object.assign(new Error(response?.error?.message || '操作未完成，请重试。'), { code: response?.error?.code });
  return response.data;
}

let activeSpeech;
export function stopSpeech() {
  if (!activeSpeech) return;
  if ('speechSynthesis' in globalThis) speechSynthesis.cancel();
  if (activeSpeech) { activeSpeech.button.disabled = false; activeSpeech.button.title = '朗读原文'; }
  activeSpeech = null;
}

export function speak(text, trigger, onError) {
  if (!('speechSynthesis' in globalThis)) { onError('当前环境不支持朗读，请查看拼音。'); return; }
  if (activeSpeech?.button === trigger) { stopSpeech(); return; }
  stopSpeech();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN'; utterance.rate = 0.8;
  const voice = speechSynthesis.getVoices().find(v => /^zh[-_]CN/i.test(v.lang)) || speechSynthesis.getVoices().find(v => v.lang.startsWith('zh'));
  if (voice) utterance.voice = voice;
  activeSpeech = { utterance, button: trigger }; trigger.title = '停止朗读';
  utterance.onend = () => { if (activeSpeech?.utterance === utterance) activeSpeech = null; trigger.title = '朗读原文'; };
  utterance.onerror = event => { if (event.error !== 'interrupted' && event.error !== 'canceled') onError('朗读不可用，请检查系统中文语音。多音字请以读音提示为准。'); if (activeSpeech?.utterance === utterance) activeSpeech = null; };
  speechSynthesis.speak(utterance);
}

export function loadingView(text) {
  const root = el('div', 'sw-loading'); root.setAttribute('role', 'status'); root.setAttribute('aria-live', 'polite');
  const top = el('div', 'sw-loading-caption'); top.append(el('span', 'sw-pulse'), el('span', '', '正在推敲字句…'));
  root.append(top, el('p', 'sw-loading-text', text.length > 80 ? text.slice(0, 80) + '…' : text));
  const skeleton = el('div', 'sw-skeleton'); skeleton.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 4; i++) skeleton.append(el('span'));
  root.append(skeleton, el('p', 'sw-muted sw-small', '正在整理白话、读音与出处线索，最长约 65 秒。')); return root;
}

export function errorView(error, retry) {
  const root = el('div', 'sw-error'); root.setAttribute('role', 'alert');
  root.append(el('span', 'sw-eyebrow', '暂未读成'), el('h3', '', error.message || '查询未完成，请重试。'));
  const controls = el('div', 'sw-inline');
  if (['SETTINGS', 'PERMISSION', 'DISABLED', 'API'].includes(error.code)) {
    const config = button('检查设置', 'settings', 'sw-button sw-primary'); config.onclick = () => send('OPEN_OPTIONS').catch(() => {}); controls.append(config);
  }
  if (retry) { const again = button('重新查询', 'refresh'); again.onclick = retry; controls.append(again); }
  root.append(controls); return root;
}

function section(title, text) {
  const root = el('section', 'sw-result-section'); root.append(el('h3', 'sw-section-heading', title), el('p', 'sw-prose', text)); return root;
}

export function renderResult(entry, { onWord, onSave, onCopy, example = false } = {}) {
  const r = entry.result;
  const root = el('article', 'sw-result');
  const header = el('div', 'sw-result-heading');
  header.append(el('span', 'sw-eyebrow', example ? '内置示例 · 非实时 AI' : '拾文笺注'));
  const tools = el('div', 'sw-inline sw-tools');
  const status = el('p', 'sw-feedback'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const sound = iconButton('朗读原文（现代普通话）', 'sound'); sound.onclick = () => speak(entry.text, sound, message => { status.textContent = message; }); tools.append(sound);
  if (onCopy) { const copy = iconButton('复制译注', 'copy'); copy.onclick = async () => { try { await onCopy(entry); status.textContent = '译注已复制'; } catch { status.textContent = '复制失败，请手动选中译注复制。'; } }; tools.append(copy); }
  if (onSave && !example) {
    const save = iconButton('收藏到生词笺', 'bookmark');
    save.onclick = async () => {
      save.disabled = true;
      try { await onSave(entry); save.replaceChildren(icon('check')); save.title = '已收藏'; save.setAttribute('aria-label', '已收藏到生词笺'); status.textContent = '已收入生词笺'; }
      catch (error) { status.textContent = error.message; save.disabled = false; }
    };
    tools.append(save);
  }
  header.append(tools); root.append(header);
  const original = el('p', 'sw-original', entry.text); root.append(original);
  if (r.pinyin) root.append(el('p', 'sw-pinyin', r.pinyin));
  root.append(status);
  const translation = section(entry.mode === 'explain' ? '字词释义' : '白话译文', r.translation); translation.classList.add('sw-translation'); root.append(translation);
  if (r.lines.length > 1) {
    const lines = el('details', 'sw-details'); lines.append(el('summary', '', '逐句对照'));
    for (const line of r.lines) { const row = el('div', 'sw-line-pair'); row.append(el('p', 'sw-line-original', line.original), el('p', 'sw-prose', line.translation)); lines.append(row); }
    root.append(lines);
  }
  if (r.readingNote) root.append(section('辨音', r.readingNote));
  if (r.words.length) {
    const words = el('section', 'sw-result-section'); const heading = el('div', 'sw-section-row');
    heading.append(el('h3', 'sw-section-heading', '字词小笺'), el('span', 'sw-muted sw-small', onWord ? '点击字词，继续细读' : ''));
    words.append(heading);
    for (const word of r.words) {
      const row = el('div', 'sw-word');
      const wordHead = el('div', 'sw-word-head');
      const label = onWord ? button(word.text, '', 'sw-word-link') : el('strong', '', word.text);
      if (onWord) label.onclick = () => onWord(word.text, entry.text);
      wordHead.append(label, el('span', 'sw-pinyin', word.pinyin));
      row.append(wordHead, el('p', 'sw-prose', word.meaning)); words.append(row);
    }
    root.append(words);
  }
  if (r.origin) root.append(section('字词溯源', r.origin));
  const source = el('section', 'sw-result-section sw-source');
  source.append(el('h3', 'sw-section-heading', '出处线索'));
  source.append(el('p', 'sw-source-title', [r.source.title || '出处待考', r.source.author, r.source.dynasty].filter(Boolean).join(' · ')));
  if (r.source.quote) source.append(el('blockquote', 'sw-source-quote', r.source.quote));
  if (r.source.note) source.append(el('p', 'sw-prose', r.source.note));
  const verify = el('a', 'sw-source-link', '搜索原文核对'); verify.target = '_blank'; verify.rel = 'noopener noreferrer';
  verify.href = 'https://www.baidu.com/s?wd=' + encodeURIComponent([r.source.title, r.source.author, entry.text.slice(0, 60)].filter(Boolean).join(' ')); verify.append(icon('arrow', 14)); source.append(verify); root.append(source);
  if (r.appreciation) root.append(section('赏读', r.appreciation));
  root.append(el('p', 'sw-ai-note', example ? '此为内置展示示例。配置接口后，可查询任意字词与诗文。' : 'AI 译注仅供阅读参考；出处、引文和字源未经联网核验。朗读使用系统普通话语音，多音字请结合辨音提示。'));
  return root;
}
