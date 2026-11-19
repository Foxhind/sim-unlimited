import type { AircraftConfig } from './aircraft';
import type { FlightModel } from './model';
import type { FlightControls } from './model';
import { pistonRpm } from './propeller';

/**
 * The kind of engine an airframe has, which sets its voice:
 * - piston: a four-cylinder engine on a two-blade propeller — firing pulses, a crank lope, a chugging exhaust;
 * - fighter: a low-bypass turbofan with afterburner — a deep roar, a turbine whine, the burner's rumble;
 * - turbojet: the same core without a burner, its exhaust muffled (the F-117's slots) — roar and a softer whine;
 * - turbofan: a big high-bypass fan — the fan's buzz-saw over a low roar, a quiet whine.
 */
export type EngineKind = 'piston' | 'fighter' | 'turbojet' | 'turbofan';

export interface EngineVoiceDef {
  kind: EngineKind;
  /** stereo position of each engine, -1 left .. 1 right; its length is the engine count */
  pans: number[];
  /** spool time constants, s: up and down */
  spoolUp: number;
  spoolDown: number;
  /** turbine whine at full power, Hz (0: none) */
  whine: number;
  /** fan shaft rate at full power, Hz: the buzz-saw's fundamental (0: no big fan) */
  fan: number;
  /** cutoff of the exhaust roar at full power, Hz */
  roar: number;
  /** loudness of the whole engine set */
  level: number;
}

/** the engine voice an airframe gets from its config: the kind from its powerplant, one voice per engine */
export function engineVoice(cfg: AircraftConfig): EngineVoiceDef {
  const count = Math.max(1, cfg.nozzles.length);
  const half = cfg.wingSpan / 2;
  const pans = cfg.nozzles.length
    ? cfg.nozzles.map((n) => Math.max(-0.6, Math.min(0.6, (n.pos[0] / half) * 0.9)))
    : [0];
  if (cfg.prop) {
    return { kind: 'piston', pans, spoolUp: 0.25, spoolDown: 0.35, whine: 0, fan: 0, roar: 1400, level: 0.9 };
  }
  const perEngine = cfg.thrustDry / count;
  if (cfg.thrustAfterburner > cfg.thrustDry) {
    return { kind: 'fighter', pans, spoolUp: 1.4, spoolDown: 1.8, whine: 2900, fan: 0, roar: 900, level: 1 };
  }
  if (perEngine > 120000) {
    return { kind: 'turbofan', pans, spoolUp: 3.2, spoolDown: 2.6, whine: 1900, fan: 58, roar: 650, level: 1 };
  }
  return { kind: 'turbojet', pans, spoolUp: 1.6, spoolDown: 2, whine: 2300, fan: 0, roar: 600, level: 0.9 };
}

interface Voice {
  readonly out: GainNode;
  /** n: spool 0 (idle) .. 1 (full); speed: true airspeed m/s; ab: burner lit */
  set(n: number, speed: number, ab: boolean, t: number): void;
  stop(): void;
}

/** a looping buffer started at a random point, so every voice gets its own stretch of noise */
function loop(ctx: BaseAudioContext, buf: AudioBuffer): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.start(0, Math.random() * buf.duration);
  return src;
}

function filter(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q = 0.707): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function gain(ctx: BaseAudioContext, v: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

function osc(ctx: BaseAudioContext, type: OscillatorType, freq: number): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.start();
  return o;
}

/** Shared sources: brown noise (deep, for roars), white noise (wind, bursts), a slow random wobble, the firing wave. */
export class SoundBank {
  readonly white: AudioBuffer;
  readonly brown: AudioBuffer;
  /** smooth random -1..1 at about 7 knots a second: combustion unevenness, burner flutter */
  readonly wobble: AudioBuffer;
  /** an exhaust pulse train: strong low harmonics rolling off, fixed random phases so it is not a buzzy saw */
  readonly firing: PeriodicWave;

