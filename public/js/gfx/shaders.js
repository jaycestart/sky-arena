// SKY ARENA — GLSL 소스 모음.
//
// WebGL2 로 승격했지만 셰이더는 **전부 GLSL ES 1.00 한 벌**로 유지한다.
// `#version 300 es` 프로그램을 하나도 만들지 않는 이유: 두 벌이 되는 순간
// node 도 린트도 없고 컴파일 오류가 브라우저에서만 드러나는 이 환경에서
// 유지가 불가능해진다. WebGL2 는 버전 없는 셰이더를 그대로 컴파일하고,
// 인스턴싱은 WebGL1 에서도 ANGLE_instanced_arrays 로 된다.
// 기능 차이는 소스 앞에 #define 을 붙이는 방식으로만 분기한다.
//
// ── 조도 단위 ─────────────────────────────────────────────────────
// **태양 조도 선형 1.0 = 약 100,000 lux.**
// 블룸·바다 글리터·예광탄·애프터버너·폭발 밝기가 전부 이 기준 위에서
// 정해져야 서로 싸우지 않는다. 씬 셰이더는 톤매핑도 감마도 하지 않고
// 선형 방사휘도만 뱉는다 — 톤 커브는 후처리 한 곳에만 있다.
import { TERRAIN_OCT } from '../m3d.js';

/** GLSL 실수 리터럴로. 정수여도 소수점을 붙여야 한다(`380` 은 int 다). */
const f = (n) => {
  const s = String(n);
  return (s.indexOf('.') >= 0 || s.indexOf('e') >= 0 || s.indexOf('E') >= 0) ? s : s + '.0';
};

// ── 셰이더 앞머리 ──────────────────────────────────────────────────
/**
 * @param {object} o  { fs:bool, high:bool, deriv:bool, defines:string[] }
 * fs 프래그먼트면 정밀도 선언을 붙인다. high 면 highp 를 시도한다.
 */
export function prelude(o) {
  let s = '';
  // #extension 은 반드시 다른 토큰보다 앞에 와야 한다.
  // WebGL2 컨텍스트라도 **버전 없는(ES 1.00) 셰이더에서는 이 선언이 있어야
  // fwidth 가 보인다.** 실측: 빼면 'fwidth: no matching overloaded function'.
  // : enable 이라 미지원 드라이버에서는 경고만 나고 컴파일은 통과한다.
  if (o.deriv) s += '#extension GL_OES_standard_derivatives : enable\n#define HAS_DERIV 1\n';
  for (const d of (o.defines || [])) s += '#define ' + d + '\n';
  if (o.fs) {
    // 일부 모바일 GPU 에서 highp 는 성능이 절반이 된다 — 필요한 패스에만 준다.
    s += o.high
      ? '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n'
      : 'precision mediump float;\n';
  } else {
    // 정점 highp 는 ES 1.00 에서 항상 보장된다.
    s += 'precision highp float;\n';
  }
  return s;
}

// ── 공용 노이즈 ────────────────────────────────────────────────────
export const NOISE_GLSL = `
float hash21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), fr = fract(p);
  vec2 u = fr * fr * (3.0 - 2.0 * fr);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm2(vec2 p) { return vnoise(p) * 0.66 + vnoise(p * 2.03 + 11.7) * 0.34; }
float fbm3(vec2 p) {
  return vnoise(p) * 0.53 + vnoise(p * 2.03 + 11.7) * 0.29 + vnoise(p * 4.11 + 5.3) * 0.18;
}
// 값과 **기울기**를 함께 내는 값노이즈. x = 값, yz = 기울기(노이즈 좌표 기준).
// 값노이즈의 기울기는 해석적으로 나오므로 해시는 vnoise 와 똑같이 4번뿐이다 —
// 아래 nGrad(vnoise 3회 = 해시 12번)의 1/3 이다. 실측으로 그 차이가 그대로
// 프레임에 나왔다(전면 100% 기준 +0.83ms -> +0.29ms).
// 보간 가중치 u = f*f*(3-2f) 의 도함수 6f(1-f) 는 칸 경계에서 정확히 0 이라
// 기울기가 칸을 넘어도 이어진다 — 전방차분과 달리 방향 편향도 없다.
vec3 vnoised(vec2 p) {
  vec2 i = floor(p), fr = fract(p);
  vec2 u = fr * fr * (3.0 - 2.0 * fr);
  vec2 du = 6.0 * fr * (1.0 - fr);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  float k1 = b - a, k2 = c - a, k3 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k3 * u.x * u.y,
              du.x * (k1 + k3 * u.y),
              du.y * (k2 + k3 * u.x));
}
// 전방차분 기울기 — 4탭 중심차분보다 한 번 싸다. 노이즈 좌표계 기준이다.
vec2 nGrad(vec2 p) {
  const float e = 0.36;
  float a = vnoise(p);
  return vec2(vnoise(p + vec2(e, 0.0)) - a, vnoise(p + vec2(0.0, e)) - a) / e;
}
`;

// ── 지형 높이 함수 (m3d.TERRAIN_OCT 에서 생성) ─────────────────────
// 손으로 옮겨 적지 않는다. 어긋나면 서버와 다른 곳에 산이 서고
// '보이지 않는 산' 에서 지면 충돌이 일어난다.
export const TERRAIN_GLSL = (() => {
  let body = '';
  TERRAIN_OCT.forEach(([A, kx, kz, px, pz], i) => {
    const ax = `${f(kx)} * p.x + ${f(px)}`;
    const az = `${f(kz)} * p.y + ${f(pz)}`;
    body += `  s = sin(${ax}); c = cos(${ax}); s2 = sin(${az}); c2 = cos(${az});\n`;
    body += `  h += ${f(A)} * s * c2;\n`;
    body += `  hx += ${f(A * kx)} * c * c2;\n`;
    body += `  hz -= ${f(A * kz)} * s * s2;\n`;
  });
  return `
// 높이와 두 방향 기울기를 한 번에 낸다 — 사인/코사인을 두 번 돌지 않기 위해서.
// .x = 높이, .y = dh/dx, .z = dh/dz.  p 는 (x, z) 월드 좌표.
// |x| < 65000, 최고 k = 0.0071 이라 인자 최대 461 rad, fp32 상대오차 6e-8 →
// 위상오차 2.8e-5 rad → 높이오차 0.6mm 미만. 정밀도 문제 없다.
vec3 terrainHD(vec2 p) {
  float h = 0.0, hx = 0.0, hz = 0.0;
  float s, c, s2, c2;
${body}  return vec3(h, hx, hz);
}
float terrainH(vec2 p) { return terrainHD(p).x; }
// 법선은 유한차분이 아니라 도함수 닫힌형이다 — 정확해서 능선이 살아난다.
vec3 terrainN(vec3 hd) { return normalize(vec3(-hd.y, 1.0, -hd.z)); }
`;
})();

// ── 대기 산란 (해석해 하나) ────────────────────────────────────────
// 레이마치 적분은 쓰지 않는다. 하늘·지형 안개·물 반사·금속 반사가 전부
// 이 함수를 공유한다. 픽셀당 2~3회 불러도 견딘다.
export const ATMO_GLSL = `
uniform vec3 uSun;        // 태양 방향(단위벡터)
uniform vec3 uSunColor;   // 대기를 통과한 태양 조도(CPU 에서 매 프레임 1회)
uniform vec3 uCamPos;
uniform vec3 uAmbSky;     // 2밴드 앰비언트 — 위
uniform vec3 uAmbGnd;     // 2밴드 앰비언트 — 아래(지면 바운스 포함)
uniform float uMieG;      // 기상에 따른 미 비대칭
uniform float uMieAmt;    // 기상에 따른 미 산란량
uniform float uTime;      // 스냅샷 tick 기준 시간(초) — 모든 클라가 같은 값
uniform vec2 uWind;
uniform float uCloudAmt;  // 구름량 0..1
uniform float uCloudIn;   // 카메라가 구름층 안에 든 정도 0..1

const vec3 BETA_R = vec3(5.802e-6, 13.558e-6, 33.100e-6);
const vec3 BETA_M = vec3(21.0e-6, 21.0e-6, 21.0e-6);
const vec3 BETA_O3 = vec3(0.650e-6, 1.881e-6, 0.085e-6);
const float H_R = 8000.0;
const float H_M = 1200.0;
const float O3_COL = 15000.0;   // 오존 등가 두께. 상수 하나로 천정 파랑이 정확해진다.
const float PI = 3.14159265;

// Kasten-Young 에어매스. 목적은 하나 — 지평선에서 발산하지 않게 하는 것.
float amKY(float cz) {
  float c = clamp(cz, 0.0, 1.0);
  float z = degrees(acos(c));                    // 0..90
  return 1.0 / (c + 0.50572 * pow(96.07995 - z, -1.6364));
}

vec3 atmoTau(float h0, float cz) {
  float am = amKY(cz);
  float fR = exp(-max(h0, 0.0) / H_R);
  float fM = exp(-max(h0, 0.0) / H_M);
  return (BETA_R * H_R * fR + BETA_M * 1.1 * H_M * fM + BETA_O3 * O3_COL) * am;
}

/** 태양이 대기를 통과하고 남은 색. 일출/일몰에 자동으로 붉어지고 약해진다. */
vec3 sunTransmit(vec3 sun) { return exp(-atmoTau(0.0, sun.y)); }

float phaseR(float mu) { return 0.0596831 * (1.0 + mu * mu); }
float phaseHG(float mu, float g) {
  float d = 1.0 + g * g - 2.0 * g * mu;
  return (1.0 - g * g) / (12.5663706 * d * max(sqrt(max(d, 1e-4)), 1e-3));
}

/** 시선 방향의 하늘 방사휘도. 구름은 포함하지 않는다(하늘 패스에서 따로 얹는다). */
vec3 skyRadiance(vec3 dir, vec3 sun, float camY) {
  float mu = clamp(dot(dir, sun), -1.0, 1.0);
  float h0 = max(camY, 0.0);
  float am = amKY(dir.y);
  float fR = exp(-h0 / H_R);
  float fM = exp(-h0 / H_M);
  vec3 tR = BETA_R * H_R * fR * am;
  vec3 tM = BETA_M * H_M * fM * am;
  vec3 tau = tR + tM * 1.1 + BETA_O3 * O3_COL * am;
  vec3 T = exp(-tau);
  vec3 S = tR * phaseR(mu) + tM * phaseHG(mu, uMieG) * uMieAmt;
  vec3 sunT = sunTransmit(sun);
  vec3 sc = S / max(tau, vec3(1e-7)) * (1.0 - T) * sunT;
  // 다중산란 근사. 없으면 태양 반대편과 지평선 아래가 새까맣게 죽는다.
  vec3 ms = (1.0 - T) * vec3(0.0055, 0.0080, 0.0125) * clamp(sun.y + 0.12, 0.0, 1.0);
  return sc + ms;
}

/** 소산 + 내산란. camPos.y 가 들어가므로 고고도에서 저절로 안개가 걷힌다. */
vec3 aerial(vec3 color, vec3 camPos, vec3 dir, float dist, vec3 sun) {
  float h0 = max(camPos.y, 0.0);
  float dy = dir.y;
  float e0R = exp(-h0 / H_R), e0M = exp(-h0 / H_M);
  float sR, sM;
  if (abs(dy) < 0.02) {           // 거의 수평 — 밀도가 일정하다고 봐도 된다
    sR = dist * e0R; sM = dist * e0M;
  } else {                        // 지수 밀도의 경사 적분은 닫힌 형태로 나온다
    float h1 = max(h0 + dist * dy, 0.0);
    sR = (H_R / dy) * (e0R - exp(-h1 / H_R));
    sM = (H_M / dy) * (e0M - exp(-h1 / H_M));
  }
  // 미 산란은 '뿌연 흰 베일' 그 자체다. 물리값 그대로(1.1배) 쓰면 수 km 앞
  // 지형이 통째로 우윳빛이 되어 색과 대비가 다 날아간다 — 실제로 그렇게
  // 보이는 게 맞지만 게임 화면으로는 못 쓴다. 레일리(파랑)는 그대로 두어
  // 거리감과 푸른 기운은 살리고, 흰 베일만 3분의 1로 줄인다.
  vec3 tau = BETA_R * max(sR, 0.0) + BETA_M * 0.38 * max(sM, 0.0);
  vec3 T = exp(-tau);
  // 채널별이라 파랑이 먼저 차오르고, 안개색이 시선 방향의 함수가 된다 —
  // 태양 쪽은 밝고 따뜻하게, 반대쪽은 어둡고 푸르게 자동으로 갈린다.
  return color * T + skyRadiance(dir, sun, camPos.y) * (1.0 - T);
}

/** 태양 원반. 각반경 0.00465 rad + 주연감광. 밝기는 톤매핑 전 선형값이다. */
float sunDisk(float cosA) {
  float ang = acos(clamp(cosA, -1.0, 1.0));
  float r = ang / 0.00465;
  if (r >= 1.0) return 0.0;
  return pow(sqrt(max(1.0 - r * r, 0.0)), 0.6);
}
`;

