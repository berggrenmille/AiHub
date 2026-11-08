import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { OfficeStatus } from "../office-status.ts";
import { powershellArgs, powershellPath } from "./powershell.ts";

// The notification-area icon of the background daemon (DESIGN.md › Windows lifecycle). Node can't
// add one, so a Windows PowerShell helper shows it with Windows Forms. The daemon sends the helper
// what to show, one JSON line at a time on its stdin, and the helper says on its stdout when the
// operator chose Quit. Opening the office or the notes folder the helper does itself. It ends when
// its stdin closes, so the icon never outlives the daemon.

export interface TrayOptions {
  /** The name on the icon and its menu, such as "AiHub". */
  name: string;
  /** The office, opened by a click on the icon. */
  url: string;
  /** The .ico file the icon shows. */
  icon: string;
  /** The staff's notes folder, which the menu opens. */
  notesDir: string;
  /** The operator chose Quit. */
  onQuit: () => void;
  log?: (message: string) => void;
  /** Tests replace how the helper starts. */
  spawn?: typeof nodeSpawn;
  restartDelayMs?: number;
}

/** The tooltip Windows Forms accepts is at most 63 characters. */
const TIP_LENGTH = 63;
/** A helper that stops on its own is started again, a few times. */
const MAX_RESTARTS = 3;

export class Tray {
  private readonly spawn: typeof nodeSpawn;
  private readonly log: (message: string) => void;
  private helper: ChildProcess | null = null;
  private line: string | null = null;
  private restarts = 0;
  private closed = false;

  constructor(private readonly options: TrayOptions) {
    this.spawn = options.spawn ?? nodeSpawn;
    this.log = options.log ?? ((message) => console.warn(`[tray] ${message}`));
  }

  start() {
    if (this.closed || this.helper) return;
    let helper: ChildProcess;
    try {
      helper = this.spawn(powershellPath(), powershellArgs(TRAY_SCRIPT), {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          AIHUB_TRAY_NAME: this.options.name,
          AIHUB_TRAY_URL: this.options.url,
          AIHUB_TRAY_ICON: this.options.icon,
          AIHUB_TRAY_NOTES: this.options.notesDir,
        },
      });
    } catch (error) {
      this.log(`Couldn't show the tray icon: ${String(error)}`);
      return;
    }
    this.helper = helper;
    let errors = "";
    let pending = "";
    helper.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        this.heard(pending.slice(0, end).trim());
        pending = pending.slice(end + 1);
      }
    });
    helper.stderr?.setEncoding("utf8").on("data", (chunk: string) => (errors = (errors + chunk).slice(-2_000)));
    // A helper that already exited can't take its stdin; that shows in its exit instead.
    helper.stdin?.on("error", () => {});
    helper.on("error", (error) => {
      if (this.helper === helper) this.helper = null;
      this.log(`Couldn't show the tray icon: ${error.message}`);
    });
    helper.on("exit", (code) => {
      if (this.helper !== helper) return;
      this.helper = null;
      this.log(`The tray icon's helper stopped (exit code ${code}): ${errors.trim() || "no reason given"}`);
      if (this.closed || this.restarts >= MAX_RESTARTS) return;
      this.restarts++;
      setTimeout(() => this.start(), this.options.restartDelayMs ?? 10_000).unref();
    });
    if (this.line) helper.stdin?.write(this.line);
  }

  /** Shows the office's status on the icon and in its menu. The same status again sends nothing. */
  show(status: OfficeStatus) {
    const lead = status.needs[0] ?? status.status;
    const line = `${JSON.stringify({ ...status, tip: tip(`${this.options.name}: ${lead}`) })}\n`;
    if (line === this.line) return;
    this.line = line;
    this.helper?.stdin?.write(line);
  }

  /** Removes the icon. */
  close() {
    this.closed = true;
    const helper = this.helper;
    this.helper = null;
    if (!helper) return;
    helper.stdin?.end();
    // Closing stdin ends the helper at once; this is for one that hangs.
    setTimeout(() => {
      if (helper.exitCode === null) helper.kill();
    }, 5_000).unref();
  }

  private heard(word: string) {
    if (word === "quit") this.options.onQuit();
    else if (word.startsWith("error ")) this.log(word.slice("error ".length));
  }
}

function tip(text: string): string {
  return text.length <= TIP_LENGTH ? text : `${text.slice(0, TIP_LENGTH - 1).trimEnd()}…`;
}

