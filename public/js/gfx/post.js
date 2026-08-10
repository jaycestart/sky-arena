// HDR 렌더 타깃 · MSAA 리졸브 · 블룸 · 자동 노출 · 합성.
//
// 씬 셰이더는 톤매핑도 감마도 하지 않는다 — 톤 커브가 두 개(물체 c/(c+0.55),
// 하늘 pow(0.94))라 지평선에서 지형 색과 하늘 색이 구조적으로 맞을 수 없었던
// 것이 이 게임이 가장 '게임 같아' 보이던 지점이었다. 커브는 여기 한 곳뿐이다.
//
// FBO 로 가면서 기본 프레임버퍼의 antialias:true 를 잃으면 하늘 배경의 얇은
// 익단·수직미익이 계단진다. 그래서 멀티샘플 렌더버퍼에 그리고 blit 으로
// 리졸브한다 — WebGL2 승격의 가장 큰 실질 이유가 이것이다.
import { prelude, VS_FULL, FS_DOWN, FS_UP, FS_LUM, FS_POST } from './shaders.js';

const MIPS = 4;   // 5단은 내장 GPU 대역폭에 과하다
// 후처리는 전부 highp 다 — 태양 원반이 선형 1만을 넘는 HDR 값을 다룬다.
const VP = prelude({ fs: false });
const FP = prelude({ fs: true, high: true });

