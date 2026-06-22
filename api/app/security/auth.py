"""
Authentication: Microsoft Entra ID (Azure AD) via OAuth2/OIDC.

Validates bearer JWTs against Entra's JWKS endpoint (cached), checks issuer +
audience, and derives the catalog RBAC role from AD group claims. Supports both
interactive users and service accounts / machine-to-machine (client credentials)
tokens (which carry roles/app-roles instead of group memberships).

No secrets in code: ENTRA_TENANT_ID, ENTRA_AUDIENCE, ENTRA_JWKS_URL come from
env (injected from Vault/OpenShift Secret).
"""
from __future__ import annotations
import os
import time
from dataclasses import dataclass, field
from typing import Optional

import httpx
from jose import jwt
from jose.exceptions import JWTError

TENANT = os.getenv("ENTRA_TENANT_ID", "")
AUDIENCE = os.getenv("ENTRA_AUDIENCE", "")
ISSUER = os.getenv("ENTRA_ISSUER", f"https://login.microsoftonline.com/{TENANT}/v2.0")
JWKS_URL = os.getenv("ENTRA_JWKS_URL",
                     f"https://login.microsoftonline.com/{TENANT}/discovery/v2.0/keys")

# AD group object-id -> catalog role. Group ids come from env (per environment).
GROUP_VIEWER = os.getenv("AD_GROUP_CATALOG_VIEWER", "")
GROUP_ENGINEER = os.getenv("AD_GROUP_CATALOG_ENGINEER", "")
GROUP_ADMIN = os.getenv("AD_GROUP_CATALOG_ADMIN", "")

ROLE_RANK = {"viewer": 1, "engineer": 2, "admin": 3}


@dataclass
class Principal:
    user_id: str                  # oid (stable) or app id for service accounts
    name: Optional[str]
    email: Optional[str]
    role: str                     # viewer | engineer | admin
    groups: list[str] = field(default_factory=list)
    is_service: bool = False
    # ABAC attributes (filled by the PDP from principal_attributes table)
    domain: Optional[str] = None
    clearance: int = 1
    raw_claims: dict = field(default_factory=dict)

    def has_role(self, minimum: str) -> bool:
        return ROLE_RANK.get(self.role, 0) >= ROLE_RANK.get(minimum, 99)


class _JWKSCache:
    def __init__(self, ttl=3600):
        self._keys = None
        self._exp = 0
        self._ttl = ttl

    def get(self) -> dict:
        if self._keys and time.time() < self._exp:
            return self._keys
        resp = httpx.get(JWKS_URL, timeout=5)
        resp.raise_for_status()
        self._keys = resp.json()
        self._exp = time.time() + self._ttl
        return self._keys


_jwks = _JWKSCache()


def validate_token(token: str) -> Principal:
    """Validate an Entra bearer token and return a Principal, or raise JWTError."""
    jwks = _jwks.get()
    header = jwt.get_unverified_header(token)
    key = next((k for k in jwks.get("keys", []) if k["kid"] == header.get("kid")), None)
    if not key:
        raise JWTError("signing key not found in JWKS")
    claims = jwt.decode(
        token, key, algorithms=[key.get("alg", "RS256")],
        audience=AUDIENCE, issuer=ISSUER,
        options={"verify_at_hash": False})
    return _principal_from_claims(claims)


def _principal_from_claims(claims: dict) -> Principal:
    # service account / M2M tokens: no 'groups', carry 'roles' (app roles) and
    # an 'idtyp'=app or no 'name'.
    is_service = claims.get("idtyp") == "app" or (
        "groups" not in claims and "name" not in claims)
    groups = claims.get("groups", []) or []
    app_roles = claims.get("roles", []) or []
    role = _derive_role(groups, app_roles)
    return Principal(
        user_id=claims.get("oid") or claims.get("azp") or claims.get("sub"),
        name=claims.get("name"),
        email=claims.get("preferred_username") or claims.get("email"),
        role=role, groups=groups, is_service=is_service,
        raw_claims=claims)


def _derive_role(groups: list[str], app_roles: list[str]) -> str:
    # AD group membership (interactive users)
    if GROUP_ADMIN and GROUP_ADMIN in groups:
        return "admin"
    if GROUP_ENGINEER and GROUP_ENGINEER in groups:
        return "engineer"
    if GROUP_VIEWER and GROUP_VIEWER in groups:
        return "viewer"
    # app roles (service accounts), named CATALOG_ADMIN/ENGINEER/VIEWER
    roles_up = {r.upper() for r in app_roles}
    if "CATALOG_ADMIN" in roles_up:
        return "admin"
    if "CATALOG_ENGINEER" in roles_up:
        return "engineer"
    if "CATALOG_VIEWER" in roles_up:
        return "viewer"
    # default least-privilege
    return "viewer"
