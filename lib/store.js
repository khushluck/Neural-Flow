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
].join('\n');

const DEFAULTS = {
  provider: 'groq',            // groq | openai | nvidia | local
  language: '',                // Whisper language hint: '' = auto-detect, 'en', 'hi', ...
  hotkey: process.platform === 'darwin' ? 'AltRight' : 'CtrlRight',
  doubleTapLock: true,         // double-tap the hotkey for hands-free mode
  voiceCommands: true,
  keepInClipboard: false,      // false = restore your previous clipboard after pasting
  launchAtLogin: false,
  keys: { groq: '', openai: '', nvidia: '' },
  sttModel: '',                // blank = provider default
  nvidia: { functionId: '', lang: 'en-US' },
  local: { binary: '', model: '', threads: 4 },
  cleanup: { enabled: true, model: 'llama-3.1-8b-instant', minWords: 4, hinglishRoman: false },
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
    fs.mkdirSync(dir, { recursive: true });
    this.isFirstRun = !fs.existsSync(this.settingsFile);
    this.settings = this._load();
    this.history = this._read(this.historyFile, []);
    if (!Array.isArray(this.history)) this.history = [];
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
    return this.settings;
  }

  // Key from settings, falling back to .env / environment (handy for development).
  effectiveKey(name) { return this.settings.keys[name] || process.env[ENV_KEYS[name]] || ''; }
  effectiveNvidiaFunctionId() { return this.settings.nvidia.functionId || process.env.NVIDIA_ASR_FUNCTION_ID || ''; }

  addHistory(entry) {
    const e = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), ...entry };
    this.history.unshift(e);
    this.history = this.history.slice(0, Math.max(1, this.settings.historyLimit));
    this._write(this.historyFile, this.history);
    return e;
  }
  getHistory() { return this.history; }
  deleteHistory(id) { this.history = this.history.filter((h) => h.id !== id); this._write(this.historyFile, this.history); }
  clearHistory() { this.history = []; this._write(this.historyFile, this.history); }
}

module.exports = { Store, DEFAULTS, MASK };
