# CP Metadata Catalog — Functional Specification

**Version:** 1.0  ·  **Status:** Build in progress  ·  **Owner:** CP Technology / Aneesh

A self-hosted data catalog, lineage, and data-health platform for the CP greenfield
pipeline (Airflow + dbt + Oracle / SQL Server), deployed on OpenShift. Delivers the
core capabilities of OpenMetadata for the four features that matter to CP, plus
runtime gating, observability, and data quality — without adopting OpenMetadata's
full operational weight.

---

## 1. Scope at a glance

In scope: data exploration & search, table lineage, transformation rules, column-level
lineage, dbt-model and Airflow-pipeline entities, a rich interactive lineage graph,
runtime gate (observe-only), observability, and data quality — with two tailored
audiences (Global Support, Business).

Out of scope (v1): RBAC governance workflows, glossary approval flows, alerting/paging,
50+ source connectors, and gate *enforcement* (the schema supports it; v1 only observes).

Sources: Oracle and SQL Server (technical metadata); dbt artifacts (models, lineage,
transformations, tests, freshness); Airflow metadata DB (pipelines, tasks, runs);
Excel/Word templates (business metadata).

---

## 2. Core features

### 2.1 Data exploration & 360 view
- Faceted search across all assets by name, description, platform, layer
  (bronze/silver/gold), and object type (table/view).
- Asset 360 page: full schema (columns, types, nullability, PK), technical + business
  descriptions, owner, tags, producing transformation, upstream/downstream counts,
  recent run history, and current data-health status.
- Multi-platform: Oracle + SQL Server unified, each asset platform-badged.
- dbt models and Airflow DAGs are first-class, explorable assets.

### 2.2 Lineage graph
- Interactive canvas: pan, zoom, minimap, fit-to-view, search-to-focus, light/dark.
- Three togglable planes: Data (table→table), Transform (adds dbt-model nodes),
  Orchestration (adds Airflow DAG/task nodes).
- Table-level lineage harvested authoritatively from dbt ref/source graph.
- Column-level lineage traced from compiled SQL via sqlglot; each edge carries its
  transform expression. Columns collapsed by default, expandable on demand.
- Upstream/downstream traversal to N levels from any node.
- Data-health badge (green/amber/red) on each node, from the runtime gate.

### 2.3 Transformation rules
- Every target's compiled SQL stored and viewable as its transformation rule, attached
  to the producing dbt model with materialization type and associated tests.

### 2.4 Impact analysis
- Click a column to trace its full lineage path (upstream + downstream), dimming the
  rest. Shows "N downstream columns affected" for change planning.

---

## 3. Pipeline & orchestration

- Airflow DAGs, tasks, and run history harvested from the Airflow metadata DB.
- Cosmos task↔dbt-model mapping (1:1), so each task's model is known, with per-run
  status and duration.
- Pipeline detail view: tasks, schedule, owners, recent runs.

---

## 4. Runtime gate (observe-only)

A checkpoint that evaluates rules at pipeline runtime and records a verdict, without
blocking the pipeline in v1.

- Rules per model or layer boundary (e.g. Silver→Gold): dbt test outcomes, freshness
  thresholds, and row-count/volume bounds.
- Verdict: PASS / WARN / FAIL, with the list of rules evaluated and a `blocking` flag
  (recorded but not enforced in v1).
- Surfaced as: a gate badge on lineage nodes, a gate panel on the asset 360 page, and a
  failing-gate list on the support dashboard.
- Enforcement is a future opt-in per pipeline; the data model already carries the
  `blocking` flag so enabling it later needs no schema change.

---

## 5. Observability

Operational health of pipelines and data.

- Run trends: success/failure over time, per DAG and per model.
- Durations: task/model runtime trends to spot regressions.
- Freshness: per-dataset lag (how stale), with SLA targets.
- Volume: row-count trends to catch under/over-loads.
- Two surfaces:
  - Global Support: dense dashboard — failures, stale datasets, slow tasks, drill-down.
  - Business: freshness + "last updated" per report-facing dataset.

---

## 6. Data quality gate view & report

The DQ dimension specifically, sourced from dbt test results.

- Per-dataset DQ scorecard by dimension: completeness, uniqueness, validity,
  referential integrity, freshness.
- Test pass rates and coverage, trended over time.
- Two surfaces:
  - Global Support: failing tests with detail, coverage gaps.
  - Business: domain-level DQ scorecards and trends (trust view).
- In-app views in v1; downloadable Excel/PDF report deferred (data model supports it).

---

## 7. Business metadata overlay

- Standardized Excel and Word templates for business users to add descriptions, owners,
  tags, and sensitivity (PII/CONFIDENTIAL/INTERNAL/PUBLIC).
- Overlay updates business fields only; never overwrites harvested technical metadata.

---

## 8. Ingestion (catalog-as-byproduct)

- Connectors: Oracle dict, SQL Server, dbt manifest, sqlglot column lineage, dbt
  run_results/sources (quality + freshness), Airflow metadata DB, Excel/Word overlay.
- One idempotent Airflow DAG re-harvests after each dbt build via MERGE upserts — no
  manual curation.
- Pluggable connector model: a new source is one new class, no schema change.

---

## 9. Audiences

| Capability        | Global Support Team                         | Business Team                              |
|-------------------|---------------------------------------------|--------------------------------------------|
| Runtime gate      | Live gate status, failures, blocking reasons| Approved/published green-amber-red per set |
| Observability     | Runs, durations, freshness SLAs, drill-down | Freshness + last-updated per report set    |
| Data quality      | Failing tests, coverage gaps                | DQ scorecards + trend per domain           |
| Lineage           | Full technical lineage + impact             | Business-readable lineage summary          |

---

## 10. Architecture summary

```
Sources         Oracle dict · SQL Server I_S · dbt artifacts · Airflow meta DB · Excel/Word
   │
Connectors      oracle · mssql · dbt(manifest) · sqlglot · dbt(run_results/sources) · airflow · overlay
   │   (one idempotent Airflow ingestion DAG, MERGE upserts)
Metadata store  Oracle schema METACAT — datasets · columns · dbt_models · transformations
                · table_lineage · column_lineage · pipelines · pipeline_tasks · pipeline_runs
                · quality_results · gate_evaluations · freshness_snapshots
   │
API             FastAPI read API (search, asset360, lineage, impact, pipelines,
                quality, gates, observability)
   │
UI              React: Explore · Lineage graph (3 planes, column-level, impact)
                · Asset 360 · Pipelines · Health/Observability · DQ & Gate views
   │
Audiences       Global Support dashboard · Business trust views
```

---

## 11. Technology

Oracle (catalog store, reuses existing infra) · Python connectors + sqlglot · FastAPI ·
React + Vite · Airflow 3.x + astronomer-cosmos · deployed on OpenShift (UBI images,
non-root, Routes, Secrets/ConfigMaps).
