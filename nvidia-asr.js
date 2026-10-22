// NVIDIA hosted Riva ASR (build.nvidia.com) over gRPC. Input: raw 16 kHz mono int16 PCM.
// Streaming-only models (e.g. nemotron-asr-streaming) reject offline Recognize with INVALID_ARGUMENT,
// so we try StreamingRecognize first and fall back to offline Recognize for offline-only models.
const path = require('path');
const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');

const PROTO_ROOT = path.join(__dirname, 'proto');
const def = loader.loadSync(path.join(PROTO_ROOT, 'riva/proto/riva_asr.proto'), {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true, includeDirs: [PROTO_ROOT],
});
const { RivaSpeechRecognition } = grpc.loadPackageDefinition(def).nvidia.riva.asr;
const CODE = Object.fromEntries(Object.entries(grpc.status).map(([k, v]) => [v, k]));

const fmt = (e) => Object.assign(new Error(`NVIDIA ASR ${CODE[e.code] || e.code}: ${e.details || e.message || 'no details'}`), { code: e.code });

function makeClient({ apiKey, functionId, target, insecure }) {
  const creds = insecure
    ? grpc.credentials.createInsecure()
    : grpc.credentials.combineChannelCredentials(
        grpc.credentials.createSsl(),
        grpc.credentials.createFromMetadataGenerator((_p, cb) => {
          const md = new grpc.Metadata();
          md.set('authorization', `Bearer ${apiKey}`);
          md.set('function-id', functionId);
          cb(null, md);
        }));
  return new RivaSpeechRecognition(target, creds);
}

const baseConfig = (language) => ({
  encoding: 'LINEAR_PCM', sample_rate_hertz: 16000, language_code: language,
  max_alternatives: 1, audio_channel_count: 1, enable_automatic_punctuation: true,
});

function streaming(pcm, o) {
  return new Promise((resolve, reject) => {
    const client = makeClient(o);
    const call = client.StreamingRecognize({ deadline: Date.now() + 30000 });
    const parts = [];
    let failed = false;
    call.on('data', (res) => {
      for (const r of res.results || []) if (r.is_final) parts.push(r.alternatives?.[0]?.transcript || '');
    });
    call.on('error', (e) => { failed = true; client.close(); reject(fmt(e)); });
    call.on('end', () => { if (!failed) { client.close(); resolve(parts.join(' ').replace(/\s+/g, ' ').trim()); } });
    call.write({ streaming_config: { config: baseConfig(o.language), interim_results: false } });
    const tail = Buffer.alloc(16000); // 0.5 s of silence so the model finalizes the last words
    const audio = Buffer.concat([pcm, tail]);
    for (let i = 0; i < audio.length; i += 3200) call.write({ audio_content: audio.subarray(i, i + 3200) });
    call.end();
  });
}

function offline(pcm, o) {
  return new Promise((resolve, reject) => {
    const client = makeClient(o);
    client.Recognize({ config: baseConfig(o.language), audio: pcm }, { deadline: Date.now() + 30000 }, (err, res) => {
      client.close();
      if (err) return reject(fmt(err));
      resolve((res.results || []).map((r) => r.alternatives?.[0]?.transcript || '').join(' ').trim());
    });
  });
}

async function recognize(pcm, opts) {
  const o = { language: 'en-US', target: 'grpc.nvcf.nvidia.com:443', insecure: false, ...opts };
  const mode = (process.env.NVIDIA_ASR_MODE || 'auto').toLowerCase(); // auto | streaming | offline
  if (mode === 'offline') return offline(pcm, o);
  if (mode === 'streaming') return streaming(pcm, o);
  try { return await streaming(pcm, o); }
  catch (e1) {
    if (e1.code !== grpc.status.INVALID_ARGUMENT && e1.code !== grpc.status.UNIMPLEMENTED) throw e1;
    try { return await offline(pcm, o); }
    catch (e2) {
      throw new Error(`${e1.message} | offline retry: ${e2.message} | Check NVIDIA_ASR_FUNCTION_ID and STT_LANG for that model`);
    }
  }
}
module.exports = { recognize };
