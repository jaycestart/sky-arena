"""SKY ARENA — 서버 권위(server-authoritative) 게임 월드 시뮬레이션.

물리 상수(CFG)와 기체 클래스(CLASSES)는 접속 시 클라이언트로 그대로 내려보내며,
클라이언트는 동일한 공식으로 자기 비행기를 예측(prediction)한다.
따라서 밸런스를 바꿀 때는 이 파일만 고치면 양쪽이 함께 바뀐다.
"""

import math
import random

# ── 튜닝 값 ───────────────────────────────────────────────────────────
CFG = {
    "arenaR": 2600,          # 원형 전장 반지름
    "tickHz": 40,            # 시뮬레이션 틱
    "snapEvery": 2,          # 몇 틱마다 스냅샷을 보낼지 (=20Hz)
    "planeR": 20,            # 피격 판정 반지름

    "speedMin": 150,
    "speedMax": 430,
    "speedBoost": 640,
    "accel": 420,
    "turnRate": 4.4,         # rad/s (최저속 기준). 높을수록 기민하다
    "turnFalloff": 0.32,     # 최고속에서 선회율이 얼마나 줄어드는가

    "hpMax": 100,
    "hpRegen": 7,
    "hpRegenDelay": 5.0,
    "energyMax": 100,
    "boostCost": 34,
    "energyRegen": 17,

    # 기본 기총 값(조준선 계산 등 클라이언트 참조용 — 실제 수치는 WEAPONS)
    "bulletSpeed": 1050,
    "bulletLife": 1.0,
    "bulletDmg": 11,
    "bulletR": 7,
    "fireCd": 0.10,

    # 열 관리 — 무기를 난사하면 과열되어 잠긴다
    "heatMax": 100.0,
    "heatCool": 40.0,        # 초당 냉각
    "heatDelay": 0.55,       # 마지막 발사 후 이만큼 지나야 식기 시작한다
    "heatReset": 35.0,       # 과열 후 이 아래로 내려가야 다시 발사

    # 유도 미사일
    "msAmmo": 3,             # 최대 보유량
    "msCd": 1.1,             # 발사 간격
    "msRegen": 9.0,          # 몇 초마다 1발 재보급
    "msSpeed": 480,
    "msSpeedMax": 1150,
    "msAccel": 620,
    "msTurn": 2.9,           # rad/s 유도 선회율
    "msDmg": 34,
    "msLife": 4.5,
    "msR": 11,
    "lockRange": 1150,       # 락온 사거리
    "lockCone": 0.62,        # 락온 원뿔 반각(rad)
    "lockTime": 0.45,        # 락온 유지 시간

    # 회피 기동(배럴롤)
    "rollDur": 0.42,
    "rollCd": 3.2,
    "rollPush": 620,         # 옆으로 밀려나는 속도
    "rollCost": 22,          # 에너지 소모

    "shieldMax": 60,
    "spawnInvuln": 2.0,      # 스폰 직후 무적
    "collideDmg": 42,        # 공중 충돌 피해
    "assistWindow": 6.0,     # 어시스트 인정 시간
    "assistScore": 40,

    "levelStep": 400,        # 점수 몇 점마다 레벨업
    "levelMax": 6,
    "levelHp": 8,            # 레벨당 최대 체력 증가
    "levelDmg": 0.03,        # 레벨당 화력 증가율

    "pickupMax": 10,
    "pickupEvery": 2.6,      # 스폰 간격(초)
    "pickupR": 30,

    "respawn": 3.0,
    "borderDmg": 14,
    "borderPull": 260,
}

# 주무기 4종. spread 가 0 이면 탄이 기수 방향으로 완전히 일직선으로 나간다.
# inherit: 발사 시 기체 속도를 얼마나 물려받는가(추격전에서 탄이 따라잡도록)
WEAPONS = [
    {"key": "vulcan", "label": "발칸", "icon": "≡", "desc": "일직선 연사. 기본기.",
     "cd": 0.10, "dmg": 11, "speed": 1050, "count": 1, "spread": 0.0,
     "life": 1.0, "r": 7, "heat": 5.5, "pierce": 0, "splash": 0, "inherit": 0.35},
    {"key": "shotgun", "label": "산탄", "icon": "⁂", "desc": "근접 6발 확산. 한 방이 무겁다.",
     "cd": 0.60, "dmg": 8, "speed": 900, "count": 6, "spread": 0.13,
     "life": 0.60, "r": 7, "heat": 24, "pierce": 0, "splash": 0, "inherit": 0.35},
    {"key": "railgun", "label": "레일건", "icon": "⌁", "desc": "초고속 관통탄. 두 명까지 뚫는다.",
     "cd": 1.10, "dmg": 48, "speed": 2600, "count": 1, "spread": 0.0,
     "life": 0.65, "r": 9, "heat": 46, "pierce": 2, "splash": 0, "inherit": 0.0},
    {"key": "plasma", "label": "플라즈마", "icon": "◉", "desc": "느리지만 착탄 범위 피해.",
     "cd": 0.45, "dmg": 20, "speed": 660, "count": 1, "spread": 0.0,
     "life": 1.7, "r": 15, "heat": 19, "pierce": 0, "splash": 130, "inherit": 0.25},
]
WEAPON_COUNT = len(WEAPONS)

