-- =====================================================================
-- CP Metadata Catalog - Security / Governance / Versioning (v5)
-- Adapted to Oracle (METACAT schema). Run AFTER 03_*.sql as METACAT.
-- =====================================================================

-- =====================================================================
-- SECURITY LAYER
-- =====================================================================

-- ---------- audit log (append-only; immutability enforced by trigger) ----
CREATE TABLE audit_log (
    audit_id      VARCHAR2(64)  NOT NULL,    -- sha256(payload) for tamper-evidence
    prev_hash     VARCHAR2(64),              -- hash chain -> immutability evidence
    user_id       VARCHAR2(256),
    user_role     VARCHAR2(40),
    action        VARCHAR2(60),              -- login|search|dataset_access|lineage_access|
                                             -- sql_preview|metadata_change|ingestion|policy_change
    resource      VARCHAR2(520),
    outcome       VARCHAR2(20),              -- allow|deny|success|failure
    detail        CLOB,                      -- JSON context (PDP reason, query, etc.)
    event_ts      TIMESTAMP DEFAULT SYSTIMESTAMP,
    CONSTRAINT pk_audit PRIMARY KEY (audit_id)
);
CREATE INDEX ix_audit_user ON audit_log(user_id);
CREATE INDEX ix_audit_action ON audit_log(action);
CREATE INDEX ix_audit_ts ON audit_log(event_ts);

-- block UPDATE/DELETE on audit_log (immutability)
CREATE OR REPLACE TRIGGER trg_audit_immutable
BEFORE UPDATE OR DELETE ON audit_log
BEGIN
    RAISE_APPLICATION_ERROR(-20001, 'audit_log is append-only');
END;
/

-- ---------- ABAC policies (data-driven PDP rules) ------------------------
CREATE TABLE abac_policies (
    policy_id     VARCHAR2(64) NOT NULL,
    name          VARCHAR2(200),
    effect        VARCHAR2(10),              -- permit | deny
    action        VARCHAR2(60),              -- e.g. dataset:view_sql, ingestion:trigger
    condition_expr CLOB,                      -- JSON condition (see PDP)
    priority      NUMBER DEFAULT 100,        -- lower evaluated first; deny wins
    enabled       CHAR(1) DEFAULT 'Y',
    version       NUMBER DEFAULT 1,
    updated_by    VARCHAR2(256),
    updated_at    TIMESTAMP DEFAULT SYSTIMESTAMP,
    CONSTRAINT pk_abac PRIMARY KEY (policy_id)
);

-- ---------- principal attributes (clearance, domain) for ABAC -----------
CREATE TABLE principal_attributes (
    user_id       VARCHAR2(256) NOT NULL,
    domain        VARCHAR2(120),
    clearance     NUMBER,                    -- 1=Public..4=Restricted
    service_account CHAR(1) DEFAULT 'N',
    updated_at    TIMESTAMP DEFAULT SYSTIMESTAMP,
    CONSTRAINT pk_principal PRIMARY KEY (user_id)
);

-- =====================================================================
-- GOVERNANCE LAYER
-- =====================================================================

-- classification + ownership + lifecycle live on a governance overlay so
-- they version independently of the harvested technical metadata.
CREATE TABLE dataset_governance (
    dataset_key   VARCHAR2(520) NOT NULL,
    classification VARCHAR2(20),             -- public|internal|confidential|restricted
    classification_source VARCHAR2(20),      -- auto|manual
    certification VARCHAR2(10),              -- gold|silver|bronze
    lifecycle_state VARCHAR2(20),            -- draft|active|certified|deprecated|archived
    technical_owner VARCHAR2(256),
    business_steward VARCHAR2(256),
    domain        VARCHAR2(120),
    updated_by    VARCHAR2(256),
    updated_at    TIMESTAMP DEFAULT SYSTIMESTAMP,
    CONSTRAINT pk_ds_gov PRIMARY KEY (dataset_key),
    CONSTRAINT fk_gov_ds FOREIGN KEY (dataset_key) REFERENCES datasets(dataset_key)
);

-- column masking policy (role-based dynamic masking)
CREATE TABLE column_masking (
    masking_id    VARCHAR2(64) NOT NULL,
    dataset_key   VARCHAR2(520) NOT NULL,
    column_name   VARCHAR2(128) NOT NULL,
    mask_type     VARCHAR2(30),              -- partial|hash|redact|none
    unmasked_roles VARCHAR2(400),            -- comma roles that see full value
    pattern       VARCHAR2(120),             -- e.g. 'XXXX-XX-{last4}'
    CONSTRAINT pk_masking PRIMARY KEY (masking_id)
);
CREATE INDEX ix_masking_ds ON column_masking(dataset_key);

