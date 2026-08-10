// 조종 입력 — 조준 방향의 단일 소유자 · 기수 추종 제어기 · 키보드 · 터치.
//
// 이 파일이 조준 방향 `aim`(월드 단위벡터)의 **유일한 주인**이다. 카메라와
// 기수 명령과 HUD 와 서버 전송이 모두 같은 프레임의 이 값 하나를 읽는다.
// 예전에는 마우스 → scene.viewYaw/Pitch → camQ → (한 프레임 늦게) aimDir →
// 기수 → 다시 카메라의 기체 추종으로 돌아오는 폐루프였다. 그래서 마우스
// 이동량과 조준 방향 사이에 1:1 대응이 없었고, 그 헌팅을 막으려 넣은 1.4도
// 데드존이 정확히 기총 추적 밴드를 죽이고 있었다.
import { quat, v3 } from './m3d.js';

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// 800DPI 마우스가 1cm 움직이면 315 카운트다. 360도 = 2π rad 이므로
// 1 카운트당 라디안 = 2π / (315 * cm360) = 0.0199492 / cm360.
const RAD_PER_CM360 = 0.0199492;

export class Input {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.set = settings;
    this.keys = new Set();
    // 이번 프레임에 마우스가 움직인 **원본 카운트**. 감도는 updateAim 한 곳에서만
    // 곱한다 — 예전에는 곱셈 지점이 세 군데로 흩어져 실효 감도가 정의되지 않았다.
    this.lookDelta = { x: 0, y: 0 };
    this.aim = null;          // 조준 방향(월드 단위벡터). null 이면 기수에서 다시 시작.
    this.aimOff = 0;          // 기수 - 조준점 사이 각(rad). HUD 가 읽는다.
    this.aimRecenter = 0;     // >0 이면 조준점이 기수 쪽으로 느리게 끌린다(τ초). 기본 끔.
    this.ac = null;           // 내 기체 제원 — main 이 world.ac 를 넣어 준다
    this.fov = 0;             // scene 의 현재 FOV — main 이 넣어 준다
    this.uiOpen = false;      // 설정/도움말이 열려 있으면 조준을 멈춘다
    this.mouseFire = false;
    this.mouseMissile = false;
    this.pointerLocked = false;
    this.touch = { active: false, dx: 0, dy: 0, fire: false, missile: false,
                   flare: false, ab: false, level: false };
    this.isTouch = matchMedia('(hover:none) and (pointer:coarse)').matches;
    this.throttle = 0.8;
    this.weapon = 0;
    this.onWeapon = null;
    this.onView = null;
    this.onAny = null;
    this.cmd = { pitch: 0, roll: 0, yaw: 0, throttle: 0.8, ab: false, brake: false,
                 fire: false, missile: false, flare: false, weapon: 0 };
    this._bindKeyboard();
    this._bindMouse();
    this._bindTouch();
  }

  _touched() { if (this.onAny) { this.onAny(); this.onAny = null; } }

  _bindKeyboard() {
    addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      this.keys.add(e.code);
      this._touched();
      if (e.code === 'Digit1') { this.weapon = 0; this.onWeapon?.(0); }
      if (e.code === 'Digit2') { this.weapon = 1; this.onWeapon?.(1); }
      if (e.code === 'KeyV') this.onView?.();
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    });
    // keydown 과 같은 가드가 있어야 한다 — 없으면 닉네임 입력 중에 뗀 키가
    // keys 에 남아 출격하자마자 그 키가 눌린 것처럼 동작한다.
    addEventListener('keyup', (e) => {
      if (e.target.tagName === 'INPUT') return;
      this.keys.delete(e.code);
    });
    addEventListener('blur', () => {
      this.keys.clear();
      this.mouseFire = this.mouseMissile = false;
      this.touch.fire = this.touch.missile = this.touch.flare = this.touch.ab = false;
    });
  }

  _bindMouse() {
    const c = this.canvas;
    // 포인터를 화면에 가둔다 — 커서가 밖으로 나가지도, 보이지도 않는다.
    // unadjustedMovement 로 OS 포인터 가속을 뺀다. 가속이 남아 있으면 같은
    // 물리적 이동이 매번 다른 각도를 만들어 cm/360 이라는 단위가 무의미해진다.
    const grab = () => {
      this._touched();
      if (this.pointerLocked || this.isTouch) return;
      // 잠금이 거부된 직후에는 브라우저가 쿨다운을 건다. 그 사이 계속
      // 재시도하면 에러만 쌓이고 영영 안 잠긴다.
      if (performance.now() < (this._lockCool || 0)) return;
      try {
        const r = c.requestPointerLock?.({ unadjustedMovement: true });
        // Firefox·구형 크롬은 옵션 인자를 모른다 — 인자 없이 한 번 더
        if (r && typeof r.catch === 'function') {
          r.catch(() => { try { c.requestPointerLock(); } catch { /* 거부 */ } });
        }
      } catch { try { c.requestPointerLock?.(); } catch { /* 거부 */ } }
    };
    this.grabPointer = grab;
    c.addEventListener('click', grab);
    c.addEventListener('mousedown', grab);
    addEventListener('pointerdown', (e) => { if (e.target === c) grab(); });
    // 출격 중에는 어디를 클릭하든 다시 잠근다 — Esc 로 풀린 뒤에도 바로 복구된다
    addEventListener('mousedown', () => {
      if (document.body.classList.contains('flying')) grab();
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === c;
      if (this.pointerLocked) { this.lockError = ''; this._lockFresh = true; }
      this.lookDelta.x = 0; this.lookDelta.y = 0;
    });
    document.addEventListener('pointerlockerror', () => {
      this.lockError = '마우스 잠금이 거부되었습니다. 화면을 한 번 더 클릭하세요.';
      this._lockCool = performance.now() + 1400;
    });
    addEventListener('mousemove', (e) => {
      const mx = e.movementX || 0, my = e.movementY || 0;
      // 잠긴 직후 첫 이벤트에는 커서가 화면 구석에서 중앙으로 순간이동한 양이
      // 통째로 실려 오는 브라우저가 있다. 그대로 먹으면 출격하자마자 홱 돈다.
      if (this._lockFresh) {
        this._lockFresh = false;
        if (Math.abs(mx) + Math.abs(my) > 300) return;
      }
      // 원본 카운트만 쌓는다. 회전은 프레임 경계에서 한 번에 적용한다 —
      // 회전은 비가환이라 이벤트마다 돌리는 것과 미세하게 다르지만, 통상
      // 델타에서 그 차이는 0.01도 미만이고 코드가 훨씬 단순해진다.
      this.lookDelta.x += mx;
      this.lookDelta.y += my;
    });
    // 화면(캔버스)에서 누를 때만 발사한다 — 설정 버튼 등 UI 클릭은 제외
    c.addEventListener('mousedown', (e) => {
      this._touched();
      if (e.button === 0) {
        this.mouseFire = true;
        // 톡 눌러도 몇 발은 나가도록. 80ms — 이보다 길면 점사가 안 된다.
        this.fireUntil = performance.now() + 80;
      }
      if (e.button === 2) this.mouseMissile = true;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseFire = false;
      if (e.button === 2) this.mouseMissile = false;
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      this.throttle = clamp(this.throttle - Math.sign(e.deltaY) * 0.06, 0, 1);
      e.preventDefault();
    }, { passive: false });
  }

  _bindTouch() {
    const stick = document.getElementById('stick');
    const knob = document.getElementById('stick-knob');
    if (!stick) return;
    const R = 46;
    let id = null, cx = 0, cy = 0;
    const move = (t) => {
      let dx = t.clientX - cx, dy = t.clientY - cy;
      const d = Math.hypot(dx, dy);
      if (d > R) { dx = dx / d * R; dy = dy / d * R; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.touch.dx = dx / R; this.touch.dy = dy / R; this.touch.active = true;
    };
    stick.addEventListener('touchstart', (e) => {
      this._touched();
      const t = e.changedTouches[0];
      id = t.identifier;
      const r = stick.getBoundingClientRect();
      cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      move(t); e.preventDefault();
    }, { passive: false });
    stick.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) if (t.identifier === id) move(t);
      e.preventDefault();
    }, { passive: false });
    const end = (e) => {
      for (const t of e.changedTouches) if (t.identifier === id) {
        id = null; this.touch.active = false; this.touch.dx = this.touch.dy = 0;
        knob.style.transform = '';
      }
    };
    stick.addEventListener('touchend', end);
    stick.addEventListener('touchcancel', end);

    const hold = (elId, key) => {
      const el = document.getElementById(elId);
      if (!el) return;
      const on = (e) => { this._touched(); this.touch[key] = true; e.preventDefault(); };
      const off = (e) => { this.touch[key] = false; e.preventDefault(); };
      el.addEventListener('touchstart', on, { passive: false });
      el.addEventListener('touchend', off, { passive: false });
      el.addEventListener('touchcancel', off, { passive: false });
      el.addEventListener('mousedown', on);
      el.addEventListener('mouseup', off);
    };
    hold('btn-fire', 'fire');
    hold('btn-missile', 'missile');
    hold('btn-flare', 'flare');
    hold('btn-ab', 'ab');
    hold('btn-level', 'level');
  }

  // ── 조준 ─────────────────────────────────────────────────────────
  /**
   * 마우스/터치 이동량을 조준 방향에 적용한다. sample() 보다 **먼저** 부른다.
   * @param look  takeLook() 이 준 원본 카운트
   * @param me    world.me  (pos, q, hpb)
   * @param hpb   [방위, 기수각, 비틀기]
   */
  updateAim(look, me, hpb, dt = 1 / 60) {
    if (!me) { this.aim = null; this.aimOff = 0; return; }
    const nose = quat.fwd(me.q);
    if (!this.aim) this.aim = nose;              // 출격·재출격: 기수에서 시작
    if (this.uiOpen) look = { x: 0, y: 0 };      // 설정/도움말이 열려 있으면 조준 정지

    // 감도는 cm/360 하나로 정의한다(800DPI 기준). 작을수록 빠르다.
    // FOV 보정: 속도가 붙으면 FOV 가 최대 +26도 넓어진다. 넓어질수록 같은
    // 각도가 화면에서 차지하는 픽셀이 줄어드니, 손의 이동량과 화면 위 이동량이
    // 계속 1:1 이려면 라디안/카운트를 tan(fov/2) 에 비례해 키워야 한다.
    // (조준 사양서에는 이 비가 뒤집혀 적혀 있었다 — 그대로 쓰면 부스트 중
    //  화면 감도가 두 배로 느려진다. FPS 의 zoom_sensitivity_ratio 와 같은 식이다.)
    const fovBase = this.set?.fov ?? 75;
    const fovNow = this.fov || fovBase;
    const fovK = Math.tan(fovNow * Math.PI / 360) / Math.tan(fovBase * Math.PI / 360);
    const k = RAD_PER_CM360 / Math.max(1, this.set?.cm360 ?? 12) * fovK;

    let mx = look.x * k;
    let myUp = -look.y * k * (this.set?.invert ? -1 : 1);
    // 터치 스틱은 위치가 곧 회전 '속도' 다. 마우스와 같은 aim 상태를 공유하므로
    // 제어기·리시·HUD 가 전부 그대로 재사용된다.
    if (this.touch.active) {
      mx += this.touch.dx * 1.6 * dt;
      myUp += -this.touch.dy * 1.6 * dt * (this.set?.invert ? -1 : 1);
    }

    // 화면축(카메라 right/up) 둘레로 조준 벡터를 직접 돌린다.
    // hdg/pit 스칼라로 적분하면 수직 근처에서 1/cos(pit) 이 폭주하고
    // 좌우 입력이 화면을 굴린다 — 벡터로 돌리면 극점이 없고 모든 자세에서
    // 정확히 1:1 이다.
    const camQ = quat.mul(quat.swing(nose, this.aim), me.q);
    const sr = quat.right(camQ), su = quat.up(camQ);
    let a = quat.rotAxis(this.aim, su, mx);        // su 둘레 = 화면 좌우
    a = quat.rotAxis(a, sr, -myUp);                // sr 둘레(부호 반전) = 화면 상하
    this.aim = v3.norm(a);

    // 선택: 조준점을 기수 쪽으로 아주 약하게 끌어당긴다(기본 꺼짐).
    // 되돌리더라도 **카메라 쪽이 아니라 여기**에 둔다 — 카메라에 넣으면
    // 카메라가 기수를 쫓고 기수가 카메라를 쫓던 폐루프가 되살아난다.
    if (this.aimRecenter > 0) {
      const t = 1 - Math.exp(-dt / this.aimRecenter);
      this.aim = v3.norm(quat.rot(quat.slerp([1, 0, 0, 0], quat.swing(this.aim, nose), t), this.aim));
    }

    // ── 리시(leash): 조준점이 기수에서 LMAX 이상 벌어지지 않게 초과분만 당긴다 ──
    // 이동량 제한이 아니다. 계속 밀면 리시가 기수를 끌고 무한히 돈다.
    // 상호추종 루프와 데드존을 동시에 없애고, 스윙 기저의 조건수를 보장하며,
    // 기총 원뿔(서버 max_off)에 다시 의미를 준다.
    const lim = (this.set?.leash ?? 55) * Math.PI / 180;
    const LMAX = Math.min(lim, 2.62);            // 끄기(=180도)여도 150도로 막는다
    const off = Math.acos(clamp(v3.dot(this.aim, nose), -1, 1));
    if (off > LMAX) {
      const ax = v3.cross(this.aim, nose);
      if (v3.len(ax) > 1e-9) {
        this.aim = v3.norm(quat.rotAxis(this.aim, v3.norm(ax), off - LMAX));
      }
      this.aimOff = LMAX;
    } else this.aimOff = off;
  }

  // ── 조종 명령 ────────────────────────────────────────────────────
  /**
   * 기수를 조준점으로 끌고 가는 명령을 만든다.
   * @param dt   프레임 시간
   * @param me   world.me
   * @param hpb  [방위, 기수각, 비틀기] — 없으면 자세에서 되뽑는다
   */
  sample(dt = 1 / 60, me = null, hpb = null) {
    const k = this.keys;
    let pitch = 0, roll = 0, yaw = 0;
    const ac = this.ac || { pitchRate: 2.6, yawRate: 2.9, rollRate: 6.4 };

    if (me) {
      hpb = hpb || quat.toHpb(me.q);
      // ── 차트축 P 제어기 ──────────────────────────────────────────
      // 오차를 기체축(right/up)이 아니라 **실제 조종축**(월드 Y 회전 = hdg,
      // 자오선 = pit)으로 분해한다. 비틀린 상태에서 기체축에 투영하면 두 축이
      // 교차결합해 기수가 조준점으로 직선이 아니라 나선으로 접근한다.
      const [h, p] = hpb;
      const ch = Math.cos(h), sh = Math.sin(h), cp = Math.cos(p), sp = Math.sin(p);
      const eh = [ch, 0, -sh];                 // 방위 증가 방향(단위)
      const ep = [-sp * sh, cp, -sp * ch];     // 기수각 증가 방향(단위)
      const cf = quat.fwd(me.q), want = this.aim || cf;
      const z = v3.dot(want, cf);
      const m = v3.sub(want, v3.mul(cf, z));   // 접선 오차, 크기 = sin θ
      const ml = v3.len(m);
      // sin θ 를 그대로 쓰면 180도에서 0 이 되어 뒤를 홱 돌아볼 때 명령이 안
      // 나온다. 전각도 θ 로 스케일해 0~π 전 구간에서 단조 증가하게 만든다.
      const th = Math.atan2(ml, z);
      const sc = ml > 1e-9 ? th / ml : 0;
      const dP = v3.dot(m, ep) * sc;                                // 필요한 pit 변화(rad)
      const cps = Math.sign(cp || 1) * Math.max(Math.abs(cp), 0.20);
      const dH = v3.dot(m, eh) * sc / cps;                          // 필요한 hdg 변화(rad)
      // 두 축의 최대 회전율이 다르므로(pitchRate/yawRate) '초 단위'로 정규화한
      // 뒤 함께 스케일한다. 이래야 기수가 조준점으로 휘지 않고 직선으로 간다.
      const KP = 9.0;                          // 1/s — 수렴 시간상수 약 0.11초
      let cx = dP / ac.pitchRate * KP;
      let cy = dH / ac.yawRate * KP;
      const n = Math.max(1, Math.hypot(cx, cy));
      cx /= n; cy /= n;
      // ── 극점 처리 ─────────────────────────────────────────────
      // 수직 근처에서 hdg 회전은 기수를 못 돌리고 기수축 둘레 롤만 만든다.
      // 그래서 요 권한을 죽이고 부족분을 피치로 넘긴다 — 피치는 제한이
      // 없으니 정점을 넘겨 해결된다(실기의 '정점에서 넘겨 빼기'와 같은 그림).
      // 여기를 1/|cos p| 로 증폭하면 마우스로 화면이 굴러 1순위 요구가 깨진다.
      const pa = clamp((Math.abs(cp) - 0.10) / 0.25, 0, 1);   // |pit|<=75도 1, >=84도 0
      cy *= pa;
      if (pa < 1) {
        // 넘길 방향: 위아래 오차가 뚜렷하면 그쪽으로, **거의 순수 좌우 오차면
        // 정점 쪽으로** 민다. sign(dP) 만 쓰면 dP 가 0 근처에서 부호가 매 틱
        // 뒤집혀 제자리 떨림이 되고 기수가 영영 정점을 못 넘는다(실측 확인).
        // 정점을 넘기면 cos(pit) 부호가 바뀌며 방위가 180도 접히고, |cos| 이
        // 다시 커지면서 요 권한이 살아나 남은 좌우 오차를 스스로 해결한다.
        const over = Math.abs(dP) > 0.15 ? Math.sign(dP) : (Math.sign(sp) || 1);
        cx = clamp(cx + (1 - pa) * 0.7 * over, -1, 1);
      }
      pitch = clamp(cx, -1, 1);
      yaw = clamp(cy, -1, 1);
    }

    // 지면 충돌 방지 — 낮고 가라앉는 중이면 자동으로 기수를 든다
    if (this.flightState) {
      const { agl, vy } = this.flightState;
      if (agl < 700 && vy < 0) {
        const urgency = clamp((700 - agl) / 700 + (-vy) / 120, 0, 1);
        pitch = Math.max(pitch, urgency);
        roll = clamp(-(hpb ? hpb[2] : 0) * 2.4, -1, 1);   // 수평으로 펴면서 상승
        this.groundWarn = true;
      } else this.groundWarn = false;
    }

    // T — 날개만 수평. 근접전에서 필요한 건 '기수는 그대로, 날개만 수평'이다.
    // 예전처럼 기수각까지 0 으로 만들면 조준을 통째로 잃는다.
    if ((k.has('KeyT') || this.touch.level) && hpb) {
      roll = clamp(-hpb[2] * 3.0, -1, 1);
    }
    // A / D — 기체를 비튼다. 누르는 동안 제한 없이 계속 돌고, 떼면 그 자세로
    // 남는다. **pitch/yaw 는 건드리지 않는다** — 예전에는 여기서 0 으로
    // 덮어써서 선회 중 A 를 누르면 기수 추종이 뚝 끊겼다.
    if (k.has('KeyA')) roll = -1;
    else if (k.has('KeyD')) roll = 1;

    // 스로틀 — 프레임률과 무관하도록 초당 비율로 바꾼다(예전엔 프레임당 고정값)
    if (k.has('ShiftLeft') || k.has('ShiftRight')) this.throttle = Math.min(1, this.throttle + 0.9 * dt);
    if (k.has('ControlLeft') || k.has('KeyZ') || k.has('KeyS')) {
      this.throttle = Math.max(0, this.throttle - 0.9 * dt);
    }

    // W = 부스터(애프터버너). Tab 은 뺐다 — preventDefault 가 없어 포커스가
    // 설정 버튼으로 튀고, 그 뒤 Space 가 그 버튼을 눌러 버렸다.
    const ab = k.has('KeyW') || this.touch.ab;
    const brake = k.has('KeyX');
    const fire = this.mouseFire || this.touch.fire || k.has('Space')
      || performance.now() < (this.fireUntil || 0);
    const missile = this.mouseMissile || k.has('KeyF') || this.touch.missile;
    const flare = k.has('KeyC') || this.touch.flare;

    // 평활(τ=0.03)은 뺐다 — 위 제어기 자체가 τ=0.11 의 저역통과다. 대신
    // 슬루 리밋만 남긴다: 0→1 을 56ms. 작은 입력에는 위상 지연이 붙지 않아
    // 미세 조준의 손맛이 죽지 않는다.
    const lim = 18 * dt;
    this._cmd = this._cmd || { pitch: 0, roll: 0, yaw: 0 };
    this._cmd.pitch += clamp(pitch - this._cmd.pitch, -lim, lim);
    this._cmd.yaw += clamp(yaw - this._cmd.yaw, -lim, lim);
    this._cmd.roll = roll;      // 롤은 즉시 — 누르는 즉시 돌아가야 한다

    this.cmd = { pitch: this._cmd.pitch, roll: this._cmd.roll, yaw: this._cmd.yaw,
                 throttle: this.throttle, ab, brake, fire, missile, flare,
                 weapon: this.weapon };
    return this.cmd;
  }

  /** 이번 프레임에 쌓인 마우스 이동량(원본 카운트)을 꺼내 간다(꺼내면 비워진다) */
  takeLook() {
    const d = { x: this.lookDelta.x, y: this.lookDelta.y };
    this.lookDelta.x = 0;
    this.lookDelta.y = 0;
    // 포인터가 잠기지 않았으면 조준을 아예 움직이지 않는다.
    // (터치는 updateAim 안의 스틱 경로가 대신 aim 을 움직인다)
    if (!this.pointerLocked && !this.isTouch) return { x: 0, y: 0 };
    return d;
  }
}