// ── 출력 변환 ──────────────────────────────────────────────────────
// 부동소수 렌더 타깃이 없는 기기에서는 후처리를 통째로 끄고 기본 프레임버퍼에
// 직접 그린다. 그래도 톤 커브는 한 벌이어야 하므로 같은 식을 여기에 둔다.
// (HDR 경로에서는 sceneOut() 이 항등함수다 — 커브는 post.js 한 곳뿐)
export const TONE_GLSL = `
uniform float uOutExp;
vec3 acesFit(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 srgbEnc(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
vec3 sceneOut(vec3 c) {
#ifdef DIRECT_OUT
  return srgbEnc(acesFit(c * uOutExp));
#else
  return c;
#endif
}
`;

// ── 구름 ───────────────────────────────────────────────────────────
// 하늘 패스 안에서 처리한다. 별도 드로우 없음 — 하늘이 보이는 픽셀에서만
// 도니 지형이 화면을 덮을수록 저절로 싸진다. 볼류메트릭 레이마칭은 하지 않는다.
export const CLOUD_GLSL = `
const float CLOUD_LO = 2200.0;
const float CLOUD_HI = 3000.0;
const float CIRRUS_Y = 8000.0;

/** 구름 밀도장. 지면 그림자도 반드시 이 함수를 써야 하늘과 위치가 맞는다. */
float cloudMap(vec2 p) {
  vec2 q = p * 0.00034 + uWind * uTime * 0.000021;
  return fbm3(q) + 0.22 * fbm2(q * 3.7 + 4.1);
}
float cloudCover(vec2 p) {
  float th = mix(0.72, 0.40, uCloudAmt);
  return smoothstep(th, th + 0.17, cloudMap(p));
}
/** 지면에 흘러가는 구름 그림자. 텍스처가 필요 없다 — 절차 함수를 공유한다. */
float cloudShadow(vec3 wp, vec3 sun) {
  float t = (CLOUD_LO - wp.y) / max(sun.y, 0.18);
  if (t <= 0.0) return 1.0;
  return 1.0 - 0.72 * cloudCover(wp.xz + sun.xz * t) * uCloudAmt;
}

/** 두 평면 교차 + 시차로 슬랩을 흉내낸다. 샘플 6회. */
vec4 cloudDeck(vec3 ro, vec3 rd, vec3 sun) {
  vec3 col = vec3(0.0);
  float a = 0.0;
  if (abs(rd.y) > 0.006 && uCloudAmt > 0.01) {
    float t0 = (CLOUD_LO - ro.y) / rd.y;
    float t1 = (CLOUD_HI - ro.y) / rd.y;
    if (max(t0, t1) > 0.0 && min(max(t0, 0.0), max(t1, 0.0)) < 260000.0) {
      vec2 p0 = ro.xz + rd.xz * max(t0, 0.0);
      vec2 p1 = ro.xz + rd.xz * max(t1, 0.0);
      float d0 = cloudCover(p0);
      float d1 = cloudCover(p1);
      float dens = max(d0, d1) * (0.5 + 0.5 * min(d0, d1));
      float slab = clamp(0.34 / max(abs(rd.y), 0.055), 1.0, 3.4);
      a = clamp(1.0 - exp(-dens * slab * 2.6), 0.0, 1.0);
      // 위쪽 샘플이 두꺼우면 아래가 어둡다 — 간이 자기그림자
      float lit = clamp(0.34 + 0.9 * (1.0 - d1 * 0.85), 0.0, 1.3);
      float mu = dot(rd, sun);
      // 태양 쪽 은빛 테두리(silver lining). 사실감 대비 비용이 가장 좋은 한 줄.
      float hg = phaseHG(mu, 0.62);
      col = sunTransmit(sun) * (0.085 + 0.62 * hg) * lit
          + skyRadiance(rd, sun, ro.y) * 0.55;
    }
  }
  // 상층 권운 — 단순 평면 + 2옥타브
  if (rd.y > 0.02 && ro.y < CIRRUS_Y) {
    float tc = (CIRRUS_Y - ro.y) / rd.y;
    if (tc > 0.0 && tc < 400000.0) {
      vec2 pc = ro.xz + rd.xz * tc;
      float ci = fbm2(pc * 0.000075 + uWind * uTime * 0.0000085);
      ci = smoothstep(0.56, 0.80, ci) * (0.30 + 0.35 * uCloudAmt);
      vec3 cc = sunTransmit(sun) * (0.07 + 0.35 * phaseHG(dot(rd, sun), 0.55));
      col = mix(cc, col, a);
      a = a + (1.0 - a) * ci;
    }
  }
  return vec4(col, a);
}
`;

// ── PBR ────────────────────────────────────────────────────────────
export const PBR_GLSL = `
float ggxD(float nh, float a) {
  float a2 = a * a;
  float d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-7);
}
// Smith height-correlated visibility (= G / (4 nl nv))
float smithV(float nv, float nl, float a) {
  float a2 = a * a;
  float gv = nl * sqrt(nv * nv * (1.0 - a2) + a2);
  float gl = nv * sqrt(nl * nl * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}
vec3 fSchlick(vec3 f0, float u) {
  float m = clamp(1.0 - u, 0.0, 1.0);
  float m2 = m * m;
  return f0 + (1.0 - f0) * (m2 * m2 * m);
}
/** 태양 각반경을 반영해 하이라이트를 넓힌다 — 점광원으로 두면 GGX 하이라이트가
 *  픽셀보다 작아져 기체가 움직일 때 깜빡인다(파이어플라이). */
float sunAlpha(float rough) { return clamp(rough * rough + 0.00465 * 0.5, 0.0016, 1.0); }

vec3 shadePBR(vec3 N, vec3 V, vec3 albedo, float metal, float rough,
              float shadow, float ao) {
  float a = sunAlpha(rough);
  vec3 L = uSun;
  vec3 H = normalize(L + V);
  float nl = max(dot(N, L), 0.0);
  float nv = max(dot(N, V), 1e-4);
  float nh = max(dot(N, H), 0.0);
  float vh = max(dot(V, H), 0.0);
  vec3 f0 = mix(vec3(0.04), albedo, metal);
  vec3 F = fSchlick(f0, vh);
  vec3 spec = vec3(ggxD(nh, a) * smithV(nv, nl, a)) * F;
  vec3 kd = (1.0 - F) * (1.0 - metal);
  vec3 direct = (kd * albedo / PI + spec) * uSunColor * nl * shadow;
  // 앰비언트는 2밴드를 노멀 y 로 보간. AO 는 여기에만 곱한다 —
  // 직사광에 곱하면 그림자를 두 번 세는 셈이 된다.
  // clamp 는 값 범위 때문이 아니라 **NaN 방어**다. 정점 법선이 (0,0,0) 이면
  // normalize 가 NaN 을 내고, mix 의 t 가 NaN 이면 그 삼각형 전체가 순흑으로
  // 그려진다(실제로 났던 버그 — 무장 노즈콘). 데이터 쪽은 jet.js grid() 에서
  // 고쳤지만 린트가 없는 환경이라 셰이더에도 공짜 안전판을 하나 둔다.
  vec3 amb = mix(uAmbGnd, uAmbSky, clamp(N.y * 0.5 + 0.5, 0.0, 1.0)) * ao;
  // 환경 반사: 큐브맵도 프로브도 없다. 하늘 함수를 반사 방향으로 한 번 더.
  //
  // **거울 방향으로 그냥 쏘면 안 된다.** 거친 면의 반사 로브는 넓게 퍼져 있어
  // 하늘을 넓게 평균한 값을 받아야 하는데, 거울 표본은 좁은 한 점을 집는다.
  // 그래서 무광 도장(거칠기 0.62)이 하늘에서 가장 밝은 자리 — 특히 미 산란이
  // 태양 둘레에 만드는 후광 — 을 그대로 집어 표면이 통째로 밝게 떠 버렸다.
  // 이 항 하나가 기체가 받는 빛의 35% 다(헤드리스 실측). 알베도와 무관한
  // 항이라, 도장·패널라인·기류 때·그을음이 아무리 알베도를 흔들어도 그 대비가
  // 화면에서 절반 이하로 희석된다 — '네 번 고쳤는데 똑같다'의 정체다.
  //
  // 로브 중심 방향은 거칠기가 오를수록 N 쪽으로 온다(거칠기 1 이면 로브가
  // 반구 전체라 코사인 가중 평균 방향이 곧 N 이다). **표본을 하나 더 쓰지 않고
  // 방향만 굽힌다** — skyRadiance 는 exp/pow/acos 덩어리라 두 번 부를 여유가 없다.
  //
  // 길이로 나눌 때 normalize 를 안 쓰는 이유: 기체는 컬링을 끄고 그려서
  // 뒷면(N·V<0)이 실제로 래스터된다. 그 면에서 R 은 N 의 반대쪽을 향하고,
  // 거칠기가 정확히 0.707 이면 mix 결과가 영벡터가 되어 normalize 가 NaN 을
  // 낸다. NaN 은 이 파일에서 이미 삼각형을 통째로 순흑으로 만든 적이 있다.
  // 1e-3 은 mediump 최소 정규수(약 6.1e-5)보다 충분히 크다.
  vec3 Rw = mix(reflect(-V, N), N, rough * rough);
  vec3 R = Rw / max(length(Rw), 1e-3);
  vec3 env = skyRadiance(R, uSun, uCamPos.y);
  // **반사 방향이 아래를 향하면 하늘이 아니라 지면이 보여야 한다.** 예전에는
  // skyRadiance 하나뿐이라 저공에서 기체 하면·동체 측면·익하 무장이 어두운
  // 지형 위에서도 하늘색으로 빛났다. 지평선에서 갈라 준다(거친 면일수록
  // 반사가 넓게 퍼지므로 갈라짐을 약하게).
  float down = smoothstep(0.02, -0.10, R.y);
  env = mix(env, uAmbGnd * 1.6 + uSunColor * 0.035, down * (1.0 - rough * 0.35));
  vec3 Fe = fSchlick(f0, nv) * (1.0 - rough * 0.7);
  return direct + kd * albedo * amb + env * Fe * ao;
}
`;

// ── 하늘 ───────────────────────────────────────────────────────────
export const VS_SKY = `
attribute vec2 aXY;
uniform mat4 uInvVP;
varying vec3 vDir;
void main() {
  vec4 p = uInvVP * vec4(aXY, 1.0, 1.0);
  vDir = p.xyz;
  gl_Position = vec4(aXY, 0.999999, 1.0);
}`;

