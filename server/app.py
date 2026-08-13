"""SKY ARENA 서버 — 정적 파일 + WebSocket 을 한 포트에서 처리한다.

    python server/app.py            # 0.0.0.0:8080
    python server/app.py --port 3000

방(room)은 접속 URL 의 ?room= 으로 나뉜다. 방마다 독립된 월드와 봇이 돈다.
"""

import argparse
import asyncio
import json
import math
import mimetypes
import os
import re
import secrets
import socket
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 윈도우 콘솔(cp949)에서도 한글/기호가 깨지지 않도록
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except (AttributeError, OSError, ValueError):
        pass

from game import (CFG, CLASSES, DEFAULT_CLASS, DIFFICULTY, WEAPONS,  # noqa: E402
                  WEAPON_COUNT, World)
from ws import WebSocket, accept_key                 # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, "public")
MAX_PLAYERS = 24          # 방 하나당
MAX_ROOMS = 12
RESUME_TTL = 120.0        # 재접속 시 전적 복구 유효시간(초)
START = time.time()

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("application/manifest+json", ".webmanifest")




_BUILD_CACHE = {"mtime": 0.0, "value": ""}


def current_build():
    """public/js/main.js 의 BUILD 상수를 읽어 돌려준다.

    클라이언트는 자기 안의 BUILD 와 이 값을 비교해서, 다르면 낡은 번들을
    붙잡고 있다고 판단하고 워커·캐시를 걷어낸 뒤 다시 뜬다. 서버가 별도로
    계산한 값(예: 파일 mtime 해시)을 쓰면 클라 상수와 절대 같아질 수 없어
    매번 복구 루프를 돈다 — 반드시 **같은 출처**를 읽어야 한다."""
    f = os.path.join(PUBLIC, "js", "main.js")
    try:
        mt = os.path.getmtime(f)
        if mt != _BUILD_CACHE["mtime"]:
            with open(f, "r", encoding="utf-8") as fh:
                head = fh.read()   # 앞 4096자만 읽으면 BUILD 줄에 못 닿는다
            m = re.search(r"BUILD\s*=\s*'([^']+)'", head)
            _BUILD_CACHE["mtime"] = mt
            _BUILD_CACHE["value"] = m.group(1) if m else ""
    except OSError:
        pass
    return _BUILD_CACHE["value"]

class Client:
    def __init__(self, sock: WebSocket, plane):
        self.ws = sock
        self.plane = plane
        self.cache: dict = {}      # 델타 스냅샷용 마지막 전송 상태
        self.token = ""


