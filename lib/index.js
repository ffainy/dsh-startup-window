/**
 * Host half of dsh-startup-window.
 *
 * The desktop shell creates its main window with a hard-coded 1280x820 and never
 * saves the bounds back, so every launch starts small. This half does two things
 * at boot and on request: it keeps the user's preferred size in
 * ~/.dsh/startup-window/config.json, and it asks a tiny PowerShell/Win32 helper to
 * apply that size to the app's own top-level window.
 *
 * Why a helper process: the renderer has no sanctioned API for resizing the main
 * window (dshDesktop.resizable does not exist, and no DESKTOP_IPC channel carries
 * a size), so the resize has to happen outside the page. The helper runs as a
 * child of this Host process, i.e. under the app's own token and integrity level,
 * which is what SetWindowPos needs.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PACKAGE = 'dsh-startup-window';
const ENDPOINT = 'dsh-startup-window/apply';
const ROUTE_PATH = '/api/' + ENDPOINT;
const STATE_DIR = process.env.DWS_STATE_DIR
  ? path.resolve(process.env.DWS_STATE_DIR)
  : path.join(os.homedir(), '.dsh', 'startup-window');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const LOG_FILE = path.join(STATE_DIR, 'host.log');
const SCRIPT_FILE = path.join(STATE_DIR, 'resize.ps1');
const BOOT = Math.random().toString(36).slice(2, 8);
const MIN_WIDTH = 520;
const MIN_HEIGHT = 600;
const MAX_SIDE = 7680;
const DEFAULT_CONFIG = { enabled: true, width: 1280, height: 820 };
const AUTO_DELAY_MS = 2500;
const SCRIPT_TIMEOUT_MS = 40000;

let autoApplied = false;

/* ------------------------------------------------------------------ logging */

async function logHost(line) {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.appendFile(LOG_FILE, new Date().toISOString() + ' [' + BOOT + '] ' + line + '\n', 'utf8');
  } catch {
    /* logging must never break a request */
  }
}

async function readLogTail(lines) {
  try {
    const text = await fs.readFile(LOG_FILE, 'utf8');
    const all = text.trim().split('\n').filter(Boolean);
    return all.slice(-(lines || 6)).join('\n');
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------- config */

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: source.enabled === false ? false : true,
    width: clampInt(source.width, MIN_WIDTH, MAX_SIDE, DEFAULT_CONFIG.width),
    height: clampInt(source.height, MIN_HEIGHT, MAX_SIDE, DEFAULT_CONFIG.height),
  };
}

async function readConfig() {
  try {
    const text = await fs.readFile(CONFIG_FILE, 'utf8');
    return normalizeConfig(JSON.parse(text));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function writeConfig(config) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const tmp = CONFIG_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, CONFIG_FILE);
}

/* ---------------------------------------------------- resize helper (Win32) */

