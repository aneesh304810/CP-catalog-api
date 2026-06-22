# CP Metadata Catalog — Installation & Deployment Guide

Target platform: **OpenShift** (4.x). Catalog store: **Oracle** (dedicated `METACAT`
schema in an existing instance). Sources: Oracle, SQL Server, dbt artifacts, Airflow
metadata DB, Excel/Word overlay.

This guide covers: prerequisites, database setup, image builds, configuration,
deployment, ingestion, and verification.

---

## 1. Architecture recap

```
 React UI (nginx)  ──/api──▶  FastAPI  ──▶  Oracle METACAT schema
       ▲                                          ▲
   Route (TLS)                                     │ MERGE upserts
                                                   │
 Ingestion (Airflow DAG or OpenShift CronJob) ─────┘
   reads: Oracle dict · SQL Server · dbt target/*.json · Airflow Postgres · Excel/Word
```

Three deployable units: **api**, **ui**, **ingestion** (the api image also runs ingestion).

---

## 2. Prerequisites

- OpenShift project/namespace admin (or ability to create one).
- `oc` CLI logged in to the cluster.
- An Oracle instance reachable from the cluster for the `METACAT` schema.
- Read-only credentials to each source: Oracle, SQL Server, Airflow metadata Postgres.
- The dbt build publishes `target/manifest.json`, `catalog.json`, `run_results.json`,
  and (if using freshness) `sources.json` to a location the ingestion can read
  (a shared PVC is the simplest).
- astronomer-cosmos used for dbt orchestration (so task↔model mapping is automatic).

---

## 3. Database setup (METACAT)

Connect to the target Oracle as a privileged user and create the schema owner:

```sql
CREATE USER metacat IDENTIFIED BY "<strong-password>";
GRANT CONNECT, RESOURCE, CREATE VIEW TO metacat;
ALTER USER metacat QUOTA UNLIMITED ON USERS;
```

Then, connected as `metacat`, run the DDL in order:

```bash
sqlplus metacat/<pwd>@<dsn> @sql/01_schema.sql
sqlplus metacat/<pwd>@<dsn> @sql/02_schema_additions.sql
sqlplus metacat/<pwd>@<dsn> @sql/03_quality_gate_observability.sql
sqlplus metacat/<pwd>@<dsn> @sql/04_security_governance_versioning.sql
sqlplus metacat/<pwd>@<dsn> @sql/06_oracle_text_search.sql   # full-text search
```

**Oracle Text (full-text search) prerequisites.** `06_oracle_text_search.sql` creates
CONTEXT indexes for ranked full-text search over datasets and columns. Oracle Text is
included in SE2/EE at no extra license, but verify it's installed and grant the role:

```sql
-- as DBA:
SELECT comp_name, status FROM dba_registry WHERE comp_name LIKE '%Text%';  -- expect VALID
GRANT CTXAPP TO metacat;
```

If Oracle Text isn't available, skip `06_*.sql` — search automatically falls back to
LIKE matching, so the catalog still works (without relevance ranking or column search
ranking). The ingestion job syncs the indexes after each load; `SYNC (ON COMMIT)` also
keeps them current between runs.

Create **read-only** users on each source for harvesting, e.g. on Oracle:

```sql
CREATE USER catalog_ro IDENTIFIED BY "<pwd>";
GRANT CREATE SESSION TO catalog_ro;
GRANT SELECT ANY DICTIONARY TO catalog_ro;          -- or per-schema SELECT grants
```

On SQL Server:

```sql
CREATE LOGIN catalog_ro WITH PASSWORD = '<pwd>';
CREATE USER catalog_ro FOR LOGIN catalog_ro;
GRANT VIEW DEFINITION TO catalog_ro;
GRANT SELECT ON SCHEMA::risk TO catalog_ro;
```

On the Airflow metadata Postgres, create a read-only role with `SELECT` on
`dag`, `dag_run`, `task_instance`, `serialized_dag`, `dag_tag`.

---

## 4. Create the project and configuration

```bash
oc apply -f deploy/openshift/00-namespace.yaml
```

Copy `deploy/openshift/01-config.yaml`, fill in **real** credentials and DSNs
(do not commit), then apply:

```bash
oc apply -f 01-config.yaml      # your filled copy
```

Key values to set:
- `METACAT_*` — the catalog store connection.
- `ORA_<ID>_*` / `MSSQL_<ID>_CONNSTR` — one block per source; the `<ID>` becomes
  the platform id (e.g. `ORA_PROD_DSN` → platform `ora_prod`).
- `AIRFLOW_DB_DSN` — read-only Postgres URL.
- `DBT_*` paths — where the dbt artifacts are mounted.
- `OVERLAY_PATH` — the business metadata template location (optional).

---

## 5. Build the images

Using OpenShift internal builds (BuildConfig or `oc new-build`), from the repo root:

