// 기체 · 미사일 · 콕핏 메시 — 절차 생성 로프트. 에셋 파일 없음.
//
// 이전 buildJet 은 총 35 삼각형이었고 날개·미익은 같은 삼각형을 감김만 뒤집어
// 두 번 넣은 것이라 두께가 0 이었다. 동체 꼬리를 닫는 삼각형이 없어 후방에서
// 보면 기체에 구멍이 뚫려 있었다. 후처리를 아무리 붙여도 35 삼각형은
// 35 삼각형처럼 보인다.
//
// 감김 실수로 면이 사라지는 사고를 막기 위해 기체는 컬링을 끄고 그린다
// (scene.js). 대신 법선은 파라미터화에서 명시적으로 바깥쪽으로 뽑는다.

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// ── 메시 실측치 (여기를 바꾸면 아래 소비처를 전부 확인할 것) ─────────
// 소비처: scene.js 의 idScale()/점 스프라이트 전환, server/game.py 의 mscale
// 산출(실물 제원 ÷ 이 값). 지금 세 기종 배율은 전부 이 두 수에서 나온다.
export const JET_SPAN_REF = 12.10;   // 구조 날개폭 — 익단 x = ±6.05
export const JET_LEN_REF = 18.20;    // 전장 — 피토관 z=+10.85 ~ 노즐 z=-7.35
export const MSL_LEN = 3.04;         // 미사일 전장 (z +1.62 ~ -1.42)
export const MSL_DIA = 0.127;        // 미사일 동체 지름 — 실물 AIM-9 과 동일

// 노즐 z. buildJet 의 캡 / buildJetGlow 의 발광 링 / buildAfterburner 의
// 콘 시작이 **전부 이 상수를 참조한다.** 예전에는 세 함수가 -6.80 / -6.72 /
// -6.9 를 따로 들고 있었고, 그 결과 발광 링(-6.72)이 폐쇄 캡(-6.80)보다
// 기수 쪽에 놓여 후방 카메라에서 완전히 가려졌다 — z-파이팅이 아니라 폐색이라
// **AB 를 안 켠 평상시 노즐 발광은 한 번도 렌더된 적이 없었다.**
// 세 곳을 묶어 두지 않으면 나중에 한 곳만 고치고 또 어긋난다.
//
// 깊이 1.25m 는 출구를 뒤로 빼서가 아니라 **캡을 동체 안쪽으로 밀어서** 만든다.
// 뒤로 빼면 전장이 18.20 → 18.90m 가 되고(실측함), 그러면 전장/날개폭이
// 1.504 → 1.562 로 벌어져 mscale 이 기반한 비율이 깨진다 — 세 기종 전장이
// 실물보다 4% 길어진다. 실제 제트 노즐도 동체를 파고든 관이다.
export const NOZZLE_EXIT_Z = -7.35;    // 출구 평면(전장의 뒤끝)
const NOZZLE_THROAT_Z = -7.05;         // 목
const NOZZLE_CAP_Z = -6.10;            // 관 안쪽 끝 — 동체 **속**이다

/** NACA 4자리 두께 분포. t 는 시위 대비 최대두께비. */
function naca(xc, t) {
  const x = Math.min(1, Math.max(0, xc));
  const y = 5 * t * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x
                     + 0.2843 * x * x * x - 0.1015 * x * x * x * x);
  // 뒷전을 정확히 닫는다 — 안 닫으면 얇은 틈이 남아 반짝인다
  return y * (1 - x * x * x * x * 0.0) - 5 * t * 0.0021 * x;
}

/** 도장 카운터셰이딩 — 상면이 어둡고 하면이 밝다. 실제 전투기 도장이다.
 *
 *  M_PAINT 의 metallic 을 0.85 → 0.0 으로 내리면서 재노출했다. shadePBR 의
 *  kd = (1-F)(1-metal) 이라 확산광이 0.15배에서 거의 1.0배로 살아난다 —
 *  알베도를 그대로 두면 기체가 통째로 밝아진다. 방향(위 어둡고 아래 밝게)은
 *  그대로 유지한다. */
function paint(y) {
  const t = Math.max(0, Math.min(1, y * 0.55 + 0.5));
  return [lerp(0.27, 0.17, t), lerp(0.29, 0.19, t), lerp(0.28, 0.20, t)];
}

// ── 렌더 부품 코드 (aSkin.y) ─────────────────────────────────────────
// **셰이더가 부품별로 다르게 그리기 위한 표시다.** FS_PBR 이 이 값으로
//   (1) 패널라인을 어디에 어떤 축으로 그을지,
//   (2) 기종 도장을 어디에 칠할지(손으로 색을 준 면은 건드리면 안 된다),
//   (3) 캐노피 금 코팅 · 수직미익 색 띠 같은 국소 규칙
// 을 가른다. 예전에는 AO 계열 5종뿐이라 **캐노피 유리와 흡입구 덕트가 동체와
// 같은 코드(0)** 였고, 그래서 유리에 패널라인이 그어졌다(y≈1.30 가로줄).
//
// 값을 바꾸면 shaders.js FS_PBR 의 비교 상수를 **같이** 고쳐야 한다.
// 두 파일이 어긋나면 컴파일은 통과하고 화면만 조용히 틀어진다.
const P_BODY = 0;     // 동체
const P_WING = 1;     // 주익
const P_HTAIL = 2;    // 수평미익(전동 스태빌레이터)
const P_VTAIL = 3;    // 수직미익
const P_LIP = 4;      // 흡입구 립
const P_DUCT = 5;     // 흡입구 덕트 안쪽 — 패널라인 없음
const P_NOZ = 6;      // 노즐(바깥 페탈 + 안쪽 셸) — 패널라인 없음
const P_CANOPY = 7;   // 캐노피 유리 — 패널라인 없음
const P_STORE = 8;    // 파일런 + 익하/익단 무장 — 아주 성긴 링만
const P_STRAKE = 9;   // LERX 스트레이크
const P_PITOT = 10;   // 피토관 — 패널라인 없음

/** 헤드리스 검증용. 셰이더는 문자열이라 import 할 수 없으므로 값이 어긋나면
 *  조용히 틀어진다 — 부팅 검사에서 이 표와 FS_PBR 을 대조하라. */
export const JET_PARTS = {
  BODY: P_BODY, WING: P_WING, HTAIL: P_HTAIL, VTAIL: P_VTAIL, LIP: P_LIP,
  DUCT: P_DUCT, NOZ: P_NOZ, CANOPY: P_CANOPY, STORE: P_STORE,
  STRAKE: P_STRAKE, PITOT: P_PITOT,
};

// ── 정점 AO 계열 ─────────────────────────────────────────────────────
// 접촉 그림자를 '어떤 규칙으로' 걸지. 부품 코드와 **1:1 이 아니다** —
// 익단 발사대는 렌더상 STORE(8) 지만 허공에 떠 있어서 '날개 하면 밑' 규칙을
// 쓰면 통째로 새까매진다(그래서 A_FLY 를 준다). 이 값은 GPU 로 가지 않는다.
const A_NONE = 0;   // 자기 자신이라 AO 없음
const A_FLY = 1;    // 동체 접합부가 어두워진다
const A_LOAD = 2;   // 날개 하면 밑이 어두워진다
const A_DUCT = 3;   // 깊이에 따라 고정값
const A_NOZ = 4;    // 고정값