const PS_SCRIPT = String.raw`param(
  [int]$Width,
  [int]$Height,
  [string]$LogFile
)
$ErrorActionPreference = 'Continue'

function Write-Log([string]$message) {
  try {
    Add-Content -LiteralPath $LogFile -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff') + ' [ps] ' + $message) -Encoding UTF8
  } catch { }
}

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public struct DwsRect { public int Left, Top, Right, Bottom; }
public struct DwsMonitorInfo { public int cbSize; public DwsRect rcMonitor; public DwsRect rcWork; public int dwFlags; }
public class DwsWin {
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref DwsMonitorInfo info);
  public delegate bool EnumProc(IntPtr h, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out DwsRect r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("kernel32.dll")] public static extern uint GetLastError();
}
"@

try { [void][DwsWin]::SetProcessDpiAwareness(2) } catch { try { [void][DwsWin]::SetProcessDPIAware() } catch { } }

$script:pids = New-Object System.Collections.Generic.HashSet[int]

# Prefer this process's own ancestor chain: the Host runs under the desktop app.
try {
  $cursor = $PID
  for ($i = 0; $i -lt 12; $i++) {
    $info = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $cursor) -ErrorAction SilentlyContinue
    if (-not $info) { break }
    if ($info.Name -like '*DeepSeek Harness*') { [void]$script:pids.Add([int]$cursor) }
    $cursor = [int]$info.ParentProcessId
    if ($cursor -le 4) { break }
  }
} catch { Write-Log ('ancestry lookup failed: ' + $_.Exception.Message) }

# Fallback (and second opinion): every process named like the desktop app.
try {
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DeepSeek Harness*' } | ForEach-Object { [void]$script:pids.Add([int]$_.Id) }
} catch { }

if ($script:pids.Count -eq 0) {
  Write-Log 'no DeepSeek Harness process found; nothing to resize'
  exit 3
}

$script:best = [IntPtr]::Zero
$script:bestArea = 0
$script:bestVisible = $false

function Find-MainWindow {
  $script:best = [IntPtr]::Zero
  $script:bestArea = 0
  $script:bestVisible = $false
  $callback = [DwsWin+EnumProc]{
    param($hwnd, $param)
    $owner = 0
    [void][DwsWin]::GetWindowThreadProcessId($hwnd, [ref]$owner)
    if (-not $script:pids.Contains([int]$owner)) { return $true }
    $class = New-Object System.Text.StringBuilder 128
    [void][DwsWin]::GetClassNameW($hwnd, $class, 128)
    if ($class.ToString() -ne 'Chrome_WidgetWin_1') { return $true }
    $rect = New-Object DwsRect
    [void][DwsWin]::GetWindowRect($hwnd, [ref]$rect)
    $area = ($rect.Right - $rect.Left) * ($rect.Bottom - $rect.Top)
    if ($area -le 0) { return $true }
    $visible = [DwsWin]::IsWindowVisible($hwnd)
    if ($visible -and -not $script:bestVisible) {
      $script:best = $hwnd
      $script:bestArea = $area
      $script:bestVisible = $true
      return $true
    }
    if ($visible -eq $script:bestVisible -and $area -gt $script:bestArea) {
      $script:best = $hwnd
      $script:bestArea = $area
    }
    return $true
  }
  [void][DwsWin]::EnumWindows($callback, [IntPtr]::Zero)
  return $script:best
}

$target = [IntPtr]::Zero
for ($i = 0; $i -lt 40; $i++) {
  $target = Find-MainWindow
  if ($target -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 500
}

if ($target -eq [IntPtr]::Zero) {
  Write-Log ('no main window after waiting; pids=' + ($script:pids -join ','))
  exit 4
}

if ([DwsWin]::IsZoomed($target)) {
  [void][DwsWin]::ShowWindow($target, 9)
  Start-Sleep -Milliseconds 250
}

$rect = New-Object DwsRect
[void][DwsWin]::GetWindowRect($target, [ref]$rect)

$dpi = 96
try {
  $reported = [DwsWin]::GetDpiForWindow($target)
  if ($reported -gt 0) { $dpi = [int]$reported }
} catch { }

# The desktop shell centers the window when it is created (1280x820). Resizing
# around the old top-left corner pushes the window off the bottom-right of the
# screen, so the new size is always re-centered inside the work area of the
# monitor the window currently lives on, and clamped to that work area.
$work = New-Object DwsMonitorInfo
$work.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][DwsMonitorInfo])
$haveWork = $false
try {
  $monitor = [DwsWin]::MonitorFromWindow($target, 2)
  if ($monitor -ne [IntPtr]::Zero) { $haveWork = [DwsWin]::GetMonitorInfo($monitor, [ref]$work) }
} catch { }
if (-not $haveWork) {
  $work.rcWork.Left = 0
  $work.rcWork.Top = 0
  $work.rcWork.Right = $rect.Right
  $work.rcWork.Bottom = $rect.Bottom
}
$workW = $work.rcWork.Right - $work.rcWork.Left
$workH = $work.rcWork.Bottom - $work.rcWork.Top
if ($workW -le 0 -or $workH -le 0) {
  Write-Log 'no usable work area; nothing to resize'
  exit 5
}

$wantW = [int][math]::Round($Width * $dpi / 96.0)
$wantH = [int][math]::Round($Height * $dpi / 96.0)
if ($wantW -gt $workW) { $wantW = $workW; Write-Log ('width clamped to work area: ' + $wantW) }
if ($wantH -gt $workH) { $wantH = $workH; Write-Log ('height clamped to work area: ' + $wantH) }
$wantX = $work.rcWork.Left + [int][math]::Floor(($workW - $wantW) / 2)
$wantY = $work.rcWork.Top + [int][math]::Floor(($workH - $wantH) / 2)

$ok = [DwsWin]::SetWindowPos($target, [IntPtr]::Zero, $wantX, $wantY, $wantW, $wantH, 0x0014)
Start-Sleep -Milliseconds 300

$after = New-Object DwsRect
[void][DwsWin]::GetWindowRect($target, [ref]$after)
$err = 0
$errText = ''
if (-not $ok) {
  $err = [DwsWin]::GetLastError()
  $errText = ' err=' + $err
}

Write-Log ('hwnd=' + $target + ' dpi=' + $dpi + ' work=' + $workW + 'x' + $workH + '@' + $work.rcWork.Left + ',' + $work.rcWork.Top + ' want=' + $wantW + 'x' + $wantH + ' pos=' + $wantX + ',' + $wantY + ' ok=' + $ok + $errText + ' now=' + ($after.Right - $after.Left) + 'x' + ($after.Bottom - $after.Top) + '@' + $after.Left + ',' + $after.Top)

if ($ok) { exit 0 }
exit 2
`;

const PS_HEADER = 'param(';

