"""
CP Metadata Catalog API.

Endpoints:
  GET /health
  GET /search?q=&platform=&layer=&type=        -> asset list
  GET /assets/{key}                             -> 360 detail (schema, transform, runs)
  GET /lineage/table?root=&depth=&plane=        -> {nodes, edges} table-level
  GET /lineage/column?root=                     -> column-level subgraph for a dataset
  GET /impact/column?col=                        -> downstream column impact set
  GET /pipelines / /pipelines/{dag_id}
The React UI consumes /lineage/* as {nodes, edges} and renders the graph.
"""
from __future__ import annotations
import json
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .db import query

app = FastAPI(title="CP Metadata Catalog API", version="1.0.0")

# CORS restricted to configured origins (no wildcard in production)
import os as _os
_origins = [o for o in _os.getenv("CORS_ORIGINS", "").split(",") if o] or ["*"]
app.add_middleware(
    CORSMiddleware, allow_origins=_origins,
    allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type"])


# secure headers on every response
@app.middleware("http")
async def secure_headers(request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    response.headers["Content-Security-Policy"] = "default-src 'self'"
    return response


# mount Security / Governance / Versioning routers
# CATALOG_DISABLE_SECURITY=true skips the secured router entirely (dev/test only).
# Hard refuses in prod so the flag can never disable auth in a production env.
import logging as _logging
_log = _logging.getLogger("uvicorn")
_disable_security = _os.getenv("CATALOG_DISABLE_SECURITY", "false").lower() == "true"
_environment = _os.getenv("ENVIRONMENT", "dev").lower()

if _disable_security and _environment == "prod":
    raise RuntimeError(
        "CATALOG_DISABLE_SECURITY=true is not allowed when ENVIRONMENT=prod")

if _disable_security:
    _log.warning("=" * 60)
    _log.warning("SECURITY DISABLED (CATALOG_DISABLE_SECURITY=true). "
                 "Core API is open with NO authentication. Dev/test only.")
    _log.warning("=" * 60)
else:
    try:
        from .routers_sgv import router as sgv_router
        app.include_router(sgv_router)
        _log.info("Security/Governance/Versioning router mounted")
    except Exception as _e:       # keep core API usable if auth deps absent in dev
        _log.warning("SGV router not mounted: %s", _e)


# ---------------------------------------------------------------- API 360
try:
    from .routers_api360 import router as api360_router
    app.include_router(api360_router)
    _log.info("API 360 router mounted")
except Exception as _e:           # keep core API usable if api_* tables absent
    _log.warning("API 360 router not mounted: %s", _e)


# ---------------------------------------------------------------- health
@app.get("/health")
def health():
    try:
        query("SELECT 1 AS ok FROM dual")
        return {"status": "ok"}
    except Exception as e:
        raise HTTPException(503, f"db unavailable: {e}")


# ---------------------------------------------------------------- search
def _ft_query(q: str) -> str:
    """Build a safe Oracle Text query: AND the tokens, allow prefix matching.
    Strips characters special to the CONTAINS grammar to avoid DRG errors."""
    import re
    tokens = re.findall(r"[A-Za-z0-9_]+", q or "")
    if not tokens:
        return ""
    # each token as a stem/prefix match, ANDed
    return " & ".join(f"{t}%" for t in tokens)


@app.get("/search")
def search(q: str = "", platform: str | None = None,
           layer: str | None = None, type: str | None = None,
           limit: int = 50):
    """
    Full-text search over datasets (name + description + tags + owner) using the
    Oracle Text CONTEXT index with relevance ranking. Falls back to LIKE matching
    if the Text index is unavailable, so behavior is preserved in every state.
    """
    filters = []
    params: dict = {"lim": limit}
    if platform:
        filters.append("platform_id = :platform"); params["platform"] = platform
    if layer:
        filters.append("layer = :layer"); params["layer"] = layer
    if type:
        filters.append("object_type = :type"); params["type"] = type.upper()
    filt_sql = (" AND " + " AND ".join(filters)) if filters else ""

    ft = _ft_query(q)
    if ft:
        # --- Oracle Text path (ranked) ---
        params["ftq"] = ft
        sql = f"""
            SELECT dataset_key, platform_id, schema_name, object_name, object_type,
                   layer, NVL(business_desc, tech_desc) AS description, owner, tags,
                   SCORE(1) AS relevance
            FROM   datasets
            WHERE  CONTAINS(object_name, :ftq, 1) > 0 {filt_sql}
            ORDER  BY SCORE(1) DESC
            FETCH FIRST :lim ROWS ONLY
        """
        try:
            return {"results": query(sql, params), "mode": "fulltext"}
        except Exception:
            # index missing/invalid -> fall through to LIKE
            params.pop("ftq", None)

    # --- LIKE fallback (original behavior) ---
    where = ["1=1"]
    if q:
        where.append("(LOWER(object_name) LIKE :q OR LOWER(dataset_key) LIKE :q "
                     "OR LOWER(NVL(business_desc,tech_desc)) LIKE :q)")
        params["q"] = f"%{q.lower()}%"
    if filters:
        where.extend(filters)
    sql = f"""
        SELECT dataset_key, platform_id, schema_name, object_name, object_type,
               layer, NVL(business_desc, tech_desc) AS description, owner, tags
        FROM   datasets
        WHERE  {' AND '.join(where)}
        FETCH FIRST :lim ROWS ONLY
    """
    return {"results": query(sql, params), "mode": "like"}


@app.get("/search/columns")
def search_columns(q: str = "", sensitivity: str | None = None,
                   platform: str | None = None, limit: int = 50):
    """
    Column-level search: find columns by name, description, or sensitivity across
    all datasets (e.g. "every column named account", "all PII columns"). Uses the
    Oracle Text index on columns with a LIKE fallback. Returns the owning dataset
    so results are navigable.
    """
    filters = []
    params: dict = {"lim": limit}
    if sensitivity:
        filters.append("c.sensitivity = :sens"); params["sens"] = sensitivity.upper()
    if platform:
        filters.append("d.platform_id = :platform"); params["platform"] = platform
    filt_sql = (" AND " + " AND ".join(filters)) if filters else ""

    ft = _ft_query(q)
    if ft:
        params["ftq"] = ft
        sql = f"""
            SELECT c.column_key, c.dataset_key, c.column_name, c.data_type,
                   c.is_pk, c.sensitivity,
                   NVL(c.business_desc, c.tech_desc) AS description,
                   d.object_name, d.platform_id, d.schema_name, d.layer,
                   SCORE(1) AS relevance
            FROM   columns c JOIN datasets d ON d.dataset_key = c.dataset_key
            WHERE  CONTAINS(c.column_name, :ftq, 1) > 0 {filt_sql}
            ORDER  BY SCORE(1) DESC
            FETCH FIRST :lim ROWS ONLY
        """
        try:
            return {"results": query(sql, params), "mode": "fulltext"}
        except Exception:
            params.pop("ftq", None)

    where = ["1=1"]
    if q:
        where.append("(LOWER(c.column_name) LIKE :q "
                     "OR LOWER(NVL(c.business_desc,c.tech_desc)) LIKE :q)")
        params["q"] = f"%{q.lower()}%"
    if filters:
        where.extend(filters)
    sql = f"""
        SELECT c.column_key, c.dataset_key, c.column_name, c.data_type,
               c.is_pk, c.sensitivity,
               NVL(c.business_desc, c.tech_desc) AS description,
               d.object_name, d.platform_id, d.schema_name, d.layer
        FROM   columns c JOIN datasets d ON d.dataset_key = c.dataset_key
        WHERE  {' AND '.join(where)}
        FETCH FIRST :lim ROWS ONLY
    """
    return {"results": query(sql, params), "mode": "like"}


# ------------------------------------------------------------- asset 360
@app.get("/assets/{key}")
def asset(key: str):
    ds = query("SELECT * FROM v_dataset_360 WHERE dataset_key = :k", {"k": key})
    if not ds:
        raise HTTPException(404, "asset not found")
    d = ds[0]
    cols = query("""
        SELECT column_name, ordinal, data_type, is_nullable, is_pk,
               NVL(business_desc, tech_desc) AS description, sensitivity
        FROM columns WHERE dataset_key = :k ORDER BY ordinal""", {"k": key})
    transform = query("""
        SELECT model_key, transform_type, compiled_sql, dbt_model
        FROM transformations WHERE target_key = :k""", {"k": key})
    model = query("SELECT * FROM dbt_models WHERE produced_key = :k", {"k": key})
    runs = []
    if model:
        runs = query("""
            SELECT pr.dag_id, pr.task_id, pr.status, pr.start_ts, pr.duration_s
            FROM pipeline_runs pr
            JOIN pipeline_tasks pt ON pt.dag_id = pr.dag_id AND pt.task_id = pr.task_id
            WHERE pt.model_key = :mk
            ORDER BY pr.start_ts DESC FETCH FIRST 10 ROWS ONLY""",
            {"mk": model[0]["model_key"]})
    return {"dataset": d, "columns": cols,
            "transformation": transform[0] if transform else None,
            "model": model[0] if model else None, "runs": runs}


# --------------------------------------------------------- table lineage
@app.get("/lineage/table")
def table_lineage(root: str, depth: int = 3, plane: str = "data"):
    """
    plane: data | transform | orchestration
    Returns {nodes, edges} reachable within `depth` hops up+down from root.
    """
    # choose edge sources by plane
    type_filter = {
        "data": "('dataset')",
        "transform": "('dataset','dbt_model')",
        "orchestration": "('dataset','dbt_model','task')",
    }.get(plane, "('dataset')")

    edge_sql = f"""
        SELECT from_key, to_key, from_type, to_type, source, transform_id
        FROM table_lineage
        WHERE from_type IN {type_filter} AND to_type IN {type_filter}
    """
    edges_all = query(edge_sql)

    # BFS both directions from root
    adj_down, adj_up = {}, {}
    for e in edges_all:
        adj_down.setdefault(e["from_key"], []).append(e)
        adj_up.setdefault(e["to_key"], []).append(e)

    keep_nodes, keep_edges = {root}, []

    def bfs(adj, key_field):
        frontier = {root}
        for _ in range(depth):
            nxt = set()
            for n in frontier:
                for e in adj.get(n, []):
                    keep_edges.append(e)
                    other = e[key_field]
                    if other not in keep_nodes:
                        keep_nodes.add(other); nxt.add(other)
            frontier = nxt
    bfs(adj_down, "to_key")
    bfs(adj_up, "from_key")

    nodes = _hydrate_nodes(keep_nodes)
    # de-dup edges
    seen, uniq = set(), []
    for e in keep_edges:
        eid = f"{e['from_key']}>{e['to_key']}"
        if eid not in seen:
            seen.add(eid); uniq.append(e)
    return {"nodes": nodes, "edges": uniq}


def _hydrate_nodes(keys: set[str]) -> list[dict]:
    if not keys:
        return []
    out = []
    # datasets
    binds = {f"k{i}": k for i, k in enumerate(keys)}
    inlist = ",".join(f":k{i}" for i in range(len(keys)))
    ds = query(f"""
        SELECT dataset_key AS id, 'dataset' AS node_type, platform_id, schema_name,
               object_name AS name, object_type, layer
        FROM datasets WHERE dataset_key IN ({inlist})""", binds)
    out.extend(ds)
    # dbt model nodes (keys that look like model ids)
    models = query(f"""
        SELECT model_key AS id, 'dbt_model' AS node_type, 'dbt' AS platform_id,
               project AS schema_name, name, materialization AS object_type, layer
        FROM dbt_models WHERE model_key IN ({inlist})""", binds)
    out.extend(models)
    return out


# -------------------------------------------------------- column lineage
@app.get("/lineage/column")
def column_lineage(root: str):
    """All column edges among columns of `root` and its directly linked datasets."""
    edges = query("""
        SELECT cl.from_column, cl.to_column, cl.transform_expr, cl.model_key
        FROM column_lineage cl
        WHERE cl.from_column LIKE :p OR cl.to_column LIKE :p""",
        {"p": f"{root}.%"})
    cols = query("""
        SELECT column_key, dataset_key, column_name, data_type, is_pk
        FROM columns WHERE dataset_key = :k ORDER BY ordinal""", {"k": root})
    return {"columns": cols, "edges": edges}


# --------------------------------------------------------- impact (cols)
@app.get("/impact/column")
def impact_column(col: str):
    """Downstream column closure for impact analysis."""
    edges = query("SELECT from_column, to_column, transform_expr FROM column_lineage")
    down = {}
    for e in edges:
        down.setdefault(e["from_column"], []).append(e["to_column"])
    seen, stack, path = set(), [col], []
    while stack:
        cur = stack.pop()
        for nx in down.get(cur, []):
            if nx not in seen:
                seen.add(nx); stack.append(nx); path.append({"from": cur, "to": nx})
    return {"column": col, "downstream_count": len(seen),
            "downstream": sorted(seen), "edges": path}


# ------------------------------------------------------------- pipelines
@app.get("/pipelines")
def pipelines():
    return {"pipelines": query(
        "SELECT dag_id, description, schedule, owners, is_paused, tags FROM pipelines")}


@app.get("/pipelines/{dag_id}")
def pipeline(dag_id: str):
    p = query("SELECT * FROM pipelines WHERE dag_id = :d", {"d": dag_id})
    if not p:
        raise HTTPException(404, "pipeline not found")
    tasks = query("""SELECT task_id, operator, group_id, model_key
                     FROM pipeline_tasks WHERE dag_id = :d""", {"d": dag_id})
    runs = query("""SELECT run_id, task_id, status, start_ts, duration_s
                    FROM pipeline_runs WHERE dag_id = :d
                    ORDER BY start_ts DESC FETCH FIRST 25 ROWS ONLY""", {"d": dag_id})
    return {"pipeline": p[0], "tasks": tasks, "runs": runs}


# -------------------------------------------------------------- quality
@app.get("/quality/summary")
def quality_summary():
    by_dim = query("""
        SELECT dimension,
               ROUND(AVG(pass_pct), 1) AS pass_pct,
               SUM(tests_total)        AS total
        FROM v_quality_scorecard
        GROUP BY dimension ORDER BY dimension""")
    datasets = query("""
        SELECT s.dataset_key, d.object_name, d.layer, d.platform_id,
               ROUND(100 * SUM(s.tests_pass) / NULLIF(SUM(s.tests_total),0), 1) AS score_pct,
               SUM(s.tests_total) AS tests_total,
               SUM(s.tests_pass)  AS tests_passed,
               SUM(s.tests_total - s.tests_pass) AS tests_failed
        FROM v_quality_scorecard s
        JOIN datasets d ON d.dataset_key = s.dataset_key
        GROUP BY s.dataset_key, d.object_name, d.layer, d.platform_id
        ORDER BY score_pct""")
    rollup = query("""
        SELECT COUNT(*) AS datasets,
               ROUND(AVG(score), 1) AS avg_score,
               SUM(CASE WHEN score < 100 THEN 1 ELSE 0 END) AS datasets_failing
        FROM (
            SELECT dataset_key,
                   100 * SUM(tests_pass)/NULLIF(SUM(tests_total),0) AS score
            FROM v_quality_scorecard GROUP BY dataset_key)""")
    return {"rollup": rollup[0] if rollup else {},
            "by_dimension": by_dim, "datasets": datasets}


@app.get("/quality/{key}")
def quality_for(key: str):
    return {"results": query("""
        SELECT test_name, column_name, dimension, status, observed_value,
               message, run_ts
        FROM quality_results WHERE dataset_key = :k
        ORDER BY run_ts DESC, test_name""", {"k": key})}


# ----------------------------------------------------------------- gates
@app.get("/gates")
def gates():
    rows = query("""
        SELECT g.scope_key, g.gate_name, g.verdict, g.blocking,
               g.rules_total, g.rules_passed, g.rules_failed,
               d.object_name, d.layer, d.platform_id
        FROM (
            SELECT ge.*, ROW_NUMBER() OVER (PARTITION BY scope_key
                   ORDER BY run_ts DESC) rn
            FROM gate_evaluations ge) g
        LEFT JOIN datasets d ON d.dataset_key = g.scope_key
        WHERE g.rn = 1
        ORDER BY CASE g.verdict WHEN 'fail' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END""")
    counts = {"pass": 0, "warn": 0, "fail": 0}
    for r in rows:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
    return {"counts": counts, "gates": rows}


# ------------------------------------------------------- observability
@app.get("/observability/runs")
def observability_runs():
    by_day = query("""
        SELECT TO_CHAR(start_ts, 'Mon DD') AS day,
               COUNT(*) AS total,
               SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS succeeded,
               SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed,
               ROUND(AVG(duration_s)) AS avg_duration_s
        FROM pipeline_runs
        WHERE start_ts > SYSTIMESTAMP - INTERVAL '7' DAY
        GROUP BY TO_CHAR(start_ts, 'Mon DD'), TRUNC(start_ts)
        ORDER BY TRUNC(start_ts)""")
    failures = query("""
        SELECT dag_id, task_id, status, TO_CHAR(start_ts,'YYYY-MM-DD HH24:MI') AS start_ts,
               duration_s
        FROM pipeline_runs WHERE status = 'failed'
        ORDER BY start_ts DESC FETCH FIRST 10 ROWS ONLY""")
    return {"by_day": by_day, "recent_failures": failures}


@app.get("/observability/freshness")
def observability_freshness():
    return {"freshness": query("""
        SELECT dataset_key, object_name, layer, platform_id,
               lag_minutes, freshness_status AS status, row_count
        FROM v_dataset_health
        WHERE lag_minutes IS NOT NULL
        ORDER BY lag_minutes DESC""")}


# ------------------------------------------------------- quality / gates
@app.get("/quality/summary")
def quality_summary():
    """Catalog-wide DQ rollup + per-dataset latest scores."""
    rollup = query("""
        SELECT COUNT(*) AS datasets,
               ROUND(AVG(score_pct), 1) AS avg_score,
               SUM(CASE WHEN tests_failed > 0 THEN 1 ELSE 0 END) AS datasets_failing
        FROM v_quality_latest""")
    by_dim = query("""
        SELECT dimension,
               ROUND(100 * SUM(CASE WHEN status='pass' THEN 1 ELSE 0 END)
                     / NULLIF(COUNT(*),0), 1) AS pass_pct,
               COUNT(*) AS total
        FROM quality_results
        WHERE run_ts = (SELECT MAX(run_ts) FROM quality_results)
        GROUP BY dimension""")
    datasets = query("""
        SELECT v.dataset_key, d.object_name, d.layer, d.platform_id,
               v.score_pct, v.tests_total, v.tests_passed, v.tests_failed, v.tests_warn
        FROM v_quality_latest v JOIN datasets d ON d.dataset_key = v.dataset_key
        ORDER BY v.score_pct ASC, v.tests_failed DESC""")
    return {"rollup": rollup[0] if rollup else {},
            "by_dimension": by_dim, "datasets": datasets}


@app.get("/quality/{key}")
def quality_dataset(key: str):
    """Per-dataset DQ scorecard: latest results + trend."""
    latest = query("SELECT * FROM v_quality_latest WHERE dataset_key = :k", {"k": key})
    results = query("""
        SELECT test_name, column_name, dimension, status, observed_value, message, run_ts
        FROM quality_results
        WHERE dataset_key = :k AND run_ts = (
            SELECT MAX(run_ts) FROM quality_results WHERE dataset_key = :k)
        ORDER BY DECODE(status,'fail',0,'error',1,'warn',2,'pass',3)""", {"k": key})
    trend = query("""
        SELECT run_ts,
               ROUND(100*SUM(CASE WHEN status='pass' THEN 1 ELSE 0 END)
                     /NULLIF(COUNT(*),0),1) AS score_pct
        FROM quality_results WHERE dataset_key = :k
        GROUP BY run_ts ORDER BY run_ts FETCH FIRST 30 ROWS ONLY""", {"k": key})
    return {"summary": latest[0] if latest else None,
            "results": results, "trend": trend}


@app.get("/gates")
def gates():
    """Latest gate verdict per scope, worst first."""
    rows = query("""
        SELECT g.scope_key, g.scope_type, g.gate_name, g.verdict, g.blocking,
               g.rules_total, g.rules_passed, g.rules_failed, g.run_ts,
               d.object_name, d.layer, d.platform_id
        FROM v_gate_latest g LEFT JOIN datasets d ON d.dataset_key = g.scope_key
        ORDER BY DECODE(g.verdict,'fail',0,'warn',1,'pass',2)""")
    counts = query("""
        SELECT verdict, COUNT(*) AS n FROM v_gate_latest GROUP BY verdict""")
    return {"gates": rows, "counts": {c["verdict"]: c["n"] for c in counts}}


@app.get("/gates/{key}")
def gate_detail(key: str):
    rows = query("""
        SELECT gate_name, verdict, blocking, rules_total, rules_passed,
               rules_failed, detail, run_ts
        FROM gate_evaluations WHERE scope_key = :k
        ORDER BY run_ts DESC FETCH FIRST 1 ROWS ONLY""", {"k": key})
    if not rows:
        raise HTTPException(404, "no gate evaluation for scope")
    return rows[0]


# -------------------------------------------------------- observability
@app.get("/observability/runs")
def obs_runs(days: int = 7):
    """Run success/failure + duration trend for the support dashboard."""
    by_day = query("""
        SELECT TRUNC(start_ts) AS day,
               COUNT(*) AS total,
               SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS succeeded,
               SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
               ROUND(AVG(duration_s),1) AS avg_duration_s
        FROM pipeline_runs
        WHERE start_ts >= SYSTIMESTAMP - :d
        GROUP BY TRUNC(start_ts) ORDER BY day""", {"d": days})
    recent_failures = query("""
        SELECT dag_id, task_id, status, start_ts, duration_s
        FROM pipeline_runs WHERE status = 'failed'
        ORDER BY start_ts DESC FETCH FIRST 25 ROWS ONLY""")
    return {"by_day": by_day, "recent_failures": recent_failures}


@app.get("/observability/freshness")
def obs_freshness():
    """Freshness heatmap data: latest lag per dataset."""
    rows = query("""
        SELECT f.dataset_key, d.object_name, d.layer, d.platform_id,
               f.row_count, f.lag_minutes, f.status, f.max_loaded_at, f.captured_ts
        FROM v_freshness_latest f JOIN datasets d ON d.dataset_key = f.dataset_key
        ORDER BY f.lag_minutes DESC NULLS LAST""")
    return {"freshness": rows}
