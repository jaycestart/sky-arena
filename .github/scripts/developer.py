"""개발자의 머리 — 문제를 읽고 코드 수정안을 받아 적용한다.

의존성 0 원칙을 지킨다. 파이썬 표준 라이브러리만 쓴다.

무료 열쇠 두 곳을 지원한다. 있는 것을 골라 쓰고, 둘 다 없으면 아무것도
하지 않는다(워크플로가 미리 걸러내지만 여기서도 한 번 더 본다).

  GEMINI_API_KEY  https://aistudio.google.com/apikey
  GROQ_API_KEY    https://console.groq.com/keys

모델에게는 **파일 전체를 다시 써서 달라**고 요구한다. 조각 수정(diff)은
공백 한 칸만 어긋나도 적용이 실패하는데, 실패를 사람이 확인해 줄 수 없는
자동 운영에서는 통째로 받는 편이 훨씬 안전하다.
"""

import io
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 개발자가 건드려도 되는 파일. 이 밖은 거부한다 — 워크플로 자신이나
# 검증 스크립트를 고치게 두면 안전장치를 스스로 무력화할 수 있다.
ALLOWED = ("server/game.py", "server/flightmath.py",
           "public/js/world.js", "public/js/hud.js", "public/js/input.js")
MAX_CHANGED_LINES = 200


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


# Groq 은 모델 이름을 자주 갈아치운다. 하나가 사라져도 개발자가 멈추지
# 않도록 여러 개를 순서대로 시도한다. 앞의 것일수록 코드를 잘 쓴다.
GROQ_MODELS = [
    "llama-3.3-70b-versatile",
    "moonshotai/kimi-k2-instruct",
    "qwen/qwen3-32b",
    "llama-3.1-8b-instant",
]


# Groq 앞단의 Cloudflare 가 파이썬 기본 신원(Python-urllib/3.x)을 보고
# 차단한다 — HTTP 403 error code 1010 이 그것이다. 열쇠와는 무관하다.
# 자기 소개를 제대로 하면 통과한다. 하나가 막히면 다음 것으로 넘어간다.
USER_AGENTS = [
    "sky-arena-developer/1.0 (+https://github.com/jaycestart/sky-arena)",
    "curl/8.5.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
]


