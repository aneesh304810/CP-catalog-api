"""
Routers for the Security / Governance / Versioning layers.
Mounted by main.py. Every mutating or sensitive endpoint goes through the PEP
(require(...)) which performs RBAC+ABAC and writes the audit record.
"""
from __future__ import annotations
import os
from fastapi import APIRouter, Depends, HTTPException, Body

from .db import query, get_pool
from .security.pep import get_principal, require
from .security.auth import Principal
from .security.sql_preview import run_preview, SqlPreviewError
from .security.audit import AuditLogger
from .governance.governance import (
    Classifier, Masker, ApprovalWorkflow, AccessGovernance)
from .versioning.versioner import Versioner

router = APIRouter()
_approval = ApprovalWorkflow()
_access = AccessGovernance()
_versioner = Versioner()


# ============================== VERSIONING =============================
@router.get("/datasets/{key}/versions")
def list_versions(key: str, principal: Principal = Depends(require("dataset:view"))):
    return {"versions": query("""
        SELECT version_no, change_type, created_by,
               TO_CHAR(created_at,'YYYY-MM-DD HH24:MI') AS created_at,
               classification_snapshot, source_run_id
        FROM dataset_versions WHERE dataset_key = :k
        ORDER BY created_at DESC""", {"k": key})}


@router.get("/datasets/{key}/diff/{v1}/{v2}")
def version_diff(key: str, v1: str, v2: str,
                 principal: Principal = Depends(require("dataset:view"))):
    rows = query("""
        SELECT from_version, to_version, added_columns, removed_columns,
               changed_columns, lineage_changes, policy_changes
        FROM dataset_diffs
        WHERE dataset_key = :k AND from_version = :v1 AND to_version = :v2""",
        {"k": key, "v1": v1, "v2": v2})
    if not rows:
        raise HTTPException(404, "diff not found; versions may be non-adjacent")
    return rows[0]


@router.post("/datasets/{key}/rollback/{version}")
def rollback(key: str, version: str, reason: str = Body(..., embed=True),
             principal: Principal = Depends(require("version:rollback"))):
    with get_pool().acquire() as conn:
        try:
            return _versioner.rollback(conn, key, version, principal.user_id, reason)
        except ValueError as e:
            raise HTTPException(404, str(e))


# ============================== GOVERNANCE ============================
@router.get("/governance/{key}")
def governance(key: str, principal: Principal = Depends(require("dataset:view"))):
    rows = query("SELECT * FROM dataset_governance WHERE dataset_key = :k", {"k": key})
    return rows[0] if rows else {}


@router.post("/governance/{key}/classify")
def classify(key: str, manual: str | None = Body(None, embed=True),
             principal: Principal = Depends(require("metadata:change"))):
    cols = query("""SELECT column_name, sensitivity FROM columns
                    WHERE dataset_key = :k""", {"k": key})
    cls, source = Classifier().classify_dataset(cols, manual)
    with get_pool().acquire() as conn:
        cur = conn.cursor()
        cur.execute("""
            MERGE INTO dataset_governance t
            USING (SELECT :k AS dataset_key FROM dual) s
            ON (t.dataset_key = s.dataset_key)
            WHEN MATCHED THEN UPDATE SET classification = :c,
                 classification_source = :src, updated_by = :by,
                 updated_at = SYSTIMESTAMP
            WHEN NOT MATCHED THEN INSERT (dataset_key, classification,
                 classification_source, updated_by)
                 VALUES (:k, :c, :src, :by)""",
            {"k": key, "c": cls, "src": source, "by": principal.user_id})
        conn.commit(); cur.close()
    return {"dataset_key": key, "classification": cls, "source": source}


@router.post("/governance/approval")
def submit_approval(request_type: str = Body(...), dataset_key: str = Body(...),
                    payload: str = Body("{}"),
                    principal: Principal = Depends(require("metadata:change"))):
    with get_pool().acquire() as conn:
        rid = _approval.submit(conn, request_type, dataset_key, payload,
                               principal.user_id)
    return {"request_id": rid, "state": "submitted"}


