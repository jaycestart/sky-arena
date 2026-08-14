// 지형 클립맵 — 격자 메시 한 장을 유니폼만 바꿔가며 6번 그린다.
//
// 왜 64m 셀인가: terrainH 의 최단 파장이 662m 다. 이 세계에는 662m 보다 작은
// 지오메트리가 **원리적으로 존재하지 않는다.** 4m·20m 셀은 같은 매끄러운
// 곡면을 수백~수천 배 비싸게 그리는 것뿐이다. 클립맵의 실제 가치는
//   (a) 지평선 서브픽셀 삼각형 낭비 회수  (b) 30km 벽 제거
//   (c) 부팅 시 80만 회 CPU 샘플 제거
// 이 셋뿐이고 64m 셀 6링이면 다 얻는다. 표면 디테일은 프래그먼트 노멀 담당.
//
// ── 885 → 662 정정 (2026-08-15, 지형실 실측) ─────────────────────────
// 여기 적혀 있던 885m 는 **x 축 성분만 본 값**이었다. 최고 옥타브는
// `A·sin(kx·x+px)·cos(kz·z+pz)` 인데, 곱-합 항등식으로 풀면
//   sin(a)cos(b) = ½[sin(a+b) + sin(a−b)]
// 이라 이것은 파수벡터 (kx, ±kz) 짜리 **평면파 두 장**이다. 파장은 축 성분이
// 아니라 벡터 길이로 정해진다 — λ = 2π/√(kx²+kz²).
//   kx=0.0071, kz=0.0063  →  λx=885m, λz=997m, **λ(대각)=661.9m**
// 최단 파장은 대각선 41.6도 방향의 662m 다. 885m 는 어느 방향으로도 최단이
// 아니다. (수치 확인 셋: 항등식 잔차 4e-14 / 평면파 진행방향 실측 주기
// 661.94m / 지형 최대 경사 0.626 ≤ 이론 상한 Σ A·|k| = 1.0005 — 숨은 고주파 없다.)
//
// **결론은 안 바뀐다.** 662m 도 64m 셀에는 파장당 10.34 표본이라 나이퀴스트(2)의
// 5.2배다. 아레나 ±6km 에서 57,600 표본으로 잰 격자 재현 오차:
//   64m 셀 최대 1.76m / RMS 0.49m   — 눈에 안 보인다
//   128m 6.93m · 256m 24.9m · 512m 67.7m · 1024m 150m · 2048m 262m
// 바깥 링(1024·2048m)은 파장당 0.65·0.32 표본으로 나이퀴스트 아래지만, 그
// 링은 32~65km 를 덮어 262m 오차가 시각 0.47도(≈7px)다. 게다가 링이 2×cell
// 로 스냅해 표본점이 월드에 고정되므로 헤엄치지 않고 지평선 윤곽만 살짝
// 다르다. 지오메트리는 순수 시각물이라(아래 주석) 판정에는 영향이 없다.
//
// **지오메트리는 물리에 전혀 영향을 주지 않는다.** 지면 충돌·AGL 은 서버
// fp64 terrain_h 가 유일한 권위이고 이 메시는 순수 시각물이다.
// GPU 평가값을 판정에 쓰는 일은 절대 없어야 한다.
import { TERRAIN_MAX } from '../m3d.js';

export const GRID = 64;        // 패치당 셀 수 (정점 65×65 = 4,225)
export const BASE_CELL = 64;   // L0 셀 크기(m)
export const LEVELS = 6;       // 셀 64,128,256,512,1024,2048 → 커버 ±65km

const N = GRID + 1;

/** 65×65 격자 정점 + 링 경계 봉합 표식을 만든다. */
function buildGrid() {
  const pos = new Float32Array(N * N * 2);
  const stitch = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      pos[k * 2] = i;
      pos[k * 2 + 1] = j;
      // 바깥 링(셀 2배)의 변 위에 놓이지 않는 '홀수' 정점만 표시한다.
      // 짝수 정점은 바깥 격자점과 정확히 겹치므로 손댈 필요가 없다.
      const edgeJ = (j === 0 || j === GRID);
      const edgeI = (i === 0 || i === GRID);
      if (edgeJ && (i & 1)) stitch[k] = 1;        // x 축으로 평균
      else if (edgeI && (j & 1)) stitch[k] = 2;   // z 축으로 평균
    }
  }
  return { pos, stitch };
}

/** 꽉 찬 격자 인덱스 (L0). */
function fullIndices() {
  const idx = new Uint16Array(GRID * GRID * 6);
  let n = 0;
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx[n++] = a; idx[n++] = c; idx[n++] = b;
      idx[n++] = b; idx[n++] = c; idx[n++] = d;
    }
  }
  return idx;
}

