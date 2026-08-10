"""PWA 아이콘 생성기 — 외부 라이브러리 없이 순수 파이썬으로 PNG 를 직접 쓴다.

    python tools/make_icons.py
"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "public", "icons")

# 기체 실루엣(게임 렌더러의 HULL 과 동일한 형태)
HULL = [(27, 0), (11, 4), (3, 4), (-4, 16), (-11, 16), (-9, 4),
        (-17, 4), (-19, 9), (-24, 9), (-22, 2)]
POLY = HULL + [(x, -y) for x, y in reversed(HULL)]


def in_poly(px, py, poly):
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > py) != (y2 > py):
            xx = x1 + (py - y1) * (x2 - x1) / (y2 - y1)
            if px < xx:
                inside = not inside
    return inside


def write_png(path, size, pixels):
    raw = bytearray()
    for y in range(size):
        raw.append(0)                       # 필터 타입 None
        row = pixels[y]
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def render(size, maskable=False):
    """어두운 배경 + 대각선 광선 + 시안색 기체."""
    pad = 0.30 if maskable else 0.16       # maskable 은 안전 영역이 좁다
    scale = size * (1 - pad * 2) / 54.0
    cx, cy = size / 2, size / 2
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            nx, ny = (x - cx) / (size / 2), (y - cy) / (size / 2)
            d = math.hypot(nx, ny)
            # 배경: 중앙이 밝은 남색 그라데이션
            t = max(0.0, 1.0 - d)
            r = int(6 + 14 * t)
            g = int(10 + 30 * t)
            b = int(22 + 62 * t)
            a = 255
            # 대각선 속도선
            band = abs((nx * 0.7 + ny * 0.7) % 0.42 - 0.21)
            if band < 0.035 and d < 0.95:
                r = min(255, r + 18); g = min(255, g + 44); b = min(255, b + 70)
            # 기체 (오른쪽 위로 30도 기울임)
            ang = -math.radians(30)
            lx = (x - cx) / scale
            ly = (y - cy) / scale
            rx = lx * math.cos(-ang) - ly * math.sin(-ang)
            ry = lx * math.sin(-ang) + ly * math.cos(-ang)
            if in_poly(rx, ry, POLY):
                r, g, b = 56, 232, 255
            elif in_poly(rx, ry, [(px * 1.16, py * 1.16) for px, py in POLY]):
                r, g, b = 20, 90, 120       # 외곽 글로우
            if not maskable and d > 1.02:
                a = 0
            row.append((r, g, b, a))
        rows.append(row)
    return rows


os.makedirs(OUT, exist_ok=True)
for name, size, mask in (("icon-192.png", 192, False),
                         ("icon-512.png", 512, False),
                         ("icon-maskable.png", 512, True)):
    write_png(os.path.join(OUT, name), size, render(size, mask))
    print("wrote", os.path.join(OUT, name))
