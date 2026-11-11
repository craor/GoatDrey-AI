// Совместимость с v1.0: прежний Groq-клиент поверх универсального ai.js.
const ai = require('./ai');
const BASE = 'https://api.groq.com/openai/v1';
const T = key => ({ provider: 'groq', base: BASE, key });
module.exports = {
  BASE, cleanCites: ai.cleanCites, buildBody: ai.buildBody, sanitizeMessages: ai.sanitizeMessages, TOOL_MISMATCH: ai.TOOL_MISMATCH,
  listModels: key => ai.listModels(T(key)),
  chatStream: o => ai.chatStream({ ...o, target: T(o.key) }),
  chatWithToolGuard: o => ai.chatWithToolGuard({ ...o, target: T(o.key) }),
  chatOnce: o => ai.chatOnce({ ...o, target: T(o.key) }),
  transcribe: o => ai.transcribe({ ...o, target: T(o.key), model: 'whisper-large-v3-turbo' })
};
