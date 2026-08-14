// 클라이언트 3D 월드 상태.
//  · 내 기체 = 서버와 동일한 비행 모델로 예측 + 미확인 입력 재시뮬레이션
//  · 다른 기체 = 스냅샷 버퍼 보간(위치 lerp, 자세 slerp)
// 옛 항공역학 분기(양력·항력·실속)는 지웠다 — 아케이드 분기의 return 뒤라
// 절대 실행되지 않는 코드였다. 서버 game.py Plane.step 의 짝도 같은 커밋에서
// 함께 지웠다. 그때 쓰임을 잃은 m3d 의 airDensity/soundSpeed/groundH 는
// 2026-08-14 에 정의까지 지웠다 — 여기서 m3d 에 남겨 둘 것은 G 뿐이다.
import { quat, v3, clamp, G } from './m3d.js';

/** 각도를 (-π, π] 로 (서버 flightmath.wrap_pi 와 동일) */
const wrapPi = (a) => {
  let x = (a + Math.PI) % (Math.PI * 2);
  if (x < 0) x += Math.PI * 2;
  return x - Math.PI;
};

const DELAY = 120;   // 보간 지연(ms)

export class World {
  constructor(sfx) {
    this.sfx = sfx;
    this.cfg = null;
    this.ac = null;            // 내 기체 제원
    this.aircraft = null;
    this.weapons = [];
    this.myId = 0;
    this.room = 'main';
    this.roster = new Map();
    this.buf = [];
    this.known = new Map();
    this.missiles = [];
    this.flares = [];
    this.radar = [];
    this.booms = [];
    this.me = null;            // {pos, q, vel}
    this.srv = null;
    this.pending = [];
    this.lb = [];
    this.hurtFlash = 0;
    this.stats = { kbps: 0 };
    this._prevAlive = new Map();
    this._prevRwr = 0;
  }

  setup(msg) {
    this.cfg = msg.cfg;
    this.aircraft = msg.classes;
    this.weapons = msg.weapons;
    this.myId = msg.id;
    this.room = msg.room;
    this.difficulty = msg.difficulty;
    this.roster.clear();
    for (const r of msg.roster) this.roster.set(r.id, r);
    this.ac = this.aircraft[this.roster.get(msg.id)?.ac] || Object.values(this.aircraft)[0];
    this.lb = msg.lb || [];
    this.me = null;
    this.srv = null;
    this.buf.length = 0;
    this.known.clear();
    this.pending.length = 0;
  }

  addPlayer(m) { this.roster.set(m.id, { n: m.n, c: m.c, bot: m.bot, ac: m.ac, tg: m.tg }); }
  removePlayer(id) {
    this.roster.delete(id);
    this.known.delete(id);
    this._prevAlive.delete(id);
  }
  name(id) { return this.roster.get(id)?.n ?? '???'; }

  /** 기종별 메시 배율. 렌더링에서만 쓴다(물리·예측은 절대 읽지 않는다).
   *
   *  배율표는 서버 AIRCRAFT **한 곳에만** 있고 roster 항목의 `ac` 는 사람·봇을
   *  구분하지 않고 실린다(game.py add_player). 그래서 봇이 사람과 다른 크기로
   *  그려지는 것이 원리적으로 불가능하다 — bot 플래그로 분기하는 코드를 새로
   *  만들지 말 것. 그 순간 두 경로가 갈라진다. */
  scaleOf(id) {
    return this.aircraft?.[this.roster.get(id)?.ac]?.mscale ?? 1;
  }
  /** 그 기체의 회전율 제원. 조종면 편각을 '명령 대비 몇 %' 로 정규화하는 데
   *  쓴다. scaleOf 와 같은 경로(roster.ac → 서버 AIRCRAFT)라 봇도 자동이다. */
  ratesOf(id) {
    return this.aircraft?.[this.roster.get(id)?.ac] || this.ac || null;
  }
  color(id) { return this.roster.get(id)?.c ?? '#9dd'; }
  byId(id) { return this.view().find((p) => p.id === id); }

