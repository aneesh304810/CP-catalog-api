"""
Offline unit tests for CP Catalog core logic (no DB, no network).
Run: pytest -q tests/
These cover the security PDP, governance classifier/masker, versioning semver,
and the SQL preview guard - the logic that must be correct for the ARB gates.
"""
import sys, os, importlib.util
from dataclasses import dataclass, field
from typing import Optional

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, path))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# ---- stub Principal so pdp can import without the httpx-backed auth module ----
ROLE_RANK = {"viewer": 1, "engineer": 2, "admin": 3}


@dataclass
class StubPrincipal:
    user_id: str = "u"
    name: str = "n"
    email: str = "e"
    role: str = "viewer"
    domain: Optional[str] = None
    clearance: int = 1
    groups: list = field(default_factory=list)
    is_service: bool = False
    raw_claims: dict = field(default_factory=dict)

    def has_role(self, m):
        return ROLE_RANK.get(self.role, 0) >= ROLE_RANK.get(m, 99)


def _pdp_module():
    import types
    fake = types.ModuleType("app.security.auth")
    fake.Principal = StubPrincipal
    fake.ROLE_RANK = ROLE_RANK
    sys.modules.setdefault("app", types.ModuleType("app"))
    sys.modules.setdefault("app.security", types.ModuleType("app.security"))
    sys.modules["app.security.auth"] = fake
    return _load("api/app/security/pdp.py", "app.security.pdp")


# ============================== SECURITY / PDP ========================
def test_rbac_blocks_viewer_sql_preview():
    PDP = _pdp_module().PDP
    pdp = PDP([])
    d = pdp.decide(StubPrincipal(role="viewer"), "dataset:view_sql", {})
    assert d.permit is False


def test_rbac_allows_engineer_sql_preview():
    PDP = _pdp_module().PDP
    assert PDP([]).decide(StubPrincipal(role="engineer"), "dataset:view_sql", {}).permit


def test_rbac_ingestion_admin_only():
    PDP = _pdp_module().PDP
    assert not PDP([]).decide(StubPrincipal(role="engineer"), "ingestion:trigger", {}).permit
    assert PDP([]).decide(StubPrincipal(role="admin"), "ingestion:trigger", {}).permit


def test_abac_clearance_gate_denies_low_clearance():
    PDP = _pdp_module().PDP
    pol = [{"policy_id": "clr", "name": "clearance", "effect": "deny",
            "action": "dataset:view", "priority": 5, "enabled": "Y",
            "condition_expr": {"op": "attr_lt", "left": "user.clearance",
                               "right": "resource.classification_rank"}}]
    pdp = PDP(pol)
    restricted = {"classification": "restricted", "domain": "risk"}
    assert not pdp.decide(StubPrincipal(role="viewer", clearance=1), "dataset:view", restricted).permit
    assert pdp.decide(StubPrincipal(role="admin", clearance=4), "dataset:view", restricted).permit


# ============================== GOVERNANCE ===========================
def test_classifier_detects_restricted():
    g = _load("api/app/governance/governance.py", "gov1")
    cls, src = g.Classifier().classify_dataset(
        [{"column_name": "ssn", "sensitivity": "PII"}])
    assert cls == "restricted" and src == "auto"


def test_classifier_manual_override():
    g = _load("api/app/governance/governance.py", "gov2")
    cls, src = g.Classifier().classify_dataset(
        [{"column_name": "x"}], manual="Internal")
    assert cls == "internal" and src == "manual"


def test_masker_partial_for_viewer_full_for_engineer():
    g = _load("api/app/governance/governance.py", "gov3")
    m = g.Masker()
    assert m.mask_value("123-45-6789", "partial", "XXXX-XX-{last4}",
                        "viewer", {"engineer", "admin"}) == "XXXX-XX-6789"
    assert m.mask_value("123-45-6789", "partial", "XXXX-XX-{last4}",
                        "engineer", {"engineer", "admin"}) == "123-45-6789"


def test_workflow_cannot_skip_review():
    g = _load("api/app/governance/governance.py", "gov4")
    wf = g.ApprovalWorkflow()
    assert "approved" not in wf.TRANSITIONS["submitted"]
    assert "approved" in wf.TRANSITIONS["in_review"]


# ============================== VERSIONING ===========================
def test_semver_major_on_column_removed():
    v = _load("api/app/versioning/versioner.py", "ver1")
    de = v.DiffEngine(); vr = v.Versioner(de)
    old = {"columns": [{"name": "a", "data_type": "NUMBER"},
                       {"name": "b", "data_type": "NUMBER"}], "tests": []}
    new = {"columns": [{"name": "a", "data_type": "NUMBER"}], "tests": []}
    assert vr.decide_bump(de.diff_schema(old, new), {}) == "major"


def test_semver_minor_on_column_added():
    v = _load("api/app/versioning/versioner.py", "ver2")
    de = v.DiffEngine(); vr = v.Versioner(de)
    old = {"columns": [{"name": "a", "data_type": "NUMBER"}], "tests": []}
    new = {"columns": [{"name": "a", "data_type": "NUMBER"},
                       {"name": "b", "data_type": "NUMBER"}], "tests": []}
    assert vr.decide_bump(de.diff_schema(old, new), {}) == "minor"
    assert vr.next_version("1.2.3", "minor") == "1.3.0"


def test_semver_patch_on_policy_only():
    v = _load("api/app/versioning/versioner.py", "ver3")
    de = v.DiffEngine(); vr = v.Versioner(de)
    same = {"columns": [{"name": "a", "data_type": "NUMBER"}], "tests": []}
    assert vr.decide_bump(de.diff_schema(same, same),
                          {"technical_owner": {"from": "a", "to": "b"}}) == "patch"


# ============================== SQL PREVIEW GUARD ====================
def test_sql_guard_blocks_dml_ddl():
    sp = _load("api/app/security/sql_preview.py", "sqlprev")
    for bad in ["UPDATE t SET x=1", "DELETE FROM t", "DROP TABLE t",
                "TRUNCATE TABLE t", "INSERT INTO t VALUES (1)",
                "SELECT * FROM t; DROP TABLE t"]:
        try:
            sp.validate_sql(bad)
            assert False, f"should have blocked: {bad}"
        except sp.SqlPreviewError:
            pass


def test_sql_guard_allows_select():
    sp = _load("api/app/security/sql_preview.py", "sqlprev2")
    assert sp.validate_sql("SELECT * FROM positions WHERE id = 1")
