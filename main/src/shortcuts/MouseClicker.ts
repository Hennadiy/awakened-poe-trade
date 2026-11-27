import { spawn, ChildProcess } from 'child_process'
import { app } from 'electron'
import type { Logger } from '../RemoteLogger'

// Left clicks at the cursor through user32's mouse_event.
// uiohook-napi can only send keys, so a hidden PowerShell process
// compiles a tiny C# wrapper once and then clicks on each "click" line.
const SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AptMouse {
  [DllImport("user32.dll")]
  static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public static void LeftClick() {
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
"@
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'click') { [AptMouse]::LeftClick() }
}
`

export class MouseClicker {
  private proc: ChildProcess | undefined
  private ready = false

  constructor (private logger: Logger) {
    app.on('will-quit', () => { this.stop() })
  }

  get isReady () {
    return this.ready
  }

  start () {
    if (this.proc || process.platform !== 'win32') return
    const proc = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc

    proc.stdout!.setEncoding('utf8')
    proc.stdout!.on('data', (chunk: string) => {
      if (!this.ready && chunk.includes('ready')) {
        this.ready = true
        this.logger.write('info [MouseClicker] Ready.')
      }
    })
    proc.stderr!.setEncoding('utf8')
    proc.stderr!.on('data', (chunk: string) => {
      // PowerShell reports progress as CLIXML when stderr is redirected
      if (chunk.includes('CLIXML') || chunk.includes('S="progress"')) return
      this.logger.write(`error [MouseClicker] ${chunk.trim()}`)
    })
    proc.on('exit', (code) => {
      if (this.proc === proc) {
        this.proc = undefined
        this.ready = false
        this.logger.write(`warn [MouseClicker] Stopped (exit code ${code}).`)
      }
    })
  }

  stop () {
    const { proc } = this
    this.proc = undefined
    this.ready = false
    proc?.stdin?.end()
  }

  // Clicks only once the helper is up: a click queued during startup
  // would land a second later, wherever the cursor is by then.
  click (): boolean {
    if (!this.ready || !this.proc) return false
    this.proc.stdin!.write('click\n')
    return true
  }
}