class Mesh {
  constructor() {
    this.pos = []; this.nrm = []; this.col = []; this.mr = [];
    // aSkin = vec2(ao, part). **col 에 굽지 않는다** — 예전 VS_PBR 이
    // vAlb = mix(aColor, uTint, uTintAmt) 로 알베도를 통째로 치환해서 식별
    // 틴트(적기 0.35)가 AO 를 씻어냈다. 반드시 별도 속성이어야 한다.
    this.skin = [];
    // aFlex — 조종면 구동(VS_PBR). 정수부 = 면 ID(1 좌에일러론 · 2 우에일러론 ·
    // 3 스태빌레이터 · 4 러더), 소수부 = 힌지 블렌드 가중치 w.
    // **모든 정점이 반드시 숫자를 갖는다.** undefined 는 Float32Array 에서
    // NaN 이 되고 NaN 정점은 삼각형을 통째로 사라지게 한다(aSkin 과 같은 사고).
    this.flex = [];
    this.flexV = 0;        // 지금 굽는 정점의 aFlex(빌더가 세팅)
    this.flexAt = null;    // 격자용 — (p, i, j) => aFlex
    // AO 계열은 정점당으로 들고 있다가 bakeSkinAO 가 소비하고 버린다.
    this.fams = [];
    this.part = P_BODY;
    this.fam = A_NONE;
  }
  get count() { return this.pos.length / 3; }
  vert(p, n, c, m) {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.col.push(c[0], c[1], c[2]);
    this.mr.push(m[0], m[1]);
    this.skin.push(1.0, this.part);
    this.flex.push(this.flexV);
    this.fams.push(this.fam);
  }
  /** flx 를 주면 세 정점의 aFlex 를 각각 다르게 싣는다(익단 마감처럼 한 삼각형
   *  안에서 힌지 가중치가 갈리는 자리). 안 주면 this.flexV 가 세 개 모두다. */
  tri(a, b, c, na, nb, nc, col, m, flx) {
    const keep = this.flexV;
    if (flx) this.flexV = flx[0];
    this.vert(a, na, col ? col : paint(a[1]), m);
    if (flx) this.flexV = flx[1];
    this.vert(b, nb, col ? col : paint(b[1]), m);
    if (flx) this.flexV = flx[2];
    this.vert(c, nc, col ? col : paint(c[1]), m);
    this.flexV = keep;
  }
  /**
   * 격자 [row][col] 을 스무스 셰이딩으로 붙인다.
   *
   * @param col  배열이면 단색, 함수면 (p, i, j) 로 정점색, null 이면 paint(y)
   * @param flip 법선을 뒤집는다
   * @param wrapJ 열 방향이 **닫힌 고리**임을 알린다(j=0 과 j=C-1 이 같은 점).
   *   안 켜면 양 끝 열의 법선을 한쪽 차분으로만 뽑아 각각 반대로 약 9도씩
   *   기울고, 이음매에 18도 법선 점프가 남는다. 정반사가 그걸 전장 16m 짜리
   *   밝은 줄로 증폭한다(이음매 = 각도 0 = +X = 동체 최대폭 옆선이라 3인칭에서
   *   잘 보인다). **열린 격자(주익·미익·스트레이크·캐노피)에 켜면 양 끝이
   *   이어지며 법선이 뒤집혀 그 면이 통째로 검게 죽는다** — 반드시 false 다.
   */
  grid(g, col, m, flip, wrapJ) {
    const R = g.length, C = g[0].length;
    const W = C - 1;                       // 닫힌 고리의 서로 다른 열 개수
    const n = [];
    for (let i = 0; i < R; i++) {
      n.push([]);
      for (let j = 0; j < C; j++) {
        const jn = wrapJ ? j % W : j;
        const jp = wrapJ ? (jn + 1) % W : Math.min(j + 1, C - 1);
        const jm = wrapJ ? (jn - 1 + W) % W : Math.max(j - 1, 0);
        const a = g[Math.min(i + 1, R - 1)][j], b = g[Math.max(i - 1, 0)][j];
        const c = g[i][jp], d = g[i][jm];
        const u = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        const v = [c[0] - d[0], c[1] - d[1], c[2] - d[2]];
        let nx = u[1] * v[2] - u[2] * v[1];
        let ny = u[2] * v[0] - u[0] * v[2];
        let nz = u[0] * v[1] - u[1] * v[0];
        const l = Math.hypot(nx, ny, nz);
        // l==0 이면 그 행이 한 점으로 뭉친 것이다(오자이브 노즈처럼 반경 0 인
        // 링). 예전에는 `|| 1` 로 넘겨 법선 (0,0,0) 을 그대로 실었는데, 셰이더의
        // normalize(vN) 가 그걸 **NaN** 으로 만들고 varying 보간이 NaN 을 삼각형
        // 전체로 퍼뜨려 그 면이 순흑으로 그려졌다(실측: 익하 무장·익단 발사대
        // 노즈콘 96 삼각형). 아래에서 이웃 행의 법선으로 메운다.
        const s = l > 1e-9 ? (flip ? -1 : 1) / l : 0;
        n[i].push(s ? [nx * s, ny * s, nz * s] : null);
      }
    }
    // 퇴화 링 메우기 — 이웃 행에서 가져온다(원뿔 꼭짓점의 올바른 법선이다).
    // 앞뒤 두 번 훑어 연속으로 뭉친 행도 메운다.
    for (let i = R - 2; i >= 0; i--) {
      for (let j = 0; j < C; j++) if (!n[i][j]) n[i][j] = n[i + 1][j];
    }
    for (let i = 1; i < R; i++) {
      for (let j = 0; j < C; j++) if (!n[i][j]) n[i][j] = n[i - 1][j];
    }
    for (let i = 0; i < R; i++) {
      for (let j = 0; j < C; j++) if (!n[i][j]) n[i][j] = [0, 0, flip ? 1 : -1];
    }
    const cf = (typeof col === 'function') ? col : null;
    const cAt = (p, i, j) => (cf ? cf(p, i, j) : (col ? col : paint(p[1])));
    // 힌지 가중치는 격자 좌표(i=스팬, j=시위)의 함수라 여기서만 뽑을 수 있다.
    const fa = this.flexAt;
    const keep = this.flexV;
    const put = (p, nn, i, j) => {
      if (fa) this.flexV = fa(p, i, j);
      this.vert(p, nn, cAt(p, i, j), m);
    };
    for (let i = 0; i < R - 1; i++) {
      for (let j = 0; j < C - 1; j++) {
        const p00 = g[i][j], p01 = g[i][j + 1], p10 = g[i + 1][j], p11 = g[i + 1][j + 1];
        const n00 = n[i][j], n01 = n[i][j + 1], n10 = n[i + 1][j], n11 = n[i + 1][j + 1];
        put(p00, n00, i, j);
        put(p10, n10, i + 1, j);
        put(p01, n01, i, j + 1);
        put(p01, n01, i, j + 1);
        put(p10, n10, i + 1, j);
        put(p11, n11, i + 1, j + 1);
      }
    }
    this.flexV = keep;
  }
}

// 재질 (metallic, roughness)
//
// M_PAINT 의 metallic 0.85 는 이 목록에서 단일 최대 오류였다 — 도장은
// 유전체다. 금속으로 두면 kd=(1-F)(1-metal) 이 확산광을 0.15배로 죽여
// 기체가 '회색으로 칠한 금속'이 아니라 '다크크롬'으로 읽힌다.
// 다만 이것만 내리면 f0 가 0.26 에서 0.04 로 떨어져 env 항이 급감하므로
// paint() 재노출 · 지면 환경반사 · 정점 AO 를 반드시 같이 넣어야 한다.
const M_PAINT = [0.0, 0.42];
const M_GLASS = [0.0, 0.05];
const M_NOZZLE = [1.0, 0.32];        // 미도장 내열합금 — 여긴 진짜 금속이다
const M_FAN = [1.0, 0.38];           // 압축기 블레이드 — 노즐과 같은 미도장 금속
const M_DUCT = [0.0, 0.92];
const M_PITOT = [1.0, 0.25];         // 미도장 금속봉

/** 슈퍼타원 단면 — 기수 원 → 중앙 납작한 사각 → 노즐 원 */
function section(rx, ry, e, yOff, z, div) {
  const out = [];
  for (let k = 0; k <= div; k++) {
    const a = (k / div) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const p = 2 / e;
    const x = rx * Math.sign(ca) * Math.pow(Math.abs(ca), p);
    const y = ry * Math.sign(sa) * Math.pow(Math.abs(sa), p);
    out.push([x, y + yOff, z]);
  }
  return out;
}

