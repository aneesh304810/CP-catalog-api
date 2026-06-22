"""
Policy Decision Point (PDP).

Evaluates an access request (principal, action, resource-attributes) against:
  1. RBAC baseline (role rank vs action's minimum role)
  2. ABAC policies (data-driven rules from abac_policies), deny-overrides

Returns a Decision (permit/deny + reason) that the PEP enforces and the audit
log records. Conditions are a small, safe JSON expression language - NO eval().

Condition JSON examples:
  {"op":"attr_eq","left":"user.domain","right":"resource.domain"}
  {"op":"attr_gte","left":"user.clearance","right":"resource.classification_rank"}
  {"op":"role_gte","right":"engineer"}
  {"op":"all","of":[ {...}, {...} ]}
  {"op":"any","of":[ {...}, {...} ]}
"""
from __future__ import annotations
import json
from dataclasses import dataclass
from typing import Optional

from .auth import Principal, ROLE_RANK

CLASSIFICATION_RANK = {
    "public": 1, "internal": 2, "confidential": 3, "restricted": 4}

# action -> minimum RBAC role (baseline before ABAC refinement)
ACTION_MIN_ROLE = {
    "search": "viewer",
    "dataset:view": "viewer",
    "lineage:view": "viewer",
    "dataset:view_sql": "engineer",
    "metadata:change": "engineer",
    "ingestion:trigger": "admin",
    "policy:change": "admin",
    "version:rollback": "admin",
    "governance:approve": "admin",
}


@dataclass
class Decision:
    permit: bool
    reason: str
    matched_policy: Optional[str] = None


class PDP:
    def __init__(self, policies: list[dict]):
        # policies sorted by priority asc; deny overrides at equal match
        self.policies = sorted(policies, key=lambda p: p.get("priority", 100))

    def decide(self, principal: Principal, action: str,
               resource: dict) -> Decision:
        # ---- 1. RBAC baseline -----------------------------------------
        min_role = ACTION_MIN_ROLE.get(action, "viewer")
        if not principal.has_role(min_role):
            return Decision(False,
                            f"rbac: role '{principal.role}' < required '{min_role}'")

        # ---- 2. ABAC policies (deny-overrides) ------------------------
        ctx = self._context(principal, resource)
        permit_hit = None
        for pol in self.policies:
            if pol.get("enabled", "Y") != "Y":
                continue
            if pol.get("action") not in (action, "*"):
                continue
            cond = pol.get("condition_expr")
            cond = json.loads(cond) if isinstance(cond, str) else (cond or {})
            if self._eval(cond, ctx):
                if pol.get("effect") == "deny":
                    return Decision(False, f"abac deny: {pol.get('name')}",
                                    pol.get("policy_id"))
                permit_hit = pol.get("policy_id")
        # ---- 3. default: RBAC passed and no explicit deny -------------
        return Decision(True, "permitted", permit_hit)

    # ---- context + safe evaluator -------------------------------------
    def _context(self, p: Principal, r: dict) -> dict:
        cls = (r.get("classification") or "public").lower()
        return {
            "user": {"domain": p.domain, "clearance": p.clearance,
                     "role": p.role, "role_rank": ROLE_RANK.get(p.role, 0)},
            "resource": {"domain": r.get("domain"),
                         "classification": cls,
                         "classification_rank": CLASSIFICATION_RANK.get(cls, 1)},
        }

    def _resolve(self, path: str, ctx: dict):
        cur = ctx
        for part in path.split("."):
            if isinstance(cur, dict):
                cur = cur.get(part)
            else:
                return None
        return cur

    def _eval(self, cond: dict, ctx: dict) -> bool:
        op = cond.get("op")
        if op == "all":
            return all(self._eval(c, ctx) for c in cond.get("of", []))
        if op == "any":
            return any(self._eval(c, ctx) for c in cond.get("of", []))
        if op == "attr_eq":
            return self._operand(cond["left"], ctx) == self._operand(cond["right"], ctx)
        if op == "attr_gte":
            l, r = self._operand(cond["left"], ctx), self._operand(cond["right"], ctx)
            try:
                return (l or 0) >= (r or 0)
            except TypeError:
                return False
        if op == "attr_gt":
            l, r = self._operand(cond["left"], ctx), self._operand(cond["right"], ctx)
            try:
                return (l or 0) > (r or 0)
            except TypeError:
                return False
        if op == "attr_lt":
            l, r = self._operand(cond["left"], ctx), self._operand(cond["right"], ctx)
            try:
                return (l or 0) < (r or 0)
            except TypeError:
                return False
        if op == "role_gte":
            return ctx["user"]["role_rank"] >= ROLE_RANK.get(cond.get("right"), 99)
        return False

    def _operand(self, val, ctx):
        # a dotted path resolves against ctx; a literal returns itself
        if isinstance(val, str) and (val.startswith("user.") or val.startswith("resource.")):
            return self._resolve(val, ctx)
        return val
