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
for (const file of ['background.js', 'content.js', 'reader.html', 'reader.js', 'options.html', 'options.js', 'styles.css', 'pages.css']) await copyFile(file, join(fixture, file));
for (const dir of ['lib', 'assets']) await cp(dir, join(fixture, dir), { recursive: true });
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
assert(!manifest.host_permissions);
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(join(fixture, 'manifest.json'), JSON.stringify(manifest));
let apiMode = 'normal', calls = [], releaseSlow;
const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw); calls.push(payload);
    if (apiMode === 'unauthorized') { res.writeHead(401); res.end('This body must never be shown: test-secret-key'); return; }
    if (apiMode === 'slow') { await new Promise(resolve => { releaseSlow = resolve; }); if (res.destroyed) return; }
    const user = JSON.parse(payload.messages[1].content);
    const result = structuredClone(EXAMPLE.result);
    result.translation = `测试接口译注：${user.text}`;
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

try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 1440, height: 1050 },
    args: [`--disable-extensions-except=${fixture}`, `--load-extension=${fixture}`, '--no-first-run'],
    acceptDownloads: true
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const extension = `chrome-extension://${extensionId}`;
  const reader = await context.newPage();
  await reader.goto(`${extension}/reader.html?wide=1`);
  await reader.locator('#setup-banner').waitFor({ state: 'visible' });
  await reader.screenshot({ path: join(screenshotDir, 'reader-desktop.png'), fullPage: true });
  await reader.locator('#example').click();
  await reader.getByText('内置示例 · 非实时 AI', { exact: true }).waitFor();
  await reader.screenshot({ path: join(screenshotDir, 'example-desktop.png'), fullPage: true });
  log('unconfigured install and explicitly labelled built-in example');

  const options = await context.newPage(); await options.goto(`${extension}/options.html`);
  await options.locator('#base-url').waitFor();
  await options.waitForFunction(() => document.getElementById('base-url').value !== '');
  await options.screenshot({ path: join(screenshotDir, 'settings-desktop.png'), fullPage: true });
  await options.locator('#provider').selectOption('custom');
  await options.locator('#base-url').fill(`${base}/v1`); await options.locator('#model').fill('mock-model'); await options.locator('#api-key').fill('test-secret-key');
  await options.locator('#save').click();
  await options.waitForFunction(() => /设置已保存|尚未授权/.test(document.getElementById('settings-message').textContent), null, { timeout: 10000 });
  assert.match(await options.locator('#settings-message').textContent(), /设置已保存/);
  log('settings save using Chrome permissions API with pre-granted test localhost origin');

  await reader.reload(); await reader.locator('#query').fill('蒹葭苍苍，白露为霜。'); await reader.locator('#query-submit').click();
  await reader.getByText('测试接口译注：蒹葭苍苍，白露为霜。', { exact: true }).waitFor();
  await reader.getByRole('button', { name: '收藏到生词笺', exact: true }).click();
  await reader.waitForFunction(() => document.getElementById('saved-count').textContent === '1');
  await reader.locator('#saved-tab').click(); await reader.getByRole('button', { name: '蒹葭苍苍，白露为霜。', exact: true }).waitFor();
  await reader.locator('#saved-search').fill('找不到的字词'); await reader.getByText('还没找到这句', { exact: true }).waitFor();
  await reader.locator('#saved-search').fill('');
  const downloadEvent = reader.waitForEvent('download'); await reader.locator('#export').click(); const download = await downloadEvent;
  const exported = await readFile(await download.path(), 'utf8'); assert(!exported.includes('test-secret-key')); assert.equal(JSON.parse(exported).entries.length, 1);
  log('real streaming API query, save, search and credential-free export');

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
    const result = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `function(...args) { return (${fn.toString()})(this, ...args); }`, arguments: args.map(value => ({ value })), returnByValue: true });
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
  await shadow(root => [...root.querySelectorAll('.sw-toolbar-button')].find(b => b.textContent === '字词解释').click());
  await waitShadow(root => !!root.querySelector('.sw-result'), 'AI result in floating card');
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
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  console.log(`\nBrowser integration checks passed. Screenshots: ${screenshotDir}`);
} finally {
  releaseSlow?.(); if (context) await context.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true }); await rm(fixture, { recursive: true, force: true });
}