class Room:
    """방 하나 = 월드 하나 + 접속자 + 게임 루프."""

    def __init__(self, name: str):
        self.name = name
        self.world = World(name)
        self.clients: dict[int, Client] = {}
        self.saved: dict[str, dict] = {}   # 재접속 복구용 전적
        self.task: asyncio.Task | None = None
        self.lag_ticks = 0

    @property
    def humans(self) -> int:
        return len(self.clients)

    def start(self):
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self.run())

    async def run(self):
        dt = 1.0 / CFG["tickHz"]
        next_t = time.perf_counter()
        lb_t = 0.0
        idle = 0.0
        while True:
            next_t += dt
            sleep = next_t - time.perf_counter()
            if sleep > 0:
                await asyncio.sleep(sleep)
            else:
                # 틱이 밀렸다 — 따라잡기를 포기하고 지연을 기록한다
                if sleep < -0.05:
                    self.lag_ticks += 1
                    if self.lag_ticks % 200 == 1:
                        print(f"[!] '{self.name}' 틱 지연 {-sleep * 1000:.0f}ms "
                              f"(누적 {self.lag_ticks}회, 접속 {self.humans}명)")
                next_t = time.perf_counter()

            w = self.world
            w.step(dt)

            # 아무도 없으면 30초 뒤 방을 정리한다(기본 방은 유지)
            if not self.clients:
                # 보낼 사람이 없어도 **반드시 비운다.** 예전에는 여기서 그냥
                # continue 로 빠져나갔는데, 아래 132줄이 리스트를 비우는
                # 유일한 곳이라 빈 방에서 이벤트가 무한히 쌓였다. 봇은 사람이
                # 없어도 계속 싸우기 때문이다. 그러다 첫 사람이 들어오면 그동안
                # 밀린 것이 한 틱에 전부 쏟아졌다 — 60초 놀면 299개(발사 183개),
                # 2분이면 초당 73발. BACKLOG 에 '사람이 접속하면 발사가
                # 폭증한다'고 적혀 있던 것의 정체가 이것이다.
                #
                # main 방은 위에서 정리되지 않으므로, 안 비우면 서버가 하루
                # 놀았을 때 리스트가 수십만 개로 자란다. 메모리 누수이기도 했다.
                w.joined.clear()
                w.left.clear()
                w.events.clear()
                idle += dt
                if idle > 30 and self.name != "main":
                    ROOMS.pop(self.name, None)
                    print(f"[x] 빈 방 '{self.name}' 정리")
                    return
                continue
            idle = 0.0

            joined, left, events = w.joined, w.left, w.events
            w.joined, w.left, w.events = [], [], []

            msgs = [json.dumps({"t": "j", **j}) for j in joined]
            msgs += [json.dumps({"t": "l", "id": pid}) for pid in left]
            msgs += [json.dumps({"t": "ev", **ev}) for ev in events]

            lb_t += dt
            if lb_t >= 1.0:
                lb_t = 0.0
                msgs.append(json.dumps({"t": "lb", "r": w.leaderboard()}))

            for m in msgs:
                await self.broadcast(m)
            if w.tick % CFG["snapEvery"] == 0:
                await self.send_snapshots()

    async def broadcast(self, text: str):
        sends = []
        for c in list(self.clients.values()):
            if c.ws.closed:
                self.drop(c.plane.id)
            else:
                sends.append(c.ws.send(text))
        if sends:
            await asyncio.gather(*sends, return_exceptions=True)

    async def send_snapshots(self):
        # 느린 클라이언트 한 명이 게임 루프 전체를 붙잡지 않도록 동시에 보낸다
        sends = []
        for c in list(self.clients.values()):
            if c.ws.closed:
                self.drop(c.plane.id)
                continue
            snap = self.world.snapshot(c.plane, c.cache)
            sends.append(c.ws.send(json.dumps(snap, separators=(",", ":"))))
        if sends:
            await asyncio.gather(*sends, return_exceptions=True)

    def drop(self, pid: int):
        c = self.clients.pop(pid, None)
        if not c:
            return
        p = c.plane
        if c.token:   # 잠깐 끊겨도 전적이 날아가지 않도록 보관
            self.saved[c.token] = {"score": p.score, "kills": p.kills,
                                   "deaths": p.deaths,
                                   "exp": time.time() + RESUME_TTL}
        self.world.remove_player(pid)
        print(f"[-] '{self.name}' 퇴장 id={pid} (접속 {self.humans}명)")

    def restore(self, token: str, plane):
        rec = self.saved.pop(token, None)
        if not rec or rec["exp"] < time.time():
            return False
        plane.score = rec["score"]
        plane.kills = rec["kills"]
        plane.deaths = rec["deaths"]
        return True

    # ── 클라이언트 세션 ──────────────────────────────────────────────
    async def session(self, sock: WebSocket):
        try:
            raw = await asyncio.wait_for(sock.recv(), 15)
        except asyncio.TimeoutError:
            await sock.close()
            return
        if raw is None:
            return
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            await sock.close()
            return
        if not isinstance(msg, dict) or msg.get("t") != "join":
            await sock.close()
            return
        if self.humans >= MAX_PLAYERS:
            await sock.send(json.dumps({"t": "full"}))
            await sock.close()
            return

        name = str(msg.get("name", ""))[:14].strip() or "PILOT"
        cls = msg.get("cls")
        cls = cls if cls in CLASSES else DEFAULT_CLASS
        # 방에 처음 들어온 사람이 봇 난이도를 정한다
        diff = msg.get("diff")
        if diff in DIFFICULTY and not self.clients:
            self.world.difficulty = diff
        plane = self.world.add_player(name, cls)
        client = Client(sock, plane)
        client.token = str(msg.get("token", ""))[:64] or secrets.token_hex(8)
        resumed = self.restore(client.token, plane)
        self.clients[plane.id] = client
        self.start()
        print(f"[+] '{self.name}' 참가 {name}({cls}) id={plane.id}"
              f"{' 전적복구' if resumed else ''} (접속 {self.humans}명)")

        await sock.send(json.dumps({
            "t": "welcome", "id": plane.id, "cfg": CFG, "classes": CLASSES,
            "weapons": WEAPONS, "difficulty": self.world.difficulty,
            "room": self.name, "token": client.token, "resumed": 1 if resumed else 0,
            "roster": self.world.roster(), "lb": self.world.leaderboard(),
        }))

        try:
            while True:
                raw = await sock.recv()
                if raw is None:
                    break
                await self.handle(client, raw)
        finally:
            self.drop(plane.id)
            await sock.close()

    async def handle(self, client: Client, raw: str):
        try:
            m = json.loads(raw)
        except json.JSONDecodeError:
            return
        if not isinstance(m, dict):
            return
        t = m.get("t")
        p = client.plane
        if t == "i":  # 조종 입력 — 망가진 값이 와도 연결을 끊지 않는다
            try:
                p.c_pitch = max(-1.0, min(1.0, float(m.get("pi", 0))))
                p.c_roll = max(-1.0, min(1.0, float(m.get("ro", 0))))
                p.c_yaw = max(-1.0, min(1.0, float(m.get("ya", 0))))
                p.throttle = max(0.0, min(1.0, float(m.get("th", 0.75))))
                p.seq = int(m.get("q", p.seq))
            except (TypeError, ValueError):
                return
            p.ab = bool(m.get("ab"))
            p.brake = bool(m.get("br"))
            # 'tb'(공중제비)는 더 이상 쓰지 않는다. 프로토콜을 건드리지 않기로
            # 했으므로 필드는 그대로 오지만 무시한다(클라도 0 만 보낸다).
            p.want_fire = bool(m.get("f"))
            p.want_missile = bool(m.get("ms"))
            p.want_flare = bool(m.get("fl"))
            # 마지막으로 입력을 받은 시각. 클라이언트의 전송 루프는
            # requestAnimationFrame 안에 있어서 탭을 가리면 멈춘다. 그러면
            # 마지막 패킷의 상태가 그대로 붙잡혀, 좌클릭을 누른 채 탭을
            # 전환하면 소켓이 끊길 때까지 0.42초마다 로켓이 계속 나갔다.
            # 창을 벗어날 때 클라가 보내는 해제 신호도 그 루프에 실려 있어서
            # 전달되지 못한다. 서버가 스스로 시간을 재는 수밖에 없다.
            #
            # 벽시계(time.time)가 아니라 **월드 시계**를 쓴다. 이 값을 재는
            # 쪽(World.step)이 self.time 으로 판단하므로 같은 시계여야 한다.
            p.last_input = self.world.time
            # 조준 방향(화면의 조준 원) — 없으면 기수 방향으로 쏜다
            aim = m.get("aim")
            if (isinstance(aim, list) and len(aim) == 3
                    and all(isinstance(v, (int, float)) for v in aim)):
                n = math.sqrt(aim[0] ** 2 + aim[1] ** 2 + aim[2] ** 2)
                p.aim = (aim[0] / n, aim[1] / n, aim[2] / n) if n > 1e-6 else None
            else:
                p.aim = None
            w = m.get("w")
            if isinstance(w, int) and 0 <= w < WEAPON_COUNT:
                p.weapon = w
        elif t == "pi":
            await client.ws.send(json.dumps({"t": "po", "c": m.get("c")}))
        elif t == "emote":  # 퀵 채팅
            idx = m.get("i")
            if isinstance(idx, int) and 0 <= idx < 8:
                await self.broadcast(json.dumps(
                    {"t": "em", "id": p.id, "i": idx, "n": p.name, "c": p.color}))


