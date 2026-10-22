'use strict';
// Pure state machine for the dictation hotkey (no Electron / timers, so it is unit-testable).
//   hold      : press and hold -> record, release -> stop
//   hands-free: double-tap -> keeps recording, next tap -> stop
// Emits: {type:'start'} | {type:'stop', tooShort, cancel} | {type:'lock'}
class HotkeyMachine {
  constructor({ emit, minHoldMs = 300, doubleTapMs = 450, doubleTapLock = true }) {
    Object.assign(this, { emit, minHoldMs, doubleTapMs, doubleTapLock });
    this.state = 'idle';   // idle | holding | locked
    this.isDown = false;
    this.ignoreUp = false;
    this.downAt = 0;
    this.lastTapUp = 0;
  }

  down(t) {
    if (this.isDown) return;            // swallow key auto-repeat
    this.isDown = true;
    this.downAt = t;
    if (this.state === 'locked') {      // tap while hands-free -> finish
      this.state = 'idle';
      this.ignoreUp = true;
      this.emit({ type: 'stop', tooShort: false, cancel: false });
      return;
    }
    this.state = 'holding';
    this.emit({ type: 'start' });
  }

  up(t) {
    if (!this.isDown) return;
    this.isDown = false;
    if (this.ignoreUp) { this.ignoreUp = false; return; }
    if (this.state !== 'holding') return;
    const heldMs = t - this.downAt;
    if (heldMs >= this.minHoldMs) {     // normal hold-to-talk
      this.state = 'idle';
      this.lastTapUp = 0;
      this.emit({ type: 'stop', tooShort: false, cancel: false });
      return;
    }
    // A quick tap.
    const isSecondTap = this.doubleTapLock && this.lastTapUp && this.downAt - this.lastTapUp <= this.doubleTapMs;
    if (isSecondTap) {
      this.state = 'locked';
      this.lastTapUp = 0;
      this.emit({ type: 'lock' });
    } else {
      this.state = 'idle';
      this.lastTapUp = t;
      this.emit({ type: 'stop', tooShort: true, cancel: false });
    }
  }

  cancel() {                             // Esc: discard the current recording
    if (this.state === 'idle') return;
    this.state = 'idle';
    this.lastTapUp = 0;
    if (this.isDown) this.ignoreUp = true;
    this.emit({ type: 'stop', tooShort: false, cancel: true });
  }

  reset() { this.state = 'idle'; this.isDown = false; this.ignoreUp = false; this.lastTapUp = 0; }
}

module.exports = { HotkeyMachine };