-- approval workflow (submit -> review -> approve/reject)
CREATE TABLE approval_requests (
    request_id    VARCHAR2(64) NOT NULL,
    request_type  VARCHAR2(40),              -- certification|classification|access|lifecycle
    dataset_key   VARCHAR2(520),
    payload       CLOB,                      -- JSON of proposed change
    state         VARCHAR2(20),              -- submitted|in_review|approved|rejected
    requested_by  VARCHAR2(256),
    reviewer      VARCHAR2(256),
    decision_note VARCHAR2(2000),
    created_at    TIMESTAMP DEFAULT SYSTIMESTAMP,
    decided_at    TIMESTAMP,
    CONSTRAINT pk_approval PRIMARY KEY (request_id)
);
CREATE INDEX ix_approval_state ON approval_requests(state);

-- access governance (request, temporary grants, recertification)
CREATE TABLE access_grants (
    grant_id      VARCHAR2(64) NOT NULL,
    user_id       VARCHAR2(256),
    dataset_key   VARCHAR2(520),
    access_level  VARCHAR2(20),              -- read|preview
    state         VARCHAR2(20),              -- requested|active|expired|revoked
    granted_by    VARCHAR2(256),
    expires_at    TIMESTAMP,                 -- null = permanent; set for temporary
    recertify_due TIMESTAMP,
    created_at    TIMESTAMP DEFAULT SYSTIMESTAMP,
    CONSTRAINT pk_access PRIMARY KEY (grant_id)
);
CREATE INDEX ix_access_user ON access_grants(user_id);
CREATE INDEX ix_access_ds ON access_grants(dataset_key);

-- =====================================================================
-- VERSIONING LAYER (immutable)
-- =====================================================================

CREATE TABLE dataset_versions (
    version_id    VARCHAR2(64) NOT NULL,
    dataset_key   VARCHAR2(520) NOT NULL,
    version_no    VARCHAR2(20),              -- semver e.g. 2.1.0
    change_type   VARCHAR2(10),              -- major|minor|patch
    created_by    VARCHAR2(256),
    created_at    TIMESTAMP DEFAULT SYSTIMESTAMP,
    schema_snapshot CLOB,                    -- JSON column list + types
    lineage_snapshot CLOB,                   -- JSON upstream/downstream keys
    classification_snapshot VARCHAR2(20),
    ownership_snapshot CLOB,                 -- JSON owner/steward/domain
    source_run_id VARCHAR2(120),             -- dbt invocation that produced it
    CONSTRAINT pk_dsver PRIMARY KEY (version_id),
    CONSTRAINT fk_ver_ds FOREIGN KEY (dataset_key) REFERENCES datasets(dataset_key)
);
CREATE INDEX ix_dsver_key ON dataset_versions(dataset_key);

-- immutability: versions are append-only
CREATE OR REPLACE TRIGGER trg_version_immutable
BEFORE UPDATE OR DELETE ON dataset_versions
BEGIN
    RAISE_APPLICATION_ERROR(-20002, 'dataset_versions is immutable');
END;
/

CREATE TABLE dataset_diffs (
    diff_id       VARCHAR2(64) NOT NULL,
    dataset_key   VARCHAR2(520) NOT NULL,
    from_version  VARCHAR2(20),
    to_version    VARCHAR2(20),
    added_columns CLOB,                      -- JSON
    removed_columns CLOB,
    changed_columns CLOB,
    lineage_changes CLOB,
    policy_changes CLOB,
    created_at    TIMESTAMP DEFAULT SYSTIMESTAMP,
    CONSTRAINT pk_dsdiff PRIMARY KEY (diff_id)
);
CREATE INDEX ix_dsdiff_key ON dataset_diffs(dataset_key);

-- rollback audit (who rolled back to which version, and why)
CREATE TABLE rollback_log (
    rollback_id   VARCHAR2(64) NOT NULL,
    dataset_key   VARCHAR2(520) NOT NULL,
    to_version    VARCHAR2(20),
    performed_by  VARCHAR2(256),
    reason        VARCHAR2(2000),
    performed_at  TIMESTAMP DEFAULT SYSTIMESTAMP,
    CONSTRAINT pk_rollback PRIMARY KEY (rollback_id)
);
