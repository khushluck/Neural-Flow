require('dotenv').config(); // optional: keys in .env still work for development
const { app, BrowserWindow, ipcMain, clipboard, screen, systemPreferences, Tray, Menu, nativeImage, shell, safeStorage, dialog } = require('electron');
const path = require('path');
const { uIOhook, UiohookKey } = require('uiohook-napi');

const { Store } = require('./lib/store');
const { HotkeyMachine } = require('./lib/hotkey');
const { transcribeWithFallback } = require('./lib/stt');
const { reverseKeyMap, describeKey } = require('./lib/keys');
const { cleanText, rewriteText } = require('./lib/cleanup');
const { processAudio, processCommand } = require('./lib/pipeline');
const { makeInput } = require('./lib/input');
const activeApp = require('./lib/activeApp');
const T = require('./lib/text');

const HOTKEY_LABELS = { CtrlRight: 'Right Ctrl', AltRight: process.platform === 'darwin' ? 'Right Option' : 'Right Alt', ShiftRight: 'Right Shift', F8: 'F8', F9: 'F9', F10: 'F10' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GROQ = 'https://api.groq.com/openai/v1';

let store, bar, settingsWin, tray, input;
let enabled = true;
let fgPromise = Promise.resolve(null);
let lastPaste = null; // { text, app, ts } of the last dictation, for smart spacing + AI context
let busy = Promise.resolve(); // utterances are processed one at a time, in order

const setState = (s, msg = '') => bar && !bar.isDestroyed() && bar.webContents.send('state', s, msg);
const keyCode = (name) => UiohookKey[name] ?? UiohookKey.AltRight;
const hotkeyLabel = () => HOTKEY_LABELS[store.get().hotkey] || store.get().hotkey;
const cmdLabel = () => HOTKEY_LABELS[store.get().commandHotkey] || store.get().commandHotkey;

// ---------- overlay pill ----------
const BAR_W = 460, BAR_H = 130; // transparent stage: room for the glow, hint caption and the widest message

// Put the overlay on the monitor where the user is working (bottom or top centre of its work area).
function placeBar() {
  if (!bar || bar.isDestroyed()) return;
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const top = store.get().overlayPosition === 'top';
  bar.setBounds({ x: Math.round(wa.x + wa.width / 2 - BAR_W / 2), y: top ? wa.y : wa.y + wa.height - BAR_H, width: BAR_W, height: BAR_H });
}

function sendOverlayConfig() {
  if (!bar || bar.isDestroyed()) return;
  const s = store.get();
  bar.webContents.send('config', {
    hideIdle: !!s.overlayHideIdle, sounds: !!s.soundCues, position: s.overlayPosition === 'top' ? 'top' : 'bottom',
    liveSegments: !!s.liveSegments, pauseParagraphs: !!s.pauseParagraphs, micWarm: !!s.micWarm,
  });
}

function createBar() {
  bar = new BrowserWindow({
    width: BAR_W, height: BAR_H,
    frame: false, transparent: true, resizable: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true,
    focusable: false, // never steals focus, so the paste lands in the app you were typing in
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      autoplayPolicy: 'no-user-gesture-required', // the pill is never clicked; without this the mic AudioContext stays suspended
    },
  });
  placeBar();
  bar.setAlwaysOnTop(true, 'screen-saver');
  bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  bar.setIgnoreMouseEvents(true);
  bar.loadFile('overlay.html');
  bar.webContents.on('did-finish-load', sendOverlayConfig);
  bar.once('ready-to-show', () => bar.showInactive());
}

// ---------- hotkeys ----------
const machine = new HotkeyMachine({ emit: (ev) => onHotkeyEvent(ev, 'dictate') });
const cmdMachine = new HotkeyMachine({ emit: (ev) => onHotkeyEvent(ev, 'command'), doubleTapLock: false });

function onHotkeyEvent(ev, mode) {
  if (ev.type === 'start') {
    fgPromise = activeApp.get();                               // capture the target app while it still has focus
    placeBar();                                                // follow the user to whichever monitor they are on
    if (mode === 'dictate' && process.platform === 'win32' && /^Alt/.test(store.get().hotkey)) input.suppressAltMenu();
    bar.webContents.send('rec:start', mode);
  } else if (ev.type === 'stop') {
    bar.webContents.send('rec:stop', { tooShort: ev.tooShort, cancel: ev.cancel });
  } else if (ev.type === 'lock') {
    setState('listening', 'Hands-free · tap to stop');
  }
}

const KEY_NAMES = reverseKeyMap(UiohookKey);
let recordResolve = null; // set while Settings is waiting for "press the key you want"