export const FS_SKY = ATMO_GLSL + TONE_GLSL + NOISE_GLSL + CLOUD_GLSL + `
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec3 c = skyRadiance(d, uSun, uCamPos.y);
  vec4 cl = cloudDeck(uCamPos, d, uSun);
  // 태양 원반은 구름 뒤에 있다
  float disk = sunDisk(dot(d, uSun));
  c += sunTransmit(uSun) * disk * 12000.0;
  c = mix(c, cl.rgb, cl.a);
  // 구름층 안에 들어가면 뿌옇게. 지형 조명도 CPU 에서 같이 낮춘다
  // (안 낮추면 지형만 밝은 채로 남아 어긋난다).
  vec3 fogDir = normalize(vec3(d.x, abs(d.y) * 0.35 + 0.12, d.z));
  c = mix(c, skyRadiance(fogDir, uSun, uCamPos.y) * 3.2, uCloudIn * 0.85);
  gl_FragColor = vec4(sceneOut(c), 1.0);
}`;

// ── 지형 클립맵 ────────────────────────────────────────────────────
export const VS_TERRAIN = TERRAIN_GLSL + `
attribute vec2 aGrid;      // 0..64 로컬 격자
attribute float aStitch;   // 0=없음, 1=x축 홀수 정점, 2=z축 홀수 정점
uniform mat4 uProj, uView;
uniform vec2 uOrigin;
uniform float uCell;
uniform float uStitchOn;
varying vec3 vW;
void main() {
  vec2 p = uOrigin + aGrid * uCell;
  float h;
  if (uStitchOn > 0.5 && aStitch > 0.5) {
    // 링 경계 봉합. 안쪽 링 최외곽의 '홀수' 정점은 바깥 링 변 위에 놓이지
    // 않아 균열이 생긴다. 높이가 해석 함수이므로 이웃 두 짝수 정점에서
    // 두 번 더 평가해 평균내면 바깥 변과 **정확히** 일치한다.
    // 모프 가중치도 팝핑 튜닝도 필요 없다.
    vec2 e = (aStitch < 1.5) ? vec2(uCell, 0.0) : vec2(0.0, uCell);
    h = 0.5 * (terrainH(p - e) + terrainH(p + e));
  } else {
    h = terrainH(p);
  }
  vW = vec3(p.x, h, p.y);
  gl_Position = uProj * uView * vec4(vW, 1.0);
}`;

export const FS_TERRAIN = ATMO_GLSL + TONE_GLSL + NOISE_GLSL + TERRAIN_GLSL
  + PBR_GLSL + CLOUD_GLSL + `
varying vec3 vW;
uniform sampler2D uBake;    // R = 태양 그림자, G = 하늘 차폐(AO)
uniform float uBakeHalf;
uniform float uDetail;      // 디테일 노멀 옥타브 수 0..3

// 재질 경계 폭. 거리와 무관하게 일정한 화면 폭을 유지하는 게 목적이다 —
// 안 그러면 원거리에서 경계가 1픽셀 미만이 되어 지글거린다.
//
// **WebGL2 컨텍스트에서 버전 없는(ESSL1) 셰이더는 fwidth 를 쓸 수 없다.**
// 실측: OES_standard_derivatives 확장 이름 자체가 지원되지 않는다고 나오고
// fwidth 는 미정의다. WebGL1 + 확장에서만 도함수 경로가 산다. 그래서 기본은
// 거리 기반 폭이고, 도함수가 있으면 그쪽이 더 정확하니 쓴다.
float gBandW = 1.0;      // main 에서 카메라 거리로 채운다
float band(float x, float edge, float w0) {
#ifdef HAS_DERIV
  float w = max(fwidth(x) * 1.2, w0 * 0.15);
#else
  float w = w0 * gBandW;
#endif
  return smoothstep(edge - w, edge + w, x);
}

void main() {
  vec3 hd = terrainHD(vW.xz);
  vec3 N0 = terrainN(hd);
  vec3 toEye = uCamPos - vW;
  float dist = length(toEye);
  vec3 V = toEye / max(dist, 1e-3);
  vec2 P = vW.xz;
  gBandW = clamp(0.35 + dist * 0.0015, 0.35, 8.0);

  // ── 디테일 노멀 ────────────────────────────────────────────────
  // 밉맵이 없다. 거리 페이드를 빠뜨리면 원거리에서 심하게 지글거린다 —
  // 정지 스크린샷은 멀쩡한데 움직여야만 보이는 유형의 버그다.
  // 페이드 거리는 '2픽셀 미만이 되는 거리'의 70% 로 잡는다. 예전 값은
  // 그 한계보다 2.3~2.6배 일찍 껐다 — 고도 3200m 순항에서는 지면까지가
  // 3200m 라 8m·2m 옥타브가 통째로 꺼져 땅이 밋밋해지고, 흘러가는 것이
  // 없으니 속도감이 사라졌다. (한계: 30m→10.6km, 8m→2.8km, 2m→0.70km)
  vec2 g = vec2(0.0);
  float f30 = 1.0 - smoothstep(5200.0, 7400.0, dist);
  float f8 = 1.0 - smoothstep(1400.0, 1970.0, dist);
  float f2 = 1.0 - smoothstep(350.0, 490.0, dist);
  if (uDetail > 0.5) g += nGrad(P * 0.0333) * (0.70 * f30);
  if (uDetail > 1.5) g += nGrad(P * 0.125) * (0.34 * f8);
  if (uDetail > 2.5) g += nGrad(P * 0.5) * (0.16 * f2);

  float fA = 1.0 - smoothstep(19000.0, 27000.0, dist);

  float slope = degrees(acos(clamp(N0.y, 0.0, 1.0)));
  float macro = fbm2(P * 0.0013);
  float y = vW.y;
  float depth = -y;

  // ── 스플랫 ─────────────────────────────────────────────────────
  vec3 wetSand = vec3(0.115, 0.100, 0.078);
  vec3 drySand = vec3(0.500, 0.440, 0.320);
  vec3 grass = mix(vec3(0.075, 0.115, 0.042), vec3(0.150, 0.155, 0.070),
                   smoothstep(0.35, 0.72, macro));
  vec3 screeC = vec3(0.215, 0.198, 0.176);
  vec3 rockC = mix(vec3(0.155, 0.142, 0.130), vec3(0.230, 0.212, 0.192),
                   fbm2(P * 0.021 + 3.0));
  vec3 snowC = vec3(0.88, 0.90, 0.94);
  vec3 seabed = vec3(0.085, 0.082, 0.070);

  float rough = 0.85;
  vec3 alb = drySand;
  float nAmp = 0.55;

  // 해안: 수심 0~3m 젖은 모래(어둡고 반사 강함) → 3~25m 마른 모래
  float wet = 1.0 - smoothstep(0.0, 3.0, y);
  alb = mix(drySand, wetSand, clamp(wet, 0.0, 1.0));
  rough = mix(0.85, 0.15, clamp(wet, 0.0, 1.0));
  // 해저
  float sea = 1.0 - smoothstep(-26.0, -2.0, y);
  alb = mix(alb, seabed, sea);
  rough = mix(rough, 0.60, sea);

  // 초지
  float tg = smoothstep(25.0, 60.0, y) * (1.0 - band(slope, 25.0, 4.0));
  alb = mix(alb, grass, tg);
  rough = mix(rough, 0.86, tg);
  nAmp = mix(nAmp, 0.75, tg);

  // 너덜(스크리) 25~38도 — 없으면 초지에서 바위로 점프해 절벽이 갑자기 나타난다
  float tS = band(slope, 25.0, 4.0) * (1.0 - band(slope, 38.0, 4.0));
  alb = mix(alb, screeC, tS);
  rough = mix(rough, 0.80, tS);
  nAmp = mix(nAmp, 1.25, tS);

  // 바위 — 수평 층리 줄무늬를 넣으면 절벽이 절벽으로 보인다
  float tR = band(slope, 38.0, 4.0);
  float strata = sin(y * 0.42 + fbm2(P * 0.006) * 5.0) * 0.5 + 0.5;
  alb = mix(alb, rockC * (0.82 + 0.30 * strata), tR);
  rough = mix(rough, 0.75, tR);
  nAmp = mix(nAmp, 1.6, tR);
  g += vec2(0.0, cos(y * 0.42) * 0.35) * tR * f8;

  // 설선: 저주파 노이즈로 ±80m 흔들고, 북사면에서 60m 낮추고,
  // 급경사에는 눈이 지수적으로 감소한다(효과가 가장 크다).
  float snowY = 372.0 + (macro - 0.5) * 160.0 - 60.0 * clamp(N0.z, 0.0, 1.0);
  float tSn = smoothstep(snowY, snowY + 55.0, y) * exp(-max(slope - 42.0, 0.0) * 0.13);
  // 완전 무광이면 눈으로 보이지 않는다
  alb = mix(alb, snowC, tSn);
  rough = mix(rough, 0.55, tSn);
  nAmp = mix(nAmp, 0.35, tSn);

  vec3 N = normalize(N0 + vec3(-g.x, 0.0, -g.y) * nAmp);

  // ── 속도감용 알베도 얼룩 ────────────────────────────────────────
  // 노멀 섭동은 스치는 빛에서만 보인다. 순항 고도에서 지면이 흘러가는 것을
  // 눈으로 잡으려면 **밝기 자체가 변해야** 한다. 파장 80m 는 28km 까지,
  // macro(770m)는 사실상 끝까지 지글거리지 않는다 — 지면이 보이는 전 구간에서
  // 살아 있다. 이게 광류를 만들어 속도가 체감되는 실제 원인이다.
  // macro 는 위에서 이미 구한 값을 재활용한다 — fbm2 호출은 한 번만 는다.
  // 스플랫이 끝난 뒤에 얹어야 재질 구분을 흐리지 않는다. 눈 위에서는
  // 절반만 — 설원은 원래 균질해서 얼룩이 지면 어색하다.
  float mottle = (fbm2(P * 0.0125) - 0.5) * 0.30 * fA + (macro - 0.5) * 0.24;
  alb *= 1.0 + mottle * (1.0 - tSn * 0.5);

  // ── 베이크 그림자 · AO · 구름 그림자 ───────────────────────────
  vec2 buv = P / (2.0 * uBakeHalf) + 0.5;
  vec4 bk = texture2D(uBake, clamp(buv, 0.001, 0.999));
  float sh = bk.r * cloudShadow(vW, uSun);
  float ao = bk.g;
  // 그림자 안쪽 눈에는 약한 청색 산란 틴트
  alb = mix(alb, alb * vec3(0.85, 0.92, 1.10), tSn * (1.0 - sh) * 0.8);

  vec3 c = shadePBR(N, V, alb, 0.0, rough, sh, ao);
  c = aerial(c, uCamPos, -V, dist, uSun);
  gl_FragColor = vec4(sceneOut(c), 1.0);
}`;

// ── 바다 ───────────────────────────────────────────────────────────
export const VS_WATER = `
attribute vec2 aGrid;
attribute float aStitch;
uniform mat4 uProj, uView;
uniform vec2 uOrigin;
uniform float uCell;
varying vec3 vW;
void main() {
  vec2 p = uOrigin + aGrid * uCell;
  vW = vec3(p.x, 0.0, p.y);       // 정확히 y=0. Gerstner 정점 변위는 넣지 않는다.
  gl_Position = uProj * uView * vec4(vW, 1.0);
}`;

