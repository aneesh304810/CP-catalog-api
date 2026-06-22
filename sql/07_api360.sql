-- =====================================================================
-- CP Metadata Catalog — API 360 schema
--
-- Self-contained tables for API exploration (Swagger + Postman). Kept
-- separate from the dataset/lineage tables so API 360 never touches the
-- existing catalog model. Idempotent: safe to re-run (MERGE upserts in the
-- loader; this DDL guards with checks).
-- =====================================================================

-- ---------- API SOURCES (one row per registered spec/collection) ------
CREATE TABLE api_sources (
    source_id      VARCHAR2(128) NOT NULL,    -- e.g. 'sei_swp'
    name           VARCHAR2(256),
    kind           VARCHAR2(30),              -- 'openapi' | 'swagger2' | 'postman'
    version        VARCHAR2(64),
    spec_path      VARCHAR2(1024),            -- webfs path the file was read from
    endpoint_count NUMBER DEFAULT 0,
    field_count    NUMBER DEFAULT 0,
    flow_count     NUMBER DEFAULT 0,
    ingested_at    TIMESTAMP DEFAULT SYSTIMESTAMP,
    CONSTRAINT pk_api_sources PRIMARY KEY (source_id)
);

-- ---------- API ENDPOINTS ---------------------------------------------
CREATE TABLE api_endpoints (
    endpoint_key   VARCHAR2(512) NOT NULL,    -- source_id + method + path
    source_id      VARCHAR2(128) NOT NULL,
    method         VARCHAR2(10),              -- GET | POST | PUT | DELETE | PATCH
    path           VARCHAR2(512),
    operation_id   VARCHAR2(256),
    summary        VARCHAR2(1024),
    ref_object     VARCHAR2(256),             -- primary $ref schema object
    owner          VARCHAR2(128),
    CONSTRAINT pk_api_endpoints PRIMARY KEY (endpoint_key),
    CONSTRAINT fk_ep_source FOREIGN KEY (source_id)
        REFERENCES api_sources(source_id)
);

-- ---------- API FIELDS (per endpoint, from the resolved schema) --------
CREATE TABLE api_fields (
    field_key      VARCHAR2(640) NOT NULL,    -- endpoint_key + field name
    endpoint_key   VARCHAR2(512) NOT NULL,
    source_id      VARCHAR2(128) NOT NULL,
    name           VARCHAR2(256),
    data_type      VARCHAR2(64),
    is_key         CHAR(1) DEFAULT 'N',       -- 'Y' if identifier/key-like
    nullable       CHAR(1) DEFAULT 'Y',
    description    VARCHAR2(2000),            -- from dictionary if joined
    ref_object     VARCHAR2(256),
    CONSTRAINT pk_api_fields PRIMARY KEY (field_key),
    CONSTRAINT fk_fld_ep FOREIGN KEY (endpoint_key)
        REFERENCES api_endpoints(endpoint_key)
);

-- ---------- API DEPENDENCY EDGES (endpoint -> endpoint) ----------------
CREATE TABLE api_dependencies (
    edge_id        VARCHAR2(1100) NOT NULL,   -- from_key + '>' + to_key
    source_id      VARCHAR2(128) NOT NULL,
    from_endpoint  VARCHAR2(512) NOT NULL,
    to_endpoint    VARCHAR2(512) NOT NULL,
    kind           VARCHAR2(20),              -- 'ref' (shared schema) | 'runtime'
    via            VARCHAR2(256),             -- shared $ref object or note
    CONSTRAINT pk_api_deps PRIMARY KEY (edge_id)
);

-- ---------- BUSINESS FLOWS (one row per Postman folder) ----------------
CREATE TABLE api_flows (
    flow_key       VARCHAR2(512) NOT NULL,    -- source_id + flow name
    source_id      VARCHAR2(128) NOT NULL,
    name           VARCHAR2(256),
    description    VARCHAR2(2000),
    owner          VARCHAR2(128),
    schedule       VARCHAR2(128),
    step_count     NUMBER DEFAULT 0,
    CONSTRAINT pk_api_flows PRIMARY KEY (flow_key)
);

-- ---------- FLOW STEPS (ordered API calls within a flow) ---------------
CREATE TABLE api_flow_steps (
    step_key       VARCHAR2(640) NOT NULL,    -- flow_key + step ordinal
    flow_key       VARCHAR2(512) NOT NULL,
    source_id      VARCHAR2(128) NOT NULL,
    step_no        NUMBER,
    method         VARCHAR2(10),
    path           VARCHAR2(512),
    endpoint_key   VARCHAR2(512),             -- resolved link to api_endpoints (may be null if stale)
    note           VARCHAR2(1024),
    input_vars     VARCHAR2(1024),            -- {{vars}} consumed
    output_vars    VARCHAR2(1024),            -- values captured for later steps
    CONSTRAINT pk_api_flow_steps PRIMARY KEY (step_key),
    CONSTRAINT fk_step_flow FOREIGN KEY (flow_key)
        REFERENCES api_flows(flow_key)
);

-- ---------- FLOW EDGES (step -> step, data passed between) -------------
CREATE TABLE api_flow_edges (
    edge_id        VARCHAR2(1300) NOT NULL,
    flow_key       VARCHAR2(512) NOT NULL,
    from_step      VARCHAR2(640) NOT NULL,
    to_step        VARCHAR2(640) NOT NULL,
    variable       VARCHAR2(256),             -- the {{variable}} passed
    CONSTRAINT pk_api_flow_edges PRIMARY KEY (edge_id)
);

-- ---------- helpful indexes -------------------------------------------
CREATE INDEX ix_api_ep_source   ON api_endpoints(source_id);
CREATE INDEX ix_api_fld_ep      ON api_fields(endpoint_key);
CREATE INDEX ix_api_deps_from   ON api_dependencies(from_endpoint);
CREATE INDEX ix_api_steps_flow  ON api_flow_steps(flow_key);
CREATE INDEX ix_api_steps_ep    ON api_flow_steps(endpoint_key);
