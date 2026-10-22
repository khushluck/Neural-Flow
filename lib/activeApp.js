'use strict';
// Which app is in the foreground? Used for per-app tone. Never throws; resolves null on any problem.
// Windows: one persistent hidden PowerShell (type compiled once) so each lookup takes a few ms.
const { spawn, execFile } = require('child_process');

const INIT = [
  `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;using System.Text;public class NF{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);}'`,
  `function Get-Fg{$h=[NF]::GetForegroundWindow();$p=0;[void][NF]::GetWindowThreadProcessId($h,[ref]$p);$sb=New-Object System.Text.StringBuilder 256;[void][NF]::GetWindowText($h,$sb,256);$n='';try{$n=(Get-Process -Id $p -ErrorAction Stop).ProcessName}catch{};Write-Output ('NF|'+$n+'|'+$sb.ToString())}`,
];

let ps = null, buf = '', waiters = [];

function parseLine(line) {
  const [, name = '', ...rest] = line.split('|');
  return { name, title: rest.join('|') };
}

function ensurePs() {
  if (ps) return;
  ps = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('NF|')) continue;
      const w = waiters.shift();
      if (w && !w.dead) w.res(parseLine(line));
    }
  });
  const gone = () => { ps = null; buf = ''; waiters.splice(0).forEach((w) => !w.dead && w.res(null)); };
  ps.on('exit', gone); ps.on('error', gone);
  ps.stdin.on('error', () => {});
  ps.stdin.write(INIT.join('\n') + '\n');
}

function get() {
  return new Promise((resolve) => {
    try {
      if (process.platform === 'win32') {
        ensurePs();
        const w = { dead: false, res: resolve };
        waiters.push(w);
        setTimeout(() => { if (!w.dead) { w.dead = true; resolve(null); } }, 1500);
        ps.stdin.write('Get-Fg\n');
      } else if (process.platform === 'darwin') {
        execFile('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
          { timeout: 1500 }, (err, out) => resolve(err ? null : { name: String(out).trim(), title: '' }));
      } else resolve(null);
    } catch { resolve(null); }
  });
}

function shutdown() { try { ps && ps.kill(); } catch { /* ignore */ } ps = null; }

module.exports = { get, shutdown, parseLine };
