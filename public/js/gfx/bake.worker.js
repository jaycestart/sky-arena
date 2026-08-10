// 태양 그림자 · 하늘 차폐(AO) 굽기 — 모듈 Worker.
//
// 태양 방향은 방 단위로 고정이고 지형은 해석 함수다. 매 프레임 계산할 이유가
// 전혀 없다. 프래그먼트 하이트필드 레이마치는 스텝당 삼각함수 8개 × 8~12스텝
// = 픽셀당 96 trig 라 내장 GPU 에서 성립하지 않는다. 여기서 한 번 굽고
// 픽셀당 텍스처 페치 1회로 끝낸다.
//
// 메인 스레드를 절대 점유하지 않는다. 빌드 단계가 없으므로 표준 모듈 Worker 로
// m3d.js 의 terrainH 를 그대로 import 한다 — 공식이 갈라질 여지가 없다.
import { terrainH } from '../m3d.js';

self.onmessage = (e) => {
  const { half, size, aoSize, sun } = e.data;
  const t0 = Date.now();

  // ── 높이장 ────────────────────────────────────────────────────
  // 한 번만 만들어 그림자와 AO 가 함께 쓴다. AO 를 terrainH 로 다시 뜨면
  // 5천만 회 호출이 되어 몇 초씩 걸린다.
  const H = new Float32Array(size * size);
  const ts = (2 * half) / size;
  for (let j = 0; j < size; j++) {
    const z = -half + (j + 0.5) * ts;
    const row = j * size;
    for (let i = 0; i < size; i++) H[row + i] = terrainH(-half + (i + 0.5) * ts, z);
  }

  const shadow = sunShadow(H, size, ts, sun);
  blur3(shadow, size);
  const ao = skyView(H, size, ts, aoSize);
  blur3(ao, aoSize);

  // ── RGBA 한 장에 팩 → 픽셀당 페치 1회 ─────────────────────────
  const out = new Uint8Array(size * size * 4);
  const s2a = aoSize / size;
  for (let j = 0; j < size; j++) {
    const aj = Math.min(aoSize - 1, (j * s2a) | 0) * aoSize;
    for (let i = 0; i < size; i++) {
      const k = (j * size + i) * 4;
      out[k] = Math.max(0, Math.min(255, shadow[j * size + i] * 255)) | 0;
      out[k + 1] = Math.max(0, Math.min(255, ao[aj + Math.min(aoSize - 1, (i * s2a) | 0)] * 255)) | 0;
      out[k + 2] = 0;
      out[k + 3] = 255;
    }
  }
  self.postMessage({ buf: out.buffer, size, ms: Date.now() - t0 }, [out.buffer]);
};

/**
 * 태양 그림자 — O(N) 스캔라인 스윕.
 * 태양 쪽에서 바람 아래(-태양방위) 로 훑으면서 '지금까지 만난 능선이 만드는
 * 그림자 엽면 높이' 하나만 들고 가면 각 텍셀의 가려짐이 한 번에 나온다.
 */