// ── 동체 10 스테이션 [z, rx, ry, e, yOff] ────────────────────────────
// 모듈 스코프에 둔다 — 정점 AO 가 '동체 표면까지의 거리'를 알아야 한다.
const BODY_ST = [
  [9.60, 0.03, 0.03, 2.0, 0.00],
  [8.30, 0.32, 0.28, 2.1, 0.02],
  [6.50, 0.66, 0.52, 2.5, 0.05],
  [4.20, 0.94, 0.72, 3.0, 0.05],
  [1.60, 1.08, 0.80, 3.6, 0.00],
  [-0.80, 1.12, 0.80, 3.6, -0.02],
  [-3.00, 1.05, 0.78, 3.2, -0.02],
  [-4.80, 0.92, 0.72, 2.8, 0.00],
  [-6.00, 0.74, 0.66, 2.3, 0.02],
  [-6.80, 0.58, 0.58, 2.0, 0.02],
];

/** z 위치의 동체 단면(선형보간). AO 와 등마루 페어링이 쓴다. */
function bodySec(z) {
  const S = BODY_ST, n = S.length;
  if (z >= S[0][0]) return { rx: S[0][1], ry: S[0][2], e: S[0][3], yOff: S[0][4] };
  if (z <= S[n - 1][0]) {
    return { rx: S[n - 1][1], ry: S[n - 1][2], e: S[n - 1][3], yOff: S[n - 1][4] };
  }
  for (let i = 0; i < n - 1; i++) {
    if (z <= S[i][0] && z >= S[i + 1][0]) {
      const t = (S[i][0] - z) / (S[i][0] - S[i + 1][0]);
      return { rx: lerp(S[i][1], S[i + 1][1], t), ry: lerp(S[i][2], S[i + 1][2], t),
               e: lerp(S[i][3], S[i + 1][3], t), yOff: lerp(S[i][4], S[i + 1][4], t) };
    }
  }
  return { rx: 0.6, ry: 0.6, e: 2.4, yOff: 0 };
}

/** 동체 **상면**의 y. 등마루 페어링의 밑동을 동체에 정확히 얹으려면 필요하다 —
 *  상수 높이로 얹으면 좌우 끝이 동체에서 떠서 틈이 보인다.
 *  section() 의 슈퍼타원 (|x|/rx)^e + (|y|/ry)^e = 1 을 y 로 푼 것이다. */
function bodyTopY(x, z) {
  const s = bodySec(z);
  const t = Math.min(1, Math.abs(x) / Math.max(s.rx, 1e-6));
  return s.yOff + s.ry * Math.pow(Math.max(0, 1 - Math.pow(t, s.e)), 1 / s.e);
}

/** 주익 하면의 근사 높이 — 파일런·스토어 AO 전용. */
function wingUnderY(x) {
  const u = clamp01((Math.abs(x) - 1.02) / (6.05 - 1.02));
  return lerp(0.02, 0.04, u) - 0.06;
}

/**
 * 정점 AO 를 해석식으로 굽는다(텍스처 베이크가 아니다).
 *
 * shadePBR 은 ao 를 앰비언트와 env 에만 곱하고 직사광에는 안 곱한다 —
 * 직사광에 곱하면 그림자를 두 번 세는 셈이라 옳다. 여기서는 값만 채운다.
 */
function bakeSkinAO(M) {
  const n = M.count;
  for (let i = 0; i < n; i++) {
    const fam = M.fams[i];
    if (fam === A_NONE) continue;
    const px = M.pos[i * 3], py = M.pos[i * 3 + 1], pz = M.pos[i * 3 + 2];
    let ao = 1;
    if (fam === A_FLY) {
      // 동체 표면까지의 거리. 슈퍼타원 역산은 닫힌 해가 없어 타원으로 근사한다.
      const s = bodySec(pz);
      const dy = py - s.yOff;
      const l = Math.hypot(px, dy) || 1e-6;
      const rd = 1 / Math.hypot((px / l) / s.rx, (dy / l) / s.ry);
      ao = 1 - 0.45 * (1 - smoothstep(0, 0.9, l - rd));
    } else if (fam === A_LOAD) {
      // 위쪽 날개면까지의 수직 거리
      const gap = Math.max(0, wingUnderY(px) - py);
      ao = 1 - 0.55 * (1 - smoothstep(0, 0.9, gap));
    } else if (fam === A_DUCT) {
      // 립(z=3.4) 0.35 → 안쪽 끝(z=0.4) 0.08
      ao = lerp(0.08, 0.35, clamp01((pz - 0.4) / 3.0));
    } else if (fam === A_NOZ) {
      ao = 0.5;
    }
    M.skin[i * 2] = ao;
  }
}

const out = (M) => ({
  pos: M.pos, nrm: M.nrm, col: M.col, mr: M.mr, skin: M.skin, flex: M.flex,
  count: M.count,
});

/** 세 점의 면 법선. wantZ 를 주면 그쪽(±Z)을 보도록 부호를 맞춘다 —
 *  엔진 페이스 블레이드는 흡입구 쪽에서만 보이므로 단면(單面)으로 충분하다. */
function faceN(a, b, c, wantZ) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  if (wantZ && nz * wantZ < 0) { nx = -nx; ny = -ny; nz = -nz; }
  return [nx, ny, nz];
}