  constructor(ctx: BaseAudioContext) {
    const sr = ctx.sampleRate;
    const len = sr * 4;
    this.white = ctx.createBuffer(1, len, sr);
    this.brown = ctx.createBuffer(1, len, sr);
    this.wobble = ctx.createBuffer(1, len, sr);
    const w = this.white.getChannelData(0);
    const b = this.brown.getChannelData(0);
    let last = 0;
    let peak = 0;
    for (let i = 0; i < len; i++) {
      w[i] = Math.random() * 2 - 1;
      last = (last + 0.02 * w[i]) / 1.02;
      b[i] = last;
      peak = Math.max(peak, Math.abs(last));
    }
    // brown noise drifts: take out the mean, scale to a peak of 1, and fade the ends together so the loop is seamless
    let mean = 0;
    for (let i = 0; i < len; i++) mean += b[i];
    mean /= len;
    const fade = Math.floor(sr * 0.05);
    for (let i = 0; i < len; i++) b[i] = (b[i] - mean) / peak;
    for (let i = 0; i < fade; i++) {
      const a = i / fade;
      b[i] = b[i] * a + b[len - fade + i] * (1 - a);
    }
    const wb = this.wobble.getChannelData(0);
    const knotsPerSec = 7;
    const knots = Array.from({ length: 4 * knotsPerSec }, () => Math.random() * 2 - 1);
    for (let i = 0; i < len; i++) {
      const x = (i / sr) * knotsPerSec;
      const k = Math.floor(x);
      const f = x - k;
      const s = f * f * (3 - 2 * f);
      wb[i] = knots[k % knots.length] * (1 - s) + knots[(k + 1) % knots.length] * s;
    }
    const H = 32;
    const re = new Float32Array(H + 1);
    const im = new Float32Array(H + 1);
    for (let n = 1; n <= H; n++) {
      const a = Math.exp(-n / 7) / n ** 0.6;
      const ph = Math.random() * Math.PI * 2;
      re[n] = a * Math.cos(ph);
      im[n] = a * Math.sin(ph);
    }
    this.firing = ctx.createPeriodicWave(re, im);
  }
}

/** A four-cylinder four-stroke on a two-blade propeller: two firings and two blade passes a revolution. */
class PistonVoice implements Voice {
  readonly out: GainNode;
  private fire: OscillatorNode;
  private crank: OscillatorNode;
  private pulse: OscillatorNode;
  private tone: BiquadFilterNode;
  private jitter: GainNode;
  private srcs: AudioScheduledSourceNode[];

  constructor(ctx: BaseAudioContext, bank: SoundBank, private detune: number) {
    this.out = gain(ctx, 0);
    this.tone = filter(ctx, 'lowpass', 400, 0.8);
    this.tone.connect(this.out);
    this.fire = ctx.createOscillator();
    this.fire.setPeriodicWave(bank.firing);
    this.fire.start();
    this.fire.connect(gain(ctx, 0.55)).connect(this.tone);
    // half order: the uneven crank, the lope that makes it sound like an engine and not a tone
    this.crank = osc(ctx, 'sine', 20);
    this.crank.connect(gain(ctx, 0.3)).connect(this.tone);
    // the exhaust: brown noise chopped by each firing
    const exhaust = loop(ctx, bank.brown);
    const chop = gain(ctx, 0.5);
    exhaust.connect(filter(ctx, 'bandpass', 180, 0.7)).connect(chop);
    this.pulse = osc(ctx, 'sine', 40);
    this.pulse.connect(gain(ctx, 0.5)).connect(chop.gain);
    chop.connect(gain(ctx, 1.6)).connect(this.tone);
    // combustion unevenness: a small slow wander of the rpm
    const wob = loop(ctx, bank.wobble);
    this.jitter = gain(ctx, 0);
    wob.connect(this.jitter);
    this.jitter.connect(this.fire.frequency);
    this.jitter.connect(this.pulse.frequency);
    this.srcs = [this.fire, this.crank, this.pulse, exhaust, wob];
  }

  set(n: number, speed: number, _ab: boolean, t: number): void {
    // fixed pitch: the airstream turns the propeller faster too (O-200: ~700 idle, 2750 at full and cruise)
    const rpm = pistonRpm(n, speed) * this.detune;
    const f = (rpm / 60) * 2;
    this.fire.frequency.setTargetAtTime(f, t, 0.06);
    this.pulse.frequency.setTargetAtTime(f, t, 0.06);
    this.crank.frequency.setTargetAtTime(f / 2, t, 0.06);
    this.jitter.gain.setTargetAtTime(f * (0.02 - 0.012 * n), t, 0.2);
    this.tone.frequency.setTargetAtTime(260 + 1100 * n, t, 0.1);
    this.out.gain.setTargetAtTime(0.4 + 0.6 * n, t, 0.1);
  }

  stop(): void {
    for (const s of this.srcs) s.stop();
    this.out.disconnect();
  }
}

/** A gas turbine: the exhaust roar and sub rumble, the core's whine, a big fan's buzz-saw, the burner. */
class JetVoice implements Voice {
  readonly out: GainNode;
  private roarF: BiquadFilterNode;
  private roarG: GainNode;
  private subG: GainNode;
  private whine: OscillatorNode;
  private whine2: OscillatorNode;
  private whineG: GainNode;
  private fan?: OscillatorNode;
  private fanF?: BiquadFilterNode;
  private fanG?: GainNode;
  private abG: GainNode;
  private srcs: AudioScheduledSourceNode[];

