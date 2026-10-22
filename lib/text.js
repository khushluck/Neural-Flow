'use strict';
// Pure text helpers: dictionary, snippets, voice commands, per-app tone.

const normalize = (s) => String(s || '').toLowerCase()
  .replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();

const countWords = (s) => (String(s).trim() ? String(s).trim().split(/\s+/).length : 0);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lines = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

// Dictionary lines: "Word"  or  "heard => Right".
function parseDictionary(str) {
  const words = [], map = [];
  for (const l of lines(str)) {
    const i = l.indexOf('=>');
    if (i > 0) {
      const heard = l.slice(0, i).trim(), right = l.slice(i + 2).trim();
      if (heard && right) { map.push([heard, right]); words.push(right); }
    } else words.push(l);
  }
  return { words: [...new Set(words)], map };
}

function applyReplacements(text, map) {
  let out = text;
  for (const [heard, right] of map) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(heard)}(?![\\p{L}\\p{N}])`, 'giu');
    out = out.replace(re, () => right);
  }
  return out;
}

// Hint for Whisper's `prompt` parameter (keeps spellings of names/terms).
function whisperPrompt(dict) {
  if (!dict.words.length) return '';
  let p = '';
  for (const w of dict.words) { if ((p + w).length > 400) break; p += (p ? ', ' : '') + w; }
  return p;
}

// Snippet lines: "trigger => expansion text" (use \n for a line break).
function parseSnippets(str) {
  const out = [];
  for (const l of lines(str)) {
    const i = l.indexOf('=>');
    if (i <= 0) continue;
    const trigger = normalize(l.slice(0, i));
    const text = l.slice(i + 2).trim().replace(/\\n/g, '\n');
    if (trigger && text) out.push({ trigger, text });
  }
  return out;
}

// Whole-utterance match only (optionally "insert <trigger>") so normal sentences are never hijacked.
function matchSnippet(raw, snippets) {
  const n = normalize(raw).replace(/^(insert|paste|type) /, '');
  const hit = snippets.find((s) => s.trigger === normalize(raw) || s.trigger === n);
  return hit ? hit.text : null;
}

const COMMANDS = {
  undo: ['delete that', 'scratch that', 'undo that', 'undo', 'delete last'],
  enter: ['press enter', 'hit enter', 'new line'],
  selectAll: ['select all'],
};
function parseCommand(raw) {
  const n = normalize(raw);
  for (const [action, phrases] of Object.entries(COMMANDS)) if (phrases.includes(n)) return action;
  return null;
}

const SP = '\\s*[,.]?\\s*';
const INLINE = [
  [new RegExp(`${SP}\\bnew paragraph\\b[,.]?\\s*`, 'gi'), '\n\n'],
  [new RegExp(`${SP}\\bnew line\\b[,.]?\\s*`, 'gi'), '\n'],
  [new RegExp(`${SP}\\bfull stop\\b[,.]?\\s*`, 'gi'), '. '],
  [new RegExp(`${SP}\\bquestion mark\\b[,.]?\\s*`, 'gi'), '? '],
  [new RegExp(`${SP}\\bexclamation (?:mark|point)\\b[,.]?\\s*`, 'gi'), '! '],
  [new RegExp(`${SP}\\bcomma\\b[,.]?\\s*`, 'gi'), ', '],
];
function applyInlineCommands(text) {
  let out = text;
  for (const [re, rep] of INLINE) out = out.replace(re, rep);
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/^[ \t]+|[ \t]+$/g, '');
}

// Rules: "pattern=tone" (matched against app/process name words) or "title:text=tone".
function toneForApp(app, rulesStr, fallback = 'neutral') {
  if (!app) return fallback;
  const name = String(app.name || '').toLowerCase();
  const compact = name.replace(/[^a-z0-9]/g, '');
  const words = name.split(/[^a-z0-9]+/).filter(Boolean);
  const title = String(app.title || '').toLowerCase();
  for (const l of lines(rulesStr)) {
    const eq = l.lastIndexOf('=');
    if (eq < 1) continue;
    let pat = l.slice(0, eq).trim().toLowerCase();
    const tone = l.slice(eq + 1).trim().toLowerCase();
    if (pat.startsWith('title:')) { if (title.includes(pat.slice(6).trim())) return tone; continue; }
    if (compact === pat || words.includes(pat) || compact.startsWith(pat)) return tone;
  }
  return fallback;
}

module.exports = {
  normalize, countWords, parseDictionary, applyReplacements, whisperPrompt,
  parseSnippets, matchSnippet, parseCommand, applyInlineCommands, toneForApp,
};
