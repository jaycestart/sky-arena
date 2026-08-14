// 전투기 HUD — 2D 캔버스 오버레이.
// 피치 사다리 · 속도/고도 테이프 · 방위 테이프 · 비행경로 지시자 ·
// 기총 조준점(리드 계산) · 레이더 락온 · 경고
import { quat, v3, clamp } from './m3d.js';

const GREEN = '#7dfba6';
const AMBER = '#ffcc55';
const RED = '#ff5f6d';

export class Hud {
  constructor(canvas, world, scene, input) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.scene = scene;
    this.input = input;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    // HUD 는 3D 렌더 스케일과 무관하게 네이티브 DPR 을 쓴다 — 텍스트 선명도
    // 때문이다. 3D 를 0.7 로 낮춰도 글자는 그대로 또렷해야 한다.
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.w = Math.max(1, innerWidth);
    this.h = Math.max(1, innerHeight);
    this.cv.width = Math.round(this.w * dpr);
    this.cv.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 저빈도 요소용 오프스크린. 스냅샷이 25Hz 인데 60Hz 로 다시 그릴 이유가 없다.
    if (!this.slow) this.slow = document.createElement('canvas');
    this.slow.width = this.cv.width;
    this.slow.height = this.cv.height;
    this.sctx = this.slow.getContext('2d');
    this.sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.slowT = 0;
  }

  draw() {
    const ctx = this.ctx, W = this.world, s = W.srv;
    ctx.clearRect(0, 0, this.w, this.h);
    if (this.scene?.showPerf) this.perf(ctx);
    if (!s || !W.me) return;

    const cx = this.w / 2, cy = this.h / 2;
    const q = W.me.q;
    const f = quat.fwd(q);
    const hdg = (Math.atan2(f[0], f[2]) + Math.PI * 2) % (Math.PI * 2);

    // ── 저빈도 레이어 (30Hz) ──────────────────────────────────────
    const now = performance.now();
    if (now - this.slowT > 33 || this._wasAlive !== !!s.al) {
      this.slowT = now;
      this._wasAlive = !!s.al;
      const g = this.sctx;
      g.clearRect(0, 0, this.w, this.h);
      this.style(g, s);
      this.headingTape(g, cx, hdg);
      this.tape(g, 78, cy, s.sp, 'SPD', 'M' + s.mach.toFixed(2), true);
      this.tape(g, this.w - 78, cy, s.y, 'ALT', 'R' + Math.round(s.agl) + 'm', false);
      this.radar(g, hdg);
      this.corners(g, s);
      this.targetPanel(g);
      this.warnings(g, cx, cy, s);
      g.restore();
    }
    ctx.drawImage(this.slow, 0, 0, this.w, this.h);

    // ── 매 프레임 레이어 ─────────────────────────────────────────
    this.style(ctx, s);
    this.flightPath(ctx, cx, cy);
    this.gunsight(ctx, cx, cy);
    this.targets(ctx);
    this.offscreen(ctx, cx, cy);
    this.hitMarker(ctx, cx, cy);
    ctx.restore();
  }

  style(ctx, s) {
    ctx.save();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = GREEN;
    ctx.fillStyle = GREEN;
    ctx.font = '600 13px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = s.al ? 1 : 0.35;
  }

  /** F3 — 패스별 GPU ms. 이 박스에서는 화면 안에 떠야만 계측이 된다. */
  perf(ctx) {
    const sc = this.scene;
    const ms = sc.timer?.ms || {};
    const order = ['sky', 'terrain', 'water', 'solid', 'particles', 'post'];
    let total = 0;
    for (const k of order) total += ms[k] || 0;
    const rows = order.map((k) => `${k.padEnd(10)}${(ms[k] || 0).toFixed(2)}ms`);
    rows.push(`${'합계'.padEnd(9)}${total.toFixed(2)}ms`);
    rows.push(`fps ${sc.fps}  draw ${sc.drawCalls}`);
    rows.push(`q ${sc.q?.name}/${sc.deg}  rs ${(sc.q?.renderScale || 1).toFixed(2)}`
              + `  ${sc.pw}x${sc.ph}`);
    rows.push(`gl${sc.gl2 ? '2' : '1'} post:${sc.usePost ? 'on' : 'off'} `
              + `bake:${sc.bakeReady ? (sc.bakeMs | 0) + 'ms' : '…'}`
              + (sc.timer?.ext ? '' : ' (cpu)'));
    if (sc.progFail?.size) rows.push('실패: ' + [...sc.progFail].join(','));
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = '600 11px ui-monospace, Consolas, monospace';
    const y0 = this.h - 18 - rows.length * 14;
    ctx.fillStyle = 'rgba(0,0,0,.62)';
    ctx.fillRect(8, y0 - 6, 240, rows.length * 14 + 12);
    ctx.fillStyle = '#8affd8';
    rows.forEach((t, i) => ctx.fillText(t, 14, y0 + i * 14));
    ctx.restore();
  }

  // 화면 중앙의 피치 사다리는 어지럽다는 지적을 받아 걷어냈다. 되살리지 말 것.
  // 남아 있던 pitchLadder() 는 draw() 가 부르지 않는 죽은 코드라 지웠다.

  // ── 방위 테이프 ───────────────────────────────────────────────
  headingTape(ctx, cx, hdg) {
    const deg = hdg * 180 / Math.PI;
    const y = 46, span = 60, pxPerDeg = 4.6;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx - span * pxPerDeg / 2, y + 12);
    ctx.lineTo(cx + span * pxPerDeg / 2, y + 12);
    ctx.stroke();
    for (let d = Math.floor((deg - span / 2) / 5) * 5; d <= deg + span / 2; d += 5) {
      const x = cx + ((d - deg) * pxPerDeg);
      const dd = ((d % 360) + 360) % 360;
      ctx.beginPath();
      ctx.moveTo(x, y + 12);
      ctx.lineTo(x, y + (dd % 10 === 0 ? 4 : 8));
      ctx.stroke();
      if (dd % 10 === 0) {
        ctx.font = '600 11px ui-monospace, monospace';
        const label = dd === 0 ? 'N' : dd === 90 ? 'E' : dd === 180 ? 'S' : dd === 270 ? 'W'
          : String(dd / 10).padStart(2, '0');
        ctx.fillText(label, x, y - 6);
      }
    }
    ctx.beginPath();
    ctx.moveTo(cx, y + 12); ctx.lineTo(cx - 6, y + 21); ctx.lineTo(cx + 6, y + 21);
    ctx.closePath();
    ctx.fill();
    ctx.font = '700 14px ui-monospace, monospace';
    ctx.fillText(String(Math.round(deg)).padStart(3, '0'), cx, y + 34);
    ctx.restore();
  }

  // ── 속도/고도 테이프 ──────────────────────────────────────────
  tape(ctx, x, cy, value, label, sub, left) {
    const h = 190, step = 20, pxPer = 2.6;
    ctx.save();
    ctx.strokeRect(x - 34, cy - h / 2, 68, h);
    ctx.beginPath();
    const start = Math.floor((value - h / 2 / pxPer) / step) * step;
    for (let v = start; v < value + h / 2 / pxPer; v += step) {
      const y = cy + (value - v) * pxPer;
      if (y < cy - h / 2 + 2 || y > cy + h / 2 - 2) continue;
      const long = v % 100 === 0;
      ctx.moveTo(left ? x + 34 : x - 34, y);
      ctx.lineTo(left ? x + 34 - (long ? 14 : 7) : x - 34 + (long ? 14 : 7), y);
      if (long) {
        ctx.save();
        ctx.font = '600 10px ui-monospace, monospace';
        ctx.textAlign = left ? 'left' : 'right';
        ctx.fillText(String(Math.round(v)), left ? x - 30 : x + 30, y);
        ctx.restore();
      }
    }
    ctx.stroke();
    // 현재값 박스
    ctx.fillStyle = 'rgba(0,20,10,.75)';
    ctx.fillRect(x - 34, cy - 12, 68, 24);
    ctx.strokeRect(x - 34, cy - 12, 68, 24);
    ctx.fillStyle = GREEN;
    ctx.textAlign = 'center';
    ctx.font = '700 15px ui-monospace, monospace';
    ctx.fillText(String(Math.round(value)), x, cy);
    ctx.font = '600 10px ui-monospace, monospace';
    ctx.fillText(label, x, cy - h / 2 - 12);
    ctx.fillText(sub, x, cy + h / 2 + 12);
    ctx.restore();
  }

  // ── 비행경로 지시자(속도 벡터) — 곁가지 없이 작은 원만 ─────────
  flightPath(ctx, cx, cy) {
    const W = this.world, s = W.srv;
    const vel = [s.vx, s.vy, s.vz];
    if (v3.len(vel) < 5) return;
    const p = this.scene.project(v3.add(W.me.pos, v3.mul(v3.norm(vel), 900)));
    if (!p) return;
    ctx.save();
    ctx.globalAlpha *= 0.7;
    ctx.beginPath();
    ctx.arc(p[0], p[1], 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** 지금 쏘면 탄이 어디로 가는지(피퍼) + 맞히려면 어디를 겨눠야 하는지(리드 마커) */
  gunsight(ctx, cx, cy) {
    const W = this.world, s = W.srv;
    // 예전에는 s.w !== 0 이면 여기서 나가버렸다. 그런데 서버의 _launch 는
    // 무기 선택값을 아예 보지 않는다 — 좌클릭은 언제나 로켓, 우클릭은
    // 언제나 유도탄이다. 그래서 2 번 키를 누르면 조준경만 사라지고 발사는
    // 그대로 되는, 규칙과 화면이 어긋난 상태가 됐다. 선택은 표시일 뿐이니
    // 조준경은 항상 그린다.
    const me = W.me.pos;
    const myVel = [s.vx, s.vy, s.vz];
    const g = 9.80665;
    // 로켓 제원은 welcome 으로 내려온 값만 쓴다. 숫자를 손으로 베껴 두면
    // 서버를 고쳤을 때 화면만 조용히 어긋난다 — targets() 의 lockTime 이
    // 정확히 그렇게 어긋난 적이 있다. 여기에도 muzzle 1030 · 사거리 2880
    // 이라는, 지금 서버 어디에도 없는 숫자가 폴백으로 박혀 있었다
    // (실제 제원은 900m/s · 13,980m). 제원이 아직 안 왔으면(welcome 전
    // 한두 프레임) 리드도 사거리 판정도 건너뛴다 — 모르면 말을 안 한다.
    const spec0 = W.weapons?.[0];
    const accel = spec0 ? spec0.thrust / spec0.mass : 0;
    // 로켓이 수명 동안 갈 수 있는 거리. burn 초는 등가속, 그 뒤는 다 태워
    // 얻은 속도(muzzle + accel*burn)로 등속.
    //
    // **사거리를 계산하는 곳은 여기 하나뿐이어야 한다.** 예전에는 SHOOT
    // 판정이 이 등가속 식을, 바로 아래 '사거리 밖' 배지가 옛 등속 식
    // (muzzle * life = 6,300m)을 따로 썼다. 실제 도달 거리를 서버
    // _step_missiles 로 적분해 재면 출격 속도 450m/s 에서 14,177m 라
    // 등속 식은 2.2배 짧다. 그래서 락온 거리 6.3~9km 에서 'SHOOT' 과
    // '사거리 밖'이 같은 화면에 동시에 떴다 — 한쪽은 쏘라고, 한쪽은
    // 안 닿는다고. 항력을 빼고 발사기 속도도 빼면 두 오차가 서로 상쇄돼
    // 이 식이 실측의 −1.4% 안에 든다(1450m/s 에서는 33% 보수적이다 —
    // '못 닿는다'고 말하는 쪽은 보수적인 게 안전하다).
    const maxR = spec0
      ? spec0.muzzle * spec0.burn + 0.5 * accel * spec0.burn * spec0.burn
        + (spec0.muzzle + accel * spec0.burn) * (spec0.life - spec0.burn)
      : 0;

    // 가장 유력한 목표: 락온 대상, 없으면 조준선에 가장 가까운 적
    let tgt = W.byId(s.lk);
    if (!tgt) {
      const f = quat.fwd(W.me.q);
      let best = null, bestDot = 0.90;
      for (const p of W.view()) {
        if (!p.alive || p.id === W.myId) continue;
        const rel = v3.sub(p.pos, me);
        const d = v3.len(rel);
        if (d > 3000) continue;
        const dot = v3.dot(v3.norm(rel), f);
        if (dot > bestDot) { bestDot = dot; best = p; }
      }
      tgt = best;
    }

    const range = tgt ? Math.max(120, v3.len(v3.sub(tgt.pos, me))) : 800;

    // ── 조준점과 보어사이트 ───────────────────────────────────────
    // 조작 체계 전체가 '시선과 기수의 분리' 위에 서 있다. 그 분리가 화면에
    // 안 보이면 조준 기동 피드백이 통째로 없는 것과 같다.
    // 십자를 화면 중앙에 못 박지 않고 **총구 기준으로 투영**한다: 탄은
    // 기체 위치에서 나가는데(game.py `muzzle = pos + f*12`) 외부 시점 카메라는
    // 62m 뒤에 있어, 근거리 목표에서 화면 중앙과 실탄착이 어긋난다.
    const nose = quat.fwd(W.me.q);
    const aimDir = this.input?.aim || nose;
    let pip = this.scene.project(v3.add(me, v3.mul(aimDir, range)));
    // 투영 실패(뒤쪽)거나 거의 중앙이면 중앙으로 스냅한다 —
    // '십자는 한가운데 있어야 한다'는 직관과 싸우지 않게.
    if (!pip || Math.hypot(pip[0] - cx, pip[1] - cy) < 8) pip = [cx, cy];
    const bore = this.scene.project(v3.add(me, v3.mul(nose, range)));
    const aimOff = Math.acos(clamp(v3.dot(aimDir, nose), -1, 1));
    // 서버 aim_dir(max_off=1.15rad) 과 반드시 같은 값이어야 한다.
    // 넘어가면 탄이 조준점이 아니라 원뿔 경계로 나간다.
    const outside = aimOff > 1.15;

    // 리드 마커: 목표를 맞히려면 기수를 향해야 할 지점.
    //
    // 로켓은 등속이 아니다. 발사 후 burn 초 동안 thrust/mass 로 가속한다
    // (game.py 의 WEAPONS[0]). 예전에는 t = range/muzzle 로 등속 가정을
    // 했는데, 1000m 표적에서 등속 해는 1.11초, 실제 등가속 해는 0.776초라
    // 리드가 43% 과다했다 — HUD 가 찍어 주는 곳으로 겨누면 표적을 앞질러
    // 빗나갔다. 봇은 이미 등가속으로 계산하고 있었고(game.py _bot_think),
    // 사람 쪽만 옛 식으로 남아 있었다.
    //
    // 그리고 반복문이 아무 일도 하지 않았다. 루프 안에서 t 를 다시
    // range/muzzle 로 되돌려서 세 번 돌아도 한 번 돈 것과 결과가 같았다.
    // 주석은 '2회 반복 수렴'이라 적혀 있었는데 수렴 절차 자체가 없었다.
    let lead = null, aligned = false;
    if (tgt && pip && spec0) {
      const muzzle = spec0.muzzle, burn = spec0.burn;
      // 거리 d 를 나는 데 걸리는 시간. burn 안에 도달하면 등가속 해,
      // 그 뒤로는 다 태우고 얻은 속도로 등속.
      const flightTime = (d) => {
        const dBurn = muzzle * burn + 0.5 * accel * burn * burn;
        if (d <= dBurn) {
          return (Math.sqrt(muzzle * muzzle + 2 * accel * d) - muzzle) / accel;
        }
        return burn + (d - dBurn) / (muzzle + accel * burn);
      };
      let t = flightTime(range);
      let aim = null;
      // ⚠ 이 반복문은 **아직도 아무 일도 하지 않는다.** 위 주석이 '이번에는
      // 진짜로 수렴시킨다' 고 적어 두었지만 사실이 아니다 — aim 을 언제나
      // `me + dn * range` 로, 즉 반지름 range 인 구면 위로 되쏘기 때문에
      // |aim − me| 가 항등적으로 range 다. 그래서 t = flightTime(range) 가
      // 매 회차 같은 값으로 다시 계산되고 세 회차의 dn 이 소수점 아래까지
      // 똑같다(실측: 800m 교차 표적에서 세 번 모두 t=0.652417s).
      // 제대로 수렴시키려면 표적의 **미래 위치까지의 상대거리**
      // |rel + (tv − myVel)·t| 로 t 를 다시 구해야 한다. 그렇게 고치면 같은
      // 표적에서 t 가 0.433s(−50.6%), 조준 방향이 24.8도 옮겨간다.
      // 어느 모델이 옳은지는 아직 못 박지 못했다 — BACKLOG 'HUD 리드 마커의
      // 수렴 루프' 항목에 측정과 함께 넘겼다. 지금은 **동작을 바꾸지 않는다.**
      for (let i = 0; i < 3; i++) {
        const rel = v3.sub(tgt.pos, me);
        const tv = tgt.vel || [0, 0, 0];
        const dir = v3.add(v3.add(v3.mul(rel, 1 / t), v3.sub(tv, myVel)),
                           [0, 0.5 * g * t, 0]);
        const dn = v3.norm(dir);
        aim = v3.add(me, v3.mul(dn, range));
        t = flightTime(v3.len(v3.sub(aim, me)));
      }
      lead = this.scene.project(aim);
      // 탄이 조준 원 방향으로 나가므로, 원이 리드 지점에 닿으면 명중이다
      if (lead) {
        // 원뿔 밖이면 탄이 조준점으로 나가지 않으므로 SHOOT 을 띄우면 거짓말이다
        aligned = !outside && range <= maxR
          && Math.hypot(lead[0] - pip[0], lead[1] - pip[1]) < 30;
      }
    }

    ctx.save();
    // 보어사이트(기수가 실제로 향하는 곳) — 점선 작은 원.
    // 조준점과 3도 넘게 벌어지면 둘을 잇는 가는 선을 긋는다. 기수가 얼마나
    // 뒤처졌는지가 그대로 보이고, 이게 조준 기동 피드백의 전부다.
    if (bore) {
      ctx.save();
      ctx.globalAlpha *= 0.8;
      ctx.strokeStyle = GREEN;
      ctx.lineWidth = 1.4;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(bore[0], bore[1], 6, 0, Math.PI * 2);
      ctx.stroke();
      if (aimOff > 0.052) {
        ctx.globalAlpha *= 0.65;
        ctx.beginPath();
        ctx.moveTo(bore[0], bore[1]);
        ctx.lineTo(pip[0], pip[1]);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (pip) {
      if (outside) {
        // 원뿔 밖 — 지금 쏘면 탄이 조준점이 아니라 원뿔 경계로 나간다
        ctx.strokeStyle = '#ff9a3c';
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(pip[0] - 9, pip[1] - 9); ctx.lineTo(pip[0] + 9, pip[1] + 9);
        ctx.moveTo(pip[0] + 9, pip[1] - 9); ctx.lineTo(pip[0] - 9, pip[1] + 9);
        ctx.stroke();
      } else {
        // 탄이 실제로 지나가는 지점의 작은 십자
        ctx.strokeStyle = aligned ? '#ff4d4d' : GREEN;
        ctx.lineWidth = aligned ? 2.6 : 2;
        ctx.beginPath();
        ctx.moveTo(pip[0] - 10, pip[1]); ctx.lineTo(pip[0] - 3, pip[1]);
        ctx.moveTo(pip[0] + 3, pip[1]); ctx.lineTo(pip[0] + 10, pip[1]);
        ctx.moveTo(pip[0], pip[1] - 10); ctx.lineTo(pip[0], pip[1] - 3);
        ctx.moveTo(pip[0], pip[1] + 3); ctx.lineTo(pip[0], pip[1] + 10);
        ctx.stroke();
        ctx.fillStyle = aligned ? '#ff4d4d' : GREEN;
        ctx.fillRect(pip[0] - 1, pip[1] - 1, 2, 2);
      }
    }
    if (lead) {
      // 겨눠야 할 지점 — 굵은 마름모. 여기로 피퍼를 가져가면 맞는다.
      const pulse = 1 + Math.sin(performance.now() / 180) * 0.12;
      const r = 19 * pulse;
      ctx.strokeStyle = AMBER;
      ctx.fillStyle = 'rgba(255,204,85,.18)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(lead[0], lead[1] - r); ctx.lineTo(lead[0] + r, lead[1]);
      ctx.lineTo(lead[0], lead[1] + r); ctx.lineTo(lead[0] - r, lead[1]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = AMBER;
      ctx.font = '700 11px ui-monospace, monospace';
      ctx.fillText('여기를 겨냥', lead[0], lead[1] - r - 12);
      if (aligned) {
        ctx.fillStyle = '#ff4d4d';
        ctx.font = '900 24px ui-monospace, monospace';
        ctx.fillText('SHOOT', lead[0], lead[1] - r - 32);
      }
    }
    if (pip) {
      // 로켓이 닿는 거리인지 알려 준다(멀면 아무리 쏴도 안 맞는다).
      // 위 SHOOT 판정과 **같은 maxR** 을 쓴다. 제원이 없으면 아무 말도 안
      // 한다 — 모르는 채로 '사거리 밖'을 띄우면 그게 거짓말이다.
      const inRange = !tgt || !maxR || range <= maxR;
      ctx.fillStyle = inRange ? GREEN : RED;
      ctx.font = '600 11px ui-monospace, monospace';
      ctx.fillText(Math.round(range) + 'm', pip[0], pip[1] + 48);
      if (!inRange) {
        ctx.font = '800 13px ui-monospace, monospace';
        ctx.fillText('사거리 밖', pip[0], pip[1] + 66);
      }
    }
    ctx.restore();
  }

  // ── 목표 표시 ────────────────────────────────────────────────
  targets(ctx) {
    const W = this.world, s = W.srv;
    for (const pl of W.view()) {
      if (!pl.alive || pl.id === W.myId) continue;
      const p = this.scene.project(pl.pos);
      if (!p) continue;
      const dist = v3.len(v3.sub(pl.pos, W.me.pos));
      const locked = s.lk === pl.id;
      const size = clamp(2600 / Math.max(dist, 40), 9, 46);
      ctx.save();
      // 적은 항상 붉게 — 하늘에서 즉시 구분되도록
      ctx.strokeStyle = RED;
      ctx.lineWidth = locked ? 2.6 : 1.6;
      ctx.strokeRect(p[0] - size, p[1] - size, size * 2, size * 2);
      ctx.font = '600 10px ui-monospace, monospace';
      ctx.fillStyle = RED;
      ctx.fillText(W.name(pl.id), p[0], p[1] - size - 9);
      ctx.fillText((dist / 1000).toFixed(1) + 'km', p[0], p[1] + size + 9);
      // 목표 체력바 — 얼마나 더 때려야 하는지 보인다
      const hpf = Math.max(0, Math.min(1, (pl.hp ?? 100) / 100));
      const bw = Math.max(26, size * 1.6);
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      ctx.fillRect(p[0] - bw / 2, p[1] - size - 21, bw, 4);
      ctx.fillStyle = hpf > 0.5 ? GREEN : hpf > 0.25 ? AMBER : RED;
      ctx.fillRect(p[0] - bw / 2, p[1] - size - 21, bw * hpf, 4);
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = RED;
      ctx.fillStyle = RED;
      if (locked) {
        ctx.beginPath();
        ctx.arc(p[0], p[1], size * 1.7, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    // 락온 진행 표시.
    //
    // 분모를 0.9 로 박아두고 있었는데 서버의 실제 lockTime 은 0.18 초다
    // (game.py 의 WEAPONS[1]). 그래서 링은 최대 20% 까지만 차고 그 순간
    // 락온이 끝나 사라졌다 — 사용자는 링이 채워지는 것을 평생 볼 수 없었다.
    // 서버 제원을 클라가 숫자로 베껴 들고 있으면 이렇게 조용히 어긋난다.
    // welcome 으로 내려온 값을 쓴다.
    const lockT = W.weapons?.[1]?.lockTime || 0.18;
    if (s.lkt > 0 && !s.lk) {
      ctx.save();
      ctx.strokeStyle = AMBER;
      ctx.beginPath();
      ctx.arc(this.w / 2, this.h / 2, 60, -Math.PI / 2,
              -Math.PI / 2 + Math.PI * 2 * clamp(s.lkt / lockT, 0, 1));
      ctx.stroke();
      ctx.restore();
    }
  }

  /** 락온한 목표의 상세 정보 — 거리 / 접근률 / 고도차 / 자세 */
  targetPanel(ctx) {
    const W = this.world, s = W.srv;
    const tgt = W.byId(s.lk);
    if (!tgt) return;
    const rel = v3.sub(tgt.pos, W.me.pos);
    const dist = v3.len(rel);
    const relV = v3.sub(tgt.vel || [0, 0, 0], [s.vx, s.vy, s.vz]);
    const closure = -v3.dot(relV, v3.norm(rel));     // 양수면 접근 중
    const dAlt = tgt.pos[1] - W.me.pos[1];
    const aspect = v3.dot(v3.norm(rel), quat.fwd(tgt.q));   // 1 = 꽁무니를 봄
    const x = this.w - 26, y = 96;
    ctx.save();
    ctx.textAlign = 'right';
    ctx.font = '600 11px ui-monospace, monospace';
    ctx.fillStyle = RED;
    ctx.fillText('LOCK ' + W.name(tgt.id), x, y);
    ctx.fillStyle = GREEN;
    const rows = [
      `RNG ${(dist / 1000).toFixed(2)}km`,
      `CLS ${closure >= 0 ? '+' : ''}${Math.round(closure)}m/s`,
      `ALT ${dAlt >= 0 ? '+' : ''}${Math.round(dAlt)}m`,
      aspect > 0.6 ? 'ASPECT 후방(미사일 유리)' : aspect < -0.4 ? 'ASPECT 정면' : 'ASPECT 측면',
    ];
    rows.forEach((t, i) => ctx.fillText(t, x, y + 16 + i * 15));
    ctx.restore();
  }

  // ── 화면 밖 적 방향 표시 ─────────────────────────────────────
  offscreen(ctx, cx, cy) {
    const W = this.world;
    const pad = 70;
    for (const pl of W.view()) {
      if (!pl.alive || pl.id === W.myId) continue;
      const p = this.scene.project(pl.pos);
      const onScreen = p && p[0] > 0 && p[0] < this.w && p[1] > 0 && p[1] < this.h;
      if (onScreen) continue;
      // 뒤쪽이면 화면 반대편을 가리키도록 뒤집는다
      let dx, dy;
      if (p) { dx = p[0] - cx; dy = p[1] - cy; }
      else {
        const rel = v3.sub(pl.pos, W.me.pos);
        const q = W.me.q;
        const r = quat.right(q), u = quat.up(q);
        dx = v3.dot(rel, r); dy = -v3.dot(rel, u);
      }
      const a = Math.atan2(dy, dx);
      const rx = (this.w / 2 - pad) / Math.max(Math.abs(Math.cos(a)), 1e-3);
      const ry = (this.h / 2 - pad) / Math.max(Math.abs(Math.sin(a)), 1e-3);
      const d = Math.min(rx, ry);
      const ex = cx + Math.cos(a) * d, ey = cy + Math.sin(a) * d;
      const dist = v3.len(v3.sub(pl.pos, W.me.pos));
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(a);
      ctx.fillStyle = AMBER;
      ctx.beginPath();
      ctx.moveTo(14, 0); ctx.lineTo(-8, 8); ctx.lineTo(-8, -8);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.fillStyle = AMBER;
      ctx.font = '600 10px ui-monospace, monospace';
      ctx.fillText((dist / 1000).toFixed(1) + 'km',
                   cx + Math.cos(a) * (d - 26), cy + Math.sin(a) * (d - 26));
      ctx.restore();
    }
  }

  // ── 레이더 스코프 (전장 전체 접촉) ───────────────────────────
  radar(ctx, hdg) {
    const W = this.world;
    const R = 62, cx = this.w / 2, cy = this.h - R - 26;
    const range = (this.world.cfg?.worldR || 8000) * 1.1;
    ctx.save();
    ctx.globalAlpha *= 0.85;
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha *= 0.4;
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const me = W.me.pos;
    const contacts = [...W.view().filter((p) => p.alive && p.id !== W.myId)
      .map((p) => ({ pos: p.pos, id: p.id, solid: true })),
      ...W.radar.map((r) => ({ pos: r.pos, id: r.id, solid: false }))];
    for (const c of contacts) {
      const dx = c.pos[0] - me[0], dz = c.pos[2] - me[2];
      const dist = Math.hypot(dx, dz);
      if (dist > range) continue;
      // 기수를 위로 향하게 회전 (heading-up)
      const bearing = Math.atan2(dx, dz) - hdg;
      const rr = (dist / range) * R;
      const px = cx + Math.sin(bearing) * rr, py = cy - Math.cos(bearing) * rr;
      const dy = c.pos[1] - me[1];
      ctx.fillStyle = c.solid ? RED : AMBER;
      ctx.beginPath();
      ctx.arc(px, py, c.solid ? 3.4 : 2.4, 0, Math.PI * 2);
      ctx.fill();
      // 고도차 표시
      if (Math.abs(dy) > 250) {
        ctx.strokeStyle = ctx.fillStyle;
        ctx.beginPath();
        ctx.moveTo(px, py); ctx.lineTo(px, py - Math.sign(dy) * 6);
        ctx.stroke();
      }
    }

    // ── 미사일 접촉 ────────────────────────────────────────────────
    // 마름모로 그려 기체(원)와 한눈에 구분된다. 나에게 다가오는 것만
    // 붉게 깜빡인다 — 내가 쏜 것과 남의 것이 섞이면 경고로 못 쓴다.
    const blink = (performance.now() % 400) < 240;
    for (const m of W.missiles) {
      const dx = m.pos[0] - me[0], dz = m.pos[2] - me[2];
      const dist = Math.hypot(dx, dz);
      if (dist > range) continue;
      const bearing = Math.atan2(dx, dz) - hdg;
      const rr = (dist / range) * R;
      const px = cx + Math.sin(bearing) * rr, py = cy - Math.cos(bearing) * rr;
      const mine = m.owner === W.myId;
      // 접근 중인가 — 상대속도가 나를 향하면 위협이다
      const rel = [me[0] - m.pos[0], me[1] - m.pos[1], me[2] - m.pos[2]];
      const rl = Math.hypot(rel[0], rel[1], rel[2]) || 1;
      const closing = (m.vel[0] * rel[0] + m.vel[1] * rel[1] + m.vel[2] * rel[2]) / rl;
      // topThreat() 과 같은 규칙이어야 한다 — 감속한 후방 유도탄이 레이더에서만
      // 조용하면 두 위젯이 서로 다른 말을 한다.
      const threat = !mine && (closing > 60 || rl < 400);
      if (threat && !blink) continue;
      ctx.fillStyle = threat ? RED : (mine ? GREEN : AMBER);
      ctx.beginPath();
      const s = threat ? 4.2 : 3.0;
      ctx.moveTo(px, py - s); ctx.lineTo(px + s, py);
      ctx.lineTo(px, py + s); ctx.lineTo(px - s, py);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = GREEN;
    ctx.font = '600 9px ui-monospace, monospace';
    ctx.fillText('RADAR ' + (range / 1000).toFixed(0) + 'km', cx, cy + R + 11);
    ctx.restore();
  }

  // ── 모서리 정보 ──────────────────────────────────────────────
  /** 구형 렌더러로 떨어졌으면 화면에 알린다.
   *  이 박스는 브라우저 콘솔을 볼 수 없어서, 화면에 뜨지 않으면 사용자가
   *  '그래픽이 왜 이래' 라고 말할 때 원인을 좁힐 방법이 없다. */
  rendererBadge(ctx) {
    const sc = this.scene;
    if (!sc || sc.q?.modern === undefined) return;
    const legacy = !(sc.q.modern && sc.progSky && sc.progTerrain && sc.progPbr);
    if (!legacy) return;
    const why = !sc.q.modern ? `품질 '${sc.q.name}'`
      : '셰이더 실패: ' + ([...(sc.progFail || [])].join(',') || '알 수 없음');
    ctx.save();
    ctx.textAlign = 'left';
    ctx.font = '700 12px ui-monospace, monospace';
    ctx.fillStyle = AMBER;
    ctx.fillText('구형 렌더러 — ' + why, 26, 92);
    ctx.restore();
  }

  /** 화면 오른쪽 위에 현재 버전과 기체 배율을 띄운다.
   *  이 환경은 화면을 눈으로 볼 수 없어서, '바뀐 게 맞냐' 를 말로 주고받으면
   *  끝없이 어긋난다. 숫자를 화면에 박아 두면 한 번에 판별된다. */
  buildBadge(ctx) {
    const W = this.world;
    ctx.save();
    ctx.textAlign = 'right';
    ctx.font = '700 11px ui-monospace, monospace';
    // 빌드 날짜를 **맨 앞에** 박는다. 기체 배율만 찍고 있었더니 "바뀐 게
    // 맞냐" 를 말로 주고받는 동안 판별이 안 됐다 — 실제로 오늘 하루,
    // 코드는 서버에 올라갔는데 사용자 화면은 어제 것이었고 그걸 알아채는 데
    // 오래 걸렸다. 날짜가 화면에 있으면 한 번에 끝난다.
    ctx.fillStyle = 'rgba(125,251,166,.75)';
    ctx.fillText('BUILD ' + (W.build || '?'), this.w - 14, this.h - 30);
    const ms = W.scaleOf ? W.scaleOf(W.myId) : 0;
    if (ms) {
      ctx.fillStyle = 'rgba(125,251,166,.5)';
      ctx.fillText('SCALE x' + ms.toFixed(2) + '  R' + (W.cfg?.planeR ?? '?'),
                   this.w - 14, this.h - 16);
    }
    ctx.restore();
  }

  corners(ctx, s) {
    this.rendererBadge(ctx);
    this.buildBadge(ctx);
    ctx.save();
    ctx.textAlign = 'left';
    ctx.font = '600 12px ui-monospace, monospace';
    const x = 26, y0 = this.h - 132;
    // AOA 칸은 뺐다. 서버(game.py)가 v.aoa 를 0.0 으로 두고 한 번도 바꾸지
    // 않아 화면에는 영원히 '0.0°' 만 찍혔다 — 옛 항공역학 분기의 잔재다.
    // 서버가 실제 받음각을 보내기 시작하면 그때 되살린다.
    const rows = [
      ['G', s.g.toFixed(1)],
      ['THR', Math.round(s.thr * 100) + '%' + (s.ab ? ' AB' : '')],
    ];
    // G 칸의 호박색 문턱(7)은 걷어냈다 — warnings() 의 'OVER G'(8.5)와 같은
    // 이유다. 서버의 gload 는 물리량이 아니라 **피치 명령을 옮겨 적은 표시용
    // 수치**다: `1.0 + |pr| * 4.0`, `pr = 피치명령 × pitchRate`(game.py:370·406).
    //
    // 그래서 문턱이 기체 제원과 무관해진다. 기수 추종 제어기가 명령을
    // `dP / pitchRate * 9.0` 으로 만들므로(input.js KP) pitchRate 가 약분되고
    // `gload = 1 + 36·dP` 만 남는다 — 세 기종 모두 **피치 조준 오차 9.5도에서
    // 호박색, 11.9도에서 OVER G** 였다(순수 피치 오차 기준. 좌우 오차가 섞이면
    // 정규화로 조금 늦춰진다). 기본 리시가 28도인데 그 3분의 1만 벌어져도
    // 뜨고, 지면 회피 보조는 피치를 1.0 까지 밀어(input.js) 작동할 때마다 떴다.
    //
    // 넘겨도 아무 일이 없다. gLimit(falcon·eagle 30 · flanker 28)은 어디서도
    // 강제되지 않고(game.py:398), 애초에 이 식의 최대값(18.2 · 15.2 · 20.2)이
    // 거기 닿지도 못한다. `RKT 99` 를 걷어낸 것과 같은 종류다 — 화면이 게임에
    // 없는 규칙을 지어내고 있었다.
    //
    // 숫자는 남긴다 — 조종간을 얼마나 당기고 있는지는 읽을 값이다. 다만
    // **이 한 줄이 스냅샷 `me.g` 의 유일한 독자**라는 것은 알아 둘 것.
    // 익단 와류는 예전엔 `srv.g > 6` 이었지만 지금은 자세 차분에서 뽑은
    // `pl.rate[1]` 로 옮겨 갔다(scene.js:1705 주석). 그러니 이 줄까지 빼면
    // `me.g` 는 아무도 안 읽는 칸이 된다 — 그때는 서버와 **같은 커밋**에서
    // 빼야 한다(4순위 `st` 와 같은 부류).
    ctx.fillStyle = GREEN;
    rows.forEach((row, i) => {
      ctx.fillText(row[0].padEnd(4) + row[1], x, y0 + i * 18);
    });
    ctx.textAlign = 'right';
    const rx = this.w - 26;
    // 로켓·유도탄은 탄약이 무제한이다. 서버는 잔량을 99 로 세팅만 하고 어디서도
    // 줄이지 않으며(game.py:606 에 그 코멘트가 남아 있다) 발사를 막는 것은
    // 쿨다운뿐이다(game.py:509·511 — "둘 다 탄약 무제한이다"). 그래서 s.am·s.ms
    // 는 영원히 99 이고, 그 숫자를 띄우면 '99발 남았으니 아껴 쓰자' 는 게임에
    // 없는 규칙을 화면이 지어내는 셈이다. 숫자를 빼고 무제한 기호만 남긴다.
    // **플레어(s.fla)만 실제로 줄어든다**(game.py:627, CFG 20발) — 그쪽만
    // 숫자와 0 경고를 유지한다.
    // 재장전까지 남은 시간을 대신 띄우려면 서버가 fire_t·ms_cd 를 스냅샷에
    // 실어야 한다. 지금 스냅샷에는 쿨다운이 없다 — BACKLOG 4순위로 넘겼다.
    const arm = [
      ['RKT', '∞'],
      ['MSL', '∞'],
      ['FLR', String(s.fla)],
    ];
    arm.forEach((row, i) => {
      ctx.fillStyle = row[1] === '0' ? RED : GREEN;
      ctx.fillText(row[0] + ' ' + row[1], rx, y0 + i * 18);
    });
    // 무기를 가르는 것은 **누른 버튼**뿐이다. 서버 _launch 는 want_fire →
    // ROCKET · want_missile → MISSILE 로 갈라 쏘고 p.weapon(= s.w)을 아예
    // 보지 않는다(game.py:509·511). 예전에는 여기서 s.w 로 '[ ROCKET ]' /
    // '[ AIM-9 ]' 를 찍어 선택이 있는 것처럼 보였는데, 1·2 키를 눌러도
    // 이 글자만 바뀌고 발사는 하나도 안 달라졌다 — 화면이 게임에 없는
    // 규칙을 지어내고 있었다. 실제 규칙을 그대로 적는다.
    ctx.fillStyle = GREEN;
    ctx.font = '700 13px ui-monospace, monospace';
    ctx.fillText('좌클릭 RKT · 우클릭 MSL', rx, y0 - 22);
    ctx.fillStyle = s.lk ? '#3dff8a' : AMBER;
    ctx.font = '800 12px ui-monospace, monospace';
    ctx.fillText(s.lk ? '● 미사일 발사 가능' : '락온 없음 (자동추적)', rx, y0 - 40);
    ctx.restore();
  }

  /** 명중 순간 화면 중앙에 뜨는 히트마커 — 맞았다는 걸 즉각 알려 준다 */
  hitMarker(ctx, cx, cy) {
    const W = this.world;
    const sparks = W.booms.filter((b) => b.kind === 'spark');
    if (!sparks.length) return;
    const newest = sparks.reduce((a, b) => (a.t < b.t ? a : b));
    const t = Math.min(1, newest.t / 0.28);
    if (t >= 1) return;
    const g = 13 + t * 10;
    ctx.save();
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.moveTo(cx + sx * g, cy + sy * g);
      ctx.lineTo(cx + sx * g * 0.45, cy + sy * g * 0.45);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** 나에게 다가오는 미사일 중 가장 급한 것. 없으면 null. */
  topThreat() {
    const W = this.world;
    if (!W.me) return null;
    const me = W.me.pos;
    let best = null;
    for (const m of W.missiles) {
      if (m.owner === W.myId) continue;
      const rel = [me[0] - m.pos[0], me[1] - m.pos[1], me[2] - m.pos[2]];
      const d = Math.hypot(rel[0], rel[1], rel[2]);
      if (d < 1) continue;
      // 접근 속도 = 상대속도를 시선에 투영한 값. 양수여야 나에게 온다.
      const vc = (m.vel[0] * rel[0] + m.vel[1] * rel[1] + m.vel[2] * rel[2]) / d;
      // 접근 속도만 보면 구멍이 난다 — 뒤에서 따라붙다 추력이 끝나 감속한
      // 유도탄, 나와 나란히 가는 유도탄은 경고가 아예 꺼진다. 미사일 메시를
      // 265m 밖에서 컬링하기 시작했으므로(scene.js mslRadiusK) 그 거리의
      // 위협 단서는 연기 궤적과 이 경고뿐이다. 400m 안쪽은 무조건 표시한다.
      if (vc < 60 && d > 400) continue;
      // vc 가 0 이하일 수 있으므로 tti 를 하한으로 막는다(정렬용 값이다)
      const tti = vc > 1 ? d / vc : 999;   // 남은 시간
      if (!best || tti < best.tti) best = { m, d, vc, tti };
    }
    return best;
  }

  /** 미사일 경고 — 방향과 남은 시간을 화면에 직접 그린다.
   *  글자만 띄우면 어디서 오는지 몰라 피할 수가 없다. */
  missileWarn(ctx, cx, cy, th) {
    const W = this.world;
    const camQ = this.scene?.camQ;
    if (!camQ) return;
    // 위협을 카메라 좌표로 옮겨 화면 어느 쪽인지 각도를 구한다
    const d = [th.m.pos[0] - W.me.pos[0], th.m.pos[1] - W.me.pos[1],
               th.m.pos[2] - W.me.pos[2]];
    const r = quat.right(camQ), u = quat.up(camQ), f = quat.fwd(camQ);
    const x = v3.dot(d, r), y = v3.dot(d, u), z = v3.dot(d, f);
    // 뒤에 있는 위협은 화면 투영이 뒤집혀 방향 정보가 없다. 정후방(x=y=0)이면
    // atan2 가 0 이라 화살표가 위를 가리켜 정반대로 알려 준다. 좌우는 그대로
    // 두고 아래쪽으로 밀어 낸다 — 뒤쪽 위협은 화면 아래에 표시하는 관례다.
    const ang = Math.atan2(x, z >= 0 ? y : -Math.hypot(x, y) - 1e-3);
    const R = 150;
    const px = cx + Math.sin(ang) * R, py = cy - Math.cos(ang) * R;

    const urgent = th.tti < 2.5;
    const blink = (performance.now() % 320) < (urgent ? 200 : 260);
    if (!blink) return;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.fillStyle = RED;
    // 위협 쪽을 가리키는 삼각형
    ctx.beginPath();
    ctx.moveTo(0, -13); ctx.lineTo(9, 7); ctx.lineTo(0, 2); ctx.lineTo(-9, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = RED;
    ctx.font = '800 12px ui-monospace, monospace';
    // 화살표만으로는 앞/뒤가 헷갈린다 — 글자로 못 박는다. 정확히 옆에서
    // 오는 것을 '전방'이라 하면 반대로 알려 주는 셈이라 세 구간으로 나눈다.
    const cosT = z / Math.max(th.d, 1e-3);
    const where = cosT > 0.4 ? '전방' : (cosT < -0.4 ? '후방' : '측면');
    // 접근 속도가 없는(감속·병주) 위협은 남은 시간이 의미가 없다 — '999.0s'
    // 대신 거리만 띄운다.
    const tt = th.tti < 90 ? `  ${th.tti.toFixed(1)}s` : '';
    ctx.fillText(`${where} ${Math.round(th.d)}m${tt}`,
                 cx + Math.sin(ang) * (R + 26), cy - Math.cos(ang) * (R + 26) + 4);
    ctx.restore();
  }

  // ── 경고 ────────────────────────────────────────────────────
  warnings(ctx, cx, cy, s) {
    const msgs = [];
    const inp = this.input;
    const th = this.topThreat();
    if (th) {
      this.missileWarn(ctx, cx, cy, th);
      msgs.push([th.tti < 2.5 ? 'MISSILE — 회피!' : 'MISSILE', RED]);
    } else if (s.rwr > 0) msgs.push(['MISSILE', RED]);
    else if (s.lw) msgs.push(['LOCKED', AMBER]);
    // STALL(s.st) 과 '실속 방지 보조'(inp.stallGuard) 는 뺐다. 서버가
    // stalling 을 False 로 두고 바꾸지 않고, stallGuard 를 세팅하는 코드는
    // 어디에도 없어서 둘 다 도달할 수 없는 경고였다.
    if (s.agl < 300 && s.vy < 0) msgs.push(['PULL UP', RED]);
    // 'OVER G'(8.5) 는 걷어냈다 — 근거는 corners() 의 G 칸 주석에 있다.
    // 요약하면 피치 조준 오차 11.9도에서 뜨는, 결과가 없는 경고였다.
    if (inp?.groundWarn) msgs.push(['지면 회피 보조 작동', GREEN]);
    if (!msgs.length) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = '800 20px ui-monospace, monospace';
    const blink = (performance.now() / 260 | 0) % 2 === 0;
    msgs.forEach((m, i) => {
      if (m[1] === RED && !blink) return;
      ctx.fillStyle = m[1];
      ctx.fillText(m[0], cx, cy + 130 + i * 26);
    });
    ctx.restore();
  }
}
