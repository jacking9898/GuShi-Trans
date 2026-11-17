import { AppError, endpointFrom } from './core.js';

const MAX_MODELS = 2000;
export function modelSettings(value) {
  const baseUrl = typeof value?.baseUrl === 'string' ? value.baseUrl.trim() : '';
  const apiKey = typeof value?.apiKey === 'string' ? value.apiKey.trim() : '';
  endpointFrom(baseUrl);
  if (!apiKey || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new AppError('SETTINGS', '请先填写当前服务商的 API Key，再获取模型列表。');
  return { baseUrl, apiKey };
}
export function modelsEndpoint(baseUrl) {
  const { endpoint, origin } = endpointFrom(baseUrl);
  const url = new URL(endpoint);
  const qwen = /^dashscope(?:-intl|-us)?\.aliyuncs\.com$/.test(url.hostname) || /^[a-z0-9-]+\.(?:cn-beijing|ap-southeast-1|cn-hongkong|eu-central-1|ap-northeast-1)\.maas\.aliyuncs\.com$/.test(url.hostname);
  // DashScope's catalog uses its native API on the same configured host. Other
  // compatible services retain their own prefix, including /v1 and local ports.
  url.pathname = qwen ? '/api/v1/models' : url.pathname.replace(/\/chat\/completions$/, '/models');
  if (qwen) { url.searchParams.set('page_no', '1'); url.searchParams.set('page_size', '100'); }
  return { url, origin, qwen };
}
export async function modelsKey(settings) {
  const value = JSON.stringify([modelsEndpoint(settings.baseUrl).url.href, settings.apiKey]);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function jsonBody(response, budget) {
  if (!response.body) throw new AppError('MODELS_FORMAT', '模型列表为空或格式不兼容，可继续手动填写模型 ID。');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength; budget.bytes += value.byteLength;
      if (bytes > 2000000 || budget.bytes > 8000000) throw new AppError('MODELS_LIMIT', '模型列表过大，请使用服务商提供的筛选地址，或手动填写模型 ID。');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); } catch { throw new AppError('MODELS_FORMAT', '接口未返回有效模型列表，可继续手动填写模型 ID。'); }
  } finally { await reader.cancel().catch(() => {}); }
}
function modelRows(data, qwen) {
  const rows = qwen ? data?.output?.models : data?.data;
  if (data?.success === false || !Array.isArray(rows)) throw new AppError('MODELS_FORMAT', '接口未返回兼容的模型列表，可继续手动填写模型 ID。');
  return rows;
}
export async function queryModels(settings, signal, fetchImpl = fetch) {
  const { url, qwen } = modelsEndpoint(settings.baseUrl);
  const combined = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  const budget = { bytes: 0 }, models = new Set();
  let truncated = false;
  for (let page = 1; page <= 20; page++) {
    if (qwen) url.searchParams.set('page_no', String(page));
    const response = await fetchImpl(url.href, { method: 'GET', headers: { Authorization: `Bearer ${settings.apiKey}` }, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: combined });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const messages = { 401: '获取模型列表失败：API Key 无效或已过期。', 403: '当前 Key 无权查询模型列表，请检查服务商权限和地域；仍可手动填写。', 404: '此接口未提供模型列表，请继续手动填写模型 ID。', 405: '此接口不支持查询模型列表，请继续手动填写模型 ID。', 429: '模型列表查询受限，请稍后点击刷新，或手动填写模型 ID。' };
      throw new AppError('MODELS_API', messages[response.status] || `获取模型列表失败（HTTP ${response.status}），可继续手动填写模型 ID。`);
    }
    const data = await jsonBody(response, budget), rows = modelRows(data, qwen);
    for (const row of rows) {
      const id = qwen ? row?.model : row?.id;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,149}$/.test(id) || id.includes(settings.apiKey)) continue;
      if (models.size >= MAX_MODELS && !models.has(id)) { truncated = true; break; }
      models.add(id);
    }
    if (!qwen) { truncated ||= rows.length > MAX_MODELS; break; }
    const total = Number(data.output.total);
    const size = Number(data.output.page_size) || rows.length;
    if (!rows.length || (Number.isFinite(total) && page * size >= total)) break;
    if (page === 20 || models.size >= MAX_MODELS) { truncated = true; break; }
  }
  if (combined.aborted) throw combined.reason;
  return { models: [...models].sort((a, b) => a.localeCompare(b, 'en')), truncated };
}
