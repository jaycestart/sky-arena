"""개발자의 머리 — 문제를 읽고 코드를 고친다.

의존성 0 원칙을 지킨다. 파이썬 표준 라이브러리만 쓴다.

── 파일을 통째로 보내지 않는 이유 ────────────────────────────────
처음에는 "파일 전체를 다시 써서 달라"고 했다. 첫 실전에서 바로 막혔다.
Groq 무료 한도가 분당 12,000 토큰인데 game.py 한 파일이 이미 14,000 토큰이라
HTTP 413 으로 거절당했다. 그래서 고칠 함수만 오려 보내고, 고쳐 온 것을
제자리에 끼워 넣는다. 보내는 양이 10분의 1로 줄고, 실수로 다른 곳을
건드릴 여지도 함께 줄어든다.

── 한 번에 여러 곳을 고치는 이유 ─────────────────────────────────
서버가 내려보내는 형식을 바꾸면 클라이언트가 읽는 형식도 같이 바뀌어야
한다. 한쪽만 고치면 화면에서 미사일이 사라진다. 그래서 서버와 클라이언트를
한 번에 고치도록 했다. 봇 전투 검증은 파이썬만 돌리므로 이 짝을 잡아내지
못한다 — 사람이 규칙으로 막아야 하는 자리다.

무료 열쇠 두 곳을 지원한다.
  GEMINI_API_KEY / GEMINI_SKY_ARENA   https://aistudio.google.com/apikey
  GROQ_API_KEY   / GROQ_SKY_ARENA     https://console.groq.com/keys
"""

import io
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blocks as B    # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 개발자가 건드려도 되는 파일. 이 밖은 거부한다 — 자기 워크플로나 검증
# 스크립트를 고치게 두면 안전장치를 스스로 무력화할 수 있다.
ALLOWED = ("server/game.py", "server/flightmath.py",
           "public/js/world.js", "public/js/hud.js", "public/js/input.js")
MAX_CHANGED_LINES = 200
MAX_BLOCKS = 3

# 2026-08-13 확인: kimi-k2 와 qwen3-32b 은 404 로 사라졌다. 살아 있는 것만 둔다.
GROQ_MODELS = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]

USER_AGENTS = [
    "sky-arena-developer/1.0 (+https://github.com/jaycestart/sky-arena)",
    "curl/8.5.0",
]


def out(key, val):
    with io.open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as f:
        f.write(f"{key}={val}\n")


def summary(text):
    io.open("/tmp/summary.txt", "w", encoding="utf-8").write(text)
    print(text)


def give_up(reason):
    summary(reason)
    out("patched", "no")
    sys.exit(0)


def _why(e):
    if isinstance(e, urllib.error.HTTPError):
        try:
            body = e.read().decode()[:200]
        except Exception:
            body = ""
        return {401: "열쇠가 거부됐습니다(401).",
                404: "그 모델이 없습니다(404).",
                413: f"보낸 내용이 너무 큽니다(413). {body}",
                429: "무료 한도를 다 썼습니다(429). 잠시 뒤 다시 됩니다."}.get(
                    e.code, f"HTTP {e.code} {body}")
    return f"{type(e).__name__}: {e}"


