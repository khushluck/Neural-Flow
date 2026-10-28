'use strict';
// The whole "audio -> text in your app" flow, with every side effect injected so it can be tested.
const T = require('./text');

function audioStats(buf) {
  let peak = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) { const v = Math.abs(buf.readInt16LE(i)); if (v > peak) peak = v; }
  return { peak, seconds: buf.length / 32000 };
}

// Quiet speech (whispering, far from the mic) is boosted before transcription so Whisper can hear it.
function normalizeAudio(buf, { target = 14000, maxGain = 12, minPeak = 100 } = {}) {
  const { peak } = audioStats(buf);
  if (peak < minPeak || peak >= target * 0.8) return { buf, gain: 1, peak };
  const gain = Math.min(maxGain, target / peak);
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i + 1 < buf.length; i += 2) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(buf.readInt16LE(i) * gain))), i);
  }
  return { buf: out, gain, peak };
}

const COMMAND_LABEL = { undo: 'Deleted', enter: 'Enter', selectAll: 'Selected all' };
const SPACING_WINDOW_MS = 20000;   // consecutive dictations within this window get a space between them
const CONTEXT_WINDOW_MS = 120000;  // ...and the previous text is given to the AI as context for this long

async function processAudio(buf, ctx) {
  const t0 = Date.now();
  const s = ctx.settings, ui = ctx.ui, meta = ctx.meta || {};
  ui.state('processing', 'Transcribing');

  const { peak, seconds } = audioStats(buf);
  const quiet = !!s.privacyMode; // privacy mode: nothing about what you said is logged
  ctx.log?.(`[audio] ${seconds.toFixed(1)}s peak=${peak}`);
  if (peak < 100 || seconds < 0.3) { ui.state('toast', 'Didn’t hear anything'); return { status: 'silent' }; }
  const audio = s.autoGain ? normalizeAudio(buf).buf : buf;

  const dict = T.parseDictionary(s.dictionary);
  let raw = ((await ctx.transcribe(audio, { prompt: T.whisperPrompt(dict, { prime: s.punctuationHint !== false && s.language === 'en' }) })) || '').trim();
  if (!raw) { ui.state('toast', 'No speech detected'); return { status: 'empty' }; }
  raw = T.applyReplacements(raw, dict.map);
  ctx.log?.(quiet ? '[stt] (hidden by privacy mode)' : `[stt] "${raw}"`);

  const app = await ctx.getApp().catch(() => null);
  const last = ctx.getLast?.() || null;
  const sameApp = !!(last && app && last.app === app.name);
  const translateTo = String(s.translateTo || '').trim();

  let final, kind = 'dictation', cleaned = false;
  const snippet = T.matchSnippet(raw, T.parseSnippets(s.snippets));
  if (snippet != null) { final = snippet; kind = 'snippet'; }
  else {
    if (s.voiceCommands) {
      const cmd = T.parseCommand(raw);
      if (cmd) { await ctx.actions[cmd](); ui.state('toast', COMMAND_LABEL[cmd]); return { status: 'command', command: cmd }; }
    }
    final = s.voiceCommands ? T.applyInlineCommands(raw) : raw;
    const wantsClean = ctx.canClean && ((s.cleanup.enabled && T.countWords(final) >= s.cleanup.minWords) || translateTo);
    if (translateTo && !ctx.canClean) ui.state('toast', 'Translation needs a Groq or OpenAI key');
    if (wantsClean) {
      ui.state('processing', translateTo ? 'Translating' : 'Polishing');
      try {
        const r = await ctx.cleanText(final, {
          tone: T.toneForApp(app, s.appRules, s.tone), dictWords: dict.words, hinglishRoman: s.cleanup.hinglishRoman,
          level: s.cleanup.level, translateTo, smartFormatting: s.smartFormatting !== false, markdownApp: T.isMarkdownApp(app), styleNote: s.writingStyle,
          previous: sameApp && Date.now() - last.ts < CONTEXT_WINDOW_MS ? last.text : '',
        });
        final = r.text; cleaned = r.cleaned;
      } catch (e) { ctx.log?.(`[cleanup] skipped: ${e.message}`); } // fall back to the raw transcript
    }
  }
  if (!final) { ui.state('idle'); return { status: 'empty' }; }

  // Smart spacing: a second dictation right after the first in the same app starts with a space.
  let toPaste = final;
  if (s.smartSpacing && sameApp && Date.now() - last.ts < SPACING_WINDOW_MS && !/\s$/.test(last.text) && !/^[\s.,;:!?)\]}]/.test(final)) toPaste = ' ' + final;

  // Hands-free segments: a long pause between sentences becomes a paragraph break (when enabled).
  if (meta.paragraph && sameApp && !/\n\s*$/.test(last.text) && !/^\s/.test(final)) toPaste = '\n\n' + final;

  const res = await ctx.actions.paste(toPaste);
  if (res.pasted) ctx.setLast?.({ text: final, app: app?.name || '', ts: Date.now() });
  ctx.addHistory({ text: final, raw, app: app?.name || '', ms: Date.now() - t0, kind, cleaned, words: T.countWords(final), seconds: Math.round(seconds * 10) / 10 });
  const n = T.countWords(final);
  ui.state(res.pasted ? 'success' : 'toast', res.pasted ? (n > 1 ? `Pasted · ${n} words` : 'Pasted') : `Copied — press ${ctx.pasteHint || 'Ctrl+V'}`);
  return { status: res.pasted ? 'pasted' : 'copied', text: final, cleaned };
}

// Command Mode: the user selected text, then spoke an instruction ("make this shorter").
async function processCommand(buf, ctx) {
  const t0 = Date.now();
  const s = ctx.settings, ui = ctx.ui;
  ui.state('processing', 'Reading selection');
  const { peak, seconds } = audioStats(buf);
  if (peak < 100 || seconds < 0.3) { ui.state('toast', 'Didn’t hear an instruction'); return { status: 'silent' }; }
  if (!ctx.canClean) { ui.state('toast', 'Command Mode needs a Groq or OpenAI key'); return { status: 'nokey' }; }

  const dict = T.parseDictionary(s.dictionary);
  const [selection, heard] = await Promise.all([
    Promise.resolve(ctx.getSelection()).catch(() => ''),
    ctx.transcribe(s.autoGain ? normalizeAudio(buf).buf : buf, { prompt: '' }),
  ]);
  const instruction = String(heard || '').trim();
  if (!String(selection || '').trim()) { ui.state('toast', 'Select some text first, then hold the Command key'); return { status: 'noselection' }; }
  if (!instruction) { ui.state('toast', 'No instruction heard'); return { status: 'empty' }; }

  ui.state('processing', 'Editing');
  const out = await ctx.rewriteText(selection, instruction, { dictWords: dict.words });
  const res = await ctx.actions.paste(out.text);    // the selection is still active, so this replaces it
  ctx.addHistory({ text: out.text, raw: instruction, original: selection, app: '', ms: Date.now() - t0, kind: 'command', cleaned: true, words: T.countWords(out.text), seconds: Math.round(seconds * 10) / 10 });
  ui.state(res.pasted ? 'success' : 'toast', res.pasted ? 'Edit applied' : `Copied — press ${ctx.pasteHint || 'Ctrl+V'}`);
  return { status: res.pasted ? 'pasted' : 'copied', text: out.text, instruction };
}

module.exports = { processAudio, processCommand, audioStats, normalizeAudio };
