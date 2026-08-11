// 부팅 · 홈 화면 · 게임 루프 · HUD 연결
import { Net } from './net.js';
import { Input } from './input.js';
import { World } from './world.js';
import { Scene } from './scene.js';
import { Hud } from './hud.js';
import { Sfx } from './audio.js';
import { quat } from './m3d.js';

const $ = (id) => document.getElementById(id);

const settings = {
  // 화각 75 → 88. 카메라를 23m 에서 16m 로 당기면서 기체가 화면을 크게
  // 차지하게 됐는데, 화각까지 좁으면 주변이 안 보여 교전이 안 된다.
  // 둘을 같이 움직여야 '크게 보이면서 더 많이 보이는' 상태가 된다.
  fov: +(localStorage.getItem('skyarena.fov') ?? 88),
  invert: localStorage.getItem('skyarena.invert') === '1',
  net: localStorage.getItem('skyarena.net') === '1',
  // ── 조준 ────────────────────────────────────────────────────────
  // 마우스 감도는 cm/360 하나로 정의한다(800DPI 기준). 작을수록 빠르다.
  // cm/360 — 마우스를 몇 cm 움직여야 360도 도는가(800DPI 기준).
  // **작을수록 예민하다.** 12cm 는 FPS 표준에 가깝지만 이 게임은 기체를
  // 통째로 돌리는 것이라 답답했다. 5cm 면 손목만 까딱해도 크게 돈다.
  cm360: +(localStorage.getItem('skyarena.cm360') ?? 5),
  // 조준점이 기수에서 벌어질 수 있는 최대 각도(도). 이게 있어야 상호추종
  // 루프와 데드존이 동시에 사라지고 기총 원뿔에 의미가 생긴다.
  // 리시 = 조준점이 기수에서 벌어질 수 있는 최대 각도.
  // 55도면 마우스를 휙 돌렸을 때 조준점만 먼저 가고 기체가 뒤따라온다 —
  // 사용자가 "따라오는 게 아니라 같이 움직이게" 라고 한 게 이것이다.
  // 8도로 좁히면 기수가 조준점에 붙어 함께 돈다.
  leash: +(localStorage.getItem('skyarena.leash') ?? 8),
  // ── 그래픽 ──────────────────────────────────────────────────────
  // 'low' 는 이번 그래픽 작업 전 파이프라인 그대로다(회귀 안전판).
  gfx: localStorage.getItem('skyarena.gfx') || 'med',
  // 3D 해상도. HUD 는 이 값과 무관하게 네이티브 DPR 로 그려 텍스트가 선명하다.
  renderScale: +(localStorage.getItem('skyarena.rscale') ?? 1),
  adaptive: localStorage.getItem('skyarena.adaptive') !== '0',
  // 식별 강조: 먼 적기를 키우고 붉게 칠한다. 끄면 실물 크기 + 점 스프라이트.
  idBoost: localStorage.getItem('skyarena.idboost') !== '0',
  cockpit: localStorage.getItem('skyarena.cockpit') !== '0',
};
// 조작 체계가 통째로 바뀌었다(조준 = 월드 방향, 카메라는 그 값을 읽기만 한다).
// 옛 설정값은 새 체계에서 의미가 없으므로 한 번만 새 기본값으로 갈아끼운다.
let ctrlMigrated = false;
if (localStorage.getItem('skyarena.ctrlv') !== '3') {
  settings.cm360 = 12;
  settings.leash = 55;
  localStorage.setItem('skyarena.cm360', '12');
  localStorage.setItem('skyarena.leash', '55');
  localStorage.removeItem('skyarena.camlead');
  localStorage.removeItem('skyarena.camleadv');
  localStorage.removeItem('skyarena.assist');
  localStorage.removeItem('skyarena.sens');
  localStorage.setItem('skyarena.ctrlv', '3');
  ctrlMigrated = true;
}
// 화각 기본값을 75 → 88 로 올렸다. 이미 75 가 저장돼 있으면 새 기본값이
// 영영 안 먹으므로 한 번만 갈아끼운다(사용자가 직접 바꿨더라도 이번 한 번은
// 새 값으로 간다 — 카메라 거리와 짝이라 따로 놀면 화면이 이상해진다).
if (localStorage.getItem('skyarena.sensv') !== '2') {
  settings.cm360 = 5;
  localStorage.setItem('skyarena.cm360', '5');
  localStorage.setItem('skyarena.sensv', '2');
}
if (localStorage.getItem('skyarena.leashv') !== '2') {
  settings.leash = 8;
  localStorage.setItem('skyarena.leash', '8');
  localStorage.setItem('skyarena.leashv', '2');
}
if (localStorage.getItem('skyarena.fovv') !== '2') {
  settings.fov = 88;
  localStorage.setItem('skyarena.fov', '88');
  localStorage.setItem('skyarena.fovv', '2');
}
const saveSet = () => {
  localStorage.setItem('skyarena.fov', settings.fov);
  localStorage.setItem('skyarena.invert', settings.invert ? '1' : '0');
  localStorage.setItem('skyarena.net', settings.net ? '1' : '0');
  localStorage.setItem('skyarena.cm360', settings.cm360);
  localStorage.setItem('skyarena.leash', settings.leash);
  localStorage.setItem('skyarena.gfx', settings.gfx);
  localStorage.setItem('skyarena.rscale', settings.renderScale);
  localStorage.setItem('skyarena.adaptive', settings.adaptive ? '1' : '0');
  localStorage.setItem('skyarena.idboost', settings.idBoost ? '1' : '0');
  localStorage.setItem('skyarena.cockpit', settings.cockpit ? '1' : '0');
};