export const FS_WATER = ATMO_GLSL + TONE_GLSL + NOISE_GLSL + TERRAIN_GLSL
  + PBR_GLSL + CLOUD_GLSL + `
varying vec3 vW;
uniform float uWaveHi;    // 고주파 옥타브 사용 여부(품질)

vec3 waterNormal(vec2 P, float dist) {
  // 거리에 따른 고주파 페이드아웃은 선택이 아니다 — 밉맵이 없어
  // 빠뜨리면 원거리 바다가 심하게 지글거린다.
  float f1 = 1.0 - smoothstep(3000.0, 6500.0, dist);
  float f2 = 1.0 - smoothstep(700.0, 1700.0, dist);
  float f3 = (1.0 - smoothstep(160.0, 420.0, dist)) * uWaveHi;
  float t = uTime;
  vec2 g = vec2(0.0);
  g += nGrad(P * 0.0090 + vec2(0.075, 0.041) * t) * (0.60 * f1);
  g += nGrad(P * 0.0270 + vec2(-0.050, 0.098) * t) * (0.30 * f2);
  g += nGrad(P * 0.0810 + vec2(0.130, -0.062) * t) * (0.14 * f3);
  g += nGrad(P * 0.2100 + vec2(-0.180, -0.120) * t) * (0.06 * f3);
  return normalize(vec3(-g.x * 0.55, 1.0, -g.y * 0.55));
}

void main() {
  vec2 P = vW.xz;
  // 수심은 해석 함수라 공짜다 — 마스크 텍스처가 필요 없고
  // 해안선(depth=0 등고선)이 픽셀 단위로 정확해진다.
  float depth = -terrainH(P);
  if (depth <= 0.0) discard;

  vec3 toEye = uCamPos - vW;
  float dist = length(toEye);
  vec3 V = toEye / max(dist, 1e-3);
  vec3 N = waterNormal(P, dist);

  // 프레넬 — 스칠수록 하늘을 거의 거울처럼 반사한다.
  // 고고도에서 바다가 은빛으로 빛나는 이유가 이것이다.
  float ndv = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  vec3 R = reflect(-V, N);
  R.y = max(R.y, 0.012);          // 아래를 향한 반사에는 하늘이 없다
  vec3 refl = skyRadiance(normalize(R), uSun, max(uCamPos.y, 0.0));
  vec4 cl = cloudDeck(vW, normalize(R), uSun);
  refl = mix(refl, cl.rgb, cl.a * 0.85);

  // 수심 흡수. 실측 계수(0.45,0.09,0.05)/m 를 그대로 쓰면 10m 안에서 전환이
  // 끝나 아레나 전체가 남색 한 색이 된다 — 전환 구간만 넓힌 채널비다.
  vec3 absorb = exp(-min(depth, 900.0) * vec3(0.055, 0.0115, 0.0065));
  float sh = cloudShadow(vW, uSun);
  vec3 body = vec3(0.055, 0.115, 0.105) * absorb
            * (uAmbSky * 2.2 + uSunColor * 0.28 * sh);

  // 태양 글리터 — 거리·시야각에 따라 넓힌 GGX. 태양 아래로 반짝이는 길이 생긴다.
  float rg = clamp(0.06 + dist * 0.000035, 0.06, 0.25);
  float a = sunAlpha(rg);
  vec3 H = normalize(uSun + V);
  float nh = max(dot(N, H), 0.0), nl = max(dot(N, uSun), 0.0);
  float glt = ggxD(nh, a) * smithV(max(ndv, 1e-4), nl, a) * nl;
  vec3 glit = uSunColor * glt * F * sh * 2.4;

  // 서프 — 얕고 경사가 급한 곳에 폼 밴드
  vec3 shd = terrainHD(P);
  float gradM = length(vec2(shd.y, shd.z));
  float foamN = fbm2(P * 0.06 + vec2(uTime * 0.35, -uTime * 0.22));
  float foam = (1.0 - smoothstep(0.0, 2.6, depth))
             * smoothstep(0.02, 0.16, gradM)
             * smoothstep(0.35, 0.72, foamN);
  vec3 c = mix(body, refl, F) + glit;
  c = mix(c, (uSunColor * sh * 0.55 + uAmbSky * 2.0) * 0.75, clamp(foam, 0.0, 0.9));
  c = aerial(c, uCamPos, -V, dist, uSun);
  gl_FragColor = vec4(sceneOut(c), 1.0);
}`;

// ── 기체 · 미사일 · 콕핏 (픽셀 단위 PBR) ───────────────────────────
export const VS_PBR = `
attribute vec3 aPos;
attribute vec3 aNorm;
attribute vec3 aColor;
attribute vec2 aMR;          // metallic, roughness
// 조종면 구동. 정수부 = 면 ID(1 좌에일러론 · 2 우에일러론 · 3 스태빌레이터 ·
// 4 러더), 소수부 = 힌지 블렌드 가중치. jet.js Mesh.flex 가 굽는다.
// **격자를 쪼개지 않고 휘게 하는 방식이라 삼각형이 한 개도 안 는다.**
attribute float aFlex;
#ifdef SKIN
attribute vec2 aSkin;        // x = 정점 AO, y = 부품 코드(jet.js JET_PARTS)
varying vec2 vSkin;
#endif
uniform mat4 uProj, uView, uModel;
// 편각(라디안) — 좌에일러론 · 우에일러론 · 스태빌레이터 · 러더.
// 물리와 완전히 무관한 순수 시각이다(world.js 비행 모델은 rate 기반이라
// '편각' 이라는 개념 자체가 없다). 서버·프로토콜·예측 전부 무변경.
uniform vec4 uDefl;
varying vec3 vN, vW, vAlb;
varying vec2 vMR;
varying vec3 vObj;
// 기체 좌표계 법선. 카운터셰이딩(위 어둡고 아래 밝은 도장)을 **면이 향한
// 쪽**으로 가르는 데 쓴다. 예전에는 vObj.y(위치)로 갈랐는데, 주익처럼
// 납작한 면은 위아래가 같은 높이라 두 면 모두 위색과 아래색의 중간인 밝은
// 회색이 됐다. 실측: 의도한 윗면 밝기 0.201 인데 주익 0.350, 동체 0.320.
// 기체가 통째로 하얗게 보이던 원인이다(수직미익만 높이 있어 제대로 어두웠다).
// 월드 법선을 쓰면 안 된다 — 기체가 구를 때마다 도장이 다시 칠해진다.
varying vec3 vNObj;
// 마이크로 범프의 접선(월드). FS 가 오브젝트 공간에서 잰 높이 기울기를 월드
// 법선에 얹으려면 **오브젝트 접선의 월드 상(像)** 이 필요한데, uModel 이
// FS 에 없어서 여기서 넘긴다. 종법선은 FS 가 cross(N, vT) 로 만든다 —
// 회전은 외적을 보존하므로 varying 하나면 접평면 두 축이 다 선다.
// 이것으로 varying 은 vec3 6 + vec2 2 = 22 float(7행)이고 ES 1.00 보장치
// 8행 안이다. **하나만 더 늘려도 8행이 차므로 다음 사람은 여기서 멈춰라.**
varying vec3 vT;
void main() {
  vec3 P = aPos, Nrm = aNorm;
  float fid = floor(aFlex);
  if (fid > 0.5) {
    float w = aFlex - fid;
    float ang = 0.0;
    vec3 org = vec3(0.0);
    bool yAxis = false;
    if (fid < 2.5) {
      // 주익 — 힌지선은 각 스팬 위치의 시위 75% 다. jet.js wing() 의 로프트를
      // 여기서 다시 만든다(FS_PBR 패널라인이 쓰는 것과 **같은 식**이다).
      ang = (fid < 1.5 ? uDefl.x : uDefl.y) * w;
      float u = clamp((abs(aPos.x) - 1.02) / 5.03, 0.0, 1.0);
      org = vec3(0.0, mix(0.02, 0.04, u),
                 mix(2.40, -1.70, u) - 0.75 * mix(5.30, 1.55, u));
    } else if (fid < 3.5) {
      // 전동 스태빌레이터 — 시위 40% 를 피벗으로 면 전체가 강체 회전한다.
      ang = uDefl.z * w;
      float u = clamp((abs(aPos.x) - 0.85) / 2.45, 0.0, 1.0);
      org = vec3(0.0, mix(-0.05, 0.02, u),
                 mix(-4.30, -5.20, u) - 0.40 * mix(2.30, 0.85, u));
    } else {
      // 방향타 — 스팬 방향이 y 라 힌지축도 Y 다.
      ang = uDefl.w * w;
      float u = clamp((aPos.y - 0.55) / 2.75, 0.0, 1.0);
      org = vec3(sign(aPos.x) * mix(0.80, 0.90, u), 0.0,
                 mix(-3.20, -5.10, u) - 0.667 * mix(3.10, 1.15, u));
      yAxis = true;
    }
    float c = cos(ang), s = sin(ang);
    vec3 d = aPos - org;
    // **법선에도 같은 회전을 건다.** 안 걸면 꺾인 뒷전이 평평하게 셰이딩돼
    // 안 꺾인 것과 화면에서 구분이 안 된다(이 작업의 목적 자체가 사라진다).
    if (yAxis) {
      P = org + vec3(d.x * c + d.z * s, d.y, -d.x * s + d.z * c);
      Nrm = vec3(aNorm.x * c + aNorm.z * s, aNorm.y, -aNorm.x * s + aNorm.z * c);
    } else {
      P = org + vec3(d.x, d.y * c - d.z * s, d.y * s + d.z * c);
      Nrm = vec3(aNorm.x, aNorm.y * c - aNorm.z * s, aNorm.y * s + aNorm.z * c);
    }
  }
  vec4 world = uModel * vec4(P, 1.0);
  vW = world.xyz;
  // 기체는 균등 스케일이라 mat3(uModel) 정규화로 충분하다. 미사일 반경만
  // diag(k, k, 1) 을 쓰는데, 순수 반경 법선은 정규화 뒤 방향이 불변이고
  // 노즈콘·보트테일 법선만 기운다(그 배율이 서는 거리에서는 안 보인다).
  vN = normalize(mat3(uModel) * Nrm);
  vec3 nO = normalize(Nrm);
  vNObj = nO;
  // 접선은 **기체축(z)을 법선 평면에 투영한 것**이다. 임의 축을 쓰면 안 된다 —
  // 법선에서 접선을 뽑는 식은 어떤 것이든 특정 법선 방향에서 값이 튀고(털난 공),
  // 그 자리에 무늬가 회전하는 이음매가 선으로 남는다. 기체축을 쓰면 튀는 곳이
  // 법선이 z 와 나란한 두 점(기수 끝·노즐 출구)뿐이고, 그 둘은 각각 몇 px 이다.
  // 덤으로 결이 기류를 따라 뒤로 눕는다 — 실물 판금의 결과 같은 방향이다.
  vec3 t = vec3(0.0, 0.0, 1.0) - nO * nO.z;
  // 그 두 점에서는 t 가 0 벡터라 normalize 가 NaN 을 뱉는다. NaN 은 한 픽셀에
  // 머물지 않고 곱해지는 곳마다 번지므로 여기서 끊는다.
  vT = normalize(mat3(uModel) * (dot(t, t) > 1e-6 ? t : vec3(1.0, 0.0, 0.0)));
  // **식별 틴트를 여기서 걸지 않는다.** 예전 vAlb = mix(aColor, uTint, uTintAmt)
  // 는 알베도를 통째로 치환해서 적기에서는 도장·정점 AO·패널라인이 전부
  // 사라졌고, 도장이 밝아지면 같은 uTintAmt 라도 강조 강도가 달라졌다.
  // FS 에서 **최종 색의 휘도 보존 채도 이동**으로 건다.
  vAlb = aColor;
  vMR = aMR;
  // **구동 전 위치**를 넘긴다. FS_PBR 의 도장 그라디언트·패널라인·색 띠는 전부
  // 표면에 인쇄된 것이라 조종면이 꺾여도 표면에 붙어 따라가야 한다. 구동 후
  // 좌표를 넘기면 에일러론을 칠 때마다 선이 날개 위를 미끄러진다.
  vObj = aPos;
#ifdef SKIN
  vSkin = aSkin;
#endif
  gl_Position = uProj * uView * world;
}`;