# 기체 클래스 — 곱연산 계수
CLASSES = {
    "interceptor": {"label": "인터셉터", "speed": 1.14, "turn": 1.18, "hp": 0.85,
                    "dmg": 0.90, "desc": "가장 빠르고 가장 잘 돈다. 대신 물렁하다."},
    "striker":     {"label": "스트라이커", "speed": 1.00, "turn": 1.00, "hp": 1.00,
                    "dmg": 1.00, "desc": "균형형. 처음이라면 이걸로."},
    "bomber":      {"label": "봄버", "speed": 0.90, "turn": 0.84, "hp": 1.42,
                    "dmg": 1.20, "desc": "둔하지만 튼튼하고 화력이 세다."},
}
DEFAULT_CLASS = "striker"

PICKUPS = ("hp", "shield", "missile", "energy")

COLORS = ["#38e8ff", "#ff5c8a", "#7cff6b", "#ffd166", "#c08bff", "#ff8f4a",
          "#4affd4", "#ff6b6b", "#8ab4ff", "#f4ff6b"]

BOT_NAMES = ["VIPER", "FALCON", "GHOST", "RAPTOR", "NOVA", "ECHO", "BLAZE",
             "TALON", "ONYX", "HAWK", "ZERO", "STORM", "KITE", "ORCA"]

# 봇 난이도: 조준 흔들림, 선회 상한, 사격 원뿔, 미사일/회피 사용 여부
BOT_TIERS = {
    "easy":   {"tag": "◦", "bias": 0.16, "turn": 0.45, "cone": 0.16, "smart": False,
               "cls": "bomber", "weapon": 0},
    "normal": {"tag": "◈", "bias": 0.07, "turn": 0.70, "cone": 0.11, "smart": False,
               "cls": "striker", "weapon": 0},
    "ace":    {"tag": "★", "bias": 0.028, "turn": 0.92, "cone": 0.075, "smart": True,
               "cls": "interceptor", "weapon": 2},
}
BOT_MIX = ["easy", "normal", "normal", "ace", "easy", "normal"]

MIN_POPULATION = 6  # 봇으로 채울 최소 인원


_NEXT_ID = 1


def new_id() -> int:
    """플레이어 id 는 방을 넘어 전역에서 유일하다(로그·디버깅 혼선 방지)."""
    global _NEXT_ID
    _NEXT_ID += 1
    return _NEXT_ID


def ang_norm(a: float) -> float:
    """각도를 -pi..pi 로 정규화."""
    return (a + math.pi) % (2 * math.pi) - math.pi


def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


