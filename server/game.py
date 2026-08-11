"""SKY ARENA 3D — 서버 권위 전투기 시뮬레이션.

물리 상수(CFG/AIRCRAFT/WEAPONS)는 접속 시 클라이언트로 내려보내고,
클라이언트는 같은 공식으로 자기 기체를 예측한다.

비행 모델(단순화했지만 실제 공력에 기반):
  · 받음각(AoA)에 따른 양력계수, 실속 이후 양력 붕괴
  · 유도항력 k·CL², 천음속 항력 상승, 고도에 따른 공기밀도·추력 감소
  · 조종면 효과는 동압에 비례 — 저속·고고도에서 둔해진다
  · 피치 선회율은 구조 G 한계로 제한 (ω = n·g / V)
"""

import math
import random

# sound_speed / q_mul / q_rot 는 옛 항공역학 분기와 함께 사라졌다.
from flightmath import (G, TERRAIN_MAX, air_density, fwd, ground_h, q_axis_angle,
                        q_from_heading, q_hpb, hpb_from_q, wrap_pi,
                        q_integrate, q_norm, right,
                        up, v_add, v_cross, v_dot, v_len, v_mul,
                        v_norm, v_sub)

# ── 전역 설정 ───────────────────────────────────────────────────────
CFG = {
    "tickHz": 50,
    "snapEvery": 2,             # 25Hz 스냅샷
    "worldR": 4500.0,           # 전장 반경(m). 좁을수록 바로 교전이 붙는다
    "ceiling": 17000.0,         # 실용 상승한계
    "gLimit": 30.0,             # 구조 한계 G (아케이드 — 시선에 바로 붙도록)
    "gLOC": 8.0,                # 이 이상 지속되면 시야가 좁아진다(블랙아웃)
    "planeR": 9.0,              # 피격 반경(m)
    "gunHitR": 115.0,            # 기총 판정은 넉넉하게 — 맞히는 재미 우선
    "hpMax": 100.0,
    "respawn": 2.6,             # 격추 후 재출격 대기
    "wreckDrag": 0.055,         # 잔해 낙하 저항(작을수록 빨리 떨어진다)
    "wreckSpin": 2.4,           # 잔해 회전(rad/s)
    "spawnInvuln": 3.0,
    "spawnAlt": 3200.0,
    "spawnSpeed": 450.0,
    # ── 아케이드 비행 ──────────────────────────────────────────────
    "arcMin": 300.0,            # 스로틀 0
    "arcMax": 830.0,            # 스로틀 100%
    "arcBoost": 1450.0,          # 애프터버너
    "arcAccel": 700.0,          # 속도 변화율
    "flares": 20,
    "flareCd": 0.45,
    "viewR": 14000.0,           # 스냅샷 시야 반경
    "stallWarnMargin": 0.85,    # 실속각의 85% 부터 경고
    # ── 렌더링 전용 (서버 물리는 이 값을 전혀 참조하지 않는다) ────
    # 방을 만들 때 한 번 정하고 **경기 중에는 고정**한다. 실시간으로
    # 흐르게 하면 태양 그림자를 주기적으로 다시 구워야 하고 재베이크
    # 중 조명 불일치 관리가 따라붙는데, 몇 분짜리 판에서 얻는 게 없다.
    "tod": 14.5,                # 시각 0~24. 하늘·태양·그림자를 정한다
    "wx": 0,                    # 0=맑음, 1=흐림, 2=박무
}

def _init_tod():
    """서버가 뜰 때 실제 시각으로 시간대를 한 번 정한다.

    방마다 다르게 하려면 app.py 가 CFG 를 통째로 넘기는 대신 방별 사본을
    만들어야 하는데, 이번 범위에서는 app.py 를 건드리지 않기로 했다.
    한 판이 몇 분인 게임이라 실시간으로 흐르게 할 이유도 없다 — 태양이
    움직이면 베이크한 그림자를 주기적으로 다시 구워야 한다.
    고정값을 쓰고 싶으면 아래 두 줄을 지우고 CFG["tod"] 를 직접 적으면 된다."""
    import time as _time
    lt = _time.localtime()
    h = lt.tm_hour + lt.tm_min / 60.0
    if h < 6.5:      # 밤은 지원하지 않는다 — 새벽/황혼 구간으로 접는다
        h += 12.0
    if h > 18.0:
        h -= 12.0
    return round(min(18.0, max(6.5, h)), 2)


# 실제 시각을 따라가면 아침·저녁에 태양이 낮게 깔려 대기 통과 거리가 길어지고
# 화면이 통째로 뿌예진다(사용자가 오전 8시에 겪은 증상). 사실적이긴 하지만
# 게임 화면으로는 색과 대비가 다 죽는다. 태양이 높은 시각으로 고정한다.
# 실제 시각을 쓰고 싶으면 아래 줄을 CFG["tod"] = _init_tod() 로 바꾸면 된다.
CFG["tod"] = 13.0

# 기체 3종 — 실제 전투기 성향을 참고한 값.
#
# 회전율은 **여기 한 곳에만** 정의된다. 클라이언트는 welcome 의 classes 를
# 그대로 읽어 쓰므로(world.js `this.ac = this.aircraft[...]`) 서버-클라
# 불일치가 원리적으로 생길 수 없다. Plane.step 의 적분식은 손대지 않았으니
# world.js `_integrate` 도 그대로다 — 예측 차이 0.000000도가 유지된다.
#
# pitchRate 를 올려 **주축**으로 만들었다. 100°/s 는 아케이드 근접전 기준으로
# 느렸고, 좌우가 위아래보다 빠른 배분은 '기수를 끌어올려 조준한다'는 감각을
# 죽인다. yawRate 는 내리지 않는다 — 내리면 수평 추적이 느려져 '맞히기
# 쉬울 것'에 역행한다. 이 값은 input.js 기수 추종 제어기의 시간상수(0.11초)와
# 맞물려, 기수가 조준점에 0.2초 안에 붙게 하려고 고른 것이다.
#
# ── 전체 크기 배율 (2026-08-11) ────────────────────────────────────────────
# 사용자 요구: "비행기 크기를 많이 늘리고, 더 멀리서 바라봐서 **상대는 커 보이고
# 내 비행기는 비슷해 보이게**" — 기체를 K 배 키우고 카메라도 K 배 물리면
# 내 기체의 화면 점유율은 그대로인데, 월드에서 같은 거리에 있는 적기는
# 정확히 K 배 커진다. 그게 이 상수의 전부다.
#
# 피격 반경(planeR)도 같이 키운다. 안 그러면 눈에 크게 보이는 적을 쐈는데
# 빗나가는, 제일 나쁜 종류의 불일치가 생긴다.
# 클라이언트는 welcome 의 classes 에서 mscale 을 읽으므로 자동으로 따라온다.
JET_SCALE = 3.0