  // ── 스냅샷 ──────────────────────────────────────────────────────
  onSnapshot(s, bytes) {
    const now = performance.now();
    this._rx = (this._rx || 0) + (bytes || 0);
    if (now - (this._rxT || 0) > 1000) {
      this.stats.kbps = Math.round(this._rx / 1024 * 10) / 10;
      this._rx = 0; this._rxT = now;
    }

    // 렌더 쪽 시간 원본. 구름·구름 그림자·파도가 모든 클라이언트에서 같은
    // 위치에 있으려면 로컬 시계가 아니라 서버 tick 을 써야 한다.
    // (프로토콜 변경 없음 — 'k' 는 원래 오던 값이다)
    this.tick = s.k;

    const planes = new Map();
    for (const row of s.p) {
      const [id, x, y, z, qw, qx, qy, qz] = row;
      if (row.length > 8) this.known.set(id, { hp: row[8], fl: row[9] });
      const k = this.known.get(id) || { hp: 100, fl: 1 };
      planes.set(id, {
        id, pos: [x, y, z], q: [qw, qx, qy, qz], hp: k.hp,
        alive: !!(k.fl & 1), ab: !!(k.fl & 2), invuln: !!(k.fl & 4), stalling: !!(k.fl & 8),
      });
      const was = this._prevAlive.get(id);
      if (was === true && !(k.fl & 1)) this.sfx?.explode();
      this._prevAlive.set(id, !!(k.fl & 1));
    }
    for (const id of [...this._prevAlive.keys()]) if (!planes.has(id)) this._prevAlive.delete(id);

    this.buf.push({ t: now, planes });
    if (this.buf.length > 20) this.buf.shift();

    this.missiles = (s.m || []).map(([id, x, y, z, vx, vy, vz, o]) => ({
      id, pos: [x, y, z], vel: [vx, vy, vz], owner: o, q: lookQ(v3.norm([vx, vy, vz])),
    }));
    this.flares = (s.fl || []).map(([x, y, z, life, vx, vy, vz]) =>
      ({ pos: [x, y, z], life, vel: [vx || 0, vy || 0, vz || 0] }));
    this.radar = (s.rd || []).map(([id, x, y, z]) => ({ id, pos: [x, y, z] }));

    if (s.me) this._applyMe(s.me);
  }

  _applyMe(me) {
    const prev = this.srv;
    this.srv = me;

    for (const [x, y, z, dmg] of me.ht || []) {
      // 명중 스파크 — 방향이 제각각인 불똥이 튀도록 씨앗을 함께 넣는다
      this.booms.push({ kind: 'spark', x, y, z, t: 0, life: 0.42,
                        seed: (x * 13 + z * 7) % 6.283, dmg });
      this.hitFlash = 1;
      this.sfx?.hit();
    }
    if ((me.hu || []).length) {
      this.hurtFlash = 1;
      this.sfx?.hurt();
    }
    // 발사음은 여기서 내지 않는다. **내 유도탄 잔량이 줄었을 때만** 울리던
    // 경로라 (a) 내 로켓은 평생 소리가 안 났고 (b) 남·봇과 다른 코드가
    // 울렸다. 이제 launch 이벤트 한 곳(main.js onEvent)이 사람·봇·나를
    // 구분 없이 처리한다. 잔량 추적(_prevMs)은 2026-08-14 에 지웠다 —
    // 서버가 am · ms 를 아예 안 보낸다.
    if (me.rwr > this._prevRwr) this.sfx?.warn();
    this._prevRwr = me.rwr;
    if (prev?.al && !me.al) this.sfx?.explode();

    if (!this.me || (!prev?.al && me.al)) {
      this.me = { pos: [me.x, me.y, me.z], q: [...me.q], vel: [me.vx, me.vy, me.vz] };
      this.pending.length = 0;
      return;
    }
    // 서버 상태로 되감고 미확인 입력을 다시 적용
    this.me.pos = [me.x, me.y, me.z];
    this.me.q = [...me.q];
    // 자세의 원본인 세 값도 서버 것으로 되감는다
    if (me.hpb) this.me.hpb = [...me.hpb];
    this.me.vel = [me.vx, me.vy, me.vz];
    this.pending = this.pending.filter((p) => p.seq > me.ack);
    if (this.pending.length > 300) this.pending.splice(0, this.pending.length - 300);
    for (const p of this.pending) this._integrate(p.dt, p.cmd, false);
  }