const cv = $('game');
const sfx = new Sfx();
const world = new World(sfx);
const input = new Input(cv, settings);
const scene = new Scene(cv, world, settings);
const hud = new Hud($('hud-canvas'), world, scene, input);
const net = new Net();
input.onAny = () => sfx.resume();

// 창이 가려지거나 닫히면 소리를 완전히 끊는다.
// (배경 탭에서 엔진음이 계속 울리던 문제)
const silence = () => {
  sfx.stopEngine();
  try { sfx.ctx?.suspend?.(); } catch { /* 아직 오디오 미생성 */ }
};
addEventListener('visibilitychange', () => {
  if (document.hidden) silence();
  else if (sfx.enabled) { try { sfx.ctx?.resume?.(); } catch { /* noop */ } }
});
addEventListener('pagehide', silence);
addEventListener('blur', () => { if (!net.joined) silence(); });
input.onView = () => scene.toggleView();

const ui = {
  home: $('home'), hud: $('hud'), conn: $('conn'), join: $('join'), nick: $('nick'),
  room: $('room'), score: $('s-score'), kills: $('s-kills'), ping: $('s-ping'),
  fps: $('s-fps'), kbps: $('s-kbps'), feed: $('feed'), board: $('board-list'),
  banner: $('banner'), respawn: $('respawn'), respawnT: $('respawn-t'),
  killedBy: $('killed-by'), touch: $('touch'), roomName: $('room-name'),
  srvStat: $('server-stat'), settings: $('settings'), acPick: $('ac-pick'),
  acList: $('ac-list'), record: $('record'), hpBar: $('bar-hp'),
};

ui.nick.value = localStorage.getItem('skyarena.nick') || '';
ui.room.value = new URLSearchParams(location.search).get('room') || '';
if (input.isTouch) ui.touch.classList.remove('hidden');
document.querySelectorAll('.net').forEach((e) => e.classList.toggle('hidden', !settings.net));

if (!scene.ok) {
  $('gl-error').classList.remove('hidden');
  $('gl-error').textContent = 'WebGL 초기화 실패: ' + scene.error;
}

// ── 번들 버전 ──────────────────────────────────────────────────────
// 서버(/game.json 의 build)와 이 상수가 어긋나면 **낡은 번들이 돌고 있다**는
// 뜻이다. 설치형 앱은 새로고침할 일이 없어서, 옛 서비스 워커가 캐시에서
// 꺼내 준 예전 코드가 며칠씩 살아남는다 — 사용자에게는 '그래픽이 갑자기
// 옛날로 돌아갔다'로 보인다(구형 렌더러 시절 번들이라 실제로 그렇다).
// 사람이 눈치채고 조치하기를 기대하지 말고 스스로 복구한다.
export const BUILD = '2026-08-11b';

