import { readFile, access, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert(!manifest.permissions.includes('tabs'), 'No broad browsing-history permission');
assert(!manifest.host_permissions, 'Provider permissions must be optional');
const files = [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page, manifest.side_panel.default_path, ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(x => x.js), ...manifest.web_accessible_resources.flatMap(x => x.resources)];
for (const file of files) await access(file);
for (const directory of ['.', 'lib']) {
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.js')) continue;
    const path = `${directory}/${file}`;
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
}
for (const page of ['reader.html', 'options.html', 'panel.html']) {
  const html = await readFile(page, 'utf8');
  assert(!/<script(?![^>]*src=)[^>]*>/i.test(html), 'No inline scripts under MV3 CSP');
  for (const match of html.matchAll(/(?:src|href)="([^"?#]+)(?:[?#][^"]*)?"/g)) {
    if (/^(https?:|#)/.test(match[1])) continue;
    await access(match[1]);
  }
}
console.log('Manifest, assets, page references, and JavaScript syntax are valid.');
