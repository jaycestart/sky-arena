// 키보드 · 마우스 · 터치 입력을 하나의 조종 명령으로 통합한다.
// 출력: { turn:-1..1, throttle:0..1, boost, fire, missile, roll }
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const angDiff = (a, b) => {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

export class Input {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.set = settings;                     // {sens, autofire, ...}
    this.keys = new Set();
    this.mouse = { x: 0, y: 0, has: false };
    this.mouseFire = false;
    this.mouseBoost = false;
    this.touch = { active: false, dx: 0, dy: 0, fire: false, boost: false, missile: false, roll: false };
    this.isTouch = matchMedia('(hover:none) and (pointer:coarse)').matches;
    this.throttle = 0.65;
    this.weapon = 0;
    this.cmd = { turn: 0, throttle: 0.65, boost: false, fire: false,
                 missile: false, roll: false, weapon: 0 };
    this.onAny = null;                       // 첫 입력 시 오디오 활성화용
    this._edge = new Set();
    this._bindKeyboard();
    this._bindMouse();
    this._bindTouch();
  }

  _touched() { if (this.onAny) { this.onAny(); this.onAny = null; } }

  /** 이번 프레임에 새로 눌린 키인지 (연타 방지) */
  pressed(code) {
    if (this.keys.has(code) && !this._edge.has(code)) { this._edge.add(code); return true; }
    return false;
  }

  _bindKeyboard() {
    addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      this.keys.add(e.code);
      this._touched();
      // 1~4 로 주무기 교체
      const w = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(e.code);
      if (w >= 0) { this.weapon = w; this.onWeapon?.(w); }
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => { this.keys.delete(e.code); this._edge.delete(e.code); });
    // 창을 벗어나면 눌린 입력이 남아 계속 발사되지 않도록 전부 해제한다
    addEventListener('blur', () => {
      this.keys.clear(); this._edge.clear();
      this.mouseFire = this.mouseBoost = false;
      this.touch.fire = this.touch.boost = this.touch.missile = this.touch.roll = false;
    });
  }

  _bindMouse() {
    const c = this.canvas;
    c.addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.has = true;
    });
    c.addEventListener('mousedown', (e) => {
      this._touched();
      if (e.button === 0) this.mouseFire = true;
      if (e.button === 2) this.mouseBoost = true;
      if (e.button === 1) { this.touch.missile = true; e.preventDefault(); }
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseFire = false;
      if (e.button === 2) this.mouseBoost = false;
      if (e.button === 1) this.touch.missile = false;
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      this.throttle = clamp(this.throttle - Math.sign(e.deltaY) * 0.1, 0, 1);
      e.preventDefault();
    }, { passive: false });
  }

  _bindTouch() {
    const stick = document.getElementById('stick');
    const knob = document.getElementById('stick-knob');
    if (!stick) return;
    const R = 42;
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
    hold('btn-boost', 'boost');
    hold('btn-missile', 'missile');
    hold('btn-roll', 'roll');
  }

  /** 화면상 내 비행기 위치(px)와 기수 각도로부터 조종 명령을 만든다. */
  sample(screenX, screenY, angle) {
    const k = this.keys;
    let turn = 0, fire = false, boost = false, missile = false, roll = false;

    if (k.has('KeyW') || k.has('ArrowUp')) this.throttle = Math.min(1, this.throttle + 0.02);
    if (k.has('KeyS') || k.has('ArrowDown')) this.throttle = Math.max(0, this.throttle - 0.02);
    if (k.has('KeyA') || k.has('ArrowLeft')) turn -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) turn += 1;
    if (k.has('Space')) fire = true;
    if (k.has('ShiftLeft') || k.has('ShiftRight')) boost = true;
    if (k.has('KeyE')) missile = true;
    if (k.has('KeyQ')) roll = true;

    const gain = 5.0 * (this.set?.sens ?? 1);
    if (this.touch.active) {
      const mag = Math.hypot(this.touch.dx, this.touch.dy);
      if (mag > 0.2) {
        const want = Math.atan2(this.touch.dy, this.touch.dx);
        turn = clamp(angDiff(want, angle) * gain, -1, 1);
        this.throttle = Math.min(1, 0.35 + mag * 0.75);
      }
    } else if (turn === 0 && this.mouse.has && !this.isTouch) {
      // 마우스 조향: 커서 쪽으로 기수를 맞춘다
      const want = Math.atan2(this.mouse.y - screenY, this.mouse.x - screenX);
      turn = clamp(angDiff(want, angle) * gain, -1, 1);
    }

    if (this.mouseFire || this.touch.fire || this.set?.autofire) fire = true;
    if (this.mouseBoost || this.touch.boost) boost = true;
    if (this.touch.missile) missile = true;
    if (this.touch.roll) roll = true;

    this.cmd = { turn, throttle: this.throttle, boost, fire, missile, roll,
                 weapon: this.weapon };
    return this.cmd;
  }
}