export function buildJet() {
  const M = new Mesh();
  // 3인칭 기본 + 카메라를 30m 로 당기면서 기체가 화면을 크게 차지하게 됐다.
  // 12분할은 그 크기에서 동체 옆선이 눈에 띄게 각진다. 20분할로 올려도
  // 기체 전체가 5천 삼각형 남짓이라(최대 6기 = 3만) 비용은 무시할 수준이다.
  const DIV = 20;
  const ST = BODY_ST;

  // ── 동체 ──────────────────────────────────────────────────────
  const body = ST.map((s) => section(s[1], s[2], s[3], s[4], s[0], DIV));
  M.grid(body, null, M_PAINT, false, true);

  // ── 노즐 — 수축·확산 2단 + 안쪽 셸 + 플레임홀더 ────────────────
  // 3인칭에서 노즐은 시선과 정면으로 마주보는 유일한 면이라(dot(N,V)≈0.97)
  // 픽셀당 가치가 기체에서 가장 높다. 예전에는 0.55m 짜리 페탈 한 단에
  // 평평한 캡 하나뿐이었다.
  const last = body[body.length - 1];
  const cz = ST[ST.length - 1][0];      // -6.80, 동체 끝
  const cy = ST[ST.length - 1][4];      // 0.02
  const r0 = ST[ST.length - 1][1];      // 0.58
  // 동체 마지막 단면을 반경비로 스케일해 링을 만든다 — 같은 방향벡터를 쓰므로
  // 이음매가 정확히 붙는다(24분할로 올리면 20각형 동체와 틈이 벌어진다).
  const nring = (k, z) => last.map((p) => [p[0] * k, (p[1] - cy) * k + cy, z]);
  // 바깥 페탈: 동체 끝(0.58) → 목(0.50) → 출구(0.66). 수축-확산 실루엣.
  const outZ = [cz, NOZZLE_THROAT_Z, NOZZLE_EXIT_Z];
  const outK = [1.0, 0.50 / r0, 0.66 / r0];
  // 안쪽 관: 동체 **속** 캡(0.44) → 목(0.465) → 출구 내경(0.625).
  // 어느 z 에서도 바깥보다 작아 서로 뚫지 않는다.
  const inZ = [NOZZLE_CAP_Z, NOZZLE_THROAT_Z, NOZZLE_EXIT_Z];
  const inK = [0.44 / r0, 0.465 / r0, 0.625 / r0];
  // 열변색 — 축방향으로 짚색 → 청보라 → 회색. 셰이더가 아니라 정점색이라 비용 0.
  const NCOL = [[0.52, 0.44, 0.30], [0.30, 0.31, 0.44], [0.26, 0.25, 0.24]];
  // 바깥 페탈은 부품상 노즐(패널라인·기종 도장 제외 — 열변색 정점색이 원본이다)
  // 이지만 AO 계열은 A_NONE 이다. 자기 자신에 가려지는 면이 아니다.
  M.part = P_NOZ;
  M.grid(outZ.map((z, i) => nring(outK[i], z)), (p, i) => NCOL[i], M_NOZZLE, false, true);
  M.fam = A_NOZ;
  const gIn = inZ.map((z, i) => nring(inK[i], z));
  M.grid(gIn, [0.16, 0.15, 0.14], M_NOZZLE, true, true);   // flip — 법선이 안쪽
  {
    // 출구 립 — 안팎 셸을 잇는다. 안 이으면 벽 두께(3.5cm)만큼 구멍이 남는다.
    const a = nring(outK[2], NOZZLE_EXIT_Z), b = gIn[2], n = [0, 0, -1];
    for (let k = 0; k < DIV; k++) {
      M.tri(a[k], b[k], a[k + 1], n, n, n, [0.30, 0.29, 0.28], M_NOZZLE);
      M.tri(a[k + 1], b[k], b[k + 1], n, n, n, [0.30, 0.29, 0.28], M_NOZZLE);
    }
    // 관 안쪽 끝을 막는 캡. **발광 링보다 반드시 기수 쪽(z 가 큼)** 이어야
    // 한다 — 이 관계가 뒤집힌 것이 '노즐이 한 번도 안 빛난' 원인이었다.
    const c0 = gIn[0];
    for (let k = 0; k < DIV; k++) {
      M.tri(c0[k], [0, cy, NOZZLE_CAP_Z], c0[k + 1], n, n, n, [0.07, 0.06, 0.06], M_NOZZLE);
    }
    // 플레임홀더 12 스포크 — 1.25m 깊이의 관에 스케일 단서를 준다
    const zf = NOZZLE_CAP_Z - 0.06, ri = 0.13, ro = 0.42;
    const P = (r, a2) => [Math.cos(a2) * r, cy + Math.sin(a2) * r, zf];
    for (let s = 0; s < 12; s++) {
      const a0 = (s / 12) * Math.PI * 2, a1 = a0 + 0.17;
      M.tri(P(ri, a0), P(ro, a0), P(ro, a1), n, n, n, [0.10, 0.09, 0.09], M_NOZZLE);
      M.tri(P(ri, a0), P(ro, a1), P(ri, a1), n, n, n, [0.10, 0.09, 0.09], M_NOZZLE);
    }
  }
  M.part = P_BODY; M.fam = A_NONE;

  // ── 주익 (NACA 두께 · 상반각 · 익단 워시아웃 -2도) ─────────────
  // 상반각은 3.19도였다(Δx 5.03m 에 Δy 0.28m). 실물은 F-16 0도 · F-15 -1도 ·
  // Su-27 0도다. 3.2도 상반각 + 39도 후퇴각은 전투기가 아니라 고등훈련기
  // 조합이고 실루엣에서 즉시 읽힌다. 0.23도로 눕힌다.
  const WING_Y0 = 0.02, WING_Y1 = 0.04;
  M.part = P_WING; M.fam = A_FLY;
  const wing = (side) => {
    const S = 9, C = 12, th = 0.04;
    const up = [], lo = [];
    for (let s = 0; s <= S; s++) {
      const u = s / S;
      const lx = lerp(1.02, 6.05, u) * side;
      const ly = lerp(WING_Y0, WING_Y1, u);     // 상반각 0.23도
      const lz = lerp(2.40, -1.70, u);
      const ch = lerp(5.30, 1.55, u);
      const tw = (-2 * Math.PI / 180) * u;      // 워시아웃
      const ct = Math.cos(tw), st = Math.sin(tw);
      const ru = [], rl = [];
      for (let i = 0; i <= C; i++) {
        const xc = i / C;
        const yt = naca(xc, th) * ch;
        const dz = -xc * ch;
        ru.push([lx, ly + yt * ct - dz * st, lz + yt * st + dz * ct]);
        rl.push([lx, ly - yt * ct - dz * st, lz - yt * st + dz * ct]);
      }
      up.push(ru); lo.push(rl);
    }
    // ── 에일러론 힌지 가중치(격자를 쪼개지 않고 **휘게** 한다) ────────
    // 시위 12분할 중 뒤 25%(xc>=0.75)만 돌리고, 안쪽 45% 스팬은 플랩 구역이라
    // 0 이다. 가중치를 0.999 로 자르는 이유: aFlex = ID + w 인코딩이라
    // w=1.0 이면 값이 다음 ID 와 충돌한다(2.0 을 3 번 면으로 읽는다).
    const AIL = side > 0 ? 2 : 1;      // 1 = 좌 · 2 = 우
    const ailW = (xc) => {
      const w = (xc - 0.75) / 0.25;
      return w <= 0 ? 0 : Math.min(w, 0.999);
    };
    const ailF = (xc, u) => (u < 0.45 || ailW(xc) === 0 ? 0 : AIL + ailW(xc));
    M.flexAt = (p, i, j) => ailF(j / C, i / S);
    // 열린 격자 — wrapJ 는 반드시 false 다(켜면 앞전과 뒷전이 이어지며
    // 법선이 뒤집혀 날개 한 면이 통째로 검게 죽는다).
    M.grid(up, null, M_PAINT, side < 0, false);
    M.grid(lo, null, M_PAINT, side > 0, false);
    M.flexAt = null;
    // 익단 마감 — 익단은 u=1 이라 전부 에일러론 구역이다. 한 삼각형 안에서
    // 시위 위치가 갈리므로 정점별 aFlex 를 실어야 면과 마감이 같이 꺾인다.
    const tu = up[S], tl = lo[S];
    for (let i = 0; i < C; i++) {
      const n = [side, 0, 0];
      const f0 = ailF(i / C, 1), f1 = ailF((i + 1) / C, 1);
      M.tri(tu[i], tl[i], tu[i + 1], n, n, n, null, M_PAINT, [f0, f0, f1]);
      M.tri(tu[i + 1], tl[i], tl[i + 1], n, n, n, null, M_PAINT, [f1, f0, f1]);
    }
    return { up, lo };
  };
  wing(1); wing(-1);

  // ── 수평 미익 ─────────────────────────────────────────────────
  M.part = P_HTAIL;
  const tailPlane = (side) => {
    const S = 6, C = 9, th = 0.05;
    const up = [], lo = [];
    for (let s = 0; s <= S; s++) {
      const u = s / S;
      const lx = lerp(0.85, 3.30, u) * side;
      const ly = lerp(-0.05, 0.02, u);
      const lz = lerp(-4.30, -5.20, u);
      const ch = lerp(2.30, 0.85, u);
      const ru = [], rl = [];
      for (let i = 0; i <= C; i++) {
        const xc = i / C, yt = naca(xc, th) * ch, dz = -xc * ch;
        ru.push([lx, ly + yt, lz + dz]);
        rl.push([lx, ly - yt, lz + dz]);
      }
      up.push(ru); lo.push(rl);
    }
    // 전동 스태빌레이터라 면 전체가 강체로 돈다(w=1). 뿌리가 동체를 뚫지
    // 않는지 실측: z=-4.30 에서 동체 rx=0.956 · ry=0.737 · e=2.91 이라
    // 뿌리 x=0.85 지점의 동체 표면은 y=±0.481 이다. 피벗(시위 40%)에서
    // 뒷전까지 1.38m 이므로 ±12도에서 수직 이동은 0.287m — 동체 안에 남는다.
    M.flexV = 3.999;
    M.grid(up, null, M_PAINT, side < 0, false);   // 열린 격자 — wrapJ false
    M.grid(lo, null, M_PAINT, side > 0, false);
    M.flexV = 0;
  };
  tailPlane(1); tailPlane(-1);

  // ── 수직 미익 2매 ─────────────────────────────────────────────
  // 외경사가 11.3도였다(높이 2.75m 에 바깥 0.55m). F/A-18 값이지 F-15·Su-27
  // 값이 아니다 — 둘 다 거의 수직(0~2도)이다. 2.1도로 세운다.
  M.part = P_VTAIL;
  const fin = (side) => {
    const S = 6, C = 9, th = 0.055;
    const up = [], lo = [];
    for (let s = 0; s <= S; s++) {
      const u = s / S;
      const bx = lerp(0.80, 0.90, u) * side;     // 외경사 2.1도
      const by = lerp(0.55, 3.30, u);
      const bz = lerp(-3.20, -5.10, u);
      const ch = lerp(3.10, 1.15, u);
      const ru = [], rl = [];
      for (let i = 0; i <= C; i++) {
        const xc = i / C, yt = naca(xc, th) * ch, dz = -xc * ch;
        ru.push([bx + yt, by, bz + dz]);
        rl.push([bx - yt, by, bz + dz]);
      }
      up.push(ru); lo.push(rl);
    }
    // 방향타 — 시위 9분할이라 힌지는 xc>=0.667 이다(패널라인의 방향타
    // 힌지선 0.72 와 한 셀 차이. 선을 정확히 힌지에 맞추면 꺾일 때 선이
    // 그리는 그림자와 실제 꺾임이 겹쳐 오히려 안 읽힌다).
    M.flexAt = (p, i, j) => {
      const w = (j / C - 0.667) / 0.333;
      return w <= 0 ? 0 : 4 + Math.min(w, 0.999);
    };
    M.grid(up, null, M_PAINT, side < 0, false);   // 열린 격자 — wrapJ false
    M.grid(lo, null, M_PAINT, side > 0, false);
    M.flexAt = null;
  };
  fin(1); fin(-1);
  M.part = P_BODY; M.fam = A_NONE;

  // ── 흡입구 — 실루엣에서 '전투기' 로 읽히게 하는 핵심 요소 ──────
  const intake = (side) => {
    const zf = 3.4, zb = 0.4;
    const w = 0.42, hgt = 0.50;
    const cxx = 1.12 * side, cyy = -0.42;
    const IN = 14;   // 8각이면 가까이서 흡입구가 다각형인 게 그대로 보인다
    const ring = [];
    for (let k = 0; k <= IN; k++) {
      const a = (k / IN) * Math.PI * 2;
      ring.push([cxx + Math.cos(a) * w, cyy + Math.sin(a) * hgt]);
    }
    const outer = [], inner = [];
    for (let k = 0; k <= IN; k++) {
      outer.push([ring[k][0] * 1.28, ring[k][1] * 1.18, zf]);
      inner.push([ring[k][0], ring[k][1], zf]);
    }
    // 립
    M.part = P_LIP;
    for (let k = 0; k < IN; k++) {
      const n = [side * 0.3, 0, 1];
      M.tri(outer[k], inner[k], outer[k + 1], n, n, n, null, M_PAINT);
      M.tri(outer[k + 1], inner[k], inner[k + 1], n, n, n, null, M_PAINT);
    }
    // 실제로 뚫린 덕트 + 내부 어두운 면. 알베도 0.012 는 순흑에 가까워
    // 깊이감이 아니라 '구멍'으로 읽혔다 — 0.055 로 올리고 깊이는 AO 가 만든다.
    //
    // **덕트가 z=0.4 에서 막히지 않고 그냥 끝나 있었다.** 기체는 감김 사고를
    // 막으려고 컬링을 끄고 그리므로(scene.js), 그 열린 끝으로 동체 안쪽 뒷면이
    // 그대로 보였다 — 관이 아니라 '구멍' 이었다. 한 단(z -0.20)을 더 파서
    // 깊이를 주고 끝에 압축기 페이스를 깐다. 이게 '뚫린 구멍'과 '엔진'을
    // 가르는 전부다.
    M.part = P_DUCT; M.fam = A_DUCT;
    const dz = [zf, zb, -0.20];
    const dk = [1.0, 0.80, 0.78];
    // 링 좌표가 원점 기준이라 k 배는 중심(cxx,cyy)까지 함께 줄인다 — 예전
    // 한 단짜리 코드와 **같은 축소 방식**이라 실루엣이 안 변한다.
    const duct = dz.map((z, i) => inner.map((p) => [p[0] * dk[i], p[1] * dk[i], z]));
    // 닫힌 고리(wrapJ=true) · 법선은 관 안쪽을 향해야 하므로 flip=true.
    M.grid(duct, [0.055, 0.055, 0.060], M_DUCT, true, true);

    // ── 엔진 페이스 ────────────────────────────────────────────────
    // A_DUCT 는 깊이에 따라 ao 0.35→0.08 이라 z=-0.20 면은 거의 어둠에
    // 가라앉고, 립에서 들어온 빛을 받는 블레이드 끝만 번쩍인다.
    const fz = -0.20, fk = dk[2];
    const fcx = cxx * fk, fcy = cyy * fk;   // 덕트 끝 중심
    const fw = w * fk, fh = hgt * fk;       // 덕트 끝 내경(타원)
    const NB = 14;                          // 블레이드 장수
    // 압축기 배면. **덕트 끝 링과 정확히 같은 평면·같은 반경**이라 관이
    // 빈틈없이 닫힌다 — 조금이라도 어긋나면 그 틈으로 동체 안쪽이 다시 보인다.
    const bz = fz;
    const nz1 = [0, 0, 1];
    const rim = (a, s) => [fcx + Math.cos(a) * fw * s, fcy + Math.sin(a) * fh * s, bz];
    for (let k = 0; k < NB; k++) {
      const a0 = (k / NB) * Math.PI * 2, a1 = ((k + 1) / NB) * Math.PI * 2;
      M.tri([fcx, fcy, bz], rim(a0, 1), rim(a1, 1), nz1, nz1, nz1,
            [0.030, 0.030, 0.035], M_FAN);
    }
    // 중심 스피너 — 원뿔(기저 z=-0.20 반경 0.10, 꼭짓점 z=-0.05).
    // 꼭짓점을 흡입구 쪽으로 세워야 옆에서 봐도 안에 '물체' 가 보인다.
    const spr = 0.10, apex = [fcx, fcy, fz + 0.15];
    for (let k = 0; k < NB; k++) {
      const a0 = (k / NB) * Math.PI * 2, a1 = ((k + 1) / NB) * Math.PI * 2;
      const p0 = [fcx + Math.cos(a0) * spr, fcy + Math.sin(a0) * spr, fz];
      const p1 = [fcx + Math.cos(a1) * spr, fcy + Math.sin(a1) * spr, fz];
      // 원뿔 꼭짓점은 grid() 의 퇴화 링 사고가 났던 형상이라 아예 격자를
      // 쓰지 않고 면 법선을 직접 계산한다(법선 (0,0,0) → NaN → 순흑 삼각형).
      const n = faceN(p0, p1, apex, 1);
      M.tri(p0, p1, apex, n, n, n, [0.24, 0.24, 0.26], M_FAN);
    }
    // 방사형 블레이드 14장. 안쪽 모서리와 바깥 모서리의 각도를 22도 어긋나게
    // 잡아 축 둘레로 비튼다 — 안 비틀면 14장이 전부 같은 각도로 빛을 받아
    // 판 하나처럼 보인다.
    const TW = 22 * Math.PI / 180, ri = 0.105;
    for (let k = 0; k < NB; k++) {
      const a = (k / NB) * Math.PI * 2, b2 = a + TW;
      // 배면(fz)보다 반드시 앞(z 가 큼)이어야 한다 — 뒤로 넘기면 깊이 판정에
      // 걸려 블레이드가 통째로 사라진다.
      const i0 = [fcx + Math.cos(a) * ri, fcy + Math.sin(a) * ri, fz + 0.08];
      const i1 = [fcx + Math.cos(a) * ri, fcy + Math.sin(a) * ri, fz + 0.005];
      const o0 = [fcx + Math.cos(b2) * fw * 0.98, fcy + Math.sin(b2) * fh * 0.98, fz + 0.08];
      const o1 = [fcx + Math.cos(b2) * fw * 0.98, fcy + Math.sin(b2) * fh * 0.98, fz + 0.005];
      const n = faceN(i0, o0, o1, 1);
      M.tri(i0, o0, o1, n, n, n, [0.20, 0.20, 0.22], M_FAN);
      M.tri(i0, o1, i1, n, n, n, [0.20, 0.20, 0.22], M_FAN);
    }
    M.part = P_BODY; M.fam = A_NONE;
  };
  intake(1); intake(-1);

  // ── 익근 스트레이크(LERX) ─────────────────────────────────────
  // 주익 앞전에서 기수 쪽으로 뻗는 얇은 판. 실루엣을 '전투기'로 읽히게 하는
  // 요소인데 빠져 있었다 — 3인칭에서 내 기체를 계속 보게 되니 특히 눈에 띈다.
  M.part = P_STRAKE; M.fam = A_FLY;
  const strake = (side) => {
    const N = 6, hh = 0.055;
    const up = [], lo = [];
    for (let s = 0; s <= N; s++) {
      const u = s / N;
      // 앞은 가늘게 시작해 주익 앞전에서 두꺼워진다
      const z = lerp(5.30, 2.40, u);
      const xo = lerp(0.62, 1.04, u) * side;
      const xi = lerp(0.50, 0.96, u) * side;
      const y = lerp(0.30, 0.12, u);
      const t = hh * Math.sin(Math.PI * Math.min(1, u * 1.15));
      up.push([xo, y + t, z], [xi, y + t, z]);
      lo.push([xo, y - t, z], [xi, y - t, z]);
    }
    // 위/아래 면을 각각 스트립으로 (열린 격자 — wrapJ false)
    for (const [rows, flip] of [[up, side < 0], [lo, side > 0]]) {
      const g = [];
      for (let s = 0; s <= N; s++) g.push([rows[s * 2], rows[s * 2 + 1]]);
      M.grid(g, null, M_PAINT, flip, false);
    }
  };
  strake(1); strake(-1);
  M.part = P_BODY; M.fam = A_NONE;

  // ── 파일런 + 익하 무장 ────────────────────────────────────────
  // 무장이 달려 있어야 군용기로 보인다. 실제로 쏘는 미사일과는 별개의
  // 장식 지오메트리다(발사해도 사라지지 않는다 — 교전 거리에서 티가 안 난다).
  //
  // 치수는 전부 실물이다: AIM-120 3.66×0.178m, AIM-9X 3.02×0.127m.
  // 예전 값(3.6×0.40, 3.2×0.34)은 지름이 2.2배 뚱뚱했다. 카메라가 62m 뒤에
  // 있던 시절의 가시성 보정으로 보이는데 지금은 23m 라 근거가 없다.
  const STORE = [0.0, 0.50];         // 흰 도장 — 유전체다
  const store = (cx, cy2, cz2, len, rad, finR) => {
    const DV = 8, NS = 7;
    const g = [];
    for (let s = 0; s <= NS; s++) {
      const u = s / NS;
      // 앞은 오자이브, 뒤는 살짝 좁아지는 보트테일
      const r = rad * (u < 0.22 ? Math.sqrt(u / 0.22)
                                : (u > 0.86 ? 1 - (u - 0.86) / 0.14 * 0.35 : 1));
      const z = cz2 + lerp(len * 0.5, -len * 0.5, u);
      const row = [];
      for (let k = 0; k <= DV; k++) {
        const a = (k / DV) * Math.PI * 2;
        row.push([cx + Math.cos(a) * r, cy2 + Math.sin(a) * r, z]);
      }
      g.push(row);
    }
    M.grid(g, [0.62, 0.62, 0.60], STORE, false, true);   // 닫힌 회전체
    // 꼬리 날개 4장
    for (let f = 0; f < 4; f++) {
      const a = (f / 4) * Math.PI * 2 + Math.PI / 4;
      const ca = Math.cos(a), sa = Math.sin(a);
      const zb = cz2 - len * 0.30, zt = cz2 - len * 0.50;
      const p0 = [cx + ca * rad, cy2 + sa * rad, zb];
      const p1 = [cx + ca * rad, cy2 + sa * rad, zt];
      const p2 = [cx + ca * finR, cy2 + sa * finR, zt];
      const p3 = [cx + ca * finR, cy2 + sa * finR, zb + (zt - zb) * 0.35];
      const n = [-sa, ca, 0];
      M.tri(p0, p1, p2, n, n, n, [0.55, 0.55, 0.54], STORE);
      M.tri(p0, p2, p3, n, n, n, [0.55, 0.55, 0.54], STORE);
      const m = [sa, -ca, 0];
      M.tri(p0, p2, p1, m, m, m, [0.55, 0.55, 0.54], STORE);
      M.tri(p0, p3, p2, m, m, m, [0.55, 0.55, 0.54], STORE);
    }
  };
  const pylon = (cx, cz2, top, bot, half, len) => {
    const g = [];
    for (const zz of [cz2 + len * 0.5, cz2 - len * 0.5]) {
      g.push([[cx - half, top, zz], [cx + half, top, zz],
              [cx + half, bot, zz], [cx - half, bot, zz],
              [cx - half, top, zz]]);
    }
    M.grid(g, [0.30, 0.31, 0.32], M_PAINT, false, true);   // 닫힌 단면
  };
  const hardpoint = (side) => {
    // 주익 위치는 wing() 의 보간과 맞춘다: x 1.02→6.05, z 2.40→-1.70.
    // **여기가 wing() 의 보간을 손으로 베껴 쓰는 자리다** — 상반각(WING_Y0/Y1)을
    // 바꿀 때 이쪽을 같이 안 고치면 무장이 날개에서 떨어져 공중에 뜬다.
    M.part = P_STORE; M.fam = A_LOAD;
    for (const [u, len, rad] of [[0.34, 3.66, 0.089], [0.60, 3.02, 0.0635]]) {
      const x = lerp(1.02, 6.05, u) * side;
      const y = lerp(WING_Y0, WING_Y1, u);
      const z = lerp(2.40, -1.70, u) - lerp(5.30, 1.55, u) * 0.45;
      // 실물 파일런은 스토어 지름과 같은 폭이다(반폭 0.075 → 0.05).
      pylon(x, z, y - 0.02, y - 0.24, 0.05, 1.5);
      store(x, y - 0.24 - rad, z, len, rad, rad * 2.52);
    }
    // 익단 발사대 — 짧은 단거리탄이었는데 2.5×0.26m 라 짧고 뚱뚱했다.
    // AIM-9X 실물(3.02×0.127)로 바꾼다. 렌더상으로는 무장(P_STORE)이지만
    // 익단은 허공이라 접촉 그림자가 없으므로 **AO 계열만 A_FLY** 로 둔다
    // (A_LOAD 로 두면 '날개 하면 밑' 규칙에 걸려 통째로 새까매진다).
    M.fam = A_FLY;
    const tx = 6.05 * side, ty = WING_Y1, tz = -1.70 + 5.30 * 0.06;
    store(tx, ty + 0.02, tz + 1.5, 3.02, 0.0635, 0.175);
    M.part = P_BODY; M.fam = A_NONE;
  };
  hardpoint(1); hardpoint(-1);

  // ── 피토관 ────────────────────────────────────────────────────
  {
    M.part = P_PITOT;
    const g = [];
    for (const [z, r] of [[9.60, 0.030], [10.85, 0.012]]) {
      const row = [];
      for (let k = 0; k <= 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        row.push([Math.cos(a) * r, 0.03 + Math.sin(a) * r, z]);
      }
      g.push(row);
    }
    M.grid(g, [0.08, 0.08, 0.09], M_PITOT, false, true);   // 닫힌 회전체
    M.part = P_BODY;
  }

  // ── 캐노피 ────────────────────────────────────────────────────
  // 별도 투명 패스를 만들지 않는다 — 정렬·블렌드 상태 전환이 따라붙는데
  // 교전 거리에서는 불투명 + 강한 프레넬 + 하늘 반사만으로 유리로 읽힌다.
  {
    M.part = P_CANOPY;
    const S = 8, C = 10;
    const g = [];
    for (let s = 0; s <= S; s++) {
      const t = s / S;                      // 0 = 앞, 1 = 뒤
      const z = lerp(5.6, 0.4, t);
      const w = 0.50 + 0.42 * Math.sin(t * Math.PI) - 0.10 * t;
      const hgt = 0.42 + 0.52 * Math.sin(Math.pow(t, 0.75) * Math.PI * 0.92);
      const base = 0.55 + 0.14 * t;
      const row = [];
      for (let i = 0; i <= C; i++) {
        const a = Math.PI * (i / C);
        row.push([Math.cos(a) * w, base + Math.sin(a) * hgt, z]);
      }
      g.push(row);
    }
    // 반원(0~π)이라 **열린 격자**다 — wrapJ 를 켜면 좌우 밑동이 이어지며
    // 법선이 뒤집혀 캐노피가 통째로 검게 죽는다.
    M.grid(g, [0.045, 0.062, 0.085], M_GLASS, false, false);
    M.part = P_BODY;
  }

  // ── 캐노피 뒤 등마루(spine) 페어링 ──────────────────────────────
  // 3인칭 기본 시점에서 화면 정중앙 바로 아래가 민둥한 원뿔이었다. 실제
  // 전투기는 여기에 배선·연료·감속판 액추에이터가 들어가는 페어링이 있다.
  // 수직미익 뿌리(z=-3.20)와 교차하지 않게 z=-3.0 에서 끊는다.
  {
    M.part = P_BODY; M.fam = A_FLY;
    const SS = 7, SC = 9;      // (7-1)*(9-1)*2 = 96 삼각형
    const g = [];
    for (let s = 0; s < SS; s++) {
      const t = s / (SS - 1);
      const z = lerp(0.4, -3.0, t);
      const hw = lerp(0.40, 0.22, t);     // 반폭
      const hh = lerp(0.22, 0.05, t);     // 동체 상면 대비 높이
      const row = [];
      for (let j = 0; j < SC; j++) {
        const u = j / (SC - 1);
        const x = hw * Math.cos(Math.PI * u);          // +hw → -hw
        // 밑동(u=0,1)에서 sin=0 이라 정확히 동체 상면에 앉는다.
        row.push([x, bodyTopY(x, z) + hh * Math.sin(Math.PI * u), z]);
      }
      g.push(row);
    }
    // **좌우로 열린 격자다 — wrapJ 는 반드시 false.** 켜면 양 끝 열이 이어지며
    // 법선이 뒤집혀 등마루가 통째로 검게 죽는다(grid() 주석).
    M.grid(g, null, M_PAINT, false, false);
    M.fam = A_NONE;
  }

  bakeSkinAO(M);
  return out(M);
}

