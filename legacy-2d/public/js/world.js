// 클라이언트 월드 상태.
//  · 내 비행기 = 로컬 예측(prediction) + 미확인 입력 재시뮬레이션으로 정확 보정
//  · 다른 비행기 = 스냅샷 버퍼 보간(interpolation, 110ms 지연 재생)
//  · 스냅샷은 델타 압축이므로 마지막으로 받은 상태를 유지하며 병합한다
import { clamp } from './input.js';

const DELAY = 110;      // 보간 지연(ms)
const TRAIL = 14;       // 엔진 궤적 점 개수
const MAX_PENDING = 240;

export class World {
  constructor(sfx) {
    this.sfx = sfx;
    this.cfg = null;
    this.k = null;             // 내 기체 클래스 계수
    this.classes = null;
    this.myId = 0;
    this.room = 'main';
    this.roster = new Map();
    this.buf = [];
    this.known = new Map();    // 델타 병합용 마지막 확정 상태
    this.bullets = [];
    this.missiles = [];
    this.pickups = [];
    this.radar = [];
    this.fx = [];
    this.popups = [];          // 데미지 숫자
    this.trails = new Map();
    this.lb = [];
    this.me = null;
    this.srv = null;
    this.shake = 0;
    this.hitFlash = 0;
    this.hurtDirs = [];        // 피격 방향 표시
    this.pending = [];         // 서버가 아직 확인하지 않은 입력
    this.stats = { snaps: 0, bytes: 0, rate: 0, kbps: 0 };
    this._rateT = performance.now();
    this._prevAlive = new Map();
    this._prevLevel = 1;
    this._prevMs = 0;
  }

  setup(msg) {
    this.cfg = msg.cfg;
    this.classes = msg.classes;
    this.weapons = msg.weapons || [];
    this.myId = msg.id;
    this.room = msg.room;
    this.roster.clear();
    for (const r of msg.roster) this.roster.set(r.id, r);
    this.k = this.classes[this.roster.get(msg.id)?.cl] || this.classes.striker;
    this.lb = msg.lb || [];
    this.me = null;
    this.srv = null;
    this.buf.length = 0;
    this.known.clear();
    this.pending.length = 0;
  }

  addPlayer(m) {
    this.roster.set(m.id, { n: m.n, c: m.c, bot: m.bot, cl: m.cl, tg: m.tg });
  }

  removePlayer(id) {
    this.roster.delete(id);
    this.trails.delete(id);
    this._prevAlive.delete(id);
    this.known.delete(id);
  }

  name(id) { return this.roster.get(id)?.n ?? '???'; }
  color(id) { return this.roster.get(id)?.c ?? '#8ab4ff'; }
  tag(id) { return this.roster.get(id)?.tg ?? ''; }

  // ── 스냅샷 수신 ──────────────────────────────────────────────────
  onSnapshot(s, bytes) {
    const now = performance.now();
    this.stats.snaps++;
    this.stats.bytes += bytes || 0;
    if (now - this._rateT > 1000) {
      const dt = (now - this._rateT) / 1000;
      this.stats.rate = Math.round(this.stats.snaps / dt);
      this.stats.kbps = Math.round(this.stats.bytes / dt / 1024 * 10) / 10;
      this.stats.snaps = 0; this.stats.bytes = 0; this._rateT = now;
    }

    const planes = new Map();
    for (const row of s.p) {
      const [id, x, y, a] = row;
      // 4개짜리 행은 "이전 값 그대로" 라는 뜻이다
      if (row.length > 4) this.known.set(id, { hp: row[4], fl: row[5], lv: row[6], sh: row[7] });
      const k = this.known.get(id) || { hp: 100, fl: 1, lv: 1, sh: 0 };
      planes.set(id, {
        id, x, y, a, hp: k.hp, lv: k.lv, sh: k.sh,
        alive: !!(k.fl & 1), boost: !!(k.fl & 2),
        invuln: !!(k.fl & 4), rolling: !!(k.fl & 8), shielded: !!(k.fl & 16),
      });
      const was = this._prevAlive.get(id);
      if (was === true && !(k.fl & 1)) this.boom(x, y, this.color(id));
      this._prevAlive.set(id, !!(k.fl & 1));
    }
    // 시야에서 사라진 기체는 사망 판정 대상에서 제외한다
    for (const id of [...this._prevAlive.keys()]) if (!planes.has(id)) this._prevAlive.delete(id);

    this.buf.push({ t: now, planes });
    if (this.buf.length > 24) this.buf.shift();

    // 시야 밖 기체는 미니맵에만 찍는다(좌표는 1/16 해상도)
    this.radar = (s.rd || []).map(([id, x, y]) => ({ id, x: x * 16, y: y * 16 }));
    this.bullets = s.b.map(([x, y, a, o, sp, w]) => ({ x, y, a, o, sp, w: w || 0 }));
    this.missiles = (s.m || []).map(([x, y, a, o, sp, tg]) => ({ x, y, a, o, sp, tg }));
    this.pickups = (s.u || []).map(([id, kind, x, y]) => ({ id, kind, x, y }));

    if (s.me) this._applyMe(s.me);
  }