  // ── 비행 모델 (서버 game.py Plane.step 과 동일) ─────────────────
  _integrate(dt, cmd, record, seq = 0) {
    const me = this.me, ac = this.ac, c = this.cfg;
    if (!me || !ac) return;

    // ── 아케이드 비행 (서버 game.py 와 동일) ────────────────────────
    // 기수 방향으로 날고, 회전 속도는 속도와 무관하다.
    if (c.arcMin !== undefined) {
      let target = cmd.ab ? c.arcBoost
        : c.arcMin + (c.arcMax - c.arcMin) * cmd.throttle;
      if (cmd.brake) target *= 0.55;
      const cur = v3.len(me.vel);
      const st = c.arcAccel * dt;
      const spd = cur + clamp(target - cur, -st * 1.8, st);

      const pr = clamp(cmd.pitch, -1, 1) * ac.pitchRate;
      const rr = clamp(cmd.roll, -1, 1) * ac.rollRate;
      const yr = clamp(cmd.yaw, -1, 1) * ac.yawRate;
      // 방위·기수각·비틀기가 자세의 원본이다. 자세에서 되뽑지 않고
      // 이 세 값을 직접 이어 간다 — 되뽑으면 기수각이 90도를 넘는 순간
      // 뒤집힌 해가 나와 조작이 반대로 먹는다. (서버 game.py 와 동일)
      me.hpb = me.hpb || quat.toHpb(me.q);
      me.hpb = [wrapPi(me.hpb[0] + yr * dt),
                wrapPi(me.hpb[1] + pr * dt),
                wrapPi(me.hpb[2] + rr * dt)];
      me.q = quat.hpb(me.hpb[0], me.hpb[1], me.hpb[2]);

      // 기체는 언제나 기수 방향으로 난다(서버와 동일).
      // 공중제비(tumble) 분기는 지웠다 — 어느 쪽도 그 플래그를 켜지 않아
      // 죽은 코드였고, 서버 Plane.step 에서도 같은 커밋으로 함께 지웠다.
      me.vel = v3.mul(quat.fwd(me.q), spd);
      me.pos = v3.add(me.pos, v3.mul(me.vel, dt));
      if (record) {
        this.pending.push({ seq, dt, cmd: { ...cmd } });
        // 내 기체 조종면 구동값. **렌더 전용**이라 예측·전송에는 안 쓴다.
        // 되감기 재적용(record=false)에서는 갱신하지 않는다 — 그건 과거
        // 입력을 다시 미는 것이라 지금 스틱 위치가 아니다.
        this.lastCmd = [clamp(cmd.roll, -1, 1), clamp(cmd.pitch, -1, 1),
                        clamp(cmd.yaw, -1, 1)];
      }
    }
  }

  predict(dt, cmd, seq) {
    if (!this.cfg || !this.me) return;
    if (this.srv?.al) this._integrate(dt, cmd, true, seq);
    else if (this.me.vel) {
      // 격추 후: 잔해가 떨어지는 동안 카메라가 부드럽게 따라가도록 외삽
      this.me.pos = v3.add(this.me.pos, v3.mul(this.me.vel, dt));
      this.me.vel = v3.add(this.me.vel, [0, -G * 3.4 * dt, 0]);
    }

    // 발사체는 스냅샷 사이를 로컬에서 이어 굴린다
    for (const m of this.missiles) m.pos = v3.add(m.pos, v3.mul(m.vel, dt));
    // 서버 _step_flares 와 **같은 공식**이어야 한다. 예전에는 수직 낙하만
    // 시켰는데 실제로는 모기 속도를 물려받아 수평으로 날아간다.
    for (const f of this.flares) {
      f.vel[1] -= G * dt;
      const drag = 0.9 * dt;
      f.vel[0] -= f.vel[0] * drag;
      f.vel[1] -= f.vel[1] * drag;
      f.vel[2] -= f.vel[2] * drag;
      f.pos = v3.add(f.pos, v3.mul(f.vel, dt));
      f.life -= dt;
    }

    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2);
    for (const b of this.booms) b.t += dt;
    this.booms = this.booms.filter((b) => b.t < b.life);
  }

  addBoom(x, y, z, ground, water) {
    // ground/water 는 착탄 이펙트 분기용이다 — 물이면 물기둥, 땅이면 먼지.
    this.booms.push({ kind: 'boom', x, y, z, t: 0, life: 1.1, ground: !!ground, water: !!water });
    if (this.me && v3.len(v3.sub([x, y, z], this.me.pos)) < 3000) this.sfx?.explode();
  }

  // ── 보간 ────────────────────────────────────────────────────────
  view() {
    const now = performance.now() - DELAY;
    const out = [];
    let a = null, b = null;
    for (let i = this.buf.length - 1; i >= 0; i--) {
      if (this.buf[i].t <= now) { a = this.buf[i]; b = this.buf[i + 1] ?? null; break; }
    }
    if (!a) a = this.buf[0];
    if (!a) return out;
    const t = b ? clamp((now - a.t) / (b.t - a.t), 0, 1) : 0;

    for (const [id, pa] of a.planes) {
      if (id === this.myId && this.me) continue;
      const pb = b?.planes.get(id);
      if (!pb) { out.push({ ...pa, vel: [0, 0, 0], rate: [0, 0, 0] }); continue; }
      // 두 스냅샷 차이로 속도를 추정한다(리드 조준 계산에 쓴다)
      const span = Math.max(1, b.t - a.t) / 1000;
      out.push({
        ...pb,
        pos: [pa.pos[0] + (pb.pos[0] - pa.pos[0]) * t,
              pa.pos[1] + (pb.pos[1] - pa.pos[1]) * t,
              pa.pos[2] + (pb.pos[2] - pa.pos[2]) * t],
        q: quat.slerp(pa.q, pb.q, t),
        vel: [(pb.pos[0] - pa.pos[0]) / span,
              (pb.pos[1] - pa.pos[1]) / span,
              (pb.pos[2] - pa.pos[2]) / span],
        rate: bodyRate(pa.q, pb.q, span, this.ratesOf(id)),
      });
    }
    if (this.me && this.srv) {
      out.push({
        id: this.myId, pos: this.me.pos, q: this.me.q, hp: this.srv.hp,
        alive: !!this.srv.al, ab: !!this.srv.ab, invuln: this.srv.iv > 0,
        stalling: !!this.srv.st, me: true,
        rate: this.lastCmd || [0, 0, 0],
      });
    }
    return out;
  }
}