/** 노즐 내부 발광 링 + 항법등. 조명을 받지 않는 발광체로 따로 그린다.
 *  mr.x 슬롯에 밝기 배수를 싣는다(VS_GLOW 규약). */
export function buildJetGlow() {
  const M = new Mesh();
  const DIV = 12;
  // 관 **안쪽**에 둔다. 폐쇄 캡(NOZZLE_CAP_Z)보다 카메라 쪽이고 출구보다
  // 안쪽이라 후방에서는 보이고 옆에서는 노즐 벽에 가려진다(맞는 동작).
  // 반경 0.42 는 그 깊이의 관 내경(약 0.464)보다 작아 벽을 뚫지 않는다.
  const gz = NOZZLE_EXIT_Z + 0.35;
  const ring = section(0.42, 0.42, 2.0, 0.02, gz, DIV);
  // mr.y = 1 → **추력 연동**(VS_GLOW 가 uGlow 를 곱한다). 항법등은 0 이라
  // 스로틀을 놓아도 안 어두워진다 — 같은 메시 안에서 갈리는 유일한 규칙이다.
  for (let k = 0; k < DIV; k++) {
    M.tri(ring[k], [0, 0.02, gz], ring[k + 1], [0, 0, -1], [0, 0, -1], [0, 0, -1],
          [1.0, 0.42, 0.14], [3.5, 1]);
  }
  /** 항법등. axis 'x' 면 YZ 평면 쿼드(익단에서 바깥을 향한다), 그 외는 XY. */
  const lamp = (p, c, b, half, axis) => {
    const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const w = q.map((o) => (axis === 'x'
      ? [p[0], p[1] + o[0] * half, p[2] + o[1] * half]
      : [p[0] + o[0] * half, p[1] + o[1] * half, p[2]]));
    const n = axis === 'x' ? [Math.sign(p[0]) || 1, 0, 0] : [0, 0, 1];
    M.tri(w[0], w[1], w[2], n, n, n, c, [b, 0]);
    M.tri(w[0], w[2], w[3], n, n, n, c, [b, 0]);
  };
  // 예전 위치 [±6.0, 0.30, -1.6] 는 한 변 0.26m 쿼드가 **날개를 관통했다**
  // (그 z 에서 날개 상/하면이 y≈0.29~0.31, 글로우 패스는 컬링이 꺼져 있어
  // 교선이 그대로 보인다). 익단 캡(x=±6.05) 바깥 4cm 로 빼고, 익단 발사대가
  // 차지한 z 구간(-1.39~+1.63)을 피해 뒤로 물린다. 쿼드 평면도 YZ 로 눕혀
  // 날개와 교차할 수 없게 만들었다.
  // 좌현 적색 / 우현 녹색 — +X 가 오른쪽이므로(scene.js 좌표 규약) 예전
  // 배치는 좌우가 뒤집혀 있었다.
  lamp([6.09, 0.019, -2.30], [0.06, 1.0, 0.18], 6, 0.07, 'x');
  lamp([-6.09, 0.019, -2.30], [1.0, 0.06, 0.06], 6, 0.07, 'x');
  // 후미등: 예전 [0, 3.30, -5.0] 은 수직미익 외경사를 11.3도 → 2.1도로 세운
  // 뒤 좌우 미익(x=±0.90) 사이 허공에 떠 버린다. 동체 등마루로 옮긴다.
  lamp([0, 0.665, -6.55], [1.0, 1.0, 1.0], 8, 0.055, 'z');
  return out(M);
}

