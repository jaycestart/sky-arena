// 3D 수학 — 서버 flightmath.py 와 같은 규약.
// y = 고도, 기체축 forward=+Z, up=+Y, right=+X.

export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
                    a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; },
};

export const quat = {
  // 해밀턴 규약이다 — mul(a, b) 는 'b 를 먼저, a 를 나중에' 적용한다.
  // (quat.hpb 가 hdg⊗pit⊗bnk 순으로 쌓는 것이 그 증거다.)
  // 카메라 자세 quat.mul(swing, planeQ) 가 이 규약에 의존한다: 기체 자세를
  // 먼저 적용하고 그 위에 기수→조준 스윙을 얹는다(스윙은 월드 기준 회전이다).
  mul: (a, b) => [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]],
  norm: (q) => {
    const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  },
  rot: (q, v) => {
    const [w, x, y, z] = q, [vx, vy, vz] = v;
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
    return [vx + w * tx + (y * tz - z * ty),
            vy + w * ty + (z * tx - x * tz),
            vz + w * tz + (x * ty - y * tx)];
  },
  axis: (ax, ang) => {
    const h = ang / 2, s = Math.sin(h), a = v3.norm(ax);
    return [Math.cos(h), a[0] * s, a[1] * s, a[2] * s];
  },
  integrate: (q, w, dt) => {
    const d = quat.mul(q, [0, w[0] * dt / 2, w[1] * dt / 2, w[2] * dt / 2]);
    return quat.norm([q[0] + d[0], q[1] + d[1], q[2] + d[2], q[3] + d[3]]);
  },
  slerp: (a, b, t) => {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    let bb = b;
    if (d < 0) { bb = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
    if (d > 0.9995) {
      return quat.norm([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t,
                        a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
    }
    const th = Math.acos(d), s = Math.sin(th);
    const w1 = Math.sin((1 - t) * th) / s, w2 = Math.sin(t * th) / s;
    return [a[0] * w1 + bb[0] * w2, a[1] * w1 + bb[1] * w2,
            a[2] * w1 + bb[2] * w2, a[3] * w1 + bb[3] * w2];
  },
  /** 직교 기저(right, up, forward) → 쿼터니언 */
  fromBasis: (x, y, z) => {
    const t = x[0] + y[1] + z[2];
    let q;
    if (t > 0) {
      const s = Math.sqrt(t + 1) * 2;
      q = [0.25 * s, (y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s];
    } else if (x[0] > y[1] && x[0] > z[2]) {
      const s = Math.sqrt(1 + x[0] - y[1] - z[2]) * 2;
      q = [(y[2] - z[1]) / s, 0.25 * s, (y[0] + x[1]) / s, (z[0] + x[2]) / s];
    } else if (y[1] > z[2]) {
      const s = Math.sqrt(1 + y[1] - x[0] - z[2]) * 2;
      q = [(z[0] - x[2]) / s, (y[0] + x[1]) / s, 0.25 * s, (z[1] + y[2]) / s];
    } else {
      const s = Math.sqrt(1 + z[2] - x[0] - y[1]) * 2;
      q = [(x[1] - y[0]) / s, (z[0] + x[2]) / s, (z[1] + y[2]) / s, 0.25 * s];
    }
    return quat.norm(q);
  },
  /** from → to 로 기수를 옮기는 최단호 회전. 기수축 둘레 비틀림이 0 이다.
   *  카메라 자세를 이걸로 만들면 마우스가 아무리 움직여도 화면이 기울 수 없다 —
   *  비틀기는 q_plane 안의 bnk 하나에서만 온다. 매 프레임 현재 상태에서 새로
   *  계산하므로 RESUME 의 막다른 길 2번(구면 평행이동 누적)에 빠지지 않는다. */
  swing: (from, to) => {
    const d = v3.dot(from, to);
    if (d > 0.999999) return [1, 0, 0, 0];
    if (d < -0.999999) {
      // 정반대 — 축이 정해지지 않는다. 아무 수직축이나 잡는다(실제로는 리시가 막는다)
      const t = Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      return quat.axis(v3.norm(v3.cross(from, t)), Math.PI);
    }
    const ax = v3.cross(from, to);
    // asin(|ax|) 이 아니라 atan2 다 — 180도 근처에서도 각도가 접히지 않는다
    return quat.axis(ax, Math.atan2(v3.len(ax), d));
  },
  /** v 를 축 ax 둘레로 ang 만큼 돌린다(로드리게스).
   *  hdg/pit 스칼라로 적분하면 수직 근처에서 1/cos(pit) 이 폭주하지만
   *  벡터를 직접 돌리면 극점이 아예 없다 — 조준을 이걸로 굴린다. */
  rotAxis: (v, ax, ang) => quat.rot(quat.axis(ax, ang), v),
  fwd: (q) => quat.rot(q, [0, 0, 1]),
  up: (q) => quat.rot(q, [0, 1, 0]),
  right: (q) => quat.rot(q, [1, 0, 0]),
  /** 방위·기수각·비틀기 → 자세 (서버 flightmath.q_hpb 와 동일) */
  hpb: (hdg, pitch, bank) => {
    const q = quat.mul(quat.axis([0, 1, 0], hdg), quat.axis([1, 0, 0], -pitch));
    return quat.norm(quat.mul(q, quat.axis([0, 0, 1], -bank)));
  },
  /** 자세 → [방위, 기수각, 비틀기] */
  toHpb: (q) => {
    const f = quat.fwd(q), u = quat.up(q), r = quat.right(q);
    return [Math.atan2(f[0], f[2]),
            Math.asin(Math.max(-1, Math.min(1, f[1]))),
            Math.atan2(-r[1], u[1])];
  },
};

export const m4 = {
  ident: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),

  perspective: (fovy, aspect, near, far) => {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0, 0, f, 0, 0,
      0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  },

  /** 쿼터니언 자세 + 위치 → 모델 행렬 */
  fromQuatPos: (q, p, scale = 1) => {
    const [w, x, y, z] = q;
    const s = scale;
    return new Float32Array([
      (1 - 2 * (y * y + z * z)) * s, (2 * (x * y + z * w)) * s, (2 * (x * z - y * w)) * s, 0,
      (2 * (x * y - z * w)) * s, (1 - 2 * (x * x + z * z)) * s, (2 * (y * z + x * w)) * s, 0,
      (2 * (x * z + y * w)) * s, (2 * (y * z - x * w)) * s, (1 - 2 * (x * x + y * y)) * s, 0,
      p[0], p[1], p[2], 1]);
  },

  /** 쿼터니언 자세 + 위치 + **축별** 배율 → 모델 행렬.
   *
   *  미사일을 diag(k, k, 1) 로 굵히는 데 쓴다. fromQuatPos 의 균등 s 를
   *  열 0/1/2 별로 푼 것이 전부다.
   *  법선 주의: 순수 반경 법선 (nx, ny, 0) 은 (k·nx, k·ny, 0) 이 되어
   *  정규화하면 방향이 **정확히 동일**하다. 기우는 것은 노즈콘·보트테일
   *  법선뿐이고, k>1 이 시작되는 거리가 곧 전장 21px 밑이라 눈에 안 닿는다. */
  fromQuatPosS3: (q, p, sx, sy, sz) => {
    const [w, x, y, z] = q;
    return new Float32Array([
      (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
      (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
      (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
      p[0], p[1], p[2], 1]);
  },

  /** 카메라 위치 + 자세 → 뷰 행렬 (모델행렬의 역) */
  view: (q, eye) => {
    const r = quat.rot(q, [1, 0, 0]), u = quat.rot(q, [0, 1, 0]), f = quat.rot(q, [0, 0, 1]);
    // 카메라는 -Z 를 바라보므로 forward 를 뒤집는다
    const b = [-f[0], -f[1], -f[2]];
    return new Float32Array([
      r[0], u[0], b[0], 0,
      r[1], u[1], b[1], 0,
      r[2], u[2], b[2], 0,
      -v3.dot(r, eye), -v3.dot(u, eye), -v3.dot(b, eye), 1]);
  },

  mul: (a, b) => {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
                     + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  },
};

// ── 지형 (서버 flightmath.terrain_h 와 반드시 동일) ─────────────────
// 계수를 '데이터' 로 한 번만 둔다. terrainH() 도, gfx/shaders.js 의 TERRAIN_GLSL
// 도 전부 이 배열에서 만들어진다 — 셰이더에 손으로 옮겨 적을 여지를 구조적으로
// 없애기 위해서다. 옮겨 적으면 언젠가 어긋나서 서버와 다른 곳에 산이 서고,
// '보이지 않는 산' 에서 지면 충돌이 일어난다.
// [A, kx, kz, px, pz]  →  A * sin(kx*x + px) * cos(kz*z + pz)
export const TERRAIN_OCT = [
  [380, 0.00042, 0.00037, 0, 0],
  [190, 0.00119, 0.00097, 1.7, 0.6],
  [70, 0.00301, 0.00279, 3.1, 2.2],
  [22, 0.0071, 0.0063, 0, 0],
];

// 최고 주파수 옥타브의 파장이 약 885m 다 — 이 세계에는 885m 보다 작은
// 지오메트리가 원리적으로 존재하지 않는다. 지형 격자를 더 촘촘히 깎아도
// 같은 곡면을 비싸게 그리는 것뿐이라, 표면 디테일은 전부 프래그먼트가 맡는다.
export function terrainH(x, z) {
  let h = 0;
  for (let i = 0; i < TERRAIN_OCT.length; i++) {
    const o = TERRAIN_OCT[i];
    h += o[0] * Math.sin(o[1] * x + o[3]) * Math.cos(o[2] * z + o[4]);
  }
  return h;
}

/** 30km 메시 실측 최대 637.7m / 최소 -636.9m. 여유를 둔 값. */
export const TERRAIN_MAX = 700;

/** 바다에서는 해수면이 바닥이다 — 서버 flightmath.ground_h 와 같은 식.
 *  지금 클라 예측은 지면 판정을 하지 않지만, 나중에 누군가 넣을 때
 *  서버와 다른 함수를 쓰는 사고를 막으려고 대칭으로 둔다. */
export const groundH = (x, z) => Math.max(terrainH(x, z), 0);

export const RHO0 = 1.225, SCALE_H = 8500, G = 9.80665;
export const airDensity = (alt) => RHO0 * Math.exp(-Math.max(0, alt) / SCALE_H);
export const soundSpeed = (alt) => {
  const t = 288.15 - 0.0065 * Math.min(alt, 11000);
  return Math.sqrt(1.4 * 287.05 * Math.max(t, 216.65));
};
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
