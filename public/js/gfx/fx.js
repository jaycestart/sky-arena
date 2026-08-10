// 인스턴싱 파티클 — gl.LINES 이펙트를 전면 교체한다.
//
// 이 게임이 '벡터 그래픽' 으로 보이던 가장 큰 단일 원인은 폭발이 중심에서
// 뻗는 14개 선분이고, 미사일 연기가 **가산 블렌딩** 이라 빛을 흡수하지 않고
// 발광하는 초록 네온 줄이었다는 점이다.
//
// 드로우콜은 파티클 종류 수와 무관하게 2회다 — 가산(불꽃·예광탄·플레어) 과
// 알파(연기, 뒤→앞 정렬).
import { T_SMOKE, T_SPARK, T_FLAME, T_GLOW, T_RING, T_CHUNK, T_STREAK } from './tex.js';

const F = 26;          // 파티클당 상태 float 수
const IF = 13;         // 인스턴스당 float 수 (pos3 size rot tile life col3 stretch3)

// 상태 오프셋.
// **P_SW 는 맨 뒤에만 붙인다.** 기존 오프셋을 한 칸이라도 밀면 build() 인덱싱과
// _p() 가 조용히 어긋나고, 린트가 없는 이 환경에서는 '파티클이 이상하게 생김'
// 으로만 드러난다. 23→26 확장에서 0..22 는 한 글자도 안 바뀐다.
const P_X = 0, P_VX = 3, P_AGE = 6, P_LIFE = 7, P_S0 = 8, P_S1 = 9,
      P_ROT = 10, P_ROTV = 11, P_C0 = 12, P_C1 = 15, P_TILE = 18,
      P_DRAG = 19, P_GRAV = 20, P_STR = 21, P_A0 = 22,
      // 월드 고정 스트레치(3슬롯). P_STR 은 '속도 × 계수' 라 월드에 고정된
      // 선분을 표현할 수 없다 — 미사일 연기 리본이 그걸 필요로 한다.
      P_SW = 23;

class Pool {
  constructor(cap) {
    this.cap = cap;
    this.n = 0;
    this.s = new Float32Array(cap * F);
    // 살아 있는 파티클 + 이번 프레임 전용 인스턴스가 함께 들어간다
    this.inst = new Float32Array(cap * 2 * IF);
    this.order = new Int32Array(cap);
    this.key = new Float32Array(cap);
    this.tn = 0;                 // 이번 프레임만 사는 인스턴스(예광탄 등)
    this.tr = new Float32Array(cap * IF);
  }
  spawn() {
    if (this.n >= this.cap) return -1;
    return this.n++;
  }
  kill(i) {
    this.n--;
    if (i !== this.n) this.s.copyWithin(i * F, this.n * F, this.n * F + F);
  }
  step(dt) {
    const s = this.s;
    for (let i = 0; i < this.n;) {
      const b = i * F;
      s[b + P_AGE] += dt;
      if (s[b + P_AGE] >= s[b + P_LIFE]) { this.kill(i); continue; }
      const dr = Math.max(0, 1 - s[b + P_DRAG] * dt);
      s[b + P_VX] *= dr; s[b + P_VX + 1] *= dr; s[b + P_VX + 2] *= dr;
      s[b + P_VX + 1] += s[b + P_GRAV] * dt;
      s[b + P_X] += s[b + P_VX] * dt;
      s[b + P_X + 1] += s[b + P_VX + 1] * dt;
      s[b + P_X + 2] += s[b + P_VX + 2] * dt;
      s[b + P_ROT] += s[b + P_ROTV] * dt;
      i++;
    }
  }
}

export class Fx {
  constructor(cap) {
    this.setCap(cap);
    this.trails = new Map();
  }
  setCap(cap) {
    const half = Math.max(128, cap >> 1);
    this.add = new Pool(half);
    this.alpha = new Pool(half);
  }
  clear() { this.add.n = 0; this.alpha.n = 0; this.trails.clear(); }

