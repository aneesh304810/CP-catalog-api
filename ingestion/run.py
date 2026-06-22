"""
Ingestion orchestrator.

Runs the full harvest and upserts into METACAT. Designed to be called either
from the CLI (python -m ingestion.run) or from the Airflow DAG task.

Config via environment (see deploy/ for the OpenShift Secret/ConfigMap):
  METACAT_*           catalog Oracle (write target)
  ORA_<id>_DSN/USER/PASSWORD   source Oracle instances
  MSSQL_<id>_*        source SQL Server instances
  DBT_MANIFEST_PATH, DBT_CATALOG_PATH, DBT_TARGET_PLATFORM, DBT_PROJECT
  AIRFLOW_DB_DSN      Airflow metadata Postgres (read-only)
  OVERLAY_PATH        Excel/Word business metadata template
"""
from __future__ import annotations
import os
import oracledb

from .loader import CatalogLoader
from .oracle_conn import OracleConnector
from .mssql_conn import SqlServerConnector
from .dbt_conn import DbtConnector
from .lineage_sqlglot import ColumnLineageExtractor
from .airflow_conn import AirflowMetaConnector
from .overlay_conn import OverlayConnector
from .model import dataset_key


def _cat_conn():
    return oracledb.connect(
        user=os.environ["METACAT_USER"],
        password=os.environ["METACAT_PASSWORD"],
        dsn=os.environ["METACAT_DSN"])