async function healIfStale() {
  try {
    const g = await (await fetch('/game.json?v=' + Date.now(), { cache: 'no-store' })).json();
    if (!g.build || g.build === BUILD) return false;
    console.warn('낡은 번들 감지: 화면 ' + BUILD + ' / 서버 ' + g.build + ' — 복구한다');
    // 워커와 캐시를 통째로 걷어내고 한 번만 다시 뜬다. 이 경로를 타면
    // 다음 로드부터는 네트워크 전용 워커(v5)가 잡혀 다시는 안 굳는다.
    if (sessionStorage.getItem('skyarena.healed') === g.build) return false;  // 무한루프 방지
    sessionStorage.setItem('skyarena.healed', g.build);
    for (const r of await navigator.serviceWorker?.getRegistrations?.() || []) await r.unregister();
    for (const k of await caches?.keys?.() || []) await caches.delete(k);
    location.reload();
    return true;
  } catch { return false; }
}

// ── PWA ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  addEventListener('load', async () => {
    if (await healIfStale()) return;
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      // 설치된 앱은 새로고침할 일이 없어 낡은 워커가 오래 살아남는다.
      // 띄울 때마다 갱신을 확인한다.
      reg.update().catch(() => {});
    } catch { /* 워커 없이도 게임은 돈다 */ }
    // 새 워커가 올라오면 다시 로드한다 — 옛 번들과 새 번들이 섞인 채로
    // 도는 것을 막기 위해서다.
    //
    // 단 **교전 중에는 절대 새로고침하지 않는다.** 한창 날고 있는데 페이지가
    // 다시 뜨면 홈 화면으로 튕겨 나간다 — 죽었다 살아나는 것과 구분이 안 되고,
    // 사용자 입장에서는 그냥 '판이 날아간' 것이다. 홈으로 돌아왔을 때
    // 조용히 적용한다.
    let pending = false, reloaded = false;
    const applyUpdate = () => {
      if (reloaded || !pending) return;
      if (document.body.classList.contains('flying')) return;   // 비행 중이면 미룬다
      reloaded = true;
      location.reload();
    };
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.t !== 'sw-updated') return;
      pending = true;
      applyUpdate();
    });
    // 홈으로 나오는 시점을 잡는다(⏻ 버튼 · 연결 끊김 등 경로가 여럿이다)
    setInterval(applyUpdate, 2000);

    // ── 설치된 앱이 최신을 놓치지 않게 ────────────────────────────
    // 설치형 앱(PWA)은 주소창도 새로고침 버튼도 없어서, 한 번 띄워 두면
    // 며칠이고 그대로 산다. 브라우저의 자동 워커 갱신은 '탐색(navigation)'
    // 때 도는데 그 탐색이 영영 안 일어나는 것이다. 그래서 직접 확인한다.
    const reg2 = await navigator.serviceWorker.getRegistration();
    const check = () => {
      if (document.hidden) return;              // 숨겨져 있으면 의미 없다
      reg2?.update?.().catch(() => {});
      healIfStale();                            // 워커가 죽어 있어도 잡히도록
    };
    setInterval(check, 60000);                  // 1분마다
    addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  });
}
let installPrompt = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('btn-install').disabled = false;
  $('install-hint').textContent = '';
});
const installed = matchMedia('(display-mode: fullscreen)').matches
  || matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (installed) $('install-card').classList.add('hidden');
else {
  $('btn-install').disabled = true;
  $('install-hint').textContent =
    '버튼이 잠겨 있으면 크롬 주소창 오른쪽 설치 아이콘을 눌러도 됩니다. iPhone 은 공유 → “홈 화면에 추가”.';
}
$('btn-install').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  $('install-hint').textContent = outcome === 'accepted' ? '설치했습니다!' : '설치를 취소했습니다.';
});