// 부품 코드는 jet.js 의 JET_PARTS 와 **같은 값**이어야 한다. 셰이더가 문자열이라
// import 로 묶을 수 없다 — 어긋나면 컴파일은 통과하고 그림만 조용히 틀어진다.
//   0 동체 · 1 주익 · 2 수평미익 · 3 수직미익 · 4 흡입구립 · 5 덕트 ·
//   6 노즐 · 7 캐노피 · 8 무장/파일런 · 9 스트레이크 · 10 피토
export const FS_PBR = ATMO_GLSL + TONE_GLSL + NOISE_GLSL + PBR_GLSL + CLOUD_GLSL + `
varying vec3 vN, vW, vAlb;
varying vec2 vMR;
varying vec3 vObj;
// 기체 좌표계 법선. 카운터셰이딩(위 어둡고 아래 밝은 도장)을 **면이 향한
// 쪽**으로 가르는 데 쓴다. 예전에는 vObj.y(위치)로 갈랐는데, 주익처럼
// 납작한 면은 위아래가 같은 높이라 두 면 모두 위색과 아래색의 중간인 밝은
// 회색이 됐다. 실측: 의도한 윗면 밝기 0.201 인데 주익 0.350, 동체 0.320.
// 기체가 통째로 하얗게 보이던 원인이다(수직미익만 높이 있어 제대로 어두웠다).
// 월드 법선을 쓰면 안 된다 — 기체가 구를 때마다 도장이 다시 칠해진다.
varying vec3 vNObj;
varying vec3 vT;           // 마이크로 범프 접선(월드) — VS 쪽 주석 참조
#ifdef SKIN
varying vec2 vSkin;        // x = 정점 AO, y = 부품 코드
#endif
uniform float uFlash;      // 폭발 순간 씬 전체를 아주 짧게 밝힌다
uniform float uPanel;      // 패널라인 **강도 마스터**(기체 1.0 / 콕핏 0.35 / 그 외 0)
uniform float uBurn;       // 피격 그을림 0..1
uniform vec3 uTint;        // 식별 틴트 색(적 붉음 / 아군 파랑)
uniform float uTintAmt;
uniform float uPxScale;    // 2*tan(fov/2)/renderHeightPx — 1px 이 벌리는 각
uniform float uScale;      // uModel 에 들어간 균등 배율(기종 배율 × 원거리 확대)
uniform vec3 uPaintTop;    // 기종 도장 — 상면(선형 albedo)
uniform vec3 uPaintBot;    // 기종 도장 — 하면
uniform float uPaintAmt;   // 도장 적용(콕핏·미사일은 0 — 손으로 준 색을 지키려고)
uniform float uGold;       // 캐노피 금(ITO) 코팅 — falcon 만 1
uniform vec3 uBand;        // 수직미익 상단 색 띠(roster 플레이어 색, 선형)
uniform float uBandAmt;
uniform float uSeed;       // 개체차 0..1 (pl.id 해시 — 봇에도 그대로 걸린다)

void main() {
  vec3 N = normalize(vN);
  vec3 toEye = uCamPos - vW;
  float dist = length(toEye);
  vec3 V = toEye / max(dist, 1e-3);
  vec3 alb = vAlb;
  float metal = vMR.x, rough = vMR.y;
  // ao 는 예전에 1.0 하드코딩이라 기체에 접촉 그림자가 전무했다 — 파일런·
  // 스토어·미익 뿌리·흡입구 밑이 동체에 '얹혀' 보였다. jet.js 가 부팅 시
  // 해석식으로 구운 정점 AO 를 쓴다.
#ifdef SKIN
  float ao = vSkin.x;
  float part = vSkin.y;
#else
  // 폴백 경로(SKIN 컴파일 실패)는 전 부품이 0 = 동체로 취급된다. 도장·패널이
  // 유리에도 걸리지만 '기체가 통째로 안 그려지는' 것보다는 낫다.
  float ao = 1.0;
  float part = 0.0;
#endif
  // 마모량 — 같은 방의 같은 기종 여섯 대를 여섯 대로 보이게 하는 유니폼 하나.
  float wear = 0.30 + 0.70 * fract(uSeed * 7.13);

  // 오브젝트 1m 가 화면에서 몇 px 인가의 역수. 예전에는 패널라인 블록 **안에서**
  // 구했는데, 아래 '표면 잡티' 도 같은 잣대로 페이드해야 해서 위로 끌어올렸다.
  // 식도 의미도 그대로다(fwidth 를 못 쓰는 이유는 패널라인 블록 주석 참조).
  float slant = max(dot(N, V), 0.12);
  float mpp = dist * uPxScale / (max(uScale, 1e-4) * slant);   // 오브젝트 m/px

  // ── 기종 도장 ────────────────────────────────────────────────────
  // paint() 가 칠한 면(동체·주익·수평/수직미익·흡입구 립·스트레이크)만 갈아
  // 끼운다. 손으로 색을 지정한 면(유리·덕트·노즐 열변색·무장·피토)은 정점색이
  // 원본이라 건드리면 안 된다 — 그래서 부품 코드로 가른다.
  bool painted = (part < 4.5) || (part > 8.5 && part < 9.5);
  if (uPaintAmt > 0.0 && painted) {
    // 실제 전투기의 카운터셰이딩은 '위아래 절반씩'이 아니다. **배 밑만**
    // 밝은 회색이고 옆면·수직미익·윗면은 전부 같은 위색이다. 그래서 법선의
    // y 를 그대로 섞지 않고, 아래를 또렷이 볼 때만 아래색으로 넘어가게 한다.
    //
    // 단순히 vNObj.y*1.6+0.5 로 했더니 수직미익과 동체 옆면이 위아래 중간인
    // 밝은 회색이 됐다(실측 0.206 -> 0.351). 그건 도장이 아니라 그냥 색이 뜬
    // 것이다.
    float t = 1.0 - smoothstep(-0.15, -0.78, vNObj.y);
    alb = mix(alb, mix(uPaintBot, uPaintTop, t), uPaintAmt);
    // 저주파 얼룩 — 시드로 흔들어 개체차를 만든다. fbm2(=vnoise 2회) 대신
    // vnoise 1회다. 이 블록은 기체 픽셀에서만 돌고 기체는 화면의 몇 %다.
    float mot = vnoise(vObj.xz * 0.42 + uSeed * 31.7);
    alb *= 1.0 - 0.09 * wear * smoothstep(0.45, 0.95, mot);
  }

  // ── 표면 잡티 — '플라스틱' 을 벗기는 실제 작업 ─────────────────────
  //
  // 진단부터. 문제는 메시가 아니었다(노즐 페탈·덕트·LERX·캐노피는 이미 다
  // 있다). **재질이 기수부터 노즐까지 정확히 한 값**인 것이 원인이다 —
  // 거칠기는 전 표면 0.42 단일값이었고 알베도 변화는 파장 2.4m 짜리 얼룩
  // 하나(진폭 9%)가 전부였다. 균일한 거칠기는 통짜로 미끄러지는 하이라이트를
  // 만들고, 그 하이라이트가 곧 사출 성형품의 정의다. 부품을 더 붙여서는
  // 절대 안 고쳐진다(BACKLOG 2순위의 지적 그대로다).
  //
  // 실제 정비받으며 나는 기계의 표면은 셋으로 나뉜다. 셋 다 절차적으로
  // 만든다 — 이 저장소는 이미지 파일을 쓰지 않는다.
  //   (1) 기류를 따라 뒤로 늘어진 때·색바램
  //   (2) 배기 그을음 (노즐 주변, 후방 3인칭이 기본이라 늘 보이는 자리)
  //   (3) 패널마다 어긋난 광택·색조 (아래 패널라인 블록에서 격자를 공유한다)
  //
  // **섭동은 평균 0 으로 만든다.** vnoise 는 U(0,1) 해시의 볼록결합이라
  // 평균이 정확히 0.5 다 — (n - 0.5) 의 평균은 정확히 0 이고, 그래서
  // (셰이더 소스는 JS 템플릿 리터럴 안이다. **주석에도 역따옴표를 쓰면 안 된다**
  //  — 문자열이 거기서 닫혀 파일 전체가 SyntaxError 가 된다. 실제로 밟았다.)
  // 원거리에서 페이드로 꺼도 기체의 평균 밝기가 변하지 않는다. 패널라인이
  // '잉크 총량 보존' 으로 푼 것과 같은 문제를 여기서는 이 방법으로 푼다
  // (예전에 dist 로 선을 0 까지 죽여서 '멀어지면 기체가 밝아지던' 사고).
  //
  // 비용: vnoise 1회 + smoothstep 3회. 기체는 화면의 몇 % 라 측정 가능한
  // 프레임 비용이 아니다. **금속으로 되돌리는 길은 쓰지 않았다** — metallic 은
  // 전 도장면에서 0 그대로고, 여기서 움직이는 것은 거칠기와 알베도뿐이다.
  //
  // 게이트는 도장 블록과 **같은 조건**이다(uPaintAmt > 0 && painted). 손으로
  // 색을 준 면은 건드리지 않는다는 이 파일의 규칙을 그대로 따른다 — 미사일과
  // 콕핏은 uPaintAmt 가 0 이라 여기 들어오지 않는다. part 만으로 가르면
  // 미사일이 part=0(동체)이라 그을음·레이돔 규칙에 걸린다.
  if (uPaintAmt > 0.0 && painted) {
    // 파장 0.87m 짜리 디테일이 화면 2.4px 아래로 작아지면 지글거림이 된다.
    // mpp 0.36 ≈ 250m(1080p·화각 75·배율 1) 부터 걷기 시작한다.
    float fine = 1.0 - smoothstep(0.36, 1.10, mpp);
    // 스팬 방향(x)은 촘촘하고 축 방향(z)은 3.8m 로 늘어진다. 이 **비등방**이
    // 전부다 — 등방 노이즈를 얹으면 때가 아니라 대리석 무늬로 읽힌다.
    // vObj.y 를 섞는 것은 동체 위아래가 같은 줄무늬를 갖지 않게 하려는 것이다
    // (안 섞으면 상면 무늬가 하면에 그대로 복사돼 대칭이 눈에 띈다).
    float strk = vnoise(vec2(vObj.x * 1.15 + vObj.y * 0.80, vObj.z * 0.26)
                        + uSeed * 19.7) - 0.5;
    alb *= 1.0 + strk * 0.30 * wear * fine;
    rough = clamp(rough + strk * 0.26 * fine, 0.04, 1.0);

    // 배기 그을음. 마스크는 vObj 의 매끈한 함수라 원거리에서도 지글거리지
    // 않으므로 페이드하지 않는다 — 노이즈로는 세기만 흔들고 평균은 마스크가
    // 쥔다. 가로 감쇠(|x| 1.3~4.2m)를 넣지 않으면 익단과 스태빌레이터 바깥쪽까지
    // 새까매져서 '그을음' 이 아니라 '어두운 도장' 으로 읽힌다.
    // 상한 1.0 으로 자르는 이유: 노이즈 변조가 1.6배까지 올라가면 알베도가
    // 0.41배(59% 어두움)가 되어 '그을음' 이 아니라 '탄 자국' 이 된다. 최대
    // 42% 까지만 어둡게 한다 — 자국이지 구멍이 아니다.
    float soot = clamp(smoothstep(-2.4, -5.8, vObj.z)
                       * (1.0 - smoothstep(1.3, 4.2, abs(vObj.x)))
                       * (1.0 + 1.2 * strk * fine) * wear, 0.0, 1.0);
    alb *= 1.0 - 0.42 * soot;
    rough = clamp(rough + 0.18 * soot, 0.04, 1.0);

    // 레이돔은 도장 알루미늄이 아니라 복합재다. 실물에서 색과 광택이 눈에
    // 띄게 다르고, 분리선(z=7.60)은 패널라인에 이미 그어져 있다 — 선만 있고
    // 재질이 같으면 그 선이 구조가 아니라 '스티커' 로 읽힌다.
    float radome = smoothstep(7.55, 8.10, vObj.z) * step(part, 0.5);
    alb *= 1.0 - 0.20 * radome;
    rough = mix(rough, 0.50, radome);

    // ── 마이크로 범프 — 하이라이트를 끊는 마지막 수단 ────────────────
    // 위 블록들은 알베도와 거칠기를 얼룩지게 했지만 **법선은 아직 면마다 한
    // 값**이다. 그런데 하이라이트가 표면 어디에 서는지를 정하는 것은 법선뿐이라,
    // 거칠기를 아무리 흔들어도 하이라이트 자체는 기체를 통짜로 미끄러진다.
    // 실물 판금은 프레임 사이가 미세하게 배불러(oil canning) 그 미끄러짐이
    // 끊긴다. 여기서 하는 것이 그것이고, 이 파일에 남은 마지막 수단이다.
    //
    // **노멀맵을 쓰지 않는다** — 이 저장소는 이미지 파일을 쓰지 않고, 무엇보다
    // 접선공간 노멀맵은 UV 가 있어야 하는데 이 메시에는 UV 가 없다. 대신
    // 오브젝트 공간에서 절차적 높이의 기울기를 재 법선에 얹는다. 필요한 것은
    // 접평면 두 축뿐이고 그건 vT 와 cross(N, vT) 로 이미 서 있다.
    //
    // **금속·유광으로 되돌리는 길이 아니다.** metallic 도 거칠기도 여기서
    // 안 건드린다 — 움직이는 것은 법선 하나뿐이다.
    //
    // **진폭과 파장은 훑어서 골랐다.** 태양의 거울 방향에 카메라를 둔 도장판을
    // 1920x1080 으로 실제로 그려, 범프 파장 대역의 대비(2차차분 RMS)가 얼마나
    // 늘고 평균 밝기가 얼마나 흔들리는지 잰 표다. 패널라인은 끄고 쟀다 —
    // 그쪽도 같은 일을 하는 다른 수단이라 켜 두면 기여가 안 갈린다.
    //
    //   파장     진폭    대역대비   평균밝기
    //   0.625m   0.055   1.09배      -0.6%     <- 처음 넣었던 값. 거의 무의미했다
    //   0.625m   0.12    1.38배      -2.8%
    //   0.625m   0.22    1.90배      -7.8%
    //   0.385m   0.055   1.25배      -0.5%
    //   0.385m   0.12    1.81배      -2.7%     <- 고른 값
    //   0.385m   0.22    2.57배      -7.6%
    //   0.385m   0.35    3.21배     -15.2%
    //
    // 진폭을 올릴수록 어두워지는 것은 기운 면이 거울 방향에서 벗어나기 때문이다.
    // 그래서 진폭의 상한을 정하는 것은 대비가 아니라 **밝기**다 — 0.22 부터는
    // '도장이 어두워졌다' 로 읽힐 값이라 안 쓴다. 비용은 진폭과 무관하다.
    //
    // 0.12 는 법선을 중앙값 3.0도 기울인다(평균 3.2 · 95% 6.7 · 최대 9.9도.
    // 기울기 분포는 20만 표본으로 쟀다). 실물 판금의 굴곡이 그 언저리다.
    // 1도 아래면 GGX 로브 폭(거칠기 0.62)에 통째로 묻혀 하이라이트가 안 끊기고,
    // 10도를 넘기면 망치로 두들긴 판이 된다. 좌표는 uSeed 로 밀어 같은 방의
    // 같은 기종 여섯 대가 같은 자리에 같은 굴곡을 갖지 않게 한다.
    //
    // 파장 0.385m 가 화면 2.4px 아래로 작아지면 지글거림이 된다 — 그 문턱이
    // mpp 0.16 이다. 법선 지글거림은 알베도보다 훨씬 눈에 띄므로(하이라이트가
    // 픽셀 단위로 켜졌다 꺼진다) 위 잡티(0.36~1.10)보다 일찍 걷는다.
    // mb 가 0 이면 vnoised 를 통째로 건너뛴다 — 화면의 기체는 대개 멀리 있다.
    float mb = 1.0 - smoothstep(0.16, 0.48, mpp);
    if (mb > 0.0) {
      // 접선을 FS 가 **다시 만든다.** VS 와 같은 식이라야 넘어온 vT 의 원상과
      // 맞는다(그쪽 주석에 왜 기체축인지 적어 뒀다).
      vec3 nO = normalize(vNObj);
      vec3 tO = vec3(0.0, 0.0, 1.0) - nO * nO.z;
      tO = dot(tO, tO) > 1e-6 ? normalize(tO) : vec3(1.0, 0.0, 0.0);
      // 오브젝트 위치를 두 축에 내려 만든 2D 좌표. 곡면이라 축이 조금씩 돌지만
      // 노이즈는 위치가 지배하므로 결이 면을 넘어 이어진다.
      vec3 g = vnoised(vec2(dot(vObj, tO), dot(vObj, cross(nO, tO))) * 2.60
                       + uSeed * 41.3);
      vec3 Tw = normalize(vT);
      N = normalize(N - (g.y * Tw + g.z * cross(N, Tw)) * 0.12 * mb);
    }
  }

  // 캐노피 금 코팅(ITO). F-16 을 F-16 으로 읽게 하는 가장 강한 단일 신호다.
  // 목표는 f0 ≈ (0.28,0.21,0.09) — 이 BRDF 는 f0 = mix(0.04, alb, metal) 이라
  // metal 0.25 로는 도달할 수 없다(0.03 + 0.25·alb). metal 0.85 로 잡고
  // alb = (f0 - 0.006)/0.85 를 역산했다. kd=0.15 라 확산은 거의 안 남는다 —
  // 금빛 거울이지 금색 페인트가 아니다.
  if (uGold > 0.0 && part > 6.5 && part < 7.5) {
    alb = vec3(0.322, 0.240, 0.099);
    metal = 0.85;
  }

  // 수직미익 상단 색 띠 — roster 의 플레이어 색이라 **프로토콜 변경 0** 이고
  // 봇도 서버 COLORS 표에서 같은 경로로 색을 받는다.
  if (uBandAmt > 0.0 && part > 2.5 && part < 3.5) {
    alb = mix(alb, uBand, smoothstep(2.55, 2.78, vObj.y) * uBandAmt);
  }

  // ── 패널라인 ──────────────────────────────────────────────────────
  // 예전 구현의 문제 셋: (1) vObj 만 보고 그려서 유리·덕트·노즐·무장에도
  // 선이 갔다, (2) 폭이 오브젝트 고정 5.3px 이라 '패널라인'이 아니라 체크무늬
  // 도장으로 읽혔다, (3) min(x,y,z) 3축 월드 격자는 격자면에 거의 평행한
  // 면에서 띠가 통째로 뭉개졌다(수직미익 뿌리 0.48×3m 어두운 얼룩).
  if (uPanel > 0.0) {
    float d = 1000.0;    // 가장 가까운 선까지의 거리(오브젝트 m)
    float T = 1.5;       // 선 간격 — 커버리지 평균 계산에 쓴다
    float on = 1.0;
    // 패널 **칸 번호**(정수 좌표). 아래에서 이 칸마다 광택·색조를 조금씩
    // 어긋나게 한다. 선을 긋는 격자를 그대로 재사용하는 것이 핵심이다 —
    // 따로 격자를 만들면 색조 단차가 선을 가로질러 어긋나서 더 이상해진다.
    // 격자가 없는 부품(립·무장·스트레이크)은 좌우/구간만 갈라 준다.
    vec2 cellv = vec2(0.0);
    if (part < 0.5) {
      // 동체 — z 프레임 + 스트링거(둘레). 부각 15도에서 전후 방향은
      // sin15=0.26 배로 압축되므로 프레임 간격을 둘레 간격의 1.7배로 벌려야
      // 화면에서 둘 다 비슷한 px 가 된다(비등방 설계).
      T = 1.53;
      d = abs(fract(vObj.z / T + uSeed * 0.31) - 0.5) * T;
      vec2 rv = vec2(vObj.x, vObj.y - 0.02);
      float rr = max(length(rv), 0.28);
      float ang = atan(rv.y, rv.x);
      float arc = 6.2831853 * rr / 8.0;              // 스트링거 8줄
      d = min(d, abs(fract(ang * 8.0 / 6.2831853 + 0.5) - 0.5) * arc);
      cellv = vec2(floor(vObj.z / T + uSeed * 0.31),
                   floor(ang * 8.0 / 6.2831853 + 0.5));
      // 진짜 있는 선: 레이돔 분리선 · 흡입구 뒤 스플리터 · 캐노피 실
      d = min(d, abs(vObj.z - 7.60));
      d = min(d, abs(vObj.z - 3.25));
      float sill = 0.55 + 0.14 * clamp((5.6 - vObj.z) / 5.2, 0.0, 1.0);
      if (vObj.z > 0.2 && vObj.z < 5.8) d = min(d, abs(vObj.y - sill));
    } else if (part < 1.5) {
      // 주익 — 리브(스팬 0.75m) + 힌지선. 시위 방향 균일 격자는 넣지 않는다:
      // 구조선 두 개가 이미 시위를 나누고, 격자를 겹치면 모아레만 는다.
      T = 0.75;
      d = abs(fract(abs(vObj.x) / T + uSeed * 0.17) - 0.5) * T;
      float u = clamp((abs(vObj.x) - 1.02) / 5.03, 0.0, 1.0);
      float zle = mix(2.40, -1.70, u);
      float ch = mix(5.30, 1.55, u);
      d = min(d, abs(vObj.z - (zle - 0.68 * ch)));    // 플랩/에일러론 힌지선
      d = min(d, abs(vObj.z - (zle - 0.12 * ch)));    // 앞전 슬랫 경계
      d = min(d, abs(abs(vObj.x) - 1.14));            // 익근 필렛
      // 시위 방향으로도 칸을 나눈다 — 선은 안 긋지만(모아레) 색조는 나뉘어야
      // 날개가 '한 장의 판' 이 아니라 '패널을 붙인 구조물' 로 읽힌다.
      cellv = vec2(floor(abs(vObj.x) / T + uSeed * 0.17), floor(vObj.z / 1.15));
    } else if (part < 2.5) {
      T = 0.75;
      d = abs(fract(abs(vObj.x) / T) - 0.5) * T;
      d = min(d, abs(abs(vObj.x) - 0.95));            // 전동 스태빌레이터 경계
      cellv = vec2(floor(abs(vObj.x) / T), floor(vObj.z / 1.00));
    } else if (part < 3.5) {
      // 수직미익 — 스팬 방향은 y 다. 여기가 옛 3축 격자에서 얼룩이 나던 곳이다.
      T = 0.75;
      d = abs(fract((vObj.y - 0.55) / T) - 0.5) * T;
      float u = clamp((vObj.y - 0.55) / 2.75, 0.0, 1.0);
      float zle = mix(-3.20, -5.10, u);
      float ch = mix(3.10, 1.15, u);
      d = min(d, abs(vObj.z - (zle - 0.72 * ch)));    // 방향타 힌지선
      cellv = vec2(floor((vObj.y - 0.55) / T), floor(vObj.z / 1.20));
    } else if (part < 4.5) {
      T = 1.53;
      d = abs(vObj.z - 3.25);                          // 립 뒤 스플리터만
      cellv = vec2(0.0, sign(vObj.x));                 // 좌우 립만 갈라 준다
    } else if (part > 7.5 && part < 8.5) {
      T = 0.90;
      d = abs(fract(vObj.z / T) - 0.5) * T;            // 무장 — 아주 성긴 링만
      // 무장은 링마다가 아니라 **발마다** 달라야 한다(한 발은 한 번에 칠한다).
      // +0.35 는 칸 경계를 스토어 중심(|x| = 2.73 · 4.04 · 6.05)에서 떼어
      // 놓으려는 것이다 — 안 밀면 경계가 한 발을 세로로 갈라 색조 단차가
      // 미사일 몸통을 따라 줄로 남는다(최소 여유 0.25m > 최대 반경 0.224m).
      cellv = vec2(floor(abs(vObj.x) * 0.7 + 0.35), sign(vObj.x));
    } else if (part > 8.5 && part < 9.5) {
      T = 1.20;
      d = abs(fract(vObj.z / T) - 0.5) * T;
      cellv = vec2(floor(vObj.z / T), sign(vObj.x));
    } else {
      on = 0.0;    // 5 덕트 · 6 노즐 · 7 캐노피 · 10 피토 — 선을 긋지 않는다
    }

    // 선폭은 **화면 기준**이다. fwidth 를 못 쓰므로(WebGL2 + ESSL1 에서
    // 미정의, shaders.js 앞쪽 측정 주석 참조) dist·slant·uScale 세 인자를
    // 넣은 해석식으로 만든다. **하나라도 빠지면 선회 중에만 보이는 모아레**가
    // 난다 — 정지 스크린샷으로는 절대 안 잡힌다.
    // 1e-4 아래로 내리지 않는다 — mediump 폴백의 최소 정규수가 약 6.1e-5 라
    // 그보다 작은 상수는 0 으로 플러시되고 나눗셈이 inf 가 된다.
    // (slant · mpp 는 main 앞쪽으로 옮겼다 — 표면 잡티도 같은 잣대를 쓴다.)
    // 물리 반폭 1.6cm(총 3.2cm). 화면에서 1.4px 보다 얇아지면 1.4px 로 넓히되
    // **정확히 그만큼 약하게** 그린다 — 잉크 총량(적분)이 보존된다.
    //   평균 = amp · hw / T = hw0 / T  (세 구간 전부에서 항등)
    // 그래서 거리·해상도·화각·기종 배율이 어떻게 변해도 기체의 평균 밝기가
    // 안 변한다. 예전엔 dist 로 선을 0 까지 페이드해서 **멀어지면 기체가 밝아졌다**.
    // 선 간격의 절반을 넘겨 넓히는 건 의미가 없으므로 거기서 자른다.
    float hw0 = 0.016;
    float hwPix = 0.70 * mpp;                       // 화면 총 1.4px
    float hw = clamp(hwPix, hw0, 0.5 * T);
    float amp = hw0 / hw;
    float line = (1.0 - smoothstep(0.0, hw, d)) * amp * on;
    alb *= 1.0 - line * 0.50 * uPanel * (0.55 + 0.45 * wear);
    // 러프니스 점프는 +0.05 다. 예전 +0.22 는 태양 하이라이트를 선 위에서
    // 급격히 끊어 원거리 반짝임(파이어플라이)을 만들었다.
    rough = mix(rough, min(rough + 0.05, 1.0), line * uPanel);

    // ── 패널마다 어긋난 광택·색조 ────────────────────────────────────
    // 표면 잡티 셋 중 세 번째다. 실물에서 가장 확실한 '정비받는 기계' 신호이자
    // 여기 넣을 수 있는 것 중 가장 싼 것이다(hash21 1회).
    //
    // 왜 이게 결정적인가: 패널은 교체·재도장 시기가 제각각이라 광택과 색조가
    // 미세하게 어긋나 있고, 그 어긋남이 **하이라이트를 패널 단위로 끊는다.**
    // 하이라이트가 기체 전체를 통짜로 미끄러지면 거칠기를 아무리 올려도
    // 성형품으로 읽힌다 — 균일함 자체가 문제이지 광택의 세기가 문제가 아니다.
    // (그래서 반대 방향, 즉 금속·유광으로 되돌리는 길로는 절대 안 풀린다.)
    //
    // 진폭은 일부러 작다: 알베도 ±5.5%, 거칠기 ±0.075. 크게 주면 위장 도색이
    // 되어 버린다. 목표는 '눈에 띄는 무늬' 가 아니라 '균일함의 파괴' 다.
    //
    // 칸이 화면에서 2.5px 아래로 작아지면 지글거림이 되므로 걷는다. 평균 0 인
    // 섭동이라(hash21 은 U(0,1), -0.5 하면 평균 0) 페이드가 기체의 평균 밝기를
    // 바꾸지 않는다 — 패널라인이 잉크 보존으로 푼 문제를 이쪽은 이렇게 푼다.
    // part 를 해시에 섞는 이유: 안 섞으면 같은 칸 번호를 갖는 주익과 수평미익이
    // 정확히 같은 값을 받아 두 면의 얼룩이 대칭으로 겹친다.
    float cellPx = T / max(mpp, 1e-4);
    float cf = smoothstep(2.5, 6.0, cellPx) * on * uPanel;
    float pj = hash21(cellv + vec2(part * 3.7, part * 9.1) + uSeed * 53.1) - 0.5;
    alb *= 1.0 + pj * 0.11 * wear * cf;
    rough = clamp(rough + pj * 0.15 * cf, 0.04, 1.0);
  }

  if (uBurn > 0.0) {
    float sm = fbm2(vObj.xz * 1.7 + vObj.y * 0.9);
    alb = mix(alb, vec3(0.035, 0.030, 0.028), clamp(uBurn * smoothstep(0.35, 0.8, sm), 0.0, 1.0));
    rough = mix(rough, 0.92, uBurn * 0.7);
  }
  float sh = cloudShadow(vW, uSun);
  vec3 c = shadePBR(N, V, alb, metal, rough, sh, ao);
  c += uFlash * alb * 2.0;
  // 식별 틴트 — **휘도 보존 채도 이동**이다. 밝기(따라서 형태·패널라인·AO 의
  // 명암 구조)를 그대로 두고 색상만 민다. 알베도 치환과 달리 새 도장이 밝아져도
  // 강조 강도가 변하지 않고, 틴트가 걸린 적기에서도 디테일이 살아남는다.
  c = aerial(c, uCamPos, -V, dist, uSun);
  // 식별 틴트는 **대기 산란 뒤**에 건다. 물리량이 아니라 '식별 강조' 토글로
  // 끌 수 있는 **판단 정보 오버레이**이고, 대기 앞에 걸면 정작 필요한 원거리에서
  // 안개가 먼저 씻어낸다(실측: 1000m 에서 R/B 가 1.28 → 1.11 로 무너졌다).
  // 휘도를 정확히 보존하므로 안개가 만드는 거리감(밝기·대비)은 그대로 남고
  // 색상만 돈다.
  //
  // 배수는 1.4 고정이 아니라 **uTint 자신의 휘도로 정규화**한다. 고정 1.4 는
  // 실측에서 너무 약했다 — 적색 (1,0.16,0.16) 의 휘도가 0.411 이라 목표색이
  // 원본보다 43% 어두워지고, 그 손실을 메우려 mix 가 원본 회색을 남긴다.
  // 정규화하면 목표 휘도가 원본과 **정확히 같아지고**(진짜 휘도 보존) 동시에
  // 채도 이동폭이 커진다. 적색이면 tn = (2.43, 0.39, 0.39) 이다.
  if (uTintAmt > 0.0) {
    vec3 kY = vec3(0.299, 0.587, 0.114);
    vec3 tn = uTint / max(dot(uTint, kY), 1e-3);
    c = mix(c, dot(c, kY) * tn, uTintAmt);
  }
  gl_FragColor = vec4(sceneOut(c), 1.0);
}`;

