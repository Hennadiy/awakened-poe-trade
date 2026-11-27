import { app } from 'electron'
import { uIOhook, UiohookKey } from 'uiohook-napi'
import { HookHotkey, parseHookHotkey, isHookHotkey, isNumpadNavForm } from './hook-hotkey'
import type { GameWindow } from '../windowing/GameWindow'
import type { ServerEvents } from '../server'

// Keeps Shift pressed in the game window, e.g. to keep using a currency item.
// Shift is let go while the game is not focused (so other apps don't get it)
// and pressed again when the game is focused. If Shift goes up while held
// (Windows' fake releases, or a tap on the keyboard) it is pressed again;
// only the hotkey or the on-screen badge turn the hold off.
export class ShiftHold {
  private enabled = false
  private pressed = false
  private pauseTimer: NodeJS.Timeout | undefined
  private repressTimer: NodeJS.Timeout | undefined
  private ownKeyupUntil = 0
  private changeListener: (() => void) | undefined

  private hotkey: HookHotkey | null = null
  private hotkeyDown = false
  private releaseOnHotkeyUp = false

  constructor (
    private poeWindow: GameWindow,
    private server: ServerEvents
  ) {
    this.poeWindow.on('active-change', () => {
      process.nextTick(() => { this.sync() })
    })

    uIOhook.on('keydown', (e) => {
      if (e.keycode === UiohookKey.Shift) {
        // only track Shift while holding, never touch a Shift held by the user
        if (this.enabled) {
          this.pressed = true
          clearTimeout(this.repressTimer)
        }
        return
      }
      if (isHookHotkey(e, this.hotkey)) {
        if (this.hotkeyDown) return // auto-repeat
        this.hotkeyDown = true
        if (!this.poeWindow.isActive) return
        this.toggle()
        this.releaseOnHotkeyUp = !this.enabled && isNumpadNavForm(e, this.hotkey!)
      }
    })

    uIOhook.on('keyup', (e) => {
      if (e.keycode === UiohookKey.Shift) {
        if (!this.enabled || Date.now() < this.ownKeyupUntil) return
        this.pressed = false
        // press again unless Windows does it itself right away
        clearTimeout(this.repressTimer)
        this.repressTimer = setTimeout(() => { this.sync() }, 50)
        return
      }
      if (isHookHotkey(e, this.hotkey)) {
        this.hotkeyDown = false
        if (this.releaseOnHotkeyUp) {
          this.releaseOnHotkeyUp = false
          // Windows presses Shift again after a numpad key it faked a release for
          setTimeout(() => {
            if (!this.enabled) this.forceRelease()
          }, 30)
        }
      }
    })

    this.server.onEventAnyClient('CLIENT->MAIN::user-action', (e) => {
      if (e.action === 'hold-shift') {
        this.set(e.held)
      }
    })

    app.on('will-quit', () => { this.release() })
  }

  get isHeld () {
    return this.enabled
  }

  onChange (cb: () => void) {
    this.changeListener = cb
  }

  setHotkey (shortcut: string | null) {
    this.hotkey = parseHookHotkey(shortcut)
  }

  toggle () {
    this.set(!this.enabled)
  }

  // let go of Shift while a hotkey action sends its own keys
  pause (ms = 300) {
    if (!this.enabled) return
    clearTimeout(this.pauseTimer)
    this.release()
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = undefined
      this.sync()
    }, ms)
  }

  private set (enabled: boolean) {
    const changed = this.enabled !== enabled
    this.enabled = enabled
    if (!enabled) {
      clearTimeout(this.pauseTimer)
      this.pauseTimer = undefined
      clearTimeout(this.repressTimer)
    }
    this.sync()
    if (changed) {
      this.server.sendEventTo('broadcast', {
        name: 'MAIN->CLIENT::widget-action',
        payload: { target: enabled ? 'hold-shift:on' : 'hold-shift:off' }
      })
      this.changeListener?.()
    }
  }

  private sync () {
    const shouldPress = this.enabled && this.poeWindow.isActive && !this.pauseTimer
    if (shouldPress && !this.pressed) {
      uIOhook.keyToggle(UiohookKey.Shift, 'down')
      this.pressed = true
    } else if (!shouldPress && this.pressed) {
      this.release()
    }
  }

  private release () {
    if (!this.pressed) return
    this.forceRelease()
  }

  private forceRelease () {
    this.ownKeyupUntil = Date.now() + 200
    uIOhook.keyToggle(UiohookKey.Shift, 'up')
    this.pressed = false
  }
}
