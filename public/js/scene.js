// WebGL 3D 씬 — 하늘 / 지형 / 바다 / 기체 / 파티클 / 후처리.
// 외부 3D 라이브러리 없이 직접 셰이더를 쓴다. 셰이더 소스는 gfx/shaders.js.
//
// 그래픽 품질 '낮음' 은 **작업 전 파이프라인 그대로**다(회귀 안전판).
// 그 위에 '보통' · '높음' 이 클립맵 · PBR · HDR 후처리를 얹는다.
import { m4, quat, v3, terrainH, clamp, TERRAIN_MAX } from './m3d.js';
import * as SH from './gfx/shaders.js';
import { Clipmap } from './gfx/terrain.js';
import { Water } from './gfx/water.js';
import { Post } from './gfx/post.js';
import { Fx } from './gfx/fx.js';
import {
  buildAtlas, uploadAtlas, whiteBake, uploadBake,
  T_SMOKE, T_SPARK, T_FLAME, T_GLOW, T_STREAK,
} from './gfx/tex.js';
import {
  buildJet, buildJetGlow, buildAfterburner, buildExhaust, buildMissile, buildCockpit,
  JET_SPAN_REF, MSL_LEN, MSL_DIA,
} from './gfx/jet.js';

// ── 조종면 최대 편각(라디안) ────────────────────────────────────────
// 순수 시각이다. 서버 물리도, 클라 예측도 이 값을 읽지 않는다.
const D_AIL = 18 * Math.PI / 180;
const D_STAB = 12 * Math.PI / 180;
const D_RUD = 14 * Math.PI / 180;
const DEFL_TAU = 0.08;    // 계단 입력을 부드럽게 하는 1차 지연 시정수(초)

// ── 원거리 식별 보정 ────────────────────────────────────────────────
// 먼 적기를 '화면에서 최소 이만큼' 으로 붙잡아 둔다. 기준이 **절대 겉보기
// 미터**라 메시 치수나 기종 배율(mscale)을 바꿔도 식별성이 안 변한다.
// 예전에는 max(1, min(3, dist/1200)) 이라 '메시 상대 배율'이었고, 기종별
// 배율이 들어가는 순간 아무도 그 줄을 안 건드렸는데 falcon 식별성만
// 18% 떨어지는 구조였다.
//
// s0 = 1 에서 예전 식과 **대수적으로 동일**하다. 이 리팩터는 증명 가능하게
// 행동 중립이어야 한다 — 600/1200/1800/2400/3600m 에서
// 1.00 / 1.00 / 1.50 / 2.00 / 3.00 이 나온다.
const ID_K = JET_SPAN_REF / 1200;      // 0.0100833 겉보기m/거리m — 오늘 그대로
const ID_CAP_M = JET_SPAN_REF * 3;     // 36.3m — 오늘의 상한 3배 그대로
// FOV 보상은 넣지 않는다. 가속으로 화각이 75→101도 열리면 바닥이 7.10→4.64px
// 로 무너지는 건 사실이지만, 픽셀로 고정하면 가속할 때 적기만 세계 대비
// 커지는 아티팩트가 생긴다. 눈으로 보고 고르라고 대안을 남겨 둔다:
//   const ID_K_PX = 7.10 * 2 * Math.tan(fov * Math.PI / 360) / this.h;

// ── 미사일 그리기 ───────────────────────────────────────────────────
// 길이는 절대 늘리지 않는다(실물 3.02m). 반경만 픽셀 바닥까지 굵히고,
// 그것도 한계를 넘으면 메시를 포기하고 연기 궤적과 HUD 에 넘긴다.
// 두 경계는 해상도·화각이 바뀌어도 **픽셀로는 항상 같은 값**에 머문다.
const MSL_FLOOR_PX = 2.0;                    // 안티에일리어싱이 지우지 않는 최소 굵기
const MSL_K_MAX = (MSL_LEN / 4) / MSL_DIA;   // 5.98 — 4:1 보다 뚱뚱하면 미사일이 아니다

// ── 저공 속도감 ────────────────────────────────────────────────────
// 시속 3000km 로 날아도 빠르게 느껴지지 않던 근본 원인은 파티클 수가 아니라
// **지형에 스쳐 지나갈 것이 없다**는 것이다. terrainH 의 최고 주파수 파장이
// 885m 라 이 세계에는 885m 보다 작은 지오메트리가 원리적으로 없고(m3d.js
// 주석), 순항 고도 3000m 에서는 그 885m 짜리 언덕조차 화면에서 거의 안
// 움직인다. 속도감(= 시선 각속도)은 **가까운 작은 것**에서만 나온다.
//
// 그래서 세 가지를 전부 '지면 근처' 로 묶는다. 고도가 높으면 효과가 사라지는
// 게 타협이 아니라 물리적으로 맞는 그림이고, 동시에 **비용도 0** 이 된다.
const DUST_AGL = 260;      // 흙먼지가 이는 최대 고도(m)
const SHADOW_AGL = 800;    // 접지 그림자 한계(이 위로는 안 그린다)
const SCAT_AGL = 600;      // 지상 스캐터 한계
// 셀 50m·13칸이면 창이 650m 다. 앞으로 0.6R 밀어 두므로 830m/s 순항에서
// 지물 하나가 시야에 들어와 스쳐 갈 때까지 0.5초쯤 걸린다 — 더 크게 잡으면
// 먼 지물에 terrainH 를 쓰는 셈이고(비용은 거리와 무관하다), 더 작게 잡으면
// 가장자리 페이드가 코앞에서 일어나 지물이 눈앞에서 태어난다.
const SCAT_CELL = 50;      // 스캐터 격자 셀(m) — 셀 하나에 지물 하나
// 셀 개수는 q.detail 에 묶는다. adapt() 가 이미 그 손잡이를 돌리고 있으므로
// 느린 기기에서는 별도 코드 없이 자동으로 성겨진다(DEGRADE 표 참조).
// detail 0(강등 7단계 이하)에서는 통째로 끈다.
const SCAT_N = [0, 7, 11, 13];

// 속도 → 화각 부스트(도). 예전 식은 `min(26, (spd-180)/9)` 였는데 414 m/s
// 에서 이미 상한이라 **순항(830)도 AB(1450)도 똑같이 +26도**였다. 속도 블러가
// 항상 최대치라 '상시 흐림' 이 됐던 것과 완전히 같은 종류의 버그다
// (postParams 주석). 화각이 변하지 않으면 그건 속도 단서가 아니라 그냥 넓은
// 렌즈다 — 가속·감속의 순간에 화각이 '움직여야' 속도로 읽힌다.
//
// 순항 앵커를 오늘 값(830 → +26.0)에 못 박았으므로 **평소 화면 구도는 한
// 도도 안 바뀐다.** 움직이는 건 양 끝뿐이다: 스로틀을 놓으면 좁아지고
// AB 를 켜면 더 열린다. 표로 두는 이유는 멀미 조정이 결국 눈으로 보고 값을
// 만지는 작업이라, 수식 계수보다 '이 속도에서 몇 도' 가 사람이 고칠 수 있는
// 형태이기 때문이다. [속도 m/s, 부스트 도]
// AB 앵커를 31 로 잡아 최대 화각을 106도에 묶었다. 오늘의 최대가 101도이고
// 화각은 넓힐수록 가장자리 왜곡과 멀미가 같이 온다 — 순항 대비 +5도면
// 'AB 를 켰다'는 것이 몸으로 읽히면서 화면은 아직 멀쩡한 범위다.
const FOV_BOOST = [[0, 0], [300, 12], [830, 26], [1450, 31]];
function fovBoost(spd) {
  for (let i = 1; i < FOV_BOOST.length; i++) {
    const a = FOV_BOOST[i - 1], b = FOV_BOOST[i];
    if (spd <= b[0]) return a[1] + (b[1] - a[1]) * clamp((spd - a[0]) / (b[0] - a[0]), 0, 1);
  }
  return FOV_BOOST[FOV_BOOST.length - 1][1];
}

// ── 기종별 도장 (선형 albedo) ──────────────────────────────────────
// 기종별 메시 3벌을 기각한 대신 **같은 메시를 색으로 가른다.** 실루엣이 같아도
// 색이 다르면 사람은 다른 기체로 인식한다. 배율 차이(0.824 vs 1.210)와 겹치면
// 구분이 확실해진다. 비용은 유니폼 두 개다.
//
// 표의 키는 서버 AIRCRAFT 키(roster 의 `ac`)다. roster 는 사람·봇을 구분하지
// 않고 같은 필드를 싣는다 — **bot 플래그로 분기하는 코드를 만들지 말 것.**
// 그 순간 봇과 사람이 다른 도장을 입고 두 경로가 갈라진다.
//
// 하면 필드 이름이 `under` 인 이유: 'bot' 으로 두면 이 파일에서 `bot` 을 grep
// 했을 때 도장 항목이 걸려 **'봇(AI) 분기가 없다'는 검사가 무의미해진다.**
// 그 검사가 이 규칙을 지키는 유일한 자동 수단이라 이름 쪽을 양보한다.
const PAINT = {
  // ── 노출 보정 (2026-08-14) ────────────────────────────────────────
  // 이 값은 '실물 도장의 반사율' 이 아니라 **화면에 그렇게 보이게 하는 값**
  // 이다. 렌더 경로의 노출이 약 7.7배(BASE_EXPOSURE)라, 실물 반사율을 그대로
  // 넣으면 ACES 곡선의 어깨에서 포화해 하얗게 뜬다. 사용자가 네 번 "플라스틱
  // 같다 / 똑같다" 고 지적한 것이 이 포화다.
  //
  // 앞선 두 수정(금속성 0.85 -> 0, 거칠기 0.42 -> 0.62)은 방향이 옳았지만
  // 밝기를 건드리지 않아 효과가 묻혔다. 무광으로 만들어도 흰색은 흰색이다.
  //
  // 조절하려면 여기 세 줄만 만지면 된다. 더 어둡게: 곱하기 0.8.
  // 너무 죽었으면: 곱하기 1.25. 위/아래 비율은 유지하는 편이 좋다 —
  // 그게 카운터셰이딩(배 밑만 밝은 실제 도장 방식)의 근거다.
  // F-16 형 — 2톤 고스트 그레이(상 FS36270 / 하 FS36375)
  falcon: { top: new Float32Array([0.098, 0.113, 0.124]),
            under: new Float32Array([0.300, 0.320, 0.335]), gold: 1 },
  // F-15 형 — Mod Eagle 저대비 2톤. 위아래 차가 거의 없는 것이 특징이다.
  eagle: { top: new Float32Array([0.082, 0.091, 0.096]),
           under: new Float32Array([0.150, 0.165, 0.173]), gold: 0 },
  // Su-27 형 — 청회색. 유일하게 색상(hue)까지 다르다.
  flanker: { top: new Float32Array([0.055, 0.085, 0.123]),
             under: new Float32Array([0.320, 0.350, 0.372]), gold: 0 },
};
const PAINT_DEF = PAINT.falcon;

/** pl.id → 0..1 개체 시드. 정수 해시라 같은 기체는 프레임 간 항상 같은 값이고,
 *  id 에서만 뽑으므로 봇에도 자동으로 걸린다(분기 없음). */
function seedOf(id) {
  let h = (Math.imul(id | 0, 374761393) + 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const _BAND = new Map();
/** roster 의 플레이어 색(sRGB 16진 문자열) → 선형 RGB. 수직미익 상단 색 띠에
 *  쓴다. `c` 는 원래 오던 필드라 **프로토콜 변경이 0** 이고, 봇도 서버
 *  add_player 가 같은 COLORS 표에서 색을 주므로 자동으로 티어가 눈에 보인다. */
function bandOf(hex) {
  let v = _BAND.get(hex);
  if (!v) {
    const n = parseInt(String(hex || '').replace('#', ''), 16);
    const k = Number.isFinite(n) ? n : 0x888888;
    // sRGB → 선형. 0.55 를 곱해 '발광'이 아니라 '칠한 띠'로 앉힌다.
    const s = (b) => Math.pow(b / 255, 2.2) * 0.55;
    v = new Float32Array([s((k >> 16) & 255), s((k >> 8) & 255), s(k & 255)]);
    _BAND.set(hex, v);
  }
  return v;
}

// 기준 노출. 태양 조도 선형 1.0 = 100,000 lux 규약 위에서 하늘이 중간 밝기로
// 오도록 잡은 값이다(EV -3.2). 자동 노출은 이 값 주위를 오갈 뿐이다.
const BASE_EXPOSURE = 1.0 / (1.2 * Math.pow(2, -3.2));
const UNDER_TINT = new Float32Array([0.18, 0.52, 0.58]);

const PRESETS = {
  low: {
    modern: false, post: false, clipmap: false, water: false, clouds: false,
    particles: false, bake: false, detail: 0, waveHi: 0, fxCap: 0,
    bakeSize: 0, aoSize: 0, renderScale: 1.0,
  },
  med: {
    modern: true, post: true, clipmap: true, water: true, clouds: true,
    particles: true, bake: true, detail: 2, waveHi: 0, fxCap: 2000,
    bakeSize: 1024, aoSize: 320, renderScale: 1.0,
  },
  high: {
    modern: true, post: true, clipmap: true, water: true, clouds: true,
    particles: true, bake: true, detail: 3, waveHi: 1, fxCap: 4000,
    bakeSize: 2048, aoSize: 512, renderScale: 1.0,
  },
};

// 적응형 강등 사슬 — 내릴 땐 즉시, 올릴 땐 3초 안정 후.
//
// 예전 사슬은 맨 끝까지 내려가도 후처리·물·파티클이 켜진 채였다. 그래서
// 정말 느린 기기에서는 아무리 강등해도 60fps 에 닿지 못했다. 끝을 '옛
// 렌더러와 같은 수준'까지 열어 둬야 어떤 기기에서든 결국 부드러워진다.
// 비싼 순서대로 뺀다: 픽셀 수 → 구름 → 블룸 해상도 → 물 → 지형 디테일
// → 파티클 → 후처리 전체.
// 강등 순서가 곧 '무엇을 먼저 포기하는가'다. 예전에는 **해상도부터** 깎았다.
// 그런데 해상도는 사용자가 가장 먼저 알아채는 항목이다 — 기체를 돌리면
// 지형이 왈칵 들어와 한순간 프레임이 떨어지고, 그 순간 해상도가 내려가
// **"돌릴 때 흐려진다"** 가 된다. 회전은 게임의 기본 동작이라 이게 상시로
// 걸린다. 그래서 눈에 덜 띄는 것부터 끄고 해상도는 마지막까지 지킨다.
const DEGRADE = [
  { renderScale: 1.00 },
  { renderScale: 1.00, bloomHalf: true },
  { renderScale: 1.00, bloomHalf: true, clouds: false },
  { renderScale: 1.00, bloomHalf: true, clouds: false, detail: 1 },
  { renderScale: 0.85, bloomHalf: true, clouds: false, detail: 1 },
  { renderScale: 0.65, clouds: false, bloomHalf: true, water: false },
  { renderScale: 0.60, clouds: false, bloomHalf: true, water: false, detail: 1 },
  { renderScale: 0.60, clouds: false, bloomHalf: true, water: false, detail: 0,
    fxCap: 400 },
  { renderScale: 0.55, clouds: false, water: false, detail: 0, fxCap: 0,
    particles: false, post: false },
];

// 자동 강등이 갈 수 있는 **최대 단계**. 이 아래(5~8)는 물·후처리·파티클·지형
// 디테일을 꺼 버려서 화면이 통째로 밋밋해진다 — 사용자가 "잠깐 최신 버전이었다가
// 이렇게 된다" 고 한 그 상태다. 프레임을 벌자고 게임이 다른 게임처럼 보이게
// 만들면 안 된다. 그 단계들은 설정에서 품질 '낮음' 을 **직접 고를 때만** 쓴다.
const AUTO_MAX_DEG = 4;

// ── 대기 산란 CPU 미러 ─────────────────────────────────────────────
// 셰이더 ATMO_GLSL 과 같은 식. 태양색과 2밴드 앰비언트를 방 입장 시 1회 계산해
// 유니폼으로 넘기려면 CPU 쪽에도 같은 함수가 있어야 한다.
const BR = [5.802e-6, 13.558e-6, 33.100e-6];
const BM = 21.0e-6;
const BO = [0.650e-6, 1.881e-6, 0.085e-6];
const HR = 8000, HM = 1200, O3C = 15000;

function amKY(cz) {
  const c = clamp(cz, 0, 1);
  const z = Math.acos(c) * 180 / Math.PI;
  return 1 / (c + 0.50572 * Math.pow(96.07995 - z, -1.6364));
}
function sunTransmitJS(sunY) {
  const am = amKY(sunY);
  return BR.map((b, i) => Math.exp(-(b * HR + BM * 1.1 * HM + BO[i] * O3C) * am));
}
function skyRadianceJS(dir, sun, camY) {
  const mu = clamp(dir[0] * sun[0] + dir[1] * sun[1] + dir[2] * sun[2], -1, 1);
  const h0 = Math.max(camY, 0);
  const am = amKY(dir[1]);
  const fR = Math.exp(-h0 / HR), fM = Math.exp(-h0 / HM);
  const phR = 0.0596831 * (1 + mu * mu);
  const g = 0.76, dd = 1 + g * g - 2 * g * mu;
  const phM = (1 - g * g) / (12.5663706 * dd * Math.sqrt(Math.max(dd, 1e-4)));
  const st = sunTransmitJS(sun[1]);
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const tR = BR[i] * HR * fR * am;
    const tM = BM * HM * fM * am;
    const tau = tR + tM * 1.1 + BO[i] * O3C * am;
    const T = Math.exp(-tau);
    const S = tR * phR + tM * phM;
    const ms = (1 - T) * [0.0055, 0.0080, 0.0125][i] * clamp(sun[1] + 0.12, 0, 1);
    out[i] = S / Math.max(tau, 1e-7) * (1 - T) * st[i] + ms;
  }
  return out;
}

/** 시각(0~24) → 태양 방향. 북위 37도 여름 근사. +Z = 북, +X = 동. */
function sunDirFromTod(tod) {
  const h = ((tod - 12) / 12) * Math.PI;
  const decl = 12 * Math.PI / 180, lat = 37 * Math.PI / 180;
  const sinEl = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(h);
  // 밤은 지원하지 않는다 — 태양을 지평선 위에 붙들어 둔다. 4도 밑으로
  // 내리면 파랑 투과율이 0.03 아래로 떨어져 화면이 사실상 단색 적갈색이
  // 되고 교전 가독성이 무너진다(실측).
  const el = Math.max(Math.asin(clamp(sinEl, -1, 1)), 0.075);
  const cosAz = clamp((Math.sin(decl) - Math.sin(el) * Math.sin(lat))
                      / Math.max(Math.cos(el) * Math.cos(lat), 1e-4), -1, 1);
  let az = Math.acos(cosAz);
  if (h > 0) az = -az;                       // 오후엔 서쪽
  return v3.norm([Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)]);
}

