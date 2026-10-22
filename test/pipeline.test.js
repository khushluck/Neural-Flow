const test = require('node:test');
const assert = require('node:assert');
const { processAudio } = require('../lib/pipeline');
const { cleanText, buildSystemPrompt } = require('../lib/cleanup');
const { DEFAULTS } = require('../lib/store');

const pcm = (seconds = 1, amp = 3000) => { const b = Buffer.alloc(Math.round(seconds * 32000)); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 4 ? amp : -amp, i); return b; };
const clone = (o) => JSON.parse(JSON.stringify(o));

function harness(over = {}) {
  const calls = { states: [], pasted: [], actions: [], history: [], cleanInputs: [] };
  const ctx = {
    settings: Object.assign(clone(DEFAULTS), over.settings || {}),
    canClean: over.canClean ?? true,
    ui: { state: (s, m) => calls.states.push([s, m]) },
    transcribe: async () => over.transcript ?? 'um so i think we should ship it on friday',
    cleanText: async (t, o) => { calls.cleanInputs.push(o); if (over.cleanThrows) throw new Error('boom'); return { text: 'I think we should ship it on Friday.', cleaned: true }; },
    getApp: async () => over.app ?? { name: 'slack', title: '' },
    actions: {
      paste: async (t) => { calls.pasted.push(t); return { pasted: over.pasteOk ?? true }; },
      undo: async () => calls.actions.push('undo'), enter: async () => calls.actions.push('enter'), selectAll: async () => calls.actions.push('selectAll'),
    },
    addHistory: (h) => calls.history.push(h),
    pasteHint: 'Ctrl+V',
  };
  return { ctx, calls };
}

test('dictation is cleaned, tone comes from the active app, result is pasted and saved', async () => {
  const { ctx, calls } = harness();
  const r = await processAudio(pcm(), ctx);
  assert.strictEqual(r.status, 'pasted');
  assert.deepStrictEqual(calls.pasted, ['I think we should ship it on Friday.']);
  assert.strictEqual(calls.cleanInputs[0].tone, 'casual'); // slack
  assert.strictEqual(calls.history[0].raw, 'um so i think we should ship it on friday');
});

test('silent audio never hits the network', async () => {
  const { ctx, calls } = harness();
  ctx.transcribe = async () => { throw new Error('should not be called'); };
  const r = await processAudio(pcm(1, 10), ctx);
  assert.strictEqual(r.status, 'silent');
  assert.strictEqual(calls.pasted.length, 0);
});

test('cleanup failure falls back to the raw transcript', async () => {
  const { ctx, calls } = harness({ cleanThrows: true });
  await processAudio(pcm(), ctx);
  assert.deepStrictEqual(calls.pasted, ['um so i think we should ship it on friday']);
});

test('short utterances skip cleanup; disabled cleanup skips it too', async () => {
  let h = harness({ transcript: 'okay sounds good' });
  await processAudio(pcm(), h.ctx);
  assert.strictEqual(h.calls.cleanInputs.length, 0);
  h = harness({ settings: { cleanup: { ...DEFAULTS.cleanup, enabled: false } } });
  await processAudio(pcm(), h.ctx);
  assert.strictEqual(h.calls.cleanInputs.length, 0);
});

test('voice command "delete that" triggers undo, not typing', async () => {
  const { ctx, calls } = harness({ transcript: 'Delete that.' });
  const r = await processAudio(pcm(), ctx);
  assert.strictEqual(r.status, 'command');
  assert.deepStrictEqual(calls.actions, ['undo']);
  assert.strictEqual(calls.pasted.length, 0);
});

test('snippet expands verbatim and skips cleanup', async () => {
  const { ctx, calls } = harness({ transcript: 'My email.', settings: { snippets: 'my email => hi@example.com' } });
  await processAudio(pcm(), ctx);
  assert.deepStrictEqual(calls.pasted, ['hi@example.com']);
  assert.strictEqual(calls.cleanInputs.length, 0);
});

test('dictionary replacements are applied before cleanup', async () => {
  const { ctx, calls } = harness({ transcript: 'welcome to neural syntax today everyone', settings: { dictionary: 'neural syntax => NeuralSyntax', cleanup: { ...DEFAULTS.cleanup, enabled: false } } });
  await processAudio(pcm(), ctx);
  assert.deepStrictEqual(calls.pasted, ['welcome to NeuralSyntax today everyone']);
});

test('failed paste shows a "Copied" toast (text stays on the clipboard)', async () => {
  const { ctx, calls } = harness({ pasteOk: false });
  const r = await processAudio(pcm(), ctx);
  assert.strictEqual(r.status, 'copied');
  assert.deepStrictEqual(calls.states.at(-1), ['toast', 'Copied — press Ctrl+V']);
});

test('cleanText rejects hallucinated answers and strips wrapper quotes', async () => {
  const realFetch = global.fetch;
  const reply = (content) => { global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) }); };
  const o = { baseUrl: 'x', apiKey: 'k', model: 'm' };
  try {
    reply('"I think we should ship on Friday."');
    assert.strictEqual((await cleanText('um i think we should ship on friday', o)).text, 'I think we should ship on Friday.');
    reply('Sure! Here is a long answer to your question about shipping that goes on and on and on and on and on and on and on and on and on and on and on and on.');
    const r = await cleanText('what day should we ship', o);
    assert.strictEqual(r.cleaned, false);
    assert.strictEqual(r.text, 'what day should we ship');
  } finally { global.fetch = realFetch; }
});

test('cleanup prompt carries tone, dictionary and Hinglish rule', () => {
  const p = buildSystemPrompt({ tone: 'formal', dictWords: ['NeuralSyntax'], hinglishRoman: true });
  assert.ok(p.includes('Professional email'));
  assert.ok(p.includes('NeuralSyntax'));
  assert.ok(p.includes('Roman script'));
});