  _applyMe(me) {
    const prev = this.srv;
    this.srv = me;

    for (const [hx, hy, dmg] of me.ht || []) {
      this.fx.push({ kind: 'hit', x: hx, y: hy, t: 0, life: 0.32, color: '#ffffff' });
      this.popups.push({ x: hx, y: hy, t: 0, life: 0.8, text: `-${dmg}`, color: '#ffe27a' });
      this.sfx?.hit();
    }
    for (const [hx, hy, dmg] of me.hu || []) {
      this.hurtDirs.push({ a: Math.atan2(hy - me.y, hx - me.x), t: 0, life: 0.9 });
      this.popups.push({ x: hx, y: hy, t: 0, life: 0.8, text: `-${dmg}`, color: '#ff7a9c' });
      this.shake = Math.min(16, this.shake + 4);
      this.hitFlash = 1;
      this.sfx?.hurt();
    }
    for (const kind of me.pk || []) this.sfx?.pickup();
    if (me.lv > this._prevLevel) { this.sfx?.levelup(); this.flashLevel = 1; }
    this._prevLevel = me.lv;
    if (me.lw && !prev?.lw) this.sfx?.warn();
    if (me.lk && !prev?.lk) this.sfx?.lock();
    if (me.ms < this._prevMs) this.sfx?.missile();
    this._prevMs = me.ms;
    if (me.ov && !prev?.ov) { this.sfx?.warn(); this.overheatFlash = 1; }
    if (prev?.al && !me.al) this.sfx?.explode();

    if (!this.me || (!prev?.al && me.al)) {
      this.me = { x: me.x, y: me.y, a: me.a, sp: me.sp, en: me.en,
                  rollT: 0, rollCd: me.rc, rollDir: 1 };
      this.pending.length = 0;
      return;
    }
    // 서버 상태로 되감고, 아직 확인되지 않은 입력을 다시 적용한다
    const m = this.me;
    m.x = me.x; m.y = me.y; m.a = me.a; m.sp = me.sp; m.en = me.en; m.rollCd = me.rc;
    this.pending = this.pending.filter((p) => p.seq > me.ack);
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
    for (const p of this.pending) this._integrate(p.dt, p.cmd, false);
  }

  // ── 예측 ────────────────────────────────────────────────────────
  /** 서버와 동일한 물리. record=true 면 재시뮬레이션 대비로 입력을 쌓는다. */
  _integrate(dt, cmd, record, seq = 0) {
    const c = this.cfg, m = this.me, k = this.k;
    if (!c || !m) return;

    if (cmd.roll && m.rollT <= 0 && m.rollCd <= 0 && m.en >= c.rollCost) {
      m.rollT = c.rollDur; m.rollCd = c.rollCd; m.en -= c.rollCost;
      m.rollDir = cmd.turn >= 0 ? 1 : -1;
      if (record) this.sfx?.roll();
    }
    m.rollCd = Math.max(0, m.rollCd - dt);

    const boosting = cmd.boost && m.en > 1 && m.rollT <= 0;
    let target;
    if (boosting) {
      target = c.speedBoost * k.speed;
      m.en = Math.max(0, m.en - c.boostCost * dt);
    } else {
      target = (c.speedMin + (c.speedMax - c.speedMin) * cmd.throttle) * k.speed;
      m.en = Math.min(c.energyMax, m.en + c.energyRegen * dt);
    }
    const d = target - m.sp, step = c.accel * dt;
    m.sp += clamp(d, -step, step);

    const t = clamp((m.sp - c.speedMin * k.speed) / (c.speedBoost - c.speedMin), 0, 1);
    m.a += cmd.turn * c.turnRate * k.turn * (1 - c.turnFalloff * t) * dt;
    m.x += Math.cos(m.a) * m.sp * dt;
    m.y += Math.sin(m.a) * m.sp * dt;

    if (m.rollT > 0) {
      m.rollT -= dt;
      const side = m.a + Math.PI / 2 * m.rollDir;
      m.x += Math.cos(side) * c.rollPush * dt;
      m.y += Math.sin(side) * c.rollPush * dt;
    }

    const r = Math.hypot(m.x, m.y);
    if (r > c.arenaR) {
      m.x -= (m.x / r) * c.borderPull * dt;
      m.y -= (m.y / r) * c.borderPull * dt;
    }
    if (record) this.pending.push({ seq, dt, cmd: { ...cmd } });
  }