/**
 * Shows the icon until stdin closes. A click opens the office; the menu shows the status, what
 * needs the operator, and Open, notes, and Quit. Each line on stdin is the status to show, as JSON.
 * Says "ready" once the icon is up, "quit" when the operator chooses Quit, and "error …" when
 * something it opens fails.
 */
export const TRAY_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $size = [System.Windows.Forms.SystemInformation]::SmallIconSize
  $plain = New-Object System.Drawing.Icon -ArgumentList $env:AIHUB_TRAY_ICON, $size
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}

function Say([string]$word) {
  [Console]::Out.WriteLine($word)
  [Console]::Out.Flush()
}

function Open-Target([string]$target) {
  try { Start-Process -FilePath $target } catch { Say ('error Couldn''t open ' + $target + ': ' + $_.Exception.Message) }
}

# A click can come as two, from a double-click: the office opens once.
$script:opened = [DateTime]::MinValue
function Open-Office {
  $now = [DateTime]::UtcNow
  if (($now - $script:opened).TotalMilliseconds -lt 1500) { return }
  $script:opened = $now
  Open-Target $env:AIHUB_TRAY_URL
}

# The same icon with a dot, for when something needs the operator.
$bitmap = $plain.ToBitmap()
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$dot = [Math]::Max(6, [int][Math]::Round($bitmap.Width * 0.5))
$left = $bitmap.Width - $dot
$graphics.FillEllipse([System.Drawing.Brushes]::White, $left, 0, $dot, $dot)
$amber = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 234, 88, 12))
$graphics.FillEllipse($amber, $left + 1, 1, $dot - 2, $dot - 2)
$graphics.Dispose()
$marked = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$status = New-Object System.Windows.Forms.ToolStripMenuItem ('Starting ' + $env:AIHUB_TRAY_NAME)
$status.Enabled = $false
[void]$menu.Items.Add($status)
$script:needs = @()
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$open = New-Object System.Windows.Forms.ToolStripMenuItem ('Open ' + $env:AIHUB_TRAY_NAME)
$open.Font = New-Object System.Drawing.Font -ArgumentList $open.Font, ([System.Drawing.FontStyle]::Bold)
$open.add_Click({ Open-Office })
[void]$menu.Items.Add($open)
$notes = New-Object System.Windows.Forms.ToolStripMenuItem 'Open staff notes'
$notes.add_Click({ Open-Target $env:AIHUB_TRAY_NOTES })
[void]$menu.Items.Add($notes)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$quit = New-Object System.Windows.Forms.ToolStripMenuItem ('Quit ' + $env:AIHUB_TRAY_NAME)
$quit.add_Click({
  $tray.Visible = $false
  Say 'quit'
})
[void]$menu.Items.Add($quit)

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $plain
$tray.Text = $env:AIHUB_TRAY_NAME
$tray.ContextMenuStrip = $menu
$tray.add_MouseClick({
  param($source, $click)
  if ($click.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Office }
})

function Show-State($state) {
  $status.Text = [string]$state.status
  foreach ($item in $script:needs) {
    $menu.Items.Remove($item)
    $item.Dispose()
  }
  $script:needs = @()
  $index = 1
  foreach ($line in @($state.needs)) {
    if (-not $line) { continue }
    $item = New-Object System.Windows.Forms.ToolStripMenuItem ([string]$line)
    $item.add_Click({ Open-Office })
    $menu.Items.Insert($index, $item)
    $script:needs += $item
    $index++
  }
  $tip = [string]$state.tip
  if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
  $tray.Text = $tip
  if ($state.attention) { $tray.Icon = $marked } else { $tray.Icon = $plain }
}

# Console.In reads synchronously even when asked to read asynchronously, which would hold up the
# icon, so stdin is read through a stream of its own and checked between window messages.
$stdin = New-Object System.IO.StreamReader -ArgumentList ([Console]::OpenStandardInput()), (New-Object System.Text.UTF8Encoding -ArgumentList $false)
$script:pending = $stdin.ReadLineAsync()
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$timer.add_Tick({
  while ($script:pending.IsCompleted) {
    $line = $null
    if (-not $script:pending.IsFaulted) { $line = $script:pending.Result }
    if ($null -eq $line) {
      $timer.Stop()
      [System.Windows.Forms.Application]::ExitThread()
      return
    }
    try { Show-State ($line | ConvertFrom-Json) } catch { Say ('error The tray icon couldn''t show the status: ' + $_.Exception.Message) }
    $script:pending = $stdin.ReadLineAsync()
  }
})
$timer.Start()
$tray.Visible = $true
Say 'ready'
[System.Windows.Forms.Application]::Run()
$tray.Visible = $false
$tray.Dispose()
`;
