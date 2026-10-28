const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const Segmenter = require('../lib/segmenter');
const { reverseKeyMap, describeKey } = require('../lib/keys');
const { whisperPrompt, isMarkdownApp, parseDictionary } = require('../lib/text');
const { buildSystemPrompt } = require('../lib/cleanup');
const { transcribeWithFallback } = require('../lib/stt');
const { Store, DEFAULTS } = require('../lib/store');
const { processAudio } = require('../lib/pipeline');

// ---------- Segmenter ----------
const CH = 128; // samples per chunk (8 ms at 16 kHz), like the audio worklet
function feedMs(seg, ms, amp) {
  const out = [];
  const chunk = new Float32Array(CH).map((_, i) => amp * Math.sin(i / 3));
  for (let t = 0; t < ms; t += 8) { const r = seg.feed(chunk); if (r) out.push(r); }
  return out;
}
test('segmenter cuts after a sentence followed by a pause, not during short pauses', () => {
  const s = new Segmenter();
  assert.strictEqual(feedMs(s, 1500, 0.2).length, 0);          // talking
  assert.strictEqual(feedMs(s, 600, 0.001).length, 0);         // short breath
  assert.strictEqual(feedMs(s, 1200, 0.2).length, 0);          // keeps talking
  const cut = feedMs(s, 1300, 0.001);                          // real pause
  assert.strictEqual(cut.length, 1);
  assert.strictEqual(cut[0].paragraph, false);
});
test('segmenter ignores blips and silence-only audio', () => {
  const s = new Segmenter();
  assert.strictEqual(feedMs(s, 3000, 0.001).length, 0);
  feedMs(s, 200, 0.3);                                         // a cough
  assert.strictEqual(feedMs(s, 2000, 0.001).length, 0);
  assert.strictEqual(s.finish().hasSpeech, false);
});
test('segmenter flags a paragraph after a long pause and reports leftover speech', () => {
  const s = new Segmenter();
  feedMs(s, 1500, 0.2); assert.strictEqual(feedMs(s, 1300, 0.001).length, 1);   // sentence 1
  feedMs(s, 2200, 0.001);                                                          // long gap (total > 2.6 s)
  feedMs(s, 1500, 0.2);
  const cut = feedMs(s, 1300, 0.001);
  assert.strictEqual(cut.length, 1);
  assert.strictEqual(cut[0].paragraph, true);
  // a normal 1.5 s pause between sentences is NOT a paragraph
  feedMs(s, 1500, 0.2); const c2 = feedMs(s, 1500, 0.001); assert.strictEqual(c2[0].paragraph, false);
  feedMs(s, 900, 0.2);
  assert.strictEqual(s.finish().hasSpeech, true);
});

// ---------- hotkey recorder ----------
test('describeKey accepts function/right-side keys and rejects typing keys', () => {
  const keys = { Escape: 1, F9: 67, CtrlRight: 3613, Ctrl: 29, A: 30, Space: 57, 5: 6, ScrollLock: 70 };
  const map = reverseKeyMap(keys);
  assert.deepStrictEqual(describeKey(map, 67), { name: 'F9', label: 'F9' });
  assert.deepStrictEqual(describeKey(map, 3613), { name: 'CtrlRight', label: 'Right Ctrl' });
  assert.deepStrictEqual(describeKey(map, 70), { name: 'ScrollLock', label: 'Scroll Lock' });
  assert.strictEqual(describeKey(map, 30).rejected, true);     // letter
  assert.strictEqual(describeKey(map, 57).rejected, true);     // space
  assert.strictEqual(describeKey(map, 6).rejected, true);      // digit
  assert.strictEqual(describeKey(map, 29).rejected, true);     // left Ctrl
  assert.strictEqual(describeKey(map, 1).cancelled, true);     // Esc cancels
  assert.strictEqual(describeKey(map, 9999).cancelled, true);  // unknown
});

// ---------- text helpers ----------
test('whisper prompt: unchanged by default, primed with a punctuated sample only on request', () => {
  const dict = parseDictionary('NeuralSyntax\nGroq');
  assert.strictEqual(whisperPrompt(dict), 'NeuralSyntax, Groq');
  const p = whisperPrompt(dict, { prime: true });
  assert.ok(p.startsWith('Hello, how are you?') && p.endsWith('NeuralSyntax, Groq.'));
  assert.ok(whisperPrompt(parseDictionary(''), { prime: true }).includes('5 p.m.'));
});
test('markdown apps are recognised for checklists', () => {
  assert.ok(isMarkdownApp({ name: 'Notion.exe' }) && isMarkdownApp({ name: 'obsidian' }) && isMarkdownApp({ name: 'chrome', title: 'Tasks – Notion' }));
  assert.ok(!isMarkdownApp({ name: 'slack' }) && !isMarkdownApp(null));
});

// ---------- cleanup prompt options ----------
test('smart formatting off removes list and paragraph behaviour', () => {
  const p = buildSystemPrompt({ smartFormatting: false });
  assert.ok(p.includes('do not convert anything into lists') && p.includes('Do not add paragraph breaks'));
});
test('checklists use "- [ ]" only in markdown apps; style note and extra examples are included', () => {
  assert.ok(buildSystemPrompt({ markdownApp: true }).includes('"- [ ] " lines'));
  assert.ok(!buildSystemPrompt({ markdownApp: false }).includes('- [ ] Call the bank'));
  assert.ok(buildSystemPrompt({ markdownApp: true }).includes('- [ ] Call the bank'));
  const p = buildSystemPrompt({ styleNote: 'short,   friendly\nno exclamation marks' });
  assert.ok(p.includes('short, friendly no exclamation marks'));
  assert.ok(p.includes('We need 3 tickets for Saturday.'));
  assert.ok(!buildSystemPrompt({}).includes('Personal writing style'));
});

