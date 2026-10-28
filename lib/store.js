'use strict';
// Settings + history persisted as JSON in the app's userData folder.
// API keys are encrypted at rest when an OS-level encryptor is provided (Electron safeStorage).
const fs = require('fs');
const path = require('path');

const DEFAULT_RULES = [
  '# pattern=tone  (matches the app/process name; use title:text to match the window title)',
  'slack=casual', 'discord=casual', 'whatsapp=casual', 'telegram=casual', 'teams=casual',
  'title:whatsapp=casual', 'title:discord=casual', 'title:slack=casual',
  'outlook=formal', 'thunderbird=formal', 'title:gmail=formal', 'title:outlook=formal', 'title:linkedin=formal',
  'code=code', 'cursor=code', 'windsurf=code', 'devenv=code', 'idea64=code', 'pycharm64=code',
  'windowsterminal=code', 'powershell=code', 'cmd=code', 'terminal=code',
  'signal=casual', 'title:messenger=casual', 'title:instagram=casual', 'title:reddit=casual', 'winword=formal', 'title:docs.google=formal',
].join('\n');

const DEFAULTS = {
  provider: 'groq',            // groq | openai | nvidia | local
  language: '',                // Whisper language hint: '' = auto-detect, 'en', 'hi', ...
  hotkey: process.platform === 'darwin' ? 'AltRight' : 'CtrlRight',
  doubleTapLock: true,         // double-tap the hotkey for hands-free mode
  voiceCommands: true,
  commandMode: true,           // select text, hold the command key, speak an instruction
  commandHotkey: 'F9',         // '' disables
  smartSpacing: true,          // space between back-to-back dictations in the same app
  autoGain: true,              // boost quiet speech / whispering before transcription
  translateTo: '',             // '' = off; e.g. 'English' translates everything you say
  autoUpdate: true,
  overlayHideIdle: false,      // hide the little idle pill; it still appears while you dictate
  overlayPosition: 'bottom',   // 'bottom' | 'top'
  soundCues: false,            // soft start / stop / done sounds
  smartFormatting: true,       // lists, checklists, paragraphs and numbers (off = plain running text)
  writingStyle: '',            // free text: "short sentences, friendly, no exclamation marks…"
  punctuationHint: true,       // prime Whisper with a punctuated sample (only used when language = English)
  liveSegments: true,          // hands-free: paste sentence by sentence at each pause
  pauseParagraphs: false,      // hands-free: a long pause starts a new paragraph
  micWarm: false,              // keep the mic open for an instant start + 0.4 s pre-roll (mic indicator stays on)
  sttFallback: '',             // '' | 'openai' | 'local': backup speech engine if the main one fails
  privacyMode: false,          // never save dictation text to History
  historyAutoDeleteDays: 0,    // 0 = keep (up to the history limit)
  keepInClipboard: false,      // false = restore your previous clipboard after pasting
  launchAtLogin: false,
  keys: { groq: '', openai: '', nvidia: '' },
  sttModel: '',                // blank = provider default
  nvidia: { functionId: '', lang: 'en-US' },
  local: { binary: '', model: '', threads: 4 },
  cleanup: { enabled: true, model: 'llama-3.1-8b-instant', minWords: 2, hinglishRoman: false, level: 'standard' }, // level: light | standard | polished
  tone: 'neutral',             // neutral | casual | formal | code
  appRules: DEFAULT_RULES,
  dictionary: '',
  snippets: '',
  historyLimit: 50,
};

const ENV_KEYS = { groq: 'GROQ_API_KEY', openai: 'OPENAI_API_KEY', nvidia: 'NVIDIA_API_KEY' };
const MASK = '••••';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

// Merge only keys that exist in `base`, coercing to the base value's type.
function deepMerge(base, patch) {
  if (!isObj(patch)) return base;
  for (const k of Object.keys(base)) {
    if (!(k in patch) || patch[k] === undefined) continue;
    if (isObj(base[k])) deepMerge(base[k], patch[k]);
    else if (typeof base[k] === 'number') { const n = Number(patch[k]); if (Number.isFinite(n)) base[k] = n; }
    else if (typeof base[k] === 'boolean') base[k] = !!patch[k];
    else base[k] = String(patch[k] ?? '');
  }
  return base;
}

class Store {
  constructor(dir, crypto) {
    this.dir = dir;
    this.crypto = crypto || null; // { enc(str)->str, dec(str)->str }
    this.settingsFile = path.join(dir, 'settings.json');
    this.historyFile = path.join(dir, 'history.json');
    this.statsFile = path.join(dir, 'stats.json');
    fs.mkdirSync(dir, { recursive: true });
    this.isFirstRun = !fs.existsSync(this.settingsFile);
    this.settings = this._load();
    this.history = this._read(this.historyFile, []);
    if (!Array.isArray(this.history)) this.history = [];
    this.stats = Object.assign({ words: 0, seconds: 0, count: 0, since: Date.now() }, this._read(this.statsFile, {}));
    this._prune();
  }

