// 절차 생성 텍스처. 에셋 파일 0개, 빌드 단계 0개 — 부팅 시 Canvas2D 로 그린다.

export const ATLAS_N = 4;      // 4×4 타일
export const TILE = 64;

// 아틀라스 타일 번호
export const T_SMOKE = 0;      // 연기 퍼프
export const T_SPARK = 1;      // 스파크(코어 + 글로우)
export const T_FLAME = 2;      // 불꽃
export const T_GLOW = 3;       // 플레어 글로우
export const T_RING = 4;       // 충격파 링
export const T_DISC = 5;       // 부드러운 원반(접지 그림자·물기둥 밑동)
export const T_CHUNK = 6;      // 금속 파편
export const T_STREAK = 7;     // 예광탄 코어

/** 파티클 아틀라스 한 장(256×256). 각 타일은 알파에 모양, RGB 에 밝기를 담는다. */
export function buildAtlas() {
  const S = ATLAS_N * TILE;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const c = cv.getContext('2d');
  c.clearRect(0, 0, S, S);
  const at = (t) => [(t % ATLAS_N) * TILE, Math.floor(t / ATLAS_N) * TILE];

  const radial = (t, stops, pow) => {
    const [ox, oy] = at(t);
    const img = c.createImageData(TILE, TILE);
    const d = img.data;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const dx = (x + 0.5) / TILE * 2 - 1, dy = (y + 0.5) / TILE * 2 - 1;
        const r = Math.min(1, Math.hypot(dx, dy));
        const a = Math.pow(Math.max(0, 1 - r), pow);
        const k = (y * TILE + x) * 4;
        d[k] = stops[0] * 255; d[k + 1] = stops[1] * 255; d[k + 2] = stops[2] * 255;
        d[k + 3] = a * 255;
      }
    }
    c.putImageData(img, ox, oy);
  };

  // 연기 퍼프 — 방사 그라디언트에 노이즈를 섞어 덩어리지게
  {
    const [ox, oy] = at(T_SMOKE);
    const img = c.createImageData(TILE, TILE);
    const d = img.data;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const dx = (x + 0.5) / TILE * 2 - 1, dy = (y + 0.5) / TILE * 2 - 1;
        const r = Math.min(1, Math.hypot(dx, dy));
        let n = 0, amp = 0.5, fq = 3.2;
        for (let o = 0; o < 3; o++) {
          n += amp * (Math.sin(dx * fq * 3.1 + o * 2.3) * Math.cos(dy * fq * 2.7 + o * 1.7));
          amp *= 0.5; fq *= 2.1;
        }
        const a = Math.max(0, Math.pow(1 - r, 1.6) * (0.72 + 0.45 * n));
        const k = (y * TILE + x) * 4;
        d[k] = d[k + 1] = d[k + 2] = 255;
        d[k + 3] = Math.min(255, a * 255);
      }
    }
    c.putImageData(img, ox, oy);
  }
  radial(T_SPARK, [1, 1, 1], 3.2);
  radial(T_FLAME, [1, 1, 1], 1.5);
  radial(T_GLOW, [1, 1, 1], 2.2);
  radial(T_DISC, [1, 1, 1], 1.0);
  radial(T_STREAK, [1, 1, 1], 2.6);

  // 충격파 링
  {
    const [ox, oy] = at(T_RING);
    const img = c.createImageData(TILE, TILE);
    const d = img.data;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const dx = (x + 0.5) / TILE * 2 - 1, dy = (y + 0.5) / TILE * 2 - 1;
        const r = Math.hypot(dx, dy);
        const a = Math.max(0, 1 - Math.abs(r - 0.78) / 0.20) * (r < 1 ? 1 : 0);
        const k = (y * TILE + x) * 4;
        d[k] = d[k + 1] = d[k + 2] = 255;
        d[k + 3] = a * a * 255;
      }
    }
    c.putImageData(img, ox, oy);
  }

  // 금속 파편 — 각진 조각
  {
    const [ox, oy] = at(T_CHUNK);
    c.save();
    c.translate(ox + TILE / 2, oy + TILE / 2);
    c.fillStyle = '#fff';
    c.beginPath();
    c.moveTo(-16, -10); c.lineTo(14, -16); c.lineTo(18, 8); c.lineTo(-6, 17);
    c.closePath();
    c.fill();
    c.restore();
  }
  // ── 모양은 알파에만, RGB 는 전부 흰색 ─────────────────────────────
  // 이게 없으면 **깜빡이는 검은 네모**가 생긴다. Canvas2D 의 투명 픽셀은
  // RGB 가 0(검정)이다. 알파를 미리 곱하지 않은 채 밉맵을 만들면 밉 단계마다
  // '투명한 검정'과 '불투명한 흰색'이 평균되어 RGB 가 검게 끌려 내려간다.
  // 작게 그려진 파티클일수록 거친 밉을 고르므로 스프라이트 사각형 전체가
  // 검게 나타나고, 파티클이 났다 사라지니 깜빡이는 것으로 보인다.
  //
  // 캔버스에 되써 넣는 것으로는 못 고친다 — 캔버스는 내부적으로 알파를
  // 미리 곱해 저장해서, 알파 0 인 픽셀의 RGB 는 다시 0 으로 돌아간다.
  // 그래서 픽셀을 **원시 배열로 뽑아** 그대로 업로드한다.
  // 이 아틀라스의 타일은 전부 흰색이므로 RGB 는 그냥 255 로 채우면 된다.
  const raw = new Uint8Array(S * S * 4);
  const src = c.getImageData(0, 0, S, S).data;
  for (let i = 0; i < raw.length; i += 4) {
    raw[i] = raw[i + 1] = raw[i + 2] = 255;
    raw[i + 3] = src[i + 3];
  }
  return { data: raw, size: S };
}

export function uploadAtlas(gl, atlas) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  // 캔버스가 아니라 원시 배열로 올린다 — 캔버스 경로는 알파 0 인 픽셀의
  // RGB 를 0 으로 뭉개서, 밉맵을 만들면 검은 네모가 생긴다(buildAtlas 주석).
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, atlas.size, atlas.size, 0,
                gl.RGBA, gl.UNSIGNED_BYTE, atlas.data);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/** 굽기가 끝나기 전에 쓸 1×1 상수 텍스처(그림자 없음 · 차폐 없음).
 *  로딩 프리즈를 만들지 않기 위해 렌더는 이걸로 먼저 시작한다. */
export function whiteBake(gl) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                new Uint8Array([255, 255, 0, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export function uploadBake(gl, tex, buf, size) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                new Uint8Array(buf));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