// ── 기체 선택 ──────────────────────────────────────────────────────
let chosenAc = localStorage.getItem('skyarena.ac') || 'falcon';
let chosenDiff = localStorage.getItem('skyarena.diff') || 'easy';
fetch('/game.json').then((r) => r.json()).then((g) => {
  $('diff-pick').innerHTML = Object.entries(g.difficulty).map(([k, d]) => `
    <button type="button" class="cls ${k === chosenDiff ? 'on' : ''}" data-diff="${k}">
      <b>${esc(d.label)}</b><em>${esc(d.desc)}</em></button>`).join('');
  $('diff-pick').addEventListener('click', (e) => {
    const b = e.target.closest('.cls');
    if (!b) return;
    chosenDiff = b.dataset.diff;
    localStorage.setItem('skyarena.diff', chosenDiff);
    $('diff-pick').querySelectorAll('.cls').forEach((x) => x.classList.toggle('on', x === b));
  });
  ui.acPick.innerHTML = Object.entries(g.classes).map(([k, a]) => `
    <button type="button" class="cls ${k === chosenAc ? 'on' : ''}" data-ac="${k}">
      <b>${esc(a.label)}</b><span>${esc(a.role)}</span>
      <u>추력 ${(a.abThrust / 1000).toFixed(0)}kN · 자중 ${(a.mass / 1000).toFixed(1)}t
         · 롤 ${a.rollRate.toFixed(1)}rad/s · ${a.gLimit}G</u>
      <em>${esc(a.desc)}</em>
    </button>`).join('');
  ui.acList.innerHTML = g.weapons.map((w) => `
    <div class="witem"><i>${w.icon}</i><div><b>${esc(w.label)}</b>
      <span>${esc(w.desc)}</span></div></div>`).join('');
}).catch(() => {});

ui.acPick.addEventListener('click', (e) => {
  const b = e.target.closest('.cls');
  if (!b) return;
  chosenAc = b.dataset.ac;
  localStorage.setItem('skyarena.ac', chosenAc);
  ui.acPick.querySelectorAll('.cls').forEach((x) => x.classList.toggle('on', x === b));
  sfx.resume(); sfx.lock();
});

function loadRecord() {
  const r = JSON.parse(localStorage.getItem('skyarena.record') || '{}');
  ui.record.innerHTML = r.sorties
    ? `출격 <b>${r.sorties}</b>회 · 최고 점수 <b>${r.best}</b> · 누적 격추 <b>${r.kills}</b>`
    : '첫 출격을 기다리는 중';
}
function saveRecord(s) {
  const r = JSON.parse(localStorage.getItem('skyarena.record') || '{}');
  r.sorties = (r.sorties || 0) + 1;
  r.best = Math.max(r.best || 0, s.sc || 0);
  r.kills = (r.kills || 0) + (s.kl || 0);
  localStorage.setItem('skyarena.record', JSON.stringify(r));
}
loadRecord();

