// Адаптер Anthropic Messages API: превращает OpenAI-формат (messages/tools/tool_calls) в формат Claude и обратно.
const VERSION = '2023-06-01';
const hdr = t => ({ 'x-api-key': t.key, 'anthropic-version': VERSION, 'content-type': 'application/json' });

async function err(res) {
  let msg = `HTTP ${res.status}`;
  try { const j = await res.json(); msg = j.error?.message || msg; } catch {}
  return Object.assign(new Error(msg), { status: res.status });
}

async function listModels(t) {
  const res = await fetch(`${t.base}/models?limit=100`, { headers: hdr(t), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw await err(res);
  return ((await res.json()).data || []).map(m => m.id).sort();
}

function imgBlock(url) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(url || '');
  return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : { type: 'image', source: { type: 'url', url } };
}
function toBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return (content || []).map(p => p.type === 'image_url' ? imgBlock(p.image_url?.url) : { type: 'text', text: p.text || '' });
}

/** OpenAI messages → { system, messages } для Claude. Подряд идущие роли склеиваются. */
function convert(messages) {
  const system = [], out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks); else out.push({ role, content: [...blocks] });
  };
  for (const m of messages || []) {
    if (m.role === 'system') { system.push(typeof m.content === 'string' ? m.content : toBlocks(m.content).map(b => b.text).join('\n')); continue; }
    if (m.role === 'tool') { push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') }]); continue; }
    if (m.role === 'assistant') {
      const blocks = toBlocks(m.content);
      for (const tc of m.tool_calls || []) { let input = {}; try { input = JSON.parse(tc.function.arguments || '{}'); } catch {} blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input }); }
      push('assistant', blocks); continue;
    }
    push('user', toBlocks(m.content));
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '…' }] });
  return { system: system.join('\n\n'), messages: out };
}
const convertTools = tools => (tools || []).filter(t => t.type === 'function').map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));

async function chatStream({ target, model, messages, tools, temperature = 0.6, signal, onDelta }) {
  const { system, messages: msgs } = convert(messages);
  const body = { model, max_tokens: 4096, messages: msgs, stream: true, temperature: Math.min(1, temperature) };
  if (system) body.system = system;
  const ct = convertTools(tools); if (ct.length) body.tools = ct;
  const res = await fetch(`${target.base}/messages`, { method: 'POST', headers: hdr(target), body: JSON.stringify(body), signal });
  if (!res.ok) throw await err(res);
  const dec = new TextDecoder();
  let buf = '', content = '', reasoning = '', finishReason = null, usedModel = model;
  const blocks = {};
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      let j; try { j = JSON.parse(line.slice(5)); } catch { continue; }
      if (j.type === 'error') throw new Error(j.error?.message || 'stream error');
      if (j.type === 'message_start') usedModel = j.message?.model || usedModel;
      if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use') blocks[j.index] = { id: j.content_block.id, type: 'function', function: { name: j.content_block.name, arguments: '' } };
      if (j.type === 'content_block_delta') {
        const d = j.delta || {};
        if (d.type === 'text_delta') { content += d.text; onDelta?.({ content: d.text }); }
        if (d.type === 'thinking_delta') { reasoning += d.thinking; onDelta?.({ reasoning: d.thinking }); }
        if (d.type === 'input_json_delta' && blocks[j.index]) blocks[j.index].function.arguments += d.partial_json;
      }
      if (j.type === 'message_delta' && j.delta?.stop_reason) finishReason = j.delta.stop_reason === 'tool_use' ? 'tool_calls' : j.delta.stop_reason;
    }
  }
  const toolCalls = Object.keys(blocks).sort((a, b) => a - b).map(k => { const b = blocks[k]; if (!b.function.arguments) b.function.arguments = '{}'; return b; });
  return { content, reasoning, toolCalls, finishReason, model: usedModel, sources: [] };
}

async function chatOnce({ target, model, messages, temperature = 0.3, max_tokens = 400 }) {
  const { system, messages: msgs } = convert(messages);
  const body = { model, max_tokens, messages: msgs, temperature }; if (system) body.system = system;
  const res = await fetch(`${target.base}/messages`, { method: 'POST', headers: hdr(target), body: JSON.stringify(body) });
  if (!res.ok) throw await err(res);
  return ((await res.json()).content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

module.exports = { listModels, chatStream, chatOnce, convert, convertTools };