/** 애프터버너 콘 — ab 플래그가 설 때만 그린다. 축을 따라 밝은 띠(충격
 *  다이아몬드)를 넣고 노즐 근처는 청보라, 뒤쪽은 주황. 블룸이 번지게 한다. */
export function buildAfterburner() {
  const M = new Mesh();
  const DIV = 10, SEG = 7;
  const rows = [];
  for (let s = 0; s <= SEG; s++) {
    const t = s / SEG;
    // 출구 평면에서 시작한다. 예전 -6.9 는 새 노즐(출구 -8.05) 안쪽 깊숙한
    // 곳이라 콘이 노즐 벽을 뚫고 나온다.
    const z = NOZZLE_EXIT_Z - t * 11.0;
    const r = 0.50 * (1 - t * 0.82) * (1 + 0.22 * Math.sin(t * 13.0));  // 충격 다이아몬드
    rows.push(section(r, r, 2.0, 0.02, z, DIV));
  }
  for (let s = 0; s < SEG; s++) {
    const t0 = s / SEG, t1 = (s + 1) / SEG;
    const c0 = abColor(t0), c1 = abColor(t1);
    for (let k = 0; k < DIV; k++) {
      const n = [0, 0, 0];
      M.tri(rows[s][k], rows[s + 1][k], rows[s][k + 1], n, n, n, c0, [1, 0]);
      M.tri(rows[s][k + 1], rows[s + 1][k], rows[s + 1][k + 1], n, n, n, c1, [1, 0]);
    }
  }
  return out(M);
}
/**
 * 순항 배기 코어 — AB 를 안 켠 평상시에 '엔진이 돌고 있다' 를 보이는 유일한
 * 빛이다. 예전에는 반경 0.42m 발광 디스크 하나가 전부라 순항 중 노즐이
 * 죽어 있었다. AB 콘의 축소판이되 **충격 다이아몬드가 없고**(재연소가 없으니
 * 마하 디스크도 없다) 훨씬 어둡고 붉다.
 *
 * 시작 z 는 반드시 NOZZLE_EXIT_Z 다. 세 함수가 -6.80/-6.72/-6.9 를 따로
 * 들고 있다가 발광 링이 폐색됐던 사고(파일 앞쪽 주석)를 재발시키지 않는다.
 * 출구(-7.35)에서 뒤로 가므로 발광 링(-7.00)보다 항상 카메라 쪽이고,
 * 가산 블렌딩 + depthMask(false) 로 그려서 링을 가리지 않는다.
 */