  constructor(ctx: BaseAudioContext, bank: SoundBank, private def: EngineVoiceDef, private detune: number) {
    this.out = gain(ctx, 0);
    const roar = loop(ctx, bank.brown);
    this.roarF = filter(ctx, 'lowpass', 300, 0.5);
    this.roarG = gain(ctx, 0);
    roar.connect(this.roarF).connect(this.roarG).connect(this.out);
    // the low end you feel more than hear
    const sub = loop(ctx, bank.brown);
    this.subG = gain(ctx, 0);
    sub.connect(filter(ctx, 'lowpass', 70, 0.9)).connect(filter(ctx, 'highpass', 22)).connect(this.subG).connect(this.out);
    this.whine = osc(ctx, 'sine', def.whine);
    this.whine2 = osc(ctx, 'triangle', def.whine * 0.5);
    this.whineG = gain(ctx, 0);
    this.whine.connect(this.whineG);
    this.whine2.connect(gain(ctx, 0.6)).connect(this.whineG);
    this.whineG.connect(this.out);
    this.srcs = [roar, sub, this.whine, this.whine2];
    if (def.fan > 0) {
      // buzz-saw: the fan's shaft-order harmonics, heard as a coarse low drone around the blade passing
      this.fan = osc(ctx, 'sawtooth', def.fan);
      this.fanF = filter(ctx, 'bandpass', def.fan * 8, 1.4);
      this.fanG = gain(ctx, 0);
      this.fan.connect(this.fanF).connect(this.fanG).connect(this.out);
      this.srcs.push(this.fan);
    }
    // the burner: a deep, fluttering rumble
    const burner = loop(ctx, bank.brown);
    const flutter = gain(ctx, 0.75);
    burner.connect(filter(ctx, 'lowpass', 420, 0.6)).connect(flutter);
    const wob = loop(ctx, bank.wobble);
    wob.playbackRate.value = 1.6;
    wob.connect(gain(ctx, 0.25)).connect(flutter.gain);
    this.abG = gain(ctx, 0);
    flutter.connect(this.abG).connect(this.out);
    this.srcs.push(burner, wob);
  }

  set(n: number, _speed: number, ab: boolean, t: number): void {
    const d = this.def;
    const muffled = d.kind === 'turbojet' ? 0.75 : 1;
    this.roarF.frequency.setTargetAtTime(140 + d.roar * n ** 1.3, t, 0.15);
    this.roarG.gain.setTargetAtTime((0.35 + 1.1 * n * n) * muffled, t, 0.15);
    this.subG.gain.setTargetAtTime(0.6 + 1.4 * n, t, 0.2);
    const w = d.whine * (0.42 + 0.58 * n) * this.detune;
    this.whine.frequency.setTargetAtTime(w, t, 0.15);
    this.whine2.frequency.setTargetAtTime(w * 0.5 * 1.003, t, 0.15);
    const whineLevel = d.kind === 'turbofan' ? 0.006 : d.kind === 'turbojet' ? 0.009 : 0.012;
    this.whineG.gain.setTargetAtTime(whineLevel * (0.6 + 0.4 * n), t, 0.2);
    if (this.fan && this.fanF && this.fanG) {
      const shaft = d.fan * (0.22 + 0.78 * n) * this.detune;
      this.fan.frequency.setTargetAtTime(shaft, t, 0.15);
      this.fanF.frequency.setTargetAtTime(shaft * 8, t, 0.15);
      // the buzz-saw comes up when the fan tips go supersonic, at high power
      this.fanG.gain.setTargetAtTime(0.012 + 0.06 * n ** 2.5, t, 0.2);
    }
    this.abG.gain.setTargetAtTime(ab ? 1.8 : 0, t, ab ? 0.12 : 0.3);
    this.out.gain.setTargetAtTime(1, t, 0.1);
  }

  stop(): void {
    for (const s of this.srcs) s.stop();
    this.out.disconnect();
  }
}

/**
 * An airframe's engines: one voice per engine, each panned to its side and a touch off the others in speed
 * (twins and the An-225's six beat against each other), spooling up and down at the engine kind's pace.
 */
export class EngineSound {
  readonly def: EngineVoiceDef;
  private voices: Voice[];
  private spool = 0;
  private lastT = -1;

  constructor(ctx: BaseAudioContext, bank: SoundBank, cfg: AircraftConfig, dest: AudioNode) {
    this.def = engineVoice(cfg);
    const count = this.def.pans.length;
    // more engines are louder, not proportionally so
    const each = this.def.level / Math.sqrt(count);
    this.voices = this.def.pans.map((pan, k) => {
      const detune = 1 + (k - (count - 1) / 2) * 0.0045 + (Math.random() - 0.5) * 0.002;
      const v = this.def.kind === 'piston' ? new PistonVoice(ctx, bank, detune) : new JetVoice(ctx, bank, this.def, detune);
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      v.out.connect(gain(ctx, each)).connect(p).connect(dest);
      return v;
    });
  }

