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
    // 미사일 1발이 알파 풀에서 차지할 몫.
    //
    // 예전 구현은 50/s × 평균 수명 3.4s = **발당 정상상태 약 170개**였다.
    // low 프리셋(알파 풀 200)에서는 두 발, high(1000)에서도 여섯 발이면
    // 포화하고, 그 뒤 손상 연기·콘트레일·폭발 연기가 Pool.spawn 의 -1 리턴으로
    // **조용히 전부 사라졌다**(에러도 안 난다). 동시 비행 12발을 기준으로
    // 몫을 잘라 어떤 프리셋에서도 풀이 100% 에 닿지 않게 한다.
    const budget = Math.max(6, Math.floor(half / 12));
    this.ribbonN = Math.max(4, Math.min(20, Math.round(budget * 0.6)));
    this.puffN = Math.max(3, Math.min(15, Math.round(budget * 0.4)));
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

  /**
   * 미사일 궤적 — 앞 1km 는 **월드 고정 리본**, 그 뒤는 성긴 확산 퍼프.
   *
   * 예전 구현에는 버그가 두 개 있었다.
   *  (1) 캐치업 루프가 `st.acc` 만 깎고 위치를 전진시키지 않아 한 프레임에
   *      최대 6개가 **전부 같은 좌표에 겹쳐** 스폰됐다. `st.last` 는 선언만
   *      되고 어디서도 읽히지 않았다 — 보간이 계획됐다가 배선되지 않은 것이다.
   *  (2) 시간(50/s) 기준이라 궤적 간격이 프레임레이트·미사일 속도에 따라
   *      제각각이었다.
   * 이제 **거리 기준**이다. 50m 마다 한 세그먼트를 놓고, 프레임 사이 구간은
   * 선형 보간으로 채운다. 결과가 염주알이 아니라 연속된 밧줄이다.
   */
  missile(id, pos, vel, dt, sunLit) {
    const SEG = 50;          // 리본 세그먼트 길이(m)
    const PUFF_EVERY = 4;    // 200m 마다 확산 퍼프 하나
    let st = this.trails.get(id);
    if (!st) {
      // 첫 프레임은 기준점만 잡는다 — 여기서 바로 스폰하면 발사점에 뭉친다
      this.trails.set(id, { last: [pos[0], pos[1], pos[2]], n: 0 });
      return;
    }
    const sp = Math.max(120, Math.hypot(vel[0], vel[1], vel[2]));
    // 수명 = 그 개수만큼의 세그먼트를 미사일이 지나가는 시간. 속도가 달라도
    // 밧줄의 **길이**가 일정해진다(로켓 2600m/s, 유도탄 1700m/s).
    // 저사양 프리셋에서는 ribbonN 이 줄어 밧줄이 비례 축소되고, 잘리는 끝은
    // build() 의 수명 알파 페이드가 그대로 처리한다(딱 잘린 선이 안 보인다).
    const lifeR = Math.min(4.0, this.ribbonN * SEG / sp);
    const lifeP = Math.min(8.0, this.puffN * SEG * PUFF_EVERY / sp);
    const g0 = 0.60 * sunLit, g1 = 0.32 * sunLit;
    const j = () => (Math.random() - 0.5) * 2.0;
    let dx = pos[0] - st.last[0], dy = pos[1] - st.last[1], dz = pos[2] - st.last[2];
    let d = Math.hypot(dx, dy, dz);
    let guard = 0;
    while (d >= SEG && guard++ < 24) {
      const t = SEG / d;
      const nx = st.last[0] + dx * t, ny = st.last[1] + dy * t, nz = st.last[2] + dz * t;
      const ux = dx / d, uy = dy / d, uz = dz / d;
      // 리본 세그먼트 — 중점에 놓고 진행 방향으로 늘린다. 스프라이트가 방사
      // 블롭이라 길이를 정확히 SEG 로 두면 이음매마다 알파가 꺼져 다시
      // 염주알이 된다. 1.8배로 겹쳐 놓아야 연속으로 읽힌다.
      this._p('alpha', (st.last[0] + nx) * 0.5, (st.last[1] + ny) * 0.5,
              (st.last[2] + nz) * 0.5, 0, 0.5, 0, {
        life: lifeR, s0: 2.2, s1: 11,
        c0: [g0, g0, g0 * 1.02], c1: [g1, g1, g1 * 1.05],
        tile: T_SMOKE, drag: 0.5, a0: 0.55,
        sw: [ux * SEG * 1.8, uy * SEG * 1.8, uz * SEG * 1.8],
      });
      st.n++;
      if (st.n % PUFF_EVERY === 0) {
        this._p('alpha', nx + j(), ny + j(), nz + j(), j() * 1.6, j() * 1.6 + 0.8, j() * 1.6, {
          life: lifeP, s0: 5.0, s1: 40,
          rot: Math.random() * 6.283, rotV: (Math.random() - 0.5) * 0.4,
          c0: [g0, g0, g0 * 1.02], c1: [g1, g1, g1 * 1.05],
          tile: T_SMOKE, drag: 0.9, a0: 0.34,
        });
      }
      // 노즐 화염 — 가산 풀이라 알파 예산과 무관하다
      this._p('add', nx, ny, nz, -vel[0] * 0.05, -vel[1] * 0.05, -vel[2] * 0.05, {
        life: 0.09, s0: 4.6, s1: 1.4, c0: [6.0, 3.4, 1.2], c1: [1.5, 0.4, 0.1],
        tile: T_FLAME, drag: 2.0,
      });
      st.last[0] = nx; st.last[1] = ny; st.last[2] = nz;
      dx = pos[0] - st.last[0]; dy = pos[1] - st.last[1]; dz = pos[2] - st.last[2];
      d = Math.hypot(dx, dy, dz);
    }
  }
  dropTrail(id) { this.trails.delete(id); }

  /**
   * 근접신관 공중폭발 — 격추 폭발과 **다른 이펙트**다.
   *
   * 신관 반경이 40/45m 이고 _sweep 이 경로상 최근접점을 돌려주므로, 폭발은
   * 기체에서 최대 45m 떨어진 허공에서 일어난다. 여기에 격추와 똑같은
   * explosion() 을 쓰면 '맞았는데 왜 저기서 터지지' 가 된다. 탄두만 터진
   * 자리에는 유전 화재가 없으므로 검은 연기 기둥(수명 4.6초짜리 22개)을
   * 빼고, 짧은 흰 섬광 + 진행 방향에 수직인 원반형 파편 링으로 그린다.
   * 알파 풀도 그만큼 아낀다.
   *
   * @param dir 미사일 진행 방향(단위벡터에 가깝지 않아도 된다). 없으면 임의.
   */
  airburst(x, y, z, dir) {
    // 링 평면의 직교 기저 — dir 에 수직인 두 축
    let ax = [0, 1, 0], az = dir && Math.hypot(dir[0], dir[1], dir[2]) > 1e-4
      ? [dir[0], dir[1], dir[2]] : [0, 0, 1];
    const al = Math.hypot(az[0], az[1], az[2]);
    az = [az[0] / al, az[1] / al, az[2] / al];
    if (Math.abs(az[1]) > 0.9) ax = [1, 0, 0];
    let e0 = [ax[1] * az[2] - ax[2] * az[1], ax[2] * az[0] - ax[0] * az[2],
              ax[0] * az[1] - ax[1] * az[0]];
    const l0 = Math.hypot(e0[0], e0[1], e0[2]) || 1;
    e0 = [e0[0] / l0, e0[1] / l0, e0[2] / l0];
    const e1 = [az[1] * e0[2] - az[2] * e0[1], az[2] * e0[0] - az[0] * e0[2],
                az[0] * e0[1] - az[1] * e0[0]];
    // 흰 섬광 하나
    this._p('add', x, y, z, 0, 0, 0, {
      life: 0.16, s0: 9, s1: 34, c0: [9.0, 8.4, 6.4], c1: [2.4, 1.2, 0.4], tile: T_GLOW,
    });
    // 파편 링 — 원반형으로 퍼진다(구형이 아니다. 탄두 파편은 축대칭으로 난다)
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * 6.283 + Math.random() * 0.25;
      const sp = 55 + Math.random() * 75;
      const ca = Math.cos(a) * sp, sa = Math.sin(a) * sp;
      this._p('add', x, y, z,
              e0[0] * ca + e1[0] * sa, e0[1] * ca + e1[1] * sa, e0[2] * ca + e1[2] * sa, {
        life: 0.28 + Math.random() * 0.3, s0: 1.8, s1: 0.4,
        c0: [8.0, 5.0, 1.8], c1: [1.8, 0.4, 0.1], tile: T_SPARK,
        rot: Math.random() * 6.283, rotV: (Math.random() - 0.5) * 8,
        drag: 1.6, grav: -9.8,
      });
    }
    // 짧게 남는 옅은 회색 연기 — 탄두 크기에 맞춰 6개뿐이다
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * 6.283, sp = 6 + Math.random() * 14;
      this._p('alpha', x, y, z, Math.cos(a) * sp, (Math.random() - 0.3) * 6, Math.sin(a) * sp, {
        life: 0.9 + Math.random() * 0.6, s0: 4, s1: 26,
        c0: [0.30, 0.30, 0.31], c1: [0.42, 0.42, 0.43], tile: T_SMOKE,
        drag: 1.5, a0: 0.45, rot: Math.random() * 6.283,
      });
    }
  }

  /** 발사 — 흰-청색 머즐 플래시 + 파일런 아래 발사 연기.
   *  **owner 로 분기하지 않는다.** 내 기체가 화면에서 가장 크므로 내 발사
   *  섬광이 가장 크게 보여야 하고, 봇 발사도 같은 함수를 탄다. */
  launch(pos, fwd, right, up, ms) {
    const P = (a, b, c) => [pos[0] + fwd[0] * a + right[0] * b + up[0] * c,
                            pos[1] + fwd[1] * a + right[1] * b + up[1] * c,
                            pos[2] + fwd[2] * a + right[2] * b + up[2] * c];
    // 발사점은 서버 _launch 와 같은 기체 좌표계 값이다(f·4.0 · r·2.74, 배율 곱).
    const m = P(4.0 * ms, 0, 0);
    this._p('add', m[0], m[1], m[2], 0, 0, 0, {
      life: 0.06, s0: 6.0 * ms, s1: 2.0, c0: [7.5, 8.5, 12.0], c1: [2.0, 2.4, 4.0],
      tile: T_GLOW,
    });
    for (let i = 0; i < 8; i++) {
      const side = (i % 2) ? 1 : -1;
      const p = P((1.2 + Math.random() * 1.6) * ms, 2.74 * ms * side, -0.30 * ms);
      this._p('alpha', p[0], p[1], p[2], (Math.random() - 0.5) * 6,
              -2 - Math.random() * 4, (Math.random() - 0.5) * 6, {
        life: 0.7 + Math.random() * 0.5, s0: 1.6, s1: 13,
        c0: [0.52, 0.51, 0.50], c1: [0.30, 0.30, 0.30], tile: T_SMOKE,
        drag: 2.2, a0: 0.5, rot: Math.random() * 6.283,
      });
    }
  }

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
