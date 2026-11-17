import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('node_modules/.cache/ms-playwright');
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const svg = await readFile('assets/mark.svg', 'utf8');
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`);
    await page.screenshot({ path: `assets/icon${size}.png`, omitBackground: true });
  }
  console.log('Generated 16, 32, 48, 128 px PNG icons from assets/mark.svg.');
} finally { await browser.close(); }
