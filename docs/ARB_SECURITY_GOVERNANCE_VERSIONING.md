# CP Catalog — Security, Governance & Versioning (ARB Pack)

**Scope:** three new layers over the existing CP Catalog (Oracle/OpenShift, FastAPI,
React). Stack adapted from the requested Postgres/ES reference to CP's deployed
Oracle/OpenShift. Phase 1 is built; Phases 2–3 are outlined.

---

## 1. High-level architecture

```
                 ┌────────────── OpenShift Route (TLS edge) ──────────────┐
 Browser ──────▶ │  React UI (nginx)  ──/api──▶  API Gateway / FastAPI     │
 Entra ID  ◀──── │   OIDC login (MSAL)                                     │
 (Azure AD)      └────────────────────────────────────────────────────────┘
                                       │
              ┌────────────────────────┼─────────────────────────────┐
              ▼                        ▼                              ▼
     Security Layer            Governance Layer              Versioning Layer
     - JWT/JWKS (Entra)        - auto classification         - immutable versions
     - RBAC (AD groups)        - dynamic masking             - diff engine (semver)
     - ABAC (PDP/PEP)          - ownership/lifecycle         - lineage versioning
     - audit (hash chain)      - approval workflow           - rollback (audited)
     - SQL preview guard       - access governance
              │                        │                              │
              └──────────── Oracle METACAT schema (+ Vault for secrets) ─┘
                                       │
                    OpenTelemetry → Prometheus / audit dashboards
```

## 2. Component architecture

- **API Gateway / PEP:** FastAPI with JWT middleware, secure headers, CORS allow-list,
  in-process rate limiter (gateway/3scale enforces the hard limit). Every sensitive
  route depends on `require(action)` → PDP → audit.
- **PDP:** data-driven RBAC+ABAC engine (`abac_policies`), deny-overrides, safe JSON
  condition language (no eval).
- **Audit:** append-only `audit_log` with SHA-256 hash chain + DB immutability trigger.
- **Governance services:** classifier, masker, approval workflow, access governance.
- **Versioner:** builds immutable `dataset_versions` from each dbt harvest; diff engine
  decides major/minor/patch; rollback re-applies a snapshot and logs it.

## 3. Database schema

New tables (Oracle, `sql/04_*.sql`): `audit_log`, `abac_policies`,
`principal_attributes`, `dataset_governance`, `column_masking`, `approval_requests`,
`access_grants`, `dataset_versions`, `dataset_diffs`, `rollback_log`. Immutability
triggers on `audit_log` and `dataset_versions`.

## 4. API design (additions)

```
Versioning   GET  /datasets/{id}/versions
             GET  /datasets/{id}/diff/{v1}/{v2}
             POST /datasets/{id}/rollback/{version}     (admin)
Governance   GET  /governance/{id}
             POST /governance/{id}/classify             (engineer+)
             POST /governance/approval                  (engineer+)
             POST /governance/approval/{rid}/decide     (admin)
             POST /governance/access/request            (any)
             POST /governance/access/{gid}/approve      (admin)
Security     POST /datasets/{id}/sql-preview            (engineer+, masked)
             GET  /audit                                (admin)
             GET  /audit/verify                         (admin)
```

## 5. Security architecture

- **AuthN:** Entra ID OAuth2/OIDC; bearer JWT validated against JWKS (cached); issuer
  + audience checked. Service accounts / M2M via client-credentials tokens carrying
  app roles (`CATALOG_*`).
- **AuthZ:** RBAC (Viewer/Engineer/Admin from AD groups) as baseline; ABAC refines
  (domain match, clearance ≥ classification, engineer-sees-SQL, admin-triggers-
  ingestion). PDP decides, PEP enforces.
- **Controls:** secure headers (HSTS, CSP, nosniff, frame-deny), CORS allow-list,
  rate limiting/throttling, input validation (Pydantic + sqlglot for SQL).
- **SQL preview:** statement allow-list (SELECT/WITH only), sqlglot structural guard,
  forbidden-keyword block, row limit, query timeout, dedicated **read-only DB
  principal**.
- **Secrets:** HashiCorp Vault (or OpenShift Secrets) injected as env; rotation policy;
  no secrets in code.

## 6. Governance architecture

Classification (Public/Internal/Confidential/Restricted) auto-derived from column
sensitivity + name heuristics, manual override wins, enforced via PDP clearance rule.
Dynamic role-based masking at read time (viewer `XXXX-XX-1234`, engineer full).
Ownership (technical owner, business steward, domain) + certification (Gold/Silver/
Bronze) + lifecycle (Draft→Active→Certified→Deprecated→Archived). Approval workflow
(Submit→Review→Approve/Reject) as a guarded state machine. Access governance:
request → temporary grant (expiry) → recertification sweep.

## 7. Versioning architecture

Immutable, auto-generated from dbt artifacts (`manifest`, `catalog`, `run_results`).
Semver rules: **major** = column removed / datatype change / breaking; **minor** =
column or test added; **patch** = description/owner/tag change. Each version stores
schema, lineage, classification, and ownership snapshots. Diff engine emits added/
removed/changed columns + lineage + policy changes. Lineage is version-aware
(`customer_master_v1/v2/v3`). Rollback re-applies a snapshot and writes `rollback_log`;
prior versions never mutate.

## 8. Service decomposition

`api/app/security/` (auth, pdp, pep, audit, sql_preview), `api/app/governance/`,
`api/app/versioning/`, `routers_sgv.py` (HTTP surface). Ingestion gains `quality` and
`versioning` steps. All stateless except the Oracle store.

## 9. Key sequence (SQL preview)