async function ensureScript() {
  await fs.mkdir(STATE_DIR, { recursive: true });
  let current = '';
  try {
    current = await fs.readFile(SCRIPT_FILE, 'utf8');
  } catch {
    current = '';
  }
  if (current !== PS_SCRIPT) {
    await fs.writeFile(SCRIPT_FILE, PS_SCRIPT, 'utf8');
    await logHost('helper script written to ' + SCRIPT_FILE);
  }
}

function runScript(config, wait) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          SCRIPT_FILE,
          '-Width',
          String(config.width),
          '-Height',
          String(config.height),
          '-LogFile',
          LOG_FILE,
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (error) {
      settle({ ok: false, error: describeError(error) });
      return;
    }
    let output = '';
    if (child.stdout) child.stdout.on('data', (chunk) => { output += String(chunk); });
    if (child.stderr) child.stderr.on('data', (chunk) => { output += String(chunk); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { }
      settle({ ok: false, error: 'helper timed out', tail: '' });
    }, SCRIPT_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      settle({ ok: false, error: describeError(error) });
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      const tail = await readLogTail(4);
      settle({ ok: code === 0, code, output: output.slice(-500), tail });
    });
    if (!wait) {
      child.unref();
      settle({ ok: true, started: true });
    }
  });
}

async function applySize(config, wait) {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'only Windows is supported' };
  }
  try {
    await ensureScript();
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
  const result = await runScript(config, wait);
  await logHost('apply ' + config.width + 'x' + config.height + ' -> ' + JSON.stringify(result));
  return result;
}

async function autoApply() {
  if (autoApplied) return;
  autoApplied = true;
  const config = await readConfig();
  if (!config.enabled) {
    await logHost('auto apply skipped: disabled');
    return;
  }
  const result = await applySize(config, false);
  await logHost('auto apply started: ' + JSON.stringify(result));
}

/* --------------------------------------------------------------------- route */

function describeError(error) {
  if (error && typeof error.message === 'string' && error.message) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function refusal(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

function reply(rpcId, result) {
  return Response.json({ type: 'server-response', rpcId, result });
}

async function handle(request) {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  let raw;
  try {
    raw = await request.text();
  } catch {
    return new Response('body is unreadable', { status: 400 });
  }
  if (raw.length > 32 * 1024) return new Response('body too large', { status: 413 });
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return new Response('body is not JSON', { status: 400 });
  }
  const rpcId = message && typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request';
  if (!message || message.type !== 'client-request' || message.method !== ENDPOINT) {
    return reply(rpcId, refusal('gateway/bad-request', 'This is not a dsh-startup-window request.'));
  }
  const call = message.payload && typeof message.payload === 'object' ? message.payload : {};
  const method = typeof call.method === 'string' ? call.method : '';
  try {
    if (method === 'load') {
      const config = await readConfig();
      return reply(rpcId, { ok: true, value: { config, file: CONFIG_FILE, log: LOG_FILE, platform: process.platform } });
    }
    if (method === 'save') {
      const config = normalizeConfig(call.payload && call.payload.config);
      await writeConfig(config);
      await logHost('config saved: ' + JSON.stringify(config));
      return reply(rpcId, { ok: true, value: { config, file: CONFIG_FILE } });
    }
    if (method === 'apply') {
      const config = normalizeConfig(call.payload && call.payload.config);
      const result = await applySize(config, true);
      return reply(rpcId, { ok: true, value: { result, file: LOG_FILE } });
    }
    if (method === 'status') {
      const tail = await readLogTail(8);
      return reply(rpcId, { ok: true, value: { tail, log: LOG_FILE } });
    }
    return reply(rpcId, refusal('unknown-method', 'Unknown method: ' + String(call.method)));
  } catch (error) {
    await logHost('request ' + (method || '?') + ' failed: ' + describeError(error));
    return reply(rpcId, refusal('handler-failed', describeError(error)));
  }
}

function mount(scope) {
  const connection = scope.connection || (typeof scope.get === 'function' ? scope.get('connection') : null);
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') return null;
  return connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handle(request),
  });
}

export function apply(ctx) {
  let disposed = false;
  let dispose = null;
  let retry = null;

  logHost('apply: host half starting');

  const attach = (scope) => {
    if (disposed || dispose) return;
    try {
      dispose = mount(scope);
    } catch (error) {
      logHost('mount failed: ' + describeError(error));
    }
    if (dispose) {
      logHost('route mounted at ' + ROUTE_PATH);
      setTimeout(() => {
        if (!disposed) autoApply();
      }, AUTO_DELAY_MS);
      return;
    }
    if (!disposed) retry = setTimeout(() => attach(scope), 1000);
  };

  try {
    if (typeof ctx.inject === 'function') ctx.inject(['connection'], attach);
    else attach(ctx);
  } catch (error) {
    logHost('host half could not start: ' + describeError(error));
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(
      () => () => {
        disposed = true;
        if (retry) clearTimeout(retry);
        retry = null;
        if (typeof dispose === 'function') {
          try { dispose(); } catch { }
        }
        dispose = null;
      },
      PACKAGE + ': settings route'
    );
  }
}