// ---------- STT fallback ----------
test('backup speech engine is used only when the main one fails', async () => {
  const seen = [];
  const ok = async (_p, c) => { seen.push(c.provider); return 'hello'; };
  assert.strictEqual(await transcribeWithFallback(Buffer.alloc(4), { provider: 'groq' }, { provider: 'openai' }, ok), 'hello');
  assert.deepStrictEqual(seen, ['groq']);
  seen.length = 0;
  const flaky = async (_p, c) => { seen.push(c.provider); if (c.provider === 'groq') throw new Error('Rate limit hit'); return 'from backup'; };
  assert.strictEqual(await transcribeWithFallback(Buffer.alloc(4), { provider: 'groq' }, { provider: 'openai' }, flaky), 'from backup');
  assert.deepStrictEqual(seen, ['groq', 'openai']);
  await assert.rejects(() => transcribeWithFallback(Buffer.alloc(4), { provider: 'groq' }, null, flaky), /Rate limit/);
  const dead = async () => { throw new Error('down'); };
  await assert.rejects(() => transcribeWithFallback(Buffer.alloc(4), { provider: 'a' }, { provider: 'b' }, dead), /backup engine also failed/);
});

// ---------- store: privacy + auto-delete ----------
test('privacy mode never stores text but still counts stats', () => {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'nf-')));
  s.update({ privacyMode: true });
  s.addHistory({ text: 'secret words', words: 2, seconds: 1, kind: 'dictation' });
  assert.deepStrictEqual(s.getHistory(), []);
  assert.strictEqual(s.getStats().words, 2);
  s.update({ privacyMode: false });
  s.addHistory({ text: 'kept', words: 1, seconds: 1, kind: 'dictation' });
  assert.strictEqual(s.getHistory().length, 1);
});
test('auto-delete removes old history on load and on new entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-'));
  const s = new Store(dir);
  s.addHistory({ text: 'fresh', words: 1, seconds: 1 });
  const old = { id: 'old', ts: Date.now() - 10 * 864e5, text: 'ancient', words: 1, seconds: 1 };
  s.history.push(old); s._write(s.historyFile, s.history);
  assert.strictEqual(new Store(dir).getHistory().length, 2);           // default: keep
  s.update({ historyAutoDeleteDays: 7 });                              // takes effect immediately...
  assert.deepStrictEqual(s.getHistory().map((h) => h.text), ['fresh']);
  assert.deepStrictEqual(new Store(dir).getHistory().map((h) => h.text), ['fresh']); // ...and persists
  assert.strictEqual(DEFAULTS.sttFallback, '');
});

// ---------- pipeline: new options + paragraph ----------
function harness(over = {}) {
  const calls = { pasted: [], clean: [], logs: [], last: over.last || null };
  const ctx = {
    settings: Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), over.settings || {}),
    canClean: true, meta: over.meta,
    ui: { state() {} },
    transcribe: async (_b, x) => { calls.prompt = x.prompt; return 'hello there my friend'; },
    cleanText: async (t, o) => { calls.clean.push(o); return { text: t, cleaned: true }; },
    getApp: async () => over.app ?? { name: 'Notion.exe', title: '' },
    getLast: () => calls.last, setLast: (l) => { calls.last = l; },
    log: (m) => calls.logs.push(m),
    actions: { paste: async (t) => { calls.pasted.push(t); return { pasted: true }; } },
    addHistory() {},
  };
  return { ctx, calls };
}
const pcm = () => { const b = Buffer.alloc(32000); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 4 ? 3000 : -3000, i); return b; };

test('pipeline passes formatting options, app awareness and the English prompt hint to the AI', async () => {
  const { ctx, calls } = harness({ settings: { language: 'en', writingStyle: 'friendly', smartFormatting: false } });
  await processAudio(pcm(), ctx);
  assert.deepStrictEqual([calls.clean[0].smartFormatting, calls.clean[0].markdownApp, calls.clean[0].styleNote], [false, true, 'friendly']);
  assert.ok(calls.prompt.startsWith('Hello, how are you?'));
  const auto = harness({ settings: { language: '' } });
  await processAudio(pcm(), auto.ctx);
  assert.strictEqual(auto.calls.prompt, '');                       // no English bias for auto-detect / Hinglish
});
test('a long pause between hands-free sentences becomes a paragraph break; short pauses just get a space', async () => {
  const last = { text: 'First sentence.', app: 'Notion.exe', ts: Date.now() - 4000 };
  const a = harness({ last, meta: { segment: true, paragraph: true } });
  await processAudio(pcm(), a.ctx);
  assert.strictEqual(a.calls.pasted[0], '\n\nhello there my friend');
  const b = harness({ last, meta: { segment: true, paragraph: false } });
  await processAudio(pcm(), b.ctx);
  assert.strictEqual(b.calls.pasted[0], ' hello there my friend');
});
test('privacy mode keeps the transcript out of the logs', async () => {
  const { ctx, calls } = harness({ settings: { privacyMode: true } });
  await processAudio(pcm(), ctx);
  assert.ok(calls.logs.every((l) => !l.includes('hello there')));
});
