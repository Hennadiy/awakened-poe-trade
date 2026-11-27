import { UiohookKey, UiohookKeyboardEvent } from 'uiohook-napi'

type UiohookKeyT = keyof typeof UiohookKey

// With Num Lock on and Shift down, Windows turns numpad keys into
// Insert/End/... and sends a fake Shift release around them.
// The hook then reports e.g. NumpadInsert (0xEE52) instead of Numpad0 (0x52).
const NUMPAD_NAV = 0xEE00

export interface HookHotkey {
  keycode: number
  ctrl: boolean
  alt: boolean
}

// Hotkeys read from the keyboard hook rather than registered with the OS:
// they work the same while Shift is held by the "Hold Shift" feature.
export function parseHookHotkey (shortcut: string | null | undefined): HookHotkey | null {
  const keys = shortcut?.split(' + ') ?? []
  const key = keys.find(k => k !== 'Ctrl' && k !== 'Alt' && k !== 'Shift')
  const keycode = key ? UiohookKey[key as UiohookKeyT] : undefined
  return (keycode != null)
    ? { keycode, ctrl: keys.includes('Ctrl'), alt: keys.includes('Alt') }
    : null
}

// Shift is ignored, it may be held by us
export function isHookHotkey (e: UiohookKeyboardEvent, hotkey: HookHotkey | null): boolean {
  if (!hotkey) return false
  return (e.keycode === hotkey.keycode || e.keycode === (NUMPAD_NAV | hotkey.keycode)) &&
    e.ctrlKey === hotkey.ctrl &&
    e.altKey === hotkey.alt
}

export function isNumpadNavForm (e: UiohookKeyboardEvent, hotkey: HookHotkey) {
  return e.keycode !== hotkey.keycode
}