export function buildExhaust() {
  const M = new Mesh();
  const DIV = 10, SEG = 4;
  const rows = [];
  for (let s = 0; s <= SEG; s++) {
    const t = s / SEG;
    const z = NOZZLE_EXIT_Z - t * 2.2;     // AB 는 11.0m — 이건 2.2m 다
    const r = lerp(0.50, 0.12, t);
    rows.push(section(r, r, 2.0, 0.02, z, DIV));
  }
  for (let s = 0; s < SEG; s++) {
    const c0 = exColor(s / SEG), c1 = exColor((s + 1) / SEG);
    for (let k = 0; k < DIV; k++) {
      const n = [0, 0, 0];
      // mr = [1, 1] — 밝기 1배 · 추력 연동 켬
      M.tri(rows[s][k], rows[s + 1][k], rows[s][k + 1], n, n, n, c0, [1, 1]);
      M.tri(rows[s][k + 1], rows[s + 1][k], rows[s + 1][k + 1], n, n, n, c1, [1, 1]);
    }
  }
  return out(M);
}
function exColor(t) {
  const f = (1 - t) * (1 - t);
  return [(1.05 + 0.7 * t) * f, (0.30 + 0.16 * t) * f, (0.14 - 0.09 * t) * f];
}

function abColor(t) {
  const f = (1 - t) * (1 - t);
  return [
    (0.55 + 3.4 * t) * f * 3.0,
    (0.42 + 1.5 * t * t) * f * 3.0,
    (2.20 - 1.9 * t) * f * 3.0,
  ];
}

