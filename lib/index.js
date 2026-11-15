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
// The helper appends its own diagnostics here, never to host.log: host.log also
// records the outcome line, and reading the tail of a shared file made every
// outcome embed the previous outcome (exponential nesting).
const HELPER_LOG = path.join(STATE_DIR, 'resize.log');
const BOOT = Math.random().toString(36).slice(2, 8);
const MIN_WIDTH = 520;
const MIN_HEIGHT = 600;
const MAX_SIDE = 7680;
const DEFAULT_CONFIG = { enabled: true, width: 1280, height: 820 };
const AUTO_DELAY_MS = 2500;
const SCRIPT_TIMEOUT_MS = 40000;

let autoApplied = false;

/* ------------------------------------------------------------------ logging */

const LOG_MAX_BYTES = 512 * 1024;
const LOG_TAIL_BYTES = 32 * 1024;
let logWrites = 0;

async function logHost(line) {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.appendFile(LOG_FILE, new Date().toISOString() + ' [' + BOOT + '] ' + line + '\n', 'utf8');
    if (++logWrites % 128 === 0) await rotateLog();
  } catch {
    /* logging must never break a request */
  }
}

async function rotateLog() {
  try {
    const info = await fs.stat(LOG_FILE);
    if (info.size < LOG_MAX_BYTES) return;
    await fs.rm(LOG_FILE + '.1', { force: true });
    await fs.rename(LOG_FILE, LOG_FILE + '.1');
  } catch {
    /* rotation is best-effort: never fail a request over it */
  }
}

async function rotateHelperLog() {
  try {
    const info = await fs.stat(HELPER_LOG);
    if (info.size < LOG_MAX_BYTES) return;
    await fs.rm(HELPER_LOG + '.1', { force: true });
    await fs.rename(HELPER_LOG, HELPER_LOG + '.1');
  } catch {
    /* rotation is best-effort */
  }
}

async function readLogTail(lines) {
  let handle = null;
  try {
    handle = await fs.open(HELPER_LOG, 'r');
    const info = await handle.stat();
    const length = Math.min(info.size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, info.size - length);
    const all = buffer.toString('utf8').split('\n').filter(Boolean);
    return all.slice(-(lines || 6)).join('\n');
  } catch {
    return '';
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }
}

/* ------------------------------------------------------------------- config */

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function parseEnabled(value) {
  if (value === false || value === 0) return false;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false;
  }
  return true;
}

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: parseEnabled(source.enabled),
    width: clampInt(source.width, MIN_WIDTH, MAX_SIDE, DEFAULT_CONFIG.width),
    height: clampInt(source.height, MIN_HEIGHT, MAX_SIDE, DEFAULT_CONFIG.height),
  };
}

async function readConfig() {
  let text;
  try {
    text = await fs.readFile(CONFIG_FILE, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { config: { ...DEFAULT_CONFIG }, problem: null };
    const message = 'cannot read ' + CONFIG_FILE + ': ' + describeError(error);
    await logHost('config unreadable: ' + describeError(error));
    return { config: { ...DEFAULT_CONFIG }, problem: { code: 'config-unreadable', message } };
  }
  try {
    return { config: normalizeConfig(JSON.parse(text)), problem: null };
  } catch (error) {
    const backup = CONFIG_FILE + '.broken-' + Date.now();
    let message = 'cannot parse ' + CONFIG_FILE + ': ' + describeError(error) + '; defaults used';
    try {
      await fs.rename(CONFIG_FILE, backup);
      message += '; backup at ' + backup;
    } catch {
      message += '; the original file could not be backed up';
    }
    await logHost('config corrupt: ' + describeError(error));
    return { config: { ...DEFAULT_CONFIG }, problem: { code: 'config-corrupt', message } };
  }
}

let configWrites = 0;

async function writeConfig(config) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const tmp = CONFIG_FILE + '.' + process.pid + '.' + (++configWrites) + '.tmp';
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
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("kernel32.dll")] public static extern uint GetLastError();
}
"@

