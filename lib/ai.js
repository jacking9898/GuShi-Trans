import { AppError, endpointFrom, buildMessages, parseResult, requestPolicy } from './core.js';

function completedResult(content, truncated, reasoning) {
  if (!truncated) return parseResult(content);
  try {
    const result = parseResult(content);
    result.notice = '接口已达到本次输出上限；以下译注可以读取，但内容可能不完整。需要时可重新生成。';
    return result;
  } catch {
    throw new AppError('OUTPUT_LIMIT', !content?.trim() && reasoning
      ? '深度思考已用完本次输出额度，尚未返回译注。请在设置中关闭深度思考后重试。'
      : 'AI 输出达到长度上限，译注尚未完整返回。可在设置中关闭深度思考后重试；这不代表所选文字过长。');
  }
}

export async function readCompletion(response) {
  if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
    const body = await response.text();
    if (body.length > 200000) throw new AppError('FORMAT', 'AI 返回内容过长，请缩短选文后重试。');
    let data;
    try { data = JSON.parse(body); } catch { throw new AppError('FORMAT', '接口未返回有效 JSON，请检查接口地址。'); }
    const choice = data.choices?.[0];
    return completedResult(choice?.message?.content, choice?.finish_reason === 'length', !!choice?.message?.reasoning_content);
  }
  if (!response.body) throw new AppError('FORMAT', 'AI 没有返回正文，请重试。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', content = '', total = 0, truncated = false, reasoning = false;
  function consume(line) {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let event;
    try { event = JSON.parse(data); } catch { throw new AppError('FORMAT', 'AI 响应中断或格式异常，请重试。'); }
    if (event.error) throw new AppError('API', 'AI 服务在生成时返回错误，请稍后重试。');
    const choice = event.choices?.[0];
    if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
    if (choice?.delta?.reasoning_content) reasoning = true;
    if (choice?.finish_reason === 'length') truncated = true;
    if (content.length > 120000) throw new AppError('FORMAT', 'AI 返回内容过长，请分段查询。');
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 8000000) throw new AppError('FORMAT', 'AI 响应过长，请关闭深度思考后重试。');
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) consume(line.replace(/\r$/, ''));
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer.replace(/\r$/, ''));
    return completedResult(content, truncated, reasoning);
  } finally { await reader.cancel().catch(() => {}); }
}

// Only fixed, allowlisted error codes and parameter names become user-visible.
// Never forward arbitrary provider messages, bodies or request IDs (which may
// contain selected text, endpoint credentials or reflected Authorization values).
async function errorMetadata(response) {
  if (!response.body) return {};
  const reader = response.body.getReader();
  let bytes = 0, body = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16384) return {};
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    const raw = JSON.parse(body)?.error;
    const codes = new Set(['unsupported_parameter', 'unsupported_value', 'invalid_value', 'invalid_parameter', 'model_not_found', 'insufficient_quota', 'invalid_api_key', 'unsupported_country_region_territory']);
    const params = new Set(['max_tokens', 'max_completion_tokens', 'reasoning_effort', 'response_format', 'model', 'messages', 'stream', 'temperature', 'top_p']);
    return { code: codes.has(raw?.code) ? raw.code : '', param: params.has(raw?.param) ? raw.param : '' };
  } catch { return {}; }
  finally { await reader.cancel().catch(() => {}); }
}

function apiFailure(status, { code, param }) {
  if (code === 'model_not_found') return '当前模型不存在，或此 API 项目无权使用。请核对模型 ID 和项目权限。';
  if (code === 'insufficient_quota') return 'AI 账户额度不足，请检查 API 项目的余额与用量限制。';
  if (code === 'invalid_api_key') return 'API Key 无效或已过期，请到设置中检查。';
  if (code === 'unsupported_country_region_territory') return 'AI 服务不支持当前请求所在的国家或地区。';
  if (status === 400) {
    const hints = {
      max_tokens: '当前模型拒绝 max_tokens 参数。OpenAI 新模型应使用 max_completion_tokens，请确认插件已更新。',
      max_completion_tokens: '接口拒绝 max_completion_tokens 参数。请核对服务商类型、模型和兼容协议。',
      reasoning_effort: '模型拒绝当前 reasoning_effort 思考参数。请核对该模型支持的思考档位。',
      response_format: '模型拒绝 response_format 输出格式。请关闭严格 JSON 模式，保存后重试。',
      model: '接口拒绝当前模型名称，请核对模型 ID 及 API 项目权限。',
      messages: '模型拒绝 messages 消息格式，请核对其是否支持 Chat Completions。',
      stream: '模型拒绝 stream 流式参数，请核对其是否支持流式 Chat Completions。',
      temperature: '模型拒绝 temperature 参数，请核对模型支持的采样设置。',
      top_p: '模型拒绝 top_p 参数，请核对模型支持的采样设置。'
    };
    return hints[param] || 'AI 接口拒绝本次请求（HTTP 400），未提供可识别的错误参数。请核对模型及其 Chat Completions 支持情况。';
  }
  const messages = {
    401: 'API Key 无效或已过期，请到设置中检查。',
    402: 'AI 账户余额不足，请检查服务商账户。',
    403: 'AI 服务拒绝访问，请检查密钥权限与服务区域。',
    404: '接口或模型不存在，请检查地址和模型名称。',
    429: '请求过于频繁或额度不足，请稍后重试。'
  };
  return messages[status] || `AI 服务暂时不可用（HTTP ${status}），请稍后重试。`;
}

export async function queryAI(settings, request, signal, fetchImpl = fetch) {
  const { endpoint } = endpointFrom(settings.baseUrl);
  const policy = requestPolicy(settings);
  const payload = { model: settings.model, messages: buildMessages(request), stream: true, [policy.openai ? 'max_completion_tokens' : 'max_tokens']: policy.maxTokens };
  if (policy.openaiReasoning) payload.reasoning_effort = policy.thinking ? 'medium' : 'none';
  if (policy.deepseek) payload.thinking = { type: policy.thinking ? 'enabled' : 'disabled' };
  if (policy.qwen) payload.enable_thinking = policy.thinking;
  if (settings.jsonMode) payload.response_format = { type: 'json_object' };
  const firstResponse = new AbortController();
  const combinedSignal = AbortSignal.any([signal, firstResponse.signal]);
  const timer = setTimeout(() => firstResponse.abort(), 25000);
  let response;
  try {
    response = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` }, body: JSON.stringify(payload), signal: combinedSignal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
  } finally { clearTimeout(timer); }
  if (!response.ok) {
    const metadata = await errorMetadata(response);
    if (signal.aborted) throw signal.reason;
    throw new AppError('API', apiFailure(response.status, metadata));
  }
  return readCompletion(response);
}
