"""
Airflow metadata-DB harvester (Airflow 3.x, Postgres).

Reads (READ-ONLY) from the Airflow metadata database:
  - dag             -> pipelines (schedule, paused, owners, description)
  - serialized_dag  -> task structure + operator types (JSON), and the
                       Cosmos TaskGroup -> dbt model mapping
  - dag_run         -> run history (state, dates)
  - task_instance   -> per-task state + duration

Cosmos mapping: astronomer-cosmos renders each dbt model as a task whose
task_id is the model name, nested in a TaskGroup named after the dbt project
(or the DbtTaskGroup's group_id). We read the serialized structure and map
task_id -> model_key by matching the leaf task name to a known dbt model.

Use a dedicated READ-ONLY Postgres role. Never write to this DB.
"""
from __future__ import annotations
import json
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Pipeline:
    dag_id: str
    description: Optional[str]
    schedule: Optional[str]
    owners: Optional[str]
    is_paused: bool
    tags: list[str] = field(default_factory=list)


@dataclass
class PipelineTask:
    task_key: str        # dag_id.task_id
    dag_id: str
    task_id: str
    operator: Optional[str]
    group_id: Optional[str]
    model_key: Optional[str] = None     # resolved to a dbt model if Cosmos task


@dataclass
class PipelineRun:
    run_id: str
    dag_id: str
    task_id: Optional[str]
    status: Optional[str]
    start_ts: Optional[str]
    end_ts: Optional[str]
    duration_s: Optional[float]


class AirflowMetaConnector:
    def __init__(self, pg_conn, dbt_project: str | None = None,
                 known_model_names: set[str] | None = None,
                 run_history_limit: int = 200):
        """
        pg_conn: a psycopg connection to the Airflow metadata DB (read-only).
        dbt_project: dbt package/project name to qualify model_key.
        known_model_names: set of dbt model names to match Cosmos tasks against.
        """
        self.conn = pg_conn
        self.dbt_project = dbt_project
        self.known = known_model_names or set()
        self.run_limit = run_history_limit

    # ---- pipelines -----------------------------------------------------
    def extract_pipelines(self) -> list[Pipeline]:
        cur = self.conn.cursor()
        # timetable_summary / schedule_interval naming differs across versions;
        # COALESCE the likely columns defensively.
        cur.execute("""
            SELECT dag_id,
                   description,
                   COALESCE(
                     NULLIF(timetable_summary, ''),
                     CAST(schedule_interval AS TEXT)
                   ) AS schedule,
                   owners,
                   is_paused
            FROM   dag
        """)
        rows = cur.fetchall()
        # tags (separate table)
        tags_by_dag: dict[str, list[str]] = {}
        try:
            cur.execute("SELECT dag_id, name FROM dag_tag")
            for dag_id, name in cur.fetchall():
                tags_by_dag.setdefault(dag_id, []).append(name)
        except Exception:
            self.conn.rollback()
        cur.close()
        return [
            Pipeline(dag_id=r[0], description=r[1], schedule=r[2],
                     owners=r[3], is_paused=bool(r[4]),
                     tags=tags_by_dag.get(r[0], []))
            for r in rows
        ]

    # ---- tasks (from serialized_dag JSON) ------------------------------
    def extract_tasks(self) -> list[PipelineTask]:
        cur = self.conn.cursor()
        # In Airflow 3.x serialized_dag may join via dag_version; take the
        # latest serialized blob per dag_id.
        cur.execute("""
            SELECT dag_id, data
            FROM   serialized_dag
            WHERE  (dag_id, last_updated) IN (
                       SELECT dag_id, MAX(last_updated)
                       FROM serialized_dag GROUP BY dag_id)
        """)
        out: list[PipelineTask] = []
        for dag_id, data in cur.fetchall():
            blob = data if isinstance(data, dict) else json.loads(data)
            dag = blob.get("dag", blob)
            tasks = dag.get("tasks", [])
            # task_group structure (for group_id / Cosmos project group)
            group_lookup = self._build_group_lookup(dag.get("task_group"))
            for t in tasks:
                # serialized task is often {"__var": {...}, "__type": "..."}
                tv = t.get("__var", t)
                task_id = tv.get("task_id") or tv.get("_task_id")
                operator = (tv.get("_task_type") or tv.get("task_type")
                            or t.get("__type"))
                gid = group_lookup.get(task_id)
                model_key = self._resolve_model(task_id, operator)
                out.append(PipelineTask(
                    task_key=f"{dag_id}.{task_id}",
                    dag_id=dag_id, task_id=task_id,
                    operator=operator, group_id=gid, model_key=model_key))
        cur.close()
        return out

    # ---- runs ----------------------------------------------------------
    def extract_runs(self) -> list[PipelineRun]:
        cur = self.conn.cursor()
        cur.execute("""
            SELECT ti.dag_id, ti.run_id, ti.task_id, ti.state,
                   ti.start_date, ti.end_date,
                   EXTRACT(EPOCH FROM (ti.end_date - ti.start_date))
            FROM   task_instance ti
            ORDER  BY ti.start_date DESC NULLS LAST
            LIMIT  %s
        """, (self.run_limit,))
        runs = [
            PipelineRun(
                run_id=f"{r[0]}.{r[1]}.{r[2]}",
                dag_id=r[0], task_id=r[2], status=r[3],
                start_ts=str(r[4]) if r[4] else None,
                end_ts=str(r[5]) if r[5] else None,
                duration_s=float(r[6]) if r[6] is not None else None,
            )
            for r in cur.fetchall()
        ]
        cur.close()
        return runs

    # ---- helpers -------------------------------------------------------
    def _resolve_model(self, task_id: str, operator: str | None) -> Optional[str]:
        """Map a Cosmos dbt task to a dbt model_key by name match."""
        if not task_id:
            return None
        # Cosmos task ids are often '<model>_run' / '<model>.run' or just '<model>'
        candidates = {task_id, task_id.replace(".run", ""),
                      task_id.replace("_run", ""), task_id.split(".")[0]}
        for c in candidates:
            if c in self.known:
                proj = self.dbt_project or "dbt"
                return f"{proj}.{c}"
        return None

    def _build_group_lookup(self, task_group, acc=None, parent=None):
        """Flatten task_group tree to {task_id: group_id}."""
        acc = acc if acc is not None else {}
        if not task_group:
            return acc
        tg = task_group.get("__var", task_group)
        gid = tg.get("_group_id") or tg.get("group_id") or parent
        for child_id, child in (tg.get("children") or {}).items():
            cv = child.get("__var", child)
            if "children" in cv or cv.get("_group_id"):
                self._build_group_lookup(child, acc, gid)
            else:
                acc[child_id] = gid
        return acc
