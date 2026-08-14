// 오디오 파일 없이 WebAudio 로 직접 합성하는 효과음.
// 브라우저 정책상 첫 사용자 입력 이후에만 소리가 난다.

// 발사음이 이 배율 아래면 **노드를 아예 안 만든다**(`_far` 참조). 0.04 는
// 로켓 최대진폭 0.0035 — 마스터 게인(기본 0.5)을 지나면 0.0018 이라 사실상
// 무음인데 그걸 내자고 노드 6개를 만들 이유가 없다. `1/(1+d/800)=0.04` 를
// 풀면 19,200m 라, 전장(반경 4,500m) 안에서는 절대 안 걸린다 — 걸리는 것은
// 천장 없이 위로 올라간 기체처럼 시야(`viewR` 14km) 밖의 레이더 표적뿐이다.
const FAR_CUT = 0.04;

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

  /** 같은 소리가 한꺼번에 겹쳐 터지는 것을 막는다.
   *
   *  발사음은 `rocket` / `rocket.me` 처럼 **내 것과 남의 것을 다른 칸으로**
   *  센다. 예전에는 한 칸이라 남이 쏜 직후(70ms 안)에 내가 쏘면 **내 발사음이
   *  통째로 먹혔다.** 24인 방에 봇까지 있으면 남의 발사가 계속 깔리므로
   *  가장 중요한 소리가 가장 자주 지워지는 셈이었다. 서버 재장전이 로켓
   *  0.42초·유도탄 0.9초라(`game.py` WEAPONS `cd`) 내 칸의 문턱은 어차피
   *  한 번도 안 걸린다 — 내 발사음은 이제 **언제나 난다.** */
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

  /** 발사음의 거리 감쇠 배율.
   *
   *  `launch` 이벤트에는 **쏜 사람(`id`)만** 있고 어디서 쐈는지가 없다. 그래서
   *  여태 지도 반대편 발사가 내 코앞에서 난 것과 **똑같은 크기**로 들렸다
   *  (BACKLOG 6순위 곁다리). 위치는 서버가 이미 보내고 있으므로 — 시야
   *  (`viewR` 14km) 안이면 스냅샷 `p` 행, 밖이면 레이더 `rd` — `main.js` 가
   *  그것으로 거리를 재서 넘긴다. **소리 자체는 안 건드린다. 게인만 곱한다.**
   *
   *  식은 `1/(1 + d/800)` 이다. 구면 확산의 1/d 를 0m 에서 발산하지 않게 고친
   *  흔한 꼴이고, 반감 거리 800m 는 **이 게임의 기본 교전 눈금**을 그대로 쓴
   *  것이다(락온이 없을 때 조준경이 쓰는 사거리가 상수 800 이다, `hud.js`).
   *
   *  진짜 브라우저 Web Audio 로 렌더링해 잰 값이다(마스터 1.0 기준, 노이즈
   *  난수를 고정한 하네스라 2026-08-14 이 적어 둔 0.088 과 난수열만 다르다).
   *
   *  | 거리 | 배율 | 로켓 최대진폭 | 유도탄 |
   *  |---|---|---|---|
   *  | 0 (내 발사) | 1.000 | 0.0785 | 0.0674 |
   *  | 800 (기총 사거리) | 0.500 | 0.0404 | 0.0350 |
   *  | 2,000 | 0.286 | 0.0236 | 0.0206 |
   *  | 4,500 (전장 반경) | 0.151 | 0.0128 | 0.0113 |
   *  | 9,000 (전장 지름) | 0.082 | 0.0071 | 0.0063 |
   *
   *  실측 진폭비가 배율보다 조금씩 크다(9,000m 에서 0.091 대 0.082). `_env`
   *  의 바닥 0.0001 이 **절대값**이라 작은 소리일수록 지수 봉투가 지나는
   *  자릿수가 적어 상대적으로 완만해지기 때문이다. 방향과 크기가 다 맞아
   *  그대로 둔다 — 소리를 바꾸는 것이 아니라 게인만 곱하는 것이 목적이다.
   *
   *  **내 발사음은 한 치도 안 바뀐다** — d=0 이면 배율이 정확히 1.0 이고,
   *  같은 하네스에서 인자 없는 옛 호출과 최대진폭이 **소수점 6자리까지
   *  같다**(0.078491).
   *
   *  거리를 못 구하면(스냅샷에도 레이더에도 없는 id) 전장 지름 9,000m 로
   *  본다. 예전처럼 원래 크기로 되돌리면 못 찾는 순간마다 가장 큰 소리가
   *  나므로, 모를 때는 **조용한 쪽**으로 틀린다. */
  _far(dist) {
    const d = Number.isFinite(dist) ? Math.max(0, dist) : 9000;
    return 1 / (1 + d / 800);
  }

  /** 로켓(무유도) 발사 — 짧고 날카롭게.
   *  좌클릭이고 서버 재장전이 0.42초(`game.py` WEAPONS[ROCKET].cd)라 자주
   *  울린다. 그래서 짧아야 한다 — 길면 연사할 때 서로 겹쳐 뭉갠다.
   *  유도탄과 갈리는 지점은 둘이다.
   *    · 어택 3ms — 소리가 '탁' 하고 앞에서 선다.
   *    · 하이패스 1100Hz — 고역만 남겨 파열음으로 들린다.
   *  유도탄은 정확히 반대로 잡았다(어택 40ms · 로우패스). */
  /*  `dist` 는 발사 지점까지의 거리(m), `mine` 은 내가 쐈는지다(`_far`·
   *  `_throttle` 주석 참조). 인자를 안 주면 예전 그대로 — 감쇠 없는 내 발사다. */
  rocket(dist = 0, mine = true) {
    const vol = this._far(dist);
    if (!this.enabled || !this.ctx || vol < FAR_CUT) return;
    if (!this._throttle(mine ? 'rocket.me' : 'rocket', 70)) return;
    const src = this._noise(0.09);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1100;
    src.connect(hp);
    // 게인이 낮은 건 일부러다. 렌더링해서 재 보니 원래 잡은 값(0.09+0.045)은
    // 최대진폭 0.142 로 **폭발음(0.145)과 거의 같았다.** 0.42초마다 울리는
    // 소리가 폭발만큼 크면 금방 피곤해진다. 날카로움은 크기가 아니라
    // 어택(3ms)과 고역(하이패스)에서 나오므로 크기만 30% 내렸다.
    const { stop } = this._env(hp, 0.062 * vol, 0.003, 0.085);
    src.start();
    src.stop(stop);
    // 떠나는 소리 — 빠르게 아래로 훑는다. 초속 900 으로 나가는 탄이다.
    this.tone(880, 0.07, 'square', 0.032 * vol, 300);
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

  /** 유도탄(IR) 발사 — 둔하고 길게.
   *  예전에는 220→900Hz 로 **올라가는** 톱니 하나였다. 밝고 위로 솟는 소리라
   *  로켓보다도 날카로웠고, 그나마 로켓과 같은 소리를 썼다(main.js 가 두
   *  무기 모두 이걸 불렀다). 둘을 갈라 놓으면서 성격도 뒤집는다.
   *  서버 값이 그대로 근거다 — 초속 400 으로 느리게 나가 4초를 태운다
   *  (`game.py` WEAPONS[MISSILE] `muzzle`·`burn`). 뭉근하게 점화해 멀어진다.
   *    · 어택 40ms(점화) · 55ms(모터) — 앞이 서지 않고 밀려 나온다.
   *    · 로우패스 1100→260Hz — 고역을 걷어 멀어지는 것처럼 들린다. */
  missile(dist = 0, mine = true) {
    const vol = this._far(dist);
    if (!this.enabled || !this.ctx || vol < FAR_CUT) return;
    if (!this._throttle(mine ? 'missile.me' : 'missile', 130)) return;
    const t = this.ctx.currentTime;
    // 점화 — 낮게 '쿵'. 로켓의 파열음과 달리 고역이 없다.
    // `tone()` 을 안 쓰고 직접 짠 이유: tone 은 어택이 5ms 로 박혀 있어
    // 이 소리의 **첫머리가 로켓만큼 날카로워진다**. 여기서만 40ms 로 늦춘다.
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(82, t + 0.22);
    const body = this._env(o, 0.075 * vol, 0.04, 0.2);
    o.start(t);
    o.stop(body.stop);
    const src = this._noise(0.6);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1100, t);
    lp.frequency.exponentialRampToValueAtTime(260, t + 0.55);
    src.connect(lp);
    const { stop } = this._env(lp, 0.1 * vol, 0.055, 0.5);
    src.start();
    src.stop(stop);
  }

  lock() { if (this._throttle('lock', 380)) this.tone(1500, 0.07, 'sine', 0.09); }
  warn() { if (this._throttle('warn', 600)) { this.tone(420, 0.1, 'square', 0.1); } }
  pickup() { this.tone(660, 0.09, 'sine', 0.12, 1320); }
  levelup() {
    [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone(f, 0.12, 'triangle', 0.11), i * 70));
  }
  roll() { this.tone(300, 0.18, 'sine', 0.08, 640); }

  /** 제트 엔진음 — 스로틀이 음높이와 세기를, **속도는 음높이만** 옮긴다.
   *
   *  속도를 세기에 붙이면 안 된다. 바람 소리(`wind()`)가 이미 속도를 세기로
   *  말하고 있어 둘이 같은 말을 하게 된다. 그래서 엔진은 음높이 한 축만 더
   *  쓰고, 대역(`bp`)과 오실레이터(`osc`)에 **같은 배율**을 곱한다 — 압축기
   *  소음은 날개 통과 주파수와 그 배음이 RPM 에 함께 실려 통째로 오르내리므로
   *  한쪽만 옮기면 한 엔진에서 두 소리가 난다.
   *
   *  (근거로 '도플러'가 적혀 있었는데 그건 틀렸다 — 엔진은 나와 같이 움직여서
   *   내 귀에 도플러는 0 이다. 남는 것은 램 압력뿐이라 배율도 그만큼 얕다.)
   *
   *  눈금은 서버 CFG 를 그대로 따랐다(`game.py` `arcMin` 300 · `arcMax` 830 ·
   *  `arcBoost` 1450, 제동은 목표 ×0.55 라 최저 165). **300 을 배율 1.0 으로
   *  잡아 스로틀 0 순항의 소리는 예전과 한 치도 안 바뀐다.** 165 에서 0.965,
   *  1450 에서 1.30(4.6반음)이다. 스로틀이 혼자 옮기는 폭(52→126Hz, 15반음)의
   *  3분의 1 이라 음높이의 주인은 여전히 스로틀이다.
   *
   *  **속도가 스로틀과 다른 말을 하는 자리는 셋뿐이다.** 서버 속도는 스로틀이
   *  정한 목표로 초당 700 씩 다가가는 값이라(`Plane.step`), 그 셋을 빼면
   *  스로틀의 지연 복사본이다. 이 소리가 새로 알려 주는 것도 딱 그 셋이다.
   *   · 스로틀을 밀어 넣는 0.76초(300→830) · AB 1.64초 — 음높이가 먼저 튀고
   *     뒤이어 천천히 더 오른다. 엔진이 물려 올라가는 느낌이 여기서 난다.
   *   · **제동** — `engine()` 은 브레이크를 받지도 않는다. 속도만이 안다.
   *   · 상승한계 위 — 서버가 속도를 지운다(BACKLOG '상승한계' 항목). */
  engine(throttle, ab, speed) {
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
    // 세기에는 속도가 안 들어간다(위 주석). 이 줄은 예전 그대로다.
    const lvl = 0.035 + throttle * 0.075 + (ab ? 0.06 : 0);
    e.g.gain.setTargetAtTime(lvl, t, 0.15);
    // 램 배율. 값이 안 오거나 숫자가 아니면 300 으로 봐서 배율 1.0 —
    // 즉 **모르면 예전 소리**다. 스냅샷 한 칸이 비어도 음높이가 안 튄다.
    const v = Number.isFinite(speed) ? Math.max(165, Math.min(1450, speed)) : 300;
    const ram = 1 + 0.30 * (v - 300) / 1150;
    e.bp.frequency.setTargetAtTime((180 + throttle * 520 + (ab ? 240 : 0)) * ram, t, 0.2);
    e.osc.frequency.setTargetAtTime((52 + throttle * 74) * ram, t, 0.2);
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

  /** 지면 접근 경고 — 땅이 다가오는 **속도**로 삐 소리 간격이 좁아진다.
   *
   *  미사일 경고(`warn()`)는 이미 운다(`world.js` 가 `rwr` 이 늘면 부른다).
   *  비어 있던 것은 이쪽이다. 실속 경고는 만들지 않는다 — 서버가
   *  `stalling` 을 영영 False 로 둔다(BACKLOG 4순위).
   *
   *  **`vy` 가 아니라 `agl` 의 변화율로 잰다.** 가라앉는 속도만 보면 수평
   *  비행 중에 앞의 산이 솟아오르는 것을 놓친다 — 그때 `vy` 는 0 인데 `agl`
   *  은 줄어든다. 실제 GPWS 가 지형 접근을 따로 두는 이유와 같다.
   *  대신 낮게 스치는 비행(2순위가 권하는 저공)은 접근 속도가 0 이라
   *  울리지 않는다. **높이만으로는 절대 울리지 않는다.**
   *
   *  눈금의 근거:
   *   · 바닥은 `agl` 0 이 아니라 8 이다 — 서버가 지면+8m 에서 격추로 친다
   *     (`game.py:568`). 남은 높이는 `agl - 8`.
   *   · 충돌까지 6초 안이면 울리기 시작한다. 최대 속도 830m/s(AB 1450)로
   *     수직 강하하면 5000m 상공에서 켜진다 — 그게 맞다. 정말 부딪힌다.
   *   · 접근 속도 3m/s 아래는 무시한다. 착륙하듯 살살 내려가는 것까지
   *     잡으면 저공 비행 내내 운다.
   *  간격 620ms(막 켜짐) → 120ms(충돌 직전). 음높이도 같이 오른다.
   *  두 음을 번갈아 내 미사일 경고(420Hz 한 음)와 귀로 갈린다. */
  ground(agl) {
    if (!this.enabled || !this.ctx) { this.stopGround(); return; }
    const t = this.ctx.currentTime;
    const h = Math.max(0, (agl || 0) - 8);
    if (!this._gpws) {
      // 엔진음·바람과 같은 방식이다. 오실레이터는 **한 번만** 만들고
      // 그 뒤로는 게인 봉투와 주파수만 옮긴다.
      const osc = this.ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 700;
      const g = this.ctx.createGain();
      g.gain.value = 0.0001;
      osc.connect(g).connect(this.master);
      osc.start();
      this._gpws = { osc, g, t0: 0, h, rate: 0, next: 0, alt: false };
    }
    const p = this._gpws;
    // 접근 속도. 스냅샷은 20Hz 인데 이 함수는 매 프레임(60Hz) 불리므로
    // 세 번에 두 번은 같은 값이 온다 — 20ms 마다만 재고 지수평활한다.
    if (p.t0 === 0) { p.t0 = t; p.h = h; }
    const dt = t - p.t0;
    if (dt >= 0.02) {
      // 지형이 아무리 가팔라도 초속 2km 로 다가올 수는 없다. 스냅샷이
      // 한 번 건너뛰면 나오는 헛값을 여기서 막는다.
      const inst = Math.max(-2000, Math.min(2000, (p.h - h) / dt));
      p.rate += (inst - p.rate) * (1 - Math.exp(-Math.min(dt, 0.5) / 0.30));
      p.t0 = t; p.h = h;
    }
    const ttc = p.rate > 3 ? h / p.rate : Infinity;
    const u = Math.max(0, Math.min(1, 1 - ttc / 6));
    // 조용할 때도 **재장전을 지우지 마라.** 스냅샷 20Hz 를 60Hz 로 재는 탓에
    // 접근 속도가 ±5% 흔들리고(측정: 188.7 / 200.4 / 210.9), 경보가 막 켜지는
    // 순간 `ttc` 가 문턱 6초를 여덟 번 오르내린다. 여기서 `p.next` 를 0 으로
    // 되돌리면 그때마다 재장전이 풀려 **다음 프레임에 바로** 삐가 나간다 —
    // 실측으로 67~100ms 간격이었다. 가장 안 급한 순간에 제일 빨리 울리고
    // 정작 가까워지면 633ms 로 느려지는, 의도와 정반대의 소리였다.
    // 그냥 두면 마지막 삐로부터의 간격이 그대로 살아 있어 떨림이 먹힌다.
    // 한동안 안 울리다 다시 켜지는 경우는 `p.next` 가 이미 과거라 즉시 운다.
    if (u <= 0) return;
    if (t < p.next) return;
    p.next = t + 0.62 - 0.50 * u;
    p.alt = !p.alt;
    const f = (700 + 260 * u) * (p.alt ? 1 : 0.75);
    // 눈금은 미사일 경고(`warn()`)에 맞췄다 — 렌더링해서 재 보니 그쪽
    // 최대진폭이 0.093 인데, 이 소리는 **충돌 3초 전에 딱 그 크기**가 된다.
    // 막 켜졌을 때는 절반이고, 부딪히기 직전에만 그보다 커진다.
    const lvl = 0.045 + 0.095 * u;
    p.osc.frequency.setValueAtTime(f, t);
    const g = p.g.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(lvl, t + 0.006);
    // 96ms. 가장 급할 때 간격이 120ms 라 삐 소리가 거의 맞붙는다 — 그때는
    // 하나씩 세지 않고 이어진 경보로 들려야 한다.
    g.exponentialRampToValueAtTime(0.0001, t + 0.096);
  }

  stopGround() {
    if (!this._gpws) return;
    const { osc, g } = this._gpws;
    this._gpws = null;
    try {
      g.gain.cancelScheduledValues(this.ctx.currentTime);
      g.gain.setValueAtTime(0.0001, this.ctx.currentTime);
      osc.stop(this.ctx.currentTime + 0.05);
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
