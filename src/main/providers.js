// Пресеты провайдеров ИИ. Почти все говорят на OpenAI-совместимом API (/chat/completions, /models),
// Anthropic — через свой адаптер (см. anthropic.js). Локальные (Ollama, LM Studio) работают без ключа.
const PRESETS = {
  ollama: {
    name: 'Локально (Ollama)', short: 'ollama', base: 'http://localhost:11434/v1', local: true, noKey: true,
    defaultModel: 'qwen2.5:7b', visionModel: 'qwen2.5vl:7b', tools: 'auto', note: 'Бесплатно и офлайн. Нужна установленная Ollama.'
  },
  lmstudio: {
    name: 'Локально (LM Studio)', short: 'lmstudio', base: 'http://localhost:1234/v1', local: true, noKey: true,
    defaultModel: '', tools: 'auto', note: 'Включите сервер в LM Studio: Developer → Start Server.'
  },
  groq: {
    name: 'Groq', short: 'groq', base: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys', keyPrefix: /^gsk_/,
    defaultModel: 'openai/gpt-oss-120b', visionModel: 'qwen/qwen3.8-27b', tools: 'native', browserSearch: true,
    stt: 'whisper-large-v3-turbo', fallbackModels: ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'], note: 'Быстро, есть бесплатный тариф, встроенный поиск и Whisper.'
  },
  openai: {
    name: 'OpenAI', short: 'openai', base: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys', keyPrefix: /^sk-(?!or-|ant-)/,
    defaultModel: 'gpt-4.1-mini', visionModel: 'gpt-4.1-mini', tools: 'native', stt: 'whisper-1',
    image: { kind: 'openai', models: ['gpt-image-1', 'dall-e-3'] }, note: 'Чат, картинки (gpt-image-1, DALL·E 3), Whisper.'
  },
  xai: {
    name: 'xAI (Grok)', short: 'xai', base: 'https://api.x.ai/v1', keyUrl: 'https://console.x.ai', keyPrefix: /^xai-/,
    defaultModel: 'grok-4', visionModel: 'grok-4', tools: 'native', image: { kind: 'openai', models: ['grok-2-image'] }, note: 'Grok и генерация картинок grok-2-image.'
  },
  gemini: {
    name: 'Google Gemini', short: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey', keyPrefix: /^AIza/,
    defaultModel: 'gemini-2.5-flash', visionModel: 'gemini-2.5-flash', tools: 'native', note: 'Щедрый бесплатный лимит, видит картинки.'
  },
  anthropic: {
    name: 'Anthropic (Claude)', short: 'claude', base: 'https://api.anthropic.com/v1', keyUrl: 'https://console.anthropic.com/settings/keys', keyPrefix: /^sk-ant-/,
    adapter: 'anthropic', defaultModel: 'claude-sonnet-4-5', visionModel: 'claude-sonnet-4-5', tools: 'native', note: 'Через родной API Anthropic (Messages).'
  },
  openrouter: {
    name: 'OpenRouter', short: 'openrouter', base: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys', keyPrefix: /^sk-or-/,
    defaultModel: 'openrouter/auto', tools: 'native', note: 'Сотни моделей по одному ключу, есть бесплатные (:free).'
  },
  deepseek: {
    name: 'DeepSeek', short: 'deepseek', base: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys',
    defaultModel: 'deepseek-chat', tools: 'native', note: 'Дёшево и умно. Картинки не видит.'
  },
  mistral: {
    name: 'Mistral', short: 'mistral', base: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys',
    defaultModel: 'mistral-small-latest', visionModel: 'mistral-small-latest', tools: 'native', note: 'Европейские модели, есть бесплатный тариф.'
  },
  minimax: {
    name: 'MiniMax', short: 'minimax', base: 'https://api.minimax.io/v1', keyUrl: 'https://www.minimax.io/platform',
    defaultModel: 'MiniMax-M2', tools: 'native', image: { kind: 'minimax', models: ['image-01'] }, video: { kind: 'minimax', models: ['MiniMax-Hailuo-02', 'T2V-01'] },
    note: 'Чат, картинки image-01 и видео Hailuo.'
  },
  together: {
    name: 'Together AI', short: 'together', base: 'https://api.together.xyz/v1', keyUrl: 'https://api.together.xyz/settings/api-keys',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', visionModel: 'Qwen/Qwen2.5-VL-72B-Instruct', tools: 'native',
    image: { kind: 'openai', models: ['black-forest-labs/FLUX.1-schnell', 'black-forest-labs/FLUX.1-dev'] }, note: 'Открытые модели и FLUX для картинок.'
  },
  custom: {
    name: 'Свой (Custom)', short: 'custom', base: '', tools: 'auto', defaultModel: '', note: 'Любой OpenAI-совместимый адрес: vLLM, LocalAI, прокси и т.п.'
  }
};

const ORDER = ['ollama', 'lmstudio', 'groq', 'openai', 'xai', 'gemini', 'anthropic', 'openrouter', 'deepseek', 'mistral', 'minimax', 'together', 'custom'];

/** Угадать провайдера по префиксу ключа. Порядок важен: sk-or- и sk-ant- раньше общего sk-. */
function detectProvider(key = '') {
  const k = String(key).trim();
  if (/^gsk_/.test(k)) return 'groq';
  if (/^sk-or-/.test(k)) return 'openrouter';
  if (/^sk-ant-/.test(k)) return 'anthropic';
  if (/^xai-/.test(k)) return 'xai';
  if (/^AIza/.test(k)) return 'gemini';
  if (/^sk-api-/.test(k) || /^eyJ/.test(k)) return 'minimax';
  if (/^sk-/.test(k)) return 'openai';
  return null;
}

function preset(id) { return PRESETS[id] || PRESETS.custom; }
function baseOf(profile) { return String(profile.baseUrl || preset(profile.provider).base || '').replace(/\/+$/, ''); }

module.exports = { PRESETS, ORDER, detectProvider, preset, baseOf };