  predict(dt, cmd, seq) {
    if (!this.cfg || !this.me) return;
    if (this.srv?.al) this._integrate(dt, cmd, true, seq);

    // 발사체는 스냅샷 사이를 로컬에서 이어 굴린다
    for (const b of this.bullets) {
      b.x += Math.cos(b.a) * (b.sp || this.cfg.bulletSpeed) * dt;
      b.y += Math.sin(b.a) * (b.sp || this.cfg.bulletSpeed) * dt;
    }
    for (const m of this.missiles) {
      m.x += Math.cos(m.a) * (m.sp || this.cfg.msSpeed) * dt;
      m.y += Math.sin(m.a) * (m.sp || this.cfg.msSpeed) * dt;
    }

    this.shake *= Math.pow(0.001, dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt * 2.2);
    this.flashLevel = Math.max(0, (this.flashLevel || 0) - dt * 1.5);
    for (const f of this.fx) f.t += dt;
    this.fx = this.fx.filter((f) => f.t < f.life);
    for (const p of this.popups) { p.t += dt; p.y -= dt * 34; }
    this.popups = this.popups.filter((p) => p.t < p.life);
    for (const h of this.hurtDirs) h.t += dt;
    this.hurtDirs = this.hurtDirs.filter((h) => h.t < h.life);
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

    const f = b ? clamp((now - a.t) / (b.t - a.t), 0, 1) : 0;
    for (const [id, pa] of a.planes) {
      if (id === this.myId && this.me) continue;   // 내 기체는 예측값을 쓴다
      const pb = b?.planes.get(id);
      if (!pb) { out.push({ ...pa }); continue; }
      let da = (pb.a - pa.a) % (Math.PI * 2);
      if (da > Math.PI) da -= Math.PI * 2;
      if (da < -Math.PI) da += Math.PI * 2;
      out.push({ ...pb, x: pa.x + (pb.x - pa.x) * f, y: pa.y + (pb.y - pa.y) * f,
                 a: pa.a + da * f });
    }
    if (this.me && this.srv) {
      out.push({
        id: this.myId, x: this.me.x, y: this.me.y, a: this.me.a,
        hp: this.srv.hp, lv: this.srv.lv, sh: this.srv.sh, alive: !!this.srv.al,
        boost: this.me.sp > (this.cfg.speedMax * this.k.speed) + 20,
        invuln: this.srv.iv > 0, rolling: this.me.rollT > 0,
        shielded: this.srv.sh > 0, me: true,
      });
    }
    return out;
  }

  pushTrail(p) {
    let tr = this.trails.get(p.id);
    if (!tr) { tr = []; this.trails.set(p.id, tr); }
    if (!p.alive) { tr.length = 0; return tr; }
    const last = tr[tr.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 7) {
      tr.push({ x: p.x, y: p.y });
      if (tr.length > TRAIL) tr.shift();
    }
    return tr;
  }

  boom(x, y, color) {
    this.fx.push({ kind: 'boom', x, y, t: 0, life: 0.7, color });
    if (this.me && Math.hypot(x - this.me.x, y - this.me.y) < 900) {
      this.shake = Math.min(20, this.shake + 8);
      this.sfx?.explode();
    }
  }
}
