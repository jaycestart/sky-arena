// 부팅 · 홈 화면 · 게임 루프 · HUD 연결
import { Net } from './net.js';
import { Input } from './input.js';
import { World } from './world.js';
import { Renderer } from './render.js';
import { Sfx } from './audio.js';

const $ = (id) => document.getElementById(id);

// ── 설정(localStorage 영속) ────────────────────────────────────────
const settings = {
  sens: +(localStorage.getItem('skyarena.sens') ?? 1),
  autofire: localStorage.getItem('skyarena.auto') === '1',
  quality: localStorage.getItem('skyarena.quality') || 'auto',
  net: localStorage.getItem('skyarena.net') === '1',
};
const saveSet = () => {
  localStorage.setItem('skyarena.sens', settings.sens);
  localStorage.setItem('skyarena.auto', settings.autofire ? '1' : '0');
  localStorage.setItem('skyarena.quality', settings.quality);
  localStorage.setItem('skyarena.net', settings.net ? '1' : '0');
};

const cv = $('game');
const sfx = new Sfx();
const world = new World(sfx);
const input = new Input(cv, settings);
const rend = new Renderer(cv, world, settings);
const net = new Net();
input.onAny = () => sfx.resume();

const ui = {
  home: $('home'), hud: $('hud'), conn: $('conn'), join: $('join'), nick: $('nick'),
  room: $('room'), score: $('s-score'), kills: $('s-kills'), level: $('s-level'),
  ping: $('s-ping'), fps: $('s-fps'), kbps: $('s-kbps'),
  hp: $('bar-hp'), sh: $('bar-sh'), en: $('bar-en'), heat: $('bar-heat'),
  roll: $('bar-roll'), ammo: $('ammo'), weapons: $('weapons'),
  feed: $('feed'), board: $('board-list'), banner: $('banner'), warn: $('warn'),
  respawn: $('respawn'), respawnT: $('respawn-t'), killedBy: $('killed-by'),
  specNote: $('spec-note'), touch: $('touch'), roomName: $('room-name'),
  srvStat: $('server-stat'), settings: $('settings'), classPick: $('class-pick'),
  weaponList: $('weapon-list'), record: $('record'),
};

ui.nick.value = localStorage.getItem('skyarena.nick') || '';
ui.room.value = new URLSearchParams(location.search).get('room') || '';
if (input.isTouch) {
  ui.touch.classList.remove('hidden');
  if (localStorage.getItem('skyarena.auto') === null) settings.autofire = true;
}
document.querySelectorAll('.net').forEach((e) => e.classList.toggle('hidden', !settings.net));

// ── PWA: 서비스 워커 + 설치 ────────────────────────────────────────
if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
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
if (installed) {
  $('install-card').classList.add('hidden');
} else {
  $('btn-install').disabled = true;
  $('install-hint').textContent =
    '설치 버튼이 잠겨 있으면 브라우저 주소창 오른쪽의 설치 아이콘(⊞)을 눌러도 됩니다. '
    + 'iPhone 은 공유 → “홈 화면에 추가”.';
}
$('btn-install').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  $('install-hint').textContent = outcome === 'accepted' ? '설치했습니다!' : '설치를 취소했습니다.';
});

// ── 기체 / 무기 목록 (서버 값으로 그린다) ──────────────────────────
let chosenClass = localStorage.getItem('skyarena.cls') || 'striker';
const CLASS_ICON = { interceptor: '⟁', striker: '◆', bomber: '⬢' };
let weaponMeta = [];

fetch('/game.json').then((r) => r.json()).then((g) => {
  weaponMeta = g.weapons;
  ui.classPick.innerHTML = Object.entries(g.classes).map(([k, m]) => `
    <button type="button" class="cls ${k === chosenClass ? 'on' : ''}" data-cls="${k}">
      <i>${CLASS_ICON[k] || '◆'}</i><b>${esc(m.label)}</b><span>${esc(m.desc)}</span>
      <u>속도 ×${m.speed} · 선회 ×${m.turn} · 체력 ×${m.hp} · 화력 ×${m.dmg}</u>
    </button>`).join('');
  ui.weaponList.innerHTML = g.weapons.map((w, i) => `
    <div class="witem">
      <i>${w.icon}</i>
      <div><b>${esc(w.label)}</b><span>${esc(w.desc)}</span>
        <u>피해 ${w.dmg}${w.count > 1 ? `×${w.count}` : ''} · 연사 ${w.cd}s · 사거리 ${Math.round(w.speed * w.life)}${w.pierce ? ` · 관통 ${w.pierce}` : ''}${w.splash ? ` · 범위 ${w.splash}` : ''}</u>
      </div><kbd>${i + 1}</kbd>
    </div>`).join('');
}).catch(() => { ui.weaponList.textContent = '무기 정보를 불러오지 못했습니다.'; });

ui.classPick.addEventListener('click', (e) => {
  const btn = e.target.closest('.cls');
  if (!btn) return;
  chosenClass = btn.dataset.cls;
  localStorage.setItem('skyarena.cls', chosenClass);
  ui.classPick.querySelectorAll('.cls').forEach((b) => b.classList.toggle('on', b === btn));
  sfx.resume(); sfx.lock();
});