/** 가운데 32×32 를 비운 링. 구멍 위치가 안쪽 링 위치에 따라 ±1셀 어긋나므로
 *  (ox, oz) 네 변형을 미리 만들어 둔다 — 인덱스 버퍼 4장이면 끝이다. */
function ringIndices(ox, oz) {
  const idx = new Uint16Array((GRID * GRID - 32 * 32) * 6);
  let n = 0;
  const i0 = 16 + ox, i1 = 48 + ox, j0 = 16 + oz, j1 = 48 + oz;
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      if (i >= i0 && i < i1 && j >= j0 && j < j1) continue;
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx[n++] = a; idx[n++] = c; idx[n++] = b;
      idx[n++] = b; idx[n++] = c; idx[n++] = d;
    }
  }
  return { idx, count: n };
}

export class Clipmap {
  constructor(gl) {
    this.gl = gl;
    const g = buildGrid();
    const mk = (data, type) => {
      const b = gl.createBuffer();
      gl.bindBuffer(type, b);
      gl.bufferData(type, data, gl.STATIC_DRAW);
      return b;
    };
    this.vGrid = mk(g.pos, gl.ARRAY_BUFFER);
    this.vStitch = mk(g.stitch, gl.ARRAY_BUFFER);
    const fi = fullIndices();
    this.iFull = mk(fi, gl.ELEMENT_ARRAY_BUFFER);
    this.nFull = fi.length;
    this.rings = [];
    for (let oz = 0; oz < 2; oz++) {
      for (let ox = 0; ox < 2; ox++) {
        const r = ringIndices(ox, oz);
        this.rings.push({ buf: mk(r.idx, gl.ELEMENT_ARRAY_BUFFER), count: r.count });
      }
    }
    this.list = [];
  }

  /**
   * 카메라 위치에서 그릴 패치 목록을 만든다.
   * @param {number[]} cam  카메라 월드 좌표
   * @param {Float32Array} vp  proj*view
   * @param {boolean} flat  물이면 true (y 범위 0)
   */
  patches(cam, vp, flat) {
    const out = this.list;
    out.length = 0;
    const pl = frustum(vp);
    const yLo = flat ? -1 : -TERRAIN_MAX;
    const yHi = flat ? 1 : TERRAIN_MAX;
    let prevCx = 0, prevCz = 0;
    for (let L = 0; L < LEVELS; L++) {
      const cell = BASE_CELL * (1 << L);
      // 2×cell 로 스냅해야 링이 이동해도 경계 정점의 짝/홀 패리티가 유지된다.
      // 스냅하지 않으면 지형이 카메라를 따라 헤엄친다.
      const snap = cell * 2;
      const cx = Math.floor(cam[0] / snap) * snap;
      const cz = Math.floor(cam[2] / snap) * snap;
      const ox = cx - GRID * 0.5 * cell;
      const oz = cz - GRID * 0.5 * cell;
      const size = GRID * cell;
      let buf, count;
      if (L === 0) {
        buf = this.iFull; count = this.nFull;
      } else {
        // 안쪽 링 중심과의 어긋남은 축마다 0 또는 1셀뿐이다
        const hx = Math.round((prevCx - cx) / cell);
        const hz = Math.round((prevCz - cz) / cell);
        const r = this.rings[(hz & 1) * 2 + (hx & 1)];
        buf = r.buf; count = r.count;
      }
      prevCx = cx; prevCz = cz;
      if (aabbVisible(pl, ox, yLo, oz, ox + size, yHi, oz + size)) {
        out.push({ ox, oz, cell, buf, count, stitch: L < LEVELS - 1 ? 1 : 0 });
      }
    }
    return out;
  }
}

// ── 프러스텀 (Gribb-Hartmann) ─────────────────────────────────────
// m 은 열우선 Float32Array — m[col*4 + row].
function frustum(m) {
  const p = [];
  const row = (r) => [m[r], m[4 + r], m[8 + r], m[12 + r]];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  const add = (a, b, s) => {
    const v = [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2], a[3] + s * b[3]];
    const n = Math.hypot(v[0], v[1], v[2]) || 1;
    p.push([v[0] / n, v[1] / n, v[2] / n, v[3] / n]);
  };
  add(r3, r0, 1); add(r3, r0, -1);
  add(r3, r1, 1); add(r3, r1, -1);
  add(r3, r2, 1); add(r3, r2, -1);
  return p;
}

function aabbVisible(pl, x0, y0, z0, x1, y1, z1) {
  for (let i = 0; i < 6; i++) {
    const q = pl[i];
    // 평면에서 가장 먼 쪽 꼭짓점이 뒤에 있으면 완전히 밖이다
    const px = q[0] >= 0 ? x1 : x0;
    const py = q[1] >= 0 ? y1 : y0;
    const pz = q[2] >= 0 ? z1 : z0;
    if (q[0] * px + q[1] * py + q[2] * pz + q[3] < 0) return false;
  }
  return true;
}