// ── 셰이더 컴파일 ──────────────────────────────────────────────────
function compile(gl, vsSrc, fsSrc) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s) || '';
      const m = /(\d+):(\d+)/.exec(log);
      let ctx = '';
      if (m) {
        const lines = src.split('\n');
        const ln = parseInt(m[2], 10);
        ctx = '\n' + lines.slice(Math.max(0, ln - 3), ln + 2)
          .map((t, i) => (Math.max(0, ln - 3) + i + 1) + '| ' + t).join('\n');
      }
      throw new Error(log + ctx);
    }
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

const NULL_U = { get: (t, k) => (k in t ? t[k] : null) };
const NULL_A = { get: (t, k) => (k in t ? t[k] : -1) };

// ── 패스별 GPU 계측 ────────────────────────────────────────────────
// 이 박스는 브라우저 패널이 숨겨지면 rAF 가 멈춰 렌더 검증이 불가능하다.
// 계측이 **사용자 화면에** 떠야만 이후 튜닝이 가능하므로 선택이 아니다.
class GpuTimer {
  constructor(gl, ext) {
    this.gl = gl; this.ext = ext;
    this.ms = {};
    this.pending = [];
    this.active = null;
    this.cpu0 = 0; this.cpuName = '';
  }
  begin(name) {
    if (this.active) this.end();
    this.cpuName = name;
    this.cpu0 = performance.now();
    if (!this.ext || this.pending.length > 12) return;
    const q = this.gl.createQuery ? this.gl.createQuery() : null;
    if (!q) return;
    try { this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q); this.active = { q, name }; }
    catch { this.active = null; }
  }
  end() {
    if (this.cpuName && !this.active) {
      // 타이머 확장이 없으면 CPU 제출 시간이라도 보여 준다
      this.ms[this.cpuName] = performance.now() - this.cpu0;
    }
    this.cpuName = '';
    if (!this.active) return;
    try { this.gl.endQuery(this.ext.TIME_ELAPSED_EXT); } catch { /* noop */ }
    this.pending.push(this.active);
    this.active = null;
  }
  poll() {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const e = this.pending[i];
      if (!gl.getQueryParameter(e.q, gl.QUERY_RESULT_AVAILABLE)) continue;
      // disjoint 플래그가 서면 그 프레임 값은 버린다
      if (!disjoint) this.ms[e.name] = gl.getQueryParameter(e.q, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(e.q);
      this.pending.splice(i, 1);
    }
  }
}

/** 지형 격자 메시 — 품질 '낮음' 전용 정적 경로. 되돌릴 수 있게 남겨 둔다. */
function buildTerrain(half, step) {
  const n = Math.floor((half * 2) / step) + 1;
  const pos = [], nrm = [], col = [], idx = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -half + i * step, z = -half + j * step;
      const y = terrainH(x, z);
      pos.push(x, y, z);
      const hx = terrainH(x + step, z) - terrainH(x - step, z);
      const hz = terrainH(x, z + step) - terrainH(x, z - step);
      const nx = -hx, ny = 2 * step, nz = -hz;
      const l = Math.hypot(nx, ny, nz);
      nrm.push(nx / l, ny / l, nz / l);
      const slope = 1 - ny / l;
      const n1 = Math.sin(x * 0.0031 + z * 0.0017) * 0.5
               + Math.sin(x * 0.011 - z * 0.009) * 0.3
               + Math.sin(x * 0.043 + z * 0.037) * 0.2;
      const v = n1 * 0.5;
      const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));
      let r, g, b;
      if (y < -60) { r = 0.02; g = 0.07; b = 0.16; }
      else if (y < 0) {
        const t = (y + 60) / 60;
        r = lerp(0.02, 0.10, t); g = lerp(0.07, 0.24, t); b = lerp(0.16, 0.33, t);
      } else if (y < 30) {
        r = 0.70 + v * 0.05; g = 0.65 + v * 0.05; b = 0.50 + v * 0.04;
      } else {
        const grass = [0.20 + v * 0.05, 0.34 + v * 0.06, 0.13 + v * 0.03];
        const pine = [0.13 + v * 0.03, 0.24 + v * 0.04, 0.11 + v * 0.02];
        const rock = [0.36 + v * 0.06, 0.33 + v * 0.05, 0.30 + v * 0.05];
        const snow = [0.88, 0.90, 0.93];
        const tv = Math.max(0, Math.min(1, (y - 60) / 220));
        let c0 = [lerp(grass[0], pine[0], tv), lerp(grass[1], pine[1], tv),
                  lerp(grass[2], pine[2], tv)];
        const tr = Math.max(0, Math.min(1, (slope - 0.18) / 0.22));
        c0 = [lerp(c0[0], rock[0], tr), lerp(c0[1], rock[1], tr), lerp(c0[2], rock[2], tr)];
        const ts = Math.max(0, Math.min(1, (y - 360 + v * 60) / 120)) * (1 - tr * 0.6);
        r = lerp(c0[0], snow[0], ts); g = lerp(c0[1], snow[1], ts); b = lerp(c0[2], snow[2], ts);
      }
      col.push(r, g, b);
    }
  }
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  return { pos, nrm, col, idx, verts: n * n };
}

/** 품질 '낮음' 전용 저폴리 기체(35 삼각형). 회귀 안전판. */
function buildJetLegacy() {
  const P = [], N = [], C = [];
  const tri = (a, b, c, col) => {
    const u = v3.sub(b, a), v = v3.sub(c, a);
    const n = v3.norm(v3.cross(u, v));
    for (const p of [a, b, c]) { P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); C.push(col[0], col[1], col[2]); }
  };
  const body = [0.42, 0.45, 0.50], wing = [0.32, 0.35, 0.40], glass = [0.35, 0.62, 0.85];
  const nose = [0, 0, 9.5];
  const f = [[0.9, 0.5, 4.5], [0.9, -0.6, 4.5], [-0.9, -0.6, 4.5], [-0.9, 0.5, 4.5]];
  const r = [[1.1, 0.7, -3.5], [1.1, -0.8, -3.5], [-1.1, -0.8, -3.5], [-1.1, 0.7, -3.5]];
  const tail = [[0.7, 0.4, -6.5], [0.7, -0.5, -6.5], [-0.7, -0.5, -6.5], [-0.7, 0.4, -6.5]];
  for (let i = 0; i < 4; i++) {
    const a = f[i], b = f[(i + 1) % 4];
    tri(nose, a, b, body);
    tri(a, r[i], r[(i + 1) % 4], body);
    tri(a, r[(i + 1) % 4], b, body);
    tri(r[i], tail[i], tail[(i + 1) % 4], body);
    tri(r[i], tail[(i + 1) % 4], r[(i + 1) % 4], body);
  }
  const wl = [[0.9, 0.1, 2.2], [6.2, 0.0, -3.0], [0.9, 0.1, -3.6]];
  const wr = [[-0.9, 0.1, 2.2], [-0.9, 0.1, -3.6], [-6.2, 0.0, -3.0]];
  tri(wl[0], wl[1], wl[2], wing); tri(wl[0], wl[2], wl[1], wing);
  tri(wr[0], wr[1], wr[2], wing); tri(wr[0], wr[2], wr[1], wing);
  const hl = [[0.7, 0.1, -4.6], [3.2, 0.0, -6.6], [0.7, 0.1, -6.8]];
  const hr = [[-0.7, 0.1, -4.6], [-0.7, 0.1, -6.8], [-3.2, 0.0, -6.6]];
  tri(hl[0], hl[1], hl[2], wing); tri(hl[0], hl[2], hl[1], wing);
  tri(hr[0], hr[1], hr[2], wing); tri(hr[0], hr[2], hr[1], wing);
  for (const s of [1, -1]) {
    const a = [0.8 * s, 0.6, -3.4], b = [1.0 * s, 3.4, -6.2], c = [0.8 * s, 0.6, -6.6];
    tri(a, b, c, wing); tri(a, c, b, wing);
  }
  const c1 = [0, 1.05, 4.4], c2 = [0.72, 0.5, 3.0], c3 = [-0.72, 0.5, 3.0], c4 = [0, 0.8, 0.6];
  tri(c1, c2, c4, glass); tri(c1, c4, c3, glass); tri(c1, c3, c2, glass);
  return { pos: P, nrm: N, col: C, count: P.length / 3 };
}

function buildMissileLegacy() {
  const P = [], N = [], C = [];
  const tri = (a, b, c, col) => {
    const u = v3.sub(b, a), v = v3.sub(c, a);
    const n = v3.norm(v3.cross(u, v));
    for (const p of [a, b, c]) { P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); C.push(col[0], col[1], col[2]); }
  };
  const col = [0.82, 0.82, 0.86];
  // 반경은 PBR 미사일과 같은 실물 치수여야 한다 — 그래야 drawSolidLegacy 가
  // 같은 mslRadiusK(픽셀 바닥) 를 그대로 쓸 수 있다. 예전 0.14 는 2.2배 비만.
  const nose = [0, 0, 1.6], seg = 6, rad = MSL_DIA * 0.5;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p0 = [Math.cos(a0) * rad, Math.sin(a0) * rad, 0.9];
    const p1 = [Math.cos(a1) * rad, Math.sin(a1) * rad, 0.9];
    const q0 = [Math.cos(a0) * rad, Math.sin(a0) * rad, -1.4];
    const q1 = [Math.cos(a1) * rad, Math.sin(a1) * rad, -1.4];
    tri(nose, p0, p1, col);
    tri(p0, q0, q1, col); tri(p0, q1, p1, col);
  }
  for (const s of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const a = [s[0] * rad, s[1] * rad, -0.6], b = [s[0] * 0.175, s[1] * 0.175, -1.4],
          c = [s[0] * rad, s[1] * rad, -1.4];
    tri(a, b, c, [0.7, 0.7, 0.74]); tri(a, c, b, [0.7, 0.7, 0.74]);
  }
  return { pos: P, nrm: N, col: C, count: P.length / 3 };
}

export class Scene {
  constructor(canvas, world, settings) {
    this.cv = canvas;
    this.world = world;
    this.set = settings;
    this.fps = 60;
    this._frames = 0;
    this._fpsT = performance.now();
    // 기본은 3인칭. 내 기체가 보여야 기동이 눈에 들어온다.
    // **항상 3인칭으로 시작한다.** 예전에는 저장해 두었다가 복구했는데,
    // V 를 한 번 잘못 누르면 그 뒤로 켤 때마다 조종석 안에서 시작했다.
    // 조종석 메시는 아직 상자 몇 개짜리 자리표시라, 사용자는 그걸 보고
    // '게임이 옛날 버전으로 돌아갔다'고 판단했다(실제로 그렇게 신고했다).
    // 사용자가 요구한 것은 3인칭이다. 한 판 안에서 V 로 바꾸는 것은 그대로
    // 되고, 다음에 켤 때만 3인칭으로 돌아온다.
    this.view = 'chase';
    this.trails = new Map();
    this.progFail = new Set();
    this.ok = false;
    this.showPerf = false;
    this.deg = 0;
    this._ft = [];
    this._degT = 0;
    this.drawCalls = 0;
    this.wTime = 0;
    this.flash = 0;
    try { this.init(); } catch (e) { this.error = String(e); }
  }