def _post(url, body, headers, timeout=180):
    data = json.dumps(body).encode()
    last = None
    for ua in USER_AGENTS:
        h = dict(headers, **{"User-Agent": ua, "Accept": "application/json"})
        try:
            req = urllib.request.Request(url, data, h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            # 403 은 신원 차단일 수 있으니 다음 신원으로 다시 시도한다.
            # 401(열쇠 거부)·404(모델 없음)·429(한도)는 다시 해도 같으므로 바로 던진다.
            if e.code != 403:
                raise
            last = e
    raise last


def ask(prompt, max_tokens=8192):
    """무료 열쇠로 모델을 부른다. 응답 본문(문자열)을 돌려준다.

    어느 열쇠가 왜 실패했는지 반드시 남긴다. 조용히 실패하면 사람이
    열쇠를 잘못 넣은 것인지 모델이 죽은 것인지 알 수 없다."""
    gem, groq = os.environ.get("GEMINI_API_KEY"), os.environ.get("GROQ_API_KEY")
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
        give_up("열쇠가 없습니다. 저장소 비밀값에 GEMINI_API_KEY 나 "
                "GROQ_API_KEY 를 넣어주세요.")
    give_up("열쇠는 있는데 모델을 부르지 못했습니다.\n\n" + "\n".join(errs))


def _why(e):
    """예외에서 사람이 읽을 이유를 뽑는다."""
    if isinstance(e, urllib.error.HTTPError):
        try:
            body = e.read().decode()[:200]
        except Exception:
            body = ""
        if e.code == 401:
            return "열쇠가 거부됐습니다(401). 값이 잘못됐거나 만료됐습니다."
        if e.code == 404:
            return "그 모델이 없습니다(404)."
        if e.code == 429:
            return "무료 한도를 다 썼습니다(429). 잠시 뒤 다시 됩니다."
        return f"HTTP {e.code} {body}"
    return f"{type(e).__name__}: {e}"


def read(rel):
    return io.open(os.path.join(ROOT, rel), encoding="utf-8").read()


def main():
    issue = io.open("/tmp/issue.txt", encoding="utf-8").read()

    # 1단계 — 어느 파일을 봐야 하는지 먼저 묻는다. 전부 보내면 무료 한도를
    # 넘기고, 모델이 엉뚱한 곳을 고칠 위험도 커진다.
    pick = ask(
        "너는 SKY ARENA 라는 브라우저 3D 공중전 게임을 고치는 개발자다.\n"
        "아래 문제를 고치려면 어느 파일을 봐야 하는가?\n\n"
        f"{issue}\n\n"
        f"고를 수 있는 파일: {', '.join(ALLOWED)}\n\n"
        "파일 이름 하나만 답하라. 다른 말은 쓰지 마라. "
        "이 목록으로 고칠 수 없는 문제면 NONE 이라고만 답하라."
    ).strip()

    target = next((a for a in ALLOWED if a in pick), None)
    if not target:
        give_up("이 문제는 개발자가 건드릴 수 있는 파일로는 고칠 수 없다고 판단했습니다.\n\n"
                f"모델의 답: {pick[:300]}")

    src = read(target)
    if len(src) > 120000:
        give_up(f"{target} 이 너무 커서(무료 한도) 한 번에 다루지 못했습니다.")

    # 2단계 — 파일 전체를 다시 써서 받는다.
    ans = ask(
        "너는 SKY ARENA 라는 브라우저 3D 공중전 게임을 고치는 개발자다.\n"
        "아래 문제를 고쳐라.\n\n"
        f"=== 문제 ===\n{issue}\n\n"
        f"=== {target} 전체 ===\n{src}\n\n"
        "=== 반드시 지킬 것 ===\n"
        "- 외부 라이브러리를 쓰지 마라. 파이썬 표준 라이브러리와 순수 자바스크립트만 쓴다.\n"
        "- 서버(game.py)의 물리 공식을 고치면 클라이언트(world.js)의 예측 공식도\n"
        "  같은 값이 나와야 한다. 한쪽만 고치면 화면이 떨린다.\n"
        "- 조종·무기·물리를 바꾸면 봇에도 같이 적용해야 한다.\n"
        "- 꼭 필요한 곳만 최소한으로 고쳐라. 200줄 넘게 바뀌면 거부된다.\n"
        "- 한국어 주석으로 왜 그렇게 고쳤는지 남겨라.\n"
        "- 확실하지 않으면 고치지 마라. 추측으로 고치는 것보다 못 고치는 편이 낫다.\n\n"
        "=== 답하는 형식 ===\n"
        "고칠 수 있으면 이렇게만 답하라:\n"
        "SUMMARY: (무엇을 왜 고쳤는지 두세 문장, 한국어)\n"
        "```\n(파일 전체 내용)\n```\n\n"
        "고칠 수 없거나 확신이 없으면 이렇게만 답하라:\n"
        "CANNOT: (왜 못 고치는지, 한국어)"
    )

    if "CANNOT" in ans[:400] and "```" not in ans:
        give_up("개발자가 고치지 못했습니다.\n\n" + ans.split("CANNOT", 1)[-1].strip()[:800])

    m = re.search(r"```(?:python|javascript|js)?\n(.*?)```", ans, re.S)
    if not m:
        give_up("모델이 형식에 맞게 답하지 않아 적용하지 않았습니다.")
    new = m.group(1)

    sm = re.search(r"SUMMARY:\s*(.+?)(?:\n```|$)", ans, re.S)
    what = sm.group(1).strip() if sm else "(요약 없음)"

    if len(new) < len(src) * 0.5:
        give_up(f"모델이 돌려준 내용이 원본의 절반도 안 됩니다({len(new)} vs {len(src)}). "
                "잘려서 온 것으로 보여 적용하지 않았습니다.")

    io.open(os.path.join(ROOT, target), "w", encoding="utf-8", newline="\n").write(new)

    # 3단계 — 바뀐 양과 범위를 확인한다.
    diff = subprocess.run(["git", "diff", "--numstat"], cwd=ROOT,
                          capture_output=True, text=True).stdout.strip()
    changed = 0
    for line in diff.splitlines():
        a, b, path = line.split("\t")
        if path not in ALLOWED:
            subprocess.run(["git", "checkout", "--", "."], cwd=ROOT)
            give_up(f"허용되지 않은 파일({path})을 건드려 전부 되돌렸습니다.")
        changed += int(a or 0) + int(b or 0)

    if changed == 0:
        give_up("모델이 아무것도 바꾸지 않았습니다.")
    if changed > MAX_CHANGED_LINES:
        subprocess.run(["git", "checkout", "--", "."], cwd=ROOT)
        give_up(f"{changed}줄이나 바뀌어 한 번에 반영하기에는 위험합니다. 되돌렸습니다. "
                "사람이 나눠서 봐야 합니다.")

    summary(f"{what}\n\n고친 파일: `{target}` ({changed}줄)")
    out("patched", "yes")


if __name__ == "__main__":
    main()