// ── 네트워크 ───────────────────────────────────────────────────────
net.on('open', () => {
  ui.conn.textContent = '서버 연결됨 — 출격 준비 완료';
  ui.conn.className = 'conn ok';
  ui.join.disabled = false;
  if (pendingJoin) { pendingJoin = false; doJoin(); }
});
net.on('close', () => {
  ui.conn.textContent = '연결 끊김 — 재연결 시도 중…';
  ui.conn.className = 'conn err';
  ui.join.disabled = true;
});
net.on('full', () => {
  ui.conn.textContent = '방이 가득 찼습니다. 다른 방 이름을 넣어 보세요.';
  ui.conn.className = 'conn err';
});
net.on('welcome', (m) => {
  world.setup(m);
  // 시간대·기상은 방 생성 시 서버가 정해 CFG 로 내려준다(경기 중 고정).
  // 서버가 tod/wx 를 모르면 scene 이 기본값(14.5 / 맑음)을 유지한다.
  scene.applyCfg?.(m.cfg);
  net.saveToken(m.token);
  drawBoard(m.lb);
  ui.roomName.textContent = m.room.toUpperCase();
  ui.home.classList.add('hidden');
  ui.hud.classList.remove('hidden');
  document.body.classList.add('flying');
  input.aim = null;                   // 출격 시 조준점을 기수에 붙여 다시 시작
  // 출격과 동시에 마우스를 잠근다. 잠기지 않으면 커서가 창 밖·화면 끝에
  // 있을 때 이동 신호가 아예 오지 않아 조준이 멈춘 것처럼 보인다.
  input.grabPointer?.();
  if (ctrlMigrated) {
    ctrlMigrated = false;
    banner('조작이 바뀌었습니다 — 마우스는 조준, A·D 만 비틀기 (H)', '#ffcc55');
  } else if (m.resumed) banner('이전 전적을 이어받았습니다', '#8ab4ff');
  // 이미 사람이 있던 방이면 그 방의 난이도를 따른다 — 조용히 넘어가지 않고 알린다
  if (m.difficulty && m.difficulty !== chosenDiff) {
    const label = { training: '훈련', easy: '쉬움', normal: '보통', hard: '어려움' };
    banner(`이 방은 이미 '${label[m.difficulty] || m.difficulty}' 난이도입니다`, '#ffcc55');
  }
  sfx.resume();
});
net.on('j', (m) => world.addPlayer(m));
net.on('l', (m) => world.removePlayer(m.id));
net.on('lb', (m) => drawBoard(m.r));
net.on('s', (m, bytes) => world.onSnapshot(m, bytes));
net.on('ev', (m) => onEvent(m));

net.connect(ui.room.value.trim() || 'main');
ui.join.disabled = true;
pollStats();

// ── 참가 ───────────────────────────────────────────────────────────
let pendingJoin = false;
function doJoin() {
  if (net.joined) return;
  const nick = ui.nick.value.trim() || '무명';
  localStorage.setItem('skyarena.nick', nick);
  sfx.resume();
  if (!net.ready) {
    pendingJoin = true;
    ui.conn.textContent = '연결되는 대로 바로 출격합니다…';
    return;
  }
  net.join(nick, chosenAc, chosenDiff);
  ui.join.disabled = true;
}

// 도움말 오버레이 (H)
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'KeyH') { $('help').classList.toggle('hidden'); syncCursor(); }
  if (e.code === 'Escape') { $('help').classList.add('hidden'); syncCursor(); }
  // 패스별 GPU ms 오버레이. 이 박스에서는 화면 안에 떠야만 계측이 된다.
  if (e.code === 'F3') { e.preventDefault(); scene.togglePerf?.(); }
});
$('help').addEventListener('click', () => { $('help').classList.add('hidden'); syncCursor(); });
$('btn-help').addEventListener('click', () => { $('help').classList.remove('hidden'); syncCursor(); });
$('join-form').addEventListener('submit', (e) => { e.preventDefault(); doJoin(); });
ui.join.addEventListener('click', (e) => { e.preventDefault(); doJoin(); });

$('btn-home').addEventListener('click', () => {
  if (world.srv) saveRecord(world.srv);
  loadRecord();
  document.exitPointerLock?.();
  sfx.stopEngine();
  net.joined = false;
  if (net.ws) net.ws.close();
  world.me = null; world.srv = null;
  ui.hud.classList.add('hidden');
  ui.home.classList.remove('hidden');
  document.body.classList.remove('flying');
  ui.join.disabled = true;
  net.connect(ui.room.value.trim() || 'main');
});

ui.room.addEventListener('change', () => {
  const room = ui.room.value.trim() || 'main';
  net.joined = false;
  history.replaceState({}, '', room === 'main' ? location.pathname : `?room=${encodeURIComponent(room)}`);
  if (net.ws) net.ws.close();
  net.connect(room);
});

$('copy-lan').addEventListener('click', async () => {
  const url = location.origin + (ui.room.value.trim() ? `?room=${encodeURIComponent(ui.room.value.trim())}` : '');
  try { await navigator.clipboard.writeText(url); $('copy-lan').textContent = '복사됨!'; }
  catch { $('copy-lan').textContent = url; }
  setTimeout(() => { $('copy-lan').textContent = '주소 복사'; }, 1600);
});

