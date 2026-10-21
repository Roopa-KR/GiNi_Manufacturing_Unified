"""Environment configuration for the Render background worker (validated at start-up; secrets never logged)."""
import json
import os
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load_dotenv(path: Path):
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        os.environ.setdefault(k.strip(), v)


def _find_dir(name: str) -> Path:
    """contracts/ and config/ live in backend/; the Docker image copies them next to the package."""
    env = os.environ.get("GINI_%s_DIR" % name.upper())
    for cand in ([Path(env)] if env else []) + [HERE.parent / name, HERE.parent.parent / name, Path("/app") / name]:
        if cand.is_dir():
            return cand
    raise FileNotFoundError("cannot locate %s/ directory (set GINI_%s_DIR)" % (name, name.upper()))


@dataclass
class Settings:
    app_env: str = "development"
    mongo_uri: str = ""
    mongo_db: str = "gini_demo_dev"
    api_internal_url: str = "http://localhost:5000"
    internal_token: str = ""
    tick_seconds: float = 5.0
    lease_seconds: int = 60
    max_retries: int = 5
    snapshot_interval_seconds: int = 300
    simulation_seed: int = 42
    plant_timezone: str = "America/Bogota"
    default_mode: str = "interactive"
    safety_buffer_minutes: int = 10
    worker_id: str = ""
    environment: str = "SYNTHETIC_DEMO"      # FRESH_FACTORY (empty team-test factory) or SYNTHETIC_DEMO (imported Final dataset)
    dataset_id: str = "GINI-SYN-TANKS"
    contracts_dir: Path = field(default_factory=lambda: _find_dir("contracts"))
    config_dir: Path = field(default_factory=lambda: _find_dir("config"))

    def json(self, rel: str):
        base = self.contracts_dir if rel.startswith("contracts/") else self.config_dir
        return json.loads((base / rel.split("/", 1)[1]).read_text(encoding="utf-8"))

    def problems(self):
        p = []
        if not self.mongo_uri:
            p.append("MONGODB_URI is not set")
        if not self.internal_token or len(self.internal_token) < 32 or "GENERATE" in self.internal_token or "SAME_SERVER" in self.internal_token:
            p.append("INTERNAL_SERVICE_TOKEN must be a random value of at least 32 characters (same as the API)")
        if not self.api_internal_url:
            p.append("NODE_API_INTERNAL_URL is not set")
        if self.environment not in ("FRESH_FACTORY", "SYNTHETIC_DEMO"):
            p.append("GINI_ENVIRONMENT must be FRESH_FACTORY or SYNTHETIC_DEMO")
        p.extend(api_env_mismatch(self))
        return p

    @property
    def is_fresh(self):
        return self.environment == "FRESH_FACTORY"


def _read_dotenv(path: Path):
    if not path.exists():
        return None
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def api_env_mismatch(st):
    """local runs: the engine and the Node API must use the same database, dataset and environment (values compared, never printed)"""
    if st.app_env == "production":
        return []
    api = _read_dotenv(HERE.parent.parent / ".env")
    if not api:
        return []
    out = []
    if api.get("MONGODB_URI") and api["MONGODB_URI"] != st.mongo_uri:
        out.append("backend/.env has a different MONGODB_URI than the engine - both services must use the same database server")
    if (api.get("MONGODB_DB_NAME") or "gini_demo_dev") != st.mongo_db:
        out.append('backend/.env uses database "%s" but the engine uses "%s" - set the same MONGODB_DB_NAME in both files' % (api.get("MONGODB_DB_NAME") or "gini_demo_dev", st.mongo_db))
    env = (api.get("GINI_ENVIRONMENT") or "SYNTHETIC_DEMO").upper()
    if env != st.environment:
        out.append("backend/.env has GINI_ENVIRONMENT=%s but the engine runs %s" % (env, st.environment))
    ds = api.get("DATASET_ID") or ("GINI-FRESH-FACTORY" if env == "FRESH_FACTORY" else "GINI-SYN-TANKS")
    if ds != st.dataset_id:
        out.append("backend/.env uses DATASET_ID %s but the engine uses %s" % (ds, st.dataset_id))
    return out


def load() -> Settings:
    if os.environ.get("APP_ENV", "development") != "production":
        _load_dotenv(HERE.parent / ".env")
    e = os.environ
    import socket
    return Settings(
        app_env=e.get("APP_ENV", "development"),
        mongo_uri=e.get("MONGODB_URI", ""),
        mongo_db=e.get("MONGODB_DB_NAME", "gini_demo_dev"),
        api_internal_url=e.get("NODE_API_INTERNAL_URL", "http://localhost:5000").rstrip("/"),
        internal_token=e.get("INTERNAL_SERVICE_TOKEN", ""),
        tick_seconds=float(e.get("ENGINE_TICK_SECONDS", "5")),
        lease_seconds=int(e.get("ENGINE_JOB_LEASE_SECONDS", "60")),
        max_retries=int(e.get("ENGINE_MAX_RETRIES", "5")),
        snapshot_interval_seconds=int(e.get("SNAPSHOT_INTERVAL_SECONDS", "300")),
        simulation_seed=int(e.get("SIMULATION_SEED", "42")),
        plant_timezone=e.get("DEFAULT_PLANT_TIMEZONE", "America/Bogota"),
        default_mode=e.get("DEFAULT_SIMULATION_MODE", "interactive"),
        safety_buffer_minutes=int(e.get("SAFETY_BUFFER_MINUTES", "10")),
        worker_id=e.get("ENGINE_WORKER_ID") or "%s-%d" % (socket.gethostname(), os.getpid()),
        environment=(e.get("GINI_ENVIRONMENT") or "SYNTHETIC_DEMO").upper(),
        dataset_id=e.get("DATASET_ID") or ("GINI-FRESH-FACTORY" if (e.get("GINI_ENVIRONMENT") or "").upper() == "FRESH_FACTORY" else "GINI-SYN-TANKS"),
    )