const commandKey = (s) => (s.commandMode && s.commandHotkey ? UiohookKey[s.commandHotkey] : undefined);

function startHotkey() {
  uIOhook.on('keydown', (e) => {
    if (recordResolve) { const done = recordResolve; recordResolve = null; done(describeKey(KEY_NAMES, e.keycode)); return; }
    if (e.keycode === UiohookKey.Escape) { machine.cancel(); cmdMachine.cancel(); return; } // no-op when idle
    if (!enabled) return;
    const s = store.get();
    if (e.keycode === keyCode(s.hotkey)) {                      // dictation key wins if both are set to the same key
      if (cmdMachine.state !== 'idle') return;
      machine.doubleTapLock = s.doubleTapLock;
      machine.down(Date.now());
      return;
    }
    const ck = commandKey(s);
    if (ck !== undefined && e.keycode === ck && machine.state === 'idle') cmdMachine.down(Date.now());
  });
  uIOhook.on('keyup', (e) => {
    if (!enabled) return;
    const s = store.get();
    if (e.keycode === keyCode(s.hotkey)) { machine.up(Date.now()); return; }
    const ck = commandKey(s);
    if (ck !== undefined && e.keycode === ck) cmdMachine.up(Date.now());
  });
  uIOhook.start();
}

// ---------- audio -> text ----------
function sttConfig(prompt) {
  const s = store.get();
  const p = s.provider;
  return {
    provider: p, prompt, language: s.language, model: s.sttModel,
    apiKey: p === 'groq' || p === 'openai' ? store.effectiveKey(p) : '',
    nvidia: { apiKey: store.effectiveKey('nvidia'), functionId: store.effectiveNvidiaFunctionId(), lang: s.nvidia.lang },
    local: s.local,
  };
}

// Backup speech engine, used automatically if the main one fails (rate limit, outage, bad key).
function fallbackConfig(prompt) {
  const s = store.get();
  if (!s.sttFallback || s.sttFallback === s.provider) return null;
  if (s.sttFallback === 'openai') {
    const apiKey = store.effectiveKey('openai');
    return apiKey ? { provider: 'openai', prompt, language: s.language, apiKey } : null;
  }
  if (s.sttFallback === 'local') return s.local?.binary && s.local?.model ? { provider: 'local', prompt, language: s.language, local: s.local } : null;
  return null;
}

function cleanupTarget() {
  const s = store.get();
  const groq = store.effectiveKey('groq'), openai = store.effectiveKey('openai');
  if (groq) return { baseUrl: GROQ, apiKey: groq, model: s.cleanup.model };
  if (openai) return { baseUrl: 'https://api.openai.com/v1', apiKey: openai, model: 'gpt-4o-mini' };
  return null;
}

// One shared "put the user's clipboard back" mechanism, so back-to-back dictations / commands can never
// capture each other's temporary text as if it were the user's clipboard.
let pendingOriginal = null, restoreTimer = null;
const userClipboard = () => (pendingOriginal !== null ? pendingOriginal : clipboard.readText());
function restoreClipboardLater(text, ms) {
  pendingOriginal = text;
  clearTimeout(restoreTimer);
  restoreTimer = setTimeout(() => { try { clipboard.writeText(text); } catch { /* ignore */ } pendingOriginal = null; }, ms);
}

function restoreClipboardNow(text) {
  clearTimeout(restoreTimer); pendingOriginal = null;
  try { clipboard.writeText(text); } catch { /* ignore */ }
}

async function pasteText(text) {
  const keep = store.get().keepInClipboard;
  const previous = keep ? null : userClipboard();
  clipboard.writeText(text);
  await sleep(60);
  try { await input.paste(); } catch (error) { return { pasted: false, error }; } // text stays on the clipboard
  if (previous !== null) restoreClipboardLater(previous, 1200);
  return { pasted: true };
}

// Command Mode: copy whatever text is selected in the foreground app (restoring the clipboard afterwards).
async function grabSelection() {
  const previous = userClipboard();
  clearTimeout(restoreTimer);                        // a pending restore must not overwrite the selection we are about to copy
  const sentinel = `__nf_${Date.now()}__`;
  clipboard.writeText(sentinel);
  await sleep(150);                                  // let the command key come up so Ctrl+C isn't combined with it
  try { await input.copy(); } catch { restoreClipboardNow(previous); return ''; }
  let text = '';
  for (let i = 0; i < 10 && !text; i++) { await sleep(40); const t = clipboard.readText(); if (t !== sentinel) text = t; }
  restoreClipboardNow(previous);
  return text;
}

