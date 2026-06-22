"""
Dataset versioning layer (immutable).

Builds a new DatasetVersion from a fresh dbt harvest by diffing the incoming
schema/lineage/ownership against the latest stored version, then bumping semver
per the rules:

  PATCH : description / owner / tag change only
  MINOR : column added, or new test added
  MAJOR : column removed, datatype changed, breaking schema change

Each version stores immutable snapshots (schema, lineage, classification,
ownership). The diff engine produces added/removed/changed columns, lineage
changes, and policy changes. Rollback writes the chosen historical snapshot
back onto the live governance/overlay rows and audits the action (it does NOT
mutate prior versions - those are immutable).
"""
from __future__ import annotations
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional


@dataclass
class SchemaSnapshot:
    columns: list[dict]            # [{name, data_type, is_pk}]
    tests: list[str] = field(default_factory=list)


def _now():
    return datetime.now(timezone.utc).isoformat()


class DiffEngine:
    def diff_schema(self, old: dict, new: dict) -> dict:
        old_cols = {c["name"]: c for c in old.get("columns", [])}
        new_cols = {c["name"]: c for c in new.get("columns", [])}
        added = [c for n, c in new_cols.items() if n not in old_cols]
        removed = [c for n, c in old_cols.items() if n not in new_cols]
        changed = []
        for n in set(old_cols) & set(new_cols):
            if (old_cols[n].get("data_type") != new_cols[n].get("data_type")):
                changed.append({"name": n,
                                "from": old_cols[n].get("data_type"),
                                "to": new_cols[n].get("data_type")})
        old_tests = set(old.get("tests", []))
        new_tests = set(new.get("tests", []))
        return {
            "added_columns": added,
            "removed_columns": removed,
            "changed_columns": changed,
            "added_tests": sorted(new_tests - old_tests),
            "removed_tests": sorted(old_tests - new_tests),
        }

    def diff_lineage(self, old: dict, new: dict) -> dict:
        o_up, n_up = set(old.get("upstream", [])), set(new.get("upstream", []))
        o_dn, n_dn = set(old.get("downstream", [])), set(new.get("downstream", []))
        return {
            "upstream_added": sorted(n_up - o_up),
            "upstream_removed": sorted(o_up - n_up),
            "downstream_added": sorted(n_dn - o_dn),
            "downstream_removed": sorted(o_dn - n_dn),
        }

    def diff_policy(self, old: dict, new: dict) -> dict:
        changes = {}
        for field_ in ("classification", "certification", "lifecycle_state",
                       "technical_owner", "business_steward", "domain"):
            if old.get(field_) != new.get(field_):
                changes[field_] = {"from": old.get(field_), "to": new.get(field_)}
        return changes