  // ── 초기화 ──────────────────────────────────────────────────────
  init() {
    const opts = {
      antialias: true, depth: true, alpha: false, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: false,
    };
    const gl = this.gl = this.cv.getContext('webgl2', opts) || this.cv.getContext('webgl', opts);
    if (!gl) throw new Error('WebGL 을 사용할 수 없습니다');
    const gl2 = this.gl2 = !!(self.WebGL2RenderingContext && gl instanceof WebGL2RenderingContext);

    // ── 확장 프로브를 한 곳에 모은다 ──────────────────────────────
    const ext = (n) => gl.getExtension(n);
    const timerExt = gl2 ? ext('EXT_disjoint_timer_query_webgl2') : ext('EXT_disjoint_timer_query');
    this.caps = {
      gl2,
      elementIndexUint: gl2 || !!ext('OES_element_index_uint'),
      colorHalf: gl2 && !!(ext('EXT_color_buffer_half_float') || ext('EXT_color_buffer_float')),
      depthTexture: gl2 || !!ext('WEBGL_depth_texture'),
      instanced: gl2 ? true : ext('ANGLE_instanced_arrays'),
      // WebGL2 컨텍스트에서 ESSL1 셰이더는 도함수를 못 쓴다(확장 이름 자체가
      // 노출되지 않는다). WebGL1 + 확장일 때만 켠다 — 셰이더에는 거리 기반
      // 폴백이 항상 들어 있다.
      deriv: !gl2 && !!ext('OES_standard_derivatives'),
      timer: timerExt,
      depthBits: gl.getParameter(gl.DEPTH_BITS),
    };
    this.caps.softParticles = gl2 && this.caps.colorHalf;
    this.inst = gl2 ? null : this.caps.instanced;   // WebGL1 은 확장 객체로 호출

    // 24비트 깊이를 못 받는 기기는 far 를 줄여 정밀도를 벌충한다
    this.far = this.caps.depthBits >= 24 ? 40000 : 20000;
    // 3인칭 카메라를 12.5m 까지 당기면서 기수(z=+10.85m)가 1.7m 앞에 온다.
    // 근평면 4m 로는 기수가 잘려 나가므로 1.0m 로 내렸다.
    //
    // 근평면을 내리면 깊이 정밀도가 나빠진다 — far/near 비가 곧 정밀도다.
    // 90km 를 그대로 두면 비가 9만이 되어 먼 지형에 z-파이팅이 난다.
    // 전장 반경이 4.5km, 스냅샷 시야가 14km 라 90km 는 애초에 과했다.
    // 40km 로 줄이면 비가 4만이 되어 24비트 깊이로 충분하다.
    this.near = 1.0;

    this.maxAttribs = Math.min(16, gl.getParameter(gl.MAX_VERTEX_ATTRIBS) || 16);
    this._attrMask = 0;    // GL 초기 상태 = 전부 꺼짐
    this.timer = new GpuTimer(gl, timerExt);
    this.q = this.resolveQuality();

    // 후처리를 먼저 만든다 — 씬 셰이더의 #define(DIRECT_OUT / HAS_SOFT)이
    // 후처리 가용 여부에 따라 갈리기 때문이다.
    this.post = new Post(gl, this.caps, (n, vs, fs) => this.mkProgram(n, vs, fs));
    this.usePost = !!(this.post && this.post.ok) && this.q.post;

    // ── 프로그램 ─────────────────────────────────────────────────
    this.buildPrograms();
    // solid/line/sky 세 기본 프로그램이 전부 살아 있어야만 ok.
    // 나머지는 실패해도 그 기능만 꺼지고 게임은 계속 돈다.
    this.ok = !!(this.progSolidL && this.progLine && this.progSkyL);
    if (!this.ok) throw new Error('기본 셰이더 컴파일 실패: ' + [...this.progFail].join(', '));

    const mkBuf = (data, type = gl.ARRAY_BUFFER) => {
      const b = gl.createBuffer();
      gl.bindBuffer(type, b);
      gl.bufferData(type, data, gl.STATIC_DRAW);
      return b;
    };
    this.mkBuf = mkBuf;

    // 레거시 정적 지형은 **처음 쓸 때** 만든다. 부팅에서 terrainH 를 80만 번
    // 부르던 것이 첫 화면이 늦는 가장 큰 이유였고, 클립맵 경로에서는 한 번도
    // 필요하지 않다.
    this.terrain = null;

    const jl = buildJetLegacy();
    this.jetL = { pos: mkBuf(new Float32Array(jl.pos)), nrm: mkBuf(new Float32Array(jl.nrm)),
                  col: mkBuf(new Float32Array(jl.col)), count: jl.count };
    const ml = buildMissileLegacy();
    this.mslL = { pos: mkBuf(new Float32Array(ml.pos)), nrm: mkBuf(new Float32Array(ml.nrm)),
                  col: mkBuf(new Float32Array(ml.col)), count: ml.count };

    // ── 신 메시 ──────────────────────────────────────────────────
    // skin(vec2 ao,part)은 **네 메시 전부**가 채워야 한다. buildJetGlow /
    // buildAfterburner / buildMissile / buildCockpit 이 Mesh 를 공유하므로
    // 한 곳이라도 비면 undefined 가 Float32Array 에서 NaN 이 되고, NaN 정점은
    // 삼각형을 통째로 사라지게 한다. jet.js Mesh.vert 가 기본 [1, 0] 을 넣는다.
    // aFlex(조종면 구동)도 **같은 이유로 전 메시가 채운다** — 기본값 0.
    const pack = (m) => ({
      pos: mkBuf(new Float32Array(m.pos)), nrm: mkBuf(new Float32Array(m.nrm)),
      col: mkBuf(new Float32Array(m.col)), mr: mkBuf(new Float32Array(m.mr)),
      skin: mkBuf(new Float32Array(m.skin)), flex: mkBuf(new Float32Array(m.flex)),
      count: m.count,
    });
    this.jet = pack(buildJet());
    this.jetGlow = pack(buildJetGlow());
    this.ab = pack(buildAfterburner());
    this.exhaust = pack(buildExhaust());
    this.msl = pack(buildMissile());
    this.cockpit = pack(buildCockpit());
    // 조종면 편각의 1차 지연 상태(기체별). 렌더 전용이고 pl.id 로만 갈리므로
    // 봇에도 사람과 같은 규칙이 걸린다.
    this._defl = new Map();

    this.sky = mkBuf(new Float32Array([-1, -1, 3, -1, -1, 3]));

    // ── 선분(레거시 이펙트) — 용량을 한 번만 잡고 이후 bufferSubData ──
    this.lineCap = 24000;
    this.linePos = new Float32Array(this.lineCap * 3);
    this.lineCol = new Float32Array(this.lineCap * 3);
    this.lineAlpha = new Float32Array(this.lineCap);
    this.lineBuf = {
      pos: mkBuf(this.linePos, gl.ARRAY_BUFFER),
      col: mkBuf(this.lineCol, gl.ARRAY_BUFFER),
      alpha: mkBuf(this.lineAlpha, gl.ARRAY_BUFFER),
    };
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf.pos);
    gl.bufferData(gl.ARRAY_BUFFER, this.linePos.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf.col);
    gl.bufferData(gl.ARRAY_BUFFER, this.lineCol.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf.alpha);
    gl.bufferData(gl.ARRAY_BUFFER, this.lineAlpha.byteLength, gl.DYNAMIC_DRAW);

    // ── 클립맵 · 바다 · 파티클 · 후처리 ──────────────────────────
    try { this.clip = new Clipmap(gl); } catch (e) { console.error('clipmap', e); this.clip = null; }
    this.water = (this.progWater && this.clip) ? new Water(gl, this.progWater, this.clip) : null;