// 지난 전적(로컬 저장)
function loadRecord() {
  const r = JSON.parse(localStorage.getItem('skyarena.record') || '{}');
  if (!r.games) { ui.record.textContent = '첫 출격을 기다리는 중'; return; }
  ui.record.innerHTML = `출격 <b>${r.games}</b>회 · 최고 점수 <b>${r.best}</b> · `
    + `누적 격추 <b>${r.kills}</b> · 최다 연속 <b>${r.streak}</b>`;
}
function saveRecord(s) {
  const r = JSON.parse(localStorage.getItem('skyarena.record') || '{}');
  r.games = (r.games || 0) + 1;
  r.best = Math.max(r.best || 0, s.sc || 0);
  r.kills = (r.kills || 0) + (s.kl || 0);
  r.streak = Math.max(r.streak || 0, s.st || 0);
  localStorage.setItem('skyarena.record', JSON.stringify(r));
}
loadRecord();

// ── 네트워크 이벤트 ─────────────────────────────────────────────────
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
  net.saveToken(m.token);
  drawBoard(m.lb);
  ui.roomName.textContent = m.room.toUpperCase();
  buildWeaponHud(m.weapons);
  ui.home.classList.add('hidden');
  ui.hud.classList.remove('hidden');
  if (m.resumed) banner('이전 전적을 이어받았습니다', '#8ab4ff');
  sfx.resume();
});
net.on('j', (m) => world.addPlayer(m));
net.on('l', (m) => world.removePlayer(m.id));
net.on('lb', (m) => drawBoard(m.r));
net.on('s', (m, bytes) => world.onSnapshot(m, bytes));
net.on('ev', (m) => onEvent(m));
net.on('em', (m) => {
  const icons = ['👍', '😂', '🔥', '😱'];
  pushFeed(`<b style="color:${m.c}">${esc(m.n)}</b> <span style="font-size:15px">${icons[m.i] || '💬'}</span>`);
});

net.connect(ui.room.value.trim() || 'main');
ui.join.disabled = true;
pollStats();

// ── 참가 / 홈 복귀 ─────────────────────────────────────────────────
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
  net.join(nick, chosenClass);
  ui.join.disabled = true;
}

$('join-form').addEventListener('submit', (e) => { e.preventDefault(); doJoin(); });
ui.join.addEventListener('click', (e) => { e.preventDefault(); doJoin(); });

