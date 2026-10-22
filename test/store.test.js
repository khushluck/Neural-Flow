const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../lib/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nf-test-'));
const fakeCrypto = { enc: (s) => Buffer.from(s).toString('base64'), dec: (s) => Buffer.from(s, 'base64').toString() };

test('defaults, first-run flag and persistence', () => {
  const dir = tmp();
  const a = new Store(dir, fakeCrypto);
  assert.strictEqual(a.isFirstRun, true);
  a.update({ provider: 'openai', language: 'hi', cleanup: { minWords: '6' } });
  const b = new Store(dir, fakeCrypto);
  assert.strictEqual(b.isFirstRun, false);
  assert.strictEqual(b.get().provider, 'openai');
  assert.strictEqual(b.get().cleanup.minWords, 6);          // coerced to number
  assert.strictEqual(b.get().cleanup.enabled, true);        // untouched default
});

test('API keys are encrypted on disk, masked for the UI, and a masked value never overwrites the real key', () => {
  const dir = tmp();
  const s = new Store(dir, fakeCrypto);
  s.update({ keys: { groq: 'gsk_secret_1234' } });
  const onDisk = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  assert.ok(!onDisk.includes('gsk_secret_1234'));
  assert.ok(onDisk.includes('enc:'));
  const ui = s.getForUI();
  assert.strictEqual(ui.keys.groq, '••••••••1234'.slice(0, 4) + '1234');
  s.update({ keys: { groq: ui.keys.groq } });               // UI sends the mask back unchanged
  assert.strictEqual(s.get().keys.groq, 'gsk_secret_1234');
  assert.strictEqual(new Store(dir, fakeCrypto).get().keys.groq, 'gsk_secret_1234');
});

test('unknown keys and wrong types are ignored', () => {
  const s = new Store(tmp());
  s.update({ hacker: 'x', keys: { evil: 'y' }, doubleTapLock: 0 });
  assert.strictEqual(s.get().hacker, undefined);
  assert.strictEqual(s.get().keys.evil, undefined);
  assert.strictEqual(s.get().doubleTapLock, false);
});

test('history is capped, newest first, deletable', () => {
  const s = new Store(tmp());
  s.update({ historyLimit: 3 });
  for (let i = 0; i < 5; i++) s.addHistory({ text: 't' + i });
  assert.deepStrictEqual(s.getHistory().map((h) => h.text), ['t4', 't3', 't2']);
  s.deleteHistory(s.getHistory()[0].id);
  assert.strictEqual(s.getHistory().length, 2);
  s.clearHistory();
  assert.strictEqual(s.getHistory().length, 0);
});
