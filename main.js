require('dotenv').config(); // optional: keys in .env still work for development
const { app, BrowserWindow, ipcMain, clipboard, screen, systemPreferences, Tray, Menu, nativeImage, shell, safeStorage, dialog } = require('electron');
const path = require('path');
const { uIOhook, UiohookKey } = require('uiohook-napi');

const { Store } = require('./lib/store');
const { HotkeyMachine } = require('./lib/hotkey');
const { transcribe } = require('./lib/stt');
const { cleanText } = require('./lib/cleanup');
const { processAudio } = require('./lib/pipeline');
const { makeInput } = require('./lib/input');
const activeApp = require('./lib/activeApp');

const HOTKEY_LABELS = { CtrlRight: 'Right Ctrl', AltRight: process.platform === 'darwin' ? 'Right Option' : 'Right Alt', ShiftRight: 'Right Shift', F8: 'F8', F9: 'F9', F10: 'F10' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GROQ = 'https://api.groq.com/openai/v1';

let store, bar, settingsWin, tray, input;
let enabled = true;
let fgPromise = Promise.resolve(null);
let busy = Promise.resolve(); // utterances are processed one at a time, in order

const setState = (s, msg = '') => bar && !bar.isDestroyed() && bar.webContents.send('state', s, msg);
const keyCode = (name) => UiohookKey[name] ?? UiohookKey.AltRight;
const hotkeyLabel = () => HOTKEY_LABELS[store.get().hotkey] || store.get().hotkey;

// ---------- overlay pill ----------
function createBar() {
  const wa = screen.getPrimaryDisplay().workArea;
  const W = 380, H = 64;
  bar = new BrowserWindow({
    width: W, height: H,
    x: Math.round(wa.x + wa.width / 2 - W / 2), y: wa.y + wa.height - H - 12,
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
  bar.setAlwaysOnTop(true, 'screen-saver');
  bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  bar.setIgnoreMouseEvents(true);
  bar.loadFile('overlay.html');
  bar.once('ready-to-show', () => bar.showInactive());
}

// ---------- hotkey ----------
const machine = new HotkeyMachine({ emit: onHotkeyEvent });

function onHotkeyEvent(ev) {
  if (ev.type === 'start') {
    fgPromise = activeApp.get();                               // capture the target app while it still has focus
    if (process.platform === 'win32' && /^Alt/.test(store.get().hotkey)) input.suppressAltMenu();
    bar.webContents.send('rec:start');
  } else if (ev.type === 'stop') {
    bar.webContents.send('rec:stop', { tooShort: ev.tooShort, cancel: ev.cancel });
  } else if (ev.type === 'lock') {
    setState('listening', 'Hands-free · tap to stop');
  }
}

function startHotkey() {
  uIOhook.on('keydown', (e) => {
    if (e.keycode === UiohookKey.Escape) { if (machine.state !== 'idle') machine.cancel(); return; }
    const s = store.get();
    if (!enabled || e.keycode !== keyCode(s.hotkey)) return;
    machine.doubleTapLock = s.doubleTapLock;
    machine.down(Date.now());
  });
  uIOhook.on('keyup', (e) => {
    if (!enabled || e.keycode !== keyCode(store.get().hotkey)) return;
    machine.up(Date.now());
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

function cleanupTarget() {
  const s = store.get();
  const groq = store.effectiveKey('groq'), openai = store.effectiveKey('openai');
  if (groq) return { baseUrl: GROQ, apiKey: groq, model: s.cleanup.model };
  if (openai) return { baseUrl: 'https://api.openai.com/v1', apiKey: openai, model: 'gpt-4o-mini' };
  return null;
}

async function pasteText(text) {
  const keep = store.get().keepInClipboard;
  const previous = keep ? null : clipboard.readText();
  clipboard.writeText(text);
  await sleep(60);
  try { await input.paste(); } catch (error) { return { pasted: false, error }; } // text stays on the clipboard
  if (previous !== null) setTimeout(() => { try { clipboard.writeText(previous); } catch { /* ignore */ } }, 1200);
  return { pasted: true };
}

function handleAudio(arrayBuffer) {
  busy = busy.then(async () => {
    const target = cleanupTarget();
    const ctx = {
      settings: store.get(),
      canClean: !!target,
      ui: { state: setState },
      log: (m) => console.log(m),
      transcribe: (pcm, extra) => transcribe(pcm, sttConfig(extra.prompt)),
      cleanText: (text, o) => cleanText(text, { ...o, ...target }),
      getApp: () => Promise.race([fgPromise, sleep(1200).then(() => null)]),
      actions: {
        paste: pasteText,
        undo: () => input.undo(), enter: () => input.enter(), selectAll: () => input.selectAll(),
      },
      addHistory: (h) => store.addHistory(h),
      pasteHint: input.pasteHint,
    };
    try { await processAudio(Buffer.from(arrayBuffer), ctx); }
    catch (err) {
      console.error(err);
      setState('error', String(err.message || err).slice(0, 60));
      if (err.code === 'NOKEY') showSettings('general');
    }
  });
}

// ---------- settings window + tray ----------
function showSettings(tab = 'general') {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); settingsWin.webContents.send('tab', tab); return; }
  settingsWin = new BrowserWindow({
    width: 900, height: 680, minWidth: 760, minHeight: 520, title: 'Neural Flow', backgroundColor: '#0f1117',
    autoHideMenuBar: true, icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'settingsPreload.js'), contextIsolation: true, nodeIntegration: false },
  });
  settingsWin.loadFile('settings.html', { query: { tab } });
  settingsWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

function buildTrayMenu() {
  tray.setToolTip(`Neural Flow — hold ${hotkeyLabel()} to dictate`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Hold ${hotkeyLabel()} to dictate`, enabled: false },
    { label: 'Dictation enabled', type: 'checkbox', checked: enabled, click: (i) => { enabled = i.checked; if (!enabled) machine.reset(); } },
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
  ipcMain.on('audio', (_e, ab) => handleAudio(ab));
  ipcMain.on('rec:failed', () => machine.reset());

  ipcMain.handle('settings:get', () => ({
    settings: store.getForUI(), version: app.getVersion(), platform: process.platform, dataDir: app.getPath('userData'),
  }));
  ipcMain.handle('settings:save', (_e, patch) => {
    store.update(patch);
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!store.get().launchAtLogin });
    buildTrayMenu();
    return { ok: true };
  });
  ipcMain.handle('history:get', () => store.getHistory());
  ipcMain.handle('history:delete', (_e, id) => { store.deleteHistory(id); return true; });
  ipcMain.handle('history:clear', () => { store.clearHistory(); return true; });
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
    const needsSetup = store.isFirstRun || (['groq', 'openai'].includes(store.get().provider) && !store.effectiveKey(store.get().provider));
    if (needsSetup) showSettings('general');
  });
  app.on('will-quit', () => { uIOhook.stop(); activeApp.shutdown(); });
  app.on('window-all-closed', () => { /* keep running in the tray */ });
}
