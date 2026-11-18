import type { FlightModel } from './model';
import type { FlightControls } from './model';

/** Q15: procedural WebAudio — engine, wind, gear, touchdown, stall. No samples. */
export class FlightAudio {
  private ctx?: AudioContext;
  private master?: GainNode;
  private engineGain?: GainNode;
  private engineOsc?: OscillatorNode;
  private engineOsc2?: OscillatorNode;
  private rumbleGain?: GainNode;
  private windGain?: GainNode;
  private windFilter?: BiquadFilterNode;
  private stallGain?: GainNode;
  private stallOsc?: OscillatorNode;
  private noiseBuf?: AudioBuffer;
  muted = false;

  /** must be called from a user gesture at least once */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 50;
    this.engineOsc2 = ctx.createOscillator();
    this.engineOsc2.type = 'square';
    this.engineOsc2.frequency.value = 101;
    const engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 900;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineOsc.connect(engineFilter);
    this.engineOsc2.connect(engineFilter);
    engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);
    this.engineOsc.start();
    this.engineOsc2.start();

    const rumble = ctx.createBufferSource();
    rumble.buffer = this.noiseBuf;
    rumble.loop = true;
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 220;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    rumble.connect(rumbleFilter);
    rumbleFilter.connect(this.rumbleGain);
    this.rumbleGain.connect(this.master);
    rumble.start();

    const wind = ctx.createBufferSource();
    wind.buffer = this.noiseBuf;
    wind.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 500;
    this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wind.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);
    wind.start();

    this.stallOsc = ctx.createOscillator();
    this.stallOsc.type = 'square';
    this.stallOsc.frequency.value = 760;
    this.stallGain = ctx.createGain();
    this.stallGain.gain.value = 0;
    this.stallOsc.connect(this.stallGain);
    this.stallGain.connect(this.master);
    this.stallOsc.start();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.5, this.ctx.currentTime, 0.05);
    }
  }

  update(model: FlightModel, c: FlightControls, now: number): void {
    if (!this.ctx || !this.engineGain || !this.windGain || !this.rumbleGain || !this.stallGain || !this.engineOsc || !this.engineOsc2 || !this.windFilter) return;
    const t = this.ctx.currentTime;
    const speed = model.speed;
    const thr = c.throttle;
    const ab = model.cfg.thrustAfterburner > model.cfg.thrustDry && thr > 0.85;
    const running = !model.crashed;
    // the engines that went with a wing are silent
    const eng = model.engineShare;
    this.engineOsc.frequency.setTargetAtTime(42 + thr * 90 + speed * 0.04, t, 0.1);
    this.engineOsc2.frequency.setTargetAtTime((42 + thr * 90 + speed * 0.04) * 2.02, t, 0.1);
    this.engineGain.gain.setTargetAtTime(running ? (0.05 + thr * 0.16 + (ab ? 0.1 : 0)) * eng : 0, t, 0.15);
    this.rumbleGain.gain.setTargetAtTime(running ? (0.04 + thr * 0.12 + (ab ? 0.16 : 0)) * eng : 0, t, 0.15);
    const wind = Math.min(0.3, (speed / 300) ** 2 * 0.3);
    this.windGain.gain.setTargetAtTime(running && !model.onGround ? wind : wind * 0.25, t, 0.2);
    this.windFilter.frequency.setTargetAtTime(350 + speed * 3, t, 0.2);
    const beep = model.stall && running && !model.onGround ? (Math.floor(now * 4) % 2 === 0 ? 0.09 : 0) : 0;
    this.stallGain.gain.setTargetAtTime(beep, t, 0.02);
  }

  private burst(freq: number, duration: number, gain: number, type: BiquadFilterType = 'lowpass'): void {
    if (!this.ctx || !this.master || !this.noiseBuf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.master);
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