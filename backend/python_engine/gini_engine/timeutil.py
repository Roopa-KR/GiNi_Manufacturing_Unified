"""Time helpers. Database datetimes are naive UTC (pymongo default tz_aware=False); local display uses zoneinfo."""
import datetime as dt
from zoneinfo import ZoneInfo

UTC = dt.timezone.utc
PLANT_TZ = "America/Bogota"          # synthetic dataset default; a fresh factory sets its own (factory_settings.TIMEZONE)
_TZ = [PLANT_TZ]


def set_plant_tz(tz):
    """the plant timezone used by every local-time conversion that does not name one (set from the factory settings)"""
    if tz:
        ZoneInfo(tz)                # validates the name
        _TZ[0] = tz


def plant_tz():
    return _TZ[0]


def utcnow():
    return dt.datetime.now(UTC).replace(tzinfo=None)


def to_local(d, tz=None):
    if d is None:
        return None
    return d.replace(tzinfo=UTC).astimezone(ZoneInfo(tz or _TZ[0])).replace(tzinfo=None)


def local_to_utc(date_str, hhmm, tz=None):
    y, m, d = (int(x) for x in date_str.split("-"))
    h, mi = (int(x) for x in hhmm.split(":"))
    return dt.datetime(y, m, d, h, mi, tzinfo=ZoneInfo(tz or _TZ[0])).astimezone(UTC).replace(tzinfo=None)


def minutes(a, b):
    return (b - a).total_seconds() / 60.0


def add_min(d, m):
    return d + dt.timedelta(minutes=m)


def sim_now(session, wall=None):
    """same formula as backend/src/lib/time.js simNow - the persisted anchors are the single source of truth."""
    wall = wall or utcnow()
    c = session.get("CLOCK") or {}
    if c.get("REAL_TIME"):
        # Manual Team Test (fresh factory): the operational clock is the real current time; it cannot be paused or sped up
        return wall
    anchor = c.get("ANCHOR_SIM_AT") or session["FORK_AT"]
    if c.get("PAUSED") or not c.get("ANCHOR_WALL_AT"):
        return anchor
    t = anchor + (wall - c["ANCHOR_WALL_AT"]) * float(c.get("SPEED") or 1)
    if session.get("HORIZON_AT") and t > session["HORIZON_AT"]:
        t = session["HORIZON_AT"]
    return max(t, anchor)


# v3 defect normalisation (source-audit D-01/D-02): sim minute 0 = 2026-09-14 00:00 America/Bogota (generator/common.py EPOCH_LOCAL)
SIM_EPOCH_UTC = local_to_utc("2026-09-14", "00:00", "America/Bogota")


def sim_minute_to_utc(m):
    return SIM_EPOCH_UTC + dt.timedelta(seconds=round(m * 60)) if isinstance(m, (int, float)) else m
