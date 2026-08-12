"""열쇠 점검 — 개발자가 쓸 열쇠가 실제로 되는지 확인하고 결과를 남긴다.

맡길 일이 없으면 개발자는 모델을 부르지 않는다. 그래서 열쇠를 넣어도
되는지 안 되는지 알 수가 없었다. 이 점검은 일이 있든 없든 매번 돈다.
"""

import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import developer as D    # noqa: E402


def main():
    gem = bool(os.environ.get("GEMINI_API_KEY"))
    groq = bool(os.environ.get("GROQ_API_KEY"))
    which = " / ".join([n for n, v in (("구글", gem), ("Groq", groq)) if v]) or "없음"
    print(f"넣어둔 열쇠: {which}")

    if not gem and not groq:
        line = ("열쇠가 없습니다. 개발자는 대기합니다. "
                "저장소 비밀값에 GEMINI_API_KEY 나 GROQ_API_KEY 를 넣어주세요.")
        io.open("/tmp/keycheck.md", "w", encoding="utf-8").write(line)
        print(line)
        return 0

    # 짧게 한 번 불러본다. 실패하면 developer.ask 가 이유를 적고 종료한다.
    try:
        ans = D.ask("한국어로 정확히 '준비됨' 이라고만 답하라.", max_tokens=32)
    except SystemExit:
        # give_up 이 /tmp/summary.txt 에 이유를 적어두었다
        why = io.open("/tmp/summary.txt", encoding="utf-8").read()
        io.open("/tmp/keycheck.md", "w", encoding="utf-8").write("열쇠 점검 실패\n\n" + why)
        print("열쇠 점검 실패:\n" + why)
        return 1

    ok = f"열쇠 정상입니다. 모델이 답했습니다: {ans.strip()[:60]}"
    io.open("/tmp/keycheck.md", "w", encoding="utf-8").write(ok)
    print(ok)
    return 0


if __name__ == "__main__":
    sys.exit(main())
