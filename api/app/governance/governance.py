"""
Governance layer.

- Classifier: auto-derives Public/Internal/Confidential/Restricted from column
  sensitivity (Excel overlay) + name heuristics; manual override wins.
- Masker: role-based dynamic masking applied at read time in the API.
- Workflow helpers: approval state machine and access-grant lifecycle.

Classification ranks: public=1, internal=2, confidential=3, restricted=4.
"""
from __future__ import annotations
import hashlib
import re
import uuid
from datetime import datetime, timedelta, timezone

CLASSIFICATION_RANK = {"public": 1, "internal": 2, "confidential": 3, "restricted": 4}

# sensitivity -> classification floor
_SENS_TO_CLASS = {
    "PII": "confidential",
    "CONFIDENTIAL": "confidential",
    "RESTRICTED": "restricted",
    "INTERNAL": "internal",
    "PUBLIC": "public",
}

# column-name heuristics that imply restricted/confidential
_NAME_PATTERNS = [
    (re.compile(r"\b(ssn|tax_id|passport|national_id)\b", re.I), "restricted"),
    (re.compile(r"\b(account|iban|card|cvv|routing)\b", re.I), "confidential"),
    (re.compile(r"\b(email|phone|address|dob|birth)\b", re.I), "confidential"),
    (re.compile(r"\b(salary|comp|pnl|position)\b", re.I), "confidential"),
]


class Classifier:
    def classify_dataset(self, columns: list[dict],
                         manual: str | None = None) -> tuple[str, str]:
        """Return (classification, source). manual override wins."""
        if manual:
            return manual.lower(), "manual"
        best = "public"
        for c in columns:
            sens = (c.get("sensitivity") or "").upper()
            if sens in _SENS_TO_CLASS:
                best = self._max(best, _SENS_TO_CLASS[sens])
            name = c.get("column_name") or c.get("name") or ""
            for pat, cls in _NAME_PATTERNS:
                if pat.search(name):
                    best = self._max(best, cls)
        return best, "auto"

    @staticmethod
    def _max(a: str, b: str) -> str:
        return a if CLASSIFICATION_RANK[a] >= CLASSIFICATION_RANK[b] else b


class Masker:
    """Role-based dynamic masking applied to result values at read time."""

    def mask_value(self, value, mask_type: str, pattern: str | None,
                   role: str, unmasked_roles: set[str]) -> str:
        if value is None:
            return value
        if role in unmasked_roles:
            return value
        s = str(value)
        if mask_type == "none":
            return s
        if mask_type == "redact":
            return "••••••"
        if mask_type == "hash":
            return "sha256:" + hashlib.sha256(s.encode()).hexdigest()[:12]
        if mask_type == "partial":
            # pattern 'XXXX-XX-{last4}' -> keep last 4
            last4 = s[-4:] if len(s) >= 4 else s
            if pattern and "{last4}" in pattern:
                return pattern.replace("{last4}", last4)
            return ("X" * max(0, len(s) - 4)) + last4
        return "••••••"


class ApprovalWorkflow:
    """submit -> review -> approve/reject state machine."""
    TRANSITIONS = {
        "submitted": {"in_review", "rejected"},
        "in_review": {"approved", "rejected"},
        "approved": set(),
        "rejected": set(),
    }

    def submit(self, conn, request_type, dataset_key, payload, requested_by) -> str:
        rid = uuid.uuid4().hex
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO approval_requests
              (request_id, request_type, dataset_key, payload, state,
               requested_by, created_at)
            VALUES (:id, :t, :k, :p, 'submitted', :u, SYSTIMESTAMP)""",
            {"id": rid, "t": request_type, "k": dataset_key,
             "p": payload, "u": requested_by})
        conn.commit(); cur.close()
        return rid

    def transition(self, conn, request_id, new_state, reviewer, note=None):
        cur = conn.cursor()
        cur.execute("SELECT state FROM approval_requests WHERE request_id = :id",
                    {"id": request_id})
        row = cur.fetchone()
        if not row:
            raise ValueError("request not found")
        cur_state = row[0]
        if new_state not in self.TRANSITIONS.get(cur_state, set()):
            raise ValueError(f"illegal transition {cur_state} -> {new_state}")
        cur.execute("""
            UPDATE approval_requests
            SET state = :s, reviewer = :rv, decision_note = :n,
                decided_at = CASE WHEN :s IN ('approved','rejected')
                                  THEN SYSTIMESTAMP ELSE decided_at END
            WHERE request_id = :id""",
            {"s": new_state, "rv": reviewer, "n": note, "id": request_id})
        conn.commit(); cur.close()


class AccessGovernance:
    def request(self, conn, user_id, dataset_key, access_level="read",
                days: int | None = None) -> str:
        gid = uuid.uuid4().hex
        expires = (datetime.now(timezone.utc) + timedelta(days=days)) if days else None
        recert = datetime.now(timezone.utc) + timedelta(days=90)
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO access_grants
              (grant_id, user_id, dataset_key, access_level, state,
               expires_at, recertify_due, created_at)
            VALUES (:id, :u, :k, :lvl, 'requested', :exp, :rc, SYSTIMESTAMP)""",
            {"id": gid, "u": user_id, "k": dataset_key, "lvl": access_level,
             "exp": expires, "rc": recert})
        conn.commit(); cur.close()
        return gid

    def approve(self, conn, grant_id, granted_by):
        cur = conn.cursor()
        cur.execute("""
            UPDATE access_grants SET state = 'active', granted_by = :g
            WHERE grant_id = :id AND state = 'requested'""",
            {"g": granted_by, "id": grant_id})
        conn.commit(); cur.close()

    def expire_due(self, conn) -> int:
        """Sweep: mark grants past expiry as expired. Run from a scheduled task."""
        cur = conn.cursor()
        cur.execute("""
            UPDATE access_grants SET state = 'expired'
            WHERE state = 'active' AND expires_at IS NOT NULL
              AND expires_at < SYSTIMESTAMP""")
        n = cur.rowcount
        conn.commit(); cur.close()
        return n