  /** 공용 스폰. pool 은 'add' 또는 'alpha'. */
  _p(pool, x, y, z, vx, vy, vz, o) {
    const P = pool === 'add' ? this.add : this.alpha;
    const i = P.spawn();
    if (i < 0) return;
    const s = P.s, b = i * F;
    s[b] = x; s[b + 1] = y; s[b + 2] = z;
    s[b + P_VX] = vx; s[b + P_VX + 1] = vy; s[b + P_VX + 2] = vz;
    s[b + P_AGE] = 0;
    s[b + P_LIFE] = o.life;
    s[b + P_S0] = o.s0; s[b + P_S1] = o.s1;
    s[b + P_ROT] = o.rot || 0;
    s[b + P_ROTV] = o.rotV || 0;
    s[b + P_C0] = o.c0[0]; s[b + P_C0 + 1] = o.c0[1]; s[b + P_C0 + 2] = o.c0[2];
    const c1 = o.c1 || o.c0;
    s[b + P_C1] = c1[0]; s[b + P_C1 + 1] = c1[1]; s[b + P_C1 + 2] = c1[2];
    s[b + P_TILE] = o.tile;
    s[b + P_DRAG] = o.drag || 0;
    s[b + P_GRAV] = o.grav || 0;
    s[b + P_STR] = o.stretch || 0;
    s[b + P_A0] = o.a0 === undefined ? 1 : o.a0;
    const sw = o.sw;
    s[b + P_SW] = sw ? sw[0] : 0;
    s[b + P_SW + 1] = sw ? sw[1] : 0;
    s[b + P_SW + 2] = sw ? sw[2] : 0;
  }

  update(dt) { this.add.step(dt); this.alpha.step(dt); this.add.tn = 0; this.alpha.tn = 0; }

  /** 이번 프레임만 사는 인스턴스 — 서버가 매 스냅샷 내려주는 예광탄용.
   *  CPU 에서 다시 시뮬레이션하지 않는다(권위가 두 벌이 되면 안 된다). */
  transient(pool, x, y, z, size, tile, col, mul, sx, sy, sz) {
    const P = pool === 'add' ? this.add : this.alpha;
    if (P.tn >= P.cap) return;
    const b = P.tn++ * IF;
    const t = P.tr;
    t[b] = x; t[b + 1] = y; t[b + 2] = z;
    t[b + 3] = size; t[b + 4] = 0; t[b + 5] = tile; t[b + 6] = mul;
    t[b + 7] = col[0]; t[b + 8] = col[1]; t[b + 9] = col[2];
    t[b + 10] = sx || 0; t[b + 11] = sy || 0; t[b + 12] = sz || 0;
  }

