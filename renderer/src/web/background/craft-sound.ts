let ctx: AudioContext | undefined

// short rising two-tone chime, played when the craft click key
// finds the item already matching the stop pattern
export function playCraftStopSound () {
  ctx ??= new AudioContext()
  ctx.resume().catch(() => {})
  const t = ctx.currentTime
  ;[880, 1320].forEach((freq, i) => {
    const osc = ctx!.createOscillator()
    const gain = ctx!.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    const start = t + i * 0.13
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(0.35, start + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12)
    osc.connect(gain).connect(ctx!.destination)
    osc.start(start)
    osc.stop(start + 0.13)
  })
}
