"""파일을 '블록' 단위로 잘라낸다.

왜 필요한가: 개발자에게 파일을 통째로 보냈더니 무료 한도(분당 12,000 토큰)를
넘어 HTTP 413 으로 거절당했다. game.py 한 파일이 이미 그 한도를 넘는다.
고칠 부분만 오려서 보내고, 고쳐 온 것을 제자리에 끼워 넣는다.

블록이란 파이썬의 함수/메서드 하나, 자바스크립트의 함수/메서드 하나다.
이렇게 자르면 보내는 양이 수십분의 일로 줄고, 실수로 다른 곳을 건드릴
여지도 함께 줄어든다.
"""

import re


def _py_blocks(src):
    """파이썬 소스에서 (이름, 시작줄, 끝줄) 목록을 만든다.

    들여쓰기가 다시 얕아지는 곳이 함수의 끝이다. 빈 줄과 주석 줄은
    깊이를 판단할 근거가 되지 못하므로 건너뛴다."""
    lines = src.split("\n")
    out = []
    for i, ln in enumerate(lines):
        m = re.match(r"^(\s*)def\s+(\w+)", ln)
        if not m:
            continue
        indent, name = len(m.group(1)), m.group(2)
        j = i + 1
        end = i
        while j < len(lines):
            s = lines[j]
            if s.strip() and not s.lstrip().startswith("#"):
                cur = len(s) - len(s.lstrip())
                if cur <= indent:
                    break
                end = j
            j += 1
        out.append((name, i, end))
    return out


def _js_blocks(src):
    """자바스크립트 소스에서 함수/메서드를 중괄호 짝으로 잘라낸다.

    문자열이나 주석 안의 중괄호까지 세면 짝이 어긋난다. 완벽한 파서를
    만들 이유는 없고, 어긋나면 그 블록을 그냥 버린다."""
    lines = src.split("\n")
    out = []
    pat = re.compile(
        r"^\s*(?:(?:async\s+)?function\s+(\w+)|"          # function foo(
        r"(\w+)\s*\([^)]*\)\s*\{|"                        # foo(...) {   메서드
        r"(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\()")  # const foo = (
    for i, ln in enumerate(lines):
        m = pat.match(ln)
        if not m or ln.strip().startswith("//"):
            continue
        name = m.group(1) or m.group(2) or m.group(3)
        if not name or name in ("if", "for", "while", "switch", "catch", "return"):
            continue
        depth, started, end = 0, False, None
        for j in range(i, min(len(lines), i + 400)):
            for ch in lines[j]:
                if ch == "{":
                    depth += 1
                    started = True
                elif ch == "}":
                    depth -= 1
            if started and depth <= 0:
                end = j
                break
        if end is not None:
            out.append((name, i, end))
    return out


def blocks(path, src):
    """(이름, 시작줄, 끝줄) 목록. 줄 번호는 0 부터 센다."""
    got = _py_blocks(src) if path.endswith(".py") else _js_blocks(src)
    # 너무 큰 블록은 보내봐야 한도에 걸린다. 300줄을 넘으면 뺀다.
    return [b for b in got if b[2] - b[1] < 300]


def cut(src, start, end):
    return "\n".join(src.split("\n")[start:end + 1])


def paste(src, start, end, new):
    lines = src.split("\n")
    lines[start:end + 1] = new.rstrip("\n").split("\n")
    return "\n".join(lines)