  // ── 이펙트 ──────────────────────────────────────────────────────
  /** 격추 폭발: 화구 + 검은 연기 기둥 + 파편 + 충격파 링 */
  explosion(x, y, z) {
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * 6.283, e = (Math.random() - 0.5) * 2;
      const sp = 18 + Math.random() * 46;
      this._p('add', x, y, z, Math.cos(a) * sp, e * sp * 0.7, Math.sin(a) * sp, {
        life: 0.5 + Math.random() * 0.5, s0: 16 + Math.random() * 18, s1: 46,
        rot: Math.random() * 6.283, rotV: (Math.random() - 0.5) * 2,
        c0: [7.0, 4.2, 1.4], c1: [1.4, 0.24, 0.05], tile: T_FLAME, drag: 2.6,
      });
    }
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * 6.283, sp = 6 + Math.random() * 22;
      this._p('alpha', x, y, z, Math.cos(a) * sp, 5 + Math.random() * 12, Math.sin(a) * sp, {
        life: 2.4 + Math.random() * 2.2, s0: 18, s1: 110,
        rot: Math.random() * 6.283, rotV: (Math.random() - 0.5) * 0.7,
        c0: [0.05, 0.045, 0.042], c1: [0.16, 0.155, 0.15], tile: T_SMOKE,
        drag: 0.9, grav: -0.4, a0: 0.72,
      });
    }
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * 6.283, e = (Math.random() - 0.5) * 2;
      const sp = 40 + Math.random() * 130;
      this._p('add', x, y, z, Math.cos(a) * sp, e * sp, Math.sin(a) * sp, {
        life: 0.7 + Math.random() * 0.9, s0: 2.4, s1: 0.6,
        c0: [9.0, 5.0, 1.6], c1: [2.0, 0.35, 0.08], tile: T_CHUNK,
        rot: Math.random() * 6.283, rotV: (Math.random() - 0.5) * 9,
        drag: 0.7, grav: -9.8,
      });
    }
    this._p('add', x, y, z, 0, 0, 0, {
      life: 0.55, s0: 12, s1: 260, c0: [3.0, 2.2, 1.4], c1: [0.4, 0.3, 0.2], tile: T_RING,
    });
  }

  /** 명중: 스파크 + 금속 파편 + 작은 회색 연기 */
  spark(x, y, z, seed) {
    const n = 24;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.283 + seed, e = Math.sin(a * 2.3 + seed);
      const sp = 22 + Math.random() * 48;
      this._p('add', x, y, z, Math.cos(a) * sp, e * sp * 0.8, Math.sin(a) * sp, {
        life: 0.22 + Math.random() * 0.3, s0: 1.5, s1: 0.3,
        c0: [8.0, 5.5, 2.0], c1: [2.0, 0.5, 0.1], tile: T_SPARK,
        drag: 3.2, grav: -9.8,
      });
    }
    for (let i = 0; i < 4; i++) {
      this._p('alpha', x, y, z, (Math.random() - 0.5) * 8, 2 + Math.random() * 4,
              (Math.random() - 0.5) * 8, {
        life: 0.8, s0: 3, s1: 16, c0: [0.22, 0.21, 0.20], c1: [0.30, 0.30, 0.30],
        tile: T_SMOKE, drag: 1.8, a0: 0.5, rot: Math.random() * 6.283,
      });
    }
    this._p('add', x, y, z, 0, 0, 0, {
      life: 0.14, s0: 7, s1: 2, c0: [6.0, 5.4, 4.2], tile: T_GLOW,
    });
  }

  /** 미사일: 노즐 화염(가산) + 회백색 연기 기둥(알파).
   *  초록을 버린다 — 가독성은 HUD 와 밝은 화염이 담당한다. */
  missile(id, pos, vel, dt, sunLit) {
    const st = this.trails.get(id) || { acc: 0, last: null };
    this.trails.set(id, st);
    st.acc += dt;
    const step = 0.02;
    let guard = 0;
    while (st.acc >= step && guard++ < 6) {
      st.acc -= step;
      const j = () => (Math.random() - 0.5) * 2.2;
      this._p('alpha', pos[0] + j(), pos[1] + j(), pos[2] + j(),
              j() * 2, j() * 2 + 1, j() * 2, {
        life: 2.6 + Math.random() * 1.6, s0: 2.6, s1: 34,
        rot: Math.random() * 6.283, rotV: (Math.random() - 0.5) * 0.5,
        c0: [0.55 * sunLit, 0.55 * sunLit, 0.56 * sunLit],
        c1: [0.30 * sunLit, 0.30 * sunLit, 0.32 * sunLit],
        tile: T_SMOKE, drag: 1.1, a0: 0.42,
      });
      this._p('add', pos[0], pos[1], pos[2], -vel[0] * 0.06, -vel[1] * 0.06, -vel[2] * 0.06, {
        life: 0.10, s0: 5.0, s1: 1.5, c0: [6.0, 3.4, 1.2], c1: [1.5, 0.4, 0.1],
        tile: T_FLAME, drag: 2.0,
      });
    }
  }
  dropTrail(id) { this.trails.delete(id); }

  /** 플레어: 밝은 점 + 짧은 연기 꼬리 */
  flare(x, y, z, dt) {
    if (Math.random() > dt * 40) return;
    this._p('add', x, y, z, (Math.random() - 0.5) * 3, -4, (Math.random() - 0.5) * 3, {
      life: 0.5, s0: 4.5, s1: 1.0, c0: [9.0, 5.2, 1.6], c1: [2.2, 0.6, 0.1], tile: T_FLAME,
    });
    this._p('alpha', x, y, z, 0, -2, 0, {
      life: 1.4, s0: 2, s1: 14, c0: [0.4, 0.4, 0.4], tile: T_SMOKE, a0: 0.3,
      rot: Math.random() * 6.283,
    });
  }

  /** 피격 손상 연기 — hp 가 낮을수록 짙고, 25 밑에서는 불꽃도 난다 */
  damage(pos, vel, hp, dt) {
    if (hp >= 55) return;
    const rate = (55 - hp) / 55 * 26;
    if (Math.random() > dt * rate) return;
    this._p('alpha', pos[0], pos[1], pos[2], vel[0] * 0.2, vel[1] * 0.2 + 2, vel[2] * 0.2, {
      life: 2.2, s0: 2.5, s1: 26, c0: [0.045, 0.042, 0.040], c1: [0.13, 0.13, 0.13],
      tile: T_SMOKE, drag: 0.8, a0: 0.6, rot: Math.random() * 6.283,
    });
    if (hp < 25) {
      this._p('add', pos[0], pos[1], pos[2], 0, 0, 0, {
        life: 0.22, s0: 3.4, s1: 1.0, c0: [7.0, 3.0, 0.8], c1: [1.5, 0.3, 0.05], tile: T_FLAME,
      });
    }
  }

  /** 지면/수면 착탄 */
  impact(x, y, z, water) {
    const c0 = water ? [0.9, 1.0, 1.05] : [0.34, 0.29, 0.23];
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * 6.283, sp = 4 + Math.random() * 16;
      this._p('alpha', x, y, z, Math.cos(a) * sp, 12 + Math.random() * 26, Math.sin(a) * sp, {
        life: 1.6, s0: 5, s1: 34, c0, c1: [c0[0] * 0.7, c0[1] * 0.7, c0[2] * 0.7],
        tile: T_SMOKE, drag: 1.4, grav: water ? -12 : -1.5, a0: water ? 0.8 : 0.65,
        rot: Math.random() * 6.283,
      });
    }
    if (water) {
      this._p('alpha', x, 1, z, 0, 0, 0, {
        life: 1.1, s0: 8, s1: 120, c0: [0.85, 0.95, 1.0], tile: T_RING, a0: 0.55,
      });
    }
  }

  // ── 인스턴스 버퍼 ───────────────────────────────────────────────
  /** @returns {number} 인스턴스 개수 */
  build(P, eye, sortBack) {
    const s = P.s, out = P.inst;
    const n = P.n;
    let m = 0;
    // 알파 파티클은 뒤→앞으로 그려야 겹침이 맞는다
    if (sortBack) {
      for (let i = 0; i < n; i++) {
        const b = i * F;
        const dx = s[b] - eye[0], dy = s[b + 1] - eye[1], dz = s[b + 2] - eye[2];
        P.key[i] = -(dx * dx + dy * dy + dz * dz);
        P.order[i] = i;
      }
      const ord = Array.prototype.slice.call(P.order.subarray(0, n));
      ord.sort((a, b) => P.key[a] - P.key[b]);
      for (let k = 0; k < n; k++) P.order[k] = ord[k];
    } else {
      for (let i = 0; i < n; i++) P.order[i] = i;
    }
    for (let k = 0; k < n; k++) {
      const i = P.order[k], b = i * F;
      const t = s[b + P_AGE] / s[b + P_LIFE];
      const o = m * IF;
      out[o] = s[b]; out[o + 1] = s[b + 1]; out[o + 2] = s[b + 2];
      out[o + 3] = s[b + P_S0] + (s[b + P_S1] - s[b + P_S0]) * t;
      out[o + 4] = s[b + P_ROT];
      out[o + 5] = s[b + P_TILE];
      // 수명 슬롯은 셰이더에서 알파 배수로 쓴다 — 끝에서 부드럽게 사라진다
      out[o + 6] = s[b + P_A0] * (1 - t) * (1 - t * 0.35);
      const f = 1 - t;
      out[o + 7] = s[b + P_C1] + (s[b + P_C0] - s[b + P_C1]) * f;
      out[o + 8] = s[b + P_C1 + 1] + (s[b + P_C0 + 1] - s[b + P_C1 + 1]) * f;
      out[o + 9] = s[b + P_C1 + 2] + (s[b + P_C0 + 2] - s[b + P_C1 + 2]) * f;
      // 스트레치 = 속도 기반(예광탄) + 월드 고정(연기 리본). 둘은 배타적으로
      // 쓰지만 합으로 두면 어느 쪽도 특수 분기가 필요 없다.
      const st = s[b + P_STR];
      out[o + 10] = s[b + P_VX] * st + s[b + P_SW];
      out[o + 11] = s[b + P_VX + 1] * st + s[b + P_SW + 1];
      out[o + 12] = s[b + P_VX + 2] * st + s[b + P_SW + 2];
      m++;
    }
    // 이번 프레임 전용 인스턴스를 뒤에 붙인다
    if (P.tn) {
      out.set(P.tr.subarray(0, P.tn * IF), m * IF);
      m += P.tn;
    }
    return m;
  }
}

export { IF as FX_STRIDE, T_STREAK, T_SMOKE, T_GLOW };