/**
 * 미사일 — 실물 AIM-9X 는 3.02×0.127m 다. 전장(3.04m)은 +0.7% 로 이미 맞았고
 * 지름만 0.28m 로 2.2배 뚱뚱했다(세장비 10.9 = 몽둥이). 반경만 0.4536 배 해
 * 세장비를 23.8 로 되돌린다. z 좌표는 한 글자도 안 건드린다.
 * 원거리 가시성은 메시가 아니라 scene.js 의 반경 전용 픽셀 바닥이 산다.
 */
export function buildMissile() {
  const M = new Mesh();
  // 8분할 팔각기둥은 mslRadiusK() 가 살려 두는 근거리(264m 안쪽)에서 각진
  // 봉으로 그대로 읽혔다. **보이는 구간이 근거리뿐**이라 그 구간의 형상이
  // 곧 이 메시의 전부다. 12분할로 올린다.
  const DIV = 12;
  // z 는 절대 안 건드린다 — 전장 3.04m(+1.62 ~ -1.42)는 MSL_LEN 상수를 쓰는
  // 픽셀 바닥 계산의 전제다.
  //
  // 노즈 = **반구형 시커 돔**(R=0.0475, 중심 z=1.5725). 어둡고 번들거리는
  // 코는 '유도탄' 의 가장 강한 단일 신호다. 재질이 유리라 동체 격자와 분리해
  // 굽는다(한 grid 는 재질을 하나만 갖는다). 이음매의 법선 단절은 여기서는
  // 옳다 — 유리와 금속의 경계다.
  const DOME_R = 0.0475, DOME_Z = 1.5725;
  const dome = [];
  for (const th of [0, 31, 55, 77, 90]) {
    const a = th * Math.PI / 180;
    dome.push(section(DOME_R * Math.sin(a), DOME_R * Math.sin(a), 2.0, 0,
                      DOME_Z + DOME_R * Math.cos(a), DIV));
  }
  // th=0 은 반경 0 인 퇴화 링이다. grid() 가 이웃 행 법선으로 메우므로
  // 법선 (0,0,0) → NaN → 순흑 삼각형 사고는 나지 않는다(파일 앞쪽 주석).
  M.grid(dome, [0.05, 0.05, 0.07], [0.0, 0.06], false, true);
  // 동체 — 돔 적도에서 시작해 보트테일까지. 오자이브 어깨를 3점으로 나눈다.
  const ST = [
    [DOME_Z, 0.0475], [1.470, 0.0565], [1.300, 0.0635],
    [-0.600, 0.0635], [-1.300, 0.0590], [-1.420, 0.0500],
  ];
  const g = ST.map((s) => section(s[1], s[1], 2.0, 0, s[0], DIV));
  // 도장은 오프화이트 + 노즈 뒤 갈색 띠(탄두 표시). 하늘 배경에서 밝은
  // 창으로 읽혀야 근거리 통과 순간이 보인다.
  // 띠는 **스테이션 위에 얹어야** 보인다. 정점색이라 스테이션 사이 z 구간을
  // 조건으로 잡으면 어느 정점도 안 걸려 띠가 통째로 사라진다(z=1.470 · 1.300
  // 두 링을 함께 칠해 그 사이 한 줄이 갈색이 된다).
  const BODY = [0.62, 0.62, 0.60], WARHEAD = [0.30, 0.19, 0.12];
  M.grid(g, (p) => (p[2] > 1.28 && p[2] < 1.50 ? WARHEAD : BODY), [0.0, 0.42], false, true);
  const last = g[g.length - 1];
  for (let k = 0; k < DIV; k++) {
    M.tri(last[k], [0, 0, -1.42], last[k + 1], [0, 0, -1], [0, 0, -1], [0, 0, -1],
          [0.06, 0.05, 0.05], [0.4, 0.6]);
  }
  /** 십자 배치 날개 4장(두께 있음). */
  const fins = (zRoot, zTip, zEnd, r0, r1, t, col) => {
    for (const s of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const px = -s[1] * t, py = s[0] * t;
      const quad = [
        [s[0] * r0, s[1] * r0, zRoot],
        [s[0] * r1, s[1] * r1, zTip],
        [s[0] * r1, s[1] * r1, zEnd],
        [s[0] * r0, s[1] * r0, zEnd],
      ];
      for (const sg of [1, -1]) {
        const nn = [s[1] * sg, -s[0] * sg, 0];
        const w = quad.map((p) => [p[0] + px * sg, p[1] + py * sg, p[2]]);
        M.tri(w[0], w[1], w[2], nn, nn, nn, col, [0.9, 0.2]);
        M.tri(w[0], w[2], w[3], nn, nn, nn, col, [0.9, 0.2]);
      }
    }
  };
  fins(-0.55, -1.28, -1.42, 0.0635, 0.175, 0.010, [0.42, 0.42, 0.44]);
  // 전방 카나드 4장 — 노즈 근처에 십자가 하나 더 생기면 근거리 실루엣이
  // 몽둥이가 아니라 미사일로 읽힌다.
  fins(1.15, 1.05, 0.75, 0.0635, 0.140, 0.008, [0.50, 0.50, 0.50]);
  return out(M);
}

/**
 * 콕핏 구조물 — 캐노피 보우 프레임 · 사이드 레일 · 계기 코밍 · 기수 끝단.
 * **기체 자세에 붙는다**(카메라가 아니라). 시선은 기체 자세와 독립이므로
 * 마우스로 시선을 돌리면 프레임이 화면에서 흘러가야 맞고, 그게 오히려
 * 자세를 읽는 시각적 단서가 된다.
 */
export function buildCockpit() {
  const M = new Mesh();
  const box = (cx, cy, cz, sx, sy, sz, col, mr) => {
    const p = (x, y, z) => [cx + x * sx, cy + y * sy, cz + z * sz];
    const F = [
      [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1], [0, 0, 1]],
      [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1], [0, 0, -1]],
      [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1], [1, 0, 0]],
      [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, 0, 0]],
      [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1], [0, 1, 0]],
      [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], [0, -1, 0]],
    ];
    for (const f of F) {
      const n = f[4];
      const a = p(...f[0]), b = p(...f[1]), c = p(...f[2]), d = p(...f[3]);
      M.tri(a, b, c, n, n, n, col, mr);
      M.tri(a, c, d, n, n, n, col, mr);
    }
  };
  const frame = [0.045, 0.048, 0.052];
  const FR = [0.0, 0.55];
  // 계기 코밍
  box(0, 0.42, 4.60, 0.62, 0.10, 0.34, [0.030, 0.032, 0.034], [0.0, 0.85]);
  // 캐노피 보우 프레임(앞)
  box(0, 1.02, 4.95, 0.56, 0.055, 0.06, frame, FR);
  box(0.52, 0.75, 4.95, 0.055, 0.30, 0.06, frame, FR);
  box(-0.52, 0.75, 4.95, 0.055, 0.30, 0.06, frame, FR);
  // 사이드 레일 2개
  box(0.56, 0.52, 3.20, 0.05, 0.05, 1.85, frame, FR);
  box(-0.56, 0.52, 3.20, 0.05, 0.05, 1.85, frame, FR);
  // 기수 끝단 — 화면에 기준물이 하나 생긴다
  box(0, 0.12, 7.60, 0.20, 0.10, 1.30, [0.055, 0.058, 0.062], [0.2, 0.5]);
  return out(M);
}