def _post(url, body, headers, timeout=180):
    data = json.dumps(body).encode()
    last = None
    for ua in USER_AGENTS:
        h = dict(headers, **{"User-Agent": ua, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(
                    urllib.request.Request(url, data, h), timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            # Cloudflare 가 파이썬 기본 신원을 403(code 1010)으로 막는다.
            # 그때만 다른 신원으로 다시 시도한다. 나머지는 다시 해도 같다.
            if e.code != 403:
                raise
            last = e
    raise last


def ask(prompt, max_tokens=4096):
    gem = os.environ.get("GEMINI_API_KEY")
    groq = os.environ.get("GROQ_API_KEY")
    errs = []
    if gem:
        try:
            d = _post("https://generativelanguage.googleapis.com/v1beta/models/"
                      "gemini-2.0-flash:generateContent?key=" + gem,
                      {"contents": [{"parts": [{"text": prompt}]}],
                       "generationConfig": {"temperature": 0.2,
                                            "maxOutputTokens": max_tokens}},
                      {"Content-Type": "application/json"})
            return d["candidates"][0]["content"]["parts"][0]["text"]
        except Exception as e:
            errs.append(f"구글: {_why(e)}")
    if groq:
        for model in GROQ_MODELS:
            try:
                d = _post("https://api.groq.com/openai/v1/chat/completions",
                          {"model": model,
                           "messages": [{"role": "user", "content": prompt}],
                           "temperature": 0.2, "max_tokens": max_tokens},
                          {"Content-Type": "application/json",
                           "Authorization": "Bearer " + groq})
                print(f"[모델] Groq {model}")
                return d["choices"][0]["message"]["content"]
            except Exception as e:
                errs.append(f"Groq {model}: {_why(e)}")
    if not gem and not groq:
        give_up("열쇠가 없습니다.")
    give_up("열쇠는 있는데 모델을 부르지 못했습니다.\n\n" + "\n".join(errs))


def read(rel):
    return io.open(os.path.join(ROOT, rel), encoding="utf-8").read()


def write(rel, text):
    io.open(os.path.join(ROOT, rel), "w", encoding="utf-8",
            newline="\n").write(text)


def code_of(ans):
    m = re.search(r"```(?:python|javascript|js)?\s*\n(.*?)```", ans, re.S)
    return m.group(1) if m else None


def main():
    issue = io.open("/tmp/issue.txt", encoding="utf-8").read()[:4000]

    # ── 1단계. 어느 파일의 어느 함수를 고칠지 고른다 ────────────────
    catalog = []
    index = {}
    for rel in ALLOWED:
        try:
            src = read(rel)
        except OSError:
            continue
        names = [n for n, a, b in B.blocks(rel, src)]
        index[rel] = src
        if names:
            catalog.append(f"{rel}: {', '.join(names)}")

    pick = ask(
        "너는 SKY ARENA 라는 브라우저 3D 공중전 게임을 고치는 개발자다.\n"
        "아래 문제를 고치려면 어느 함수를 고쳐야 하는가?\n\n"
        f"=== 문제 ===\n{issue}\n\n"
        f"=== 고칠 수 있는 함수 목록 ===\n" + "\n".join(catalog) + "\n\n"
        "=== 답하는 형식 ===\n"
        "고칠 함수를 `파일:함수` 형태로 한 줄에 하나씩, 최대 3개까지 적어라.\n"
        "다른 말은 절대 쓰지 마라. 예시:\n"
        "server/game.py:snapshot\n"
        "public/js/world.js:_applySnapshot\n\n"
        "**중요**: 서버가 내려보내는 형식을 바꾸면 클라이언트가 읽는 곳도\n"
        "반드시 함께 골라라. 한쪽만 고치면 화면이 깨진다.\n\n"
        "이 목록으로 고칠 수 없는 문제면 NONE 이라고만 답하라.", 512)

    targets = []
    for line in pick.splitlines():
        line = line.strip().strip("`-* ")
        if ":" not in line:
            continue
        rel, _, fn = line.partition(":")
        rel, fn = rel.strip(), fn.strip()
        if rel not in ALLOWED or rel not in index:
            continue
        for n, a, b in B.blocks(rel, index[rel]):
            if n == fn:
                targets.append((rel, n, a, b))
                break

    if not targets:
        give_up("이 문제는 개발자가 건드릴 수 있는 함수로는 고칠 수 없다고 "
                f"판단했습니다.\n\n모델의 답: {pick.strip()[:400]}")
    targets = targets[:MAX_BLOCKS]

    # ── 2단계. 함수를 하나씩 오려 보내고 고쳐 받는다 ────────────────
    notes = []
    for rel, fn, a, b in targets:
        seg = B.cut(index[rel], a, b)
        others = [f"{r}:{n}" for r, n, _, _ in targets if (r, n) != (rel, fn)]
        ans = ask(
            "너는 SKY ARENA 라는 브라우저 3D 공중전 게임을 고치는 개발자다.\n"
            f"아래 문제를 고치기 위해 `{rel}` 의 `{fn}` 함수를 고쳐라.\n\n"
            f"=== 문제 ===\n{issue}\n\n"
            + (f"=== 같이 고치는 중인 다른 함수 ===\n{', '.join(others)}\n"
               "이 함수들과 주고받는 형식이 어긋나지 않게 하라.\n\n" if others else "")
            + f"=== 지금의 {fn} ===\n```\n{seg}\n```\n\n"
            "=== 반드시 지킬 것 ===\n"
            "- 외부 라이브러리를 쓰지 마라. 파이썬 표준 라이브러리와 순수 자바스크립트만.\n"
            "- 이 함수 **하나만** 통째로 다시 써라. 다른 함수는 건드리지 마라.\n"
            "- 들여쓰기를 원본과 똑같이 맞춰라. 함수 정의 줄부터 시작해야 한다.\n"
            "- 꼭 필요한 곳만 최소한으로 고쳐라.\n"
            "- 한국어 주석으로 왜 그렇게 고쳤는지 남겨라.\n"
            "- 확실하지 않으면 고치지 마라. 추측으로 고치는 것보다 못 고치는 편이 낫다.\n\n"
            "=== 답하는 형식 ===\n"
            "고칠 수 있으면:\n"
            "SUMMARY: (무엇을 왜 고쳤는지 한두 문장, 한국어)\n"
            "```\n(고친 함수 전체)\n```\n\n"
            "고칠 수 없으면:\nCANNOT: (이유, 한국어)")

        if "CANNOT" in ans[:300] and "```" not in ans:
            give_up(f"`{rel}` 의 `{fn}` 을 고치지 못했습니다.\n\n"
                    + ans.split("CANNOT", 1)[-1].strip()[:600])
        new = code_of(ans)
        if not new:
            give_up(f"`{fn}` 에 대해 모델이 형식에 맞게 답하지 않아 적용하지 않았습니다.")
        if not new.lstrip().startswith(("def ", "async ", "function ")) \
                and fn not in new.split("\n")[0]:
            give_up(f"`{fn}` 으로 돌려받은 내용이 함수 모양이 아닙니다. 적용하지 않았습니다.")

        index[rel] = B.paste(index[rel], a, b, new)
        m = re.search(r"SUMMARY:\s*(.+?)(?:\n```|$)", ans, re.S)
        notes.append(f"- `{rel}` 의 `{fn}`: "
                     + (m.group(1).strip() if m else "(요약 없음)"))
        # 같은 파일의 다른 함수를 이어 고칠 때 줄 번호가 밀리므로 다시 잡는다
        for k, (r2, n2, _, _) in enumerate(targets):
            if r2 == rel:
                for n3, a3, b3 in B.blocks(rel, index[rel]):
                    if n3 == n2:
                        targets[k] = (r2, n2, a3, b3)
                        break

    for rel in {r for r, _, _, _ in targets}:
        write(rel, index[rel])

    # ── 3단계. 바뀐 양과 범위를 확인한다 ────────────────────────────
    diff = subprocess.run(["git", "diff", "--numstat"], cwd=ROOT,
                          capture_output=True, text=True).stdout.strip()
    changed = 0
    for line in diff.splitlines():
        add, rem, path = line.split("\t")
        if path not in ALLOWED:
            subprocess.run(["git", "checkout", "--", "."], cwd=ROOT)
            give_up(f"허용되지 않은 파일({path})을 건드려 전부 되돌렸습니다.")
        changed += int(add or 0) + int(rem or 0)

    if changed == 0:
        give_up("모델이 아무것도 바꾸지 않았습니다.")
    if changed > MAX_CHANGED_LINES:
        subprocess.run(["git", "checkout", "--", "."], cwd=ROOT)
        give_up(f"{changed}줄이나 바뀌어 한 번에 반영하기에는 위험합니다. "
                "되돌렸습니다. 사람이 나눠서 봐야 합니다.")

    summary("\n".join(notes) + f"\n\n모두 {changed}줄이 바뀌었습니다.")
    out("patched", "yes")


if __name__ == "__main__":
    main()
