-- =====================================================================
-- CP Metadata Catalog - Oracle Text full-text search (v6)
-- ADDITIVE: adds CONTEXT indexes over datasets (name+desc+tags) and over
-- columns (column name + description). No existing object is altered.
-- Oracle Text is included in SE2/EE at no extra license.
--
-- Prereqs (DBA, one-time):
--   SELECT comp_name, status FROM dba_registry WHERE comp_name LIKE '%Text%'; -- expect VALID
--   GRANT CTXAPP TO metacat;
--
-- Run AFTER 01-05 scripts, connected as METACAT.
-- =====================================================================

-- ---------- multi-column datastore for DATASETS ----------------------
-- Combines object_name + descriptions + tags into one virtual document so a
-- single CONTAINS() searches across all of them.
BEGIN
  CTX_DDL.CREATE_PREFERENCE('cp_ds_datastore', 'MULTI_COLUMN_DATASTORE');
  CTX_DDL.SET_ATTRIBUTE('cp_ds_datastore', 'COLUMNS',
    'object_name, schema_name, NVL(business_desc, tech_desc), tags, owner');
EXCEPTION WHEN OTHERS THEN
  IF SQLCODE != -20000 THEN RAISE; END IF;  -- ignore "already exists"
END;
/

-- a lightweight lexer: case-insensitive, alnum tokens
BEGIN
  CTX_DDL.CREATE_PREFERENCE('cp_lexer', 'BASIC_LEXER');
  CTX_DDL.SET_ATTRIBUTE('cp_lexer', 'MIXED_CASE', 'NO');
EXCEPTION WHEN OTHERS THEN
  IF SQLCODE != -20000 THEN RAISE; END IF;
END;
/

-- The CONTEXT index needs a column to "hang" on; object_name is the anchor but
-- the datastore pulls the other columns in. SYNC ON COMMIT keeps it fresh after
-- each ingestion commit; the ingestion job also calls SYNC explicitly.
CREATE INDEX ix_ds_text ON datasets(object_name)
  INDEXTYPE IS CTXSYS.CONTEXT
  PARAMETERS ('DATASTORE cp_ds_datastore LEXER cp_lexer SYNC (ON COMMIT)');

-- ---------- multi-column datastore for COLUMNS -----------------------
BEGIN
  CTX_DDL.CREATE_PREFERENCE('cp_col_datastore', 'MULTI_COLUMN_DATASTORE');
  CTX_DDL.SET_ATTRIBUTE('cp_col_datastore', 'COLUMNS',
    'column_name, NVL(business_desc, tech_desc), sensitivity');
EXCEPTION WHEN OTHERS THEN
  IF SQLCODE != -20000 THEN RAISE; END IF;
END;
/

CREATE INDEX ix_col_text ON columns(column_name)
  INDEXTYPE IS CTXSYS.CONTEXT
  PARAMETERS ('DATASTORE cp_col_datastore LEXER cp_lexer SYNC (ON COMMIT)');

-- ---------- manual sync helper (called by ingestion after a load) ----
-- SYNC (ON COMMIT) handles most cases; this is belt-and-suspenders for large
-- batch loads where you want one sync at the end.
-- EXEC CTX_DDL.SYNC_INDEX('IX_DS_TEXT');
-- EXEC CTX_DDL.SYNC_INDEX('IX_COL_TEXT');

-- ---------- optimize (run periodically, e.g. weekly, to defragment) --
-- EXEC CTX_DDL.OPTIMIZE_INDEX('IX_DS_TEXT', 'FULL');
-- EXEC CTX_DDL.OPTIMIZE_INDEX('IX_COL_TEXT', 'FULL');