  /** throttle 0..1; alive: which engines still run (all off once crashed) */
  set(throttle: number, ab: boolean, speed: number, alive: boolean[], t: number): void {
    const dt = this.lastT < 0 ? 0 : Math.min(0.25, t - this.lastT);
    this.lastT = t;
    const tau = throttle > this.spool ? this.def.spoolUp : this.def.spoolDown;
    this.spool = dt === 0 ? throttle : this.spool + (throttle - this.spool) * (1 - Math.exp(-dt / tau));
    this.voices.forEach((v, k) => {
      if (alive[k]) v.set(this.spool, speed, ab, t);
      else v.out.gain.setTargetAtTime(0, t, 0.08);
    });
  }

  stop(): void {
    for (const v of this.voices) v.stop();
  }
}

/** Q15: procedural WebAudio — engine, wind, gear, touchdown, stall. No samples. */
export class FlightAudio {
  private ctx?: AudioContext;
  private master?: GainNode;
  private engineBus?: GainNode;
  private engines?: EngineSound;
  private engineCfg?: AircraftConfig;
  private bank?: SoundBank;
  private windGain?: GainNode;
  private windFilter?: BiquadFilterNode;
  private stallGain?: GainNode;
  muted = false;

  /** must be called from a user gesture at least once */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.bank = new SoundBank(ctx);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.02;
    comp.release.value = 0.3;
    comp.connect(ctx.destination);
    this.master = gain(ctx, this.muted ? 0 : 0.5);
    this.master.connect(comp);

    // the engines' bus: a gentle tape-like saturation for warmth, the lows lifted, the top softened
    this.engineBus = gain(ctx, 0.7);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(1.6 * x) / Math.tanh(1.6);
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    const low = filter(ctx, 'lowshelf', 120);
    low.gain.value = 5;
    const high = filter(ctx, 'highshelf', 3500);
    high.gain.value = -6;
    this.engineBus.connect(shaper).connect(low).connect(high).connect(this.master);

    const wind = loop(ctx, this.bank.white);
    this.windFilter = filter(ctx, 'bandpass', 500, 0.6);
    this.windGain = gain(ctx, 0);
    wind.connect(this.windFilter).connect(this.windGain).connect(this.master);

    const stallOsc = osc(ctx, 'square', 760);
    this.stallGain = gain(ctx, 0);
    stallOsc.connect(this.stallGain).connect(this.master);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.5, this.ctx.currentTime, 0.05);
    }
  }

  update(model: FlightModel, c: FlightControls, now: number): void {
    if (!this.ctx || !this.bank || !this.engineBus || !this.windGain || !this.stallGain || !this.windFilter) return;
    const t = this.ctx.currentTime;
    const cfg = model.cfg;
    if (cfg.id !== this.engineCfg?.id) {
      this.engines?.stop();
      this.engines = new EngineSound(this.ctx, this.bank, cfg, this.engineBus);
      this.engineCfg = cfg;
    }
    const speed = model.speed;
    const thr = c.throttle;
    const ab = cfg.thrustAfterburner > cfg.thrustDry && thr > 0.85;
    const running = !model.crashed;
    // the engines that went with a wing are silent
    const alive = cfg.nozzles.length
      ? cfg.nozzles.map((n) => running && (!n.part || !model.lost[n.part - 1]))
      : [running];
    this.engines?.set(thr, ab, model.airspeed, alive, t);
    const wind = Math.min(0.3, (speed / 300) ** 2 * 0.3);
    this.windGain.gain.setTargetAtTime(running && !model.onGround ? wind : wind * 0.25, t, 0.2);
    this.windFilter.frequency.setTargetAtTime(350 + speed * 3, t, 0.2);
    const beep = model.stall && running && !model.onGround ? (Math.floor(now * 4) % 2 === 0 ? 0.09 : 0) : 0;
    this.stallGain.gain.setTargetAtTime(beep, t, 0.02);
  }

  private burst(freq: number, duration: number, g0: number, type: BiquadFilterType = 'lowpass'): void {
    if (!this.ctx || !this.master || !this.bank) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.bank.white;
    const f = filter(this.ctx, type, freq);
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime;
    g.gain.setValueAtTime(g0, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + duration);
  }

  gear(): void {
    this.burst(600, 0.5, 0.25);
  }

  touchdown(hard: boolean): void {
    this.burst(hard ? 300 : 180, hard ? 0.6 : 0.3, hard ? 0.5 : 0.3);
  }

  crash(): void {
    this.burst(250, 1.2, 0.6);
    this.burst(1800, 0.4, 0.3, 'highpass');
  }
}