async function pollStats() {
  try {
    const s = await (await fetch('/stats.json')).json();
    const total = s.rooms.reduce((a, b) => a + b.players, 0);
    ui.srvStat.textContent = `접속 ${total}명 · 방 ${s.rooms.length}개 · 가동 ${Math.floor(s.uptime / 60)}분`;
  } catch { ui.srvStat.textContent = '서버에 연결할 수 없습니다'; }
  setTimeout(pollStats, 5000);
}

// ── 설정 ───────────────────────────────────────────────────────────
// 창이 하나라도 열려 있으면 마우스 포인터를 다시 보여 준다
function syncCursor() {
  const open = !ui.settings.classList.contains('hidden')
            || !$('help').classList.contains('hidden');
  document.body.classList.toggle('ui-open', open);
}
$('btn-settings').addEventListener('click', () => {
  ui.settings.classList.toggle('hidden');
  syncCursor();
});
$('set-close').addEventListener('click', () => {
  ui.settings.classList.add('hidden');
  syncCursor();
});
const bind = (id, get, set) => {
  const el = $(id);
  if (!el) return;          // 설정 항목이 빠진 빌드에서도 부팅은 되어야 한다
  get(el);
  el.addEventListener('input', () => { set(el); saveSet(); });
};
bind('set-sound', (e) => { e.checked = sfx.enabled; }, (e) => sfx.setEnabled(e.checked));
bind('set-vol', (e) => { e.value = sfx.volume; }, (e) => sfx.setVolume(+e.value));
// 실효값을 옆에 띄운다 — cm/360 도 조준점 여유도 숫자를 봐야 조절이 된다
const showVal = (id, text) => { const el = $(id); if (el) el.textContent = text; };
bind('set-cm360', (e) => { e.value = settings.cm360; showVal('val-cm360', `${settings.cm360}cm/360`); },
  (e) => { settings.cm360 = +e.value; showVal('val-cm360', `${settings.cm360}cm/360`); });
bind('set-leash', (e) => { e.value = settings.leash; showVal('val-leash', `${settings.leash}°`); },
  (e) => { settings.leash = +e.value; showVal('val-leash', `${settings.leash}°`); });
bind('set-fov', (e) => { e.value = settings.fov; }, (e) => { settings.fov = +e.value; });
bind('set-invert', (e) => { e.checked = settings.invert; }, (e) => { settings.invert = e.checked; });
bind('set-net', (e) => { e.checked = settings.net; }, (e) => {
  settings.net = e.checked;
  document.querySelectorAll('.net').forEach((x) => x.classList.toggle('hidden', !settings.net));
});
// ── 그래픽 ──────────────────────────────────────────────────────────
bind('set-gfx', (e) => { e.value = settings.gfx; }, (e) => {
  settings.gfx = e.value;
  scene.refreshQuality?.();
});
bind('set-rscale', (e) => { e.value = settings.renderScale; }, (e) => {
  settings.renderScale = +e.value;
  scene.refreshQuality?.();
});
bind('set-adaptive', (e) => { e.checked = settings.adaptive; }, (e) => {
  settings.adaptive = e.checked;
});
bind('set-idboost', (e) => { e.checked = settings.idBoost; }, (e) => {
  settings.idBoost = e.checked;
});
bind('set-cockpit', (e) => { e.checked = settings.cockpit; }, (e) => {
  settings.cockpit = e.checked;
});

// ── HUD 보조 ───────────────────────────────────────────────────────
function drawBoard(rows) {
  world.lb = rows;
  ui.board.innerHTML = rows.map(([id, n, sc, kl, c, de]) =>
    `<li class="${id === world.myId ? 'me' : ''}"><i class="dot" style="background:${c}"></i>` +
    `<span class="nm">${esc(n)}</span><span class="kd">${kl}/${de}</span>` +
    `<span class="sc">${sc}</span></li>`).join('');
}

