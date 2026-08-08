import { mulberry32, type Rng } from '../sim/rng'

/**
 * The day's music, generated in the browser.
 *
 * Synthesised rather than streamed for the same reason the terrain is: rule 5 says no
 * third-party requests, and the first-load budget is three seconds. A few minutes of
 * ambient piano would be a megabyte of audio and a network round trip; this is a few
 * kilobytes of code that never repeats and never loads anything.
 *
 * Original composition, in the idiom rather than of it — a slow diatonic progression
 * with sevenths and ninths, a music-box voice over a soft pad, played well below
 * conversation level. The key and every bar's ornament come from the day's seed, so
 * the music is part of the day the same way the terrain is: everyone hears the same
 * piece, and tomorrow is a different one.
 *
 * Autoplay is not possible — browsers require a user gesture before audio, and there
 * is no way around that. `attachAutostart` waits for the first click, tap, or key,
 * which is the same gesture that launches the first flight.
 */

/** Seconds per beat. ~66 bpm. */
const BEAT = 0.9
const BEATS_PER_BAR = 4
const BAR = BEAT * BEATS_PER_BAR
/** How far ahead of the clock notes are scheduled. */
const LOOKAHEAD = 2.2
const TICK_MS = 300

const MAJOR = [0, 2, 4, 5, 7, 9, 11]

/**
 * I – V – vi – iii – IV – I – IV – V. The stepwise descending bass under a static
 * melody range is the whole reason this progression feels the way it does, and it is
 * common to a lot of the music the request was pointing at.
 */
const PROGRESSION: Array<{ degree: number; seventh: boolean }> = [
  { degree: 0, seventh: true },
  { degree: 4, seventh: false },
  { degree: 5, seventh: true },
  { degree: 2, seventh: true },
  { degree: 3, seventh: true },
  { degree: 0, seventh: false },
  { degree: 3, seventh: true },
  { degree: 4, seventh: false },
]

/** Comfortable tonics — low enough to stay warm, spread so days sound distinct. */
const TONICS = [174.61, 185.0, 196.0, 207.65, 220.0, 233.08]

export class Music {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private wet: GainNode | null = null
  private timer: number | null = null
  private nextBar = 0
  private bar = 0
  private seed: number
  private tonic: number
  private started = false
  private _muted = false

  constructor(seed: number) {
    this.seed = seed >>> 0
    this.tonic = TONICS[this.seed % TONICS.length]
  }

  get muted() {
    return this._muted
  }

  /**
   * Re-key at the next bar. Only reachable by stepping days in the tuning panel;
   * a real session never changes seed.
   */
  setSeed(seed: number) {
    this.seed = seed >>> 0
    this.tonic = TONICS[this.seed % TONICS.length]
  }

  setMuted(muted: boolean) {
    this._muted = muted
    if (!this.master || !this.ctx) return
    const now = this.ctx.currentTime
    this.master.gain.cancelScheduledValues(now)
    this.master.gain.setValueAtTime(this.master.gain.value, now)
    // A slow ramp, so muting mid-phrase is a fade rather than a cut.
    this.master.gain.linearRampToValueAtTime(muted ? 0.0001 : 1, now + 0.5)
  }

  /** Waits for the first user gesture, then starts. Returns a detach function. */
  attachAutostart(): () => void {
    const go = () => {
      void this.start()
      detach()
    }
    const detach = () => {
      window.removeEventListener('pointerdown', go)
      window.removeEventListener('keydown', go)
      window.removeEventListener('touchstart', go)
    }
    window.addEventListener('pointerdown', go)
    window.addEventListener('keydown', go)
    window.addEventListener('touchstart', go)
    return detach
  }

  async start() {
    if (this.started) return
    this.started = true

    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    this.ctx = ctx
    if (ctx.state === 'suspended') await ctx.resume()

    // Both the dry voices and the reverb return feed `master`, so the mute ramp
    // catches everything. Routing the reverb straight to the output instead left the
    // tail audible through a mute, which is worse than not having a mute.
    //
    //   voices ──────────────► master ─► lowpass ─► trim ─► out
    //   voices ─► wet ─► reverb ─┘
    //
    // The lowpass is what keeps it from ever getting bright enough to demand
    // attention.
    const master = ctx.createGain()
    master.gain.value = this._muted ? 0.0001 : 1

    const tone = ctx.createBiquadFilter()
    tone.type = 'lowpass'
    tone.frequency.value = 3200
    tone.Q.value = 0.4

    const trim = ctx.createGain()
    // Quiet on purpose, but not inaudible: the first pass measured -37 dBFS RMS at
    // the output, which is background to the point of being lost under a fan.
    trim.gain.value = 0.45

    const reverb = ctx.createConvolver()
    reverb.buffer = impulseResponse(ctx, 3.2)
    const wet = ctx.createGain()
    wet.gain.value = 0.55

    master.connect(tone)
    tone.connect(trim)
    wet.connect(reverb)
    reverb.connect(master)
    trim.connect(ctx.destination)

    this.master = master
    this.wet = wet

    this.nextBar = ctx.currentTime + 0.35
    this.timer = window.setInterval(this.tick, TICK_MS)
    this.tick()
  }

  dispose() {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    void this.ctx?.close()
    this.ctx = null
    this.master = null
    this.started = false
  }

  private tick = () => {
    const ctx = this.ctx
    if (!ctx) return
    while (this.nextBar < ctx.currentTime + LOOKAHEAD) {
      this.scheduleBar(this.nextBar, this.bar++)
      this.nextBar += BAR
    }
  }

