'use strict';
// Speech-to-text providers: groq / openai (OpenAI-compatible Whisper), nvidia (Riva gRPC), local (whisper.cpp).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const BASES = { groq: 'https://api.groq.com/openai/v1', openai: 'https://api.openai.com/v1' };
const MODELS = { groq: 'whisper-large-v3-turbo', openai: 'gpt-4o-mini-transcribe' };

function noKey(msg = 'Add your API key in Settings') { const e = new Error(msg); e.code = 'NOKEY'; return e; }

function pcmToWav(pcm) { // raw 16 kHz mono int16 -> WAV
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function openaiCompat(pcm, c) {
  if (!c.apiKey) throw noKey();
  const form = new FormData();
  form.append('file', new Blob([pcmToWav(pcm)], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', c.model || MODELS[c.provider]);
  form.append('temperature', '0');
  if (c.language && /^[a-z]{2,3}$/i.test(c.language)) form.append('language', c.language.toLowerCase());
  if (c.prompt) form.append('prompt', c.prompt);
  const r = await fetch(`${BASES[c.provider]}/audio/transcriptions`, {
    method: 'POST', headers: { Authorization: `Bearer ${c.apiKey}` }, body: form,
    signal: AbortSignal.timeout(30000),
  });
  if (r.status === 401 || r.status === 403) throw noKey('Invalid API key — check Settings');
  if (r.status === 429) throw new Error('Rate limit hit — wait a few seconds');
  if (!r.ok) throw new Error(`STT ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return ((await r.json()).text || '').trim();
}

function localWhisper(pcm, c) {
  const { binary, model, threads } = c.local || {};
  if (!binary || !model) throw noKey('Set the whisper.cpp paths in Settings → Offline');
  const wav = path.join(os.tmpdir(), `nf-${Date.now()}.wav`);
  fs.writeFileSync(wav, pcmToWav(pcm));
  const args = ['-m', model, '-f', wav, '-nt', '-np', '-t', String(threads || 4), '-l', c.language || 'auto'];
  if (c.prompt) args.push('--prompt', c.prompt);
  return new Promise((resolve, reject) => {
    execFile(binary, args, { windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      fs.unlink(wav, () => {});
      if (err) return reject(new Error(`whisper.cpp failed: ${String(err.message).slice(0, 100)}`));
      resolve(stdout.replace(/\[[A-Z_ ]+\]|\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim());
    });
  });
}

async function transcribe(pcm, c) {
  if (c.provider === 'nvidia') {
    if (!c.nvidia?.apiKey || !c.nvidia?.functionId) throw noKey('Add NVIDIA key + function ID in Settings');
    return require('../nvidia-asr').recognize(pcm, { apiKey: c.nvidia.apiKey, functionId: c.nvidia.functionId, language: c.nvidia.lang || 'en-US' });
  }
  if (c.provider === 'local') return localWhisper(pcm, c);
  return openaiCompat(pcm, c);
}

// Try the main engine; if it fails (rate limit, outage, bad key), quietly retry on a backup engine.
async function transcribeWithFallback(pcm, primary, fallback, impl = transcribe) {
  try { return await impl(pcm, primary); }
  catch (e) {
    if (!fallback) throw e;
    try { return await impl(pcm, fallback); }
    catch (e2) { throw new Error(`${e.message} (backup engine also failed: ${e2.message})`.slice(0, 160)); }
  }
}

module.exports = { transcribe, transcribeWithFallback, pcmToWav, BASES };