# ── span / length / mscale (2026-08-09) ────────────────────────────────────
# **렌더링 전용이다. Plane.step 도 world._integrate 도 이 값을 읽지 않는다.**
# 읽는 순간 서버-클라 공식이 갈라져 화면이 떨린다(실제로 여러 번 난 버그다).
# 위 CFG 의 tod/wx 와 같은 성격 — 서버가 값만 들고 있고 그림에만 쓴다.
#
# span/length 는 실물 제원(m)이고 mscale 은 buildJet() 메시를 그만큼 키우는
# 균등 배율이다. 메시 실측: 구조 날개폭 12.10m(익단 x=±6.05) · 전장 18.20m
# (피토관 z=+10.85 ~ 노즐 z=-7.35). mscale 은 (실물폭/12.10) 과
# (실물길이/18.20) 의 평균이다 — 두 비의 차이가 0.33~0.78% 라 하나로 합쳐도
# 결과가 실측 ±0.5% 안에 든다(메시의 전장/폭 비 1.504 가 세 기종 실물
# 1.489~1.509 와 이미 일치하기 때문이다).
#
# 명중 판정은 이 값을 **절대** 참조하지 않는다. 살아 있는 판정은
# _sweep(pos, fuse) 하나뿐이고 기체를 한 점으로 본다. planeR 을 _sweep 에
# 배선하지 말 것 — 그러면 '메시 크기 현실화' 커밋이 조용히 판정 반경을
# 40→45m 로 넓히게 되고 원인 추적이 지옥이 된다.
AIRCRAFT = {
    "falcon": {
        "label": "F-16 형", "role": "경량 도그파이터",
        "mass": 9500.0, "wing": 27.9, "thrust": 175000.0, "abThrust": 330000.0,
        "cl_a": 4.6, "cd0": 0.019, "k": 0.115, "stall": 0.40,
        "rollRate": 6.4, "yawRate": 2.9, "pitchRate": 2.60, "gLimit": 30.0,
        "span": 9.96, "length": 15.03, "mscale": 0.824,
        "desc": "가볍고 롤이 빠르다. 근접전 최강.",
    },
    "eagle": {
        "label": "F-15 형", "role": "제공 전투기",
        "mass": 14300.0, "wing": 56.5, "thrust": 240000.0, "abThrust": 480000.0,
        "cl_a": 4.3, "cd0": 0.021, "k": 0.095, "stall": 0.38,
        "rollRate": 5.4, "yawRate": 2.6, "pitchRate": 2.15, "gLimit": 30.0,
        "span": 13.05, "length": 19.43, "mscale": 1.073,
        "desc": "추력이 압도적. 상승과 가속으로 싸운다.",
    },
    "flanker": {
        "label": "Su-27 형", "role": "고기동 중전투기",
        "mass": 17500.0, "wing": 62.0, "thrust": 225000.0, "abThrust": 540000.0,
        "cl_a": 4.9, "cd0": 0.024, "k": 0.088, "stall": 0.52,
        "rollRate": 4.9, "yawRate": 3.0, "pitchRate": 2.90, "gLimit": 28.0,
        "span": 14.70, "length": 21.94, "mscale": 1.210,
        "desc": "받음각을 크게 쓴다. 저속 선회가 강하다.",
    },
}
for _a in AIRCRAFT.values():
    _a["mscale"] = round(_a["mscale"] * JET_SCALE, 4)
CFG["planeR"] = round(CFG["planeR"] * JET_SCALE, 2)

DEFAULT_AIRCRAFT = "falcon"
# app.py 는 기체 목록을 CLASSES / DEFAULT_CLASS 이름으로 참조한다
CLASSES = AIRCRAFT
DEFAULT_CLASS = DEFAULT_AIRCRAFT

# 기총은 없앴다. 둘 다 미사일이고, 좌클릭은 무유도 고속탄 · 우클릭은 유도탄이다.
# 유도가 없는 대신 훨씬 빠르고 아프게, 유도가 되는 대신 덜 아프게 — 조준
# 실력과 편의를 맞바꾸는 구조다.
WEAPONS = [
    {"key": "rocket", "label": "무유도 로켓", "icon": "▲",
     "desc": "유도가 없다. 대신 매우 빠르고 한 방이 크다. 겨눈 곳으로 직진.",
     "ammo": 99, "cd": 0.42, "dmg": 46.0, "fuse": 40.0,
     "burn": 1.2, "thrust": 60000.0, "mass": 60.0, "maxG": 0.0,
     "seeker": 0.0, "range": 7000.0, "life": 7.0, "lockTime": 0.0,
     "lockCone": 0.0, "rearAspect": 1.0, "muzzle": 900.0, "arm": 0.06},
    {"key": "aim9", "label": "IR 미사일", "icon": "➤",
     "desc": "후방 추적. 발사 후 자율 유도. 플레어에 속는다.",
     "ammo": 99, "cd": 0.9, "dmg": 30.0, "fuse": 45.0,
     "burn": 4.0, "thrust": 17000.0, "mass": 85.0, "maxG": 420.0,
     "seeker": 3.00, "range": 9000.0, "life": 26.0, "lockTime": 0.18,
     "lockCone": 0.95, "rearAspect": 1.9, "arm": 0.35},
]
WEAPON_COUNT = len(WEAPONS)
ROCKET, MISSILE = 0, 1
GUN = ROCKET          # 옛 이름 — 스냅샷/봇 코드가 아직 참조한다

COLORS = ["#7fd4ff", "#ff8f8f", "#9dff9d", "#ffd98a", "#c4a6ff", "#ffb37a",
          "#7cf5df", "#ff9ec4", "#a8c4ff", "#e8ff8a"]

BOT_NAMES = ["VIPER", "GHOST", "RAPTOR", "NOVA", "ECHO", "BLAZE", "TALON",
             "ONYX", "HAWK", "ZERO", "STORM", "KITE"]

# 봇 조종기를 차트축 P 제어기로 갈아끼운다(input.js 와 같은 식).
# 사용자 확인이 끝나 켰다(2026-08-09). 이제 봇은 사람과 **완전히 같은** 조종
# 체계를 쓴다 — 차트축 P 제어기, 같은 회전율, 같은 무기. 앞으로 조작·무기·
# 물리를 바꿀 때는 사람 쪽만 고치고 끝내지 말고 반드시 여기까지 함께 볼 것.
# 수직 기동을 쓰기 시작해 원반 선회가 사라지고 AIRCRAFT 회전율 상향과 겹쳐
# 난이도가 두 겹으로 오르므로 아래 gPull 이 자동으로 0.75배가 된다.
BOT_CHART_AXIS = True

BOT_TIERS = {
    "rookie": {"tag": "◦", "err": 0.10, "react": 0.9, "gPull": 0.55,
               "cone": 0.09, "ac": "eagle", "missile": False},
    "veteran": {"tag": "◈", "err": 0.045, "react": 0.5, "gPull": 0.8,
                "cone": 0.055, "ac": "falcon", "missile": True},
    "ace": {"tag": "★", "err": 0.018, "react": 0.25, "gPull": 1.0,
            "cone": 0.035, "ac": "flanker", "missile": True},
}
if BOT_CHART_AXIS:
    # 새 제어기는 훨씬 정확하게 기수를 끌어온다 — 난이도를 먼저 0.75배로
    # 되돌려 두고, 실전 승률을 본 뒤 cone 까지 조정한다.
    for _t in BOT_TIERS.values():
        _t["gPull"] *= 0.75
