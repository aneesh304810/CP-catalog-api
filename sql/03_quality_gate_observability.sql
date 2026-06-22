-- =====================================================================
-- CP Metadata Catalog - schema additions (v4)
-- Runtime gate (observe-only), observability, and data quality.
-- Run AFTER 02_schema_additions.sql, connected as METACAT.
-- =====================================================================

-- ---------- DATA QUALITY RESULTS (from dbt run_results.json) ---------
CREATE TABLE quality_results (
    result_id     VARCHAR2(64)  NOT NULL,    -- sha1(dataset|test|run_ts)
    dataset_key   VARCHAR2(520) NOT NULL,
    column_name   VARCHAR2(128),             -- null = table-level test
    test_name     VARCHAR2(256),
    dimension     VARCHAR2(30),              -- completeness|uniqueness|consistency|
                                             -- validity|freshness
    status        VARCHAR2(20),              -- pass|warn|fail|error|skipped
    observed_value NUMBER,                   -- failing row count if available
    threshold     NUMBER,
    message       VARCHAR2(2000),
    run_id        VARCHAR2(120),
    run_ts        VARCHAR2(40),
    CONSTRAINT pk_quality PRIMARY KEY (result_id),
    CONSTRAINT fk_q_dataset FOREIGN KEY (dataset_key) REFERENCES datasets(dataset_key)
);
CREATE INDEX ix_quality_dataset ON quality_results(dataset_key);
CREATE INDEX ix_quality_runts   ON quality_results(run_ts);

-- ---------- GATE EVALUATIONS (observe-only verdicts) ----------------
CREATE TABLE gate_evaluations (
    gate_eval_id  VARCHAR2(64)  NOT NULL,    -- sha1(scope_key|gate_name|run_ts)
    gate_name     VARCHAR2(160),             -- e.g. 'model:slv_positions'
    scope_type    VARCHAR2(30),              -- 'dataset' | 'layer_boundary'
    scope_key     VARCHAR2(520),             -- dataset/model the gate guards
    verdict       VARCHAR2(20),              -- pass|warn|fail
    rules_total   NUMBER,
    rules_passed  NUMBER,
    rules_failed  NUMBER,
    blocking      CHAR(1) DEFAULT 'N',       -- recorded; NOT enforced in v1
    detail        CLOB,                      -- JSON of rule outcomes
    run_id        VARCHAR2(120),
    run_ts        VARCHAR2(40),
    CONSTRAINT pk_gate PRIMARY KEY (gate_eval_id)
);
CREATE INDEX ix_gate_scope ON gate_evaluations(scope_key);
CREATE INDEX ix_gate_runts  ON gate_evaluations(run_ts);

-- ---------- FRESHNESS / VOLUME SNAPSHOTS ----------------------------
CREATE TABLE freshness_snapshots (
    snapshot_id   VARCHAR2(64)  NOT NULL,    -- sha1(dataset_key|captured_ts)
    dataset_key   VARCHAR2(520) NOT NULL,
    row_count     NUMBER,
    max_loaded_at VARCHAR2(40),              -- newest record timestamp (ISO)
    lag_minutes   NUMBER,                    -- now - max_loaded_at
    status        VARCHAR2(20),              -- fresh|stale|error
    sla_minutes   NUMBER,                    -- target freshness SLA (optional)
    captured_ts   VARCHAR2(40),
    CONSTRAINT pk_freshness PRIMARY KEY (snapshot_id),
    CONSTRAINT fk_f_dataset FOREIGN KEY (dataset_key) REFERENCES datasets(dataset_key)
);
CREATE INDEX ix_fresh_dataset ON freshness_snapshots(dataset_key);
CREATE INDEX ix_fresh_capts   ON freshness_snapshots(captured_ts);

-- ---------- current data-health per dataset (latest of each) --------
CREATE OR REPLACE VIEW v_dataset_health AS
SELECT d.dataset_key,
       d.platform_id,
       d.object_name,
       d.layer,
       (SELECT ge.verdict FROM gate_evaluations ge
        WHERE ge.scope_key = d.dataset_key
        ORDER BY ge.run_ts DESC FETCH FIRST 1 ROW ONLY) AS gate_verdict,
       (SELECT fs.lag_minutes FROM freshness_snapshots fs
        WHERE fs.dataset_key = d.dataset_key
        ORDER BY fs.captured_ts DESC FETCH FIRST 1 ROW ONLY) AS lag_minutes,
       (SELECT fs.status FROM freshness_snapshots fs
        WHERE fs.dataset_key = d.dataset_key
        ORDER BY fs.captured_ts DESC FETCH FIRST 1 ROW ONLY) AS freshness_status,
       (SELECT fs.row_count FROM freshness_snapshots fs
        WHERE fs.dataset_key = d.dataset_key
        ORDER BY fs.captured_ts DESC FETCH FIRST 1 ROW ONLY) AS row_count,
       (SELECT COUNT(*) FROM quality_results q
        WHERE q.dataset_key = d.dataset_key AND q.status = 'pass') AS tests_pass,
       (SELECT COUNT(*) FROM quality_results q
        WHERE q.dataset_key = d.dataset_key AND q.status IN ('fail','error')) AS tests_fail
FROM datasets d;

-- ---------- DQ score per dataset (simple completeness of passing) ---
CREATE OR REPLACE VIEW v_quality_scorecard AS
SELECT dataset_key,
       dimension,
       COUNT(*)                                            AS tests_total,
       SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END)    AS tests_pass,
       ROUND(100 * SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END)
             / NULLIF(COUNT(*), 0), 1)                     AS pass_pct
FROM (
    -- latest result per (dataset,test)
    SELECT q.*,
           ROW_NUMBER() OVER (PARTITION BY dataset_key, test_name
                              ORDER BY run_ts DESC) AS rn
    FROM quality_results q
)
WHERE rn = 1
GROUP BY dataset_key, dimension;
