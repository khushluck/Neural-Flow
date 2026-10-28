'use strict';
// Helpers for the "press any key to set your hotkey" recorder.
const FRIENDLY = {
  CtrlRight: 'Right Ctrl', AltRight: 'Right Alt / Right Option', ShiftRight: 'Right Shift', MetaRight: 'Right Win / Cmd',
  CapsLock: 'Caps Lock', ScrollLock: 'Scroll Lock', NumLock: 'Num Lock', PrintScreen: 'Print Screen',
};
const TYPING = /^([A-Z]|[0-9]|Space|Enter|Tab|Backspace|Comma|Period|Slash|Semicolon|Quote|Minus|Equal|Backslash|BracketLeft|BracketRight|Backquote)$/;
const LEFT_MODIFIERS = new Set(['Ctrl', 'Alt', 'Shift', 'Meta']); // used constantly in normal shortcuts

function reverseKeyMap(keys) {
  const m = {};
  for (const [name, code] of Object.entries(keys)) if (!(code in m)) m[code] = name;
  return m;
}
const friendly = (name) => FRIENDLY[name] || String(name).replace(/([a-z])([A-Z0-9])/g, '$1 $2');

// -> { name, label } for a usable key, { rejected:true } for keys that would get in the way of typing, { cancelled:true } otherwise.
function describeKey(map, code, escapeName = 'Escape') {
  const name = map[code];
  if (!name || name === escapeName) return { cancelled: true };
  if (TYPING.test(name) || LEFT_MODIFIERS.has(name)) return { rejected: true, name };
  return { name, label: friendly(name) };
}
module.exports = { reverseKeyMap, describeKey, friendly };