try { [void][DwsWin]::SetProcessDpiAwareness(2) } catch { try { [void][DwsWin]::SetProcessDPIAware() } catch { } }

$script:ownPids = New-Object System.Collections.Generic.HashSet[int]
$script:allPids = New-Object System.Collections.Generic.HashSet[int]
$script:pids = $script:ownPids
$script:phase = 'ancestry'

# Prefer this process's own ancestor chain: the Host runs under the desktop app.
try {
  $cursor = $PID
  for ($i = 0; $i -lt 12; $i++) {
    $info = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $cursor) -ErrorAction SilentlyContinue
    if (-not $info) { break }
    if ($info.Name -like '*DeepSeek Harness*') {
      [void]$script:ownPids.Add([int]$cursor)
      [void]$script:allPids.Add([int]$cursor)
    }
    $cursor = [int]$info.ParentProcessId
    if ($cursor -le 4) { break }
  }
} catch { Write-Log ('ancestry lookup failed: ' + $_.Exception.Message) }

# Fallback (and second opinion): every process named like the desktop app.
try {
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DeepSeek Harness*' } | ForEach-Object { [void]$script:allPids.Add([int]$_.Id) }
} catch { }

if ($script:allPids.Count -eq 0) {
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

# Phase 1: only the app processes this helper was spawned under, i.e. our own
# instance. Phase 2 is the last resort: any process named like the desktop app.
# Keeping them apart stops a second DSH instance from resizing the window of
# the first one.
$target = [IntPtr]::Zero
if ($script:ownPids.Count -gt 0) {
  $script:pids = $script:ownPids
  $script:phase = 'ancestry'
  for ($i = 0; $i -lt 20; $i++) {
    $target = Find-MainWindow
    if ($target -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 500
  }
}
if ($target -eq [IntPtr]::Zero) {
  $script:pids = $script:allPids
  $script:phase = 'all-processes'
  for ($i = 0; $i -lt 24; $i++) {
    $target = Find-MainWindow
    if ($target -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 500
  }
}

if ($target -eq [IntPtr]::Zero) {
  Write-Log ('no main window after waiting; phase=' + $script:phase + ' pids=' + ($script:pids -join ','))
  exit 4
}

Write-Log ('window matched via ' + $script:phase + ' pids=' + ($script:pids -join ','))

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
  # Last resort: the primary screen (SM_CXSCREEN / SM_CYSCREEN). It is a real
  # screen at origin 0,0, so centring stays sane even when the window lives at
  # some other offset.
  $work.rcWork.Left = 0
  $work.rcWork.Top = 0
  $work.rcWork.Right = [DwsWin]::GetSystemMetrics(0)
  $work.rcWork.Bottom = [DwsWin]::GetSystemMetrics(1)
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

async function ensureScript() {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await rotateHelperLog();
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
          HELPER_LOG,
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (error) {
      settle(failure('spawn-failed', describeError(error)));
      return;
    }
    let output = '';
    if (child.stdout) child.stdout.on('data', (chunk) => { output += String(chunk); });
    if (child.stderr) child.stderr.on('data', (chunk) => { output += String(chunk); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { }
      settle(failure('helper-timeout', 'helper timed out after ' + SCRIPT_TIMEOUT_MS + 'ms'));
    }, SCRIPT_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      settle(failure('helper-failed', describeError(error)));
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      const tail = await readLogTail(4);
      if (code === 0) {
        settle({ ok: true, code, output: output.slice(-500), tail });
      } else {
        settle(failure('helper-exit', 'helper exited with code ' + code, {
          exitCode: code,
          output: output.slice(-500),
          tail,
        }));
      }
    });
    if (!wait) {
      child.unref();
      settle({ ok: true, started: true });
    }
  });
}