function sunShadow(H, n, ts, sun) {
  const out = new Float32Array(n * n).fill(1);
  const hx = sun[0], hz = sun[2];
  const hl = Math.hypot(hx, hz);
  if (hl < 1e-4 || sun[1] <= 0.02) return out;    // 천정 태양 / 지평선 아래
  const tanE = sun[1] / hl;
  const dx = -hx / hl, dz = -hz / hl;             // 바람 아래 = 태양 반대
  const NEG = -1e9;

  if (Math.abs(dx) >= Math.abs(dz)) {
    const si = dx > 0 ? 1 : -1;
    const jStep = dz / Math.abs(dx);
    const L = ts / Math.abs(dx);
    const drop = L * tanE;
    let prevR = new Float32Array(n).fill(NEG);
    let prevH = new Float32Array(n).fill(NEG);
    let curR = new Float32Array(n);
    let curH = new Float32Array(n);
    const i0 = si > 0 ? 0 : n - 1;
    for (let s = 0; s < n; s++) {
      const i = i0 + si * s;
      for (let j = 0; j < n; j++) {
        const h = H[j * n + i];
        curH[j] = h;
        if (s === 0) { curR[j] = NEG; continue; }
        const jf = j - jStep;
        const j0 = Math.floor(jf);
        const fr = jf - j0;
        const a = clampIdx(j0, n), b = clampIdx(j0 + 1, n);
        const up = Math.max(prevH[a], prevR[a]) * (1 - fr) + Math.max(prevH[b], prevR[b]) * fr;
        const r = up - drop;
        curR[j] = r;
        if (h < r - 0.5) out[j * n + i] = 0;
      }
      const tR = prevR; prevR = curR; curR = tR;
      const tH = prevH; prevH = curH; curH = tH;
    }
  } else {
    const sj = dz > 0 ? 1 : -1;
    const iStep = dx / Math.abs(dz);
    const L = ts / Math.abs(dz);
    const drop = L * tanE;
    let prevR = new Float32Array(n).fill(NEG);
    let prevH = new Float32Array(n).fill(NEG);
    let curR = new Float32Array(n);
    let curH = new Float32Array(n);
    const j0s = sj > 0 ? 0 : n - 1;
    for (let s = 0; s < n; s++) {
      const j = j0s + sj * s;
      const row = j * n;
      for (let i = 0; i < n; i++) {
        const h = H[row + i];
        curH[i] = h;
        if (s === 0) { curR[i] = NEG; continue; }
        const iff = i - iStep;
        const i0 = Math.floor(iff);
        const fr = iff - i0;
        const a = clampIdx(i0, n), b = clampIdx(i0 + 1, n);
        const up = Math.max(prevH[a], prevR[a]) * (1 - fr) + Math.max(prevH[b], prevR[b]) * fr;
        const r = up - drop;
        curR[i] = r;
        if (h < r - 0.5) out[row + i] = 0;
      }
      const tR = prevR; prevR = curR; curR = tR;
      const tH = prevH; prevH = curH; curH = tH;
    }
  }
  return out;
}

/**
 * 하늘 차폐 — 8방위 × 6반경 수평선 스캔.
 * 태양 방향과 무관하므로 한 번만 구우면 된다. 계곡이 어두워지고 능선이
 * 밝아지는 이 효과 하나로 지형이 '매끈한 젤리' 에서 '산' 이 된다.
 */
function skyView(H, n, ts, m) {
  const out = new Float32Array(m * m);
  const scale = n / m;
  const rad = [2, 5, 12, 28, 65, 150];      // H 격자 텍셀 단위, 로그 간격
  const dirs = [];
  for (let d = 0; d < 8; d++) {
    const a = (d / 8) * Math.PI * 2;
    dirs.push([Math.cos(a), Math.sin(a)]);
  }
  for (let j = 0; j < m; j++) {
    const hj = Math.min(n - 1, (j * scale) | 0);
    for (let i = 0; i < m; i++) {
      const hi = Math.min(n - 1, (i * scale) | 0);
      const h0 = H[hj * n + hi];
      let sum = 0;
      for (let d = 0; d < 8; d++) {
        const dx = dirs[d][0], dz = dirs[d][1];
        let best = 0;
        for (let r = 0; r < 6; r++) {
          const rr = rad[r];
          const si = Math.min(n - 1, Math.max(0, (hi + dx * rr) | 0));
          const sj = Math.min(n - 1, Math.max(0, (hj + dz * rr) | 0));
          const dh = H[sj * n + si] - h0;
          if (dh > 0) {
            const ang = dh / (rr * ts);
            if (ang > best) best = ang;
          }
        }
        sum += best / Math.sqrt(1 + best * best);   // sin(atan(best))
      }
      // 완전 평지에서 1, 깊은 계곡에서 작아진다
      out[j * m + i] = Math.max(0.15, 1 - sum / 8);
    }
  }
  return out;
}

function clampIdx(v, n) { return v < 0 ? 0 : (v >= n ? n - 1 : v); }

/** 분리형 3탭 박스 블러 — 부드러운 반그림자 */
function blur3(a, n) {
  const t = new Float32Array(a.length);
  for (let j = 0; j < n; j++) {
    const row = j * n;
    for (let i = 0; i < n; i++) {
      t[row + i] = (a[row + clampIdx(i - 1, n)] + a[row + i] + a[row + clampIdx(i + 1, n)]) / 3;
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      a[j * n + i] = (t[clampIdx(j - 1, n) * n + i] + t[j * n + i] + t[clampIdx(j + 1, n) * n + i]) / 3;
    }
  }
}
