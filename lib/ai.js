import { AppError, endpointFrom, buildMessages, parseResult } from './core.js';

export async function readCompletion(response) {
  if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
    const body = await response.text();
    if (body.length > 200000) throw new AppError('FORMAT', 'AI 返回内容过长，请缩短选文后重试。');
    let data;
    try { data = JSON.parse(body); } catch { throw new AppError('FORMAT', '接口未返回有效 JSON，请检查接口地址。'); }
    if (data.choices?.[0]?.finish_reason === 'length') throw new AppError('FORMAT', '译注被截断，请缩短选文后重试。');
    return parseResult(data.choices?.[0]?.message?.content);
  }
  if (!response.body) throw new AppError('FORMAT', 'AI 没有返回正文，请重试。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', content = '', total = 0, truncated = false;
  function consume(line) {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let event;
    try { event = JSON.parse(data); } catch { throw new AppError('FORMAT', 'AI 响应中断或格式异常，请重试。'); }
    if (event.error) throw new AppError('API', 'AI 服务在生成时返回错误，请稍后重试。');
    const choice = event.choices?.[0];
    if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
    if (choice?.finish_reason === 'length') truncated = true;
    if (content.length > 120000) throw new AppError('FORMAT', 'AI 返回内容过长，请分段查询。');
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 1500000) throw new AppError('FORMAT', 'AI 响应过长，请换用非推理模型或缩短选文。');
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) consume(line.replace(/\r$/, ''));
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer.replace(/\r$/, ''));
    if (truncated) throw new AppError('FORMAT', '译注被截断，请缩短选文后重试。');
    return parseResult(content);
  } finally { await reader.cancel().catch(() => {}); }
}

export async function queryAI(settings, request, signal, fetchImpl = fetch) {
  const { endpoint } = endpointFrom(settings.baseUrl);
  const payload = { model: settings.model, messages: buildMessages(request), stream: true, max_tokens: 3500 };
  if (settings.jsonMode) payload.response_format = { type: 'json_object' };
  const firstResponse = new AbortController();
  const combinedSignal = AbortSignal.any([signal, firstResponse.signal]);
  const timer = setTimeout(() => firstResponse.abort(), 25000);
  let response;
  try {
    response = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` }, body: JSON.stringify(payload), signal: combinedSignal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
  } finally { clearTimeout(timer); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const messages = {
      400: '接口不接受当前参数，请检查模型名称、地址，或关闭 JSON 模式。',
      401: 'API Key 无效或已过期，请到设置中检查。',
      402: 'AI 账户余额不足，请检查服务商账户。',
      403: 'AI 服务拒绝访问，请检查密钥权限与服务区域。',
      404: '接口或模型不存在，请检查地址和模型名称。',
      429: '请求过于频繁或额度不足，请稍后重试。'
    };
    throw new AppError('API', messages[response.status] || `AI 服务暂时不可用（HTTP ${response.status}），请稍后重试。`);
  }
  return readCompletion(response);
}
