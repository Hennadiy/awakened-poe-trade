import { uIOhook } from 'uiohook-napi'
import { createCraftMatcher, CraftMatcher } from '../../../ipc/craft-regex'
import { HookHotkey, parseHookHotkey, isHookHotkey } from './hook-hotkey'
import { MouseClicker } from './MouseClicker'
import type { HostClipboard } from './HostClipboard'
import type { GameWindow } from '../windowing/GameWindow'
import type { ServerEvents } from '../server'
import type { Logger } from '../RemoteLogger'

// A key that left clicks, unless the item under the cursor already matches
// the stop pattern: then it doesn't click and the overlay plays a sound.
// One click per key press, holding the key does not repeat.

// how long an unchanged item counts as "not updated yet" after a click;
// after that the click is assumed to have done nothing (e.g. no currency on cursor)
const STALE_ITEM_MS = 1500
export class CraftClick {
  private hotkey: HookHotkey | null = null
  private matcher: CraftMatcher | null = null
  private keyDown = false
  private busy = false
  private lastClick: { text: string, at: number } | undefined
  private clicker: MouseClicker
  private shortcut = ''

  constructor (
    private poeWindow: GameWindow,
    private server: ServerEvents,
    private logger: Logger,
    private clipboard: HostClipboard,
    private copyItemText: (hotkey: string) => void
  ) {
    this.clicker = new MouseClicker(logger)

    uIOhook.on('keydown', (e) => {
      if (!isHookHotkey(e, this.hotkey)) return
      if (this.keyDown) return // auto-repeat
      this.keyDown = true
      if (this.poeWindow.isActive) this.trigger()
    })
    uIOhook.on('keyup', (e) => {
      if (isHookHotkey(e, this.hotkey)) this.keyDown = false
    })
  }

  update (shortcut: string | null, stopPattern: string) {
    this.shortcut = shortcut ?? ''
    this.hotkey = parseHookHotkey(shortcut)
    const matcher = createCraftMatcher(stopPattern)
    if (matcher instanceof Error) {
      this.logger.write(`error [CraftClick] Stop pattern: ${matcher.message}`)
      this.matcher = null
    } else {
      this.matcher = matcher
    }
    if (this.hotkey) {
      this.clicker.start()
    } else {
      this.clicker.stop()
    }
  }

  private trigger () {
    if (this.busy) return
    if (!this.clicker.isReady) {
      this.logger.write('warn [CraftClick] Clicker is still starting, press again.')
      return
    }
    this.busy = true

    this.clipboard.readItemText()
      .then(text => {
        if (this.matcher?.test(text)) {
          this.logger.write('info [CraftClick] Item matches the stop pattern, not clicking.')
          this.server.sendEventTo('broadcast', {
            name: 'MAIN->CLIENT::widget-action',
            payload: { target: 'craft-click:stop' }
          })
        } else if (
          this.lastClick?.text === text &&
          Date.now() - this.lastClick.at < STALE_ITEM_MS
        ) {
          // The game updates the item a moment after the click (server round trip).
          // Clicking on the old text could reroll an item that already matches.
          this.logger.write('info [CraftClick] Item has not changed since the last click yet, not clicking.')
        } else if (this.poeWindow.isActive) {
          if (this.clicker.click()) {
            this.lastClick = { text, at: Date.now() }
          }
        }
      })
      .catch(() => {
        this.logger.write('warn [CraftClick] No item under the cursor, not clicking.')
      })
      .finally(() => { this.busy = false })

    this.copyItemText(this.shortcut)
  }
}