# 난이도별 봇 구성과 인원
DIFFICULTY = {
    "training": {"label": "훈련", "mix": ["rookie"], "count": 1,
                 "desc": "루키 1기. 조종과 조준 연습용."},
    "easy": {"label": "쉬움", "mix": ["rookie", "rookie", "veteran"], "count": 3,
             "desc": "루키 위주. 편하게 격추 연습."},
    "normal": {"label": "보통", "mix": ["rookie", "veteran", "ace", "rookie", "veteran"],
               "count": 5, "desc": "기본 구성."},
    "hard": {"label": "어려움", "mix": ["veteran", "ace", "ace", "veteran", "ace"],
             "count": 5, "desc": "에이스 다수. 미사일과 회피를 적극적으로 쓴다."},
}
DEFAULT_DIFFICULTY = "normal"
BOT_MIX = DIFFICULTY[DEFAULT_DIFFICULTY]["mix"]
MIN_POPULATION = DIFFICULTY[DEFAULT_DIFFICULTY]["count"]

_NEXT_ID = 1


def new_id():
    global _NEXT_ID
    _NEXT_ID += 1
    return _NEXT_ID


def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


class Plane:
    """조종 가능한 전투기 한 대."""

    def __init__(self, pid, name, color, ac=DEFAULT_AIRCRAFT,
                 is_bot=False, tier="veteran"):
        self.id = pid
        self.name = name
        self.color = color
        self.is_bot = is_bot
        self.tier = tier
        self.ac_key = ac if ac in AIRCRAFT else DEFAULT_AIRCRAFT
        self.ac = AIRCRAFT[self.ac_key]

        self.score = 0
        self.kills = 0
        self.deaths = 0
        self.streak = 0

        # 조종 입력
        self.c_pitch = 0.0
        self.c_roll = 0.0
        self.c_yaw = 0.0
        self.throttle = 0.75
        self.ab = False
        self.brake = False
        self.want_fire = False
        self.want_missile = False
        self.want_flare = False
        self.weapon = GUN
        self.aim = None          # 조준 방향(월드 단위벡터). 없으면 기수 방향.
        self.seq = 0

        # 봇 상태
        self.target_id = 0
        self.retarget_t = 0.0
        self.aim_err = 0.0
        self.bot_t = 0.0

        # 피드백(스냅샷마다 비움)
        self.hit_marks = []
        self.hurt_marks = []
        self.killer_name = ""
        self.damage_from = {}
        self.spawn()

    # ── 상태 초기화 ─────────────────────────────────────────────────
    def spawn(self):
        a = random.uniform(0, math.tau)
        r = random.uniform(600.0, 1900.0)      # 서로 가까이 출격한다
        self.pos = [math.cos(a) * r, CFG["spawnAlt"] + random.uniform(-300, 500),
                    math.sin(a) * r]
        # 전장 중앙을 향해 출격한다(방위각은 +Z 에서 +X 방향으로 잰다)
        hdg = math.atan2(-self.pos[0], -self.pos[2]) + random.uniform(-0.4, 0.4)
        self.q = q_from_heading(hdg)
        self.hdg, self.pit, self.bnk = hpb_from_q(self.q)
        f = fwd(self.q)
        self.vel = list(v_mul(f, CFG["spawnSpeed"]))
        self.hp = CFG["hpMax"]
        self.alive = True
        self.respawn_t = 0.0
        self.invuln = CFG["spawnInvuln"]
        self.ammo = WEAPONS[ROCKET]["ammo"]
        self.missiles = WEAPONS[MISSILE]["ammo"]
        self.flares = CFG["flares"]
        self.fire_t = 0.0
        self.ms_cd = 0.0
        self.flare_cd = 0.0
        self.lock_id = 0
        self.lock_t = 0.0
        self.locked_by = 0
        self.rwr = 0            # 나를 향해 날아오는 미사일 수
        self.gload = 1.0
        self.aoa = 0.0
        self.mach = 0.0
        self.stalling = False
        self.blackout = 0.0
        self.last_hit_t = -99.0
        self.last_hit_by = 0
        self.streak = 0
        self.damage_from.clear()

    # ── 비행 물리 ───────────────────────────────────────────────────
    def step(self, dt, now):
        if not self.alive:
            # 격추된 기체는 잔해가 되어 회전하며 빠르게 떨어진다
            self.respawn_t -= dt
            self.vel[1] -= G * 3.4 * dt          # 양력이 사라져 급격히 낙하
            drag = CFG["wreckDrag"] * dt
            self.vel[0] -= self.vel[0] * drag
            self.vel[1] -= self.vel[1] * drag
            self.vel[2] -= self.vel[2] * drag
            self.pos[0] += self.vel[0] * dt
            self.pos[1] += self.vel[1] * dt
            self.pos[2] += self.vel[2] * dt
            spin = CFG["wreckSpin"]
            self.q = q_integrate(self.q, (spin * 0.7, spin * 0.35, spin), dt)
            if self.respawn_t <= 0:
                self.spawn()
            return

        self.invuln = max(0.0, self.invuln - dt)
        self.ms_cd = max(0.0, self.ms_cd - dt)
        self.flare_cd = max(0.0, self.flare_cd - dt)
        self.fire_t = max(0.0, self.fire_t - dt)

        # ── 아케이드 비행 모델 ───────────────────────────────────────
        # 실속·G 한계·에너지 손실 없이 속도와 선회를 분리한다.
        # 기체는 언제나 기수 방향으로 날고, 회전 속도는 속도와 무관하다.
        ac = self.ac
        target = CFG["arcBoost"] if self.ab else (
            CFG["arcMin"] + (CFG["arcMax"] - CFG["arcMin"]) * self.throttle)
        if self.brake:
            target *= 0.55
        cur = v_len(tuple(self.vel))
        step = CFG["arcAccel"] * dt
        spd = cur + clamp(target - cur, -step * 1.8, step)

        pr = clamp(self.c_pitch, -1, 1) * ac["pitchRate"]
        rr = clamp(self.c_roll, -1, 1) * ac["rollRate"]
        yr = clamp(self.c_yaw, -1, 1) * ac["yawRate"]

        # 방위·기수각·비틀기를 따로 들고 매 틱 자세를 새로 만든다.
        # 각속도로 굴려 쌓지 않으므로 피치·요를 아무리 섞어도 비틀기에
        # 스며들지 않는다 — 마우스로는 원반처럼 돌 뿐 절대 안 비틀린다.
        # 위아래도 제한이 없다 — 계속 당기면 수직을 넘어 한 바퀴 돈다.
        self.hdg = wrap_pi(self.hdg + yr * dt)
        self.pit = wrap_pi(self.pit + pr * dt)
        self.bnk = wrap_pi(self.bnk + rr * dt)
        self.q = q_hpb(self.hdg, self.pit, self.bnk)

        # 기체는 언제나 기수 방향으로 난다.
        # 공중제비(tumble) 분기는 지웠다 — 아무도 그 플래그를 켜지 않아 죽은
        # 코드였다. 클라 world.js `_integrate` 의 짝도 같은 커밋에서 지웠다.
        fv = fwd(self.q)
        self.vel = [fv[0] * spd, fv[1] * spd, fv[2] * spd]
        self.pos[0] += self.vel[0] * dt
        self.pos[1] += self.vel[1] * dt
        self.pos[2] += self.vel[2] * dt

        self.mach = spd / 340.0
        self.aoa = 0.0
        self.gload = 1.0 + abs(pr) * 4.0
        self.stalling = False
        self.blackout = 0.0
        # 옛 항공역학 분기(양력·항력·실속·G 한계)는 지웠다 — 위 아케이드
        # 분기가 항상 return 하므로 절대 실행되지 않는 코드였다.
        # 짝인 world.js `_integrate` 의 같은 블록도 같은 커밋에서 지웠다.
        # 되살릴 거라면 두 파일을 반드시 함께 되살려야 한다.

    def take_damage(self, amount, attacker_id, now):
        if self.invuln > 0 or not self.alive:
            return 0.0
        self.hp -= amount
        self.last_hit_t = now
        self.last_hit_by = attacker_id
        if attacker_id:
            prev = self.damage_from.get(attacker_id, (0.0, 0.0))[1]
            self.damage_from[attacker_id] = (now, prev + amount)
        return amount