// 발광체(애프터버너 콘 · 노즐 내부 · 항법등) — 조명을 받지 않는다
export const VS_GLOW = `
attribute vec3 aPos;
attribute vec3 aNorm;
attribute vec3 aColor;
attribute vec2 aMR;
uniform mat4 uProj, uView, uModel;
varying vec3 vC;
varying float vD;
varying float vT;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vC = aColor;
  vD = aMR.x;               // 밝기 배수를 metallic 슬롯에 실어 보낸다
  // roughness 슬롯은 **추력 연동 플래그**다. 노즐 발광과 배기 코어만 1 이고
  // 항법등은 0 이다 — uGlow 를 메시 전체에 곱하면 스로틀을 놓을 때마다
  // 항법등까지 어두워진다(같은 메시에 들어 있다).
  vT = aMR.y;
  gl_Position = uProj * uView * w;
}`;

export const FS_GLOW = TONE_GLSL + `
varying vec3 vC;
varying float vD;
varying float vT;
uniform float uGlow;
void main() { gl_FragColor = vec4(sceneOut(vC * vD * mix(1.0, uGlow, vT)), 1.0); }`;

// 접지 그림자 데칼 — 셰도우맵을 쓰지 않는다. 스냅샷의 agl 이 800m 미만일 때만
// 기체 아래 지형 높이를 조회해 반투명 타원 하나를 눕힌다. 비용이 사실상 0인데
// 저공비행 중인 기체가 지면에서 떠 보이는 문제가 사라진다.
export const VS_DECAL = `
attribute vec2 aXY;
uniform mat4 uProj, uView;
uniform vec3 uCenter;
uniform float uRadius;
varying vec2 vP;
void main() {
  vP = aXY;
  vec3 w = uCenter + vec3(aXY.x, 0.0, aXY.y) * uRadius;
  gl_Position = uProj * uView * vec4(w, 1.0);
}`;