```
UI →(JWT) API: POST /datasets/{id}/sql-preview
API: validate JWT (JWKS) → Principal
API: PDP.decide(principal, dataset:view_sql, resource) → permit?
API: audit(sql_preview, allow/deny)
API: sqlglot validate (SELECT-only) → run on READ-ONLY conn (timeout, row limit)
API: apply role-based masking → return rows
```

## 10. RBAC + ABAC policy model

RBAC: viewer<engineer<admin from AD groups `CATALOG_VIEWER/ENGINEER/ADMIN`.
ABAC (examples, data-driven): deny `dataset:view` when `resource.classification_rank
> user.clearance`; deny cross-`domain`; permit `dataset:view_sql` for engineer+;
permit `ingestion:trigger` for admin. Deny-overrides; default least-privilege.

## 11. Audit logging architecture

Append-only table; every PEP decision and sensitive action recorded with user, role,
action, resource, timestamp, outcome. SHA-256 hash chain links rows (tamper-evident);
DB trigger blocks UPDATE/DELETE; `/audit/verify` re-walks the chain. Ship to SIEM via
OpenTelemetry log export for retention + alerting.

## 12. OpenMetadata feature comparison

| Capability | OpenMetadata | CP Catalog (this build) |
|---|---|---|
| Discovery/lineage/column-lineage | ✅ | ✅ |
| RBAC + policies | ✅ | ✅ RBAC + data-driven ABAC |
| Classification/PII tags | ✅ | ✅ auto + manual, enforced via PDP |
| Dynamic masking | partial | ✅ role-based |
| Approval/lifecycle/certification | partial | ✅ |
| Dataset versioning + diff + rollback | limited | ✅ immutable semver |
| Audit immutability | basic | ✅ hash-chained + trigger |
| Connectors breadth | 50+ | Oracle/SQL Server/dbt/Airflow (focused) |

## 13–15. Deployment / OpenShift / CI-CD security

UBI non-root images; Routes with edge TLS; Secrets via Vault/OpenShift; API and UI
stateless (HPA-ready). CI/CD: image signing (cosign), SBOM, Trivy/Grype scan gates,
SAST (Bandit/Semgrep), dependency audit, no-secrets check (gitleaks), policy-as-code
on manifests (Conftest). Promotion gated on scan pass.

## 16. Threat model (STRIDE, abbreviated)

| Threat | Vector | Mitigation |
|---|---|---|
| Spoofing | stolen/forged token | Entra JWKS validation, short token TTL, audience/issuer checks |
| Tampering | edit audit/metadata | immutable triggers, hash chain, RBAC on writes |
| Repudiation | deny an action | full audit with user/role/outcome, chain verify |
| Info disclosure | read sensitive cols / SQL | classification+clearance ABAC, dynamic masking, RO preview |
| DoS | query/endpoint abuse | rate limit/throttle, SQL timeout + row limit |
| Elevation | role bypass | deny-overrides PDP, least-privilege default, admin-only ingestion/policy |

## 17. ARB readiness checklist

- [x] AuthN via Entra OIDC, JWKS validation, service accounts/M2M
- [x] RBAC from AD groups + ABAC PDP/PEP
- [x] Secure headers, CORS allow-list, rate limiting, input validation
- [x] Immutable, hash-chained audit of all sensitive actions
- [x] Read-only, guarded SQL preview
- [x] Classification (auto+manual) + dynamic masking
- [x] Ownership, certification, lifecycle, approval, access governance
- [x] Immutable dataset versioning + diff + audited rollback
- [x] Secrets via Vault/OpenShift, rotation, none in code
- [ ] Pen test + SIEM integration sign-off (Phase 2)
- [ ] DR/backup runbook for METACAT + audit retention policy (Phase 2)

---

# Phased implementation

## Phase 1 — Must Have (built)
- **Components:** Entra JWT/JWKS auth, RBAC, PDP/PEP ABAC, audit (hash chain + trigger),
  SQL-preview guard, auto-classification, role-based masking, immutable versioning +
  diff + rollback, version/governance/audit APIs.
- **DB changes:** `sql/04_*.sql` (10 tables + 2 immutability triggers).
- **APIs:** versioning, governance, sql-preview, audit (section 4).
- **Security controls:** secure headers, CORS allow-list, rate limit, RO SQL preview,
  deny-overrides PDP.
- **Effort:** ~4–6 weeks (1–2 engineers) incl. Entra app registration + integration test.
- **Risks:** Entra group-claim overage (use Graph fallback if >200 groups); RO DB
  principal must be correctly provisioned for preview; column-lineage coverage limits
  carried from base catalog.

## Phase 2 — Enterprise Ready (outlined)
- **Components:** Vault dynamic secrets + rotation, SIEM/audit dashboards, OpenTelemetry
  traces, access recertification campaigns, masking policy UI, approval UI.
- **DB changes:** recertification campaign tables; policy_version history.
- **APIs:** `/governance/recertify`, `/policies` CRUD with versioning.
- **Security controls:** WAF/API-gateway throttling tiers, anomaly alerts, mTLS to DB.
- **Effort:** ~6–8 weeks. **Risks:** SIEM data volume/cost; rotation coordination.

## Phase 3 — Advanced Governance (outlined)
- **Components:** policy-as-code (OPA/Rego) externalizing the PDP, automated impact-
  analysis notifications (affected dashboards/reports/dbt models), data-contract
  enforcement at the gate, lineage-version diffing in the UI.
- **DB changes:** `policy_versions`, contract tables.
- **APIs:** `/impact/{id}`, `/contracts`, OPA decision proxy.
- **Security controls:** external PDP attestation, continuous compliance scans.
- **Effort:** ~8–12 weeks. **Risks:** OPA integration complexity; contract false-positives
  (ship observe-first, like the runtime gate).
