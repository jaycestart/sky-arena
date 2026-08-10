// 진짜 바다 — y=0 평면.
//
// 실측했다: 아레나(r=4500) 내부의 **51.1% 가 y<0 이고 최저 -566.1m** 다.
// 이전에는 해수면 평면이 없고 y<0 정점을 남색으로 칠한 것뿐이라, 화면 절반이
// '해수면' 이 아니라 -566m 까지 비스듬히 기울어진 거대한 검푸른 경사면이었다.
// 씬에서 가장 큰 반사체가 물감으로 처리되어 있었다.
//
// 별도 메시를 만들지 않는다 — 지형 클립맵 패치를 y=0 으로 한 번 더 그린다.
// 지형은 y<0 구간도 그대로 렌더해서 물 아래로 비친다. 물을 정확히 y=0 에
// 두면 z-파이팅이 자연스럽게 해결되고, 얕은 해안선의 남는 미세 파이팅은
// polygonOffset 한 줄로 없앤다.

export class Water {
  /**
   * @param {WebGLRenderingContext} gl
   * @param {object} prog  mkProgram 이 돌려준 {p, u, a}
   * @param {Clipmap} clip
   */
  constructor(gl, prog, clip) {
    this.gl = gl;
    this.prog = prog;
    this.clip = clip;
  }

  /**
   * @param {object} o { proj, view, vp, cam, waveHi, setAtmo, use, bind }
   */
  draw(o) {
    const gl = this.gl, pr = this.prog;
    if (!pr) return 0;
    o.use(pr);
    o.setAtmo(pr);
    gl.uniformMatrix4fv(pr.u.uProj, false, o.proj);
    gl.uniformMatrix4fv(pr.u.uView, false, o.view);
    if (pr.u.uWaveHi) gl.uniform1f(pr.u.uWaveHi, o.waveHi);

    const c = this.clip;
    // 정점 배열 on/off 추적은 scene 이 한 곳에서 한다 — 버퍼를 물리지 않은 채
    // 켜진 배열이 있으면 드로우가 통째로 INVALID_OPERATION 이 된다.
    o.bind(pr, 'aGrid', c.vGrid, 2);
    o.bind(pr, 'aStitch', c.vStitch, 1);

    // 해안선 근처에서 지형과 수면이 만나 생기는 미세 z-파이팅을 없앤다
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1.0, -2.0);
    let draws = 0;
    for (const p of c.patches(o.cam, o.vp, true)) {
      gl.uniform2f(pr.u.uOrigin, p.ox, p.oz);
      gl.uniform1f(pr.u.uCell, p.cell);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, p.buf);
      gl.drawElements(gl.TRIANGLES, p.count, gl.UNSIGNED_SHORT, 0);
      draws++;
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(0, 0);
    return draws;
  }
}