async function applySize(config, wait) {
  if (process.platform !== 'win32') {
    return failure('unsupported-platform', 'only Windows is supported');
  }
  try {
    await ensureScript();
  } catch (error) {
    return failure('script-write-failed', describeError(error));
  }
  const result = await runScript(config, wait);
  await logHost(
    'apply ' + config.width + 'x' + config.height +
      ' -> ok=' + String(result.ok) +
      (result.error ? ' error=' + result.error.code : '') +
      (result.started ? ' started' : '')
  );
  return result;
}

async function autoApply() {
  if (autoApplied) return;
  autoApplied = true;
  const loaded = await readConfig();
  if (loaded.problem) await logHost('auto apply: ' + loaded.problem.message);
  const config = loaded.config;
  if (!config.enabled) {
    await logHost('auto apply skipped: disabled');
    return;
  }
  const result = await applySize(config, false);
  await logHost('auto apply started: ok=' + String(result.ok) + (result.error ? ' error=' + result.error.code : ''));
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

function failure(code, message, extra) {
  return Object.assign({ ok: false, error: { code, message, details: {} } }, extra || {});
}

let operationChain = Promise.resolve();

/** Run state-changing work one task at a time (save + apply never interleave). */
function serialize(task) {
  const next = operationChain.then(task, task);
  operationChain = next.then(() => undefined, () => undefined);
  return next;
}

function reply(rpcId, result) {
  return Response.json({ type: 'server-response', rpcId, result });
}

const MAX_BODY_BYTES = 32 * 1024;

/**
 * Defence in depth for the route itself: the RPC gateway already authenticates
 * browser connections, but a cross-site page must never be able to reach a
 * handler that writes files and spawns processes. Requests without an Origin
 * header (the desktop shell's own fetch) are allowed through.
 */
function isTrustedOrigin(request) {
  let origin = '';
  try { origin = request.headers.get('origin') || ''; } catch { origin = ''; }
  // No Origin header: the shell's own fetch, or a carrier that does not send one.
  if (!origin) return true;
  // "null" is what a file:// or sandboxed renderer sends; those are local too.
  if (origin === 'null') return true;
  let parsed = null;
  try { parsed = new URL(origin); } catch { return true; }
  // Non-HTTP origins (app://, chrome-extension://) are not remote web pages.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
  const host = parsed.hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

async function handle(request) {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  if (!isTrustedOrigin(request)) return new Response('origin not allowed', { status: 403 });
  let declared = 0;
  try { declared = Number(request.headers.get('content-length') || 0); } catch { declared = 0; }
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return new Response('body too large', { status: 413 });
  let raw;
  try {
    raw = await request.text();
  } catch {
    return new Response('body is unreadable', { status: 400 });
  }
  if (raw.length > MAX_BODY_BYTES) return new Response('body too large', { status: 413 });
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
      const loaded = await readConfig();
      return reply(rpcId, {
        ok: true,
        value: {
          config: loaded.config,
          problem: loaded.problem,
          file: CONFIG_FILE,
          log: LOG_FILE,
          platform: process.platform,
        },
      });
    }
    if (method === 'save') {
      const config = normalizeConfig(call.payload && call.payload.config);
      const saved = await serialize(async () => {
        await writeConfig(config);
        await logHost('config saved: ' + JSON.stringify(config));
        return { config, file: CONFIG_FILE };
      });
      return reply(rpcId, { ok: true, value: saved });
    }
    if (method === 'apply') {
      const config = normalizeConfig(call.payload && call.payload.config);
      const result = await serialize(() => applySize(config, true));
      return reply(rpcId, { ok: true, value: { result, config, file: CONFIG_FILE, log: LOG_FILE } });
    }
    if (method === 'status') {
      const tail = await readLogTail(8);
      return reply(rpcId, { ok: true, value: { tail, log: HELPER_LOG } });
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
  let retries = 0;

  logHost('apply: host half starting');
  // A re-applied host half (reload, settings toggle) must run its boot pass again.
  autoApplied = false;

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
    if (!disposed) {
      retries += 1;
      if (retries === 1 || retries % 30 === 0) {
        logHost('connection service not ready; retry #' + retries);
      }
      retry = setTimeout(() => attach(scope), 1000);
    }
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
