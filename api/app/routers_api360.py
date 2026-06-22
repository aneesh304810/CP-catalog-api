"""
API 360 read router — adapted to this repo's db.query() helper.

Mounted in api/app/main.py:
    from .routers_api360 import router as api360_router
    app.include_router(api360_router)

All endpoints are read-only. They read the api_* tables populated by the
api360 ingestion connector. If the tables are empty or absent, endpoints return
empty results so the UI falls back to DEMO.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from .db import query  # this repo's helper: query(sql, params) -> list[dict]

router = APIRouter(prefix="/api360", tags=["api360"])


def _safe(sql: str, params: dict | None = None) -> list[dict]:
    """Run a read query; on any error (missing tables, etc.) return []."""
    try:
        return query(sql, params or {})
    except Exception:
        return []


@router.get("/sources")
def sources():
    return _safe("""
        SELECT source_id, name, kind, version, endpoint_count,
               field_count, flow_count,
               TO_CHAR(ingested_at, 'YYYY-MM-DD HH24:MI') AS ingested_at
        FROM api_sources ORDER BY name
    """)


@router.get("/endpoints")
def endpoints(source_id: str | None = Query(None)):
    where = "WHERE source_id = :sid" if source_id else ""
    params = {"sid": source_id} if source_id else {}
    return _safe(f"""
        SELECT endpoint_key, source_id, method, path, operation_id,
               summary, ref_object, owner
        FROM api_endpoints {where} ORDER BY path, method
    """, params)


@router.get("/dependencies")
def dependencies(source_id: str | None = Query(None)):
    where = "WHERE source_id = :sid" if source_id else ""
    params = {"sid": source_id} if source_id else {}
    return _safe(f"""
        SELECT edge_id, source_id, from_endpoint, to_endpoint, kind, via
        FROM api_dependencies {where}
    """, params)


@router.get("/endpoint")
def endpoint_detail(key: str = Query(..., description="endpoint_key")):
    ep = _safe("""SELECT endpoint_key, source_id, method, path, operation_id,
                         summary, ref_object, owner
                  FROM api_endpoints WHERE endpoint_key = :k""", {"k": key})
    if not ep:
        raise HTTPException(404, "endpoint not found")
    fields = _safe("""SELECT name, data_type, is_key, nullable, description, ref_object
                      FROM api_fields WHERE endpoint_key = :k ORDER BY name""", {"k": key})
    deps = _safe("""SELECT from_endpoint, to_endpoint, kind, via
                    FROM api_dependencies
                    WHERE from_endpoint = :k OR to_endpoint = :k""", {"k": key})
    flows = _safe("""SELECT DISTINCT f.name
                     FROM api_flow_steps s JOIN api_flows f ON s.flow_key = f.flow_key
                     WHERE s.endpoint_key = :k""", {"k": key})
    detail = ep[0]
    detail["fields"] = fields
    detail["dependencies"] = deps
    detail["flows"] = [f["name"] for f in flows]
    return detail


@router.get("/flows")
def flows(source_id: str | None = Query(None)):
    where = "WHERE source_id = :sid" if source_id else ""
    params = {"sid": source_id} if source_id else {}
    return _safe(f"""
        SELECT flow_key, source_id, name, description, owner, schedule, step_count
        FROM api_flows {where} ORDER BY name
    """, params)


@router.get("/flow")
def flow_detail(key: str = Query(..., description="flow_key")):
    fl = _safe("""SELECT flow_key, source_id, name, description, owner, schedule, step_count
                  FROM api_flows WHERE flow_key = :k""", {"k": key})
    if not fl:
        raise HTTPException(404, "flow not found")
    steps = _safe("""SELECT step_no, method, path, endpoint_key, note,
                            input_vars, output_vars
                     FROM api_flow_steps WHERE flow_key = :k ORDER BY step_no""", {"k": key})
    edges = _safe("""SELECT from_step, to_step, variable
                     FROM api_flow_edges WHERE flow_key = :k""", {"k": key})
    detail = fl[0]
    detail["steps"] = steps
    detail["edges"] = edges
    return detail


@router.get("/search")
def search(q: str = Query("", min_length=0)):
    like = f"%{q.lower()}%"
    eps = _safe("""SELECT 'endpoint' AS kind, method || ' ' || path AS label,
                          summary AS context, endpoint_key AS ref
                   FROM api_endpoints WHERE LOWER(path) LIKE :q OR LOWER(summary) LIKE :q
                   FETCH FIRST 15 ROWS ONLY""", {"q": like})
    flds = _safe("""SELECT 'field' AS kind, name AS label, description AS context,
                          endpoint_key AS ref
                   FROM api_fields WHERE LOWER(name) LIKE :q OR LOWER(description) LIKE :q
                   FETCH FIRST 15 ROWS ONLY""", {"q": like})
    fls = _safe("""SELECT 'flow' AS kind, name AS label, description AS context,
                          flow_key AS ref
                   FROM api_flows WHERE LOWER(name) LIKE :q OR LOWER(description) LIKE :q
                   FETCH FIRST 10 ROWS ONLY""", {"q": like})
    return {"results": eps + flds + fls}