def run(steps: set[str] | None = None):
    """steps subset of {oracle,mssql,dbt,airflow,overlay}; None = all."""
    steps = steps or {"oracle", "mssql", "dbt", "quality", "airflow", "overlay", "versioning", "search", "api360"}
    cat = _cat_conn()
    loader = CatalogLoader(cat)
    log = print

    dbt_models = []      # shared between dbt + airflow steps

    # ---- register platforms -------------------------------------------
    for pid in _list_sources("ORA"):
        loader.upsert_platform(pid, "oracle", "oracle")
    for pid in _list_sources("MSSQL"):
        loader.upsert_platform(pid, "mssql", "tsql")
    loader.commit()

    # ---- Oracle sources ------------------------------------------------
    if "oracle" in steps:
        for pid in _list_sources("ORA"):
            log(f"[oracle] harvesting {pid}")
            conn = oracledb.connect(
                user=os.environ[f"ORA_{pid}_USER"],
                password=os.environ[f"ORA_{pid}_PASSWORD"],
                dsn=os.environ[f"ORA_{pid}_DSN"])
            schemas = _csv(os.getenv(f"ORA_{pid}_SCHEMAS"))
            ds = OracleConnector(pid, conn, schemas).extract_datasets()
            loader.upsert_datasets(ds)
            conn.close()
        loader.commit()

    # ---- SQL Server sources -------------------------------------------
    if "mssql" in steps:
        import pyodbc
        for pid in _list_sources("MSSQL"):
            log(f"[mssql] harvesting {pid}")
            conn = pyodbc.connect(os.environ[f"MSSQL_{pid}_CONNSTR"])
            schemas = _csv(os.getenv(f"MSSQL_{pid}_SCHEMAS"))
            ds = SqlServerConnector(pid, conn, schemas).extract_datasets()
            loader.upsert_datasets(ds)
            conn.close()
        loader.commit()

    # ---- dbt: models, table lineage, transforms, column lineage -------
    if "dbt" in steps and os.getenv("DBT_MANIFEST_PATH"):
        log("[dbt] parsing manifest")
        target_pid = os.environ["DBT_TARGET_PLATFORM"]
        dbt = DbtConnector(
            target_pid, os.environ["DBT_MANIFEST_PATH"],
            os.getenv("DBT_CATALOG_PATH")).load()
        dbt_models = dbt.extract_models()
        loader.upsert_datasets(dbt.produced_datasets(dbt_models))
        loader.upsert_models(dbt_models)
        loader.upsert_transformations(dbt.extract_transformations(dbt_models))
        for e in dbt.extract_table_lineage(dbt_models):
            e.to_type = "dataset"; e.from_type = "dataset"
        loader.upsert_table_edges(dbt.extract_table_lineage(dbt_models))
        loader.commit()

        # column lineage via sqlglot
        log("[dbt] sqlglot column lineage")
        dialect = os.getenv("DBT_DIALECT", "oracle")
        extractor = ColumnLineageExtractor(dialect=dialect)
        for m in dbt_models:
            if not (m.compiled_sql and m.produced_key):
                continue
            out_cols = [c.name for c in m.columns]
            resolver = _make_resolver(target_pid)
            edges = extractor.extract_for_model(
                m.produced_key, m.compiled_sql, out_cols, resolver)
            loader.upsert_column_edges(edges, model_key=m.model_key)
        loader.commit()

    # ---- Airflow metadata ---------------------------------------------
    if "airflow" in steps and os.getenv("AIRFLOW_DB_DSN"):
        log("[airflow] harvesting metadata DB")
        import psycopg
        known = {m.name for m in dbt_models}
        with psycopg.connect(os.environ["AIRFLOW_DB_DSN"]) as pg:
            af = AirflowMetaConnector(
                pg, dbt_project=os.getenv("DBT_PROJECT"), known_model_names=known)
            loader.upsert_pipelines(af.extract_pipelines()); loader.commit()
            loader.upsert_tasks(af.extract_tasks()); loader.commit()
            loader.upsert_runs(af.extract_runs()); loader.commit()
            # task -> model orchestration edges
            for t in af.extract_tasks():
                if t.model_key:
                    from .model import TableEdge
                    e = TableEdge(from_key=f"{t.dag_id}.{t.task_id}",
                                  to_key=t.model_key, source="airflow")
                    e.from_type = "task"; e.to_type = "dbt_model"
                    loader.upsert_table_edges([e])
            loader.commit()

    # ---- quality / gate / freshness (from dbt run_results) ------------
    if "quality" in steps and os.getenv("DBT_RUN_RESULTS_PATH"):
        log("[quality] parsing run_results")
        from .quality_conn import QualityConnector
        target_pid = os.environ["DBT_TARGET_PLATFORM"]
        qc = QualityConnector(
            target_pid, os.environ["DBT_RUN_RESULTS_PATH"],
            os.environ["DBT_MANIFEST_PATH"],
            os.getenv("DBT_SOURCES_PATH")).load()
        quality = qc.extract_quality()
        loader.upsert_quality(quality)
        loader.upsert_gates(qc.extract_gates(quality))
        loader.upsert_freshness(qc.extract_freshness())
        loader.commit()

    # ---- quality / gates / freshness (dbt run_results + sources) ------
    if "quality" in steps and os.getenv("DBT_RUN_RESULTS_PATH"):
        log("[quality] parsing dbt run_results + evaluating gates")
        from .quality_conn import QualityConnector
        target_pid = os.environ["DBT_TARGET_PLATFORM"]
        qc = QualityConnector(
            target_pid,
            os.environ["DBT_RUN_RESULTS_PATH"],
            os.environ["DBT_MANIFEST_PATH"],
            os.getenv("DBT_SOURCES_PATH")).load()
        quality = qc.extract_quality()
        loader.upsert_quality(quality)
        loader.upsert_gates(qc.extract_gates(quality))
        loader.upsert_freshness(qc.extract_freshness())
        loader.commit()

    # ---- business overlay (last) --------------------------------------
    if "overlay" in steps and os.getenv("OVERLAY_PATH"):
        log("[overlay] applying business metadata")
        ds_ov, col_ov = OverlayConnector(os.environ["OVERLAY_PATH"]).extract()
        loader.apply_dataset_overlay(ds_ov)
        loader.apply_column_overlay(col_ov)
        loader.commit()

    # ---- dataset versioning (immutable, from dbt artifacts) -----------
    if "versioning" in steps and dbt_models:
        log("[versioning] creating immutable dataset versions")
        from .versioner import Versioner
        versioner = Versioner()
        # build new snapshots per produced dataset and version if changed
        # upstream/downstream from the table_lineage we just wrote
        for m in dbt_models:
            if not m.produced_key:
                continue
            schema_snap = {
                "columns": [{"name": c.name, "data_type": c.data_type,
                             "is_pk": c.is_pk} for c in m.columns],
                "tests": m.tests}
            up = [r["from_key"] for r in _q(cat,
                  "SELECT from_key FROM table_lineage WHERE to_key=:k", {"k": m.produced_key})]
            dn = [r["to_key"] for r in _q(cat,
                  "SELECT to_key FROM table_lineage WHERE from_key=:k", {"k": m.produced_key})]
            gov = _q(cat, """SELECT classification, certification, lifecycle_state,
                             technical_owner, business_steward, domain
                             FROM dataset_governance WHERE dataset_key=:k""",
                     {"k": m.produced_key})
            policy = gov[0] if gov else {}
            try:
                versioner.create_version(
                    cat, m.produced_key, schema_snap,
                    {"upstream": up, "downstream": dn}, policy,
                    created_by="ingestion", source_run_id=os.getenv("DBT_INVOCATION_ID"))
            except Exception as e:
                log(f"[versioning] skip {m.produced_key}: {e}")
        cat.commit()

    # ---- refresh full-text search indexes -----------------------------
    if "search" in steps:
        log("[search] syncing Oracle Text indexes")
        _sync_text_indexes(cat, log)
        cat.commit()

    # ---- API 360 (SEI Swagger + Postman from webfs) -------------------
    if "api360" in steps:
        try:
            from .api360_conn import Api360Connector
            from .api360_loader import load_api360
            log("[api360] parsing swagger + postman from webfs")
            bundle = Api360Connector.from_env().extract()
            counts = load_api360(loader, bundle)
            log(f"[api360] loaded: {counts}")
        except Exception as e:
            log(f"[api360] skipped: {e}")

    cat.close()
    log("[done] ingestion complete")


