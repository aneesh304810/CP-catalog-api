"""FastAPI app configuration and Oracle connection pooling."""
from __future__ import annotations
import os
import oracledb

# Catalog (METACAT) connection settings from environment.
CAT_USER = os.getenv("METACAT_USER", "metacat")
CAT_PASS = os.getenv("METACAT_PASSWORD", "")
CAT_DSN  = os.getenv("METACAT_DSN", "localhost:1521/FREEPDB1")
POOL_MIN = int(os.getenv("METACAT_POOL_MIN", "1"))
POOL_MAX = int(os.getenv("METACAT_POOL_MAX", "4"))

_pool: oracledb.ConnectionPool | None = None


def get_pool() -> oracledb.ConnectionPool:
    global _pool
    if _pool is None:
        _pool = oracledb.create_pool(
            user=CAT_USER, password=CAT_PASS, dsn=CAT_DSN,
            min=POOL_MIN, max=POOL_MAX, increment=1)
    return _pool


def query(sql: str, params: dict | None = None) -> list[dict]:
    """Run a SELECT and return list of dict rows (lower-cased columns)."""
    pool = get_pool()
    with pool.acquire() as conn:
        cur = conn.cursor()
        cur.execute(sql, params or {})
        cols = [c[0].lower() for c in cur.description]
        rows = [dict(zip(cols, _coerce(r))) for r in cur.fetchall()]
        cur.close()
    return rows


def _coerce(row):
    out = []
    for v in row:
        # read LOBs eagerly
        if hasattr(v, "read"):
            out.append(v.read())
        else:
            out.append(v)
    return out