@router.post("/governance/approval/{rid}/decide")
def decide_approval(rid: str, new_state: str = Body(...),
                    note: str | None = Body(None),
                    principal: Principal = Depends(require("governance:approve"))):
    with get_pool().acquire() as conn:
        try:
            _approval.transition(conn, rid, new_state, principal.user_id, note)
        except ValueError as e:
            raise HTTPException(400, str(e))
    return {"request_id": rid, "state": new_state}


@router.post("/governance/access/request")
def request_access(dataset_key: str = Body(...), days: int | None = Body(None),
                   principal: Principal = Depends(get_principal)):
    with get_pool().acquire() as conn:
        gid = _access.request(conn, principal.user_id, dataset_key, "read", days)
    return {"grant_id": gid, "state": "requested"}


@router.post("/governance/access/{gid}/approve")
def approve_access(gid: str, principal: Principal = Depends(require("governance:approve"))):
    with get_pool().acquire() as conn:
        _access.approve(conn, gid, principal.user_id)
    return {"grant_id": gid, "state": "active"}


# ============================== SQL PREVIEW ===========================
@router.post("/datasets/{key}/sql-preview")
def sql_preview(key: str, sql: str = Body(..., embed=True),
                principal: Principal = Depends(require("dataset:view_sql"))):
    """Read-only SELECT preview with masking applied for non-privileged roles."""
    # resolve the source platform + a READ-ONLY connection (see deploy)
    plat = query("SELECT platform_id FROM datasets WHERE dataset_key = :k", {"k": key})
    dialect = "oracle"
    if plat:
        d = query("SELECT sqlglot_dialect FROM platforms WHERE platform_id = :p",
                  {"p": plat[0]["platform_id"]})
        dialect = d[0]["sqlglot_dialect"] if d else "oracle"
    row_limit = int(os.getenv("SQL_PREVIEW_ROW_LIMIT", "100"))
    timeout_s = int(os.getenv("SQL_PREVIEW_TIMEOUT_S", "10"))
    try:
        # NOTE: open a dedicated READ-ONLY connection here in production
        # (env SQL_PREVIEW_DSN/USER as a read-only DB principal). For brevity we
        # reuse the catalog pool, which must point at a RO user for preview.
        with get_pool().acquire() as conn:
            result = run_preview(conn, sql, dialect, row_limit, timeout_s)
    except SqlPreviewError as e:
        raise HTTPException(400, str(e))

    # apply role-based masking to the result set
    masks = query("""SELECT column_name, mask_type, pattern, unmasked_roles
                     FROM column_masking WHERE dataset_key = :k""", {"k": key})
    if masks:
        masker = Masker()
        mask_by_col = {m["column_name"]: m for m in masks}
        cols = result["columns"]
        for r in result["rows"]:
            for i, cname in enumerate(cols):
                m = mask_by_col.get(cname)
                if m:
                    unmasked = set((m["unmasked_roles"] or "").split(","))
                    r[i] = masker.mask_value(r[i], m["mask_type"], m["pattern"],
                                             principal.role, unmasked)
    return result


# ============================== AUDIT =================================
@router.get("/audit")
def audit(action: str | None = None, limit: int = 100,
          principal: Principal = Depends(require("policy:change"))):
    where = "1=1"
    params = {"lim": limit}
    if action:
        where = "action = :a"; params["a"] = action
    return {"records": query(f"""
        SELECT user_id, user_role, action, resource, outcome,
               TO_CHAR(event_ts,'YYYY-MM-DD HH24:MI:SS') AS event_ts
        FROM audit_log WHERE {where}
        ORDER BY event_ts DESC FETCH FIRST :lim ROWS ONLY""", params)}


@router.get("/audit/verify")
def audit_verify(principal: Principal = Depends(require("policy:change"))):
    with get_pool().acquire() as conn:
        return AuditLogger(conn).verify_chain()