function handleAudio(arrayBuffer, mode = 'dictate', meta = {}) {
  busy = busy.then(async () => {
    const target = cleanupTarget();
    const ctx = {
      settings: store.get(),
      canClean: !!target,
      ui: { state: setState },
      log: (m) => { if (!store.get().privacyMode) console.log(m); },
      meta: { segment: !!meta?.segment, paragraph: !!meta?.paragraph },
      transcribe: (pcm, extra) => transcribeWithFallback(pcm, sttConfig(extra.prompt), fallbackConfig(extra.prompt)),
      cleanText: (text, o) => cleanText(text, { ...o, ...target }),
      rewriteText: (sel, ins, o) => rewriteText(sel, ins, { ...o, ...target }),
      getSelection: grabSelection,
      getLast: () => lastPaste,
      setLast: (l) => { lastPaste = l; },
      getApp: () => Promise.race([fgPromise, sleep(1200).then(() => null)]),
      actions: {
        paste: pasteText,
        undo: () => input.undo(), enter: () => input.enter(), selectAll: () => input.selectAll(),
      },
      addHistory: (h) => store.addHistory(h),
      pasteHint: input.pasteHint,
    };
    try { await (mode === 'command' ? processCommand : processAudio)(Buffer.from(arrayBuffer), ctx); }
    catch (err) {
      console.error(err);
      setState('error', String(err.message || err).slice(0, 90));
      if (err.code === 'NOKEY') showSettings('speech');   // straight to where the key goes
    }
  });
}

// ---------- settings window + tray ----------
function showSettings(tab = 'general') {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); settingsWin.webContents.send('tab', tab); return; }
  settingsWin = new BrowserWindow({
    width: 1080, height: 760, minWidth: 920, minHeight: 620, title: 'Neural Flow', backgroundColor: '#131421',
    autoHideMenuBar: true, icon: path.join(__dirname, 'assets', 'icon.png'),
    // Windows / macOS: draw our own title bar so the window blends with the app (native min/max/close stay visible).
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#131421', symbolColor: '#A9B4C7', height: 44 } } : {}),
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: { preload: path.join(__dirname, 'settingsPreload.js'), contextIsolation: true, nodeIntegration: false },
  });
  settingsWin.loadFile('settings.html', { query: { tab } });
  settingsWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

