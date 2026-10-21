"""Deterministic exact allocation (largest remainder, ties by key ascending) so allocated parts always sum to the total."""
from decimal import ROUND_HALF_UP, Decimal


def round_half_away(x, places=0):
    q = Decimal(1).scaleb(-places)
    d = Decimal(str(x)).quantize(q, rounding=ROUND_HALF_UP) if x >= 0 else -(Decimal(str(-x)).quantize(q, rounding=ROUND_HALF_UP))
    return float(d)


def allocate(total, weights, precision=2):
    """total: number; weights: {key: non-negative weight}. Returns {key: amount} summing exactly to round(total, precision).
    Returns None when there is no valid denominator (the award stays PENDING)."""
    weights = {k: float(v) for k, v in weights.items() if v is not None and float(v) > 0}
    s = sum(weights.values())
    if not weights or s <= 0:
        return None
    unit = Decimal(1).scaleb(-precision)
    tot = Decimal(str(round_half_away(total, precision)))
    units_total = int((tot / unit).to_integral_value())
    raw = {k: Decimal(str(total)) * Decimal(str(w)) / Decimal(str(s)) / unit for k, w in weights.items()}
    base = {k: int(v.to_integral_value(rounding="ROUND_FLOOR")) for k, v in raw.items()}
    rem = units_total - sum(base.values())
    order = sorted(raw, key=lambda k: (-(raw[k] - base[k]), str(k)))
    if rem < 0:
        order = sorted(raw, key=lambda k: ((raw[k] - base[k]), str(k)))
    for k in order[:abs(rem)]:
        base[k] += 1 if rem > 0 else -1
    return {k: float(Decimal(base[k]) * unit) for k in weights}
