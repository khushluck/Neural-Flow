'use strict';
// Sends keystrokes with uiohook-napi (no PowerShell window flashing and no focus stealing).
// Falls back to a hidden PowerShell / osascript only if keyTap is unavailable.
const { execFile } = require('child_process');

function makeInput({ uIOhook, UiohookKey }) {
  const mac = process.platform === 'darwin';
  const mod = mac ? UiohookKey.Meta : UiohookKey.Ctrl;
  const canTap = () => typeof uIOhook.keyTap === 'function';
  const combo = (key) => { if (!canTap()) throw new Error('keyTap unavailable'); uIOhook.keyTap(key, [mod]); };

  const fallbackPaste = () => new Promise((resolve, reject) => {
    const done = (e) => (e ? reject(e) : resolve());
    if (mac) execFile('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'], done);
    else if (process.platform === 'win32') execFile('powershell', ['-NoProfile', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^v")'], { windowsHide: true }, done);
    else reject(new Error('Unsupported OS'));
  });

  return {
    pasteHint: mac ? 'Cmd+V' : 'Ctrl+V',
    async paste() { try { combo(UiohookKey.V); } catch { await fallbackPaste(); } },
    async copy() { combo(UiohookKey.C); },
    async undo() { combo(UiohookKey.Z); },
    async selectAll() { combo(UiohookKey.A); },
    async enter() { if (!canTap()) throw new Error('keyTap unavailable'); uIOhook.keyTap(UiohookKey.Enter); },
    // Tapping an unused key while Alt is held stops Windows from treating a lone Alt press as "focus the menu bar".
    suppressAltMenu() {
      try { const k = UiohookKey.F24 ?? UiohookKey.F23; if (canTap() && k) uIOhook.keyTap(k); } catch { /* best effort */ }
    },
  };
}

module.exports = { makeInput };
