"""Protected Express internal endpoint client. Agents never write operational state directly: every plant decision is a command
executed by the API's command bus (same validation and transitions as human commands)."""
import json
import urllib.error
import urllib.request


class ApiError(Exception):
    pass


class ApiClient:
    def __init__(self, base_url, token, timeout=30):
        self.base, self.token, self.timeout = base_url.rstrip("/"), token, timeout

    def _post(self, path, body):
        data = json.dumps(body, default=_enc).encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, method="POST",
                                     headers={"content-type": "application/json", "authorization": "Bearer " + self.token})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            raise ApiError("API %s returned %s: %s" % (path, e.code, e.read().decode("utf-8", "replace")[:500]))
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            raise ApiError("API unreachable at %s: %s" % (self.base, e))

    def commands(self, session_id, commands):
        if not commands:
            return []
        out = []
        for i in range(0, len(commands), 100):
            out += self._post("/api/internal/commands", {"sessionId": session_id, "commands": commands[i:i + 100]}).get("results", [])
        return out

    def dispatch_notifications(self, limit=20):
        return self._post("/api/internal/notifications/dispatch", {"limit": limit})


def _enc(v):
    import datetime as dt
    if isinstance(v, dt.datetime):
        return v.isoformat(timespec="milliseconds") + ("" if v.tzinfo else "Z")
    raise TypeError(repr(v))
