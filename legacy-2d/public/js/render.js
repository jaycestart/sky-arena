// Canvas 2D 렌더러 — 네온 벡터 스타일, 패럴랙스 배경, 미니맵, HUD 오버레이.
const HULL = [[27, 0], [11, 4], [3, 4], [-4, 16], [-11, 16], [-9, 4],
              [-17, 4], [-19, 9], [-24, 9], [-22, 2]];

const PICKUP_STYLE = {
  hp:      { c: '#7cff6b', s: '✚' },
  shield:  { c: '#8ab4ff', s: '◈' },
  missile: { c: '#ffd166', s: '➤' },
  energy:  { c: '#38e8ff', s: '⚡' },
};

export class Renderer {
  constructor(canvas, world, settings) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.world = world;
    this.set = settings;
    this.mini = document.getElementById('minimap');
    this.mctx = this.mini.getContext('2d');
    this.cam = { x: 0, y: 0, scale: 1 };
    this.stars = [];
    this.clouds = [];
    this.fps = 60;
    this._frames = 0;
    this._fpsT = performance.now();
    this.quality = 1;          // 1 = 최고, 0 = 저사양 (자동 조정)
    this.spectate = null;      // 사망 중 따라가는 기체
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, this.set?.hidpi === false ? 1 : 2);
    // 창이 접혀 0px 이 되는 경우가 있어 최소값을 둔다(스케일 0 → 나눗셈 폭주 방지)
    this.w = Math.max(1, innerWidth); this.h = Math.max(1, innerHeight);
    this.cv.width = Math.round(this.w * dpr);
    this.cv.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.bg = null;
  }

  makeScenery(R) {
    this.stars = [];
    for (let i = 0; i < 420; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * R * 1.5;
      this.stars.push({ x: Math.cos(a) * r, y: Math.sin(a) * r,
                        s: Math.random() * 1.6 + 0.4, o: Math.random() * 0.5 + 0.2 });
    }
    this.clouds = [];
    for (let i = 0; i < 34; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * R * 1.2;
      this.clouds.push({ x: Math.cos(a) * r, y: Math.sin(a) * r,
                         r: 180 + Math.random() * 420, o: 0.05 + Math.random() * 0.06 });
    }
  }

  frame(dt) {
    const { ctx, world: W } = this;
    const cfg = W.cfg;
    if (!this.stars.length && cfg) this.makeScenery(cfg.arenaR);

    // FPS 측정 → 낮으면 자동으로 품질을 내린다
    this._frames++;
    const now = performance.now();
    if (now - this._fpsT > 700) {
      this.fps = Math.round(this._frames / ((now - this._fpsT) / 1000));
      this._frames = 0; this._fpsT = now;
      if (this.set?.quality === 'auto') this.quality = this.fps < 45 ? 0 : 1;
      else this.quality = this.set?.quality === 'low' ? 0 : 1;
    }

    // 카메라: 살아 있으면 내 기체, 사망 중이면 나를 잡은 기체를 따라간다
    let focus = W.me;
    this.spectate = null;
    if (W.srv && !W.srv.al) {
      const target = W.view().find((p) => W.name(p.id) === W.srv.kb && p.alive);
      if (target) { focus = target; this.spectate = target; }
    }

    const base = Math.min(this.w, this.h) / 950;
    const sp = focus?.sp ?? W.me?.sp ?? 0;
    const zoom = cfg ? 1 - 0.16 * Math.min(1, Math.max(0, (sp - cfg.speedMin) / (cfg.speedBoost - cfg.speedMin))) : 1;
    this.cam.scale += (Math.max(0.5, Math.min(1.25, base)) * zoom - this.cam.scale) * Math.min(1, dt * 4);
    if (focus) {
      const lead = 90;
      const tx = focus.x + Math.cos(focus.a) * lead, ty = focus.y + Math.sin(focus.a) * lead;
      const k = Math.hypot(tx - this.cam.x, ty - this.cam.y) > 900 ? 1 : Math.min(1, dt * 7);
      this.cam.x += (tx - this.cam.x) * k;
      this.cam.y += (ty - this.cam.y) * k;
    }

    const sh = W.shake;
    const ox = (Math.random() - 0.5) * sh, oy = (Math.random() - 0.5) * sh;

    ctx.save();
    this.drawBg();
    ctx.translate(this.w / 2 + ox, this.h / 2 + oy);
    ctx.scale(this.cam.scale, this.cam.scale);
    ctx.translate(-this.cam.x, -this.cam.y);

    if (cfg) {
      this.drawStars();
      if (this.quality) this.drawClouds();
      this.drawGrid();
      this.drawArena(cfg.arenaR);
      this.drawPickups();
    }

    const planes = W.view();
    for (const p of planes) this.drawTrail(p);
    if (W.me && W.srv?.al) this.drawAim(W.me, cfg);
    this.drawBullets();
    this.drawMissiles();
    for (const p of planes) if (p.alive) this.drawPlane(p);
    this.drawFx();
    this.drawPopups();
    ctx.restore();

    this.drawOffscreen(planes);
    this.drawHurtDirs();
    if (W.hitFlash > 0) {
      ctx.fillStyle = `rgba(255,60,100,${W.hitFlash * 0.22})`;
      ctx.fillRect(0, 0, this.w, this.h);
    }
    if (W.srv && W.srv.hp / (W.srv.hm || 100) < 0.3 && W.srv.al) this.drawVignette();
    if (W.flashLevel > 0) {
      ctx.fillStyle = `rgba(120,255,180,${W.flashLevel * 0.14})`;
      ctx.fillRect(0, 0, this.w, this.h);
    }
    this.drawMini(planes);
  }

  drawBg() {
    const ctx = this.ctx;
    if (!this.bg) {
      this.bg = ctx.createRadialGradient(this.w / 2, this.h * 0.35, 0, this.w / 2, this.h * 0.5, Math.max(this.w, this.h) * 0.85);
      this.bg.addColorStop(0, '#0b1730');
      this.bg.addColorStop(0.55, '#070c1b');
      this.bg.addColorStop(1, '#04060e');
    }
    ctx.fillStyle = this.bg;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  drawStars() {
    const ctx = this.ctx, c = this.cam;
    ctx.save();
    ctx.translate(c.x * 0.55, c.y * 0.55);
    const R = this.w / this.cam.scale;
    for (const s of this.stars) {
      if (Math.abs(s.x - c.x * 0.45) > R || Math.abs(s.y - c.y * 0.45) > R) continue;
      ctx.fillStyle = `rgba(180,215,255,${s.o})`;
      ctx.fillRect(s.x, s.y, s.s, s.s);
    }
    ctx.restore();
  }

  drawClouds() {
    const ctx = this.ctx, c = this.cam;
    ctx.save();
    ctx.translate(c.x * 0.22, c.y * 0.22);      // 별보다 가까운 레이어
    const R = this.w / this.cam.scale + 500;
    for (const cl of this.clouds) {
      if (Math.abs(cl.x - c.x * 0.78) > R || Math.abs(cl.y - c.y * 0.78) > R) continue;
      const g = ctx.createRadialGradient(cl.x, cl.y, 0, cl.x, cl.y, cl.r);
      g.addColorStop(0, `rgba(130,180,255,${cl.o})`);
      g.addColorStop(1, 'rgba(130,180,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cl.x, cl.y, cl.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawGrid() {
    const ctx = this.ctx, S = 240, c = this.cam;
    const vw = this.w / c.scale / 2 + S, vh = this.h / c.scale / 2 + S;
    const x0 = Math.floor((c.x - vw) / S) * S, x1 = c.x + vw;
    const y0 = Math.floor((c.y - vh) / S) * S, y1 = c.y + vh;
    ctx.strokeStyle = 'rgba(90,150,220,.07)';
    ctx.lineWidth = 1 / c.scale;
    ctx.beginPath();
    for (let x = x0; x < x1; x += S) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    for (let y = y0; y < y1; y += S) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.stroke();
  }

  drawArena(R) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 5 / this.cam.scale;
    ctx.strokeStyle = 'rgba(255,92,138,.55)';
    ctx.setLineDash([26 / this.cam.scale, 18 / this.cam.scale]);
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  drawPickups() {
    const ctx = this.ctx;
    const t = performance.now() / 1000;
    for (const u of this.world.pickups) {
      const st = PICKUP_STYLE[u.kind] || PICKUP_STYLE.hp;
      const pulse = 1 + Math.sin(t * 3 + u.id) * 0.12;
      ctx.save();
      ctx.translate(u.x, u.y);
      ctx.rotate(t * 0.8);
      ctx.strokeStyle = st.c;
      ctx.lineWidth = 2.5;
      if (this.quality) { ctx.shadowColor = st.c; ctx.shadowBlur = 14; }
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        const r = 20 * pulse;
        if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.translate(u.x, u.y);
      ctx.scale(1 / this.cam.scale, 1 / this.cam.scale);
      ctx.fillStyle = st.c;
      ctx.font = '700 15px system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(st.s, 0, 1);
      ctx.restore();
    }
  }

  /** 기수가 향한 방향과 기총 사거리를 보여주는 조준선. */
  drawAim(me, cfg) {
    const ctx = this.ctx;
    // 현재 장착한 무기의 실제 사거리를 그린다
    const spec = this.world.weapons?.[this.world.srv?.w ?? 0];
    const range = spec ? (spec.speed + me.sp * (spec.inherit || 0)) * spec.life
                       : cfg.bulletSpeed * cfg.bulletLife;
    const c = Math.cos(me.a), s = Math.sin(me.a);
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = '#7ff0ff';
    ctx.lineWidth = 1.5 / this.cam.scale;
    ctx.setLineDash([14 / this.cam.scale, 16 / this.cam.scale]);
    ctx.beginPath();
    ctx.moveTo(me.x + c * 34, me.y + s * 34);
    ctx.lineTo(me.x + c * range, me.y + s * range);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2 / this.cam.scale;
    ctx.beginPath();
    ctx.arc(me.x + c * range, me.y + s * range, 13 / this.cam.scale + 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  drawTrail(p) {
    const tr = this.world.pushTrail(p);
    if (tr.length < 2) return;
    const ctx = this.ctx, col = this.world.color(p.id);
    ctx.lineCap = 'round';
    for (let i = 1; i < tr.length; i++) {
      const t = i / tr.length;
      ctx.globalAlpha = t * (p.boost ? 0.55 : 0.28);
      ctx.strokeStyle = col;
      ctx.lineWidth = t * (p.boost ? 7 : 4);
      ctx.beginPath();
      ctx.moveTo(tr[i - 1].x, tr[i - 1].y);
      ctx.lineTo(tr[i].x, tr[i].y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  drawPlane(p) {
    const ctx = this.ctx, W = this.world;
    const col = W.color(p.id), me = p.id === W.myId;
    const locked = W.srv?.lk === p.id;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.a);
    if (p.rolling) ctx.scale(1, Math.cos(performance.now() / 60) * 0.8 + 0.2);  // 배럴롤 연출

    if (p.boost) {
      ctx.fillStyle = 'rgba(120,230,255,.55)';
      ctx.beginPath();
      ctx.moveTo(-22, -5); ctx.lineTo(-46 - Math.random() * 22, 0); ctx.lineTo(-22, 5);
      ctx.closePath(); ctx.fill();
    }

    ctx.beginPath();
    ctx.moveTo(HULL[0][0], HULL[0][1]);
    for (let i = 1; i < HULL.length; i++) ctx.lineTo(HULL[i][0], HULL[i][1]);
    for (let i = HULL.length - 1; i >= 0; i--) ctx.lineTo(HULL[i][0], -HULL[i][1]);
    ctx.closePath();

    ctx.globalAlpha = p.invuln ? 0.45 + Math.sin(performance.now() / 70) * 0.25 : 1;
    ctx.fillStyle = 'rgba(9,15,28,.92)';
    ctx.fill();
    ctx.lineWidth = me ? 2.4 : 1.8;
    ctx.strokeStyle = col;
    if (this.quality && (me || p.boost)) { ctx.shadowColor = col; ctx.shadowBlur = 16; }
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = col;
    ctx.fillRect(2, -2.5, 9, 5);
    ctx.globalAlpha = 1;
    ctx.restore();

    // 실드 링
    if (p.shielded) {
      ctx.save();
      ctx.strokeStyle = 'rgba(138,180,255,.75)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 30, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    // 락온 표시
    if (locked) {
      ctx.save();
      ctx.strokeStyle = '#ff5c8a';
      ctx.lineWidth = 2;
      const r = 38, t = performance.now() / 250;
      for (let i = 0; i < 4; i++) {
        const a = t + i * Math.PI / 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, a, a + 0.5);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 이름표 + 체력바
    const hpMax = (this.world.cfg?.hpMax ?? 100) * (1 + 0.08 * ((p.lv || 1) - 1));
    const hpF = Math.max(0, Math.min(1, (p.hp ?? 0) / hpMax));
    ctx.save();
    ctx.translate(p.x, p.y - 40);
    ctx.scale(1 / this.cam.scale, 1 / this.cam.scale);
    ctx.font = '700 12px system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = me ? '#ffffff' : 'rgba(220,235,255,.85)';
    const lv = (p.lv || 1) > 1 ? ` Lv${p.lv}` : '';
    ctx.fillText(W.name(p.id) + W.tag(p.id) + lv, 0, 0);
    const bw = 46;
    ctx.fillStyle = 'rgba(255,255,255,.16)';
    ctx.fillRect(-bw / 2, 5, bw, 4);
    ctx.fillStyle = hpF > 0.5 ? '#7cff6b' : hpF > 0.22 ? '#ffd166' : '#ff5c8a';
    ctx.fillRect(-bw / 2, 5, bw * hpF, 4);
    if (p.sh > 0) {
      ctx.fillStyle = '#8ab4ff';
      ctx.fillRect(-bw / 2, 10, bw * Math.min(1, p.sh / 60), 3);
    }
    ctx.restore();
  }

  /** 무기마다 탄 모양이 다르다: 발칸 짧은 선 / 산탄 알갱이 / 레일건 긴 광선 / 플라즈마 구체 */
  drawBullets() {
    const ctx = this.ctx, W = this.world;
    ctx.lineCap = 'round';
    for (const b of W.bullets) {
      const col = W.color(b.o);
      if (this.quality) { ctx.shadowColor = col; ctx.shadowBlur = 12; }
      if (b.w === 3) {                      // 플라즈마
        ctx.shadowColor = '#a56bff';
        ctx.fillStyle = 'rgba(190,140,255,.9)';
        ctx.beginPath();
        ctx.arc(b.x, b.y, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#e6d4ff';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (b.w === 2) {               // 레일건
        ctx.strokeStyle = '#cfe8ff';
        ctx.shadowColor = '#8ab4ff';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - Math.cos(b.a) * 90, b.y - Math.sin(b.a) * 90);
        ctx.stroke();
      } else if (b.w === 1) {               // 산탄
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(b.x, b.y, 3.2, 0, Math.PI * 2);
        ctx.fill();
      } else {                              // 발칸
        ctx.strokeStyle = col;
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - Math.cos(b.a) * 22, b.y - Math.sin(b.a) * 22);
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;
  }

  drawMissiles() {
    const ctx = this.ctx, W = this.world;
    for (const m of W.missiles) {
      const col = W.color(m.o);
      ctx.save();
      ctx.translate(m.x, m.y);
      ctx.rotate(m.a);
      if (this.quality) { ctx.shadowColor = '#ffb26b'; ctx.shadowBlur = 18; }
      ctx.fillStyle = '#ffd7a8';
      ctx.beginPath();
      ctx.moveTo(11, 0); ctx.lineTo(-6, 3.5); ctx.lineTo(-6, -3.5);
      ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255,150,80,.6)';
      ctx.beginPath();
      ctx.moveTo(-6, -2.5); ctx.lineTo(-20 - Math.random() * 16, 0); ctx.lineTo(-6, 2.5);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.strokeRect(-6, -3.5, 17, 7);
      ctx.restore();
    }
  }

  drawFx() {
    const ctx = this.ctx;
    for (const f of this.world.fx) {
      const t = f.t / f.life;
      if (f.kind === 'hit') {
        const g = 9 + t * 9;
        ctx.globalAlpha = 1 - t;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(f.x - g, f.y - g); ctx.lineTo(f.x - g * 0.4, f.y - g * 0.4);
        ctx.moveTo(f.x + g, f.y - g); ctx.lineTo(f.x + g * 0.4, f.y - g * 0.4);
        ctx.moveTo(f.x - g, f.y + g); ctx.lineTo(f.x - g * 0.4, f.y + g * 0.4);
        ctx.moveTo(f.x + g, f.y + g); ctx.lineTo(f.x + g * 0.4, f.y + g * 0.4);
        ctx.stroke();
        continue;
      }
      const r = 18 + t * 120;
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 5 * (1 - t);
      ctx.beginPath(); ctx.arc(f.x, f.y, r, 0, Math.PI * 2); ctx.stroke();
      if (this.quality) {
        ctx.fillStyle = '#fff3c4';
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2 + f.life;
          const d = r * (0.5 + (i % 3) * 0.22);
          ctx.fillRect(f.x + Math.cos(a) * d, f.y + Math.sin(a) * d, 4, 4);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  drawPopups() {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    for (const p of this.world.popups) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(1 / this.cam.scale, 1 / this.cam.scale);
      ctx.globalAlpha = 1 - p.t / p.life;
      ctx.font = '800 15px system-ui,sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,.65)';
      ctx.strokeText(p.text, 0, 0);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, 0, 0);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  /** 화면 밖 적의 방향을 가장자리 화살표로 알려준다 */
  drawOffscreen(planes) {
    const ctx = this.ctx, W = this.world;
    if (!W.me) return;
    const cx = this.w / 2, cy = this.h / 2, pad = 46;
    for (const p of planes) {
      if (!p.alive || p.id === W.myId) continue;
      const sx = cx + (p.x - this.cam.x) * this.cam.scale;
      const sy = cy + (p.y - this.cam.y) * this.cam.scale;
      if (sx > -20 && sx < this.w + 20 && sy > -20 && sy < this.h + 20) continue;
      const a = Math.atan2(sy - cy, sx - cx);
      const rx = Math.min(cx - pad, Math.abs(Math.cos(a)) < 1e-3 ? 1e9 : (cx - pad) / Math.abs(Math.cos(a)));
      const ry = Math.min(cy - pad, Math.abs(Math.sin(a)) < 1e-3 ? 1e9 : (cy - pad) / Math.abs(Math.sin(a)));
      const d = Math.min(rx, ry);
      const ex = cx + Math.cos(a) * d, ey = cy + Math.sin(a) * d;
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(a);
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = W.color(p.id);
      ctx.beginPath();
      ctx.moveTo(11, 0); ctx.lineTo(-8, 7); ctx.lineTo(-8, -7);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  /** 어느 방향에서 맞았는지 화면 가장자리 호로 표시 */
  drawHurtDirs() {
    const ctx = this.ctx, W = this.world;
    if (!W.me) return;
    const cx = this.w / 2, cy = this.h / 2;
    const R = Math.min(this.w, this.h) * 0.42;
    for (const h of W.hurtDirs) {
      const a = h.a;
      ctx.save();
      ctx.globalAlpha = (1 - h.t / h.life) * 0.65;
      ctx.strokeStyle = '#ff5c8a';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.arc(cx, cy, R, a - 0.28, a + 0.28);
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  drawVignette() {
    const ctx = this.ctx;
    const g = ctx.createRadialGradient(this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.3,
                                       this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.7);
    g.addColorStop(0, 'rgba(255,0,60,0)');
    g.addColorStop(1, 'rgba(255,0,60,.28)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  drawMini(planes) {
    const W = this.world, ctx = this.mctx;
    if (!W.cfg) return;
    const S = this.mini.width, R = S / 2 - 6, k = R / W.cfg.arenaR;
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.strokeStyle = 'rgba(255,92,138,.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();

    // 현재 화면 영역
    ctx.strokeStyle = 'rgba(255,255,255,.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect((this.cam.x - this.w / 2 / this.cam.scale) * k,
                   (this.cam.y - this.h / 2 / this.cam.scale) * k,
                   this.w / this.cam.scale * k, this.h / this.cam.scale * k);

    for (const u of W.pickups) {
      ctx.fillStyle = (PICKUP_STYLE[u.kind] || PICKUP_STYLE.hp).c;
      ctx.fillRect(u.x * k - 1.5, u.y * k - 1.5, 3, 3);
    }
    // 시야 밖 기체도 레이더로 찍어 전장 전체를 볼 수 있게 한다
    for (const r of W.radar) {
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = W.color(r.id);
      ctx.beginPath();
      ctx.arc(r.x * k, r.y * k, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    for (const p of planes) {
      if (!p.alive) continue;
      const me = p.id === W.myId;
      ctx.fillStyle = W.color(p.id);
      if (me) {
        ctx.save();
        ctx.translate(p.x * k, p.y * k);
        ctx.rotate(p.a);
        ctx.beginPath();
        ctx.moveTo(5, 0); ctx.lineTo(-3.5, 3); ctx.lineTo(-3.5, -3);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x * k, p.y * k, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}
