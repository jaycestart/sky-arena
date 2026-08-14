// 오디오 파일 없이 WebAudio 로 직접 합성하는 효과음.
// 브라우저 정책상 첫 사용자 입력 이후에만 소리가 난다.
export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = localStorage.getItem('skyarena.sound') !== '0';
    this.volume = +(localStorage.getItem('skyarena.vol') ?? 0.5);
    this._boost = null;
    this._last = new Map();
  }

  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setEnabled(on) {
    this.enabled = on;
    localStorage.setItem('skyarena.sound', on ? '1' : '0');
    if (!on) this.stopBoost();
  }

  setVolume(v) {
    this.volume = v;
    localStorage.setItem('skyarena.vol', String(v));
    if (this.master) this.master.gain.value = v;
  }

  /** 같은 소리가 한꺼번에 겹쳐 터지는 것을 막는다 */
  _throttle(key, ms) {
    const now = performance.now();
    if (now - (this._last.get(key) || 0) < ms) return false;
    this._last.set(key, now);
    return true;
  }

  _env(node, gain, attack, decay) {
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    node.connect(g).connect(this.master);
    return { g, stop: t + attack + decay + 0.02 };
  }

  _noise(dur) {
    const n = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }

  tone(freq, dur, type = 'square', gain = 0.16, slideTo = null) {
    if (!this.enabled || !this.ctx) return;
    const o = this.ctx.createOscillator();
    o.type = type;
    const t = this.ctx.currentTime;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const { stop } = this._env(o, gain, 0.005, dur);
    o.start(t);
    o.stop(stop);
  }

  fire() {
    if (!this.enabled || !this.ctx || !this._throttle('fire', 55)) return;
    this.tone(760, 0.055, 'square', 0.05, 320);
  }

  hit() {
    if (!this.enabled || !this.ctx || !this._throttle('hit', 40)) return;
    const src = this._noise(0.06);
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2400;
    src.connect(f);
    const { stop } = this._env(f, 0.14, 0.004, 0.06);
    src.start();
    src.stop(stop);
  }

  hurt() {
    if (!this.enabled || !this.ctx || !this._throttle('hurt', 90)) return;
    this.tone(180, 0.14, 'sawtooth', 0.13, 70);
  }

  explode() {
    if (!this.enabled || !this.ctx || !this._throttle('boom', 60)) return;
    const src = this._noise(0.55);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    const t = this.ctx.currentTime;
    f.frequency.setValueAtTime(1800, t);
    f.frequency.exponentialRampToValueAtTime(90, t + 0.5);
    src.connect(f);
    const { stop } = this._env(f, 0.3, 0.01, 0.5);
    src.start();
    src.stop(stop);
  }

  missile() { this.tone(220, 0.4, 'sawtooth', 0.12, 900); }
  lock() { if (this._throttle('lock', 380)) this.tone(1500, 0.07, 'sine', 0.09); }
  warn() { if (this._throttle('warn', 600)) { this.tone(420, 0.1, 'square', 0.1); } }
  pickup() { this.tone(660, 0.09, 'sine', 0.12, 1320); }
  levelup() {
    [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone(f, 0.12, 'triangle', 0.11), i * 70));
  }
  roll() { this.tone(300, 0.18, 'sine', 0.08, 640); }

  /** 제트 엔진음 — 스로틀에 따라 음높이와 세기가 변한다 */
  engine(throttle, ab) {
    if (!this.enabled || !this.ctx) { this.stopEngine(); return; }
    if (!this._eng) {
      const src = this._noise(2.0);
      src.loop = true;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 220;
      bp.Q.value = 1.2;
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      const og = this.ctx.createGain();
      og.gain.value = 0.03;
      const g = this.ctx.createGain();
      g.gain.value = 0.0001;
      src.connect(bp).connect(g).connect(this.master);
      osc.connect(og).connect(g);
      src.start();
      osc.start();
      this._eng = { src, bp, osc, g };
    }
    const e = this._eng;
    const t = this.ctx.currentTime;
    const lvl = 0.035 + throttle * 0.075 + (ab ? 0.06 : 0);
    e.g.gain.setTargetAtTime(lvl, t, 0.15);
    e.bp.frequency.setTargetAtTime(180 + throttle * 520 + (ab ? 240 : 0), t, 0.2);
    e.osc.frequency.setTargetAtTime(52 + throttle * 74, t, 0.2);
  }

  stopEngine() {
    if (!this._eng) return;
    const { src, osc, g } = this._eng;
    this._eng = null;
    try {
      g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.2);
      src.stop(this.ctx.currentTime + 0.3);
      osc.stop(this.ctx.currentTime + 0.3);
    } catch { /* 이미 정지 */ }
  }

  /** 바람 소리 — 속도가 붙을수록 커지는 광대역 잡음. 저공에서 더 크다.
   *  속도 눈금은 서버 CFG 를 그대로 따랐다(`game.py` `arcMin`·`arcMax`·
   *  `arcBoost`): 스로틀 0 이 300, 최대 830, 애프터버너가 1450 m/s 다.
   *  제동 중(최저 165)에는 들리지 않게 260 을 문턱으로 뒀다.
   *  엔진음과 같은 방식이다 — 노이즈 루프 하나를 만들어 두고 매 프레임
   *  주파수와 게인만 옮긴다. 새로 만들면 소리가 끊기고 CPU 를 먹는다. */
  wind(speed, agl) {
    if (!this.enabled || !this.ctx) { this.stopWind(); return; }
    if (!this._wind) {
      const src = this._noise(2.0);
      src.loop = true;
      // 하이패스로 저역을 덜어 엔진음(대역 180~700Hz)과 자리를 나눈다.
      // 겹쳐 두면 둘 다 웅웅거리기만 하고 속도가 안 들린다.
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 240;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 700;
      const g = this.ctx.createGain();
      g.gain.value = 0.0001;
      src.connect(hp).connect(lp).connect(g).connect(this.master);
      src.start();
      this._wind = { src, lp, g };
    }
    const w = this._wind;
    const t = this.ctx.currentTime;
    const u = Math.max(0, Math.min(1, ((speed || 0) - 260) / 1190));
    // 저공일수록 크게 — 지면에서 1.55배, 600m 위로는 그대로.
    // 600m 는 BACKLOG 2순위가 저공으로 잡아 둔 높이와 같은 눈금이다.
    const low = 1 - Math.max(0, Math.min(1, (agl || 0) / 600));
    // 최대 0.06. 엔진음(최대 0.17)보다 확실히 아래에 둔다 — 바람이
    // 엔진을 덮으면 스로틀이 안 들린다.
    w.g.gain.setTargetAtTime(0.0001 + 0.06 * Math.pow(u, 1.2) * (1 + 0.55 * low), t, 0.25);
    // 빠를수록 밝게(쉬익), 느릴수록 둔하게.
    w.lp.frequency.setTargetAtTime(500 + u * 2600, t, 0.3);
  }

  stopWind() {
    if (!this._wind) return;
    const { src, g } = this._wind;
    this._wind = null;
    try {
      g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.25);
      src.stop(this.ctx.currentTime + 0.35);
    } catch { /* 이미 정지 */ }
  }

  /** 부스트 중에는 노이즈 루프를 계속 흘린다 */
  boost(on) {
    if (!this.enabled || !this.ctx) return;
    if (on && !this._boost) {
      const src = this._noise(1.5);
      src.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 340;
      const g = this.ctx.createGain();
      g.gain.value = 0.0001;
      g.gain.exponentialRampToValueAtTime(0.08, this.ctx.currentTime + 0.15);
      src.connect(f).connect(g).connect(this.master);
      src.start();
      this._boost = { src, g };
    } else if (!on && this._boost) {
      this.stopBoost();
    }
  }

  stopBoost() {
    if (!this._boost) return;
    const { src, g } = this._boost;
    this._boost = null;
    try {
      g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.12);
      src.stop(this.ctx.currentTime + 0.2);
    } catch { /* 이미 정지됨 */ }
  }
}
