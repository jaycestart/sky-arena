"""RFC 6455 WebSocket 최소 구현.

외부 패키지 없이 asyncio 스트림 위에서 동작한다.
텍스트 프레임만 사용하며 ping/pong, 조각(fragment) 프레임을 처리한다.
"""

import asyncio
import base64
import hashlib
import struct

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"  # RFC 6455 §1.3 고정 상수
MAX_PAYLOAD = 1 << 20  # 1MB 이상 프레임은 거부


def accept_key(client_key: str) -> str:
    """Sec-WebSocket-Key 로부터 Sec-WebSocket-Accept 값을 계산한다."""
    digest = hashlib.sha1(client_key.encode() + GUID).digest()
    return base64.b64encode(digest).decode()


class WebSocket:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.reader = reader
        self.writer = writer
        self.closed = False
        self._send_lock = asyncio.Lock()

    async def recv(self):
        """텍스트 메시지 하나를 반환한다. 연결이 끝나면 None."""
        frags: list[bytes] = []
        frag_op = None
        while not self.closed:
            try:
                head = await self.reader.readexactly(2)
                b0, b1 = head[0], head[1]
                fin = b0 & 0x80
                op = b0 & 0x0F
                masked = b1 & 0x80
                length = b1 & 0x7F
                if length == 126:
                    length = struct.unpack("!H", await self.reader.readexactly(2))[0]
                elif length == 127:
                    length = struct.unpack("!Q", await self.reader.readexactly(8))[0]
                if length > MAX_PAYLOAD:
                    await self.close(1009)
                    return None
                mask = await self.reader.readexactly(4) if masked else None
                data = await self.reader.readexactly(length) if length else b""
            except (asyncio.IncompleteReadError, ConnectionError, OSError):
                self.closed = True
                return None

            if mask:
                data = bytes(byte ^ mask[i & 3] for i, byte in enumerate(data))

            if op == 0x8:  # close
                await self.close()
                return None
            if op == 0x9:  # ping -> pong
                await self._send_frame(0xA, data)
                continue
            if op == 0xA:  # pong
                continue

            if op == 0x0:  # continuation
                if frag_op is None:
                    continue
                frags.append(data)
            elif op in (0x1, 0x2):
                frag_op = op
                frags = [data]
            else:
                continue

            if fin:
                payload = b"".join(frags)
                op_done, frags, frag_op = frag_op, [], None
                if op_done == 0x1:
                    try:
                        return payload.decode()
                    except UnicodeDecodeError:
                        await self.close(1007)
                        return None
                # 바이너리 프레임은 이 게임에서 쓰지 않으므로 무시한다.
        return None

    async def send(self, text: str):
        await self._send_frame(0x1, text.encode())

    async def _send_frame(self, op: int, payload: bytes):
        if self.closed:
            return
        head = bytearray([0x80 | op])
        n = len(payload)
        if n < 126:
            head.append(n)
        elif n < 65536:
            head.append(126)
            head += struct.pack("!H", n)
        else:
            head.append(127)
            head += struct.pack("!Q", n)
        try:
            async with self._send_lock:
                self.writer.write(bytes(head) + payload)
                await self.writer.drain()
        except (ConnectionError, OSError, RuntimeError):
            self.closed = True

    async def close(self, code: int = 1000):
        if self.closed:
            return
        self.closed = True
        try:
            await self._force_frame(0x8, struct.pack("!H", code))
            self.writer.close()
        except (ConnectionError, OSError, RuntimeError):
            pass

    async def _force_frame(self, op: int, payload: bytes):
        head = bytearray([0x80 | op, len(payload)])
        self.writer.write(bytes(head) + payload)
        await self.writer.drain()
