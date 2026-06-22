-- =====================================================================
-- CP Metadata Catalog - schema additions (v3)
-- Adds dbt model + Airflow pipeline entities and extends lineage with
-- asset-type discriminators so edges can connect dataset<->model<->task.
-- Run AFTER 01_schema.sql, connected as METACAT.
-- =====================================================================

-- ---------- DBT MODELS (the transformation entity) ------------------
CREATE TABLE dbt_models (
    model_key     VARCHAR2(256) NOT NULL,   -- project.model_name
    produced_key  VARCHAR2(520),            -- dataset it materializes
    project       VARCHAR2(128),
    name          VARCHAR2(128),
    materialization VARCHAR2(30),           -- table|view|incremental|ephemeral
    layer         VARCHAR2(20),
    description   CLOB,
    raw_sql       CLOB,
    compiled_sql  CLOB,
    tests         CLOB,                     -- JSON array of test names
    updated_at    TIMESTAMP DEFAULT SYSTIMESTAMP,
    CONSTRAINT pk_dbt_models PRIMARY KEY (model_key)
);
CREATE INDEX ix_dbt_produced ON dbt_models(produced_key);

-- ---------- PIPELINES (Airflow DAGs) --------------------------------
CREATE TABLE pipelines (
    dag_id        VARCHAR2(250) NOT NULL,
    description   CLOB,
    schedule      VARCHAR2(250),
    owners        VARCHAR2(500),
    is_paused     CHAR(1) DEFAULT 'N',
    tags          VARCHAR2(1000),
    last_seen_at  TIMESTAMP DEFAULT SYSTIMESTAMP,
    CONSTRAINT pk_pipelines PRIMARY KEY (dag_id)
);

-- ---------- PIPELINE TASKS ------------------------------------------
CREATE TABLE pipeline_tasks (
    task_key      VARCHAR2(520) NOT NULL,    -- dag_id.task_id
    dag_id        VARCHAR2(250) NOT NULL,
    task_id       VARCHAR2(250) NOT NULL,
    operator      VARCHAR2(250),
    group_id      VARCHAR2(250),
    model_key     VARCHAR2(256),             -- resolved Cosmos -> dbt model
    CONSTRAINT pk_pipeline_tasks PRIMARY KEY (task_key),
    CONSTRAINT fk_task_dag FOREIGN KEY (dag_id) REFERENCES pipelines(dag_id)
);
CREATE INDEX ix_task_model ON pipeline_tasks(model_key);

-- ---------- PIPELINE RUNS (replaces dataset_runs role) --------------
CREATE TABLE pipeline_runs (
    run_id        VARCHAR2(600) NOT NULL,
    dag_id        VARCHAR2(250) NOT NULL,
    task_id       VARCHAR2(250),
    status        VARCHAR2(30),
    start_ts      TIMESTAMP,
    end_ts        TIMESTAMP,
    duration_s    NUMBER,
    CONSTRAINT pk_pipeline_runs PRIMARY KEY (run_id)
);
CREATE INDEX ix_prun_dag ON pipeline_runs(dag_id);

-- ---------- extend table_lineage with type discriminators -----------
ALTER TABLE table_lineage ADD (
    from_type VARCHAR2(20) DEFAULT 'dataset',   -- dataset | dbt_model | task
    to_type   VARCHAR2(20) DEFAULT 'dataset'
);

-- ---------- column_lineage: annotate with producing model -----------
ALTER TABLE column_lineage ADD (
    model_key VARCHAR2(256)
);

-- ---------- convenience view: 360 dataset summary -------------------
CREATE OR REPLACE VIEW v_dataset_360 AS
SELECT d.dataset_key,
       d.platform_id,
       d.schema_name,
       d.object_name,
       d.object_type,
       d.layer,
       COALESCE(d.business_desc, d.tech_desc) AS description,
       d.owner,
       d.tags,
       m.model_key,
       m.materialization,
       (SELECT COUNT(*) FROM columns c WHERE c.dataset_key = d.dataset_key) AS column_count,
       (SELECT COUNT(*) FROM table_lineage tl WHERE tl.to_key = d.dataset_key)   AS upstream_count,
       (SELECT COUNT(*) FROM table_lineage tl WHERE tl.from_key = d.dataset_key) AS downstream_count
FROM   datasets d
LEFT   JOIN dbt_models m ON m.produced_key = d.dataset_key;
