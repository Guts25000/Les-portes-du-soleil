/**
 * Sons procéduraux (Web Audio, aucun fichier) : vent selon la vitesse, raclement des carres,
 * impacts de réception, « ding » de figure, cliquetis du télésiège.
 */
export class SkiAudio {
  private ctx: AudioContext | null = null;
  private wind!: GainNode;
  private windFilter!: BiquadFilterNode;
  private carve!: GainNode;
  private carveFilter!: BiquadFilterNode;
  private master!: GainNode;
  muted = false;

  start() {
    if (this.ctx) return;
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0.6;
      this.master.connect(ctx.destination);
      const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noise.getChannelData(0);
      let b = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        b = 0.97 * b + 0.03 * w; // bruit « brun » pour le vent
        d[i] = w * 0.35 + b * 2.5;
      }
      const src = (filter: BiquadFilterNode, gain: GainNode) => {
        const s = ctx.createBufferSource();
        s.buffer = noise;
        s.loop = true;
        s.connect(filter).connect(gain).connect(this.master);
        s.start();
      };
      this.windFilter = ctx.createBiquadFilter();
      this.windFilter.type = 'lowpass';
      this.windFilter.frequency.value = 400;
      this.wind = ctx.createGain();
      this.wind.gain.value = 0;
      src(this.windFilter, this.wind);
      this.carveFilter = ctx.createBiquadFilter();
      this.carveFilter.type = 'bandpass';
      this.carveFilter.frequency.value = 1800;
      this.carveFilter.Q.value = 0.8;
      this.carve = ctx.createGain();
      this.carve.gain.value = 0;
      src(this.carveFilter, this.carve);
      void ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.6;
  }

  /** À appeler chaque image. */
  update(speedKmh: number, edge: number, airborne: boolean, riding: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const v = Math.min(1, speedKmh / 90);
    this.wind.gain.setTargetAtTime(riding ? 0.05 : 0.04 + v * v * 0.5, t, 0.15);
    this.windFilter.frequency.setTargetAtTime(300 + v * 1400, t, 0.2);
    this.carve.gain.setTargetAtTime(airborne || riding ? 0 : Math.min(0.5, edge * 0.6 + v * 0.06), t, 0.05);
    this.carveFilter.frequency.setTargetAtTime(1200 + edge * 1800, t, 0.1);
  }

  private blip(freq: number, dur: number, type: OscillatorType, vol: number, slide = 0) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur);
  }

  land(intensity: number) {
    this.blip(90, 0.18, 'sine', Math.min(0.6, 0.15 + intensity * 0.3), 0.5);
  }
  trick(quality: 'Perfect' | 'Good' | 'Sloppy') {
    if (quality === 'Perfect') {
      this.blip(880, 0.12, 'triangle', 0.2);
      setTimeout(() => this.blip(1320, 0.18, 'triangle', 0.2), 90);
    } else this.blip(660, 0.15, 'triangle', 0.15);
  }
  bank() {
    [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.blip(f, 0.14, 'square', 0.07), i * 70));
  }
  crash() {
    this.blip(140, 0.35, 'sawtooth', 0.25, 0.3);
  }
  clack() {
    this.blip(220, 0.06, 'square', 0.08);
  }

  dispose() {
    void this.ctx?.close();
    this.ctx = null;
  }
}