```bash
# API (also used for ingestion)
oc new-build --name cp-catalog-api --binary --strategy docker
oc start-build cp-catalog-api --from-dir . --follow \
  --build-arg DOCKERFILE_PATH=api/Dockerfile

# UI
oc new-build --name cp-catalog-ui --binary --strategy docker
oc start-build cp-catalog-ui --from-dir . --follow \
  --build-arg DOCKERFILE_PATH=ui/Dockerfile
```

> If your builder doesn't support `DOCKERFILE_PATH`, build locally with
> `docker build -f api/Dockerfile -t <registry>/cp-catalog-api .` and
> `docker build -f ui/Dockerfile -t <registry>/cp-catalog-ui .`, push to the
> internal registry, and skip `oc new-build`.

Both Dockerfiles use Red Hat UBI base images and run as a non-root UID in the
root group, matching OpenShift's restricted SCC.

---

## 6. Deploy API and UI

```bash
oc apply -f deploy/openshift/02-api.yaml
oc apply -f deploy/openshift/03-ui.yaml
```

Get the public URL:

```bash
oc get route cp-catalog -o jsonpath='{.spec.host}'
```

The UI proxies `/api` to the `cp-catalog-api` service via nginx, so the browser
only needs the one Route. The UI shows a **LIVE/DEMO** badge: DEMO means it can't
reach the API yet (it still renders with sample data).

---

## 7. Run ingestion

Two options — pick one.

### Option A — Airflow DAG (recommended, integrates with your pipeline)

Copy `airflow/dags/cp_catalog_ingestion.py` into your Airflow DAGs folder and make
the `ingestion` package importable (bake it into your Airflow image or mount it).
Provide the same environment variables (Secret/ConfigMap) to the Airflow workers.
The DAG runs after the dbt build (`schedule: 30 6 * * 1-5`) and has one task per
connector.

### Option B — OpenShift CronJob (standalone)

```bash
oc apply -f deploy/openshift/04-ingestion-cronjob.yaml
```

Ensure the `dbt-artifacts-pvc` is the same volume your dbt build writes `target/`
into. Trigger an immediate run to seed the catalog:

```bash
oc create job --from=cronjob/cp-catalog-ingestion cp-catalog-ingest-now
oc logs -f job/cp-catalog-ingest-now
```

Run a subset of steps if needed:

```bash
python -m ingestion.run oracle mssql dbt        # skip airflow/quality/overlay
```

---

## 8. Verify

```bash
# API health
oc exec deploy/cp-catalog-api -- curl -s localhost:8000/health
# search
oc exec deploy/cp-catalog-api -- curl -s 'localhost:8000/search?q=positions'
# lineage
oc exec deploy/cp-catalog-api -- curl -s 'localhost:8000/lineage/table?root=<dataset_key>&plane=transform'
```

In the browser (the Route URL): the badge should read **LIVE**, search should
return harvested assets, the lineage graph should populate, and the Health &
Quality screen should show gate verdicts and freshness.

---

## 9. Business metadata overlay

Give business users `docs/business_metadata_template.xlsx` (or the `.docx`). They
fill the Datasets and Columns sheets/tables and return the file. Mount it at
`OVERLAY_PATH` (a ConfigMap or PVC) and the next ingestion applies it — business
descriptions, owners, tags, and sensitivity overlay the technical metadata without
overwriting it.

---

## 10. Operations

- **Re-harvest cadence:** the DAG/CronJob is idempotent (MERGE upserts), so re-runs
  are safe and cheap. Schedule after each dbt build.
- **Dropped objects:** `last_seen_at` on datasets/pipelines lets you detect and
  prune assets no longer present (add a cleanup step if desired).
- **Scaling:** API and UI are stateless; bump `replicas`. The catalog store is your
  Oracle instance — size the `METACAT` schema modestly (metadata, not data).
- **Column lineage coverage:** clean dbt SELECT/CTE SQL traces ~90%+. For models
  that use `SELECT *` or push logic into PL/SQL, lineage may be partial; keep
  transformation logic in dbt models to maximize coverage.
- **Runtime gate:** v1 is **observe-only** — verdicts are recorded and shown but do
  not block pipelines. To enforce later, add a gate-check task to your pipeline DAG
  that reads `gate_evaluations` and fails on a blocking `fail`.

---

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| UI shows DEMO | API unreachable | Check `cp-catalog-api` pod/health, nginx `/api` proxy, service name |
| `/health` 503 | METACAT creds/DSN wrong | Verify Secret `METACAT_*`, network to Oracle |
| Empty lineage | dbt artifacts not found | Check `DBT_*` paths and the artifacts mount |
| No column lineage | sqlglot couldn't resolve SQL | Avoid `SELECT *`; keep logic in dbt; check dialect |
| No pipelines/runs | Airflow DB unreachable | Verify `AIRFLOW_DB_DSN` read-only role and grants |
| Airflow tasks not mapped to models | not using Cosmos / name mismatch | Confirm Cosmos task ids match model names |