function buildTrayMenu() {
  const s = store.get();
  const tones = ['neutral', 'casual', 'formal', 'code'];
  const langs = ['', 'English', 'Hindi', 'Spanish', 'French', 'German'];
  tray.setToolTip(`Neural Flow — hold ${hotkeyLabel()} to dictate`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Hold ${hotkeyLabel()} to dictate`, enabled: false },
    ...(s.commandMode && s.commandHotkey ? [{ label: `Select text + hold ${cmdLabel()} to edit by voice`, enabled: false }] : []),
    { label: 'Dictation enabled', type: 'checkbox', checked: enabled, click: (i) => { enabled = i.checked; if (!enabled) { machine.reset(); cmdMachine.reset(); } } },
    { type: 'separator' },
    { label: 'AI cleanup', type: 'checkbox', checked: s.cleanup.enabled, click: (i) => store.update({ cleanup: { enabled: i.checked } }) },
    { label: 'Tone', submenu: tones.map((t) => ({ label: t[0].toUpperCase() + t.slice(1), type: 'radio', checked: s.tone === t, click: () => store.update({ tone: t }) })) },
    { label: 'Translate to', submenu: langs.map((l) => ({ label: l || 'Off', type: 'radio', checked: s.translateTo === l, click: () => store.update({ translateTo: l }) })) },
    { type: 'separator' },
    { label: 'Settings…', click: () => showSettings('general') },
    { label: 'History', click: () => showSettings('history') },
    { type: 'separator' },
    { label: 'Quit Neural Flow', click: () => app.quit() },
  ]));
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 18, height: 18 });
  tray = new Tray(img);
  tray.on('double-click', () => showSettings('general'));
  buildTrayMenu();
}

// ---------- IPC for the settings window ----------
function registerIpc() {
  ipcMain.on('audio', (_e, ab, mode, meta) => handleAudio(ab, mode === 'command' ? 'command' : 'dictate', meta));
  ipcMain.on('rec:failed', () => { machine.reset(); cmdMachine.reset(); });

  ipcMain.handle('settings:get', () => ({
    settings: store.getForUI(), version: app.getVersion(), platform: process.platform, dataDir: app.getPath('userData'), firstRun: store.isFirstRun,
  }));
  ipcMain.handle('settings:save', (_e, patch) => {
    store.update(patch);
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!store.get().launchAtLogin });
    buildTrayMenu();
    placeBar(); sendOverlayConfig();
    return { ok: true };
  });
  ipcMain.handle('history:get', () => store.getHistory());
  ipcMain.handle('history:delete', (_e, id) => { store.deleteHistory(id); return true; });
  ipcMain.handle('history:clear', () => { store.clearHistory(); return true; });
  ipcMain.handle('stats:get', () => store.getStats());
  // Settings -> "Record a key…": the next key pressed anywhere becomes the hotkey (Esc cancels).
  ipcMain.handle('hotkey:record', () => new Promise((resolve) => {
    if (recordResolve) recordResolve({ cancelled: true });
    const done = (r) => { clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { if (recordResolve === done) recordResolve = null; resolve({ cancelled: true }); }, 10000);
    recordResolve = done;
  }));
  // Edit & learn: save the corrected text and add any name/term fixes to the dictionary.
  ipcMain.handle('history:learn', (_e, id, edited) => {
    const h = store.getHistory().find((x) => x.id === id);
    if (!h) return { added: 0 };
    const pairs = T.learnFromEdit(h.text, edited);
    if (pairs.length) store.update({ dictionary: T.mergeDictionary(store.get().dictionary, pairs) });
    store.updateHistory(id, { text: String(edited) });
    return { added: pairs.length };
  });
  // Re-polish: run the saved raw transcript through cleanup again with the current settings.
  ipcMain.handle('history:repolish', async (_e, id) => {
    const h = store.getHistory().find((x) => x.id === id);
    const target = cleanupTarget();
    if (!h || !h.raw) return { ok: false, message: 'Nothing to re-polish' };
    if (!target) return { ok: false, message: 'Needs a Groq or OpenAI key' };
    const s = store.get();
    try {
      const r = await cleanText(h.raw, { ...target, tone: T.toneForApp({ name: h.app || '' }, s.appRules, s.tone), dictWords: T.parseDictionary(s.dictionary).words, hinglishRoman: s.cleanup.hinglishRoman, level: s.cleanup.level, translateTo: s.translateTo });
      store.updateHistory(id, { text: r.text, cleaned: r.cleaned });
      return { ok: true };
    } catch (e) { return { ok: false, message: String(e.message || e).slice(0, 80) }; }
  });
  ipcMain.handle('clipboard:copy', (_e, text) => { clipboard.writeText(String(text)); return true; });
  ipcMain.handle('file:pick', async (_e, title) => {
    const r = await dialog.showOpenDialog(settingsWin, { title, properties: ['openFile'] });
    return r.canceled ? '' : r.filePaths[0];
  });
  ipcMain.handle('key:test', async (_e, { provider, key }) => {
    const k = !key || key.startsWith('••••') ? store.effectiveKey(provider) : key;
    if (!k) return { ok: false, message: 'Enter a key first' };
    const base = provider === 'openai' ? 'https://api.openai.com/v1' : GROQ;
    try {
      const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(8000) });
      return r.ok ? { ok: true, message: 'Key works ✓' } : { ok: false, message: r.status === 401 ? 'Invalid key' : `Error ${r.status}` };
    } catch (e) { return { ok: false, message: 'Network error' }; }
  });
  ipcMain.handle('open:external', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
}

// ---------- boot ----------
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showSettings('general'));
  app.whenReady().then(async () => {
    const crypto = safeStorage.isEncryptionAvailable()
      ? { enc: (s) => safeStorage.encryptString(s).toString('base64'), dec: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')) }
      : null;
    store = new Store(app.getPath('userData'), crypto);
    input = makeInput({ uIOhook, UiohookKey });
    Menu.setApplicationMenu(null);

    if (process.platform === 'darwin') {
      app.dock?.hide();
      await systemPreferences.askForMediaAccess('microphone');
      systemPreferences.isTrustedAccessibilityClient(true); // prompts for Accessibility (paste + key hook)
    }
    registerIpc();
    createBar();
    createTray();
    startHotkey();
    if (app.isPackaged && store.get().autoUpdate) {              // checks the GitHub release feed; silent if offline
      try { const { autoUpdater } = require('electron-updater'); autoUpdater.on('error', () => {}); autoUpdater.checkForUpdatesAndNotify(); }
      catch (e) { console.log('[update] skipped:', e.message); }
    }
    const needsSetup = store.isFirstRun || (['groq', 'openai'].includes(store.get().provider) && !store.effectiveKey(store.get().provider));
    if (needsSetup) showSettings('general');
  });
  app.on('will-quit', () => { uIOhook.stop(); activeApp.shutdown(); });
  app.on('window-all-closed', () => { /* keep running in the tray */ });
}
