import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, readFile, writeFile, copyFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { EXAMPLE } from '../lib/example.js';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('node_modules/.cache/ms-playwright');
const { chromium } = await import('playwright');
const screenshotDir = resolve('test-results'); await mkdir(screenshotDir, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'shiwen-browser-'));
// A headless browser cannot accept Chrome's native optional-host dialog.
// Grant only the mock localhost origin in a temporary test manifest. Runtime files
// stay byte-identical; the shipped manifest remains optional-host-only.
const fixture = await mkdtemp(join(tmpdir(), 'shiwen-fixture-'));
for (const file of ['background.js', 'content.js', 'reader.html', 'reader.js', 'panel.html', 'panel.js', 'options.html', 'options.js', 'styles.css', 'pages.css']) await copyFile(file, join(fixture, file));
for (const dir of ['lib', 'assets']) await cp(dir, join(fixture, dir), { recursive: true });
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
assert(!manifest.host_permissions);
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(join(fixture, 'manifest.json'), JSON.stringify(manifest));
const observedRequests = [];
let catalogMode = 'normal', catalogCalls = [], releaseCatalog;
let apiMode = 'normal', calls = [], releaseSlow, aborted = 0;
const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    catalogCalls.push({ path: req.url, authorization: req.headers.authorization });
    if (catalogMode === 'slow') { await new Promise(resolve => { releaseCatalog = resolve; }); if (res.destroyed) return; }
    if (catalogMode === 'unsupported') { res.writeHead(404); res.end('reflected-test-secret-key'); return; }
    const ids = catalogMode === 'empty' ? [] : req.headers.authorization?.includes('qwen-fake-secret') ? ['qwen-flash', 'qwen-only-model'] : req.headers.authorization?.includes('openai-fake-secret') ? ['gpt-6-luna', 'openai-only-model'] : ['gpt-6-luna', 'gpt-4.1-mini', 'deepseek-flash', 'mock-model', '<img onerror=alert(1)>'];
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: ids.map(id => ({ id })) })); return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw); calls.push(payload); observedRequests.push({ model: payload.model, authorization: req.headers.authorization, path: req.url });
    res.on('close', () => { if (!res.writableEnded) aborted++; });
    if (apiMode === 'parameter-error') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'unsupported_parameter', param: 'max_tokens', message: 'reflected-test-secret-key' } })); return; }
    if (apiMode === 'unauthorized') { res.writeHead(401); res.end('This body must never be shown: test-secret-key'); return; }
    if (apiMode === 'slow') { await new Promise(resolve => { releaseSlow = resolve; }); if (res.destroyed) return; }
    const user = JSON.parse(payload.messages[1].content);
    const result = structuredClone(EXAMPLE.result);
    result.translation = `测试接口译注：${user.text}`;
    if (apiMode === 'reasoning-limit') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"reasoning_content":"private thought must not leak"}}]}\n\ndata: {"choices":[{"finish_reason":"length"}]}\n\n'); return;
    }
    if (apiMode === 'complete-limit') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'length' }] })); return;
    }
    if (apiMode === 'malicious') result.translation = '<img src=x onerror="window.__injected=true">安全文本';
    if (apiMode === 'json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] })); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const text = JSON.stringify(result);
    for (let i = 0; i < text.length; i += 50) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 50) } }] }) + '\n\n');
    res.end('data: [DONE]\n\n'); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'none'; frame-src 'self'" });
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>古籍阅读测试页</title><style>body{margin:0;background:#f2f0e8;color:#253d33;font:19px/2.2 'Songti SC',serif}main{max-width:760px;margin:70px auto;padding:0 30px}small{font:12px sans-serif;letter-spacing:3px;color:#8b8069}h1{font-size:42px;font-weight:500;margin:18px 0}p{max-width:580px}cite{font:13px sans-serif;color:#7a806d}textarea{display:block;margin-top:40px;padding:20px}iframe{width:100%;height:100px;border:1px solid #ddd}</style><main><small>拾文 · 划词阅读试验页</small><h1>终南别业</h1><cite>唐 · 王维</cite><p id="passage">中岁颇好道，晚家南山陲。兴来每独往，胜事空自知。<br><span id="selection">行到水穷处，坐看云起时。</span><br>偶然值林叟，谈笑无还期。</p><p>划选上面的文字，点击「字词解释」，即可打开拾文的阅读浮窗。</p><textarea id="editable" aria-label="测试编辑区">行到水穷处</textarea>${req.url === '/frame' ? '' : '<iframe src="/frame" title="子框架测试"></iframe>'}</main></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let context;
const errors = [];
const log = message => console.log('✓ ' + message);
async function waitForCalls(count) {
  const start = Date.now();
  while (calls.length < count && Date.now() - start < 10000) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls.length, count);
}