class Plane:
    def __init__(self, pid: int, name: str, color: str, cls: str = DEFAULT_CLASS,
                 is_bot: bool = False, tier: str = "normal"):
        self.id = pid
        self.name = name
        self.color = color
        self.is_bot = is_bot
        self.tier = tier
        self.cls = cls if cls in CLASSES else DEFAULT_CLASS
        self.k = CLASSES[self.cls]

        self.score = 0
        self.kills = 0
        self.deaths = 0
        self.streak = 0
        self.best_streak = 0
        self.level = 1

        # 입력 상태
        self.turn = 0.0
        self.throttle = 0.6
        self.want_boost = False
        self.want_fire = False
        self.want_missile = False
        self.want_roll = False
        self.weapon = BOT_TIERS[tier]["weapon"] if is_bot else 0
        self.seq = 0

        # 봇 AI 상태
        self.target_id = 0
        self.retarget_t = 0.0
        self.aim_bias = 0.0

        # 사수에게만 돌려주는 피드백 (스냅샷마다 비운다)
        self.hit_marks: list[list] = []    # 내가 맞힌 지점 [x, y, dmg]
        self.hurt_marks: list[list] = []   # 내가 맞은 지점 [x, y, dmg]
        self.picked: list[str] = []        # 이번 프레임에 먹은 아이템
        self.killer_name = ""

        self.damage_from: dict[int, tuple[float, float]] = {}  # 어시스트 집계
        self.spawn()

    # ── 파생 스탯 ─────────────────────────────────────────────────────
    @property
    def hp_max(self) -> float:
        return CFG["hpMax"] * self.k["hp"] + CFG["levelHp"] * (self.level - 1)

    @property
    def dmg_mul(self) -> float:
        return self.k["dmg"] * (1 + CFG["levelDmg"] * (self.level - 1))

    def spawn(self):
        r = CFG["arenaR"] * random.uniform(0.25, 0.8)
        a = random.uniform(0, math.tau)
        self.x = math.cos(a) * r
        self.y = math.sin(a) * r
        self.angle = ang_norm(a + math.pi + random.uniform(-0.6, 0.6))
        self.speed = CFG["speedMin"] * 1.4
        self.hp = self.hp_max
        self.shield = 0.0
        self.energy = CFG["energyMax"]
        self.alive = True
        self.respawn_t = 0.0
        self.fire_cd = 0.0
        self.last_hit_t = -99.0
        self.boosting = False
        self.last_hit_by = 0
        self.streak = 0
        self.invuln = CFG["spawnInvuln"]

        self.heat = 0.0
        self.overheated = False
        self.last_fire_t = -99.0
        self.missiles = CFG["msAmmo"]
        self.ms_cd = 0.0
        self.ms_regen = CFG["msRegen"]
        self.lock_id = 0
        self.lock_t = 0.0
        self.locked_by = 0

        self.roll_t = 0.0
        self.roll_cd = 0.0
        self.roll_dir = 1.0
        self.damage_from.clear()

    # ── 물리 (클라이언트 예측과 동일한 공식) ──────────────────────────
    def step(self, dt: float, now: float):
        if not self.alive:
            self.respawn_t -= dt
            if self.respawn_t <= 0:
                self.spawn()
            return

        self.invuln = max(0.0, self.invuln - dt)
        self.roll_cd = max(0.0, self.roll_cd - dt)
        self.ms_cd = max(0.0, self.ms_cd - dt)

        # 총열 냉각 — 쏘는 동안에는 식지 않고, 손을 뗀 뒤에야 식는다
        if now - self.last_fire_t > CFG["heatDelay"]:
            self.heat = max(0.0, self.heat - CFG["heatCool"] * dt)
        if self.overheated and self.heat <= CFG["heatReset"]:
            self.overheated = False

        # 미사일 재보급
        if self.missiles < CFG["msAmmo"]:
            self.ms_regen -= dt
            if self.ms_regen <= 0:
                self.missiles += 1
                self.ms_regen = CFG["msRegen"]

        # 회피 기동 발동
        if self.want_roll and self.roll_t <= 0 and self.roll_cd <= 0 and self.energy >= CFG["rollCost"]:
            self.roll_t = CFG["rollDur"]
            self.roll_cd = CFG["rollCd"]
            self.energy -= CFG["rollCost"]
            self.roll_dir = 1.0 if self.turn >= 0 else -1.0

        kspeed = self.k["speed"]
        boosting = self.want_boost and self.energy > 1 and self.roll_t <= 0
        self.boosting = boosting
        if boosting:
            target = CFG["speedBoost"] * kspeed
            self.energy = max(0.0, self.energy - CFG["boostCost"] * dt)
        else:
            target = (CFG["speedMin"] + (CFG["speedMax"] - CFG["speedMin"]) * self.throttle) * kspeed
            self.energy = min(CFG["energyMax"], self.energy + CFG["energyRegen"] * dt)

        d = target - self.speed
        step = CFG["accel"] * dt
        self.speed += clamp(d, -step, step)

        # 빠를수록 선회가 둔해진다
        t = (self.speed - CFG["speedMin"] * kspeed) / (CFG["speedBoost"] - CFG["speedMin"])
        rate = CFG["turnRate"] * self.k["turn"] * (1.0 - CFG["turnFalloff"] * clamp(t, 0.0, 1.0))
        self.angle = ang_norm(self.angle + self.turn * rate * dt)

        self.x += math.cos(self.angle) * self.speed * dt
        self.y += math.sin(self.angle) * self.speed * dt

        # 배럴롤: 기수는 그대로 두고 옆으로 미끄러진다(회피)
        if self.roll_t > 0:
            self.roll_t -= dt
            side = self.angle + math.pi / 2 * self.roll_dir
            self.x += math.cos(side) * CFG["rollPush"] * dt
            self.y += math.sin(side) * CFG["rollPush"] * dt

        # 전장 경계
        r = math.hypot(self.x, self.y)
        if r > CFG["arenaR"]:
            nx, ny = self.x / r, self.y / r
            self.x -= nx * CFG["borderPull"] * dt
            self.y -= ny * CFG["borderPull"] * dt
            if self.invuln <= 0:
                self.hp -= CFG["borderDmg"] * dt
                self.last_hit_t = now
            if self.hp <= 0:
                return

        if now - self.last_hit_t > CFG["hpRegenDelay"]:
            self.hp = min(self.hp_max, self.hp + CFG["hpRegen"] * dt)

        self.fire_cd -= dt

    def take_damage(self, amount: float, attacker_id: int, now: float) -> float:
        """실드를 먼저 깎고 남은 피해를 체력에 적용한다. 실제 들어간 피해를 반환."""
        if self.invuln > 0 or not self.alive:
            return 0.0
        if self.shield > 0:
            absorbed = min(self.shield, amount)
            self.shield -= absorbed
            amount -= absorbed
        self.hp -= amount
        self.last_hit_t = now
        self.last_hit_by = attacker_id
        if attacker_id:
            prev = self.damage_from.get(attacker_id, (0.0, 0.0))[1]
            self.damage_from[attacker_id] = (now, prev + amount)
        return amount

    def refresh_level(self):
        lv = min(CFG["levelMax"], 1 + self.score // CFG["levelStep"])
        if lv != self.level:
            self.level = lv
            self.hp = min(self.hp_max, self.hp + CFG["levelHp"])
            return True
        return False


class Bullet:
    __slots__ = ("x", "y", "vx", "vy", "life", "owner", "angle", "speed", "dmg",
                 "w", "r", "pierce", "splash", "hit_ids")

    def __init__(self, x, y, angle, owner, w: int, owner_speed: float = 0.0):
        spec = WEAPONS[w]
        self.x = x
        self.y = y
        self.angle = angle
        # 방향은 항상 기수 그대로(직선). 속도만 기체 속도를 일부 물려받는다.
        self.speed = spec["speed"] + owner_speed * spec["inherit"]
        self.vx = math.cos(angle) * self.speed
        self.vy = math.sin(angle) * self.speed
        self.life = spec["life"]
        self.owner = owner
        self.dmg = spec["dmg"]
        self.w = w
        self.r = spec["r"]
        self.pierce = spec["pierce"]
        self.splash = spec["splash"]
        self.hit_ids: set[int] = set()


class Missile:
    __slots__ = ("x", "y", "angle", "speed", "life", "owner", "target", "dmg")

    def __init__(self, x, y, angle, owner, target, dmg):
        self.x = x
        self.y = y
        self.angle = angle
        self.speed = CFG["msSpeed"]
        self.life = CFG["msLife"]
        self.owner = owner
        self.target = target
        self.dmg = dmg


class Pickup:
    __slots__ = ("id", "kind", "x", "y")

    def __init__(self, pid, kind, x, y):
        self.id = pid
        self.kind = kind
        self.x = x
        self.y = y


class World:
    def __init__(self, room: str = "main"):
        self.room = room
        self.planes: dict[int, Plane] = {}
        self.bullets: list[Bullet] = []
        self.missiles: list[Missile] = []
        self.pickups: list[Pickup] = []
        self.time = 0.0
        self.tick = 0
        self._pickup_t = 1.0
        self.events: list[dict] = []
        self.joined: list[dict] = []
        self.left: list[int] = []

    # ── 접속/퇴장 ────────────────────────────────────────────────────
    def add_player(self, name: str, cls: str = DEFAULT_CLASS, is_bot: bool = False,
                   tier: str = "normal") -> Plane:
        pid = new_id()
        color = COLORS[pid % len(COLORS)]
        p = Plane(pid, name[:14] or f"PILOT{pid}", color, cls, is_bot, tier)
        self.planes[pid] = p
        self.joined.append(self.roster_entry(p))
        return p

    def remove_player(self, pid: int):
        if self.planes.pop(pid, None):
            self.left.append(pid)

    def roster_entry(self, p: Plane) -> dict:
        return {"id": p.id, "n": p.name, "c": p.color, "bot": 1 if p.is_bot else 0,
                "cl": p.cls, "tg": BOT_TIERS[p.tier]["tag"] if p.is_bot else ""}

    def roster(self) -> list[dict]:
        return [self.roster_entry(p) for p in self.planes.values()]

    # ── 메인 루프 ────────────────────────────────────────────────────
    def step(self, dt: float):
        self.time += dt
        self.tick += 1
        now = self.time

        for p in self.planes.values():
            if p.is_bot:
                self._bot_think(p, dt)
            p.step(dt, now)
            if p.alive and p.hp <= 0:
                self._kill(p, self.planes.get(p.last_hit_by))

        self._update_locks(dt)

        for p in self.planes.values():
            if not p.alive:
                continue
            if p.want_fire and p.fire_cd <= 0 and not p.overheated:
                self._fire(p)
            if p.want_missile and p.ms_cd <= 0 and p.missiles > 0:
                self._launch(p)

        self._step_bullets(dt)
        self._step_missiles(dt)
        self._step_pickups(dt)
        self._plane_collisions(now)
        self._fill_with_bots()

    # ── 무기 ────────────────────────────────────────────────────────
    def _fire(self, p: Plane):
        spec = WEAPONS[p.weapon]
        p.fire_cd = spec["cd"]
        p.last_fire_t = self.time
        p.heat += spec["heat"]
        if p.heat >= CFG["heatMax"]:
            p.heat = CFG["heatMax"]
            p.overheated = True

        nose = CFG["planeR"] + 6
        bx = p.x + math.cos(p.angle) * nose
        by = p.y + math.sin(p.angle) * nose
        n = spec["count"]
        for i in range(n):
            # 확산이 0 인 무기(발칸·레일건·플라즈마)는 기수 방향으로 완전한 직선.
            # 산탄만 좌우로 고르게 펼친다.
            off = 0.0 if spec["spread"] <= 0 else \
                (i / (n - 1) - 0.5) * 2 * spec["spread"] if n > 1 else 0.0
            b = Bullet(bx, by, p.angle + off, p.id, p.weapon, p.speed)
            b.dmg = spec["dmg"] * p.dmg_mul
            self.bullets.append(b)

    def _launch(self, p: Plane):
        p.ms_cd = CFG["msCd"]
        p.missiles -= 1
        target = p.lock_id if p.lock_t >= CFG["lockTime"] else 0
        nose = CFG["planeR"] + 10
        self.missiles.append(Missile(
            p.x + math.cos(p.angle) * nose, p.y + math.sin(p.angle) * nose,
            p.angle, p.id, target, CFG["msDmg"] * p.dmg_mul))
        self.events.append({"e": "ms", "id": p.id})

    def _update_locks(self, dt: float):
        """조준 원뿔 안의 가장 가까운 적을 자동 락온한다."""
        for p in self.planes.values():
            p.locked_by = 0
        for p in self.planes.values():
            if not p.alive:
                p.lock_id, p.lock_t = 0, 0.0
                continue
            best, best_d = 0, CFG["lockRange"] ** 2
            for q in self.planes.values():
                if q.id == p.id or not q.alive or q.invuln > 0:
                    continue
                dx, dy = q.x - p.x, q.y - p.y
                d2 = dx * dx + dy * dy
                if d2 > best_d:
                    continue
                if abs(ang_norm(math.atan2(dy, dx) - p.angle)) > CFG["lockCone"]:
                    continue
                best, best_d = q.id, d2
            if best and best == p.lock_id:
                p.lock_t = min(CFG["lockTime"], p.lock_t + dt)
            else:
                p.lock_id, p.lock_t = best, 0.0
        # 락온 경고
        for p in self.planes.values():
            if p.lock_id and p.lock_t >= CFG["lockTime"]:
                tgt = self.planes.get(p.lock_id)
                if tgt:
                    tgt.locked_by = p.id

    def _step_bullets(self, dt: float):
        alive = []
        for b in self.bullets:
            b.life -= dt
            if b.life <= 0:
                continue
            ax, ay = b.x, b.y
            b.x += b.vx * dt
            b.y += b.vy * dt
            hit = self._sweep_hit(ax, ay, b.x, b.y, CFG["planeR"] + b.r,
                                  b.owner, b.hit_ids)
            if hit is None:
                alive.append(b)
                continue
            p, hx, hy = hit
            self._apply_hit(p, b.owner, b.dmg, hx, hy)
            if b.splash:
                self._splash(hx, hy, b.splash, b.dmg * 0.6, b.owner, p.id)
            if b.pierce > 0:          # 관통탄은 계속 날아간다
                b.pierce -= 1
                b.hit_ids.add(p.id)
                alive.append(b)
        self.bullets = alive

    def _splash(self, x, y, radius, dmg, owner_id, skip_id):
        """착탄 지점 주변에 거리 감쇠 피해."""
        r2 = radius * radius
        for p in list(self.planes.values()):
            if not p.alive or p.id == skip_id or p.id == owner_id:
                continue
            d2 = (p.x - x) ** 2 + (p.y - y) ** 2
            if d2 > r2:
                continue
            falloff = 1.0 - math.sqrt(d2) / radius
            self._apply_hit(p, owner_id, dmg * falloff, p.x, p.y)

    def _step_missiles(self, dt: float):
        hit_r = CFG["planeR"] + CFG["msR"]
        alive = []
        for m in self.missiles:
            m.life -= dt
            if m.life <= 0:
                continue
            tgt = self.planes.get(m.target)
            if tgt and tgt.alive:
                # 리드 유도: 목표의 진행 방향을 조금 앞질러 조준한다
                dist = math.hypot(tgt.x - m.x, tgt.y - m.y)
                lead = min(1.2, dist / max(1.0, m.speed))
                px = tgt.x + math.cos(tgt.angle) * tgt.speed * lead
                py = tgt.y + math.sin(tgt.angle) * tgt.speed * lead
                diff = ang_norm(math.atan2(py - m.y, px - m.x) - m.angle)
                m.angle = ang_norm(m.angle + clamp(diff, -CFG["msTurn"] * dt, CFG["msTurn"] * dt))
            else:
                m.target = 0
            m.speed = min(CFG["msSpeedMax"], m.speed + CFG["msAccel"] * dt)
            ax, ay = m.x, m.y
            m.x += math.cos(m.angle) * m.speed * dt
            m.y += math.sin(m.angle) * m.speed * dt
            hit = self._sweep_hit(ax, ay, m.x, m.y, hit_r, m.owner)
            if hit is None:
                alive.append(m)
                continue
            p, hx, hy = hit
            self._apply_hit(p, m.owner, m.dmg, hx, hy, big=True)
        self.missiles = alive

    def _sweep_hit(self, ax, ay, bx, by, radius, owner, skip: set | None = None):
        """이동 선분과 기체의 충돌. 빠른 발사체가 뚫고 지나가지 않도록."""
        sx, sy = bx - ax, by - ay
        seg2 = sx * sx + sy * sy
        r2 = radius * radius
        for p in self.planes.values():
            if not p.alive or p.id == owner or p.invuln > 0:
                continue
            if skip and p.id in skip:
                continue
            t = 0.0 if seg2 <= 0 else ((p.x - ax) * sx + (p.y - ay) * sy) / seg2
            t = clamp(t, 0.0, 1.0)
            dx = p.x - (ax + sx * t)
            dy = p.y - (ay + sy * t)
            if dx * dx + dy * dy <= r2:
                return p, ax + sx * t, ay + sy * t
        return None

    def _apply_hit(self, victim: Plane, owner_id: int, dmg: float, hx, hy, big=False):
        dealt = victim.take_damage(dmg, owner_id, self.time)
        if dealt <= 0:
            return
        shooter = self.planes.get(owner_id)
        if shooter:
            shooter.score += 5 if big else 2
            shooter.refresh_level()
            if not shooter.is_bot and len(shooter.hit_marks) < 24:
                shooter.hit_marks.append([round(hx, 1), round(hy, 1), round(dealt)])
        if not victim.is_bot and len(victim.hurt_marks) < 24:
            victim.hurt_marks.append([round(hx, 1), round(hy, 1), round(dealt)])
        if victim.hp <= 0:
            self._kill(victim, shooter)

    def _plane_collisions(self, now: float):
        """공중 충돌 — 서로 밀어내고 양쪽 모두 피해."""
        ps = [p for p in self.planes.values() if p.alive and p.invuln <= 0]
        r2 = (CFG["planeR"] * 2) ** 2
        for i in range(len(ps)):
            a = ps[i]
            for j in range(i + 1, len(ps)):
                b = ps[j]
                dx, dy = b.x - a.x, b.y - a.y
                d2 = dx * dx + dy * dy
                if d2 > r2 or d2 == 0:
                    continue
                d = math.sqrt(d2)
                nx, ny = dx / d, dy / d
                push = (CFG["planeR"] * 2 - d) / 2 + 1
                a.x -= nx * push
                a.y -= ny * push
                b.x += nx * push
                b.y += ny * push
                a.take_damage(CFG["collideDmg"], b.id, now)
                b.take_damage(CFG["collideDmg"], a.id, now)
                for p, other in ((a, b), (b, a)):
                    if p.hp <= 0:
                        self._kill(p, other)

    # ── 아이템 ──────────────────────────────────────────────────────
    def _step_pickups(self, dt: float):
        self._pickup_t -= dt
        if self._pickup_t <= 0 and len(self.pickups) < CFG["pickupMax"]:
            self._pickup_t = CFG["pickupEvery"]
            a = random.uniform(0, math.tau)
            r = CFG["arenaR"] * math.sqrt(random.uniform(0.02, 0.82))
            self.pickups.append(Pickup(new_id(), random.choice(PICKUPS),
                                       math.cos(a) * r, math.sin(a) * r))

        grab2 = (CFG["pickupR"] + CFG["planeR"]) ** 2
        rest = []
        for u in self.pickups:
            taken = None
            for p in self.planes.values():
                if not p.alive:
                    continue
                if (p.x - u.x) ** 2 + (p.y - u.y) ** 2 <= grab2:
                    taken = p
                    break
            if taken is None:
                rest.append(u)
                continue
            if u.kind == "hp":
                taken.hp = min(taken.hp_max, taken.hp + 45)
            elif u.kind == "shield":
                taken.shield = CFG["shieldMax"]
            elif u.kind == "missile":
                taken.missiles = min(CFG["msAmmo"], taken.missiles + 2)
            elif u.kind == "energy":
                taken.energy = CFG["energyMax"]
            taken.score += 15
            taken.refresh_level()
            if not taken.is_bot:
                taken.picked.append(u.kind)
        self.pickups = rest

    # ── 처치 ────────────────────────────────────────────────────────
    def _kill(self, victim: Plane, killer: Plane | None):
        if not victim.alive:
            return
        victim.alive = False
        victim.hp = 0
        victim.shield = 0
        victim.deaths += 1
        victim.streak = 0
        victim.respawn_t = CFG["respawn"]
        victim.killer_name = killer.name if killer and killer.id != victim.id else ""

        if killer and killer.id != victim.id:
            killer.kills += 1
            killer.streak += 1
            killer.best_streak = max(killer.best_streak, killer.streak)
            killer.score += 100 + 20 * min(killer.streak, 5)
            killer.hp = min(killer.hp_max, killer.hp + 25)
            killer.refresh_level()
            self.events.append({"e": "kill", "k": killer.name, "v": victim.name,
                                "kc": killer.color, "vc": victim.color, "s": killer.streak})
            # 어시스트
            for aid, (t, amount) in victim.damage_from.items():
                if aid in (killer.id, victim.id):
                    continue
                if self.time - t <= CFG["assistWindow"] and amount >= 15:
                    helper = self.planes.get(aid)
                    if helper:
                        helper.score += CFG["assistScore"]
                        helper.refresh_level()
                        self.events.append({"e": "assist", "k": helper.name,
                                            "v": victim.name, "kc": helper.color,
                                            "vc": victim.color, "s": 0})
        else:
            victim.score = max(0, victim.score - 20)
            self.events.append({"e": "kill", "k": "", "v": victim.name,
                                "kc": "", "vc": victim.color, "s": 0})
        victim.damage_from.clear()

    # ── 봇 ──────────────────────────────────────────────────────────
    def _fill_with_bots(self):
        humans = [p for p in self.planes.values() if not p.is_bot]
        bots = [p for p in self.planes.values() if p.is_bot]
        want = max(0, MIN_POPULATION - len(humans))
        if len(bots) < want:
            used = {p.name for p in self.planes.values()}
            pool = [n for n in BOT_NAMES if n not in used] or BOT_NAMES
            tier = BOT_MIX[len(bots) % len(BOT_MIX)]
            self.add_player(random.choice(pool), BOT_TIERS[tier]["cls"],
                            is_bot=True, tier=tier)
        elif len(bots) > want:
            self.remove_player(bots[-1].id)

    def _bot_think(self, bot: Plane, dt: float):
        if not bot.alive:
            bot.want_fire = bot.want_missile = bot.want_roll = False
            return
        prof = BOT_TIERS[bot.tier]
        bot.want_roll = False
        bot.want_missile = False

        # 경계 이탈 방지가 최우선
        r = math.hypot(bot.x, bot.y)
        if r > CFG["arenaR"] - 300:
            desired = math.atan2(-bot.y, -bot.x)
            bot.turn = clamp(ang_norm(desired - bot.angle) * 2.5, -prof["turn"], prof["turn"])
            bot.throttle = 0.7
            bot.want_boost = False
            bot.want_fire = False
            return

        # 위협 반응: 락온당했거나 방금 맞았으면 회피 기동
        if prof["smart"] and (bot.locked_by or self.time - bot.last_hit_t < 0.4):
            bot.want_roll = True

        bot.retarget_t -= dt
        target = self.planes.get(bot.target_id)
        if target is None or not target.alive or bot.retarget_t <= 0:
            best, best_d = None, 1e18
            for p in self.planes.values():
                if p.id == bot.id or not p.alive:
                    continue
                d = (p.x - bot.x) ** 2 + (p.y - bot.y) ** 2
                if not p.is_bot:
                    d *= 0.45
                if d < best_d:
                    best, best_d = p, d
            bot.target_id = best.id if best else 0
            bot.retarget_t = random.uniform(1.5, 3.5)
            bot.aim_bias = random.uniform(-prof["bias"], prof["bias"])
            target = best

        if target is None:
            bot.turn = 0.25
            bot.throttle = 0.5
            bot.want_fire = False
            return

        dx, dy = target.x - bot.x, target.y - bot.y
        dist = math.hypot(dx, dy) or 1.0
        lead = dist / (CFG["bulletSpeed"] + bot.speed * 0.35)
        px = target.x + math.cos(target.angle) * target.speed * lead
        py = target.y + math.sin(target.angle) * target.speed * lead
        desired = math.atan2(py - bot.y, px - bot.x) + bot.aim_bias
        diff = ang_norm(desired - bot.angle)

        bot.turn = clamp(diff * 2.4, -prof["turn"], prof["turn"])
        bot.throttle = 0.85 if dist > 500 else 0.55
        bot.want_boost = dist > 900 and bot.energy > 45
        bot.want_fire = abs(diff) < prof["cone"] and dist < 900
        if prof["smart"] and bot.missiles > 0 and bot.lock_t >= CFG["lockTime"] and dist > 350:
            bot.want_missile = True

    # ── 직렬화 ──────────────────────────────────────────────────────
    def snapshot(self, viewer: Plane | None, cache: dict, view_r: float = 2100) -> dict:
        """시야 컬링 + 델타 압축.

        기체는 [id, x, y, angle] 4개만 보내고, 체력/상태/레벨/실드가 바뀐
        기체만 6개 이상으로 확장해 보낸다. 클라이언트는 마지막 값을 유지한다.
        """
        cx, cy = (viewer.x, viewer.y) if viewer else (0.0, 0.0)
        r2 = view_r * view_r

        planes = []
        radar = []          # 시야 밖 기체 — 미니맵용 저해상도 좌표
        seen = set()
        for p in self.planes.values():
            if viewer and p.id != viewer.id:
                if not p.alive:
                    continue
                if (p.x - cx) ** 2 + (p.y - cy) ** 2 > r2:
                    radar.append([p.id, round(p.x / 16), round(p.y / 16)])
                    continue
            elif not p.alive:
                continue
            seen.add(p.id)
            flags = (1 if p.alive else 0) | (2 if p.boosting else 0) | \
                    (4 if p.invuln > 0 else 0) | (8 if p.roll_t > 0 else 0) | \
                    (16 if p.shield > 0 else 0)
            ext = (round(max(0.0, p.hp)), flags, p.level, round(p.shield))
            row = [p.id, round(p.x), round(p.y), round(p.angle, 3)]
            if cache.get(p.id) != ext:
                cache[p.id] = ext
                row.extend(ext)
            planes.append(row)
        for gone in [k for k in cache if k not in seen]:
            cache.pop(gone, None)

        bullets = [[round(b.x), round(b.y), round(b.angle, 2), b.owner,
                    round(b.speed), b.w]
                   for b in self.bullets
                   if (b.x - cx) ** 2 + (b.y - cy) ** 2 <= r2]
        missiles = [[round(m.x), round(m.y), round(m.angle, 2), m.owner,
                     round(m.speed), m.target]
                    for m in self.missiles
                    if (m.x - cx) ** 2 + (m.y - cy) ** 2 <= r2]
        pickups = [[u.id, u.kind, round(u.x), round(u.y)] for u in self.pickups]

        snap = {"t": "s", "k": self.tick, "p": planes, "rd": radar, "b": bullets,
                "m": missiles, "u": pickups}
        if viewer:
            snap["me"] = {
                "x": viewer.x, "y": viewer.y, "a": viewer.angle, "sp": viewer.speed,
                "hp": max(0.0, viewer.hp), "hm": viewer.hp_max, "sh": viewer.shield,
                "en": viewer.energy, "al": 1 if viewer.alive else 0,
                "rt": max(0.0, viewer.respawn_t), "sc": viewer.score,
                "kl": viewer.kills, "de": viewer.deaths, "ack": viewer.seq,
                "w": viewer.weapon, "he": round(viewer.heat, 1),
                "ov": 1 if viewer.overheated else 0,
                "ms": viewer.missiles, "mc": round(viewer.ms_cd, 2),
                "rc": round(viewer.roll_cd, 2), "lv": viewer.level,
                "iv": round(viewer.invuln, 2), "st": viewer.streak,
                "lk": viewer.lock_id if viewer.lock_t >= CFG["lockTime"] else 0,
                "lw": viewer.locked_by, "kb": viewer.killer_name,
                "ht": viewer.hit_marks, "hu": viewer.hurt_marks, "pk": viewer.picked,
            }
            viewer.hit_marks = []
            viewer.hurt_marks = []
            viewer.picked = []
        return snap

    def leaderboard(self, top: int = 8) -> list[list]:
        ranked = sorted(self.planes.values(), key=lambda p: -p.score)[:top]
        return [[p.id, p.name, p.score, p.kills, p.color, p.deaths, p.level]
                for p in ranked]
