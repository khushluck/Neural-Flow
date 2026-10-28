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
// A punctuated example sentence in the prompt nudges Whisper to punctuate its output (English only; it can bias other languages).
const PRIME = 'Hello, how are you? I’m doing well, thanks. Let’s meet at 5 p.m. tomorrow.';
function whisperPrompt(dict, { prime = false } = {}) {
  let p = '';
  for (const w of dict.words) { if ((p + w).length > 400) break; p += (p ? ', ' : '') + w; }
  if (!prime) return p;
  return PRIME + (p ? ' ' + p + '.' : '');
}

// Apps where "- [ ]" checklists and markdown lists render nicely.
function isMarkdownApp(app) {
  if (!app) return false;
  const name = String(app.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const title = String(app.title || '').toLowerCase();
  return /^(notion|obsidian|logseq|typora|joplin|marktext|zettlr|bear)/.test(name) || title.includes('notion') || title.includes('obsidian');
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

// ---------- learn from edits (auto dictionary) ----------
const stripP = (w) => String(w).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
const keyOf = (w) => stripP(w).toLowerCase();
function lev(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
const hasInnerCaps = (s) => /\p{Lu}/u.test(s.slice(1));

// Compare the text Neural Flow produced with what the user corrected it to; return [[heard, right], ...]
// for fixes that look like names/terms/typos (not grammar rewrites), so they can be added to the dictionary.
function learnFromEdit(original, edited, maxSpan = 3) {
  const A = String(original || '').trim().split(/\s+/).filter(Boolean);
  const B = String(edited || '').trim().split(/\s+/).filter(Boolean);
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = stripP(A[i]) === stripP(B[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs = [];
  let i = 0, j = 0, ha = [], hb = [];
  const flush = () => {
    if (ha.length && hb.length && ha.length <= maxSpan && hb.length <= maxSpan) {
      const heard = ha.map(stripP).join(' ').trim(), right = hb.map(stripP).join(' ').trim();
      if (heard && right && heard.toLowerCase() === right.toLowerCase()) {
        // case-only fix such as github -> GitHub (plain capitalisation like hello -> Hello is not a term)
        if (ha.length === 1 && hb.length === 1 && heard.length >= 2 && hasInnerCaps(right)) pairs.push([heard.toLowerCase(), right]);
      } else if (heard && right) {
        const typo = ha.length === 1 && hb.length === 1 && heard.length >= 3 && lev(heard.toLowerCase(), right.toLowerCase()) <= Math.max(2, Math.ceil(heard.length * 0.4));
        if (hasInnerCaps(right) || /^\p{Lu}/u.test(right) && /\s/.test(right) || typo) pairs.push([heard.toLowerCase(), right]);
      }
    }
    ha = []; hb = [];
  };
  while (i < n && j < m) {
    if (stripP(A[i]) === stripP(B[j])) { flush(); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) ha.push(A[i++]);
    else hb.push(B[j++]);
  }
  while (i < n) ha.push(A[i++]);
  while (j < m) hb.push(B[j++]);
  flush();
  const seen = new Set();
  return pairs.filter(([h, r]) => { const k = h + '=>' + r; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Append "heard => Right" lines to a dictionary string, skipping ones already there.
function mergeDictionary(existing, pairs) {
  const have = new Set(lines(existing).map((l) => l.toLowerCase().replace(/\s+/g, ' ')));
  const add = pairs.map(([h, r]) => `${h} => ${r}`).filter((l) => !have.has(l.toLowerCase()));
  const base = String(existing || '').replace(/\s+$/, '');
  return add.length ? (base ? base + '\n' : '') + add.join('\n') : String(existing || '');
}
module.exports.isMarkdownApp = isMarkdownApp;
module.exports.learnFromEdit = learnFromEdit;
module.exports.mergeDictionary = mergeDictionary;