  // Drop history older than the auto-delete setting.
  _prune() {
    const days = Number(this.settings.historyAutoDeleteDays) || 0;
    if (days <= 0) return false;
    const cutoff = Date.now() - days * 864e5, kept = this.history.filter((h) => (h.ts || 0) >= cutoff);
    if (kept.length === this.history.length) return false;
    this.history = kept;
    try { this._write(this.historyFile, this.history); } catch { /* best effort */ }
    return true;
  }

  _read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }

  _write(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  _load() {
    const s = deepMerge(clone(DEFAULTS), this._read(this.settingsFile, {}));
    for (const name of Object.keys(s.keys)) {
      const raw = this._read(this.settingsFile, {}).keys?.[name];
      if (typeof raw === 'string' && raw.startsWith('enc:')) {
        try { s.keys[name] = this.crypto ? this.crypto.dec(raw.slice(4)) : ''; } catch { s.keys[name] = ''; }
      }
    }
    return s;
  }

  _save() {
    const out = clone(this.settings);
    for (const name of Object.keys(out.keys)) {
      if (out.keys[name] && this.crypto) {
        try { out.keys[name] = 'enc:' + this.crypto.enc(out.keys[name]); } catch { /* keep plain */ }
      }
    }
    this._write(this.settingsFile, out);
  }

  get() { return this.settings; }

  // Same as get() but API keys are masked so they never travel to the settings window.
  getForUI() {
    const s = clone(this.settings);
    for (const n of Object.keys(s.keys)) s.keys[n] = s.keys[n] ? MASK + s.keys[n].slice(-4) : '';
    // Where each key comes from: 'saved' (encrypted in Settings), 'env' (a .env / environment variable, dev only), or ''.
    s.keyStatus = {};
    for (const n of Object.keys(ENV_KEYS)) s.keyStatus[n] = this.settings.keys[n] ? 'saved' : (process.env[ENV_KEYS[n]] ? 'env' : '');
    return s;
  }

  update(patch) {
    const p = clone(patch || {});
    if (isObj(p.keys)) for (const n of Object.keys(p.keys)) {
      if (typeof p.keys[n] === 'string' && p.keys[n].startsWith(MASK)) delete p.keys[n]; // unchanged
      else if (typeof p.keys[n] === 'string') p.keys[n] = p.keys[n].trim();
    }
    deepMerge(this.settings, p);
    this._save();
    this._prune(); // e.g. the auto-delete setting just changed
    return this.settings;
  }

  // Key from settings, falling back to .env / environment (handy for development).
  effectiveKey(name) { return this.settings.keys[name] || process.env[ENV_KEYS[name]] || ''; }
  effectiveNvidiaFunctionId() { return this.settings.nvidia.functionId || process.env.NVIDIA_ASR_FUNCTION_ID || ''; }

  addHistory(entry) {
    const e = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), ...entry };
    if (this.settings.privacyMode) { if (e.kind !== 'command' || e.words) this._bumpStats(e); return e; } // counts only, never the text
    this.history.unshift(e);
    this._prune();
    this.history = this.history.slice(0, Math.max(1, this.settings.historyLimit));
    this._write(this.historyFile, this.history);
    if (e.kind !== 'command' || e.words) this._bumpStats(e);
    return e;
  }

  _bumpStats(e) {
    this.stats.words += Number(e.words) || 0;
    this.stats.seconds += Number(e.seconds) || 0;
    this.stats.count += 1;
    try { this._write(this.statsFile, this.stats); } catch { /* stats are best-effort */ }
  }

  // Lifetime totals. "Time saved" compares speaking time with typing the same words at 40 wpm.
  getStats() {
    const { words, seconds, count, since } = this.stats;
    const savedMinutes = Math.max(0, Math.round(words / 40 - seconds / 60));
    return { words, seconds: Math.round(seconds), count, since, savedMinutes };
  }
  updateHistory(id, patch) {
    const h = this.history.find((x) => x.id === id);
    if (!h) return null;
    Object.assign(h, patch);
    this._write(this.historyFile, this.history);
    return h;
  }
  getHistory() { return this.history; }
  deleteHistory(id) { this.history = this.history.filter((h) => h.id !== id); this._write(this.historyFile, this.history); }
  clearHistory() { this.history = []; this._write(this.historyFile, this.history); }
}

module.exports = { Store, DEFAULTS, MASK };
