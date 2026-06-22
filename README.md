# CP Metadata Catalog

A self-hosted data catalog, lineage, and data-health platform for the CP pipeline
(Airflow + dbt + Oracle / SQL Server), deployed on OpenShift. Delivers the
capabilities of OpenMetadata that matter to CP — without the operational weight.

## Features

- **360° data exploration & search** across Oracle and SQL Server assets.
- **Lineage graph** (OpenMetadata-style): three planes (data / transform / orchestration),
  table-level and **column-level** lineage, impact analysis ("N downstream columns affected").
- **Transformation rules** — compiled SQL per model, with materialization and tests.
- **dbt models and Airflow DAGs as first-class assets**, with Cosmos task↔model mapping.
- **Runtime gate** (observe-only): pass/warn/fail verdicts per model/layer from tests + freshness.
- **Observability**: run trends, durations, freshness, volume — support + business views.
- **Data quality**: per-dataset scorecards by dimension, trended; two audiences.
- **Business metadata overlay** via standardized Excel/Word templates.
- **API 360** — explore the SEI API as the 4th tab: endpoint dependency graph,
  business-flow (Postman) call sequences, datapoint-across-API, and search, all
  with graphical drill-down. Ingests Swagger + Postman (+ optional dictionary)
  from the webfs CIFS share. Exploration only; never calls the SEI API.
- **Catalog-as-byproduct**: one idempotent ingestion job harvests everything after each dbt build.

## Repository structure

```
sql/                 Oracle DDL (schema, entities, quality/gate/observability)
ingestion/           Connectors + loader + orchestrator (Oracle, SQL Server, dbt,
                     sqlglot, Airflow meta, quality, Excel/Word overlay)
api/                 FastAPI read API (+ Dockerfile)
ui/                  React + Vite lineage UI and dashboards (+ Dockerfile)
airflow/dags/        Ingestion DAG (astronomer-cosmos friendly)
deploy/openshift/    Namespace, config, API, UI, ingestion CronJob manifests
deploy/nginx.conf    SPA + /api reverse proxy
docs/                Functional spec, install/deploy guide, business templates
```

## Quickstart (local dev)

```bash
# 1. Catalog schema (against a dev Oracle)
sqlplus metacat/pwd@dsn @sql/01_schema.sql
sqlplus metacat/pwd@dsn @sql/02_schema_additions.sql
sqlplus metacat/pwd@dsn @sql/03_quality_gate_observability.sql

# 2. API
pip install -r api/requirements.txt
export METACAT_USER=metacat METACAT_PASSWORD=pwd METACAT_DSN=host:1521/FREEPDB1
uvicorn api.app.main:app --reload

# 3. UI (proxies to the API)
cd ui && npm install && npm run dev

# 4. Ingest (after a dbt build)
export DBT_MANIFEST_PATH=.../target/manifest.json DBT_TARGET_PLATFORM=ora_prod ...
python -m ingestion.run
```

The UI runs in **DEMO** mode with embedded sample data until the API is reachable,
then flips to **LIVE**.

## Deployment

See **docs/INSTALL_DEPLOY.md** for the full OpenShift deployment (images, config,
routes, ingestion). See **docs/FUNCTIONAL_SPEC.md** for the complete capability spec.

## Design decisions

- **Table lineage from dbt** (authoritative ref/source graph), **column lineage from
  sqlglot** (compiled SQL). No guessing.
- **Platform dimension on every entity** + globally-qualified keys → new sources are
  one connector class, no schema change.
- **Technical vs business metadata separated** → overlay never clobbers harvested facts.
- **Idempotent MERGE upserts** → safe re-harvest on every dbt build.
- **Runtime gate observe-only in v1** → zero risk; enforcement is a later opt-in
  (the `blocking` flag is already recorded).

## Scope boundaries (v1)

Out of scope, addable later: RBAC governance workflows, glossary approval flows,
alerting/paging, gate enforcement, report export (Excel/PDF), and the 50+ connector
catalog. The data model leaves room for these.
