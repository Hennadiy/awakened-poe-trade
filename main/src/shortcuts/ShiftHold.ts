import { app } from 'electron'
import { uIOhook, UiohookKey } from 'uiohook-napi'
import type { GameWindow } from '../windowing/GameWindow'
import type { ServerEvents } from '../server'

// Keeps Shift pressed in the game window, e.g. to keep using a currency item.
// Shift is let go while the game is not focused (so other apps don't get it)
// and pressed again when the game is focused. Pressing and releasing Shift
// on the keyboard turns the hold off.
export class ShiftHold {
  private enabled = false
  private pressed = false
  private pauseTimer: NodeJS.Timeout | undefined
  private ownKeyupUntil = 0
  private changeListener: (() => void) | undefined

  constructor (
    private poeWindow: GameWindow,
    private server: ServerEvents
  ) {
    this.poeWindow.on('active-change', () => {
      process.nextTick(() => { this.sync() })
    })

    uIOhook.on('keyup', (e) => {
      if (e.keycode !== UiohookKey.Shift || !this.pressed) return
      if (Date.now() < this.ownKeyupUntil) return
      // released on the keyboard, the game no longer sees Shift pressed
      this.pressed = false
      this.set(false)
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
    if (!enabled) clearTimeout(this.pauseTimer)
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
    this.ownKeyupUntil = Date.now() + 200
    uIOhook.keyToggle(UiohookKey.Shift, 'up')
    this.pressed = false
  }
}