ROOMS: dict[str, Room] = {}


def get_room(name: str) -> Room | None:
    name = "".join(ch for ch in name if ch.isalnum() or ch in "-_")[:16] or "main"
    room = ROOMS.get(name)
    if room is None:
        if len(ROOMS) >= MAX_ROOMS:
            return None
        room = ROOMS[name] = Room(name)
        room.start()
        print(f"[o] 방 '{name}' 생성")
    return room


# ── HTTP ────────────────────────────────────────────────────────────────
def http_head(status: str, ctype: str, length: int, extra: str = "") -> bytes:
    return (f"HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\n"
            f"Content-Length: {length}\r\n{extra}Connection: close\r\n\r\n").encode()


async def serve_json(writer, obj):
    body = json.dumps(obj, ensure_ascii=False).encode()
    writer.write(http_head("200 OK", "application/json; charset=utf-8", len(body),
                           "Cache-Control: no-store\r\n"))
    writer.write(body)
    await writer.drain()


async def serve_static(writer, path: str, inm: str = "", head_only: bool = False):
    rel = urllib.parse.unquote(path.split("?")[0]).lstrip("/") or "index.html"
    full = os.path.normpath(os.path.join(PUBLIC, rel))
    if not full.startswith(PUBLIC) or not os.path.isfile(full):
        body = b"404 Not Found"
        writer.write(http_head("404 Not Found", "text/plain", len(body)))
        if not head_only:
            writer.write(body)
        await writer.drain()
        return

    st = os.stat(full)
    etag = f'"{int(st.st_mtime)}-{st.st_size}"'
    if inm == etag:      # 바뀌지 않았으면 본문을 다시 보내지 않는다
        writer.write(http_head("304 Not Modified", "text/plain", 0,
                               f"ETag: {etag}\r\n"))
        await writer.drain()
        return

    ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
    if ctype.startswith("text/") or "javascript" in ctype or "json" in ctype:
        ctype += "; charset=utf-8"
    with open(full, "rb") as f:
        body = f.read()
    writer.write(http_head("200 OK", ctype, len(body),
                           f"ETag: {etag}\r\nCache-Control: no-cache\r\n"))
    if not head_only:
        writer.write(body)
    await writer.drain()


