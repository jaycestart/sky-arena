"""3D 벡터 · 쿼터니언 · 지형 — 서버와 클라이언트가 같은 공식을 쓴다.

좌표계: y 가 고도(위), x/z 가 수평면. 단위는 m, m/s, rad.
기체 축: forward=+Z(기수), up=+Y, right=+X (기체 국소 좌표).
"""

import math

# ── 벡터 ────────────────────────────────────────────────────────────
def v_add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def v_sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def v_mul(a, s):
    return (a[0] * s, a[1] * s, a[2] * s)


def v_dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def v_cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def v_len(a):
    return math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])


def v_norm(a):
    n = v_len(a)
    return (a[0] / n, a[1] / n, a[2] / n) if n > 1e-9 else (0.0, 0.0, 0.0)


# ── 쿼터니언 [w, x, y, z] ───────────────────────────────────────────
def q_mul(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return (aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw)


def q_norm(q):
    n = math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
    return (q[0] / n, q[1] / n, q[2] / n, q[3] / n) if n > 1e-9 else (1.0, 0.0, 0.0, 0.0)


def q_rot(q, v):
    """쿼터니언으로 벡터 회전."""
    w, x, y, z = q
    vx, vy, vz = v
    # t = 2 * (q_vec × v)
    tx = 2 * (y * vz - z * vy)
    ty = 2 * (z * vx - x * vz)
    tz = 2 * (x * vy - y * vx)
    return (vx + w * tx + (y * tz - z * ty),
            vy + w * ty + (z * tx - x * tz),
            vz + w * tz + (x * ty - y * tx))


def q_axis_angle(axis, ang):
    h = ang * 0.5
    s = math.sin(h)
    a = v_norm(axis)
    return (math.cos(h), a[0] * s, a[1] * s, a[2] * s)


def q_integrate(q, omega_body, dt):
    """기체 각속도(국소축)로 자세를 적분한다."""
    wx, wy, wz = omega_body
    dq = q_mul(q, (0.0, wx * dt * 0.5, wy * dt * 0.5, wz * dt * 0.5))
    return q_norm((q[0] + dq[0], q[1] + dq[1], q[2] + dq[2], q[3] + dq[3]))


def q_from_heading(hdg, pitch=0.0):
    """방위각(라디안)과 피치로 초기 자세를 만든다."""
    qy = q_axis_angle((0.0, 1.0, 0.0), hdg)
    qx = q_axis_angle((1.0, 0.0, 0.0), pitch)
    return q_norm(q_mul(qy, qx))


def fwd(q):
    return q_rot(q, (0.0, 0.0, 1.0))


def up(q):
    return q_rot(q, (0.0, 1.0, 0.0))


def right(q):
    return q_rot(q, (1.0, 0.0, 0.0))


# ── 지형 (서버·클라이언트 동일) ─────────────────────────────────────
# 결정적인 사인 합. 해면은 y=0, 산맥은 최대 약 700m.
def terrain_h(x, z):
    return (380.0 * math.sin(x * 0.00042) * math.cos(z * 0.00037)
            + 190.0 * math.sin(x * 0.00119 + 1.7) * math.cos(z * 0.00097 + 0.6)
            + 70.0 * math.sin(x * 0.00301 + 3.1) * math.cos(z * 0.00279 + 2.2)
            + 22.0 * math.sin(x * 0.0071) * math.cos(z * 0.0063))


# 30km 메시 실측 최대 637.7m / 최소 -636.9m. 여유를 둔 값.
TERRAIN_MAX = 700.0


def ground_h(x, z):
    """바다에서는 해수면이 바닥이다 — 아레나의 51%가 y<0 이라
    해저 기준으로 판정하면 -558m 까지 '잠수' 해도 살아남는다.

    판정의 유일한 권위는 이 함수다. 클라이언트 렌더러가 GPU 에서 같은 지형을
    평가하지만 그 값은 순수 시각물이며 어떤 판정에도 쓰이지 않는다."""
    return max(terrain_h(x, z), 0.0)


# ── 대기 모델 ───────────────────────────────────────────────────────
RHO0 = 1.225          # 해면 공기밀도 kg/m^3
SCALE_H = 8500.0      # 척도 고도 m
G = 9.80665


def air_density(alt):
    return RHO0 * math.exp(-max(0.0, alt) / SCALE_H)


def wrap_pi(a):
    """각도를 (-π, π] 로 되돌린다."""
    a = math.fmod(a + math.pi, math.tau)
    if a < 0:
        a += math.tau
    return a - math.pi


def q_hpb(hdg, pitch, bank):
    """방위·기수각·비틀기 세 값으로 자세를 통째로 만든다.

    자세를 각속도로 굴려 쌓지 않고 매 틱 이 세 값에서 다시 만들기 때문에,
    피치와 요를 아무리 섞어도 비틀기는 bank 이외의 값이 될 수 없다.
    기수각에는 제한이 없다 — 그대로 계속 당기면 수직을 넘어 뒤집힌 채
    한 바퀴를 돈다. 세 값이 원본이고 자세는 매번 새로 만드는 것이라
    수직을 지나가도 끊기거나 홱 도는 지점이 없다."""
    q = q_mul(q_axis_angle((0.0, 1.0, 0.0), hdg),
              q_axis_angle((1.0, 0.0, 0.0), -pitch))
    return q_norm(q_mul(q, q_axis_angle((0.0, 0.0, 1.0), -bank)))


def hpb_from_q(q):
    """자세 → (방위, 기수각, 비틀기). 출격 직후 상태를 이어받을 때 쓴다."""
    f, u, r = fwd(q), up(q), right(q)
    hdg = math.atan2(f[0], f[2])
    pitch = math.asin(max(-1.0, min(1.0, f[1])))
    return hdg, pitch, math.atan2(-r[1], u[1])