function onEvent(ev) {
  if (ev.e === 'kill') {
    pushFeed(ev.k
      ? `<b style="color:${ev.kc}">${esc(ev.k)}</b><span class="x">▸ 격추 ▸</span><b style="color:${ev.vc}">${esc(ev.v)}</b>`
      : `<b style="color:${ev.vc}">${esc(ev.v)}</b><span class="x">${ev.g ? '지면 충돌' : '추락'}</span>`);
    if (ev.k === net.nick && ev.s >= 2) banner(`${ev.s}연속 격추!`, '#ffcc55');
  } else if (ev.e === 'boom') {
    world.addBoom(ev.x, ev.y, ev.z, ev.g, ev.w);
  } else if (ev.e === 'launch') {
    // **owner 로 분기하지 않는다.** 예전 `ev.id !== world.myId` 조건은
    // (a) 내 로켓 발사음을 평생 못 나게 했고(유도탄만 world._applyMe 의
    // 잔량 감소 경로로 울렸다) (b) 나·남·봇이 서로 다른 코드를 타게 했다.
    // 3인칭 기본 시점에서 내 기체가 화면에서 가장 크므로 내 발사 섬광이
    // 가장 크게 보여야 할 연출이기도 하다.
    sfx.missile();
    scene.launchFx?.(ev.id);
  }
}

function pushFeed(html) {
  const el = document.createElement('div');
  el.className = 'kill';
  el.innerHTML = html;
  ui.feed.appendChild(el);
  setTimeout(() => el.remove(), 5200);
  while (ui.feed.children.length > 5) ui.feed.firstChild.remove();
}