export const FS_DECAL = `
varying vec2 vP;
uniform float uDark;
void main() {
  float a = (1.0 - smoothstep(0.25, 1.0, length(vP) * 2.0)) * uDark;
  // 곱셈 블렌딩(ZERO, SRC_COLOR)로 어둡게만 만든다
  gl_FragColor = vec4(vec3(1.0 - a), 1.0);
}`;

// ── 인스턴싱 파티클 ────────────────────────────────────────────────
export const VS_FX = `
attribute vec2 aCorner;
attribute vec3 iPos;
attribute vec4 iSRTL;    // size, rot, tile, life(0..1)
attribute vec3 iColor;
attribute vec3 iStretch;
uniform mat4 uProj, uView;
uniform vec3 uRight, uUp, uEye;
varying vec2 vUV;
varying vec3 vCol;
varying float vLife;
varying vec4 vClip;
void main() {
  vec2 c = aCorner;
  float size = iSRTL.x, rot = iSRTL.y, tile = iSRTL.z;
  float s = sin(rot), co = cos(rot);
  vec2 rc = vec2(c.x * co - c.y * s, c.x * s + c.y * co);
  vec3 wp;
  float sl = length(iStretch);
  if (sl > 1e-4) {
    // 속도 방향으로 늘린 빌보드(예광탄)
    vec3 ax = iStretch / sl;
    vec3 vd = normalize(iPos - uEye);
    vec3 sd = cross(ax, vd);
    float sn = length(sd);
    sd = sn > 1e-4 ? sd / sn : uRight;
    wp = iPos + ax * (c.y * sl) + sd * (c.x * size);
  } else {
    wp = iPos + (uRight * rc.x + uUp * rc.y) * size;
  }
  float tx = mod(floor(tile + 0.5), 4.0);
  float ty = floor(floor(tile + 0.5) / 4.0);
  vUV = (vec2(tx, ty) + (c + 0.5)) * 0.25;
  vCol = iColor;
  vLife = iSRTL.w;
  gl_Position = uProj * uView * vec4(wp, 1.0);
  vClip = gl_Position;
}`;

