const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { processAudio, processCommand, normalizeAudio, audioStats } = require('../lib/pipeline');
const { cleanText, rewriteText, buildSystemPrompt } = require('../lib/cleanup');
const { learnFromEdit, mergeDictionary } = require('../lib/text');
const { Store, DEFAULTS } = require('../lib/store');

const pcm = (seconds = 1, amp = 3000) => { const b = Buffer.alloc(Math.round(seconds * 32000)); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 4 ? amp : -amp, i); return b; };
const clone = (o) => JSON.parse(JSON.stringify(o));

function harness(over = {}) {
  const calls = { pasted: [], states: [], clean: [], history: [], last: over.last || null, rewrite: [] };
  const ctx = {
    settings: Object.assign(clone(DEFAULTS), over.settings || {}),
    canClean: over.canClean ?? true,
    ui: { state: (s, m) => calls.states.push([s, m]) },
    transcribe: async () => over.transcript ?? 'hello there my friend',
    cleanText: async (t, o) => { calls.clean.push(o); return { text: over.cleaned ?? t, cleaned: true }; },
    rewriteText: async (sel, ins) => { calls.rewrite.push([sel, ins]); return { text: over.rewritten ?? 'REWRITTEN' }; },
    getSelection: async () => over.selection ?? '',
    getApp: async () => over.app ?? { name: 'slack', title: '' },
    getLast: () => calls.last, setLast: (l) => { calls.last = l; },
    actions: { paste: async (t) => { calls.pasted.push(t); return { pasted: true }; } },
    addHistory: (h) => calls.history.push(h),
  };
  return { ctx, calls };
}

// ---------- prompt ----------
test('prompt teaches lists, numbers, paragraphs, emoji and gives examples', () => {
  const p = buildSystemPrompt({ tone: 'neutral' });
  for (const w of ['LISTS', 'bullet points', 'PARAGRAPHS', 'NUMBERS', 'EMOJI', 'Examples', '1. Book the venue']) assert.ok(p.includes(w), w);
});
test('code tone never builds lists; light level does not rephrase; translate replaces the never-translate rule', () => {
  assert.ok(buildSystemPrompt({ tone: 'code' }).includes('do not convert anything into lists'));
  assert.ok(buildSystemPrompt({ level: 'light' }).includes('Do not rephrase'));
  assert.ok(buildSystemPrompt({ level: 'polished' }).includes('tighten'));
  const t = buildSystemPrompt({ translateTo: 'Hindi' });
  assert.ok(t.includes('output the final text in Hindi') && !t.includes('NEVER translate'));
  assert.ok(buildSystemPrompt({ hasPrevious: true }).includes('Continuity'));
});

// ---------- cleanText / rewriteText with a fake chat API ----------
function fakeFetch(reply, seen = []) {
  global.fetch = async (url, init) => { seen.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ choices: [{ message: { content: reply } }] }) }; };
  return seen;
}
test('cleanText sends <before> context and keeps list output', async () => {
  const seen = fakeFetch('The plan:\n1. Book\n2. Send\n3. Sort');
  const r = await cleanText('the plan is first book second send third sort', { baseUrl: 'x', apiKey: 'k', previous: 'Earlier text.' });
  assert.ok(seen[0].messages[1].content.startsWith('<before>\nEarlier text.\n</before>'));
  assert.strictEqual(r.cleaned, true);
  assert.ok(r.text.includes('\n2. Send'));
});
test('cleanText falls back to raw on a runaway or empty model answer, and on API errors', async () => {
  fakeFetch('x'.repeat(500));
  assert.strictEqual((await cleanText('short words here', { baseUrl: 'x', apiKey: 'k' })).cleaned, false);
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const r = await cleanText('keep my words', { baseUrl: 'x', apiKey: 'k' });
  assert.deepStrictEqual([r.text, r.cleaned], ['keep my words', false]);
});
test('rewriteText sends instruction + selected text and returns the edit', async () => {
  const seen = fakeFetch('Short.');
  const r = await rewriteText('A very long sentence indeed.', 'make it shorter', { baseUrl: 'x', apiKey: 'k' });
  assert.strictEqual(r.text, 'Short.');
  assert.ok(seen[0].messages[1].content.includes('<instruction>\nmake it shorter') && seen[0].messages[1].content.includes('A very long sentence'));
  fakeFetch('');
  await assert.rejects(() => rewriteText('a', 'b', { baseUrl: 'x', apiKey: 'k' }));
});

// ---------- audio ----------
test('normalizeAudio boosts quiet speech but leaves loud audio and silence alone', () => {
  const q = normalizeAudio(pcm(1, 1000));
  assert.ok(audioStats(q.buf).peak >= 11000 && q.gain > 10);
  const loud = pcm(1, 20000);
  assert.strictEqual(normalizeAudio(loud).buf, loud);
  const quiet = pcm(1, 40);
  assert.strictEqual(normalizeAudio(quiet).gain, 1);
});