async def on_connect(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 15)
    except (asyncio.TimeoutError, asyncio.IncompleteReadError,
            asyncio.LimitOverrunError, ConnectionError, OSError):
        writer.close()
        return

    lines = head.decode("latin1").split("\r\n")
    try:
        method, path, _ = lines[0].split(" ", 2)
    except ValueError:
        writer.close()
        return
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()

    if headers.get("upgrade", "").lower() == "websocket":
        key = headers.get("sec-websocket-key")
        if not key:
            writer.close()
            return
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(path).query)
        room = get_room(qs.get("room", ["main"])[0])
        writer.write(("HTTP/1.1 101 Switching Protocols\r\n"
                      "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Accept: {accept_key(key)}\r\n\r\n").encode())
        await writer.drain()
        sock = WebSocket(reader, writer)
        if room is None:
            await sock.send(json.dumps({"t": "full"}))
            await sock.close()
            return
        try:
            await room.session(sock)
        except (ConnectionError, OSError):
            pass
        return

    if method not in ("GET", "HEAD"):
        writer.close()
        return
    try:
        route = path.split("?")[0]
        if route == "/game.json":
            # 홈 화면이 기체/무기 정보를 서버와 동일한 값으로 그리도록
            await serve_json(writer, {"classes": CLASSES, "weapons": WEAPONS,
                                      "difficulty": DIFFICULTY, "cfg": CFG,
                                      "build": current_build()})
        elif route == "/stats.json":
            await serve_json(writer, {
                "uptime": round(time.time() - START, 1),
                "rooms": [{"name": r.name, "players": r.humans, "tick": r.world.tick,
                           "planes": len(r.world.planes),
                           "bots": sum(1 for p in r.world.planes.values() if p.is_bot),
                           "lag": r.lag_ticks}
                          for r in ROOMS.values()],
            })
        else:
            await serve_static(writer, path, headers.get("if-none-match", ""),
                               head_only=(method == "HEAD"))
    except (ConnectionError, OSError):
        pass
    finally:
        writer.close()


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


async def main():
    ap = argparse.ArgumentParser(description="SKY ARENA 서버")
    # 클라우드(Render 등)는 열어야 할 포트를 환경변수 PORT 로 통보한다.
    # 그 값을 안 쓰면 컨테이너는 8080 에 열고 플랫폼은 다른 포트를 찔러서,
    # 배포는 성공했는데 헬스체크만 계속 실패하는 상태가 된다.
    # 로컬에는 PORT 가 없으니 그대로 8080 이다.
    ap.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8080")))
    args = ap.parse_args()

    def quiet(loop, ctx):
        if isinstance(ctx.get("exception"), (ConnectionResetError, ConnectionAbortedError)):
            return
        loop.default_exception_handler(ctx)

    asyncio.get_running_loop().set_exception_handler(quiet)

    server = await asyncio.start_server(on_connect, args.host, args.port)
    get_room("main")
    ip = lan_ip()
    print("\n  ✈  SKY ARENA")
    print(f"     내 PC        :  http://localhost:{args.port}")
    print(f"     같은 와이파이 :  http://{ip}:{args.port}")
    print(f"     서버 상태     :  http://localhost:{args.port}/stats.json")
    print(f"     틱 {CFG['tickHz']}Hz / 스냅샷 {CFG['tickHz'] // CFG['snapEvery']}Hz"
          f" / 방당 최대 {MAX_PLAYERS}명 / 방 {MAX_ROOMS}개\n")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n서버 종료")