export const FS_FX = TONE_GLSL + `
varying vec2 vUV;
varying vec3 vCol;
varying float vLife;
varying vec4 vClip;
uniform sampler2D uAtlas;
uniform float uSoft;
uniform float uSoftOn;
#ifdef HAS_SOFT
uniform sampler2D uDepth;
uniform vec2 uNearFar;
float linZ(float d) {
  float n = uNearFar.x, fq = uNearFar.y;
  float z = d * 2.0 - 1.0;
  return (2.0 * n * fq) / (fq + n - z * (fq - n));
}
#endif
void main() {
  vec4 t = texture2D(uAtlas, vUV);
  float a = t.a * vLife;
#ifdef HAS_SOFT
  // 소프트 파티클 — 없으면 연기가 지형에 판자처럼 박힌다. 선택이 아니다.
  // 깊이 리졸브가 없는 프레임에서는 uSoftOn=0 으로 통째로 건너뛴다
  // (샘플링해 버리면 알파가 0 이 되어 파티클이 통째로 사라진다).
  if (uSoftOn > 0.5) {
    vec2 suv = vClip.xy / vClip.w * 0.5 + 0.5;
    float sz = linZ(texture2D(uDepth, suv).r);
    float fz = linZ(vClip.z / vClip.w * 0.5 + 0.5);
    a *= clamp((sz - fz) / uSoft, 0.0, 1.0);
  }
#endif
  gl_FragColor = vec4(sceneOut(t.rgb * vCol), a);
}`;

// ── 후처리 ─────────────────────────────────────────────────────────
export const VS_FULL = `
attribute vec2 aXY;
varying vec2 vUV;
void main() { vUV = aXY * 0.5 + 0.5; gl_Position = vec4(aXY, 0.0, 1.0); }`;

// 13탭 다운샘플. 첫 단계에만 Karis 평균을 걸어 파이어플라이를 잡는다.
export const FS_DOWN = `
varying vec2 vUV;
uniform sampler2D uSrc;
uniform vec2 uPx;
uniform float uKaris;
vec3 tap(vec2 o) { return texture2D(uSrc, vUV + o * uPx).rgb; }
float kw(vec3 c) { return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722))); }
vec3 grp(vec3 a, vec3 b, vec3 c, vec3 d) {
  if (uKaris > 0.5) {
    float wa = kw(a), wb = kw(b), wc = kw(c), wd = kw(d);
    return (a * wa + b * wb + c * wc + d * wd) / max(wa + wb + wc + wd, 1e-4);
  }
  return (a + b + c + d) * 0.25;
}
void main() {
  vec3 a = tap(vec2(-2.0, 2.0)), b = tap(vec2(0.0, 2.0)), c = tap(vec2(2.0, 2.0));
  vec3 d = tap(vec2(-2.0, 0.0)), e = tap(vec2(0.0, 0.0)), f = tap(vec2(2.0, 0.0));
  vec3 g = tap(vec2(-2.0, -2.0)), h = tap(vec2(0.0, -2.0)), i = tap(vec2(2.0, -2.0));
  vec3 j = tap(vec2(-1.0, 1.0)), k = tap(vec2(1.0, 1.0));
  vec3 l = tap(vec2(-1.0, -1.0)), m = tap(vec2(1.0, -1.0));
  vec3 o = grp(j, k, l, m) * 0.5;
  o += grp(a, b, d, e) * 0.125;
  o += grp(b, c, e, f) * 0.125;
  o += grp(d, e, g, h) * 0.125;
  o += grp(e, f, h, i) * 0.125;
  gl_FragColor = vec4(o, 1.0);
}`;

// 3x3 텐트 업샘플 — 임계값 없는 에너지 보존형 블룸의 짝
export const FS_UP = `
varying vec2 vUV;
uniform sampler2D uSrc;
uniform vec2 uPx;
uniform float uRad;
void main() {
  vec2 o = uPx * uRad;
  vec3 s = texture2D(uSrc, vUV + vec2(-o.x, o.y)).rgb;
  s += texture2D(uSrc, vUV + vec2(0.0, o.y)).rgb * 2.0;
  s += texture2D(uSrc, vUV + vec2(o.x, o.y)).rgb;
  s += texture2D(uSrc, vUV + vec2(-o.x, 0.0)).rgb * 2.0;
  s += texture2D(uSrc, vUV).rgb * 4.0;
  s += texture2D(uSrc, vUV + vec2(o.x, 0.0)).rgb * 2.0;
  s += texture2D(uSrc, vUV + vec2(-o.x, -o.y)).rgb;
  s += texture2D(uSrc, vUV + vec2(0.0, -o.y)).rgb * 2.0;
  s += texture2D(uSrc, vUV + vec2(o.x, -o.y)).rgb;
  gl_FragColor = vec4(s / 16.0, 1.0);
}`;

// 자동 노출 — 블룸 체인의 최소 밉을 그대로 휘도 추정치로 재사용한다.
// readPixels 는 절대 쓰지 않는다(GPU→CPU 동기 읽기가 프레임을 통째로 날린다).
export const FS_LUM = `
varying vec2 vUV;
uniform sampler2D uSrc;    // 블룸 최소 밉
uniform sampler2D uPrev;   // 1x1 핑퐁
uniform vec2 uRate;        // x = 밝아질 때, y = 어두워질 때
void main() {
  float s = 0.0;
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      vec2 uv = (vec2(float(x), float(y)) + 0.5) * 0.25;
      vec3 c = texture2D(uSrc, uv).rgb;
      s += log(max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-5));
    }
  }
  float cur = exp(s / 16.0);
  float prev = texture2D(uPrev, vec2(0.5)).r;
  if (prev <= 0.0) prev = cur;
  float rate = cur > prev ? uRate.x : uRate.y;
  gl_FragColor = vec4(vec3(mix(prev, cur, clamp(rate, 0.0, 1.0))), 1.0);
}`;

// 합성 — 톤맵 · sRGB · 디더 · 비네트 · 방사 블러 · 그레인 · 수중 틴트를
// **한 번의 풀스크린 드로우**로 전부 처리한다.
export const FS_POST = `
varying vec2 vUV;
uniform sampler2D uSrc;
uniform sampler2D uBloom;
uniform sampler2D uLum;
uniform vec2 uPx;
uniform vec3 uUnderTint;
uniform vec4 uP0;     // exposure, bloomAmt, vignette, grain
uniform vec4 uP1;     // blurAmt, autoExp, under, time
uniform vec2 uCenter; // 방사 블러 중심 (0..1)

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}
float h12(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  float exposure = uP0.x;
  if (uP1.y > 0.5) {
    // 기준 노출 주위를 오가는 '보정' 이다 — 노출 자체를 여기서 정하지 않는다.
    float avg = texture2D(uLum, vec2(0.5)).r;
    // 실측 기준: 맑은 낮 지평선 안개의 선형 방사휘도가 약 0.044 다.
    // 이 값이 sRGB 0.5 근처(중간 밝기)로 오도록 잡았다.
    exposure *= clamp(0.026 / max(avg, 1e-4), 0.40, 2.50);
  }

  vec2 d = vUV - uCenter;
  float r = length(d);
  vec3 c = texture2D(uSrc, vUV).rgb;
  // 방사 모션블러 — 비행 게임에서는 속도 벡터 버퍼보다 훨씬 싸고 결과도 낫다.
  float bl = uP1.x * smoothstep(0.25, 0.9, r);
  if (bl > 0.001) {
    vec3 s = c;
    for (int i = 1; i < 8; i++) {
      float t = float(i) / 7.0;
      s += texture2D(uSrc, vUV - d * (t * bl)).rgb;
    }
    c = s / 8.0;
  }

  c += texture2D(uBloom, vUV).rgb * uP0.y;
  // 수중: 물리를 바꾸지 않고도 '물에 들어갔다' 는 것이 화면에 나타난다
  if (uP1.z > 0.001) {
    vec2 wob = vec2(sin(vUV.y * 42.0 + uP1.w * 2.3), cos(vUV.x * 37.0 + uP1.w * 1.9)) * 0.0022;
    c = mix(c, texture2D(uSrc, vUV + wob * uP1.z).rgb, uP1.z * 0.6);
    c *= mix(vec3(1.0), uUnderTint, uP1.z);
  }

  c *= exposure;
  c = aces(c);
  c = toSRGB(c);
  // 삼각형 분포 디더 ±1/255 — 큰 화면의 하늘 그라데이션 8비트 밴딩이
  // 이 한 줄로 사라진다.
  float n1 = h12(vUV * 719.7 + uP1.w);
  float n2 = h12(vUV * 311.3 - uP1.w);
  c += (n1 - n2) / 255.0;
  c += (h12(vUV * 91.7 + uP1.w * 3.1) - 0.5) * uP0.w;
  c *= 1.0 - uP0.z * r * r;
  gl_FragColor = vec4(c, 1.0);
}`;

// ── 레거시 경로 (그래픽 품질 '낮음') ───────────────────────────────
// 회귀 안전판이다. 이 경로는 작업 전 화면과 픽셀 단위로 같아야 한다.
export const VS_LEGACY = `
attribute vec3 aPos;
attribute vec3 aNorm;
attribute vec3 aColor;
uniform mat4 uProj, uView, uModel;
uniform vec3 uLight;
uniform vec3 uTint;
uniform float uTintAmt;
varying vec3 vColor;
varying float vFog;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vec4 eye = uView * world;
  gl_Position = uProj * eye;
  vec3 n = normalize(mat3(uModel) * aNorm);
  float lam = max(dot(n, uLight), 0.0);
  float sky = n.y * 0.5 + 0.5;
  vec3 ambient = mix(vec3(0.22, 0.20, 0.17), vec3(0.42, 0.50, 0.62), sky);
  vec3 sunCol = vec3(1.05, 0.98, 0.88);
  vec3 base = mix(aColor, uTint, uTintAmt);
  vColor = base * (ambient + sunCol * lam);
  float d = length(eye.xyz);
  float haze = 1.0 - exp(-d / 16000.0);
  float low = clamp(1.0 - world.y / 4000.0, 0.0, 1.0);
  vFog = clamp(haze * (0.55 + 0.45 * low), 0.0, 1.0);
}`;

export const FS_LEGACY = `
varying vec3 vColor;
varying float vFog;
uniform vec3 uFogColor;
void main() {
  vec3 c = mix(vColor, uFogColor, vFog);
  c = c / (c + vec3(0.55)) * 1.55;
  c = pow(c, vec3(0.95));
  gl_FragColor = vec4(c, 1.0);
}`;

export const VS_LINE = `
attribute vec3 aPos;
attribute vec3 aColor;
attribute float aAlpha;
uniform mat4 uProj, uView;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 eye = uView * vec4(aPos, 1.0);
  gl_Position = uProj * eye;
  vColor = aColor;
  vAlpha = aAlpha * (1.0 - clamp(length(eye.xyz) / 26000.0, 0.0, 1.0));
}`;

export const FS_LINE = `
varying vec3 vColor;
varying float vAlpha;
void main() { gl_FragColor = vec4(vColor, vAlpha); }`;

export const VS_SKY_LEGACY = `
attribute vec2 aXY;
uniform mat4 uInvVP;
varying vec3 vDir;
void main() {
  vec4 p = uInvVP * vec4(aXY, 1.0, 1.0);
  vDir = normalize(p.xyz / p.w);
  gl_Position = vec4(aXY, 0.999999, 1.0);
}`;

export const FS_SKY_LEGACY = `
varying vec3 vDir;
uniform vec3 uSun;
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -1.0, 1.0);
  float up = max(h, 0.0);
  float t = pow(1.0 - up, 3.0);
  vec3 zenith = vec3(0.13, 0.32, 0.72);
  vec3 horizon = vec3(0.72, 0.82, 0.92);
  vec3 sky = mix(zenith, horizon, t);
  float sunAmt = max(dot(d, uSun), 0.0);
  vec3 mie = vec3(1.0, 0.92, 0.78) * pow(sunAmt, 6.0) * 0.35;
  float disk = smoothstep(0.9992, 0.9997, sunAmt);
  vec3 sunCol = vec3(1.0, 0.97, 0.90) * disk * 3.0;
  float below = smoothstep(0.0, -0.12, h);
  sky = mix(sky, vec3(0.62, 0.68, 0.72), below * 0.65);
  vec3 c = sky + mie + sunCol;
  c = pow(c, vec3(0.94));
  gl_FragColor = vec4(c, 1.0);
}`;