  private scheduleBar(at: number, index: number) {
    // Seeded per bar, so a given day plays the same piece for everyone, and bar 400
    // is reproducible without keeping any state.
    const rng = mulberry32((this.seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0)
    const chord = PROGRESSION[index % PROGRESSION.length]

    const tones = [0, 2, 4]
    if (chord.seventh) tones.push(6)

    // --- pad: the chord, held across the bar with a long overlap ------------
    for (const t of tones) {
      const semis = degreeSemitone(chord.degree + t)
      this.pad(at, BAR * 1.5, this.hz(semis), 0.055)
    }

    // --- bass: root an octave down, and a fifth halfway on some bars --------
    this.pad(at, BAR * 1.2, this.hz(degreeSemitone(chord.degree) - 12), 0.075)
    if (rng() < 0.4) {
      this.pad(at + BEAT * 2, BAR * 0.7, this.hz(degreeSemitone(chord.degree + 2) - 12), 0.04)
    }

    // --- music box: a broken chord, never quite the same twice --------------
    const notes = 3 + Math.floor(rng() * 3)
    for (let i = 0; i < notes; i++) {
      const beat = (i * BEATS_PER_BAR) / notes + (rng() - 0.5) * 0.18
      const tone = tones[Math.floor(rng() * tones.length)]
      const octave = rng() < 0.35 ? 24 : 12
      this.pluck(at + beat * BEAT, this.hz(degreeSemitone(chord.degree + tone) + octave), 0.085 + rng() * 0.05)
    }

    // --- melody: a short phrase on some bars, silence on the rest -----------
    // The rests matter more than the notes; a line that never stops stops being
    // background.
    if (rng() < 0.55) {
      const start = 1 + Math.floor(rng() * 2)
      const len = 2 + Math.floor(rng() * 2)
      let step = chord.degree + 4 + Math.floor(rng() * 3)
      for (let i = 0; i < len; i++) {
        const beat = start + i * (0.5 + rng() * 0.5)
        if (beat >= BEATS_PER_BAR) break
        this.pluck(at + beat * BEAT, this.hz(degreeSemitone(step) + 24), 0.07 + rng() * 0.04)
        step += rng() < 0.6 ? -1 : 1
      }
    }
  }

  private hz(semitones: number) {
    return this.tonic * Math.pow(2, semitones / 12)
  }

  /** Music-box / celesta voice: fast attack, long soft decay, one bell partial. */
  private pluck(at: number, freq: number, peak: number) {
    const ctx = this.ctx
    if (!ctx || !this.master || !this.wet) return
    if (at < ctx.currentTime) return

    const dur = 2.4 + Math.random() * 0.8
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, at)
    g.gain.linearRampToValueAtTime(peak, at + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur)

    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(Math.min(6000, freq * 8), at)
    lp.frequency.exponentialRampToValueAtTime(Math.max(400, freq * 2), at + dur)

    const a = ctx.createOscillator()
    a.type = 'triangle'
    a.frequency.value = freq

    const b = ctx.createOscillator()
    b.type = 'sine'
    b.frequency.value = freq * 2.01 // slightly sharp, for a little shimmer
    const bg = ctx.createGain()
    bg.gain.value = 0.3

    a.connect(lp)
    b.connect(bg)
    bg.connect(lp)
    lp.connect(g)
    g.connect(this.master)
    g.connect(this.wet)

    a.start(at)
    b.start(at)
    a.stop(at + dur + 0.05)
    b.stop(at + dur + 0.05)
  }

  /** Sustained voice for pad and bass: slow in, slow out, two detuned saws. */
  private pad(at: number, dur: number, freq: number, peak: number) {
    const ctx = this.ctx
    if (!ctx || !this.master || !this.wet) return
    if (at < ctx.currentTime) return

    const g = ctx.createGain()
    g.gain.setValueAtTime(0, at)
    g.gain.linearRampToValueAtTime(peak, at + dur * 0.35)
    g.gain.linearRampToValueAtTime(0.0001, at + dur)

    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = Math.max(320, freq * 3.2)
    lp.Q.value = 0.6

    const a = ctx.createOscillator()
    a.type = 'triangle'
    a.frequency.value = freq
    const b = ctx.createOscillator()
    b.type = 'triangle'
    b.frequency.value = freq * 1.004 // slow beating between the two
    b.detune.value = -4

    a.connect(lp)
    b.connect(lp)
    lp.connect(g)
    g.connect(this.master)
    g.connect(this.wet)

    a.start(at)
    b.start(at)
    a.stop(at + dur + 0.05)
    b.stop(at + dur + 0.05)
  }
}

/** Chromatic offset of a scale degree, wrapping octaves above the seventh. */
function degreeSemitone(degree: number): number {
  const octave = Math.floor(degree / 7)
  const i = degree - octave * 7
  return MAJOR[i] + octave * 12
}

/**
 * Decaying-noise impulse response. A generated hall rather than a sampled one — same
 * reasoning as everything else here, and for a wash this diffuse the difference is
 * inaudible.
 */
function impulseResponse(ctx: AudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate
  const len = Math.floor(rate * seconds)
  const buf = ctx.createBuffer(2, len, rate)
  const preDelay = Math.floor(rate * 0.02)
  const rng: Rng = mulberry32(0x5eaf00d)

  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch)
    for (let i = 0; i < len; i++) {
      if (i < preDelay) {
        data[i] = 0
        continue
      }
      const t = (i - preDelay) / (len - preDelay)
      data[i] = (rng() * 2 - 1) * Math.pow(1 - t, 2.6)
    }
  }
  return buf
}