try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 1440, height: 1050 },
    args: [`--disable-extensions-except=${fixture}`, `--load-extension=${fixture}`, '--no-first-run'],
    acceptDownloads: true
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => { globalThis.__observedPanelCloses = []; chrome.sidePanel.onClosed.addListener(info => globalThis.__observedPanelCloses.push(info)); });
  const extensionId = new URL(worker.url()).host;
  const extension = `chrome-extension://${extensionId}`;
  async function backgroundPage(url) {
    const opening = context.waitForEvent('page');
    await worker.evaluate(url => chrome.tabs.create({ url, active: false }), url);
    const created = await opening; await created.waitForLoadState(); return created;
  }

  const reader = await context.newPage();
  await reader.goto(`${extension}/reader.html?wide=1`);
  await reader.locator('#setup-banner').waitFor({ state: 'visible' });
  await reader.screenshot({ path: join(screenshotDir, 'reader-desktop.png'), fullPage: true });
  await reader.locator('#example').click();
  await reader.getByText('内置示例 · 非实时 AI', { exact: true }).waitFor();
  await reader.screenshot({ path: join(screenshotDir, 'example-desktop.png'), fullPage: true });
  log('unconfigured install and explicitly labelled built-in example');

  assert.equal(await reader.locator('#settings').innerText(), '设置');
  const openingOptions = context.waitForEvent('page');
  await reader.getByRole('button', { name: '打开设置', exact: true }).click();
  const options = await openingOptions; await options.waitForURL(`${extension}/options.html`);
  await reader.getByRole('button', { name: '配置 AI 服务与 API Key', exact: true }).click();
  log('visible settings button opens the options page; the AI picker also exposes a configuration shortcut');
  await options.locator('#base-url').waitFor();
  await options.waitForFunction(() => document.getElementById('base-url').value !== '');
  assert.equal(await options.locator('#thinking-enabled').isChecked(), false);
  assert.equal(await options.locator('#thinking-enabled').isEnabled(), true);
  assert.equal(await options.locator('#docked-reading').isChecked(), true);
  await options.locator('#thinking-enabled').check();
  await options.locator('#thinking-enabled').uncheck();
  await options.screenshot({ path: join(screenshotDir, 'settings-desktop.png'), fullPage: true });
  await options.locator('.preference').filter({ has: options.locator('#thinking-enabled') }).screenshot({ path: join(screenshotDir, 'thinking-switch.png') });
  await options.locator('#provider').selectOption('custom');
  await options.locator('#base-url').fill(`${base}/v1`); await options.locator('#model').fill('mock-model'); await options.locator('#api-key').fill('test-secret-key');
  await options.locator('#docked-reading').uncheck();
  await options.locator('#save').click();
  await options.waitForFunction(() => /设置已保存|尚未授权/.test(document.getElementById('settings-message').textContent), null, { timeout: 10000 });
  assert.match(await options.locator('#settings-message').textContent(), /设置已保存/);
  log('settings save using Chrome permissions API with pre-granted test localhost origin');
  await options.waitForFunction(() => document.getElementById('models-status').textContent.includes('已获取'));
  assert.equal(await options.locator('#model').inputValue(), 'mock-model');
  assert.equal(await options.locator('#dirty').textContent(), '');
  assert.equal(await options.locator('#available-models option').count(), 4);
  const modelDiscoveryPosts = calls.length;
  await options.locator('#model-search').fill('gpt-6');
  assert.equal(await options.locator('#available-models option').count(), 1);
  assert.equal(await options.locator('#dirty').textContent(), '');
  await options.locator('#available-models').selectOption('gpt-6-luna');
  assert.equal(await options.locator('#model').inputValue(), 'gpt-6-luna');
  assert.match(await options.locator('#dirty').textContent(), /未保存/);
  assert.equal(calls.length, modelDiscoveryPosts);
  await options.locator('#model').fill('mock-model'); await options.locator('#save').click();
  await options.waitForFunction(() => document.getElementById('settings-message').textContent.includes('设置已保存'));
  await options.waitForFunction(() => document.getElementById('models-status').textContent.includes('已获取'));
  catalogMode = 'unsupported'; await options.locator('#fetch-models').click();
  await options.waitForFunction(() => document.getElementById('models-status').textContent.includes('未提供模型列表'));
  assert(!(await options.locator('#models-status').textContent()).includes('reflected-test-secret-key'));
  assert.equal(await options.locator('#model').inputValue(), 'mock-model');
  catalogMode = 'empty'; await options.locator('#fetch-models').click();
  await options.waitForFunction(() => document.getElementById('models-status').textContent.includes('未返回可用模型'));
  catalogMode = 'normal'; await options.locator('#fetch-models').click();
  await options.waitForFunction(() => document.getElementById('models-status').textContent.includes('已获取'));
  await options.screenshot({ path: join(screenshotDir, 'model-discovery.png'), fullPage: true });
  await options.locator('.model-field').screenshot({ path: join(screenshotDir, 'model-picker.png') });
  log('model discovery loads automatically, supports search and selection, preserves manual input and handles empty or unsupported catalogs without generation calls');

  const connectionCalls = calls.length;
  for (let i = 1; i <= 2; i++) {
    await options.locator('#test-connection').click();
    await waitForCalls(connectionCalls + i);
    await options.waitForFunction(() => document.getElementById('test-result').textContent.startsWith('连接成功'));
  }
  log('connection tests always reach the provider, even with cached analysis results');
  apiMode = 'parameter-error'; const parameterCalls = calls.length;
  await options.locator('#test-connection').click();
  await options.waitForFunction(() => document.getElementById('test-result').textContent.includes('max_completion_tokens'));
  assert.equal(calls.length, parameterCalls + 1);
  assert(!(await options.locator('#test-result').textContent()).includes('reflected-test-secret-key'));
  apiMode = 'normal';
  log('HTTP 400 shows the rejected parameter safely and never silently retries the paid request');


  await reader.reload();
  apiMode = 'slow'; const manualCalls = calls.length, manualAborts = aborted;
  await reader.locator('#query').fill('蒹葭苍苍，白露为霜。'); await reader.locator('#query-submit').click();
  await waitForCalls(manualCalls + 1);
  for (const mode of ['explain', 'translate', 'appreciate']) await reader.locator(`#query-form [data-mode="${mode}"]`).click();
  assert.equal(calls.length, manualCalls + 1); assert.equal(aborted, manualAborts);
  await reader.locator('.sw-loading').waitFor(); releaseSlow(); apiMode = 'normal';
  await reader.locator('#result-area').getByText('测试接口译注：蒹葭苍苍，白露为霜。', { exact: true }).waitFor();
  assert.equal(await reader.locator('#result-area .sw-result [data-section]').first().getAttribute('data-section'), 'appreciate');
  for (const mode of ['explain', 'translate', 'appreciate', 'translate']) await reader.locator(`#query-form [data-mode="${mode}"]`).click();
  assert.equal(calls.length, manualCalls + 1); assert.equal(aborted, manualAborts);
  log('reader mode switches during and after generation use one uninterrupted HTTP request');
  await reader.getByRole('button', { name: '收藏到生词笺', exact: true }).click();
  await reader.waitForFunction(() => document.getElementById('saved-count').textContent === '1');
  await reader.locator('#saved-tab').click(); await reader.getByRole('button', { name: '蒹葭苍苍，白露为霜。', exact: true }).waitFor();
  await reader.locator('#saved-search').fill('找不到的字词'); await reader.getByText('还没找到这句', { exact: true }).waitFor();
  await reader.locator('#saved-search').fill('');
  const downloadEvent = reader.waitForEvent('download'); await reader.locator('#export').click(); const download = await downloadEvent;
  const exported = await readFile(await download.path(), 'utf8'); assert(!exported.includes('test-secret-key')); assert.equal(JSON.parse(exported).entries.length, 1);
  log('real streaming API query, save, search and credential-free export');
  await reader.getByRole('button', { name: '蒹葭苍苍，白露为霜。', exact: true }).click();
  const refreshedSavedCalls = calls.length;
  await reader.getByRole('button', { name: '重新生成译注（会重新请求 AI）', exact: true }).click();
  await reader.locator('#read-view').waitFor({ state: 'visible' });
  await reader.locator('#result-area').getByText('测试接口译注：蒹葭苍苍，白露为霜。', { exact: true }).waitFor();
  assert.equal(calls.length, refreshedSavedCalls + 1);
  assert.equal(await reader.locator('#query').inputValue(), '蒹葭苍苍，白露为霜。');
  log('explicit regeneration from a saved reading opens the correct query in the reader');

  // Query errors and retry recover without exposing raw provider bodies.
  await reader.locator('#read-tab').click(); apiMode = 'unauthorized'; await reader.locator('#query').fill('穷'); await reader.locator('#query-submit').click();
  await reader.getByText('API Key 无效或已过期，请到设置中检查。', { exact: true }).waitFor();
  assert(!(await reader.locator('body').textContent()).includes('test-secret-key'));
  apiMode = 'json'; await reader.getByRole('button', { name: '重新查询' }).click(); await reader.getByText('测试接口译注：穷', { exact: true }).waitFor();
  log('HTTP 401 safe error and retry with non-streaming provider');

  apiMode = 'malicious'; await reader.locator('#query').fill('测试'); await reader.locator('#query-submit').click();
  await reader.getByText('<img src=x onerror="window.__injected=true">安全文本', { exact: true }).waitFor();
  assert.equal(await reader.locator('#result-area img').count(), 0); assert.equal(await reader.evaluate(() => window.__injected), undefined);
  log('untrusted AI HTML rendered as literal text');

  apiMode = 'slow'; await reader.locator('#query').fill('取消'); await reader.locator('#query-submit').click();
  await reader.getByRole('button', { name: '取消查询', exact: true }).click();
  await reader.locator('#welcome').waitFor({ state: 'visible' }); releaseSlow?.(); apiMode = 'normal';
  await reader.locator('#query').fill('新查询'); await reader.locator('#query-submit').click();
  await reader.getByText('测试接口译注：新查询', { exact: true }).waitFor();
  log('cancel and subsequent query without stale result overwrite');

  const page = await context.newPage(); const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.goto(`${base}/reading`);
  await page.waitForFunction(() => document.readyState === 'complete');
  const select = async () => {
    await page.evaluate(() => {
      const range = document.createRange(); range.selectNodeContents(document.getElementById('selection'));
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
  };
  const findNode = (node, name) => {
    if (node.nodeName === name) return node;
    for (const child of [...(node.children || []), ...(node.shadowRoots || []), ...(node.contentDocument ? [node.contentDocument] : [])]) { const found = findNode(child, name); if (found) return found; }
  };
  async function shadow(fn, args = []) {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const host = findNode(root, 'SHIWEN-READER');
    if (!host?.shadowRoots?.[0]) return null;
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: host.shadowRoots[0].backendNodeId });
    const result = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `function(...args) { return (${fn.toString()})(this, ...args); }`, arguments: args.map(value => ({ value })), returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  async function waitShadow(fn, description) {
    const start = Date.now();
    while (Date.now() - start < 10000) { if (await shadow(fn)) return; await new Promise(resolve => setTimeout(resolve, 80)); }
    throw new Error(`Timed out: ${description}`);
  }
  await select(); await waitShadow(root => root.querySelector('.sw-selection-toolbar')?.hidden === false, 'selection toolbar');
  assert.equal(await page.evaluate(() => document.querySelector('shiwen-reader').shadowRoot), null);
  assert.equal(await shadow(root => root.querySelector('.sw-floating-dialog').getBoundingClientRect().height), 0);
  apiMode = 'slow'; const floatingCalls = calls.length, floatingAborts = aborted;
  await shadow(root => [...root.querySelectorAll('.sw-toolbar-button')].find(b => b.textContent === '字词解释').click());
  await waitForCalls(floatingCalls + 1);
  await shadow(root => { for (const mode of ['translate', 'explain', 'translate', 'appreciate']) root.querySelector(`.sw-mode[data-mode="${mode}"]`).click(); });
  assert.equal(calls.length, floatingCalls + 1); assert.equal(aborted, floatingAborts);
  assert.equal(await shadow(root => !!root.querySelector('.sw-loading')), true);
  releaseSlow(); apiMode = 'normal';
  await waitShadow(root => !!root.querySelector('.sw-result'), 'AI result in floating card');
  assert.equal(await shadow(root => root.querySelector('.sw-result [data-section]').dataset.section), 'appreciate');
  await shadow(root => { for (const mode of ['explain', 'translate', 'appreciate', 'translate']) root.querySelector(`.sw-mode[data-mode="${mode}"]`).click(); });
  await waitShadow(root => root.querySelector('.sw-result [data-section]')?.dataset.section === 'translate', 'local translation view');
  assert.equal(calls.length, floatingCalls + 1); assert.equal(aborted, floatingAborts);
  await shadow(root => { root.querySelector('.sw-floating-body').scrollTop = 180; root.querySelector('.sw-mode[data-mode="explain"]').click(); });
  await waitShadow(root => root.querySelector('.sw-result [data-section]')?.dataset.section === 'reading', 'local explanation view');
  await shadow(root => root.querySelector('.sw-mode[data-mode="translate"]').click());
  await waitShadow(root => root.querySelector('.sw-floating-body').scrollTop === 180, 'restored tab scroll position');
  log('floating mode switches preserve one in-flight request, local results and each view scroll position');
  const lastUser = JSON.parse(calls.at(-1).messages[1].content);
  assert.equal(lastUser.text, '行到水穷处，坐看云起时。'); assert.equal(lastUser.context, '未提供，请保留歧义。');
  assert.equal(await shadow(root => getComputedStyle(root.querySelector('.sw-floating-dialog')).display), 'flex');
  await page.screenshot({ path: join(screenshotDir, 'selection-floating.png'), fullPage: true });
  log('real selection and isolated closed Shadow DOM floating result on a strict-CSP page');

  await shadow(root => root.querySelector('.sw-word-link').click());
  await waitShadow(root => !!root.querySelector('.sw-result') && root.querySelector('.sw-original').textContent === '穷', 'word drilldown');
  await shadow(root => root.querySelector('[aria-label="关闭译注（Esc）"]').click());
  assert.equal(await shadow(root => root.querySelector('.sw-floating-dialog').getBoundingClientRect().height), 0);
  await page.locator('#editable').focus(); await page.locator('#editable').selectText();
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await shadow(root => root.querySelector('.sw-selection-toolbar').hidden), true);
  log('word drilldown, close behavior and editable-field exclusion');

  // A fresh content script still reuses the successful result from session storage.
  const cachedCalls = calls.length;
  await page.reload(); await select();
  await waitShadow(root => root.querySelector('.sw-selection-toolbar')?.hidden === false, 'toolbar after reload');
  await shadow(root => [...root.querySelectorAll('.sw-toolbar-button')].find(b => b.textContent === '白话翻译').click());
  await waitShadow(root => !!root.querySelector('.sw-result'), 'session-cached result');
  assert.equal(calls.length, cachedCalls);
  await shadow(root => root.querySelector('[aria-label="重新生成译注（会重新请求 AI）"]').click());
  await waitForCalls(cachedCalls + 1); await waitShadow(root => !!root.querySelector('.sw-result'), 'explicit fresh generation');
  assert.equal(calls.length, cachedCalls + 1);
  log('page reload reuses cached results; only explicit regeneration creates another API call');

  await options.locator('#docked-reading').check(); await options.locator('#save').click();
  await options.waitForFunction(() => document.getElementById('settings-message').textContent.includes('设置已保存'));
  await page.reload();
  const panelText = '玲珑骰子安红豆，入骨相思知不知。';
  await page.locator('#selection').evaluate((node, text) => { node.textContent = text; }, panelText);
  await select(); await waitShadow(root => root.querySelector('.sw-selection-toolbar')?.hidden === false, 'native side-panel toolbar');
  const nativeCalls = calls.length;
  apiMode = 'slow';
  await shadow(root => [...root.querySelectorAll('.sw-toolbar-button')].find(b => b.textContent === '字词解释').click());
  await page.waitForFunction(() => document.querySelector('shiwen-reader')?.dataset.layout === 'sidepanel');
  assert.equal(await shadow(root => root.querySelector('.sw-floating-dialog').hidden), true);
  await waitForCalls(nativeCalls + 1);
  releaseSlow(); apiMode = 'normal';
  const nativeStart = Date.now(); let nativeFinished = false;
  while (!nativeFinished && Date.now() - nativeStart < 10000) {
    nativeFinished = await worker.evaluate(async text => {
      const { recent = [] } = await chrome.storage.local.get('recent'); return recent.some(e => e.text === text);
    }, panelText);
    if (!nativeFinished) await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert(nativeFinished, 'native side-panel renderer must complete its real initial analysis');
  // The native side-panel WebContents is not exposed as a Playwright page in
  // headless Chrome. Inspect the same renderer in a test tab after that request,
  // then explicitly regenerate once to test mode changes during slow generation.
  const panelRenderer = await backgroundPage(`${extension}/panel.html`); await panelRenderer.setViewportSize({ width: 440, height: 1000 });
  await panelRenderer.getByText(`测试接口译注：${panelText}`, { exact: true }).waitFor();
  assert.equal(calls.length, nativeCalls + 1);
  const nativeAborts = aborted; apiMode = 'slow';
  await panelRenderer.getByRole('button', { name: '重新生成译注（会重新请求 AI）', exact: true }).click();
  await waitForCalls(nativeCalls + 2);
  for (const mode of ['translate', 'explain', 'appreciate']) await panelRenderer.locator(`#panel-modes [data-mode="${mode}"]`).click();
  assert.equal(calls.length, nativeCalls + 2); assert.equal(aborted, nativeAborts);
  releaseSlow(); apiMode = 'normal';
  await panelRenderer.getByText(`测试接口译注：${panelText}`, { exact: true }).waitFor();
  assert.equal(await panelRenderer.locator('#panel-body [data-section]').first().getAttribute('data-section'), 'appreciate');
  assert.match(await panelRenderer.locator('#panel-thinking').textContent(), /思考已关/);
  for (const mode of ['translate', 'explain', 'appreciate']) await panelRenderer.locator(`#panel-modes [data-mode="${mode}"]`).click();
  assert.equal(calls.length, nativeCalls + 2);
  await panelRenderer.screenshot({ path: join(screenshotDir, 'reading-sidepanel.png'), fullPage: true });
  await page.setViewportSize({ width: 800, height: 1000 }); await select();
  await waitShadow(root => root.querySelector('.sw-selection-toolbar')?.hidden === false, 'toolbar with narrowed article viewport');
  await shadow(root => [...root.querySelectorAll('.sw-toolbar-button')].find(b => b.textContent === '字词解释').click());
  await page.waitForFunction(() => document.querySelector('shiwen-reader')?.dataset.layout === 'sidepanel');
  assert.equal(await shadow(root => root.querySelector('.sw-floating-dialog').hidden), true);
  assert.equal(calls.length, nativeCalls + 2);
  const nativeWindowId = await panelRenderer.evaluate(async () => (await chrome.windows.getCurrent()).id);
  await worker.evaluate(id => chrome.sidePanel.close({ windowId: id }), nativeWindowId);
  await page.waitForFunction(() => !document.querySelector('shiwen-reader')?.dataset.layout);
  await select(); await waitShadow(root => root.querySelector('.sw-selection-toolbar')?.hidden === false, 'narrow-screen toolbar after closing side panel');
  await shadow(root => [...root.querySelectorAll('.sw-toolbar-button')].find(b => b.textContent === '字词解释').click());
  await waitShadow(root => !!root.querySelector('.sw-result') && !root.querySelector('.sw-floating-dialog').hidden, 'narrow-screen floating fallback');
  assert.equal(calls.length, nativeCalls + 2);
  // Real Chrome tab activation and navigation must retire the global panel.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shadow(root => root.querySelector('[aria-label="关闭译注（Esc）"]').click());
  await select(); await waitShadow(root => root.querySelector('.sw-selection-toolbar')?.hidden === false, 'lifecycle toolbar');
  await shadow(root => root.querySelector('.sw-toolbar-button').click());
  await page.waitForFunction(() => document.querySelector('shiwen-reader')?.dataset.layout === 'sidepanel');
  await panelRenderer.locator('.sw-result').waitFor();
  const sourceTabId = await worker.evaluate(async windowId => (await chrome.storage.session.get(`readingPanel:${windowId}`))[`readingPanel:${windowId}`].tabId, nativeWindowId);
  const lifecycleCalls = calls.length;
  const closesBeforeSwitch = await worker.evaluate(() => globalThis.__observedPanelCloses.length);
  const otherTab = await worker.evaluate(async url => chrome.tabs.create({ url, active: true }), `${base}/other-tab`);
  await panelRenderer.waitForFunction(async windowId => !(await chrome.storage.session.get(`readingPanel:${windowId}`))[`readingPanel:${windowId}`], nativeWindowId);
  await panelRenderer.locator('.sw-result').waitFor({ state: 'hidden' });
  const nativeCloseStart = Date.now();
  while (await worker.evaluate(() => globalThis.__observedPanelCloses.length) <= closesBeforeSwitch && Date.now() - nativeCloseStart < 10000) await new Promise(resolve => setTimeout(resolve, 25));
  assert(await worker.evaluate(() => globalThis.__observedPanelCloses.length) > closesBeforeSwitch, 'Chrome must confirm that its native panel closed on tab switch');
  assert.equal(calls.length, lifecycleCalls);
  await worker.evaluate(async id => chrome.tabs.update(id, { active: true }), sourceTabId);
  await worker.evaluate(async id => chrome.tabs.remove(id), otherTab.id);
  assert.equal(await panelRenderer.locator('.sw-result').count(), 0);
  await select(); await waitShadow(root => root.querySelector('.sw-selection-toolbar')?.hidden === false, 'return-to-source toolbar');
  await shadow(root => root.querySelector('.sw-toolbar-button').click());
  await panelRenderer.locator('.sw-result').waitFor();
  assert.equal(calls.length, lifecycleCalls);
  await page.goto(`${base}/new-article`);
  await panelRenderer.waitForFunction(async windowId => !(await chrome.storage.session.get(`readingPanel:${windowId}`))[`readingPanel:${windowId}`], nativeWindowId);
  await panelRenderer.locator('.sw-result').waitFor({ state: 'hidden' });
  assert.equal(calls.length, lifecycleCalls);

  await panelRenderer.close(); // Only the real native renderer observes the next uncached query.
  apiMode = 'slow'; const beforeNavigationAbort = aborted;
  const leavingText = '离开当前网页时取消这条译注';
  await page.locator('#selection').evaluate((node, text) => { node.textContent = text; }, leavingText);
  await select(); await waitShadow(root => root.querySelector('.sw-selection-toolbar')?.hidden === false, 'pending-navigation toolbar');
  await shadow(root => root.querySelector('.sw-toolbar-button').click());
  await waitForCalls(lifecycleCalls + 1);
  await page.goto(`${base}/after-navigation`);
  const abortStart = Date.now();
  while (aborted === beforeNavigationAbort && Date.now() - abortStart < 10000) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(aborted, beforeNavigationAbort + 1);
  releaseSlow(); apiMode = 'normal';
  assert.equal(await worker.evaluate(async text => {
    const { analysisCache = [] } = await chrome.storage.session.get('analysisCache'); return analysisCache.some(x => x.entry.text === text);
  }, leavingText), false);
  await page.setViewportSize({ width: 800, height: 1000 });
  log('native side panel reuses mode requests; real tab switches and same-tab navigation clear old readings, close the panel and cancel in-flight work');

  await reader.goto(`${extension}/reader.html?wide=1`);
  apiMode = 'reasoning-limit'; const exhaustedCalls = calls.length;
  await reader.locator('#query').fill('红豆'); await reader.locator('#query-submit').click();
  await reader.getByText('深度思考已用完本次输出额度，尚未返回译注。请在设置中关闭深度思考后重试。', { exact: true }).waitFor();
  assert(!(await reader.locator('body').textContent()).includes('private thought must not leak'));
  assert.equal(calls.length, exhaustedCalls + 1);
  apiMode = 'complete-limit'; await reader.getByRole('button', { name: '重新查询', exact: true }).click();
  await reader.locator('#result-area .sw-notice').waitFor();
  await reader.getByText('测试接口译注：红豆', { exact: true }).waitFor();
  assert.match(await reader.locator('.sw-notice').textContent(), /可能不完整/);
  assert.equal(calls.length, exhaustedCalls + 2); apiMode = 'normal';
  log('output-limit errors explain reasoning exhaustion; complete JSON remains visible with a qualification and no automatic paid retry');

  // Build independent profiles through the actual options UI. Paid services are
  // replaced with localhost only after their official preset values are checked.
  const profiles = [];
  for (const [kind, name, model] of [['openai', 'OpenAI 试读', 'openai-test-model'], ['qwen', '千问 试读', 'qwen-test-model']]) {
    await options.locator('#new-provider-kind').selectOption(kind); await options.locator('#add-provider').click();
    assert.equal(await options.locator('#api-key').inputValue(), '');
    assert.equal(await options.locator('#thinking-enabled').isChecked(), false);
    assert.match(await options.locator('#base-url').inputValue(), kind === 'openai' ? /api\.openai\.com/ : /dashscope\.aliyuncs\.com/);
    assert.equal(await options.locator('#thinking-enabled').isEnabled(), kind === 'qwen');
    await options.locator('#profile-name').fill(name); await options.locator('#base-url').fill(`${base}/v1`);
    await options.locator('#model').fill(model); await options.locator('#api-key').fill(`${kind}-fake-secret`);
    await options.locator('#save').click();
    await options.waitForFunction(() => document.getElementById('settings-message').textContent.includes('设置已保存'));
    profiles.push({ id: await options.locator('.provider-card.is-active').getAttribute('data-provider-id'), name, model, key: `${kind}-fake-secret` });
  }
  await options.reload(); await options.locator('#provider-list .provider-card').nth(2).waitFor();
  assert.equal(await options.locator('#provider-list .provider-card').count(), 3);
  await options.locator('#provider-list .provider-card').first().click();
  assert.equal(await options.locator('#api-key').inputValue(), 'test-secret-key');
  for (const p of profiles) {
    await options.locator(`[data-provider-id="${p.id}"]`).click();
    assert.equal(await options.locator('#api-key').inputValue(), p.key);
    assert.equal(await options.locator('#model').inputValue(), p.model);
  }
  await options.waitForFunction(() => document.getElementById('models-status').textContent.includes('已获取'));
  assert.equal(await options.locator('#available-models option').first().textContent(), 'qwen-flash');
  const qwenCatalogCalls = catalogCalls.length;
  await options.locator(`[data-provider-id="${profiles[0].id}"]`).click();
  await options.waitForFunction(() => document.getElementById('models-status').textContent.includes('已获取'));
  assert(await options.locator('#available-models option[value="openai-only-model"]').count());
  assert.equal(await options.locator('#available-models option[value="qwen-only-model"]').count(), 0);
  if (catalogCalls.length > qwenCatalogCalls) assert.equal(catalogCalls.at(-1).authorization, 'Bearer openai-fake-secret');
  const beforeReturnToQwen = catalogCalls.length;
  await options.locator(`[data-provider-id="${profiles[1].id}"]`).click();
  await options.waitForFunction(() => document.getElementById('models-status').textContent.includes('已获取'));
  assert.equal(catalogCalls.length, beforeReturnToQwen, 'switching back reuses a per-key catalog cache');
  catalogMode = 'slow'; await options.locator('#fetch-models').click();
  await options.waitForFunction(() => document.getElementById('fetch-models').textContent.includes('获取中'));
  // Wait for the server to own the pending request before switching profiles.
  while (!releaseCatalog) await new Promise(resolve => setTimeout(resolve, 10));
  await options.locator(`[data-provider-id="${profiles[0].id}"]`).click(); releaseCatalog(); catalogMode = 'normal';
  await options.waitForFunction(() => document.getElementById('models-status').textContent.includes('已获取'));
  assert(await options.locator('#available-models option[value="openai-only-model"]').count());
  assert.equal(await options.locator('#available-models option[value="qwen-only-model"]').count(), 0);
  log('model catalogs isolate provider keys and cache entries; late responses cannot overwrite another provider');
  await options.screenshot({ path: join(screenshotDir, 'multiple-providers.png'), fullPage: true });
  log('DeepSeek, OpenAI and Qwen preset profiles save independently and survive reload');

  await reader.reload();
  const originalProviderId = await reader.locator('.sw-provider-select').inputValue();
  const switchingCalls = calls.length;
  await reader.locator('.sw-provider-select').selectOption(profiles[0].id);
  await reader.getByText(/下次查询使用 OpenAI 试读/).waitFor();
  assert.equal(calls.length, switchingCalls);
  await reader.locator('#query').fill('多模型试读'); await reader.locator('#query-submit').click();
  await reader.locator('#result-area .sw-provider-source').waitFor();
  assert.match(await reader.locator('#result-area .sw-provider-source').textContent(), /OpenAI 试读/);
  assert.deepEqual(observedRequests.at(-1), { model: profiles[0].model, authorization: `Bearer ${profiles[0].key}`, path: '/v1/chat/completions' });
  const afterOpenai = calls.length;
  await reader.locator('.sw-provider-select').selectOption(profiles[1].id);
  await reader.getByText(/下次查询使用 千问 试读/).waitFor();
  assert.equal(calls.length, afterOpenai);
  assert.match(await reader.locator('#result-area .sw-provider-source').textContent(), /OpenAI 试读/);
  await reader.getByRole('button', { name: '重新生成译注（会重新请求 AI）', exact: true }).click();
  await reader.locator('#result-area .sw-provider-source').filter({ hasText: '千问 试读' }).waitFor();
  assert.equal(calls.length, afterOpenai + 1);
  assert.deepEqual(observedRequests.at(-1), { model: profiles[1].model, authorization: `Bearer ${profiles[1].key}`, path: '/v1/chat/completions' });

  // A provider switch during generation leaves the old request running and keeps
  // its captured provenance. No automatic request is made with the new key.
  apiMode = 'slow'; const providerInFlightCalls = calls.length, providerInFlightAborts = aborted;
  await reader.locator('#query').fill('切换服务时继续读'); await reader.locator('#query-submit').click();
  await waitForCalls(providerInFlightCalls + 1);
  await reader.locator('.sw-provider-select').selectOption(profiles[0].id);
  await reader.getByText(/下次查询使用 OpenAI 试读/).waitFor();
  assert.equal(calls.length, providerInFlightCalls + 1); assert.equal(aborted, providerInFlightAborts);
  releaseSlow(); apiMode = 'normal';
  await reader.locator('#result-area .sw-provider-source').filter({ hasText: '千问 试读' }).waitFor();
  assert.equal(calls.length, providerInFlightCalls + 1);
  log('provider switches neither generate nor cancel requests; explicit regeneration uses the selected key and labels the result source');

  await page.reload(); await select();
  await waitShadow(root => root.querySelector('.sw-selection-toolbar')?.hidden === false, 'multi-provider floating toolbar');
  await shadow(root => root.querySelector('.sw-toolbar-button').click());
  await waitShadow(root => !!root.querySelector('.sw-result'), 'multi-provider floating result');
  const floatingProviderCalls = calls.length;
  await shadow((root, id) => { const select = root.querySelector('.sw-provider-select'); select.value = id; select.dispatchEvent(new Event('change')); }, [profiles[1].id]);
  await waitShadow(root => root.querySelector('.sw-provider-note').textContent.includes('千问 试读'), 'floating provider selection note');
  assert.equal(calls.length, floatingProviderCalls);
  await shadow(root => root.querySelector('[aria-label="重新生成译注（会重新请求 AI）"]').click());
  await waitShadow(root => root.querySelector('.sw-provider-source')?.textContent.includes('千问 试读'), 'floating regenerated provider provenance');
  assert.equal(calls.length, floatingProviderCalls + 1);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await shadow(root => root.querySelector('[aria-label="关闭译注（Esc）"]').click());
  await select(); await waitShadow(root => root.querySelector('.sw-selection-toolbar')?.hidden === false, 'provider-panel toolbar');
  await shadow(root => root.querySelector('.sw-toolbar-button').click());
  await page.waitForFunction(() => document.querySelector('shiwen-reader')?.dataset.layout === 'sidepanel');
  const providerPanel = await backgroundPage(`${extension}/panel.html`);
  await providerPanel.locator('.sw-provider-select').waitFor();
  // The stored initial panel query may need one lookup; wait for its result.
  await providerPanel.locator('.sw-result').waitFor();
  const panelProviderCalls = calls.length;
  await providerPanel.locator('.sw-provider-select').selectOption(profiles[0].id);
  await providerPanel.getByText(/下次查询使用 OpenAI 试读/).waitFor();
  assert.equal(calls.length, panelProviderCalls);
  await providerPanel.getByRole('button', { name: '重新生成译注（会重新请求 AI）', exact: true }).click();
  await providerPanel.locator('.sw-provider-source').filter({ hasText: 'OpenAI 试读' }).waitFor();
  assert.equal(calls.length, panelProviderCalls + 1);
  await providerPanel.close();
  log('floating card and native-panel page both support explicit provider selection without paid queries on selection');

  // Remove just one key, preserving the remaining providers and their credentials.
  await options.locator(`[data-provider-id="${profiles[0].id}"]`).click(); await options.locator('#delete-key').click();
  await options.getByText(/当前配置的本机 API Key 已删除/).waitFor();
  assert.equal(await options.locator('#api-key').inputValue(), '');
  await options.locator(`[data-provider-id="${profiles[1].id}"]`).click();
  assert.equal(await options.locator('#api-key').inputValue(), profiles[1].key);
  await reader.locator('.sw-provider-select').selectOption(originalProviderId);

  await reader.setViewportSize({ width: 440, height: 760 }); await reader.goto(`${extension}/reader.html`);
  await reader.locator('#example').click();
  await reader.screenshot({ path: join(screenshotDir, 'reader-popup.png'), fullPage: true });
  for (const width of [320, 768, 1024, 1440]) {
    await reader.setViewportSize({ width, height: 900 }); await reader.goto(`${extension}/reader.html?wide=1`);
    assert(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `reader horizontal overflow at ${width}px`);
    await options.setViewportSize({ width, height: 900 });
    assert(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `options horizontal overflow at ${width}px`);
  }
  log('responsive reader and settings at 320, 768, 1024 and 1440 px');
  const emptyCalls = calls.length;
  // Removing the final configuration leaves an actionable empty state. Keyless
  // drafts can then be added without breaking native form validation.
  for (let i = 0; i < 3; i++) await options.locator('#remove-provider').click();
  await options.locator('#provider-empty').waitFor({ state: 'visible' });
  await options.locator('#save').click();
  await options.waitForFunction(() => document.getElementById('settings-message').textContent.includes('设置已保存'));
  await options.reload(); await options.locator('#provider-empty').waitFor({ state: 'visible' });
  await reader.reload(); await reader.locator('#setup-banner').waitFor({ state: 'visible' });
  assert.equal(await reader.locator('.sw-provider-select').isDisabled(), true);
  await options.locator('#new-provider-kind').selectOption('openai'); await options.locator('#add-provider').click();
  await options.locator('#save').click();
  await options.waitForFunction(() => document.getElementById('settings-message').textContent.includes('设置已保存'));
  await options.reload(); await options.locator('.provider-card').waitFor();
  assert.equal(await options.locator('#api-key').inputValue(), '');
  assert.equal(calls.length, emptyCalls);
  log('empty configuration list and keyless drafts remain editable and do not trigger requests');
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  console.log(`\nBrowser integration checks passed. Screenshots: ${screenshotDir}`);
} finally {
  releaseSlow?.(); releaseCatalog?.(); if (context) await context.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true }); await rm(fixture, { recursive: true, force: true });
}