class Missile:
    """발사체 하나. kind 로 무기 종류(0=무유도 로켓, 1=유도탄)를 들고 다닌다.
    유도 여부·수명·위력이 전부 kind 에서 나오므로 두 무기가 같은 코드를 쓴다."""

    __slots__ = ("id", "pos", "vel", "q", "life", "owner", "target", "burn",
                 "armed", "decoyed", "kind")

    def __init__(self, mid, pos, vel, q, owner, target, kind=MISSILE):
        spec = WEAPONS[kind]
        self.id = mid
        self.kind = kind
        self.pos = list(pos)
        self.vel = list(vel)
        self.q = q
        self.life = spec["life"]
        self.owner = owner
        self.target = target
        self.burn = spec["burn"]
        # 무장 지연은 무기마다 다르다. 로켓은 초속 2000m 로 튀어 나가므로
        # 0.35초면 700m 를 날아간 뒤에야 신관이 살아난다 — 그 안쪽의 적은
        # 그냥 관통해 버린다(근접전에서 한 발도 안 맞는 원인이었다).
        # 발사기에서 벗어날 최소한(약 120m)만 준다.
        self.armed = spec.get("arm", 0.35)
        self.decoyed = False


class Flare:
    __slots__ = ("pos", "vel", "life", "owner")

    def __init__(self, pos, vel, owner):
        self.pos = list(pos)
        self.vel = list(vel)
        self.life = 4.5
        self.owner = owner


