"""
Policy Enforcement Point (PEP) + security middleware for FastAPI.

- get_principal: validates the Entra JWT (Authorization: Bearer ...) and loads
  ABAC attributes (domain, clearance) from principal_attributes.
- require(action): a dependency factory that runs the PDP for a given action and
  the resource attributes, audits the decision, and raises 403 on deny.
- SecurityHeadersMiddleware: secure headers + CORS handled in main.
- Rate limiting / throttling is enforced at the API gateway (see deploy notes);
  a lightweight in-process limiter is included as defence-in-depth.
"""
from __future__ import annotations
import os
import time
from collections import defaultdict

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose.exceptions import JWTError

from .auth import validate_token, Principal
from .pdp import PDP
from .audit import AuditLogger
from ..db import query, get_pool

bearer = HTTPBearer(auto_error=True)


# ---- principal resolution ---------------------------------------------
def get_principal(creds: HTTPAuthorizationCredentials = Depends(bearer)) -> Principal:
    try:
        p = validate_token(creds.credentials)
    except JWTError as e:
        raise HTTPException(401, f"invalid token: {e}")
    # enrich with ABAC attributes
    rows = query("""SELECT domain, clearance, service_account
                    FROM principal_attributes WHERE user_id = :u""",
                 {"u": p.user_id})
    if rows:
        p.domain = rows[0]["domain"]
        p.clearance = int(rows[0]["clearance"] or 1)
    return p


# ---- PDP loader (policies cached briefly) -----------------------------
_pol_cache = {"exp": 0, "pdp": None}


def _pdp() -> PDP:
    if time.time() < _pol_cache["exp"] and _pol_cache["pdp"]:
        return _pol_cache["pdp"]
    pols = query("""SELECT policy_id, name, effect, action, condition_expr,
                           priority, enabled FROM abac_policies""")
    pdp = PDP(pols)
    _pol_cache.update(exp=time.time() + 30, pdp=pdp)
    return pdp


def _resource_attrs(dataset_key: str | None) -> dict:
    if not dataset_key:
        return {}
    rows = query("""SELECT classification, domain FROM dataset_governance
                    WHERE dataset_key = :k""", {"k": dataset_key})
    return rows[0] if rows else {}


# ---- authorization dependency factory ---------------------------------
def require(action: str, resource_param: str | None = "key"):
    """
    Returns a dependency that enforces `action`. If resource_param is given,
    the resource attributes are loaded from the path/query param of that name.
    """
    def _dep(request: Request, principal: Principal = Depends(get_principal)) -> Principal:
        dataset_key = None
        if resource_param:
            dataset_key = (request.path_params.get(resource_param)
                           or request.query_params.get(resource_param))
        res = _resource_attrs(dataset_key)
        decision = _pdp().decide(principal, action, res)
        # audit every decision
        with get_pool().acquire() as conn:
            AuditLogger(conn).record(
                principal.user_id, principal.role, _audit_action(action),
                dataset_key or action,
                "allow" if decision.permit else "deny",
                {"reason": decision.reason, "policy": decision.matched_policy})
        if not decision.permit:
            raise HTTPException(403, decision.reason)
        return principal
    return _dep


def _audit_action(action: str) -> str:
    return {
        "search": "search",
        "dataset:view": "dataset_access",
        "lineage:view": "lineage_access",
        "dataset:view_sql": "sql_preview",
        "metadata:change": "metadata_change",
        "ingestion:trigger": "ingestion",
        "policy:change": "policy_change",
        "version:rollback": "metadata_change",
        "governance:approve": "policy_change",
    }.get(action, action)


# ---- in-process rate limiter (defence-in-depth) -----------------------
class RateLimiter:
    def __init__(self, max_per_min=120):
        self.max = max_per_min
        self.hits: dict[str, list[float]] = defaultdict(list)

    def check(self, key: str):
        now = time.time()
        window = [t for t in self.hits[key] if now - t < 60]
        if len(window) >= self.max:
            raise HTTPException(429, "rate limit exceeded")
        window.append(now)
        self.hits[key] = window


rate_limiter = RateLimiter(int(os.getenv("RATE_LIMIT_PER_MIN", "120")))
