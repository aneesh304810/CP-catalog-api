"""
Catalog loader. Takes normalized records from all connectors and upserts them
into the METACAT Oracle schema with idempotent MERGE statements.

Order matters (FK dependencies):
  platforms -> datasets -> columns -> dbt_models -> transformations
            -> table_lineage -> column_lineage
            -> pipelines -> pipeline_tasks -> pipeline_runs
Business overlay is applied last (UPDATE only; never overwrites tech fields).
"""
from __future__ import annotations
import json
from typing import Iterable


class CatalogLoader:
    def __init__(self, conn):
        self.conn = conn

    def commit(self):
        self.conn.commit()

    # ---- platforms -----------------------------------------------------
    def upsert_platform(self, platform_id, kind, dialect, display=None):
        self._merge("platforms", "platform_id", {
            "platform_id": platform_id, "kind": kind,
            "sqlglot_dialect": dialect, "display_name": display or platform_id})

    # ---- datasets + columns -------------------------------------------
    def upsert_datasets(self, datasets: Iterable):
        for d in datasets:
            self._merge("datasets", "dataset_key", {
                "dataset_key": d.key, "platform_id": d.platform_id,
                "database_name": d.database, "schema_name": d.schema,
                "object_name": d.object_name, "object_type": d.object_type,
                "layer": d.layer, "tech_desc": d.tech_desc, "owner": d.owner,
                "row_count": d.row_count, "last_seen_at": {"__systs__": True},
            }, protect=("business_desc",))
            for c in d.columns:
                from .model import column_key
                self._merge("columns", "column_key", {
                    "column_key": column_key(d.key, c.name),
                    "dataset_key": d.key, "column_name": c.name,
                    "ordinal": c.ordinal, "data_type": c.data_type,
                    "is_nullable": "Y" if c.is_nullable else "N",
                    "is_pk": "Y" if c.is_pk else "N", "tech_desc": c.tech_desc,
                }, protect=("business_desc", "sensitivity"))

    # ---- dbt models + transformations ---------------------------------
    def upsert_models(self, models: Iterable):
        for m in models:
            self._merge("dbt_models", "model_key", {
                "model_key": m.model_key, "produced_key": m.produced_key,
                "project": m.project, "name": m.name,
                "materialization": m.materialization, "layer": m.layer,
                "description": m.description, "raw_sql": m.raw_sql,
                "compiled_sql": m.compiled_sql, "tests": json.dumps(m.tests),
            })

    def upsert_transformations(self, transforms: Iterable):
        for t in transforms:
            self._merge("transformations", "transform_id", {
                "transform_id": t.target_key, "target_key": t.target_key,
                "transform_type": t.transform_type, "dbt_model": t.dbt_model,
                "compiled_sql": t.compiled_sql, "raw_sql": t.raw_sql})

    # ---- lineage -------------------------------------------------------
    def upsert_table_edges(self, edges: Iterable):
        for e in edges:
            self._merge("table_lineage", "edge_id", {
                "edge_id": e.edge_id, "from_key": e.from_key, "to_key": e.to_key,
                "from_type": getattr(e, "from_type", "dataset"),
                "to_type": getattr(e, "to_type", "dataset"),
                "source": e.source, "transform_id": e.transform_id})

    def upsert_column_edges(self, edges: Iterable, model_key=None):
        for e in edges:
            self._merge("column_lineage", "edge_id", {
                "edge_id": e.edge_id, "from_column": e.from_column,
                "to_column": e.to_column, "transform_expr": e.transform_expr,
                "source": e.source, "model_key": model_key})

    # ---- pipelines -----------------------------------------------------
    def upsert_pipelines(self, pipelines: Iterable):
        for p in pipelines:
            self._merge("pipelines", "dag_id", {
                "dag_id": p.dag_id, "description": p.description,
                "schedule": p.schedule, "owners": p.owners,
                "is_paused": "Y" if p.is_paused else "N",
                "tags": ",".join(p.tags), "last_seen_at": {"__systs__": True}})

    def upsert_tasks(self, tasks: Iterable):
        for t in tasks:
            self._merge("pipeline_tasks", "task_key", {
                "task_key": t.task_key, "dag_id": t.dag_id, "task_id": t.task_id,
                "operator": t.operator, "group_id": t.group_id,
                "model_key": t.model_key})

    def upsert_runs(self, runs: Iterable):
        for r in runs:
            self._merge("pipeline_runs", "run_id", {
                "run_id": r.run_id, "dag_id": r.dag_id, "task_id": r.task_id,
                "status": r.status, "start_ts": {"__ts__": r.start_ts},
                "end_ts": {"__ts__": r.end_ts}, "duration_s": r.duration_s})

    # ---- business overlay (UPDATE only) -------------------------------
    def apply_dataset_overlay(self, overlays: Iterable):
        cur = self.conn.cursor()
        for o in overlays:
            cur.execute("""
                UPDATE datasets SET
                  business_desc = NVL(:bd, business_desc),
                  owner         = NVL(:ow, owner),
                  tags          = NVL(:tg, tags)
                WHERE dataset_key = :k""",
                {"bd": o.business_desc, "ow": o.owner, "tg": o.tags,
                 "k": o.dataset_key})
        cur.close()

    def apply_column_overlay(self, overlays: Iterable):
        cur = self.conn.cursor()
        for o in overlays:
            cur.execute("""
                UPDATE columns SET
                  business_desc = NVL(:bd, business_desc),
                  sensitivity   = NVL(:sn, sensitivity)
                WHERE column_key = :k""",
                {"bd": o.business_desc, "sn": o.sensitivity, "k": o.column_key})
        cur.close()

    # ---- quality / gate / freshness -----------------------------------
    def upsert_quality(self, results):
        for r in results:
            self._merge("quality_results", "result_id", {
                "result_id": r.result_id, "dataset_key": r.dataset_key,
                "column_name": r.column_name, "test_name": r.test_name,
                "dimension": r.dimension, "status": r.status,
                "observed_value": r.observed_value, "threshold": r.threshold,
                "message": r.message, "run_id": r.run_id,
                "run_ts": {"__ts__": _isots(r.run_ts)}})

    def upsert_gates(self, gates):
        for g in gates:
            self._merge("gate_evaluations", "gate_eval_id", {
                "gate_eval_id": g.gate_eval_id, "gate_name": g.gate_name,
                "scope_type": g.scope_type, "scope_key": g.scope_key,
                "verdict": g.verdict, "blocking": "Y" if g.blocking else "N",
                "rules_total": g.rules_total, "rules_passed": g.rules_passed,
                "rules_failed": g.rules_failed, "detail": g.detail,
                "run_id": g.run_id, "run_ts": {"__ts__": _isots(g.run_ts)}})

    def upsert_freshness(self, snaps):
        for s in snaps:
            self._merge("freshness_snapshots", "snapshot_id", {
                "snapshot_id": s.snapshot_id, "dataset_key": s.dataset_key,
                "row_count": s.row_count,
                "max_loaded_at": {"__ts__": _isots(s.max_loaded_at)},
                "lag_minutes": s.lag_minutes, "status": s.status,
                "captured_ts": {"__ts__": _isots(s.captured_ts)}})

    # ---- quality / gates / freshness ----------------------------------
    def upsert_quality(self, results):
        for q in results:
            self._merge("quality_results", "result_id", {
                "result_id": q.result_id, "dataset_key": q.dataset_key,
                "column_name": q.column_name, "test_name": q.test_name,
                "dimension": q.dimension, "status": q.status,
                "observed_value": q.observed_value, "threshold": q.threshold,
                "message": q.message, "run_id": q.run_id, "run_ts": q.run_ts})

    def upsert_gates(self, gates):
        for g in gates:
            self._merge("gate_evaluations", "gate_eval_id", {
                "gate_eval_id": g.gate_eval_id, "gate_name": g.gate_name,
                "scope_type": g.scope_type, "scope_key": g.scope_key,
                "verdict": g.verdict, "rules_total": g.rules_total,
                "rules_passed": g.rules_passed, "rules_failed": g.rules_failed,
                "blocking": "Y" if g.blocking else "N",
                "detail": g.detail, "run_id": g.run_id, "run_ts": g.run_ts})

    def upsert_freshness(self, snapshots):
        for f in snapshots:
            self._merge("freshness_snapshots", "snapshot_id", {
                "snapshot_id": f.snapshot_id, "dataset_key": f.dataset_key,
                "row_count": f.row_count, "max_loaded_at": f.max_loaded_at,
                "lag_minutes": f.lag_minutes, "status": f.status,
                "captured_ts": f.captured_ts})

    # ---- generic MERGE -------------------------------------------------
    def _merge(self, table, pk, values: dict, protect: tuple = ()):
        """
        Idempotent upsert. `protect` columns are only set on INSERT, never
        overwritten on UPDATE (used so technical harvest never clobbers
        business overlay fields).
        """
        cur = self.conn.cursor()
        cols = list(values.keys())
        # build USING select with binds, handling special markers
        sel_parts, binds = [], {}
        for c in cols:
            v = values[c]
            if isinstance(v, dict) and v.get("__systs__"):
                sel_parts.append(f"SYSTIMESTAMP AS {c}")
            elif isinstance(v, dict) and "__ts__" in v:
                binds[c] = v["__ts__"]
                sel_parts.append(f"TO_TIMESTAMP(:{c},'YYYY-MM-DD\"T\"HH24:MI:SS.FF') AS {c}"
                                 if v["__ts__"] else f"NULL AS {c}")
                if not v["__ts__"]:
                    binds.pop(c, None)
            else:
                binds[c] = v
                sel_parts.append(f":{c} AS {c}")
        using = "SELECT " + ", ".join(sel_parts) + " FROM dual"

        upd_cols = [c for c in cols if c != pk and c not in protect]
        upd = ", ".join(f"t.{c} = s.{c}" for c in upd_cols)
        ins_cols = ", ".join(cols)
        ins_vals = ", ".join(f"s.{c}" for c in cols)

        sql = f"""
            MERGE INTO {table} t
            USING ({using}) s
            ON (t.{pk} = s.{pk})
            WHEN MATCHED THEN UPDATE SET {upd}
            WHEN NOT MATCHED THEN INSERT ({ins_cols}) VALUES ({ins_vals})
        """ if upd_cols else f"""
            MERGE INTO {table} t
            USING ({using}) s
            ON (t.{pk} = s.{pk})
            WHEN NOT MATCHED THEN INSERT ({ins_cols}) VALUES ({ins_vals})
        """
        cur.execute(sql, binds)
        cur.close()


def _isots(v):
    """Normalize an ISO timestamp string to 'YYYY-MM-DDTHH:MI:SS.FF' or None."""
    if not v:
        return None
    s = str(v).replace("Z", "").replace("+00:00", "")
    if "." not in s and "T" in s:
        s += ".000000"
    return s
