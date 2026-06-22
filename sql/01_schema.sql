-- =====================================================================
-- CP Metadata Catalog - Oracle schema
-- Lives in a dedicated schema (e.g. METACAT) in the existing Oracle DB.
-- Supports multi-platform sources (Oracle, SQL Server) via a platform
-- dimension on every entity. Globally-qualified keys enable cross-system
-- lineage stitching.
-- =====================================================================
-- Run as a privileged user:
--   CREATE USER metacat IDENTIFIED BY <pwd>;
--   GRANT CONNECT, RESOURCE, CREATE VIEW TO metacat;
--   ALTER USER metacat QUOTA UNLIMITED ON USERS;
-- Then run the rest connected as METACAT.
-- =====================================================================

-- ---------- PLATFORMS (registered source systems) -------------------
CREATE TABLE platforms (
    platform_id   VARCHAR2(40)  NOT NULL,   -- e.g. 'oracle_prod', 'mssql_risk'
    kind          VARCHAR2(20)  NOT NULL,   -- 'oracle' | 'mssql'
    display_name  VARCHAR2(120),
    sqlglot_dialect VARCHAR2(20) NOT NULL,  -- 'oracle' | 'tsql'
    created_at    TIMESTAMP DEFAULT SYSTIMESTAMP,
    CONSTRAINT pk_platforms PRIMARY KEY (platform_id),
    CONSTRAINT ck_platform_kind CHECK (kind IN ('oracle','mssql'))
);

-- ---------- DATASETS (tables / views) -------------------------------
-- dataset_key is the GLOBAL canonical id: platform.database.schema.object
CREATE TABLE datasets (
    dataset_key   VARCHAR2(520) NOT NULL,
    platform_id   VARCHAR2(40)  NOT NULL,
    database_name VARCHAR2(128),
    schema_name   VARCHAR2(128),
    object_name   VARCHAR2(128) NOT NULL,
    object_type   VARCHAR2(20),             -- 'TABLE' | 'VIEW'
    layer         VARCHAR2(20),             -- 'bronze'|'silver'|'gold' (medallion)
    tech_desc     CLOB,                     -- harvested (dbt/source comments)
    business_desc CLOB,                     -- overlaid from Excel
    owner         VARCHAR2(120),
    tags          VARCHAR2(1000),           -- comma-separated
    row_count     NUMBER,
    last_seen_at  TIMESTAMP,
    CONSTRAINT pk_datasets PRIMARY KEY (dataset_key),
    CONSTRAINT fk_ds_platform FOREIGN KEY (platform_id) REFERENCES platforms(platform_id)
);
CREATE INDEX ix_datasets_platform ON datasets(platform_id);
CREATE INDEX ix_datasets_layer    ON datasets(layer);

-- ---------- COLUMNS -------------------------------------------------
CREATE TABLE columns (
    column_key    VARCHAR2(650) NOT NULL,   -- dataset_key.column_name
    dataset_key   VARCHAR2(520) NOT NULL,
    column_name   VARCHAR2(128) NOT NULL,
    ordinal       NUMBER,
    data_type     VARCHAR2(128),
    is_nullable   CHAR(1),                  -- 'Y'/'N'
    is_pk         CHAR(1) DEFAULT 'N',
    tech_desc     CLOB,
    business_desc CLOB,                     -- overlaid from Excel
    sensitivity   VARCHAR2(40),             -- e.g. 'PII','CONFIDENTIAL' (Excel)
    CONSTRAINT pk_columns PRIMARY KEY (column_key),
    CONSTRAINT fk_col_dataset FOREIGN KEY (dataset_key) REFERENCES datasets(dataset_key)
);
CREATE INDEX ix_columns_dataset ON columns(dataset_key);

-- ---------- TRANSFORMATIONS (the "rules") ---------------------------
-- One row per target dataset; stores the SQL that produces it.
CREATE TABLE transformations (
    transform_id  VARCHAR2(520) NOT NULL,   -- = target dataset_key
    target_key    VARCHAR2(520) NOT NULL,
    transform_type VARCHAR2(30),            -- 'dbt_model'|'view'|'manual'
    dbt_model     VARCHAR2(256),
    compiled_sql  CLOB,                      -- the transformation rule
    raw_sql       CLOB,
    updated_at    TIMESTAMP DEFAULT SYSTIMESTAMP,
    CONSTRAINT pk_transform PRIMARY KEY (transform_id),
    CONSTRAINT fk_tf_target FOREIGN KEY (target_key) REFERENCES datasets(dataset_key)
);

-- ---------- TABLE-LEVEL LINEAGE -------------------------------------
CREATE TABLE table_lineage (
    edge_id       VARCHAR2(1050) NOT NULL,  -- from_key || '>' || to_key
    from_key      VARCHAR2(520) NOT NULL,
    to_key        VARCHAR2(520) NOT NULL,
    source        VARCHAR2(30),             -- 'dbt'|'sqlglot'|'manual'
    transform_id  VARCHAR2(520),
    CONSTRAINT pk_tlin PRIMARY KEY (edge_id),
    CONSTRAINT fk_tl_from FOREIGN KEY (from_key) REFERENCES datasets(dataset_key),
    CONSTRAINT fk_tl_to   FOREIGN KEY (to_key)   REFERENCES datasets(dataset_key)
);
CREATE INDEX ix_tlin_from ON table_lineage(from_key);
CREATE INDEX ix_tlin_to   ON table_lineage(to_key);

-- ---------- COLUMN-LEVEL LINEAGE ------------------------------------
CREATE TABLE column_lineage (
    edge_id       VARCHAR2(1320) NOT NULL,  -- from_col || '>' || to_col
    from_column   VARCHAR2(650) NOT NULL,
    to_column     VARCHAR2(650) NOT NULL,
    transform_expr CLOB,                     -- the per-column expression
    source        VARCHAR2(30),             -- 'sqlglot'|'manual'
    CONSTRAINT pk_clin PRIMARY KEY (edge_id),
    CONSTRAINT fk_cl_from FOREIGN KEY (from_column) REFERENCES columns(column_key),
    CONSTRAINT fk_cl_to   FOREIGN KEY (to_column)   REFERENCES columns(column_key)
);
CREATE INDEX ix_clin_from ON column_lineage(from_column);
CREATE INDEX ix_clin_to   ON column_lineage(to_column);

-- ---------- OPERATIONAL (Airflow run context, optional 360 panel) ---
CREATE TABLE dataset_runs (
    run_id        VARCHAR2(200) NOT NULL,
    dataset_key   VARCHAR2(520) NOT NULL,
    dag_id        VARCHAR2(250),
    task_id       VARCHAR2(250),
    status        VARCHAR2(20),
    run_ts        TIMESTAMP,
    CONSTRAINT pk_dsrun PRIMARY KEY (run_id),
    CONSTRAINT fk_run_ds FOREIGN KEY (dataset_key) REFERENCES datasets(dataset_key)
);
CREATE INDEX ix_dsrun_dataset ON dataset_runs(dataset_key);