// ---------- pipeline: spacing, context, translate ----------
test('smart spacing: a quick second dictation in the same app gets a leading space; other apps do not', async () => {
  const { ctx, calls } = harness({ last: { text: 'Hello.', app: 'slack', ts: Date.now() - 3000 } });
  await processAudio(pcm(), ctx);
  assert.strictEqual(calls.pasted[0], ' hello there my friend');
  assert.strictEqual(calls.history[0].text, 'hello there my friend');            // history stays clean
  const o = harness({ last: { text: 'Hello.', app: 'chrome', ts: Date.now() - 3000 } });
  await processAudio(pcm(), o.ctx);
  assert.strictEqual(o.calls.pasted[0], 'hello there my friend');
  const old = harness({ last: { text: 'Hello.', app: 'slack', ts: Date.now() - 60000 } });
  await processAudio(pcm(), old.ctx);
  assert.strictEqual(old.calls.pasted[0], 'hello there my friend');
  const nl = harness({ last: { text: 'Hello.\n', app: 'slack', ts: Date.now() - 1000 } });
  await processAudio(pcm(), nl.ctx);
  assert.strictEqual(nl.calls.pasted[0], 'hello there my friend');
});
test('previous text becomes AI context for the same app and is remembered after pasting', async () => {
  const { ctx, calls } = harness({ last: { text: 'We should ship', app: 'slack', ts: Date.now() - 5000 } });
  await processAudio(pcm(), ctx);
  assert.strictEqual(calls.clean[0].previous, 'We should ship');
  assert.strictEqual(calls.last.text, 'hello there my friend');
});
test('translate mode cleans even short phrases and passes the target language', async () => {
  const { ctx, calls } = harness({ transcript: 'namaste', settings: { translateTo: 'English' } });
  await processAudio(pcm(), ctx);
  assert.strictEqual(calls.clean[0].translateTo, 'English');
});
test('history entries carry word count and audio seconds for stats', async () => {
  const { ctx, calls } = harness();
  await processAudio(pcm(2), ctx);
  assert.deepStrictEqual([calls.history[0].words, calls.history[0].seconds], [4, 2]);
});

// ---------- Command Mode ----------
test('Command Mode rewrites the selection and pastes over it', async () => {
  const { ctx, calls } = harness({ transcript: 'make this shorter', selection: 'A long wordy sentence.' });
  const r = await processCommand(pcm(), ctx);
  assert.strictEqual(r.status, 'pasted');
  assert.deepStrictEqual(calls.rewrite[0], ['A long wordy sentence.', 'make this shorter']);
  assert.deepStrictEqual(calls.pasted, ['REWRITTEN']);
  assert.strictEqual(calls.history[0].kind, 'command');
});
test('Command Mode handles: no selection, no key, silence', async () => {
  let h = harness({ transcript: 'make it formal', selection: '   ' });
  assert.strictEqual((await processCommand(pcm(), h.ctx)).status, 'noselection');
  assert.strictEqual(h.calls.pasted.length, 0);
  h = harness({ canClean: false, selection: 'text' });
  assert.strictEqual((await processCommand(pcm(), h.ctx)).status, 'nokey');
  h = harness({ selection: 'text' });
  assert.strictEqual((await processCommand(pcm(1, 5), h.ctx)).status, 'silent');
});

// ---------- learn from edits ----------
test('learnFromEdit finds names, terms and typos but ignores grammar rewrites', () => {
  assert.deepStrictEqual(learnFromEdit('hey this is neural syntax channel', 'hey this is NeuralSyntax channel'), [['neural syntax', 'NeuralSyntax']]);
  assert.deepStrictEqual(learnFromEdit('i use cloud code daily', 'I use Claude Code daily'), [['cloud code', 'Claude Code']]);
  assert.deepStrictEqual(learnFromEdit('we will recieve it', 'we will receive it'), [['recieve', 'receive']]);
  assert.deepStrictEqual(learnFromEdit('push it to github now', 'push it to GitHub now'), [['github', 'GitHub']]);
  assert.deepStrictEqual(learnFromEdit('we is going home', 'we are going home'), []);
  assert.deepStrictEqual(learnFromEdit('same text here', 'same text here'), []);
  assert.deepStrictEqual(learnFromEdit('hello world', 'Hello world.'), []);       // capitalisation/punctuation alone is not a term
});
test('mergeDictionary appends only new lines', () => {
  const d = mergeDictionary('NeuralSyntax', [['neural syntax', 'NeuralSyntax']]);
  assert.strictEqual(d, 'NeuralSyntax\nneural syntax => NeuralSyntax');
  assert.strictEqual(mergeDictionary(d, [['neural syntax', 'NeuralSyntax']]), d);
});

// ---------- store ----------
test('store keeps lifetime stats and can edit history entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-'));
  const s = new Store(dir);
  const a = s.addHistory({ text: 'x', words: 80, seconds: 30, kind: 'dictation' });
  s.addHistory({ text: 'y', words: 40, seconds: 20, kind: 'dictation' });
  assert.deepStrictEqual(s.getStats(), { words: 120, seconds: 50, count: 2, since: s.stats.since, savedMinutes: 2 });
  s.updateHistory(a.id, { text: 'edited' });
  assert.strictEqual(new Store(dir).getHistory().find((h) => h.id === a.id).text, 'edited');
  assert.strictEqual(new Store(dir).getStats().words, 120);                        // persisted
  const defaults = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'nf-'))).get();
  assert.deepStrictEqual([defaults.commandHotkey, defaults.smartSpacing, defaults.autoGain, defaults.cleanup.level, defaults.translateTo], ['F9', true, true, 'standard', '']);
});