    this.fx = new Fx(this.q.fxCap || 512);
    this.quad = mkBuf(new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5,
                                        -0.5, -0.5, 0.5, 0.5, -0.5, 0.5]));
    // 품질을 올렸을 때 다시 잡지 않아도 되도록 최대치로 한 번만 잡는다
    this.instCap = 4000;
    this.instBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.instCap * 2 * 13 * 4, gl.DYNAMIC_DRAW);
    try { this.atlas = uploadAtlas(gl, buildAtlas()); } catch (e) { this.atlas = null; }

    this.bakeTex = whiteBake(gl);
    this.bakeHalf = 30000;
    this.bakeReady = false;

    // ── 태양 · 대기 기본값 ───────────────────────────────────────
    // 품질 '낮음' 은 예전 하드코딩 태양을 그대로 쓴다(회귀 안전판).
    this.sunLegacy = new Float32Array(v3.norm([0.42, 0.72, 0.35]));
    this.setSky(14.5, 0);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    // 이 게임의 좌표계는 forward=+Z / right=+X / up=+Y (왼손 시점 규약)이라
    // 뷰 변환에 반사가 한 번 들어간다. 화면 방향은 올바르지만 삼각형 감김이
    // 뒤집히므로 앞면 기준을 CW 로 바꾼다.
    gl.frontFace(gl.CW);
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resolveQuality() {
    const key = ({ '낮음': 'low', '보통': 'med', '높음': 'high' })[this.set?.gfx] || this.set?.gfx || 'med';
    const base = PRESETS[key] || PRESETS.med;
    const d = DEGRADE[Math.min(this.deg, DEGRADE.length - 1)];
    const q = Object.assign({}, base, base.modern ? d : {});
    q.name = key;
    q.renderScale = (base.modern ? d.renderScale : 1) * (this.set?.renderScale ?? 1);
    if (!base.modern) { q.bloomHalf = false; }
    return q;
  }

  mkProgram(name, vs, fs, fallback) {
    const gl = this.gl;
    try {
      const p = compile(gl, vs, fs);
      const u = {}, a = {};
      const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < nu; i++) {
        const inf = gl.getActiveUniform(p, i);
        u[inf.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, inf.name);
      }
      const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
      let mask = 0;
      for (let i = 0; i < na; i++) {
        const inf = gl.getActiveAttrib(p, i);
        const loc = gl.getAttribLocation(p, inf.name);
        a[inf.name] = loc;
        if (loc >= 0) mask |= (1 << loc);
      }
      return { p, name, mask, u: new Proxy(u, NULL_U), a: new Proxy(a, NULL_A) };
    } catch (e) {
      // 하나가 실패해도 화면 전체가 검게 죽지 않는다 — 그 기능만 꺼진다.
      console.error('[shader 실패] ' + name + '\n' + (e && e.message ? e.message : e));
      this.progFail.add(name);
      return fallback || null;
    }
  }

  buildPrograms() {
    const c = this.caps;
    const vsPre = SH.prelude({ fs: false });
    const fsHi = SH.prelude({ fs: true, high: true, deriv: c.deriv, gl2: c.gl2,
                              defines: this.defs() });
    const fsMed = SH.prelude({ fs: true, high: false, defines: this.defs() });
    const M = (n, vs, fs) => this.mkProgram(n, vs, fs);

    // 기본 3종(레거시) — 이게 살아 있어야 게임이 돈다
    this.progSolidL = M('legacy.solid', vsPre + SH.VS_LEGACY, fsMed + SH.FS_LEGACY);
    this.progLine = M('line', vsPre + SH.VS_LINE, fsMed + SH.FS_LINE);
    this.progSkyL = M('legacy.sky', vsPre + SH.VS_SKY_LEGACY, fsMed + SH.FS_SKY_LEGACY);

    // 신규 프로그램은 전부 개별 try/catch. 실패하면 그 패스만 빠진다.
    this.progSky = M('sky', vsPre + SH.VS_SKY, fsHi + SH.FS_SKY);
    this.progTerrain = M('terrain', vsPre + SH.VS_TERRAIN, fsHi + SH.FS_TERRAIN);
    this.progWater = M('water', vsPre + SH.VS_WATER, fsHi + SH.FS_WATER);
    // PBR 은 **2단 컴파일**한다. 새 정점 AO 경로(#define SKIN)가 어떤 이유로든
    // 컴파일에 실패하면 기체만 예전 모습(ao=1.0)으로 돌아가고 하늘·지형·물은
    // 전부 산다 — frame() 의 modern 판정이 progPbr 하나에 걸려 있어서,
    // 린트가 없는 이 환경에서는 오타 하나가 '그래픽 전체 붕괴'로 보인다.
    // 1단이 성공하면 2단은 아예 컴파일되지 않으므로 부팅 비용은 0 이다.
    //
    // 정밀도를 fsMed → **fsHi** 로 올렸다. 기체만 mediump 이고 하늘·지형·물은
    // 이미 highp 였다. 패널라인 폭이 화면 기준 1.4px = vObj 기준 1.5cm 까지
    // 내려가는데, half float 은 vObj 최대 10.85m 에서 ULP 가 약 4mm 라 선
    // 가장자리가 계단으로 끊긴다. prelude 가 GL_FRAGMENT_PRECISION_HIGH 로
    // 감싸므로 highp 가 없는 기기에서는 자동으로 mediump 로 되돌아간다.
    const vsSkin = SH.prelude({ fs: false, defines: ['SKIN 1'] });
    const fsSkin = SH.prelude({ fs: true, high: true, deriv: c.deriv, gl2: c.gl2,
                                defines: this.defs().concat(['SKIN 1']) });
    this.progPbr = this.mkProgram('pbr', vsSkin + SH.VS_PBR, fsSkin + SH.FS_PBR,
                                  null)
                || M('pbr.noskin', vsPre + SH.VS_PBR, fsHi + SH.FS_PBR);
    this.progGlow = M('glow', vsPre + SH.VS_GLOW, fsMed + SH.FS_GLOW);
    this.progDecal = M('decal', vsPre + SH.VS_DECAL, fsMed + SH.FS_DECAL);
    const fxDefs = this.defs().concat(this.caps.softParticles ? ['HAS_SOFT 1'] : []);
    this.progFx = M('fx', vsPre + SH.VS_FX,
                    SH.prelude({ fs: true, high: false, defines: fxDefs }) + SH.FS_FX);
  }

  /** 후처리를 못 쓰는 기기에서는 씬 셰이더가 기본 프레임버퍼에 직접 그리고
   *  톤매핑까지 한다. 톤 커브가 두 벌이 되지 않도록 같은 식(TONE_GLSL)을
   *  공유한다. 하드웨어 능력이 아니라 **후처리가 실제로 섰는지**로 판단해야
   *  한다 — 프로그램 링크 실패까지 덮어야 하기 때문이다. */
  defs() {
    this.directOut = !(this.post && this.post.ok);
    return this.directOut ? ['DIRECT_OUT 1'] : [];
  }

  // ── 하늘/태양 설정 (방 입장 시 1회) ────────────────────────────
  setSky(tod, wx) {
    this.tod = tod;
    this.wx = wx | 0;
    this.sun = sunDirFromTod(tod);
    const st = sunTransmitJS(this.sun[1]);
    this.sunColBase = st;
    // 기상: 0=맑음, 1=흐림, 2=박무
    this.cloudAmt = [0.35, 0.85, 0.45][this.wx] ?? 0.35;
    this.mieG = [0.76, 0.70, 0.62][this.wx] ?? 0.76;
    this.mieAmt = [1.0, 1.7, 3.2][this.wx] ?? 1.0;
    this.wind = [0.62, 0.78];

    // 2밴드 앰비언트: 하늘을 12방향 평가해 압축한다. 태양 방향이 바뀔 때만
    // (= 방 입장 시 1회) 돈다. 노을에 기체 아랫면이 주황빛으로 물드는 것 —
    // 비행 게임에서 사실감을 가장 강하게 만드는 단일 요소다.
    const up = [0, 0, 0], dn = [0, 0, 0];
    let nu = 0, nd = 0;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const el = (i % 3) === 0 ? 0.85 : (i % 3) === 1 ? 0.45 : 0.12;
      const d = v3.norm([Math.cos(a) * (1 - el), el, Math.sin(a) * (1 - el)]);
      const r = skyRadianceJS(d, this.sun, 0);
      if (el > 0.4) { for (let k = 0; k < 3; k++) up[k] += r[k]; nu++; }
      else { for (let k = 0; k < 3; k++) dn[k] += r[k]; nd++; }
    }
    const AVG_GROUND = [0.16, 0.17, 0.13];
    this.ambSky = up.map((v) => v / Math.max(nu, 1) * Math.PI);
    this.ambGnd = dn.map((v, k) => v / Math.max(nd, 1) * Math.PI * 0.55
      + AVG_GROUND[k] * st[k] * Math.max(this.sun[1], 0) * 0.15);

    this.sun3 = new Float32Array(this.sun);
    this.ambSky3 = new Float32Array(this.ambSky);
    this.ambGnd3 = new Float32Array(this.ambGnd);
    this.sunCol3 = new Float32Array(st);
    this.camPos3 = new Float32Array(3);
    this.startBake();
  }

  /** 방에 들어가면서 서버 CFG 의 tod/wx 를 적용한다(없으면 기본값 유지). */
  applyCfg(cfg) {
    if (!cfg) return;
    const tod = cfg.tod === undefined ? 14.5 : +cfg.tod;
    const wx = cfg.wx === undefined ? 0 : (cfg.wx | 0);
    if (tod !== this.tod || wx !== this.wx) this.setSky(tod, wx);
  }

  // ── 그림자 굽기 ────────────────────────────────────────────────
  startBake() {
    if (!this.q || !this.q.bake || !this.gl) return;
    if (this._bakeSun === this.sun.join(',')) return;
    this._bakeSun = this.sun.join(',');
    try {
      if (this.worker) this.worker.terminate();
      this.worker = new Worker('/js/gfx/bake.worker.js', { type: 'module' });
      this.worker.onmessage = (e) => {
        uploadBake(this.gl, this.bakeTex, e.data.buf, e.data.size);
        this.bakeReady = true;
        this.bakeMs = e.data.ms;
      };
      this.worker.onerror = (e) => { console.error('bake worker', e.message); this.worker = null; };
      this.worker.postMessage({
        half: this.bakeHalf, size: this.q.bakeSize, aoSize: this.q.aoSize, sun: this.sun,
      });
    } catch (e) {
      // 모듈 Worker 미지원 — 균일 조명으로 계속 간다(로딩 프리즈 금지)
      console.warn('bake worker 사용 불가:', e.message);
    }
  }

  // ── 화면 크기 ──────────────────────────────────────────────────
  resize() {
    // 렌더 스케일은 HUD 와 분리한다. 픽셀 수가 후처리 비용에 선형이라
    // 이게 가장 강력한 레버다. HUD 는 hud.js 에서 네이티브 DPR 을 쓴다.
    // DPR 상한을 1.0 으로 둔다. 1.25 는 픽셀 수가 1.56배라 후처리·지형
    // 셰이딩 비용이 그대로 1.56배가 되는데, 화면에서 얻는 선명도는 그만큼
    // 체감되지 않는다. 렉을 없애는 가장 싼 레버가 이것이다.
    const rs = clamp(this.q?.renderScale ?? 1, 0.5, 1);
    const dpr = Math.min((devicePixelRatio || 1) * rs,
                         this.set?.hidpi ? 1.25 : 1.0);
    this.w = Math.max(1, innerWidth);
    this.h = Math.max(1, innerHeight);
    this.pw = Math.max(1, Math.round(this.w * dpr));
    this.ph = Math.max(1, Math.round(this.h * dpr));
    this.cv.width = this.pw;
    this.cv.height = this.ph;
    if (this.gl) this.gl.viewport(0, 0, this.pw, this.ph);
    if (this.usePost) this.post.resize(this.pw, this.ph);
  }

  /** 설정에서 품질/렌더스케일이 바뀌었을 때 */
  refreshQuality() {
    const prev = this.q;
    this.q = this.resolveQuality();
    if (this.fx && prev.fxCap !== this.q.fxCap) this.fx.setCap(this.q.fxCap || 512);
    if (this.q.bake && !this.bakeReady) this.startBake();
    this.usePost = !!(this.post && this.post.ok) && this.q.post;
    this.resize();
  }

  toggleView() {
    this.view = this.view === 'cockpit' ? 'chase' : 'cockpit';
    // 저장하지 않는다 — 위 생성자의 주석 참고.
  }
  togglePerf() { this.showPerf = !this.showPerf; }

  /**
   * 카메라는 **상태가 없다**. 조준 방향은 input 이 소유하고(this.aim 에
   * main 이 매 프레임 넣어 준다) 카메라는 그 값을 읽기만 한다 — 카메라가
   * 기수를 쫓고 기수가 카메라를 쫓던 폐루프를 한 방향으로 끊는다.
   */
  camera(me) {
    if (!me) return { q: [1, 0, 0, 0], eye: [0, 4000, 0] };
    const W = this.world;
    this.spectate = null;
    if (W.srv && !W.srv.al && W.srv.kb) {
      const killer = W.view().find((p) => p.alive && W.name(p.id) === W.srv.kb);
      if (killer) {
        this.spectate = killer;
        const f = quat.fwd(killer.q), u = quat.up(killer.q);
        const ks = W.scaleOf(killer.id);   // 관전 거리도 그 기체 크기를 따른다
        return { q: killer.q,
                 eye: v3.add(killer.pos, v3.add(v3.mul(f, -40 * ks), v3.mul(u, 11 * ks))) };
      }
    }
    const mf = quat.fwd(me.q);
    const aim = this.aim || mf;
    // 최단호 스윙은 기수축 둘레 비틀림이 0 이다. 따라서 화면의 기울기는
    // q_plane 안의 bnk(= A·D 가 만든 값) 하나에서만 온다 — 마우스로는 절대
    // 안 기운다. 이건 튜닝이 아니라 기하학적 항등식이다.
    const q = quat.mul(quat.swing(mf, aim), me.q);

    // 방사 블러는 속도뿐 아니라 카메라 각속도에도 비례한다.
    // 이제 마우스 델타가 아니라 실제 카메라 정면의 각변화로 잰다.
    const cf = quat.fwd(q);
    const prev = this._camFwd || cf;
    const dAng = Math.acos(clamp(v3.dot(prev, cf), -1, 1));
    this._camFwd = cf;
    const rate = dAng / Math.max(this._dt || 1 / 60, 1e-3);
    this._lookRate = (this._lookRate || 0) * 0.85 + rate * 0.15;

    // 기체 좌표계 값은 전부 기종 배율을 먹여야 한다. 안 먹이면 falcon(0.824배)
    // 에서 콕핏 눈이 캐노피 보우 프레임(4.95 → 4.08) 앞으로 튀어나온다.
    const ms = W.scaleOf(W.myId);
    if (this.view === 'cockpit') {
      // 콕핏 시점은 물리적 위치다 — 기체축을 쓴다.
      const f = mf, u = quat.up(me.q);
      return { q, eye: v3.add(me.pos, v3.add(v3.mul(f, 4.2 * ms), v3.mul(u, 1.3 * ms))) };
    }
    // 외부 시점은 **카메라 기저**로 잡는다. 기체 up 을 따라가면 조준점과
    // 기수가 벌어질 때 기체가 화면에서 미끄러져 나간다. 카메라 기저로 잡으면
    // 리시(최대 55도)와 함께 기체가 항상 화면 안에 프레이밍된다.
    //
    // 62m 는 전장 19m 짜리 기체를 화면에서 너무 작게 만든다. 기체를 보라고
    // 3인칭을 기본으로 삼았으니 거리를 좁힌다. 속도가 붙으면 살짝 뒤로
    // 물러나 속도감을 준다(가속할 때 카메라가 뒤로 밀리는 느낌).
    // 34m 도 아직 작았다. 23m 로 더 당긴다 — 크기는 거리에 반비례하므로
    // 처음 62m 기준으로는 2.7배다. 전장 19m 기체가 화각 75도에서 화면
    // 가로의 절반 남짓을 차지한다. 기수가 z=+9.6m 까지 뻗지만 근평면이
    // 4m 라 파고들지 않는다.
    //
    // 카메라 거리에도 같은 배율을 곱해 **세 기종의 화면 점유율을 오늘과
    // 동일하게** 유지한다. 현실적으로는 카메라를 고정하고 F-16 이 작게 보이는
    // 게 맞지만, 3인칭을 기본으로 삼은 목적 자체가 '기체를 보라고'인데
    // falcon 만 18% 작아지면 기종 선택이 시각 품질 페널티가 된다. 상대 현실감은
    // 남는다 — 적기는 서로에 대해 실제 비율로 그려지고 지형 대비 크기도 다르다.
    // 23m 에서 16m 로 더 당긴다. 크기는 거리에 반비례하니 1.44배 커진다.
    // 동시에 화각을 넓혀(아래 fovBase) 시야도 같이 늘렸다 — 당기기만 하면
    // 기체는 커지지만 주변이 안 보여 교전이 안 된다. 둘을 같이 움직여야
    // '크게 보이면서 더 많이 보이는' 상태가 된다.
    //
    // 위 오프셋도 6.2 → 7.4 로 올렸다. 기체가 화면 가로의 절반을 넘게
    // 차지하므로, 살짝 내려다봐서 화면 아래쪽에 앉혀야 정면 시야가 산다.
    // 거리는 `ms`(기종 메시 배율)에 비례한다. 서버에서 JET_SCALE 로 기체를
    // 통째로 키우면 이 값도 같이 커지므로, **내 기체의 화면 점유율은 그대로**
    // 유지되고 월드에서 같은 거리에 있는 적기만 그만큼 크게 보인다.
    // 사용자가 요구한 "상대는 커 보이고 내 비행기는 비슷해 보이게" 가 이것이다.
    const spd = W.srv ? Math.hypot(W.srv.vx, W.srv.vy, W.srv.vz) : 0;
    const back = (17.5 + clamp((spd - 400) / 1000, 0, 1) * 5) * ms;
    const cu = quat.up(q);
    return { q, eye: v3.add(me.pos, v3.add(v3.mul(cf, -back), v3.mul(cu, 8.0 * ms))) };
  }

  // ── 프레임 ─────────────────────────────────────────────────────
  frame(dt) {
    if (!this.ok) return;
    const gl = this.gl, W = this.world;
    this._frames++;
    const now = performance.now();
    if (now - this._fpsT > 700) {
      this.fps = Math.round(this._frames / ((now - this._fpsT) / 1000));
      this._frames = 0; this._fpsT = now;
    }
    this.adapt(dt);
    this.timer.poll();
    this.drawCalls = 0;

    const me = W.me;
    this._dt = dt;
    const cam = this.camera(me);
    this.camEye = cam.eye;
    this.camQ = cam.q;
    this.camPos3[0] = cam.eye[0]; this.camPos3[1] = cam.eye[1]; this.camPos3[2] = cam.eye[2];

    const spd = W.srv ? W.srv.sp : 0;
    const boost = fovBoost(spd);
    this.fov = (this.fov || 75) + (((this.set?.fov ?? 75) + boost) - (this.fov || 75))
             * Math.min(1, dt * 3);
    const proj = m4.perspective(this.fov * Math.PI / 180, this.w / this.h, this.near, this.far);
    const view = m4.view(cam.q, cam.eye);
    this.proj = proj; this.viewM = view;
    this.vp = m4.mul(proj, view);

    // 모든 클라이언트가 같은 그림을 보도록 시간 원본은 스냅샷 tick 이다.
    // 로컬 시간을 쓰면 관전·킬캠에서 구름 그림자가 서로 어긋난다.
    if (W.tick !== undefined) this.wTime = W.tick / (W.cfg?.tickHz || 50);
    else this.wTime += dt;

    // 구름층 안 / 수중
    const cy = cam.eye[1];
    this.cloudIn = this.q.clouds
      ? clamp(Math.min(cy - 2150, 3050 - cy) / 140, 0, 1) * Math.min(1, this.cloudAmt * 1.6) : 0;
    this.under = clamp(-cy / 6, 0, 1);
    const dim = 1 - 0.8 * this.cloudIn;
    for (let i = 0; i < 3; i++) this.sunCol3[i] = this.sunColBase[i] * dim;
    this.flash = Math.max(0, this.flash - dt * 9);

    // FBO 는 런타임에 불완전해질 수 있다. 그때 신 셰이더(선형 출력)를 기본
    // 프레임버퍼에 그대로 쏟으면 화면이 하얗게 탄다 — 레거시로 되돌린다.
    this.usePost = !!(this.post && this.post.ok) && this.q.post;
    const modern = this.q.modern && this.progSky && this.progTerrain && this.progPbr
                && (this.usePost || this.directOut);
    if (modern && this.q.particles && this.fx) this.updateFx(dt);

    if (this.usePost && modern) this.post.begin();
    else gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.pw, this.ph);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.clearColor(0.55, 0.70, 0.88, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (modern) {
      this.timer.begin('sky'); this.drawSky(cam); this.timer.end();
      this.timer.begin('terrain'); this.drawTerrain(); this.timer.end();
      if (this.q.water && this.water) { this.timer.begin('water'); this.drawWater(); this.timer.end(); }
      this.timer.begin('solid'); this.drawSolidPbr(); this.timer.end();
      this.timer.begin('particles');
      if (this.q.particles) this.drawFx();
      else this.drawLines(proj, view, dt);
      this.timer.end();
      // 콕핏은 깊이를 비우므로 반드시 마지막이다(계측은 solid 에 포함하지 않는다)
      this.drawCockpit();
      if (this.usePost) {
        this.timer.begin('post');
        this.post.end(this.postParams(dt));
        this.timer.end();
        this.resetAttribs();   // post 가 정점 배열을 직접 건드렸다
      }
    } else {
      this.timer.begin('sky'); this.drawSkyLegacy(proj, cam); this.timer.end();
      this.timer.begin('terrain'); this.drawSolidLegacy(proj, view); this.timer.end();
      this.timer.begin('particles'); this.drawLines(proj, view, dt); this.timer.end();
    }
    this.timer.end();
  }

  /** 프레임 시간 95퍼센타일로 품질을 히스테리시스 조정한다.
   *
   * 목표는 60fps(16.7ms)다. 예전에는 22ms(=45fps)를 넘어야 반응했고 한 번에
   * 한 칸씩만 내려가서, 무거운 기기는 1초에 한 칸씩 여섯 번을 내려가는 동안
   * 계속 끊겼다. 이제 (1) 30프레임이면 판단하고 (2) 많이 느리면 한 번에 여러
   * 칸을 건너뛴다. 렉을 '천천히 줄이는' 게 아니라 '빨리 끝내는' 쪽이다. */
  adapt(dt) {
    if (!(this.set?.adaptive ?? true) || !this.q.modern) return;
    // 시작 직후 30프레임은 버린다 — 셰이더 컴파일·텍스처 업로드로 튀는
    // 구간이라, 이걸 재고 강등하면 멀쩡한 기기가 저품질로 시작한다.
    if ((this._warm = (this._warm || 0) + 1) < 30) return;
    const a = this._ft;
    a.push(dt * 1000);
    if (a.length > 90) a.shift();
    if (a.length < 30) return;
    const s = a.slice().sort((x, y) => x - y);
    const p95 = s[Math.floor(s.length * 0.95)];
    this._degT += dt;
    // 자동으로는 AUTO_MAX_DEG 까지만 내려간다(그 아래는 외형이 무너진다).
    const last = Math.min(AUTO_MAX_DEG, DEGRADE.length - 1);
    // 18.5ms(54fps)는 너무 예민했다 — 60fps 근처에서 멀쩡히 돌던 기기가
    // 강등되고, 복구 조건(13ms=77fps)이 더 빡세서 영영 못 올라왔다.
    // 강등은 38fps 밑에서만, 복구는 60fps 만 넘으면.
    if (p95 > 26.0 && this.deg < last) {
      // 얼마나 느린지에 비례해 건너뛴다 — 40ms(25fps)면 세 칸을 한 번에.
      const jump = p95 > 40 ? 3 : (p95 > 26 ? 2 : 1);
      this.deg = Math.min(last, this.deg + jump);
      this._degT = 0; this.refreshQuality(); a.length = 0;
    // 복구 조건이 12.5ms(80fps)였다. 강등은 54fps 에서 걸리는데 복구는 80fps
    // 를 요구하니, 그 사이(54~80fps)에 있는 기기는 한 번 내려가면 영영 못
    // 올라온다. 60fps 만 넘으면 되돌린다.
    } else if (p95 < 16.5 && this.deg > 0 && this._degT > 2) {
      this.deg--; this._degT = 0; this.refreshQuality(); a.length = 0;
    }
  }

  postParams(dt) {
    const W = this.world;
    let center = [0.5, 0.5];
    if (W.srv && W.me) {
      const vel = [W.srv.vx, W.srv.vy, W.srv.vz];
      if (v3.len(vel) > 5) {
        const p = this.project(v3.add(W.me.pos, v3.mul(v3.norm(vel), 900)));
        if (p) center = [clamp(p[0] / this.w, -0.5, 1.5), clamp(1 - p[1] / this.h, -0.5, 1.5)];
      }
    }
    const spd = W.srv ? W.srv.sp : 0;
    // FOV 부스트와 같은 곡선을 쓴다 — 두 효과가 따로 놀지 않는다
    // ── 모션 블러를 전부 껐다 ──────────────────────────────────────
    // 사용자가 두 번 "흐리다" 고 했고, 화면을 보니 원인이 분명했다.
    // 이 곡선은 410 m/s 에서 이미 최대치인데 순항 속도가 830 이다.
    // 즉 **항상 최대 블러**가 걸려 있었다. '빠를 때만 흐려진다' 는 의도였지만
    // 이 게임에서 느린 순간이 없어서 그냥 상시 흐림이 된 것이다.
    // 거기에 회전 블러까지 겹쳐 돌릴 때마다 줄무늬가 쓸려 나갔다.
    //
    // 속도감은 화각 부스트(+26도)와 카메라 후퇴가 이미 맡고 있다.
    // 블러는 조준을 방해하는 대가로 얻는 게 없다.
    const sBlur = 0;
    const ang = 0;
    this.post.autoExp = true;
    return {
      exposure: BASE_EXPOSURE,
      bloom: 0.040,
      vignette: 0.30,
      grain: 0.006,
      blur: (sBlur * 0.055 + ang * 0.03),
      center,
      under: this.under,
      underTint: UNDER_TINT,
      time: this.wTime,
      dt,
      bloomHalf: !!this.q.bloomHalf,
    };
  }

  // ── 공용 유니폼 ────────────────────────────────────────────────
  setAtmo(pr) {
    const gl = this.gl, u = pr.u;
    gl.uniform3fv(u.uSun, this.sun3);
    gl.uniform3fv(u.uSunColor, this.sunCol3);
    gl.uniform3fv(u.uCamPos, this.camPos3);
    gl.uniform3fv(u.uAmbSky, this.ambSky3);
    gl.uniform3fv(u.uAmbGnd, this.ambGnd3);
    gl.uniform1f(u.uMieG, this.mieG);
    gl.uniform1f(u.uMieAmt, this.mieAmt);
    gl.uniform1f(u.uTime, this.wTime);
    gl.uniform2f(u.uWind, this.wind[0], this.wind[1]);
    gl.uniform1f(u.uCloudAmt, this.q.clouds ? this.cloudAmt : 0);
    gl.uniform1f(u.uCloudIn, this.cloudIn);
    gl.uniform1f(u.uOutExp, BASE_EXPOSURE);
  }

  /**
   * useProgram + 정점 배열 상태 동기화.
   *
   * 이전 프로그램이 켜 둔 정점 배열이 남아 있으면, 그게 더 작은 버퍼를 가리킨
   * 채로 큰 드로우(지형 4,225 정점)를 하다가 WebGL 이 INVALID_OPERATION 을
   * 내며 **드로우 전체를 건너뛴다**. 프로그램을 바꿀 때마다 반드시 맞춘다.
   */
  useProg(pr) {
    const gl = this.gl;
    gl.useProgram(pr.p);
    // **끄기만** 한다. 켜는 건 bindAttr 가 실제로 버퍼를 물릴 때만이다 —
    // 버퍼를 물리지 않은 채 켜진 배열이 하나라도 있으면 드로우가 통째로
    // INVALID_OPERATION 이 된다(파티클이 0개인 프레임에서 실제로 걸렸다).
    const drop = this._attrMask & ~pr.mask;
    if (drop) {
      for (let i = 0; i < this.maxAttribs; i++) {
        if ((drop >> i) & 1) gl.disableVertexAttribArray(i);
      }
      this._attrMask &= ~drop;
    }
  }

  /** 정점 배열을 전부 끄고 추적 상태를 진실과 맞춘다(후처리 뒤처리용). */
  resetAttribs() {
    const gl = this.gl;
    for (let i = 0; i < this.maxAttribs; i++) gl.disableVertexAttribArray(i);
    this._attrMask = 0;
  }

  bindAttr(pr, name, buf, size, stride, off) {
    const gl = this.gl;
    const a = pr.a[name];
    if (a < 0) return -1;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    if (!((this._attrMask >> a) & 1)) {
      gl.enableVertexAttribArray(a);
      this._attrMask |= (1 << a);
    }
    gl.vertexAttribPointer(a, size, gl.FLOAT, false, stride || 0, off || 0);
    return a;
  }

  // ── 하늘 ───────────────────────────────────────────────────────
  skyBasis(cam) {
    const r = quat.rot(cam.q, [1, 0, 0]), u = quat.rot(cam.q, [0, 1, 0]),
          f = quat.rot(cam.q, [0, 0, 1]);
    // **this.set.fov 가 아니라 this.fov** 다. 속도 부스트로 FOV 가 최대 +26도
    // 넓어질 때 하늘 광선 방향이 투영과 어긋나 하늘이 지형에 대해 미끄러진다.
    const fovy = (this.fov || 75) * Math.PI / 180;
    const ty = Math.tan(fovy / 2), tx = ty * (this.w / this.h);
    return new Float32Array([
      r[0] * tx, r[1] * tx, r[2] * tx, 0,
      u[0] * ty, u[1] * ty, u[2] * ty, 0,
      f[0], f[1], f[2], 0,
      0, 0, 0, 1]);
  }

  drawSky(cam) {
    const gl = this.gl, pr = this.progSky;
    if (!pr) return;
    this.useProg(pr);
    gl.depthMask(false);
    this.setAtmo(pr);
    gl.uniformMatrix4fv(pr.u.uInvVP, false, this.skyBasis(cam));
    this.bindAttr(pr, 'aXY', this.sky, 2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
    this.drawCalls++;
  }

  drawSkyLegacy(proj, cam) {
    const gl = this.gl, pr = this.progSkyL;
    this.useProg(pr);
    gl.depthMask(false);
    gl.uniformMatrix4fv(pr.u.uInvVP, false, this.skyBasis(cam));
    gl.uniform3fv(pr.u.uSun, this.sunLegacy);
    this.bindAttr(pr, 'aXY', this.sky, 2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
    this.drawCalls++;
  }

  // ── 지형 ───────────────────────────────────────────────────────
  drawTerrain() {
    const gl = this.gl, pr = this.progTerrain;
    if (!pr || !this.clip) return;
    this.useProg(pr);
    this.setAtmo(pr);
    gl.uniformMatrix4fv(pr.u.uProj, false, this.proj);
    gl.uniformMatrix4fv(pr.u.uView, false, this.viewM);
    gl.uniform1f(pr.u.uDetail, this.q.detail);
    gl.uniform1f(pr.u.uBakeHalf, this.bakeHalf);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.bakeTex);
    gl.uniform1i(pr.u.uBake, 0);
    this.bindAttr(pr, 'aGrid', this.clip.vGrid, 2);
    this.bindAttr(pr, 'aStitch', this.clip.vStitch, 1);
    for (const p of this.clip.patches(this.camEye, this.vp, false)) {
      gl.uniform2f(pr.u.uOrigin, p.ox, p.oz);
      gl.uniform1f(pr.u.uCell, p.cell);
      gl.uniform1f(pr.u.uStitchOn, p.stitch);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, p.buf);
      gl.drawElements(gl.TRIANGLES, p.count, gl.UNSIGNED_SHORT, 0);
      this.drawCalls++;
    }
  }

  drawWater() {
    this.drawCalls += this.water.draw({
      proj: this.proj, view: this.viewM, vp: this.vp, cam: this.camEye,
      waveHi: this.q.waveHi, setAtmo: (pr) => this.setAtmo(pr),
      use: (pr) => this.useProg(pr),
      bind: (pr, n, b, s) => this.bindAttr(pr, n, b, s),
    });
  }

  // ── 기체 · 미사일 (PBR) ────────────────────────────────────────
  bindPbr(pr, mesh) {
    this.bindAttr(pr, 'aPos', mesh.pos, 3);
    this.bindAttr(pr, 'aNorm', mesh.nrm, 3);
    this.bindAttr(pr, 'aColor', mesh.col, 3);
    this.bindAttr(pr, 'aMR', mesh.mr, 2);
    // aSkin 을 선언하지 않는 프로그램(VS_GLOW · SKIN 없이 컴파일된 폴백)에서는
    // bindAttr 가 loc<0 으로 no-op 이라 안전하다. aFlex 도 같다 — VS_GLOW 는
    // 선언하지 않으므로 발광 패스에서는 그냥 건너뛴다.
    this.bindAttr(pr, 'aSkin', mesh.skin, 2);
    this.bindAttr(pr, 'aFlex', mesh.flex, 1);
  }

  /**
   * 조종면 편각(라디안 4성분: 좌에일러론 · 우에일러론 · 스태빌레이터 · 러더).
   *
   * 구동값 rate 는 world.view() 가 준다 — 내 기체는 명령값, 남·봇은 스냅샷
   * 자세 차분이다. **`is_bot` 으로 분기하지 않는다.** 값을 봇 플래그가 아니라
   * 데이터 경로에서 뽑는 것이 '봇에도 같이 적용' 규칙의 이행 방식이다.
   */
  deflOf(id, rate, dt) {
    let s = this._defl.get(id);
    if (!s) {
      // 관전·재입장으로 id 가 계속 쌓이는 걸 막는다. 한 프레임 편각이
      // 0 으로 리셋될 뿐이라 눈에 안 띈다.
      if (this._defl.size > 64) this._defl.clear();
      s = [0, 0, 0];
      this._defl.set(id, s);
    }
    const k = clamp((dt || 0) / DEFL_TAU, 0, 1);
    const r = rate || [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      // NaN/Infinity 가 한 번이라도 들어오면 지연 필터가 영구히 오염된다.
      const v = Number.isFinite(r[i]) ? clamp(r[i], -1, 1) : 0;
      s[i] += (v - s[i]) * k;
      if (!Number.isFinite(s[i])) s[i] = 0;
    }
    // 롤 우선회(오른쪽 날개가 내려감) = 우에일러론 뒷전 위 · 좌 아래.
    // 러더는 기수가 오른쪽으로 갈 때 뒷전이 오른쪽(+X)으로 가야 하므로 부호가 반대다.
    return [-D_AIL * s[0], D_AIL * s[0], D_STAB * s[1], -D_RUD * s[2]];
  }

  /**
   * 원거리 식별 확대 배율(메시 자체 배율 s0 은 **포함하지 않는다**).
   * 모델 행렬에는 s0 * idScale(dist, s0) 을 넘긴다.
   *
   * s0=1 이면 오늘의 max(1, min(3, dist/1200)) 과 대수적으로 동일하다.
   * falcon(s0=0.824)은 1200m 에서 s0*idScale = 1.000 → 겉보기 12.10m 로
   * 오늘과 같은 픽셀 바닥을 유지한다. 세 기종의 식별 바닥이 서로 같고,
   * 바닥에 닿기 전(근거리)에는 실물 비율대로 갈라진다.
   */
  idScale(dist, s0) {
    const want = Math.min(dist * ID_K, ID_CAP_M);
    return Math.max(1, want / (JET_SPAN_REF * s0));
  }

  /**
   * 화면 1픽셀이 벌리는 각(라디안 근사). 셰이더가 절차 디테일 폭을 **화면
   * 기준**으로 잡으려면 이 값이 있어야 한다 — fwidth 를 쓸 수 없기 때문이다
   * (WebGL2 + 버전 없는 ESSL1 에서 미정의. shaders.js 앞쪽 측정 주석 참조).
   * 렌더 타깃 높이(ph)를 쓴다. 렌더스케일이 걸리면 실제로 그려지는 픽셀이
   * 그쪽이고, 후처리 업스케일은 폭을 그대로 늘리므로 화면 폭도 보존된다.
   */
  pxScale() {
    return 2 * Math.tan((this.fov || 75) * Math.PI / 360) / Math.max(this.ph, 1);
  }

  /** 미사일 반경 배율. 컬링해야 하면 0 을 돌려준다(길이는 절대 안 늘린다). */
  mslRadiusK(dist) {
    // 픽셀당 월드 길이. fov 는 속도 부스트로 75→101 까지 변한다(frame()).
    const mPerPx = dist * 2 * Math.tan((this.fov || 75) * Math.PI / 360) / this.h;
    const k = Math.max(1, MSL_FLOOR_PX * mPerPx / MSL_DIA);
    return k > MSL_K_MAX ? 0 : k;
  }

  drawSolidPbr() {
    const gl = this.gl, W = this.world, pr = this.progPbr;
    if (!pr) return;
    this.useProg(pr);
    this.setAtmo(pr);
    gl.uniformMatrix4fv(pr.u.uProj, false, this.proj);
    gl.uniformMatrix4fv(pr.u.uView, false, this.viewM);
    gl.uniform1f(pr.u.uFlash, this.flash);
    gl.uniform1f(pr.u.uPxScale, this.pxScale());
    // 감김 실수로 면이 통째로 사라지는 사고를 막는다. 기체는 화면에서 작아
    // 양면 렌더 비용이 무시할 수준이다.
    gl.disable(gl.CULL_FACE);

    const eye = this.camEye;
    const boost = this.set?.idBoost !== false;
    this.bindPbr(pr, this.jet);
    const glowJobs = [];
    for (const pl of W.view()) {
      if (pl.id === W.myId && this.view === 'cockpit' && pl.alive) continue;
      const dist = v3.len(v3.sub(pl.pos, eye));
      // 기종별 메시 배율. 배율표는 서버 AIRCRAFT 한 곳에만 있고 roster 의
      // ac 는 사람·봇을 구분하지 않으므로 봇도 같은 크기 규칙을 탄다.
      const s0 = W.scaleOf(pl.id);
      // **치환이 아니라 곱셈**이다. 치환하면 원거리 식별 강조가 통째로 죽어
      // 1200m 밖 적기가 사라진다. 곱셈이라야 기종 간 상대 크기 비도 전 거리에서
      // 보존된다. 기본 프리셋은 배율 상한 3배 · 틴트 0.35 로 완화한다 —
      // HUD 가 이미 모든 적기에 박스·이름·거리·HP 를 그리므로 정보 손실은 0 이다.
      let scale = s0;
      if (pl.id !== W.myId && boost) scale = s0 * this.idScale(dist, s0);
      // '식별 강조' 를 끄면 먼 기체는 점 스프라이트로 — 실제 공중전에서
      // 먼 기체가 '반짝이는 점' 으로 보이는 현상 그 자체다.
      if (!boost && pl.id !== W.myId) {
        // 전환 임계는 **그 기체의 실제 겉보기 폭**으로 잰다. 12 로 하드코딩해
        // 두면 기체를 줄였을 때 전환이 늦어져 1~2px 짜리 삼각형 덩어리를
        // 계속 그린다(성능 손해).
        const px = (JET_SPAN_REF * s0 * this.h) / Math.max(dist, 1)
                 / (2 * Math.tan((this.fov || 75) * Math.PI / 360));
        if (px < 5) {
          if (this.q.particles && this.fx) {
            this.fx.transient('add', pl.pos[0], pl.pos[1], pl.pos[2],
                              dist * 0.004 + 1.2, T_GLOW, [1.4, 1.3, 1.1], 0.9, 0, 0, 0);
          }
          continue;
        }
      }
      if (pl.id === W.myId) {
        // **내 기체에는 틴트를 칠하지 않는다.** 파란 물 22% 는 먼 적기와
        // 구분하려고 넣은 가독성 보정인데, 3인칭 기본이 되면서 코앞 23m 에
        // 있는 내 기체까지 파랗게 물들여 도장·금속 반사를 전부 덮어 버렸다.
        // 플라스틱 장난감처럼 보이던 원인이다. 화면 한가운데 있는 기체가
        // 내 것이라는 건 색을 칠하지 않아도 안다.
        gl.uniform1f(pr.u.uTintAmt, 0);
      } else {
        gl.uniform3f(pr.u.uTint, 1.0, 0.16, 0.16);
        gl.uniform1f(pr.u.uTintAmt, boost ? (pl.alive ? 0.35 : 0.18) : 0);
      }
      // 기종 도장 · 개체차 · 미익 색 띠. roster 의 `ac`/`c` 는 사람·봇을
      // 구분하지 않고 오므로 여기 한 줄이 양쪽에 동시에 적용된다.
      const rp = W.roster.get(pl.id);
      const sk = PAINT[rp?.ac] || PAINT_DEF;
      gl.uniform3fv(pr.u.uPaintTop, sk.top);
      gl.uniform3fv(pr.u.uPaintBot, sk.under);
      gl.uniform1f(pr.u.uPaintAmt, 1);
      gl.uniform1f(pr.u.uGold, sk.gold);
      gl.uniform3fv(pr.u.uBand, bandOf(rp?.c));
      gl.uniform1f(pr.u.uBandAmt, 0.85);
      gl.uniform1f(pr.u.uSeed, seedOf(pl.id));
      // 패널라인은 이제 **강도 마스터 노브**다. 예전의 dist<500 이진 게이트는
      // 없앴다 — 셰이더가 화면 간격으로 스스로 평균에 수렴하므로 불필요하고,
      // 배율 3배로 확대된 원거리 적기에서 잘못 꺼지는 문제도 함께 사라진다.
      gl.uniform1f(pr.u.uPanel, 1);
      // uScale 이 없으면 확대된 기체에서 절차 디테일 밀도가 1/3 로 성겨진다.
      gl.uniform1f(pr.u.uScale, scale);
      gl.uniform1f(pr.u.uBurn, pl.hp !== undefined ? clamp((45 - pl.hp) / 45, 0, 1) : 0);
      // 조종면. 격자를 쪼개지 않고 정점을 휘게 하므로 삼각형 수·드로우콜은
      // 그대로다. 격추된 기체는 조종면을 중립으로 놓는다.
      const df = this.deflOf(pl.id, pl.alive ? pl.rate : null, this._dt);
      gl.uniform4f(pr.u.uDefl, df[0], df[1], df[2], df[3]);
      const mm = m4.fromQuatPos(pl.q, pl.pos, scale);
      gl.uniformMatrix4fv(pr.u.uModel, false, mm);
      gl.drawArrays(gl.TRIANGLES, 0, this.jet.count);
      this.drawCalls++;
      if (pl.alive) {
        // 추력 연동 노즐 발광. **스냅샷은 안 건드린다** — 이미 오는 값
        // (pl.ab, 속도)만 쓴다. 내 기체는 예측 속도(srv.sp), 남·봇은 스냅샷
        // 두 장의 위치 차분(view() 의 vel)이라 owner 로 분기하지 않는다.
        const spd = (pl.me && W.srv) ? (W.srv.sp || 0) : v3.len(pl.vel || [0, 0, 0]);
        const gv = pl.ab ? 2.2 : 0.55 + 0.45 * clamp((spd - 320) / 780, 0, 1);
        glowJobs.push({ m: mm, ab: pl.ab, glow: gv });
      }
    }
    // 뒤따르는 미사일 패스는 손으로 준 색이 원본이다 — 도장·색 띠·패널라인·
    // 금 코팅을 전부 끄지 않으면 미사일이 기종 도장을 뒤집어쓴다.
    gl.uniform1f(pr.u.uPanel, 0);
    gl.uniform1f(pr.u.uBurn, 0);
    gl.uniform1f(pr.u.uPaintAmt, 0);
    gl.uniform1f(pr.u.uBandAmt, 0);
    gl.uniform1f(pr.u.uGold, 0);
    // 미사일·콕핏 메시는 aFlex 가 전부 0 이라 영향이 없지만, 마지막 기체의
    // 편각이 유니폼에 남아 있는 상태를 만들지 않는다.
    gl.uniform4f(pr.u.uDefl, 0, 0, 0, 0);

    // ── 미사일 — 반경 전용 픽셀 바닥 + 원거리 메시 컬링 ───────────
    // 예전 식 max(2.0, min(4.0, dist/900)) 은 하한 2.0 때문에 3.04m 미사일을
    // **항상 최소 6.08m** 로 그리면서 가시성을 사지도 못했다(500m 에서 여전히
    // 0.79px). 최악의 절충이라 걷어낸다. 이제 길이는 어떤 거리에서도 3.04m 다.
    gl.uniform3f(pr.u.uTint, 0.9, 0.9, 0.92);
    gl.uniform1f(pr.u.uTintAmt, 0.15);
    this.bindPbr(pr, this.msl);
    for (const m of W.missiles) {
      const dist = v3.len(v3.sub(m.pos, eye));
      const kR = this.mslRadiusK(dist);
      if (!kR) continue;      // 메시 포기 — 연기 궤적(updateFx)과 HUD 가 받는다
      gl.uniformMatrix4fv(pr.u.uModel, false, m4.fromQuatPosS3(m.q, m.pos, kR, kR, 1));
      gl.drawArrays(gl.TRIANGLES, 0, this.msl.count);
      this.drawCalls++;
    }
    gl.uniform1f(pr.u.uTintAmt, 0);

    gl.enable(gl.CULL_FACE);

    // ── 발광체: 노즐 · 항법등 · 애프터버너 ───────────────────────
    if (this.progGlow && glowJobs.length) {
      const g = this.progGlow;
      this.useProg(g);
      gl.uniformMatrix4fv(g.u.uProj, false, this.proj);
      gl.uniformMatrix4fv(g.u.uView, false, this.viewM);
      gl.uniform1f(g.u.uOutExp, BASE_EXPOSURE);
      gl.disable(gl.CULL_FACE);
      this.bindPbr(g, this.jetGlow);
      for (const j of glowJobs) {
        // uGlow 는 이제 기체별이다. 예전에는 전 기체 상수 1.0 이라 엔진이
        // 스로틀·AB 와 무관하게 늘 같은 세기로 탔다.
        gl.uniform1f(g.u.uGlow, j.glow);
        gl.uniformMatrix4fv(g.u.uModel, false, j.m);
        gl.drawArrays(gl.TRIANGLES, 0, this.jetGlow.count);
        this.drawCalls++;
      }
      // 배기 코어 · AB 콘은 가산 블렌딩. **한 기체가 둘 다 그리지 않는다** —
      // AB 를 켜면 코어를 끄고 콘으로 교체한다(겹치면 두 배로 탄다).
      const exJobs = glowJobs.filter((j) => !j.ab);
      const abJobs = glowJobs.filter((j) => j.ab);
      if (exJobs.length || abJobs.length) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.depthMask(false);
        if (exJobs.length) {
          this.bindPbr(g, this.exhaust);
          for (const j of exJobs) {
            gl.uniform1f(g.u.uGlow, j.glow);
            gl.uniformMatrix4fv(g.u.uModel, false, j.m);
            gl.drawArrays(gl.TRIANGLES, 0, this.exhaust.count);
            this.drawCalls++;
          }
        }
        if (abJobs.length) {
          this.bindPbr(g, this.ab);
          gl.uniform1f(g.u.uGlow, 1.0);   // AB 콘 색은 이미 최대 세기다
          for (const j of abJobs) {
            gl.uniformMatrix4fv(g.u.uModel, false, j.m);
            gl.drawArrays(gl.TRIANGLES, 0, this.ab.count);
            this.drawCalls++;
          }
        }
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }
      gl.enable(gl.CULL_FACE);
    }

    // ── 접지 그림자 ──────────────────────────────────────────────
    this.drawGroundShadows();
  }

  /**
   * 콕핏 — near=4.0 안쪽에 들어오므로 깊이를 비우고 좁은 투영으로 다시 그린다
   * (무기 뷰모델 표준 기법). **깊이를 비우기 때문에 반드시 파티클 뒤에 온다** —
   * 앞에 두면 그 뒤의 모든 깊이 판정이 무너진다.
   *
   * 콕핏은 카메라가 아니라 **기체 자세**에 붙는다. 카메라는 조준 방향(aim)을
   * 보고 기체 자세와 독립이므로, 조준점을 옆으로 밀면 프레임이 화면에서
   * 흘러가야 맞고, 그게 오히려 기수가 얼마나 뒤처졌는지 읽는 단서가 된다.
   */
  drawCockpit() {
    const gl = this.gl, W = this.world, pr = this.progPbr;
    if (!pr || !this.cockpit) return;
    if (this.view !== 'cockpit' || !W.me || !W.srv?.al) return;
    if (this.set?.cockpit === false) return;
    this.useProg(pr);
    this.setAtmo(pr);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.CULL_FACE);
    gl.uniformMatrix4fv(pr.u.uProj, false,
                        m4.perspective(this.fov * Math.PI / 180, this.w / this.h, 0.15, 50));
    gl.uniformMatrix4fv(pr.u.uView, false, this.viewM);
    gl.uniform3f(pr.u.uTint, 1, 1, 1);
    gl.uniform1f(pr.u.uTintAmt, 0);
    gl.uniform1f(pr.u.uFlash, this.flash);
    gl.uniform1f(pr.u.uBurn, 0);
    // 콕핏 프레임·코밍·레일은 손으로 고른 어두운 색이 원본이라 기종 도장을
    // 입히면 안 된다. 패널라인만 약하게 남긴다(0.6 → 0.35 — 눈에서 1m 안쪽이라
    // 화면 기준 폭이 그대로면 선이 굵게 읽힌다).
    gl.uniform1f(pr.u.uPaintAmt, 0);
    gl.uniform1f(pr.u.uBandAmt, 0);
    gl.uniform1f(pr.u.uGold, 0);
    gl.uniform1f(pr.u.uSeed, seedOf(W.myId));
    gl.uniform1f(pr.u.uPanel, 0.35);
    gl.uniform4f(pr.u.uDefl, 0, 0, 0, 0);   // 콕핏 메시는 aFlex 가 전부 0 이다
    // 콕핏은 좁은 투영으로 다시 그리므로 화각은 같아도 **같은 pxScale** 이다.
    gl.uniform1f(pr.u.uPxScale, this.pxScale());
    const cs = W.scaleOf(W.myId);
    gl.uniform1f(pr.u.uScale, cs);
    this.bindPbr(pr, this.cockpit);
    // 콕핏 메시도 기체 좌표계다 — camera() 의 눈 위치와 **같은 배율**을
    // 먹여야 프레임과 시점의 관계가 기종에 무관하게 유지된다.
    gl.uniformMatrix4fv(pr.u.uModel, false, m4.fromQuatPos(W.me.q, W.me.pos, cs));
    gl.drawArrays(gl.TRIANGLES, 0, this.cockpit.count);
    gl.uniform1f(pr.u.uPanel, 0);
    gl.enable(gl.CULL_FACE);
    this.drawCalls++;
  }

  drawGroundShadows() {
    const gl = this.gl, pr = this.progDecal, W = this.world;
    if (!pr) return;
    const jobs = [];
    for (const pl of W.view()) {
      if (!pl.alive) continue;
      const gh = terrainH(pl.pos[0], pl.pos[2]);
      const agl = pl.pos[1] - Math.max(gh, 0);
      if (agl > SHADOW_AGL || agl < -20) continue;
      // 고도에 따라 반경을 키우고 농도를 낮춰 페널럼브라를 흉내낸다.
      // 본영 반경 9m 는 기체 크기라 배율을 먹인다(반그림자 항은 고도의
      // 함수라 그대로 둔다 — 기체 크기와 무관한 태양 각반경 효과다).
      const t = clamp(agl / SHADOW_AGL, 0, 1);
      const r = 9 * W.scaleOf(pl.id) + agl * 0.06;
      // ── 태양 쪽으로 민다 ────────────────────────────────────────
      // 예전에는 기체 **바로 밑**에 붙어 있었다. 그러면 그림자가 기체와 함께
      // 움직일 뿐이라 '지면 위를 달리는' 것으로 안 읽힌다. 태양 방향으로
      // 밀어 두면 뱅크·상승에서 그림자만 따로 지면을 훑고, 그 상대운동이
      // 곧 속도 단서다.
      //
      // 다만 물리적으로 정확한 오프셋(agl/tan(고도각))은 아침·저녁에 수 km 가
      // 되어 화면에서 사라진다 — 태양 고도는 최소 0.075rad 까지 내려간다
      // (sunDirFromTod). agl 의 0.8배로 잘라 항상 화면 안에 붙들어 둔다.
      const sy = Math.max(this.sun3[1], 1e-3);
      let ox = -this.sun3[0] / sy * agl, oz = -this.sun3[2] / sy * agl;
      const ol = Math.hypot(ox, oz), omax = agl * 0.8;
      if (ol > omax) { ox *= omax / ol; oz *= omax / ol; }
      const px = pl.pos[0] + ox, pz = pl.pos[2] + oz;
      // ── 경사면에 파묻히는 문제 ──────────────────────────────────
      // 데칼은 **한 높이의 평평한 사각형**이다(shaders.js VS_DECAL). 지형
      // 경사가 최대 0.75 라 반경 20m 짜리 그림자는 오르막 쪽 15m 가 지면
      // 아래로 들어가 깊이 판정에 통째로 잘린다 — 산비탈을 스칠 때 그림자가
      // 깜빡이며 사라지던 원인이다. 국소 경사만큼 미리 띄운다.
      // 계수 0.75 는 타협이다: 1.0 이면 절대 안 잘리지만 평지에서 그림자가
      // 떠 보이고(시차), 0 이면 오늘처럼 잘린다.
      const e = r * 0.7;
      const sx = (terrainH(px + e, pz) - terrainH(px - e, pz)) / (2 * e);
      const sz = (terrainH(px, pz + e) - terrainH(px, pz - e)) / (2 * e);
      const gy = terrainH(px, pz);
      jobs.push({ y: Math.max(gy, 0) + 0.7 + Math.hypot(sx, sz) * r * 0.75, x: px, z: pz,
                  // 농도 곡선을 (1-t)^1.4 로 세운다. 선형이면 저공 200m 에서도
                  // 이미 4분의 1이 날아가 있어서 가장 필요한 구간이 가장 옅었다.
                  r, d: Math.pow(1 - t, 1.4) * 0.62 });
    }
    if (!jobs.length) return;
    this.useProg(pr);
    gl.uniformMatrix4fv(pr.u.uProj, false, this.proj);
    gl.uniformMatrix4fv(pr.u.uView, false, this.viewM);
    this.bindAttr(pr, 'aXY', this.quad, 2);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ZERO, gl.SRC_COLOR);   // 곱셈 — 어둡게만 만든다
    gl.disable(gl.CULL_FACE);              // 눕힌 쿼드라 감김을 따지지 않는다
    gl.depthMask(false);
    for (const j of jobs) {
      gl.uniform3f(pr.u.uCenter, j.x, j.y, j.z);
      gl.uniform1f(pr.u.uRadius, j.r * 2);
      gl.uniform1f(pr.u.uDark, j.d);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    this.drawCalls += jobs.length;
  }

  // ── 레거시 solid (품질 '낮음') ─────────────────────────────────
  bindSolidLegacy(mesh) {
    const pr = this.progSolidL;
    this.bindAttr(pr, 'aPos', mesh.pos, 3);
    this.bindAttr(pr, 'aNorm', mesh.nrm, 3);
    this.bindAttr(pr, 'aColor', mesh.col, 3);
  }

  ensureLegacyTerrain() {
    if (this.terrain) return;
    const gl = this.gl, u32 = this.caps.elementIndexUint;
    const t = buildTerrain(30000, u32 ? 150 : 420);
    this.terrain = {
      pos: this.mkBuf(new Float32Array(t.pos)), nrm: this.mkBuf(new Float32Array(t.nrm)),
      col: this.mkBuf(new Float32Array(t.col)),
      idx: this.mkBuf(u32 ? new Uint32Array(t.idx) : new Uint16Array(t.idx),
                      gl.ELEMENT_ARRAY_BUFFER),
      count: t.idx.length, u32,
    };
  }

  drawSolidLegacy(proj, view) {
    const gl = this.gl, W = this.world, pr = this.progSolidL;
    this.ensureLegacyTerrain();
    this.useProg(pr);
    gl.uniformMatrix4fv(pr.u.uProj, false, proj);
    gl.uniformMatrix4fv(pr.u.uView, false, view);
    gl.uniform3fv(pr.u.uLight, this.sunLegacy);
    gl.uniform3f(pr.u.uFogColor, 0.70, 0.80, 0.90);
    const noTint = () => {
      gl.uniform3f(pr.u.uTint, 1, 1, 1);
      gl.uniform1f(pr.u.uTintAmt, 0);
    };
    noTint();
    this.bindSolidLegacy(this.terrain);
    gl.uniformMatrix4fv(pr.u.uModel, false, m4.ident());
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.terrain.idx);
    gl.drawElements(gl.TRIANGLES, this.terrain.count,
                    this.terrain.u32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);
    this.drawCalls++;

    // 저사양 폴백은 개발 중에 한 번도 안 보이므로 코드 리뷰로는 안 잡힌다.
    // 배율 규칙을 **PBR 경로와 같은 헬퍼**에 묶는 게 유일한 구조적 방어다 —
    // 예전에는 여기 max(1.8, dist/420) 이 살아 있어서 적기가 어떤 거리에서도
    // 실물 크기가 아니었고, 미사일은 최소 21m 짜리 대들보였다(RESUME 가
    // 걷어냈다고 적은 값이 이 경로에 그대로 남아 있었다).
    this.bindSolidLegacy(this.jetL);
    const eye = this.camEye;
    for (const pl of W.view()) {
      if (pl.id === W.myId && this.view === 'cockpit' && pl.alive) continue;
      const dist = v3.len(v3.sub(pl.pos, eye));
      const s0 = W.scaleOf(pl.id);
      const scale = pl.id === W.myId ? s0 : s0 * this.idScale(dist, s0);
      if (pl.id === W.myId) {
        gl.uniform3f(pr.u.uTint, 0.45, 0.75, 1.0);
        gl.uniform1f(pr.u.uTintAmt, pl.alive ? 0.5 : 0.2);
      } else {
        gl.uniform3f(pr.u.uTint, 1.0, 0.16, 0.16);
        gl.uniform1f(pr.u.uTintAmt, pl.alive ? 0.82 : 0.35);
      }
      gl.uniformMatrix4fv(pr.u.uModel, false, m4.fromQuatPos(pl.q, pl.pos, scale));
      gl.drawArrays(gl.TRIANGLES, 0, this.jetL.count);
      this.drawCalls++;
    }
    gl.uniform3f(pr.u.uTint, 0.25, 1.0, 0.45);
    gl.uniform1f(pr.u.uTintAmt, 0.95);
    this.bindSolidLegacy(this.mslL);
    for (const m of W.missiles) {
      const dist = v3.len(v3.sub(m.pos, eye));
      // 레거시 메시는 균등 배율만 쓴다. 그래도 컬링 거리는 PBR 과 같은
      // 규칙이라 품질 설정을 바꿨다고 미사일이 대들보가 되지 않는다.
      const kR = this.mslRadiusK(dist);
      if (!kR) continue;
      gl.uniformMatrix4fv(pr.u.uModel, false, m4.fromQuatPos(m.q, m.pos, kR));
      gl.drawArrays(gl.TRIANGLES, 0, this.mslL.count);
      this.drawCalls++;
    }
    noTint();
  }

  // ── 파티클 ─────────────────────────────────────────────────────
  updateFx(dt) {
    const W = this.world, fx = this.fx;
    fx.update(dt);
    const lit = clamp(this.sun3[1] * 0.6 + 0.55, 0.3, 1.2);

    for (const m of W.missiles) fx.missile(m.id, m.pos, m.vel, dt, lit);
    const live = new Set(W.missiles.map((m) => m.id));
    for (const id of [...fx.trails.keys()]) if (!live.has(id)) fx.dropTrail(id);
    // 사라진 미사일의 마지막 속도를 잠깐 들고 있는다 — 공중폭발 파편 링을
    // 진행 방향에 수직으로 놓으려면 방향이 필요한데, 그때 미사일은 이미
    // 스냅샷에서 빠져 있다. 프로토콜을 늘리지 않고 방향을 얻는 유일한 길이다.
    const now = performance.now();
    this._deadMsl = (this._deadMsl || []).filter((d) => now - d.t < 1200);
    const seen = this._mslSeen || (this._mslSeen = new Map());
    for (const [id, d] of seen) {
      if (!live.has(id)) {
        this._deadMsl.push({ p: d.p, v: d.v, t: now });
        seen.delete(id);
      }
    }
    if (this._deadMsl.length > 16) this._deadMsl.splice(0, this._deadMsl.length - 16);
    for (const m of W.missiles) seen.set(m.id, { p: m.pos.slice(), v: m.vel.slice() });

    for (const f of W.flares) fx.flare(f.pos[0], f.pos[1], f.pos[2], dt);

    // 손상 연기 · 콘트레일 · 익단 와류 · 저공 흙먼지
    for (const pl of W.view()) {
      if (!pl.alive) continue;
      // **내 기체는 view() 가 vel 을 싣지 않는다**(world.js view() 의 me 분기).
      // 그래서 지금까지 내 손상 연기만 제자리에서 피어올랐다. 예측 상태의
      // 속도가 그 자리를 메운다 — 아래 흙먼지·와류도 이 값 하나에 매달린다.
      const vel = (pl.me ? W.me?.vel : pl.vel) || [0, 0, 0];
      // 익단 오프셋 6.0 / 5.6 은 기체 좌표계 값이라 기종 배율을 먹인다 —
      // 안 먹이면 flanker 는 콘트레일이 날개 안쪽에서, falcon 은 날개 바깥
      // 허공에서 난다.
      const ms = W.scaleOf(pl.id);
      fx.damage(pl.pos, vel, pl.hp ?? 100, dt);
      // 고도 8,000m 이상 + 추력 — 실제 응결 조건과 같은 규칙이라 물리적으로 맞다
      if (pl.pos[1] > 8000 && Math.random() < dt * 22) {
        const f = quat.fwd(pl.q), r = quat.right(pl.q);
        for (const s of [-1, 1]) {
          const p = v3.add(pl.pos, v3.add(v3.mul(r, 6.0 * ms * s), v3.mul(f, -1.5 * ms)));
          fx._p('alpha', p[0], p[1], p[2], 0, 0, 0, {
            life: 5.5, s0: 1.4, s1: 22, c0: [0.9, 0.92, 0.95], tile: T_SMOKE,
            a0: 0.30, rot: Math.random() * 6.283,
          });
        }
      }
      const sp = Math.hypot(vel[0], vel[1], vel[2]);
      // ── 익단 베이퍼 와류 ──────────────────────────────────────────
      // 예전 조건은 `pl.me && srv.g > 6` 이라 **내 기체에서만** 났다. 남·봇은
      // 실속 플래그가 뜨는 순간에만 겨우 보였는데, 아케이드 모델의 g 는
      // 서버에서 `1 + |c_pitch|·pitchRate·4` 즉 '얼마나 당겼나' 하나다.
      // 그 값은 rate[1] 로 사람·봇·나에게 **같은 경로**로 이미 와 있다
      // (world.js bodyRate 주석: 봇 플래그가 아니라 자세 차분에서 뽑는다).
      // 봇 분기로 갈라져 있던 연출을 데이터 경로로 되돌린다.
      const pull = Math.abs(pl.rate?.[1] || 0);
      // 리본을 쓰면서 발생률을 30 → 18 로 낮췄다. 점 하나가 리본 하나이므로
      // 같은 밀도를 3분의 2 개수로 얻는다.
      if ((pl.stalling || pull > 0.45) && Math.random() < dt * 18) {
        const f = quat.fwd(pl.q), r = quat.right(pl.q), u = quat.up(pl.q);
        const kv = pl.stalling ? 1 : clamp((pull - 0.45) / 0.4, 0.3, 1);
        // 리본 길이는 한 프레임에 기체가 지나는 거리 정도로 둔다 —
        // 그보다 길면 날개 끝이 아니라 기체 몸통에서 나는 것처럼 보인다.
        const rib = 5 + sp * 0.022;
        for (const s of [-1, 1]) {
          const p = v3.add(pl.pos, v3.add(v3.add(v3.mul(r, 5.6 * ms * s), v3.mul(f, -1.0 * ms)),
                                          v3.mul(u, 0.3 * ms)));
          fx.vortex(p[0], p[1], p[2], -f[0] * rib, -f[1] * rib, -f[2] * rib, kv);
        }
      }
      // ── 저공 흙먼지 ──────────────────────────────────────────────
      // 4km 밖 기체의 먼지는 화면에서 한 점도 안 되므로 아예 만들지 않는다.
      // 이 게이트가 없으면 30km 떨어진 봇 열두 대가 알파 풀을 갉아먹는다.
      const ex = pl.pos[0] - this.camEye[0], ez = pl.pos[2] - this.camEye[2];
      if (sp < 150 || ex * ex + ez * ez > 16e6) continue;
      // AGL: 내 기체는 서버가 권위값(srv.agl)을 내려준다. 남·봇만 클라에서
      // 지형을 조회한다 — **봇 분기가 아니라 데이터 유무의 차이**다.
      const agl = (pl.me && W.srv) ? W.srv.agl
                                   : pl.pos[1] - Math.max(terrainH(pl.pos[0], pl.pos[2]), 0);
      if (!(agl < DUST_AGL) || agl < -5) continue;
      const k = clamp(1 - agl / DUST_AGL, 0, 1);
      // **거리 기준** 발생률이다(45m 항적마다 하나). 시간 기준으로 두면
      // 느리게 날 때 먼지가 더 짙어지는 거꾸로 된 그림이 되고, 프레임레이트가
      // 흔들릴 때 먼지 띠에 구멍이 난다. 미사일 궤적이 같은 이유로 거리
      // 기준이다(fx.js missile 주석).
      if (Math.random() < dt * sp / 45 * k) {
        const hl = Math.hypot(vel[0], vel[2]) || 1;
        const dx = vel[0] / hl, dz = vel[2] / hl;
        const lead = 60 + Math.random() * 240;
        const side = (Math.random() - 0.5) * 46;
        const px = pl.pos[0] + dx * lead - dz * side;
        const pz = pl.pos[2] + dz * lead + dx * side;
        const gy = terrainH(px, pz);
        // 바다에는 모래가 일지 않는다. 물기둥은 다른 이펙트(impact)의 몫이다.
        if (gy > 6) fx.groundDust(px, gy, pz, dx, dz, sp, k);
      }
    }


    // 폭발/명중 — world.booms 에서 새로 생긴 것만 소비한다
    const fresh = [];
    for (const e of W.booms) if (!e._fx) { e._fx = 1; fresh.push(e); }
    // ── 근접신관 공중폭발 vs 격추 폭발 ────────────────────────────
    // 서버는 둘 다 같은 'boom' 이벤트로 내려보내고 **프로토콜은 안 건드린다**.
    // 대신 서버가 격추 순간 두 발을 함께 쏘는 성질을 쓴다(game.py):
    // _apply_hit → _kill 이 기체 위치에 하나, 곧이어 신관 코드가 경로 최근접점
    // (신관 반경 최대 45m)에 하나. 그래서 **같은 배치에 70m 안쪽으로 붙어 오는
    // 공중 boom 두 개**는 '격추 + 그 신관' 이고, 혼자 오는 것은 순수 근접신관이다.
    // 앞의 것이 기체 위치이므로 폭발은 거기서 그리고 뒤의 것은 버린다.
    const air = fresh.filter((e) => e.kind !== 'spark' && !e.ground);
    for (const e of air) {
      if (e._skip || e._kill) continue;
      const near = air.find((o) => o !== e && !o._skip && !o._kill
        && Math.hypot(o.x - e.x, o.y - e.y, o.z - e.z) < 70);
      if (near) { near._skip = 1; e._kill = 1; }
    }
    for (const e of fresh) {
      if (e._skip) continue;
      if (e.kind === 'spark') { this.fx.spark(e.x, e.y, e.z, e.seed || 0); continue; }
      const d = v3.len(v3.sub([e.x, e.y, e.z], this.camEye));
      if (!e.ground && !e._kill) {
        // 탄두만 터진 자리 — 짧은 섬광 + 원반형 파편 링, 검은 연기 기둥 없음
        this.fx.airburst(e.x, e.y, e.z, this.mslDirNear(e));
        this.flash = Math.max(this.flash, clamp(1 - d / 2200, 0, 1) * 0.35);
        continue;
      }
      this.fx.explosion(e.x, e.y, e.z);
      // 지면이면 먼지 기둥 + 파편, 물이면 흰 물기둥 + 링 파문
      if (e.ground) this.fx.impact(e.x, e.y, e.z, !!e.water);
      // 짧은 전역 섬광 — 거의 공짜인데 설득력이 크다
      this.flash = Math.max(this.flash, clamp(1 - d / 2200, 0, 1) * 0.8);
    }

    // 지상 스캐터는 맨 마지막이다 — transient 는 이번 프레임만 살고
    // fx.update(dt) 가 카운터를 0 으로 되돌린 뒤에 쌓여야 한다.
    this.groundScatter(lit);
  }

  /**
   * 저공 지상 스캐터 — 지면에 붙은 작은 지물(덤불·바위)이 스쳐 지나가게 한다.
   *
   * 왜 필요한가: 화면에서 느끼는 속도는 시선 각속도이고, 각속도는 **가깝고
   * 작은 것**에서만 나온다. 이 세계에는 885m 보다 작은 지오메트리가 원리적으로
   * 없어서(m3d.js TERRAIN_OCT) 스쳐 갈 대상 자체가 없었다. 나무를 '심는' 것도
   * 3000m 상공에서는 1픽셀이 안 되므로 의미가 없다 — 그래서 **저공에서만**
   * 존재하게 만든다. 높이 날면 속도감이 없는 것이 물리적으로 맞고, 동시에
   * 첫 세 줄에서 되돌아가므로 순항 중 비용이 정확히 0 이다.
   *
   * 스폰이 아니라 **월드 좌표 해시**다. 셀 정수 좌표에서 위치·크기·색을
   * 결정론적으로 뽑으므로
   *   (1) 지물이 월드에 못 박혀 카메라를 따라 헤엄치지 않고
   *   (2) 수명·풀 관리가 없고(transient 는 이번 프레임만 산다)
   *   (3) 프레임당 개수가 격자 크기로 **상수 고정**된다.
   * 시간 기반 스폰이면 프레임레이트에 따라 밀도가 달라지고, 미사일 궤적이
   * 쓰는 알파 풀을 잠식한다(fx.js setCap 주석의 그 사고).
   *
   * 지물은 **세로로 늘린 빌보드**다. 눕힌 판이 아니라 세로여야 하는 이유는
   * 소프트 파티클 때문이다 — 지면에 딱 붙은 스프라이트는 깊이 차가 0 이라
   * FS_FX 의 `(sz-fz)/uSoft` 가 알파를 0 으로 만들어 아무것도 안 보인다.
   * 세로 리본은 밑동만 부드럽게 지면에 묻혀 접지가 오히려 자연스럽다.
   */
  groundScatter(lit) {
    const fx = this.fx;
    const N = SCAT_N[clamp(this.q.detail | 0, 0, 3)];
    if (!fx || !N) return;
    const eye = this.camEye;
    const agl = eye[1] - Math.max(terrainH(eye[0], eye[2]), 0);
    if (!(agl < SCAT_AGL) || agl < 0) return;
    // 고도 페이드. 임계에서 뚝 끊으면 상승할 때 지면이 한 번에 벌거벗는다.
    const hi = clamp((SCAT_AGL - agl) / (SCAT_AGL * 0.45), 0, 1);
    // 격자를 시선 앞쪽으로 민다 — 뒤쪽 지물은 그려도 화면에 없다. 같은
    // 개수로 앞쪽 밀도를 두 배로 쓰는 방법이다.
    const f = quat.rot(this.camQ, [0, 0, 1]);
    const fl = Math.hypot(f[0], f[2]);
    const hx = fl > 1e-3 ? f[0] / fl : 0, hz = fl > 1e-3 ? f[2] / fl : 1;
    const half = N >> 1, R = half * SCAT_CELL;
    // **셀 격자에 스냅한다.** 스냅하지 않으면 창이 움직일 때마다 셀 경계가
    // 밀려 지물 집합이 통째로 바뀌고 지면이 지글거린다 — 클립맵이 같은
    // 이유로 2×cell 스냅을 한다(terrain.js patches 주석).
    const cx = Math.round((eye[0] + hx * R * 0.6) / SCAT_CELL);
    const cz = Math.round((eye[2] + hz * R * 0.6) / SCAT_CELL);
    const bush = [0.075 * lit, 0.095 * lit, 0.055 * lit];
    const rock = [0.21 * lit, 0.20 * lit, 0.18 * lit];
    // 근접 페이드는 **3차원 거리**로 잰다. 수평 거리로 재면 고도 500m 에서
    // 기체 바로 밑이 통째로 벌거벗는다(수평으로는 0m 니까). 카메라 AGL 을
    // 높이 성분으로 쓰면 지형별 조회 없이 근사가 맞는다.
    const a2 = agl * agl;
    for (let j = -half; j <= half; j++) {
      for (let i = -half; i <= half; i++) {
        // 창 가장자리 페이드. 셀 인덱스로 재면 정수 비교 두 번이면 되고,
        // 창이 한 칸 밀릴 때 지물이 팝하지 않고 2.5칸에 걸쳐 흐려진다.
        const m = Math.abs(i) > Math.abs(j) ? Math.abs(i) : Math.abs(j);
        const edge = 1 - clamp((m - (half - 2.5)) / 2.5, 0, 1);
        if (edge <= 0) continue;
        const gx = cx + i, gz = cz + j;
        // 정수 두 개 → 32비트 해시. 6비트씩 다섯 칸으로 잘라 쓴다(64단계면
        // 지터·크기에 충분하다). 필드를 겹쳐 쓰면 '큰 것만 사라지는' 식으로
        // 상관이 눈에 보인다.
        let h = Math.imul(gx, 374761393) ^ Math.imul(gz, 668265263);
        h = Math.imul(h ^ (h >>> 15), 2246822519);
        h = Math.imul(h ^ (h >>> 13), 3266489917);
        h ^= h >>> 16;
        const q3 = ((h >>> 18) & 63) / 64;
        if (q3 < 0.42) continue;            // 셀의 42% 는 비운다 — 격자가 보이면 지물이 아니라 무늬다
        const q0 = (h & 63) / 64, q1 = ((h >>> 6) & 63) / 64, q2 = ((h >>> 12) & 63) / 64;
        const px = gx * SCAT_CELL + (q0 - 0.5) * SCAT_CELL * 0.92;
        const pz = gz * SCAT_CELL + (q1 - 0.5) * SCAT_CELL * 0.92;
        const dx = px - eye[0], dz = pz - eye[2];
        const d2 = dx * dx + dz * dz + a2;
        // 코앞 30m 안쪽은 그리지 않는다. 지물 하나가 화면을 덮으면 그건
        // 속도감이 아니라 얼룩이다. 30→90m 구간에서 떠오른다.
        if (d2 < 900) continue;
        const near = clamp((d2 - 900) / 7200, 0, 1);
        const gy = terrainH(px, pz);
        if (gy < 12) continue;              // 바다·해안에는 안 심는다(해수면이 0 이다)
        const q4 = ((h >>> 24) & 63) / 64;
        const tall = q4 > 0.42;
        const ht = tall ? 6 + q2 * 9 : 2.5 + q2 * 3.5;
        const wd = tall ? 3.0 + q2 * 3.0 : 4.5 + q2 * 5.0;
        // 알파 풀의 transient 는 정렬 뒤에 붙으므로 연기보다 나중에 그려진다.
        // 지물은 지면에 붙은 작은 물체라 겹침 오차가 화면에 안 잡힌다 —
        // 이걸 정렬에 넣으려면 살아 있는 파티클로 만들어야 하고, 그러면
        // 위에 적은 (1)(2)(3) 이 전부 무너진다.
        fx.transient('alpha', px, gy + ht * 0.5 - 1.0, pz, wd, T_SMOKE,
                     tall ? bush : rock, hi * edge * near * 0.85, 0, ht, 0);
      }
    }
  }

  /** 그 자리에서 막 사라진 미사일의 진행 방향(없으면 null). */
  mslDirNear(e) {
    let best = null, bd = 200 * 200;
    for (const d of this._deadMsl || []) {
      const q = (d.p[0] - e.x) ** 2 + (d.p[1] - e.y) ** 2 + (d.p[2] - e.z) ** 2;
      if (q < bd) { bd = q; best = d; }
    }
    return best ? best.v : null;
  }

  /**
   * 발사 이펙트. main.js 의 launch 이벤트에서 부른다 — **`ev.id` 로 분기하지
   * 않는다.** 발사점은 프로토콜 변경 없이 유도된다: 서버 _launch 가
   * `p.pos + f·4.0·ms + r·2.74·ms` 를 쓰고, 클라는 그 플레이어의 pos·q 를
   * 스냅샷에서 이미 갖고 있다. 봇도 같은 launch 이벤트를 내므로 자동으로
   * 같은 연출을 받는다.
   */
  launchFx(id) {
    const W = this.world, fx = this.fx;
    if (!fx || !this.q?.particles) return;
    const pl = W.byId(id);
    if (!pl) return;
    fx.launch(pl.pos, quat.fwd(pl.q), quat.right(pl.q), quat.up(pl.q), W.scaleOf(id));
  }

  drawFx() {
    const gl = this.gl, pr = this.progFx;
    if (!pr || !this.atlas) return;
    const depthTex = (this.usePost && this.caps.softParticles) ? this.post.resolveDepth() : null;

    this.useProg(pr);
    gl.uniformMatrix4fv(pr.u.uProj, false, this.proj);
    gl.uniformMatrix4fv(pr.u.uView, false, this.viewM);
    const r = quat.rot(this.camQ, [1, 0, 0]), u = quat.rot(this.camQ, [0, 1, 0]);
    gl.uniform3f(pr.u.uRight, r[0], r[1], r[2]);
    gl.uniform3f(pr.u.uUp, u[0], u[1], u[2]);
    gl.uniform3fv(pr.u.uEye, this.camPos3);
    gl.uniform1f(pr.u.uOutExp, BASE_EXPOSURE);
    gl.uniform1f(pr.u.uSoft, 12.0);
    gl.uniform1f(pr.u.uSoftOn, depthTex ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.uniform1i(pr.u.uAtlas, 0);
    if (depthTex) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, depthTex);
      gl.uniform1i(pr.u.uDepth, 1);
      gl.uniform2f(pr.u.uNearFar, this.near, this.far);
      gl.activeTexture(gl.TEXTURE0);
    }

    gl.enable(gl.BLEND);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    // 알파(연기) → 가산(불꽃) 순. 드로우콜은 파티클 종류와 무관하게 2회다.
    this.drawPool(pr, this.fx.alpha, true);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    this.drawPool(pr, this.fx.add, false);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
  }

  drawPool(pr, pool, alphaBlend) {
    const gl = this.gl;
    const n = this.fx.build(pool, this.camEye, alphaBlend);
    if (!n) return;
    if (alphaBlend) gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pool.inst.subarray(0, n * 13));
    const S = 13 * 4;
    const set = (name, size, off) => {
      const a = this.bindAttr(pr, name, this.instBuf, size, S, off);
      if (a >= 0) this.divisor(a, 1);
    };
    set('iPos', 3, 0);
    set('iSRTL', 4, 12);
    set('iColor', 3, 28);
    set('iStretch', 3, 40);
    const ac = this.bindAttr(pr, 'aCorner', this.quad, 2);
    if (ac >= 0) this.divisor(ac, 0);
    this.drawInstanced(6, n);
    // 디바이저는 전역 상태다 — 반드시 0 으로 되돌린다. 배열 on/off 는
    // useProg 가 관리하므로 여기서 끄면 추적 상태와 어긋난다.
    for (const nm of ['iPos', 'iSRTL', 'iColor', 'iStretch']) {
      const a = pr.a[nm];
      if (a >= 0) this.divisor(a, 0);
    }
    this.drawCalls++;
  }

  divisor(loc, d) {
    if (this.gl2) this.gl.vertexAttribDivisor(loc, d);
    else if (this.inst) this.inst.vertexAttribDivisorANGLE(loc, d);
  }
  drawInstanced(count, n) {
    if (this.gl2) this.gl.drawArraysInstanced(this.gl.TRIANGLES, 0, count, n);
    else if (this.inst) this.inst.drawArraysInstancedANGLE(this.gl.TRIANGLES, 0, count, n);
  }

  // ── 레거시 선분 이펙트 (품질 '낮음') ───────────────────────────
  drawLines(proj, view, dt) {
    const gl = this.gl, W = this.world, pr = this.progLine;
    let n = 0;
    const push = (x, y, z, c, a) => {
      if (n >= this.lineCap) return;
      this.linePos[n * 3] = x; this.linePos[n * 3 + 1] = y; this.linePos[n * 3 + 2] = z;
      this.lineCol[n * 3] = c[0]; this.lineCol[n * 3 + 1] = c[1]; this.lineCol[n * 3 + 2] = c[2];
      this.lineAlpha[n] = a;
      n++;
    };
    const smoke = [0.45, 1.0, 0.6];
    for (const m of W.missiles) {
      let tr = this.trails.get(m.id);
      if (!tr) { tr = []; this.trails.set(m.id, tr); }
      const last = tr[tr.length - 1];
      if (!last || v3.len(v3.sub(m.pos, last)) > 25) {
        tr.push([...m.pos]);
        if (tr.length > 90) tr.shift();
      }
      for (let i = 1; i < tr.length; i++) {
        const a = (i / tr.length) * 0.55;
        push(tr[i - 1][0], tr[i - 1][1], tr[i - 1][2], smoke, a);
        push(tr[i][0], tr[i][1], tr[i][2], smoke, a);
      }
    }
    const live = new Set(W.missiles.map((m) => m.id));
    for (const id of [...this.trails.keys()]) if (!live.has(id)) this.trails.delete(id);

    const flare = [1.0, 0.78, 0.35];
    for (const f of W.flares) {
      push(f.pos[0], f.pos[1], f.pos[2], flare, clamp(f.life / 4.5, 0, 1));
      push(f.pos[0], f.pos[1] - 14, f.pos[2], flare, 0.05);
    }
    for (const e of W.booms) {
      const t = e.t / e.life;
      if (e.kind === 'spark') {
        const rr = 6 + t * 46;
        const cnt = 12;
        for (let i = 0; i < cnt; i++) {
          const a = (i / cnt) * Math.PI * 2 + (e.seed || 0);
          const el = Math.sin(a * 2.3 + (e.seed || 0)) * 0.9;
          const dx = Math.cos(a), dy = el, dz = Math.sin(a);
          const c = [1.0, 0.92 - t * 0.5, 0.45 - t * 0.4];
          push(e.x + dx * rr * 0.35, e.y + dy * rr * 0.35, e.z + dz * rr * 0.35, c, (1 - t) * 1.0);
          push(e.x + dx * rr, e.y + dy * rr, e.z + dz * rr, c, 0);
        }
        const w = 10 * (1 - t);
        push(e.x - w, e.y, e.z, [1, 1, 0.9], 1 - t);
        push(e.x + w, e.y, e.z, [1, 1, 0.9], 1 - t);
        push(e.x, e.y - w, e.z, [1, 1, 0.9], 1 - t);
        push(e.x, e.y + w, e.z, [1, 1, 0.9], 1 - t);
        continue;
      }
      const rr = 20 + t * 260;
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        const c = [1.0, 0.6 - t * 0.4, 0.2];
        push(e.x, e.y, e.z, c, (1 - t) * 0.9);
        push(e.x + Math.cos(a) * rr, e.y + Math.sin(a * 1.7) * rr * 0.6,
             e.z + Math.sin(a) * rr, c, 0);
      }
    }
    if (!n || !pr) return;
    this.useProg(pr);
    gl.uniformMatrix4fv(pr.u.uProj, false, proj);
    gl.uniformMatrix4fv(pr.u.uView, false, view);
    const bind = (name, buf, arr, size) => {
      const a = pr.a[name];
      if (a < 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, arr.subarray(0, n * size));
      gl.vertexAttribPointer(a, size, gl.FLOAT, false, 0, 0);
    };
    bind('aPos', this.lineBuf.pos, this.linePos, 3);
    bind('aColor', this.lineBuf.col, this.lineCol, 3);
    bind('aAlpha', this.lineBuf.alpha, this.lineAlpha, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    gl.drawArrays(gl.LINES, 0, n - (n % 2));
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    this.drawCalls++;
  }

  /** 월드 좌표 → 화면 좌표(HUD 조준 표시용). 뒤쪽이면 null */
  project(p) {
    if (!this.proj || !this.viewM) return null;
    const v = this.viewM, pr = this.proj;
    const ex = v[0] * p[0] + v[4] * p[1] + v[8] * p[2] + v[12];
    const ey = v[1] * p[0] + v[5] * p[1] + v[9] * p[2] + v[13];
    const ez = v[2] * p[0] + v[6] * p[1] + v[10] * p[2] + v[14];
    if (ez > -1) return null;
    const cw = -ez;
    const cx = pr[0] * ex, cy = pr[5] * ey;
    return [(cx / cw * 0.5 + 0.5) * this.w, (-cy / cw * 0.5 + 0.5) * this.h, cw];
  }
}
