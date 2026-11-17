import { DEFAULT_SETTINGS, AppError, validateSettings, requestPolicy } from './core.js';

export const PRESETS = Object.freeze({
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  qwen: { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-flash' },
  custom: { name: '自定义兼容接口', baseUrl: 'https://api.example.com/v1', model: 'your-model' }
});
const preferenceKeys = ['enabled', 'includeContext', 'fontSize', 'dockedReading'];
export function preferences(value = {}) {
  return Object.fromEntries(preferenceKeys.map(key => [key, key === 'fontSize' ? (value[key] === 'large' ? 'large' : 'normal') : typeof value[key] === 'boolean' ? value[key] : DEFAULT_SETTINGS[key]]));
}
export function newProvider(kind = 'deepseek', id = crypto.randomUUID()) {
  const preset = PRESETS[kind] || PRESETS.custom;
  return { id, kind: Object.hasOwn(PRESETS, kind) ? kind : 'custom', ...preset, apiKey: '', thinkingEnabled: false, jsonMode: false };
}
export function migrateSettings(value = {}) {
  const old = { ...DEFAULT_SETTINGS, ...value };
  let kind = 'custom';
  try {
    const host = new URL(old.baseUrl).hostname;
    if (host === 'api.deepseek.com') kind = 'deepseek';
    else if (host === 'api.openai.com') kind = 'openai';
    else if (/^(dashscope(?:-intl|-us)?\.aliyuncs\.com)$/.test(host) || host.endsWith('.maas.aliyuncs.com')) kind = 'qwen';
  } catch { /* Keep legacy values editable, including incomplete configurations. */ }
  const profile = { ...newProvider(kind, 'legacy'), ...Object.fromEntries(['baseUrl', 'model', 'apiKey', 'jsonMode', 'thinkingEnabled'].map(key => [key, old[key]])) };
  return { version: 2, preferences: preferences(old), providers: [profile], activeProviderId: profile.id };
}
export function validateConfiguration(value) {
  if (!Array.isArray(value?.providers) || value.providers.length > 20) throw new AppError('SETTINGS', '最多保存 20 套 AI 配置。');
  const ids = new Set();
  const providers = value.providers.map(profile => {
    if (typeof profile?.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(profile.id) || ids.has(profile.id)) throw new AppError('SETTINGS', 'AI 配置标识重复或无效，请重新添加。');
    ids.add(profile.id);
    if (typeof profile.name !== 'string' || !profile.name.trim() || profile.name.trim().length > 40 || /[\r\n]/.test(profile.name)) throw new AppError('SETTINGS', '请填写 1–40 字的配置名称。');
    if (!Object.hasOwn(PRESETS, profile.kind)) throw new AppError('SETTINGS', '请选择支持的服务商。');
    // Draft profiles without a key may be saved; ANALYZE still requires a real configured key.
    const settings = validateSettings({ ...profile, apiKey: profile.apiKey === '' ? 'unconfigured' : profile.apiKey });
    return { id: profile.id, name: profile.name.trim(), kind: profile.kind, ...Object.fromEntries(['baseUrl', 'model', 'apiKey', 'jsonMode', 'thinkingEnabled'].map(key => [key, key === 'apiKey' && profile.apiKey === '' ? '' : settings[key]])) };
  });
  if (providers.length ? !ids.has(value.activeProviderId) : value.activeProviderId !== null) throw new AppError('SETTINGS', '请选择默认使用的 AI 配置。');
  return { version: 2, preferences: preferences(value.preferences), providers, activeProviderId: value.activeProviderId };
}
export function resolveSettings(configuration, providerId = configuration.activeProviderId) {
  const provider = configuration.providers.find(p => p.id === providerId);
  if (!provider) throw new AppError('SETTINGS', '所选 AI 配置已删除，请到设置中添加或重新选择。');
  return { ...DEFAULT_SETTINGS, ...configuration.preferences, ...provider, providerId: provider.id, providerName: provider.name };
}
export function publicProviders(configuration) {
  return { activeProviderId: configuration.activeProviderId, providers: configuration.providers.map(p => ({ id: p.id, name: p.name, kind: p.kind, model: p.model, configured: !!p.apiKey, thinkingEnabled: requestPolicy(p).thinking })) };
}