class World:
    def __init__(self, room="main", difficulty=DEFAULT_DIFFICULTY):
        self.room = room
        self.difficulty = difficulty if difficulty in DIFFICULTY else DEFAULT_DIFFICULTY
        self.planes = {}
        self.bullets = []
        self.missiles = []
        self.flares = []
        self.time = 0.0
        self.tick = 0
        self.events = []
        self.joined = []
        self.left = []

    # ── 접속 ────────────────────────────────────────────────────────
    def add_player(self, name, ac=DEFAULT_AIRCRAFT, is_bot=False, tier="veteran"):
        pid = new_id()
        p = Plane(pid, name[:14] or f"PILOT{pid}", COLORS[pid % len(COLORS)],
                  ac, is_bot, tier)
        self.planes[pid] = p
        self.joined.append(self.roster_entry(p))
        return p

    def remove_player(self, pid):
        if self.planes.pop(pid, None):
            self.left.append(pid)

    def roster_entry(self, p):
        return {"id": p.id, "n": p.name, "c": p.color, "bot": 1 if p.is_bot else 0,
                "ac": p.ac_key, "tg": BOT_TIERS[p.tier]["tag"] if p.is_bot else ""}

    def roster(self):
        return [self.roster_entry(p) for p in self.planes.values()]

    # ── 메인 루프 ───────────────────────────────────────────────────
    def step(self, dt):
        self.time += dt
        self.tick += 1
        now = self.time

        for p in self.planes.values():
            if p.is_bot:
                self._bot_think(p, dt)
            was_alive = p.alive
            p.step(dt, now)
            if p.alive and not was_alive:
                self._face_nearest(p)      # 재출격 시 가까운 적 쪽을 향하게
            if p.alive:
                self._check_bounds(p, dt)

        self._update_locks(dt)

        for p in self.planes.values():
            if not p.alive:
                continue
            # 좌클릭 = 무유도 로켓, 우클릭 = 유도탄. 둘 다 탄약 무제한이다.
            if p.want_fire and p.fire_t <= 0:
                self._launch(p, ROCKET)
            if p.want_missile and p.ms_cd <= 0:
                self._launch(p, MISSILE)
            if p.want_flare and p.flare_cd <= 0 and p.flares > 0:
                self._drop_flare(p)

        self._step_bullets(dt)
        self._step_missiles(dt)
        self._step_flares(dt)
        self._fill_with_bots()

    def _face_nearest(self, p):
        """출격 직후 가장 가까운 적을 향해 기수를 맞춘다(찾아 헤매지 않도록)."""
        best, best_d = None, 1e18
        for q_ in self.planes.values():
            if q_.id == p.id or not q_.alive:
                continue
            d = v_dot(v_sub(tuple(q_.pos), tuple(p.pos)), v_sub(tuple(q_.pos), tuple(p.pos)))
            if d < best_d:
                best, best_d = q_, d
        if best is None:
            return
        los = v_sub(tuple(best.pos), tuple(p.pos))
        hdg = math.atan2(los[0], los[2])
        pitch = math.asin(clamp(v_norm(los)[1], -0.5, 0.5))
        p.q = q_from_heading(hdg, pitch)
        speed = v_len(tuple(p.vel))
        f = fwd(p.q)
        p.vel = [f[0] * speed, f[1] * speed, f[2] * speed]

    def _check_bounds(self, p, dt):
        # 지면 충돌
        if p.pos[1] <= ground_h(p.pos[0], p.pos[2]) + 8.0:
            p.hp = 0
            self._kill(p, self.planes.get(p.last_hit_by)
                       if self.time - p.last_hit_t < 4 else None, ground=True)
            return
        # 전장 이탈 / 상승한계
        d = math.hypot(p.pos[0], p.pos[2])
        if d > CFG["worldR"]:
            if p.invuln <= 0:
                p.hp -= 20.0 * dt
                p.last_hit_t = self.time
            if p.hp <= 0:
                self._kill(p, None)
        if p.pos[1] > CFG["ceiling"]:
            p.vel[1] = min(p.vel[1], 0.0)

    # ── 무장 ────────────────────────────────────────────────────────
    def aim_dir(self, p, max_off=1.15):
        """조준 방향을 기수 기준 원뿔 안으로 자른다(1.15rad ≈ 66도).

        클라이언트 리시 기본값 55도 + 여유 11도다. 정상 플레이에서는 이
        한계에 닿지 않는다 — 리시를 90도까지 올리거나 끈 사용자만 걸리고,
        그 상태는 HUD 가 십자를 주황 X 로 바꿔 알려 준다.
        예전 값 2.60rad 은 실제로 **149도**였다(독스트링은 80도라고 적혀
        있었다). 기수를 뒤로 두고도 사격이 통과해서, 기수를 겨누는 조종
        기량이 게임에서 사라지고 서버 권위 검증도 사실상 없는 상태였다.
        """
        f = fwd(p.q)
        a = p.aim
        if not a:
            return f
        d = clamp(v_dot(a, f), -1.0, 1.0)
        if d >= math.cos(max_off):
            return v_norm(a)
        perp = v_sub(a, v_mul(f, d))
        if v_len(perp) < 1e-6:
            return f
        perp = v_norm(perp)
        return v_norm(v_add(v_mul(f, math.cos(max_off)), v_mul(perp, math.sin(max_off))))

    def _launch(self, p, kind=MISSILE):
        spec = WEAPONS[kind]
        f = self.aim_dir(p)      # 화면 조준 십자 방향 그대로 발사
        r = right(p.q)
        if kind == ROCKET:
            # 무유도 — 락온을 보지 않는다. 겨눈 방향으로 그냥 쏜다.
            p.fire_t = spec["cd"]
            target = 0
            side = -1.0 if int(p.fire_t * 1000) % 2 else 1.0
            muzzle = spec["muzzle"]
        else:
            p.ms_cd = spec["cd"]
            target = p.lock_id if p.lock_t >= spec["lockTime"] else 0
            side = -1.0 if p.missiles % 2 else 1.0
            muzzle = 400.0
        # 발사점은 **기체 좌표계** 값이라 메시 배율을 같이 먹여야 한다.
        # 안 그러면 flanker(1.21배)는 미사일이 날개 안쪽에서, falcon(0.824배)은
        # 날개 바깥 허공에서 튀어나온다. 사람·봇이 같은 _launch 를 쓰므로
        # 여기 한 줄이 양쪽에 동시에 적용된다.
        # 가로 오프셋 3.2 는 메시의 어느 파일런과도 안 맞는 값이다. buildJet
        # hardpoint() 의 안쪽 파일런이 x = lerp(1.02, 6.05, 0.34) = 2.74,
        # 바깥쪽이 4.04 다. 안쪽에 맞춘다 — 미사일이 '달려 있던 자리'에서
        # 나가야 발사가 발사로 읽힌다. 판정(_sweep)은 손대지 않는다.
        ms = p.ac.get("mscale", 1.0)
        pos = v_add(v_add(p.pos, v_mul(f, 4.0 * ms)), v_mul(r, 2.74 * ms * side))
        vel = v_add(tuple(p.vel), v_mul(f, muzzle))
        self.missiles.append(Missile(new_id(), pos, vel, p.q, p.id, target, kind))
        self.events.append({"e": "launch", "id": p.id, "k": kind})

    def _drop_flare(self, p):
        p.flare_cd = CFG["flareCd"]
        p.flares -= 1
        u = up(p.q)
        r = right(p.q)
        # 사출 **위치**는 기체 좌표계라 메시 배율을 먹인다(디스펜서는 동체 밑에
        # 있다). 사출 **속도** -12/9 m/s 는 기체 크기와 무관한 물리량이라
        # 배율을 곱하지 않는다 — 곱하면 큰 기체의 플레어가 더 빨리 흩어진다.
        # (지시서는 여기 9.0 을 '익단 위치 6.05' 로 바꾸라고 했지만 9.0 은
        #  가로 **속도**이지 위치가 아니다. 플레어 디스펜서는 익단이 아니라
        #  동체 하부에 있으므로 위치 오프셋은 0.9m 가 맞다.)
        ms = p.ac.get("mscale", 1.0)
        for s in (-1.0, 1.0):
            pos = v_add(p.pos, v_add(v_mul(u, -0.55 * ms), v_mul(r, 0.9 * ms * s)))
            vel = v_add(tuple(p.vel), v_add(v_mul(u, -12.0), v_mul(r, 9.0 * s)))
            self.flares.append(Flare(pos, vel, p.id))

    def _step_bullets(self, dt):
        rho_k = 0.00016          # 단순 탄도 감속 계수
        hit_r = CFG["planeR"]
        alive = []
        for b in self.bullets:
            b.life -= dt
            if b.life <= 0:
                continue
            sp = v_len(tuple(b.vel))
            drag = rho_k * sp * air_density(b.pos[1]) / 1.225
            b.vel[0] -= b.vel[0] * drag * dt
            b.vel[1] -= b.vel[1] * drag * dt + G * dt
            b.vel[2] -= b.vel[2] * drag * dt
            a = tuple(b.pos)
            b.pos[0] += b.vel[0] * dt
            b.pos[1] += b.vel[1] * dt
            b.pos[2] += b.vel[2] * dt
            # 고고도 탄은 지형을 평가할 필요조차 없다 — 50Hz x 약 170발이라
            # 이 조기 탈출만으로 오히려 비용이 줄어든다.
            if b.pos[1] > TERRAIN_MAX:
                pass
            elif b.pos[1] < ground_h(b.pos[0], b.pos[2]):
                # 착탄 이펙트를 이벤트로 보내지 않는다 — 초당 수백 발이라
                # 이벤트 채널이 막힌다. 기총 착탄은 클라가 스냅샷의 탄이
                # 사라진 것으로 알아서 처리한다.
                continue
            hit = self._sweep(a, tuple(b.pos), CFG["gunHitR"], b.owner)
            if hit is None:
                alive.append(b)
                continue
            victim, hp = hit
            self._apply_hit(victim, b.owner, b.dmg, hp)
        self.bullets = alive

    def _step_missiles(self, dt):
        alive = []
        for m in self.missiles:
            spec = WEAPONS[m.kind]        # 로켓과 유도탄이 같은 코드를 공유한다
            m.life -= dt
            m.armed = max(0.0, m.armed - dt)
            if m.life <= 0:
                continue
            vel = tuple(m.vel)
            V = v_len(vel)
            vhat = v_norm(vel) if V > 1 else fwd(m.q)

            # 시커가 없으면(무유도 로켓) 표적 탐색도 유도도 하지 않는다.
            # 아래 블록들은 전부 spec["seeker"] > 0 을 전제로 한다.
            if spec["seeker"] <= 0.0:
                m.target = 0

            # 락온 없이 쏜 미사일은 시커 시야 안에서 스스로 표적을 찾는다
            # (없으면 그냥 직진해 버려 '이상한 곳으로 날아가는' 것처럼 보인다)
            # 단, 플레어에 속은 미사일은 다시 잡지 않는다(기만이 무의미해지므로)
            if not m.target and not m.decoyed and spec["seeker"] > 0.0:
                best, best_d = 0, spec["range"] ** 2
                for q_ in self.planes.values():
                    if q_.id == m.owner or not q_.alive or q_.invuln > 0:
                        continue
                    los = v_sub(tuple(q_.pos), tuple(m.pos))
                    d2 = v_dot(los, los)
                    if d2 > best_d:
                        continue
                    if v_dot(v_norm(los), vhat) < math.cos(spec["seeker"]):
                        continue
                    best, best_d = q_.id, d2
                if best:
                    m.target = best

            tgt = self.planes.get(m.target)
            if tgt and tgt.alive:
                los = v_sub(tuple(tgt.pos), tuple(m.pos))
                dist = v_len(los)
                lhat = v_norm(los)
                # 시커 시야각을 벗어나면 잃는다
                if v_dot(lhat, vhat) < math.cos(spec["seeker"]) or dist > spec["range"]:
                    m.target = 0
                else:
                    # 플레어 유혹 판정
                    for fl in self.flares:
                        if fl.owner != tgt.id:
                            continue
                        fd = v_sub(tuple(fl.pos), tuple(m.pos))
                        if v_len(fd) < dist * 0.9 and \
                                v_dot(v_norm(fd), lhat) > 0.985 and random.random() < 0.16:
                            m.target = 0
                            m.decoyed = True
                            break
                    if m.target:
                        # 비례항법: 시선각속도에 비례한 가속도 명령
                        rel_v = v_sub(tuple(tgt.vel), vel)
                        vc = -v_dot(rel_v, lhat)
                        omega = v_mul(v_cross(los, rel_v), 1.0 / max(1.0, v_dot(los, los)))
                        a_cmd = v_mul(v_cross(omega, vhat), 13.0 * max(vc, 350.0))
                        a_max = spec["maxG"] * G
                        if v_len(a_cmd) > a_max:
                            a_cmd = v_mul(v_norm(a_cmd), a_max)
                        m.vel[0] += a_cmd[0] * dt
                        m.vel[1] += a_cmd[1] * dt
                        m.vel[2] += a_cmd[2] * dt

            # 추진 / 항력 / 중력
            if m.burn > 0:
                m.burn -= dt
                acc = spec["thrust"] / spec["mass"]
                m.vel[0] += vhat[0] * acc * dt
                m.vel[1] += vhat[1] * acc * dt
                m.vel[2] += vhat[2] * acc * dt
            drag = 0.00004 * V * air_density(m.pos[1]) / 1.225
            m.vel[0] -= m.vel[0] * drag * dt
            m.vel[1] -= m.vel[1] * drag * dt + G * dt
            m.vel[2] -= m.vel[2] * drag * dt

            a = tuple(m.pos)
            m.pos[0] += m.vel[0] * dt
            m.pos[1] += m.vel[1] * dt
            m.pos[2] += m.vel[2] * dt
            m.q = q_norm(_look_q(v_norm(tuple(m.vel))))

            if m.pos[1] <= TERRAIN_MAX and m.pos[1] < ground_h(m.pos[0], m.pos[2]):
                # 물이면 지면 폭발 대신 물기둥 이펙트로 갈린다(클라 분기)
                self.events.append({"e": "boom", "x": round(m.pos[0]),
                                    "y": round(m.pos[1]), "z": round(m.pos[2]),
                                    "g": 1, "w": 1 if m.pos[1] <= 0.5 else 0})
                continue
            if m.armed <= 0:
                hit = self._sweep(a, tuple(m.pos), spec["fuse"], m.owner)
                if hit is not None:
                    victim, hp = hit
                    self._apply_hit(victim, m.owner, spec["dmg"], hp, big=True)
                    self.events.append({"e": "boom", "x": round(hp[0]),
                                        "y": round(hp[1]), "z": round(hp[2])})
                    continue
            alive.append(m)
        self.missiles = alive

    def _step_flares(self, dt):
        alive = []
        for f in self.flares:
            f.life -= dt
            if f.life <= 0:
                continue
            f.vel[1] -= G * dt
            drag = 0.9 * dt
            f.vel[0] -= f.vel[0] * drag
            f.vel[1] -= f.vel[1] * drag
            f.vel[2] -= f.vel[2] * drag
            f.pos[0] += f.vel[0] * dt
            f.pos[1] += f.vel[1] * dt
            f.pos[2] += f.vel[2] * dt
            alive.append(f)
        self.flares = alive

    def _sweep(self, a, b, radius, owner):
        """이동 선분과 기체의 충돌(빠른 탄이 뚫고 지나가지 않도록)."""
        seg = v_sub(b, a)
        seg2 = v_dot(seg, seg)
        r2 = radius * radius
        for p in self.planes.values():
            if not p.alive or p.id == owner or p.invuln > 0:
                continue
            ap = v_sub(tuple(p.pos), a)
            t = 0.0 if seg2 <= 0 else clamp(v_dot(ap, seg) / seg2, 0.0, 1.0)
            closest = v_add(a, v_mul(seg, t))
            d = v_sub(tuple(p.pos), closest)
            if v_dot(d, d) <= r2:
                return p, closest
        return None

    def _apply_hit(self, victim, owner_id, dmg, hp, big=False):
        dealt = victim.take_damage(dmg, owner_id, self.time)
        if dealt <= 0:
            return
        shooter = self.planes.get(owner_id)
        if shooter:
            shooter.score += 8 if big else 1
            if not shooter.is_bot and len(shooter.hit_marks) < 20:
                shooter.hit_marks.append([round(hp[0], 1), round(hp[1], 1),
                                          round(hp[2], 1), round(dealt)])
        if not victim.is_bot and len(victim.hurt_marks) < 20:
            victim.hurt_marks.append([round(hp[0], 1), round(hp[1], 1),
                                      round(hp[2], 1), round(dealt)])
        if victim.hp <= 0:
            self._kill(victim, shooter)

    def _kill(self, victim, killer, ground=False):
        if not victim.alive:
            return
        victim.alive = False
        victim.hp = 0
        victim.deaths += 1
        victim.streak = 0
        victim.respawn_t = CFG["respawn"]
        # 격추 순간 기수가 꺾여 곧바로 곤두박질친다
        victim.vel[0] *= 0.45
        victim.vel[2] *= 0.45
        victim.vel[1] = min(victim.vel[1] * 0.45, 0.0) - 55.0
        victim.killer_name = killer.name if killer and killer.id != victim.id else ""
        self.events.append({"e": "boom", "x": round(victim.pos[0]),
                            "y": round(victim.pos[1]), "z": round(victim.pos[2])})
        if killer and killer.id != victim.id:
            killer.kills += 1
            killer.streak += 1
            killer.score += 100 + 20 * min(killer.streak, 5)
            self.events.append({"e": "kill", "k": killer.name, "v": victim.name,
                                "kc": killer.color, "vc": victim.color,
                                "s": killer.streak})
        else:
            victim.score = max(0, victim.score - 20)
            self.events.append({"e": "kill", "k": "", "v": victim.name, "kc": "",
                                "vc": victim.color, "s": 0,
                                "g": 1 if ground else 0})
        victim.damage_from.clear()

    # ── 레이더 / 락온 ───────────────────────────────────────────────
    def _update_locks(self, dt):
        spec = WEAPONS[MISSILE]
        for p in self.planes.values():
            p.locked_by = 0
            p.rwr = 0
        for m in self.missiles:
            t = self.planes.get(m.target)
            if t:
                t.rwr += 1
        for p in self.planes.values():
            if not p.alive:
                p.lock_id, p.lock_t = 0, 0.0
                continue
            f = fwd(p.q)
            best, best_d = 0, spec["range"] ** 2
            for q_ in self.planes.values():
                if q_.id == p.id or not q_.alive or q_.invuln > 0:
                    continue
                los = v_sub(tuple(q_.pos), tuple(p.pos))
                d2 = v_dot(los, los)
                if d2 > best_d:
                    continue
                lhat = v_norm(los)
                if v_dot(lhat, f) < math.cos(spec["lockCone"]):
                    continue
                # 후방 반구일수록 열원이 잘 보인다
                tf = fwd(q_.q)
                aspect = v_dot(lhat, tf)          # 1 = 상대 꽁무니를 봄
                if aspect < 0.15 and math.sqrt(d2) > spec["range"] / spec["rearAspect"]:
                    continue
                best, best_d = q_.id, d2
            if best and best == p.lock_id:
                p.lock_t = min(spec["lockTime"], p.lock_t + dt)
            else:
                p.lock_id, p.lock_t = best, 0.0
        for p in self.planes.values():
            if p.lock_id and p.lock_t >= spec["lockTime"]:
                t = self.planes.get(p.lock_id)
                if t:
                    t.locked_by = p.id

    # ── 봇 ──────────────────────────────────────────────────────────
    def _fill_with_bots(self):
        diff = DIFFICULTY[self.difficulty]
        humans = [p for p in self.planes.values() if not p.is_bot]
        bots = [p for p in self.planes.values() if p.is_bot]
        # 나 포함 인원이 count+1 이 되도록 채운다(훈련=봇 1기).
        # MIN_POPULATION 은 전역 상한 — 테스트에서 0 으로 두면 봇이 뜨지 않는다.
        cap = min(diff["count"], MIN_POPULATION)
        want = max(0, cap - len(humans) + 1) if cap > 0 else 0
        if len(bots) < want:
            used = {p.name for p in self.planes.values()}
            pool = [n for n in BOT_NAMES if n not in used] or BOT_NAMES
            mix = diff["mix"]
            tier = mix[len(bots) % len(mix)]
            self.add_player(random.choice(pool), BOT_TIERS[tier]["ac"],
                            is_bot=True, tier=tier)
        elif len(bots) > want:
            self.remove_player(bots[-1].id)

    def _bot_think(self, bot, dt):
        if not bot.alive:
            bot.want_fire = bot.want_missile = bot.want_flare = False
            return
        prof = BOT_TIERS[bot.tier]
        bot.want_fire = bot.want_missile = bot.want_flare = False
        bot.ab = False

        f = fwd(bot.q)
        u = up(bot.q)
        r = right(bot.q)
        alt = bot.pos[1]
        ground = ground_h(bot.pos[0], bot.pos[2])
        V = v_len(tuple(bot.vel))

        # 1순위: 지면 회피
        agl = alt - ground
        if agl < 900 and bot.vel[1] < 40:
            self._bot_point(bot, v_norm((bot.vel[0], 260.0, bot.vel[2])), prof, 1.0)
            bot.throttle = 1.0
            bot.ab = True
            return
        # 2순위: 미사일 회피(플레어 + 빔 기동)
        if bot.rwr > 0:
            bot.want_flare = True
            side = v_add(v_mul(r, 1.0), (0.0, 0.25, 0.0))
            self._bot_point(bot, v_norm(side), prof, prof["gPull"])
            bot.throttle = 1.0
            bot.ab = True
            return

        bot.retarget_t -= dt
        tgt = self.planes.get(bot.target_id)
        if tgt is None or not tgt.alive or bot.retarget_t <= 0:
            best, best_d = None, 1e18
            for p in self.planes.values():
                if p.id == bot.id or not p.alive:
                    continue
                d = v_dot(v_sub(tuple(p.pos), tuple(bot.pos)),
                          v_sub(tuple(p.pos), tuple(bot.pos)))
                if not p.is_bot:
                    d *= 0.4
                if d < best_d:
                    best, best_d = p, d
            bot.target_id = best.id if best else 0
            bot.retarget_t = random.uniform(3.0, 6.0)
            bot.aim_err = random.gauss(0, prof["err"])
            tgt = best
        if tgt is None:
            self._bot_point(bot, v_norm((f[0], 0.05, f[2])), prof, 0.4)
            bot.throttle = 0.8
            return

        los = v_sub(tuple(tgt.pos), tuple(bot.pos))
        dist = v_len(los)
        # 로켓 리드: 로켓은 발사 뒤에도 계속 가속한다(추력/질량 = 15000 m/s^2).
        # muzzle 만 쓰면 실제보다 느리게 잡아 표적을 크게 앞질러 겨눈다.
        # 등가속 해: d = v0*t + a*t^2/2 를 t 에 대해 푼다.
        v0 = WEAPONS[ROCKET]["muzzle"]
        acc = WEAPONS[ROCKET]["thrust"] / WEAPONS[ROCKET]["mass"]
        tof = (math.sqrt(v0 * v0 + 2.0 * acc * dist) - v0) / acc
        aim = v_add(tuple(tgt.pos), v_mul(tuple(tgt.vel), tof))
        want = v_norm(v_sub(aim, tuple(bot.pos)))
        want = v_norm((want[0] + bot.aim_err, want[1] + bot.aim_err * 0.5,
                       want[2] + bot.aim_err))
        self._bot_point(bot, want, prof, prof["gPull"])

        # 에너지 관리
        bot.throttle = 1.0
        bot.ab = dist > 1500 or V < 200
        off = math.acos(clamp(v_dot(v_norm(los), f), -1.0, 1.0))
        if off < prof["cone"] and dist < 1800:
            bot.want_fire = True
        if prof["missile"] and dist > 600 and \
                bot.lock_t >= WEAPONS[MISSILE]["lockTime"]:
            bot.want_missile = True

    def _bot_keep_in(self, bot, want):
        """전장 밖·고고도로 새어 나가지 않게 원하는 방향을 안쪽으로 당긴다.

        옛 뱅크투턴 제어기는 원반 선회밖에 못 해서 저절로 아레나 안을 돌았다.
        차트축 제어기로 바꾸니 표적만 보고 직선으로 나가 반경 4500m 를 넘고
        초당 20 피해로 죽는다(실측: 60초에 사망 16회 중 14회가 이탈사).
        수직 기동이 열린 것도 겹쳐 12km 까지 줌클라임한다. 사람은 눈으로 보고
        알아서 되돌아오지만 봇은 그 감각이 없으므로 여기서 대신 넣어 준다."""
        R = CFG["worldR"]
        x, y, z = bot.pos
        d = math.hypot(x, z)
        # 수평: 0.62R 부터 서서히, 0.95R 에서 완전히 중심 쪽으로
        tw = clamp((d / R - 0.62) / 0.33, 0.0, 1.0)
        # 수직: 6500m 위 / 1200m 아래에서 되돌린다
        hi = clamp((y - 6500.0) / 3000.0, 0.0, 1.0)
        lo = clamp((1200.0 - y) / 900.0, 0.0, 1.0)
        w = max(tw, hi, lo)
        if w <= 0.0:
            return want
        inward = (-x / max(d, 1.0) * tw, (lo - hi), -z / max(d, 1.0) * tw)
        if v_len(inward) < 1e-6:
            return want
        inward = v_norm(inward)
        blend = v_add(v_mul(want, 1.0 - w), v_mul(inward, w))
        return v_norm(blend) if v_len(blend) > 1e-6 else want

    def _bot_point(self, bot, want, prof, gain):
        """원하는 방향으로 기수를 돌리도록 조종 입력을 만든다."""
        want = self._bot_keep_in(bot, want)
        if not BOT_CHART_AXIS:
            # ── 옛 뱅크투턴 제어기 ───────────────────────────────────
            # 아케이드 hpb 모델에서 c_pitch 는 **월드 자오선** 회전이라
            # 롤을 걸어도 선회로 이어지지 않는다. 그래서 봇이 원반 선회만
            # 한다(RESUME 의 관찰). BOT_CHART_AXIS 를 켜면 아래 새 제어기다.
            f, u, r = fwd(bot.q), up(bot.q), right(bot.q)
            x = v_dot(want, r)
            y = v_dot(want, u)
            z = v_dot(want, f)
            roll_cmd = clamp(math.atan2(x, max(y, 0.15)) * 1.4, -1.0, 1.0)
            pitch_cmd = clamp((1.0 - z) * 3.0, 0.0, 1.0) * gain
            if y < -0.2 and abs(x) < 0.3:
                pitch_cmd = -0.35
            bot.c_roll = roll_cmd
            bot.c_pitch = pitch_cmd
            bot.c_yaw = clamp(x * 0.4, -0.5, 0.5)
            return

        # ── 차트축 P 제어기 ─────────────────────────────────────────
        # public/js/input.js `sample()` 의 제어기를 그대로 옮긴 것이다.
        # 두 구현이 어긋나면 봇과 사람이 다른 물리를 타게 되므로, 고칠 때는
        # **반드시 두 곳을 함께** 고쳐야 한다(상수 KP=9.0, 극점 폭 0.10/0.25).
        ch, sh = math.cos(bot.hdg), math.sin(bot.hdg)
        cp, sp = math.cos(bot.pit), math.sin(bot.pit)
        eh = (ch, 0.0, -sh)                    # 방위 증가 방향
        ep = (-sp * sh, cp, -sp * ch)          # 기수각 증가 방향
        f = fwd(bot.q)
        z = v_dot(want, f)
        m = v_sub(want, v_mul(f, z))
        ml = v_len(m)
        th = math.atan2(ml, z)                 # 전각도 — 180도에서도 0 이 아니다
        sc = th / ml if ml > 1e-9 else 0.0
        dP = v_dot(m, ep) * sc
        cps = math.copysign(max(abs(cp), 0.20), cp if cp != 0 else 1.0)
        dH = v_dot(m, eh) * sc / cps
        ac = bot.ac
        cx = dP / ac["pitchRate"] * gain * 9.0
        cy = dH / ac["yawRate"] * gain * 9.0
        n = max(1.0, math.hypot(cx, cy))
        # 수직 근처에서는 요가 롤만 만든다 — 권한을 죽이고 피치로 넘긴다.
        # 넘길 방향은 input.js 와 같은 규칙이다: 위아래 오차가 뚜렷하면 그쪽,
        # 거의 순수 좌우 오차면 정점 쪽(sign(sin pit)). sign(dP) 만 쓰면 dP≈0
        # 에서 부호가 매 틱 뒤집혀 제자리 떨림이 된다.
        pa = clamp((abs(cp) - 0.10) / 0.25, 0.0, 1.0)
        if abs(dP) > 0.15:
            over = 1.0 if dP >= 0 else -1.0
        else:
            over = 1.0 if sp >= 0 else -1.0
        bot.c_pitch = clamp(cx / n + (1 - pa) * 0.7 * over, -1.0, 1.0)
        bot.c_yaw = clamp(cy / n * pa, -1.0, 1.0)
        # 봇도 마우스 플레이어와 같은 규칙을 따른다 — 롤은 전술·연출용이다
        bot.c_roll = 0.0

    # ── 직렬화 ──────────────────────────────────────────────────────
    def snapshot(self, viewer, cache, view_r=None):
        view_r = view_r or CFG["viewR"]
        vp = tuple(viewer.pos) if viewer else (0.0, 0.0, 0.0)
        r2 = view_r * view_r

        planes, radar, seen = [], [], set()
        for p in self.planes.values():
            d2 = v_dot(v_sub(tuple(p.pos), vp), v_sub(tuple(p.pos), vp))
            if viewer and p.id != viewer.id and d2 > r2:
                if p.alive:      # 격추된 잔해는 레이더에 잡지 않는다
                    radar.append([p.id, round(p.pos[0]), round(p.pos[1]), round(p.pos[2])])
                continue
            seen.add(p.id)
            flags = (1 if p.alive else 0) | (2 if p.ab else 0) | \
                    (4 if p.invuln > 0 else 0) | (8 if p.stalling else 0)
            ext = (round(max(0.0, p.hp)), flags)
            row = [p.id, round(p.pos[0], 1), round(p.pos[1], 1), round(p.pos[2], 1),
                   round(p.q[0], 4), round(p.q[1], 4), round(p.q[2], 4), round(p.q[3], 4)]
            if cache.get(p.id) != ext:
                cache[p.id] = ext
                row.extend(ext)
            planes.append(row)
        for gone in [k for k in cache if k not in seen]:
            cache.pop(gone, None)

        def near(o):
            d = v_sub(tuple(o.pos), vp)
            return v_dot(d, d) <= r2

        # 기총이 사라져 총알은 더 이상 생기지 않는다. 프로토콜의 'b' 키는
        # 클라이언트가 그대로 읽으므로 빈 배열로 유지한다.
        bullets = []
        missiles = [[m.id, round(m.pos[0], 1), round(m.pos[1], 1), round(m.pos[2], 1),
                     round(m.vel[0]), round(m.vel[1]), round(m.vel[2]), m.owner]
                    for m in self.missiles if near(m)]
        flares = [[round(f.pos[0], 1), round(f.pos[1], 1), round(f.pos[2], 1),
                   round(f.life, 1)] for f in self.flares if near(f)]

        snap = {"t": "s", "k": self.tick, "p": planes, "rd": radar,
                "b": bullets, "m": missiles, "fl": flares}
        if viewer:
            v = viewer
            spd = v_len(tuple(v.vel))
            snap["me"] = {
                "x": v.pos[0], "y": v.pos[1], "z": v.pos[2],
                "q": [v.q[0], v.q[1], v.q[2], v.q[3]],
                # 자세의 원본은 이 세 값이다. 기수각이 90도를 넘으면
                # 자세에서 되뽑을 때 뒤집힌 해가 나오므로 그대로 내려보낸다.
                "hpb": [round(v.hdg, 6), round(v.pit, 6), round(v.bnk, 6)],
                "vx": v.vel[0], "vy": v.vel[1], "vz": v.vel[2],
                "sp": spd, "mach": round(v.mach, 3), "aoa": round(v.aoa, 4),
                "g": round(v.gload, 2), "bo": round(v.blackout, 2),
                "hp": max(0.0, v.hp), "al": 1 if v.alive else 0,
                "rt": max(0.0, v.respawn_t), "iv": round(v.invuln, 2),
                "thr": round(v.throttle, 2), "ab": 1 if v.ab else 0,
                "am": v.ammo, "ms": v.missiles, "fla": v.flares,
                "lk": v.lock_id if v.lock_t >= WEAPONS[MISSILE]["lockTime"] else 0,
                "lkt": round(v.lock_t, 2), "lw": v.locked_by, "rwr": v.rwr,
                "st": 1 if v.stalling else 0, "sc": v.score, "kl": v.kills,
                "de": v.deaths, "ack": v.seq, "w": v.weapon, "kb": v.killer_name,
                "agl": round(v.pos[1] - ground_h(v.pos[0], v.pos[2]), 1),
                "ht": v.hit_marks, "hu": v.hurt_marks,
            }
            v.hit_marks = []
            v.hurt_marks = []
        return snap

    def leaderboard(self, top=8):
        ranked = sorted(self.planes.values(), key=lambda p: -p.score)[:top]
        return [[p.id, p.name, p.score, p.kills, p.color, p.deaths, 1] for p in ranked]


def _look_q(dir_):
    """진행 방향을 바라보는 쿼터니언(미사일 자세용)."""
    f = (0.0, 0.0, 1.0)
    d = v_dot(f, dir_)
    if d > 0.9999:
        return (1.0, 0.0, 0.0, 0.0)
    if d < -0.9999:
        return q_axis_angle((0.0, 1.0, 0.0), math.pi)
    axis = v_cross(f, dir_)
    return q_norm((1.0 + d, axis[0], axis[1], axis[2]))