def _sync_text_indexes(conn, log=print):
    """Sync Oracle Text indexes so new/changed rows are searchable. Safe no-op
    if the indexes don't exist yet (search falls back to LIKE until created)."""
    cur = conn.cursor()
    for idx in ("IX_DS_TEXT", "IX_COL_TEXT"):
        try:
            cur.execute("BEGIN CTX_DDL.SYNC_INDEX(:i); END;", {"i": idx})
            log(f"[search] synced {idx}")
        except Exception as e:
            log(f"[search] skip sync {idx}: {e}")
    cur.close()


def _make_resolver(platform_id):
    """Resolve sqlglot (catalog, db, table) parts to a dataset_key."""
    def resolver(parts):
        catalog, db, table = parts
        if not table:
            return None
        return dataset_key(platform_id, db, catalog, table)
    return resolver


def _list_sources(prefix):
    """Discover source ids from env vars like ORA_<id>_DSN."""
    ids = set()
    for k in os.environ:
        if k.startswith(f"{prefix}_") and k.endswith("_DSN") and prefix == "ORA":
            ids.add(k[len(prefix) + 1:-4])
        if k.startswith(f"{prefix}_") and k.endswith("_CONNSTR") and prefix == "MSSQL":
            ids.add(k[len(prefix) + 1:-8])
    return sorted(ids)


def _csv(v):
    return [x.strip() for x in v.split(",")] if v else None


def _q(conn, sql, params=None):
    """Small query helper returning list of dict rows."""
    cur = conn.cursor()
    cur.execute(sql, params or {})
    cols = [c[0].lower() for c in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    cur.close()
    return rows


if __name__ == "__main__":
    import sys
    sel = set(sys.argv[1:]) or None
    run(sel)