class Versioner:
    def __init__(self, diff_engine: DiffEngine | None = None):
        self.diff = diff_engine or DiffEngine()

    # ---- semver decision ----------------------------------------------
    def decide_bump(self, schema_diff: dict, policy_diff: dict) -> str:
        if (schema_diff["removed_columns"] or schema_diff["changed_columns"]):
            return "major"
        if (schema_diff["added_columns"] or schema_diff["added_tests"]):
            return "minor"
        # everything else (desc/owner/tag/classification/cert/lifecycle) = patch
        if (policy_diff or schema_diff["removed_tests"]):
            return "patch"
        return "patch"

    def next_version(self, current: str | None, bump: str) -> str:
        if not current:
            return "1.0.0"
        major, minor, patch = (int(x) for x in current.split("."))
        if bump == "major":
            return f"{major + 1}.0.0"
        if bump == "minor":
            return f"{major}.{minor + 1}.0"
        return f"{major}.{minor}.{patch + 1}"

    # ---- create a version (immutable) ---------------------------------
    def create_version(self, conn, dataset_key: str,
                       new_schema: dict, new_lineage: dict,
                       new_policy: dict, created_by: str,
                       source_run_id: str | None = None) -> Optional[dict]:
        """
        Compare against the latest version; if anything changed, write a new
        immutable version + diff and return it. If nothing changed, return None.
        """
        latest = self._latest(conn, dataset_key)
        old_schema = json.loads(latest["schema_snapshot"]) if latest else {"columns": [], "tests": []}
        old_lineage = json.loads(latest["lineage_snapshot"]) if latest else {"upstream": [], "downstream": []}
        old_policy = json.loads(latest["ownership_snapshot"]) if latest else {}
        if latest:
            old_policy = {**old_policy,
                          "classification": latest.get("classification_snapshot")}

        sdiff = self.diff.diff_schema(old_schema, new_schema)
        ldiff = self.diff.diff_lineage(old_lineage, new_lineage)
        pdiff = self.diff.diff_policy(old_policy, new_policy)

        changed = any([sdiff["added_columns"], sdiff["removed_columns"],
                       sdiff["changed_columns"], sdiff["added_tests"],
                       sdiff["removed_tests"],
                       any(ldiff.values()), bool(pdiff)])
        if not changed and latest:
            return None

        bump = self.decide_bump(sdiff, pdiff)
        new_no = self.next_version(latest["version_no"] if latest else None, bump)
        vid = uuid.uuid4().hex
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO dataset_versions
              (version_id, dataset_key, version_no, change_type, created_by,
               created_at, schema_snapshot, lineage_snapshot,
               classification_snapshot, ownership_snapshot, source_run_id)
            VALUES (:id, :k, :v, :ct, :by, SYSTIMESTAMP, :ss, :ls, :cs, :os, :run)""",
            {"id": vid, "k": dataset_key, "v": new_no, "ct": bump, "by": created_by,
             "ss": json.dumps(new_schema), "ls": json.dumps(new_lineage),
             "cs": new_policy.get("classification"),
             "os": json.dumps({k: new_policy.get(k) for k in
                               ("technical_owner", "business_steward", "domain",
                                "certification", "lifecycle_state")}),
             "run": source_run_id})
        # store the diff
        did = uuid.uuid4().hex
        cur.execute("""
            INSERT INTO dataset_diffs
              (diff_id, dataset_key, from_version, to_version, added_columns,
               removed_columns, changed_columns, lineage_changes, policy_changes,
               created_at)
            VALUES (:id, :k, :fv, :tv, :ac, :rc, :cc, :lc, :pc, SYSTIMESTAMP)""",
            {"id": did, "k": dataset_key,
             "fv": latest["version_no"] if latest else None, "tv": new_no,
             "ac": json.dumps(sdiff["added_columns"]),
             "rc": json.dumps(sdiff["removed_columns"]),
             "cc": json.dumps(sdiff["changed_columns"]),
             "lc": json.dumps(ldiff), "pc": json.dumps(pdiff)})
        conn.commit(); cur.close()
        return {"version_id": vid, "version_no": new_no, "change_type": bump,
                "schema_diff": sdiff, "lineage_diff": ldiff, "policy_diff": pdiff}

    # ---- rollback (audited; prior versions stay immutable) ------------
    def rollback(self, conn, dataset_key: str, to_version: str,
                 performed_by: str, reason: str) -> dict:
        cur = conn.cursor()
        cur.execute("""
            SELECT schema_snapshot, classification_snapshot, ownership_snapshot
            FROM dataset_versions
            WHERE dataset_key = :k AND version_no = :v""",
            {"k": dataset_key, "v": to_version})
        row = cur.fetchone()
        if not row:
            raise ValueError("target version not found")
        own = json.loads(row[2].read() if hasattr(row[2], "read") else row[2] or "{}")
        # re-apply governance snapshot onto the live overlay
        cur.execute("""
            UPDATE dataset_governance
            SET classification = :cls, certification = :cert,
                lifecycle_state = :ls, technical_owner = :to,
                business_steward = :bs, domain = :dom, updated_by = :by,
                updated_at = SYSTIMESTAMP
            WHERE dataset_key = :k""",
            {"cls": row[1], "cert": own.get("certification"),
             "ls": own.get("lifecycle_state"), "to": own.get("technical_owner"),
             "bs": own.get("business_steward"), "dom": own.get("domain"),
             "by": performed_by, "k": dataset_key})
        # audit the rollback
        rbid = uuid.uuid4().hex
        cur.execute("""
            INSERT INTO rollback_log
              (rollback_id, dataset_key, to_version, performed_by, reason,
               performed_at)
            VALUES (:id, :k, :v, :by, :r, SYSTIMESTAMP)""",
            {"id": rbid, "k": dataset_key, "v": to_version,
             "by": performed_by, "r": reason})
        conn.commit(); cur.close()
        return {"rolled_back_to": to_version, "rollback_id": rbid}

    # ---- helpers -------------------------------------------------------
    def _latest(self, conn, dataset_key: str) -> Optional[dict]:
        cur = conn.cursor()
        cur.execute("""
            SELECT version_no, schema_snapshot, lineage_snapshot,
                   classification_snapshot, ownership_snapshot
            FROM dataset_versions WHERE dataset_key = :k
            ORDER BY created_at DESC FETCH FIRST 1 ROW ONLY""", {"k": dataset_key})
        row = cur.fetchone()
        cur.close()
        if not row:
            return None
        def rd(v): return v.read() if hasattr(v, "read") else v
        return {"version_no": row[0], "schema_snapshot": rd(row[1]),
                "lineage_snapshot": rd(row[2]),
                "classification_snapshot": row[3],
                "ownership_snapshot": rd(row[4])}