let bannerT = 0;
function banner(text, color) {
  ui.banner.textContent = text;
  ui.banner.style.color = color;
  ui.banner.classList.add('show');
  clearTimeout(bannerT);
  bannerT = setTimeout(() => ui.banner.classList.remove('show'), 1800);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── 메인 루프 ──────────────────────────────────────────────────────
let last = performance.now();
let sendAcc = 0, seq = 0;
// 서버 tickHz 와 같은 50Hz. 패킷 약 130B 기준 상향 6.5KB/s 라 무시할 만하고,
// 30Hz 에서 오던 최대 33ms 의 입력 지연이 사라진다.
const SEND_HZ = 50;
// 탭에서 돌아온 직후 첫 프레임은 통째로 버린다 — 안 그러면 50ms 짜리 큰
// 스텝이 한 번 들어가 화면이 홱 튄다.
let skipFrame = false;
addEventListener('visibilitychange', () => { if (!document.hidden) skipFrame = true; });

function loop(now) {
  requestAnimationFrame(loop);
  let dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (skipFrame) { skipFrame = false; dt = 0; }

  // 조준은 항상 갱신한다. 격추·재출격 중에만 건너뛰면 그동안 입력이 쌓였다가
  // 살아나는 순간 한꺼번에 튄다.
  const look = input.takeLook();

  if (world.me && world.cfg) {
    // 지면 회피에 필요한 현재 상태를 넘긴다
    if (world.srv) {
      input.flightState = { agl: world.srv.agl, vy: world.srv.vy,
                            speed: world.srv.sp, stalling: !!world.srv.st };
    }
    input.ac = world.ac;
    input.fov = scene.fov;            // FOV 부스트 감도 보정용
    input.uiOpen = !ui.settings.classList.contains('hidden')
                || !$('help').classList.contains('hidden');
    // 격추 중에는 조준을 놓는다. 재출격하면 기수에서 다시 시작한다.
    if (world.srv && !world.srv.al) input.aim = null;

    const hpb = world.me.hpb || quat.toHpb(world.me.q);
    // ── 순서가 핵심이다 ──────────────────────────────────────────
    // 조준을 **이번 프레임** 값으로 먼저 갱신하고, 그 값으로 기수 명령을
    // 만들고, 카메라에도 같은 값을 넘긴다. 예전에는 직전 프레임 카메라를
    // 읽어 16~33ms 를 그냥 버렸다.
    input.updateAim(look, world.me, hpb, dt);
    const cmd = input.sample(dt, world.me, hpb);
    scene.aim = input.aim;

    // 전송값과 예측값을 **비트 단위로** 일치시킨다. 예전에는 toFixed(3) 한
    // 값을 보내고 예측은 원본으로 해서, 선회를 시작하는 순간마다 _applyMe
    // 되감기에서 미세하게 튀었다. invert 는 updateAim 단계에서 이미
    // 처리했으므로 여기서 pitch 를 또 뒤집지 않는다(이중 적용이 된다).
    cmd.pitch = +cmd.pitch.toFixed(3);
    cmd.roll = +cmd.roll.toFixed(3);
    cmd.yaw = +cmd.yaw.toFixed(3);
    cmd.throttle = +cmd.throttle.toFixed(2);
    const aimQ = input.aim ? input.aim.map((v) => +v.toFixed(4)) : null;

    world.predict(dt, cmd, seq);
    if (world.srv?.al) sfx.engine(cmd.throttle, cmd.ab);
    else sfx.stopEngine();          // 격추되면 엔진음도 멎는다

    sendAcc += dt;
    if (sendAcc >= 1 / SEND_HZ) {
      // 0 으로 되돌리지 않는다 — 되돌리면 남은 시간이 버려져 실효 전송률이
      // 프레임률에 따라 흔들린다(드리프트).
      sendAcc -= 1 / SEND_HZ;
      if (sendAcc > 0.2) sendAcc = 0;
      net.send({ t: 'i', q: ++seq,
                 pi: cmd.pitch, ro: cmd.roll, ya: cmd.yaw,
                 th: cmd.throttle, ab: cmd.ab ? 1 : 0, br: cmd.brake ? 1 : 0,
                 f: cmd.fire ? 1 : 0, ms: cmd.missile ? 1 : 0, fl: cmd.flare ? 1 : 0,
                 // tb(공중제비)는 이제 쓰지 않는다. 프로토콜은 건드리지 않기로
                 // 했으므로 필드만 남기고 0 으로 고정한다.
                 w: cmd.weapon, tb: 0,
                 aim: aimQ });
    }
  } else {
    // 비행 중이 아닐 때는 엔진음을 반드시 끈다(안 그러면 계속 울린다)
    sfx.stopEngine();
  }

  scene.frame(dt);
  hud.draw();
  updateHud();
  // 포인터 락이 풀렸으면 다시 클릭하도록 알려 준다
  const needLock = net.joined && !input.isTouch && !input.pointerLocked
                && ui.settings.classList.contains('hidden')
                && $('help').classList.contains('hidden');
  $('lock-hint').classList.toggle('hidden', !needLock);
  if (needLock) {
    $('lock-hint').textContent = input.lockError
      || '화면을 한 번 클릭하세요 — 클릭해야 마우스로 조종할 수 있습니다';
  }
}

function updateHud() {
  const s = world.srv;
  if (!s) return;
  ui.score.textContent = s.sc;
  ui.kills.textContent = s.kl;
  ui.ping.textContent = net.ping;
  ui.fps.textContent = scene.fps;
  ui.kbps.textContent = world.stats.kbps;
  ui.hpBar.style.width = `${Math.max(0, s.hp)}%`;
  if (s.al) ui.respawn.classList.add('hidden');
  else {
    ui.respawn.classList.remove('hidden');
    ui.respawnT.textContent = Math.ceil(s.rt);
    ui.killedBy.innerHTML = s.kb ? `<b>${esc(s.kb)}</b> 에게 격추당했습니다` : '지면에 충돌했습니다';
  }
}

requestAnimationFrame(loop);

// 헤드리스 검증용. 이 박스는 브라우저 패널이 숨겨져 rAF 가 멈추므로,
// 조작 수치는 전부 이 step 을 손으로 돌려서 잰다.
window.sky = {
  net, world, input, scene, hud, sfx, settings,
  step: (dt = 1 / 60) => {
    if (world.me) {
      const hpb = world.me.hpb || quat.toHpb(world.me.q);
      input.updateAim(input.takeLook(), world.me, hpb, dt);
      const cmd = input.sample(dt, world.me, hpb);
      scene.aim = input.aim;
      world.predict(dt, cmd, seq);
    }
    scene.frame(dt); hud.draw(); updateHud();
  },
};
