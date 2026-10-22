const test = require('node:test');
const assert = require('node:assert');
const { HotkeyMachine } = require('../lib/hotkey');

const make = (opts = {}) => { const ev = []; const m = new HotkeyMachine({ emit: (e) => ev.push(e), ...opts }); return { m, ev }; };

test('hold to talk: start on down, stop on up', () => {
  const { m, ev } = make();
  m.down(0); m.up(1000);
  assert.deepStrictEqual(ev.map((e) => e.type), ['start', 'stop']);
  assert.strictEqual(ev[1].tooShort, false);
});

test('key auto-repeat is ignored', () => {
  const { m, ev } = make();
  m.down(0); m.down(30); m.down(60); m.up(900);
  assert.strictEqual(ev.filter((e) => e.type === 'start').length, 1);
});

test('single quick tap is discarded as too short', () => {
  const { m, ev } = make();
  m.down(0); m.up(100);
  assert.strictEqual(ev[1].tooShort, true);
});

test('double-tap locks hands-free, next tap stops', () => {
  const { m, ev } = make();
  m.down(0); m.up(100);        // tap 1
  m.down(250); m.up(350);      // tap 2 -> lock
  assert.strictEqual(ev.at(-1).type, 'lock');
  assert.strictEqual(m.state, 'locked');
  m.down(5000);                // tap to finish
  assert.deepStrictEqual(ev.at(-1), { type: 'stop', tooShort: false, cancel: false });
  m.up(5080);                  // its key-up must not emit anything
  assert.strictEqual(ev.at(-1).type, 'stop');
  assert.strictEqual(ev.filter((e) => e.type === 'stop').length, 2);
  assert.strictEqual(m.state, 'idle');
});

test('slow second tap does not lock', () => {
  const { m, ev } = make();
  m.down(0); m.up(100);
  m.down(2000); m.up(2100);
  assert.ok(!ev.some((e) => e.type === 'lock'));
});

test('double-tap lock can be disabled', () => {
  const { m, ev } = make({ doubleTapLock: false });
  m.down(0); m.up(100); m.down(200); m.up(300);
  assert.ok(!ev.some((e) => e.type === 'lock'));
});

test('cancel discards recording and swallows the key-up', () => {
  const { m, ev } = make();
  m.down(0);
  m.cancel();
  assert.deepStrictEqual(ev.at(-1), { type: 'stop', tooShort: false, cancel: true });
  m.up(900);
  assert.strictEqual(ev.length, 2);
});