export class Post {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {object} caps
   * @param {function} mk  scene 의 mkProgram(name, vs, fs)
   */
  constructor(gl, caps, mk) {
    this.gl = gl;
    this.ok = false;
    this.w = 0; this.h = 0;
    if (!caps.gl2 || !caps.colorHalf) return;      // 폴백: 기본 프레임버퍼 직행

    this.pDown = mk('post.down', VP + VS_FULL, FP + FS_DOWN);
    this.pUp = mk('post.up', VP + VS_FULL, FP + FS_UP);
    this.pLum = mk('post.lum', VP + VS_FULL, FP + FS_LUM);
    this.pComp = mk('post.comp', VP + VS_FULL, FP + FS_POST);
    if (!this.pDown || !this.pUp || !this.pLum || !this.pComp) return;

    this.tri = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.tri);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.fmt = gl.RGBA16F;
    this.samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 1);
    this.depthTex = null;
    this.wantDepth = !!caps.softParticles;
    this.ok = true;
    this.autoExp = true;
    this.lumIdx = 0;
  }

  _tex(w, h, filter) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, this.fmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  _fbo(tex) {
    const gl = this.gl;
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return f;
  }

  resize(w, h) {
    if (!this.ok || (w === this.w && h === this.h)) return;
    const gl = this.gl;
    this.dispose(true);
    this.w = w; this.h = h;

    // 멀티샘플 씬 타깃
    this.msC = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.msC);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, this.fmt, w, h);
    this.msD = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.msD);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.DEPTH_COMPONENT24, w, h);
    this.fboMS = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboMS);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.msC);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.msD);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      console.error('post: MSAA FBO 불완전 — 후처리를 끕니다');
      this.ok = false; gl.bindFramebuffer(gl.FRAMEBUFFER, null); return;
    }

    // 단일샘플 리졸브 타깃
    this.resC = this._tex(w, h, gl.LINEAR);
    this.fboRes = this._fbo(this.resC);

    // 소프트 파티클용 깊이 리졸브
    if (this.wantDepth) {
      this.depthTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.fboDepth = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboDepth);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depthTex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        this.wantDepth = false; this.depthTex = null;
      }
    }

    // 블룸 체인
    this.mip = [];
    let mw = w, mh = h;
    for (let i = 0; i < MIPS; i++) {
      mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1);
      const t = this._tex(mw, mh, gl.LINEAR);
      this.mip.push({ t, f: this._fbo(t), w: mw, h: mh });
    }
    // 1×1 핑퐁 — readPixels 는 절대 쓰지 않는다
    this.lum = [];
    for (let i = 0; i < 2; i++) {
      const t = this._tex(1, 1, gl.NEAREST);
      this.lum.push({ t, f: this._fbo(t) });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose(keepProg) {
    const gl = this.gl;
    const del = (o) => { if (o) gl.deleteFramebuffer(o); };
    del(this.fboMS); del(this.fboRes); del(this.fboDepth);
    if (this.msC) gl.deleteRenderbuffer(this.msC);
    if (this.msD) gl.deleteRenderbuffer(this.msD);
    if (this.resC) gl.deleteTexture(this.resC);
    if (this.depthTex) gl.deleteTexture(this.depthTex);
    for (const m of (this.mip || [])) { gl.deleteFramebuffer(m.f); gl.deleteTexture(m.t); }
    for (const l of (this.lum || [])) { gl.deleteFramebuffer(l.f); gl.deleteTexture(l.t); }
    this.mip = []; this.lum = [];
    this.fboMS = this.fboRes = this.fboDepth = this.msC = this.msD = null;
    this.resC = this.depthTex = null;
    if (!keepProg) this.ok = false;
  }

  /** 씬을 멀티샘플 HDR 타깃에 그리기 시작한다. */
  begin() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboMS);
    gl.viewport(0, 0, this.w, this.h);
  }

  /** 불투명 패스가 끝난 뒤 깊이만 먼저 리졸브한다(소프트 파티클용). */
  resolveDepth() {
    if (!this.depthTex) return null;
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboMS);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fboDepth);
    gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h,
                       gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboMS);
    return this.depthTex;
  }

  _blit(prog, dst, dw, dh, setup) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst);
    gl.viewport(0, 0, dw, dh);
    gl.useProgram(prog.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.tri);
    const a = prog.a.aXY;
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    setup(prog);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * 리졸브 → 블룸 → 자동 노출 → 합성. 기본 프레임버퍼에 최종 픽셀을 쓴다.
   * @param {object} o  { exposure, bloom, vignette, grain, blur, center,
   *                      under, underTint, time, dt, bloomHalf }
   */
  end(o) {
    const gl = this.gl;
    const w = this.w, h = this.h;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    // MSAA → 단일샘플
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboMS);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fboRes);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);

    // ── 블룸: 임계값 없는 에너지 보존형 ─────────────────────────
    // 임계 블룸은 노출과 싸우고 밝기 경계에 계단이 생긴다.
    const nMip = o.bloomHalf ? MIPS - 1 : MIPS;
    let src = this.resC, sw = w, sh = h;
    for (let i = 0; i < nMip; i++) {
      const m = this.mip[i];
      this._blit(this.pDown, m.f, m.w, m.h, (p) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src);
        gl.uniform1i(p.u.uSrc, 0);
        gl.uniform2f(p.u.uPx, 1 / sw, 1 / sh);
        // 첫 다운샘플에만 Karis 평균 — GGX 하이라이트와 예광탄이 만드는
        // 파이어플라이를 여기서 잡는다.
        gl.uniform1f(p.u.uKaris, i === 0 ? 1 : 0);
      });
      src = m.t; sw = m.w; sh = m.h;
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = nMip - 1; i > 0; i--) {
      const dst = this.mip[i - 1], s = this.mip[i];
      this._blit(this.pUp, dst.f, dst.w, dst.h, (p) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, s.t);
        gl.uniform1i(p.u.uSrc, 0);
        gl.uniform2f(p.u.uPx, 1 / s.w, 1 / s.h);
        gl.uniform1f(p.u.uRad, 1.0);
      });
    }
    gl.disable(gl.BLEND);

    // ── 자동 노출 ────────────────────────────────────────────────
    const prev = this.lum[this.lumIdx];
    const cur = this.lum[this.lumIdx ^ 1];
    if (this.autoExp) {
      const smallest = this.mip[nMip - 1];
      const dt = Math.min(0.1, o.dt || 1 / 60);
      this._blit(this.pLum, cur.f, 1, 1, (p) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, smallest.t);
        gl.uniform1i(p.u.uSrc, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, prev.t);
        gl.uniform1i(p.u.uPrev, 1);
        // 밝아질 때 0.8초 / 어두워질 때 2.0초 — 실제 눈과 같은 비대칭
        gl.uniform2f(p.u.uRate, 1 - Math.exp(-dt / 0.8), 1 - Math.exp(-dt / 2.0));
      });
      this.lumIdx ^= 1;
    }

    // ── 합성 ─────────────────────────────────────────────────────
    this._blit(this.pComp, null, w, h, (p) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.resC);
      gl.uniform1i(p.u.uSrc, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.mip[0].t);
      gl.uniform1i(p.u.uBloom, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, cur.t);
      gl.uniform1i(p.u.uLum, 2);
      gl.uniform2f(p.u.uPx, 1 / w, 1 / h);
      gl.uniform4f(p.u.uP0, o.exposure, o.bloom, o.vignette, o.grain);
      gl.uniform4f(p.u.uP1, o.blur, this.autoExp ? 1 : 0, o.under, o.time);
      gl.uniform2f(p.u.uCenter, o.center[0], o.center[1]);
      gl.uniform3fv(p.u.uUnderTint, o.underTint);
    });
    gl.activeTexture(gl.TEXTURE0);
  }
}
