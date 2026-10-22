'use strict';
// The whole "audio -> text in your app" flow, with every side effect injected so it can be tested.
const T = require('./text');

function audioStats(buf) {
  let peak = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) { const v = Math.abs(buf.readInt16LE(i)); if (v > peak) peak = v; }
  return { peak, seconds: buf.length / 32000 };
}

const COMMAND_LABEL = { undo: 'Deleted', enter: 'Enter', selectAll: 'Selected all' };

async function processAudio(buf, ctx) {
  const t0 = Date.now();
  const s = ctx.settings, ui = ctx.ui;
  ui.state('processing');

  const { peak, seconds } = audioStats(buf);
  ctx.log?.(`[audio] ${seconds.toFixed(1)}s peak=${peak}`);
  if (peak < 150 || seconds < 0.3) { ui.state('toast', 'Didn’t hear anything'); return { status: 'silent' }; }

  const dict = T.parseDictionary(s.dictionary);
  let raw = ((await ctx.transcribe(buf, { prompt: T.whisperPrompt(dict) })) || '').trim();
  if (!raw) { ui.state('toast', 'No speech detected'); return { status: 'empty' }; }
  raw = T.applyReplacements(raw, dict.map);
  ctx.log?.(`[stt] "${raw}"`);

  let final, kind = 'dictation', cleaned = false, app = null;
  const snippet = T.matchSnippet(raw, T.parseSnippets(s.snippets));
  if (snippet != null) { final = snippet; kind = 'snippet'; }
  else {
    if (s.voiceCommands) {
      const cmd = T.parseCommand(raw);
      if (cmd) { await ctx.actions[cmd](); ui.state('toast', COMMAND_LABEL[cmd]); return { status: 'command', command: cmd }; }
    }
    final = s.voiceCommands ? T.applyInlineCommands(raw) : raw;
    app = await ctx.getApp().catch(() => null);
    if (s.cleanup.enabled && ctx.canClean && T.countWords(final) >= s.cleanup.minWords) {
      try {
        const r = await ctx.cleanText(final, { tone: T.toneForApp(app, s.appRules, s.tone), dictWords: dict.words, hinglishRoman: s.cleanup.hinglishRoman });
        final = r.text; cleaned = r.cleaned;
      } catch (e) { ctx.log?.(`[cleanup] skipped: ${e.message}`); } // fall back to the raw transcript
    }
  }
  if (!final) { ui.state('idle'); return { status: 'empty' }; }

  const res = await ctx.actions.paste(final);
  ctx.addHistory({ text: final, raw, app: app?.name || '', ms: Date.now() - t0, kind, cleaned });
  ui.state(res.pasted ? 'idle' : 'toast', res.pasted ? '' : `Copied — press ${ctx.pasteHint || 'Ctrl+V'}`);
  return { status: res.pasted ? 'pasted' : 'copied', text: final, cleaned };
}

module.exports = { processAudio, audioStats };