/**
 * 두 자세에서 **몸통 각속도**를 뽑아 기종 회전율로 나눈 정규화 명령 [-1,1]³.
 * 조종면 편각을 그리는 데만 쓴다(물리는 이 값을 절대 읽지 않는다).
 *
 * `is_bot` 으로 분기하지 않는다는 규칙의 이행이 여기다 — 구동값을 봇 플래그가
 * 아니라 **자세 차분**에서 뽑으므로 봇 기체는 별도 작업 없이 사람과 완전히
 * 같은 규칙으로 조종면이 움직인다.
 *
 * 부호: q_hpb 는 Ry(hdg)·Rx(-pit)·Rz(-bnk) 라 몸통 각속도가
 *   ω_x = -pitchRate·cmd_pitch, ω_y = +yawRate·cmd_yaw, ω_z = -rollRate·cmd_roll
 * 이다(비틀기 0 에서). 그래서 pitch/roll 만 부호를 뒤집는다.
 */
function bodyRate(qa, qb, span, ac) {
  if (!ac) return [0, 0, 0];
  // span 은 view() 에서 Math.max(1, b.t-a.t)/1000 로 이미 막혀 있지만, 여기서
  // 한 번 더 바닥을 깐다 — 두 스냅샷이 같은 ms 에 들어오면 각속도가 폭주한다.
  const dt = Math.max(span, 0.002);
  // rel = qa⁻¹ ⊗ qb (해밀턴) = 몸통 기준 증분 회전
  let rel = quat.mul([qa[0], -qa[1], -qa[2], -qa[3]], qb);
  if (rel[0] < 0) rel = [-rel[0], -rel[1], -rel[2], -rel[3]];   // 최단호
  const s = Math.hypot(rel[1], rel[2], rel[3]);
  if (!(s > 1e-9)) return [0, 0, 0];
  const ang = 2 * Math.atan2(s, Math.min(1, Math.max(-1, rel[0])));
  const k = ang / dt / s;
  const wx = rel[1] * k, wy = rel[2] * k, wz = rel[3] * k;
  const n = (v, r) => (Number.isFinite(v) && r > 0 ? clamp(v / r, -1, 1) : 0);
  return [n(-wz, ac.rollRate), n(-wx, ac.pitchRate), n(wy, ac.yawRate)];
}

function lookQ(dir) {
  const f = [0, 0, 1];
  const d = v3.dot(f, dir);
  if (d > 0.9999) return [1, 0, 0, 0];
  if (d < -0.9999) return quat.axis([0, 1, 0], Math.PI);
  const ax = v3.cross(f, dir);
  return quat.norm([1 + d, ax[0], ax[1], ax[2]]);
}