$('btn-home').addEventListener('click', () => {
  if (world.srv) saveRecord(world.srv);
  loadRecord();
  net.joined = false;
  if (net.ws) net.ws.close();
  world.me = null; world.srv = null;
  ui.hud.classList.add('hidden');
  ui.home.classList.remove('hidden');
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
  try {
    await navigator.clipboard.writeText(url);
    $('copy-lan').textContent = '복사됨!';
  } catch {
    $('copy-lan').textContent = url;
  }
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

// ── 설정 UI ────────────────────────────────────────────────────────
$('btn-settings').addEventListener('click', () => ui.settings.classList.toggle('hidden'));
$('set-close').addEventListener('click', () => ui.settings.classList.add('hidden'));
const bind = (id, get, set) => {
  const el = $(id);
  get(el);
  el.addEventListener('input', () => { set(el); saveSet(); });
};
bind('set-sound', (e) => { e.checked = sfx.enabled; }, (e) => sfx.setEnabled(e.checked));
bind('set-vol', (e) => { e.value = sfx.volume; }, (e) => sfx.setVolume(+e.value));
bind('set-sens', (e) => { e.value = settings.sens; }, (e) => { settings.sens = +e.value; });
bind('set-auto', (e) => { e.checked = settings.autofire; }, (e) => { settings.autofire = e.checked; });
bind('set-quality', (e) => { e.value = settings.quality; }, (e) => { settings.quality = e.value; });
bind('set-net', (e) => { e.checked = settings.net; }, (e) => {
  settings.net = e.checked;
  document.querySelectorAll('.net').forEach((x) => x.classList.toggle('hidden', !settings.net));
});

// ── 무기 HUD ───────────────────────────────────────────────────────
function buildWeaponHud(weapons) {
  ui.weapons.innerHTML = (weapons || []).map((w, i) => `
    <button class="wslot ${i === input.weapon ? 'on' : ''}" data-w="${i}">
      <i>${w.icon}</i><b>${esc(w.label)}</b><kbd>${i + 1}</kbd>
    </button>`).join('');
}
ui.weapons.addEventListener('click', (e) => {
  const b = e.target.closest('.wslot');
  if (b) selectWeapon(+b.dataset.w);
});
function selectWeapon(i) {
  input.weapon = i;
  ui.weapons.querySelectorAll('.wslot').forEach((b, n) => b.classList.toggle('on', n === i));
  sfx.lock();
}
input.onWeapon = selectWeapon;

// ── HUD ────────────────────────────────────────────────────────────
function drawBoard(rows) {
  world.lb = rows;
  ui.board.innerHTML = rows.map(([id, n, sc, kl, c, de, lv]) =>
    `<li class="${id === world.myId ? 'me' : ''}">` +
    `<i class="dot" style="background:${c}"></i>` +
    `<span class="nm">${esc(n)}${lv > 1 ? ` <em>L${lv}</em>` : ''}</span>` +
    `<span class="kd">${kl}/${de}</span><span class="sc">${sc}</span></li>`).join('');
}

function onEvent(ev) {
  if (ev.e === 'kill') {
    pushFeed(ev.k
      ? `<b style="color:${ev.kc}">${esc(ev.k)}</b><span class="x">▸ 격추 ▸</span>` +
        `<b style="color:${ev.vc}">${esc(ev.v)}</b>` + (ev.s > 1 ? `<span class="st">${ev.s}연속</span>` : '')
      : `<b style="color:${ev.vc}">${esc(ev.v)}</b><span class="x">추락</span>`);
    if (ev.k === net.nick && ev.s >= 2) {
      banner(ev.s >= 5 ? `${ev.s}연속 격추 — 무쌍!` : `${ev.s}연속 격추!`, '#ffd166');
    }
  } else if (ev.e === 'assist') {
    pushFeed(`<b style="color:${ev.kc}">${esc(ev.k)}</b><span class="x">어시스트</span>`);
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

// 퀵챗 — 숫자키는 무기 교체에 쓰므로 Z X C V
const sendEmote = (i) => net.send({ t: 'emote', i });
document.querySelectorAll('#emotes button').forEach((b) =>
  b.addEventListener('click', () => sendEmote(+b.dataset.emote)));
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const n = ['KeyZ', 'KeyX', 'KeyC', 'KeyV'].indexOf(e.code);
  if (n >= 0 && net.joined) sendEmote(n);
});

// ── 메인 루프 ──────────────────────────────────────────────────────
let last = performance.now();
let sendAcc = 0, seq = 0;
const SEND_HZ = 30;

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (world.me && world.cfg) {
    const sx = innerWidth / 2 + (world.me.x - rend.cam.x) * rend.cam.scale;
    const sy = innerHeight / 2 + (world.me.y - rend.cam.y) * rend.cam.scale;
    const cmd = input.sample(sx, sy, world.me.a);
    world.predict(dt, cmd, seq);
    sfx.boost(!!(cmd.boost && world.srv?.al && world.srv.en > 1));

    sendAcc += dt;
    if (sendAcc >= 1 / SEND_HZ) {
      sendAcc = 0;
      net.send({ t: 'i', q: ++seq, u: +cmd.turn.toFixed(3), h: +cmd.throttle.toFixed(2),
                 b: cmd.boost ? 1 : 0, f: cmd.fire ? 1 : 0,
                 ms: cmd.missile ? 1 : 0, rl: cmd.roll ? 1 : 0, w: cmd.weapon });
    }
  }

  rend.frame(dt);
  updateHud();
}

function updateHud() {
  const s = world.srv;
  if (!s) return;
  const hpMax = s.hm || 100;
  ui.score.textContent = s.sc;
  ui.kills.textContent = s.kl;
  ui.level.textContent = s.lv;
  ui.ping.textContent = net.ping;
  ui.fps.textContent = rend.fps;
  ui.kbps.textContent = net.rx;
  ui.hp.style.width = `${Math.max(0, s.hp / hpMax * 100)}%`;
  ui.sh.style.width = `${Math.max(0, s.sh / (world.cfg.shieldMax || 60) * 100)}%`;
  ui.en.style.width = `${Math.max(0, s.en)}%`;
  ui.heat.style.width = `${Math.max(0, s.he / world.cfg.heatMax * 100)}%`;
  ui.heat.parentElement.classList.toggle('over', !!s.ov);
  ui.roll.style.width = `${100 - Math.min(100, s.rc / world.cfg.rollCd * 100)}%`;
  ui.warn.classList.toggle('hidden', !s.lw);

  if (ui.ammo.childElementCount !== world.cfg.msAmmo) {
    ui.ammo.innerHTML = Array.from({ length: world.cfg.msAmmo }, () => '<i></i>').join('');
  }
  [...ui.ammo.children].forEach((el, i) => el.classList.toggle('on', i < s.ms));

  if (s.al) ui.respawn.classList.add('hidden');
  else {
    ui.respawn.classList.remove('hidden');
    ui.respawnT.textContent = Math.ceil(s.rt);
    ui.killedBy.innerHTML = s.kb ? `<b>${esc(s.kb)}</b> 에게 당했습니다` : '스스로 추락했습니다';
    ui.specNote.textContent = rend.spectate ? `${s.kb} 관전 중` : '';
  }
}

requestAnimationFrame(loop);

// 콘솔 디버그 훅
window.sky = {
  net, world, input, rend, sfx, settings, selectWeapon,
  step: (dt = 1 / 60) => { world.predict(dt, input.cmd, seq); rend.frame(dt); updateHud(); },
};
