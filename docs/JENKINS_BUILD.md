# CP Metadata Catalog — Jenkins Build Setup (Full Instructions)

End-to-end instructions to build, scan, sign, and deploy the CP Catalog (API, UI,
ingestion) with Jenkins into OpenShift. Written for an **air-gapped** environment
with an internal **Nexus** (pip/npm/RPM mirrors) and the **OpenShift internal
registry**. Where a step differs for a connected environment, it's noted.

The pipeline produces three deployables (the **ingestion** runs from the **API**
image, so only two images are built: `cp-catalog-api`, `cp-catalog-ui`) and enforces
the CI/CD security gates from the ARB pack: secret scan, SAST, dependency audit,
image scan, SBOM, and image signing.

---

## 0. What you get

```
jenkins/
  Jenkinsfile          declarative pipeline (build → scan → push/sign → deploy)
  agent.Dockerfile     air-gapped build agent (podman, oc, trivy, cosign, gitleaks, sqlplus)
  agent-pod.yaml       Jenkins Kubernetes agent pod template
tests/
  test_core_logic.py   offline unit tests (PDP, classifier, masker, versioner, SQL guard)
```

Pipeline stages: Checkout → Secret scan → Lint & unit tests → SAST & dependency
audit → Build images → Image scan & SBOM → Push & sign → DB migrations (gated) →
Deploy → Smoke test.

---

## 1. Prerequisites

**On the cluster**
- An OpenShift project for CI/CD, e.g. `cp-catalog-cicd`, and target projects
  `cp-catalog-dev|uat|prod`.
- A `jenkins-builder` ServiceAccount in the build project with permission to push
  to the internal registry and run `oc` against the target projects:
  ```bash
  oc create sa jenkins-builder -n cp-catalog-cicd
  oc policy add-role-to-user system:image-builder -z jenkins-builder -n cp-catalog-cicd
  oc policy add-role-to-user edit -z jenkins-builder -n cp-catalog-dev
  # repeat for uat/prod as appropriate
  ```

**In Jenkins**
- Kubernetes plugin (agents as pods), Pipeline, Credentials Binding, JUnit,
  Warnings-NG (optional, for SARIF), and the OpenShift Client plugin (optional).

**Tooling (air-gapped)** — vendored into the agent image (see §3):
podman, oc, kubectl, trivy (+ offline DB), cosign, gitleaks, Oracle Instant Client,
python3.11, node 20.

---

## 2. Internal package mirrors (Nexus)

Make sure these Nexus repos exist and are reachable from the cluster:
- a **PyPI proxy/hosted** repo → its `.../simple` index URL
- an **npm proxy/hosted** registry URL
- an **RPM/yum** mirror for UBI packages (for the agent image build)

You'll wire the pip/npm URLs into Jenkins credentials in §4.

---

## 3. Build the Jenkins agent image (once)

The agent bundles every build tool so stages run without internet.

1. Vendor the tool binaries/RPMs into `jenkins/vendor/` (air-gapped):
   `oc`, `kubectl`, `trivy`, `cosign`, `gitleaks`, and the Oracle Instant Client
   RPMs under `jenkins/vendor/oracle/`. (In a connected env you can instead add
   `curl` install steps.)
2. Build and push to the internal registry:
   ```bash
   oc project cp-catalog-cicd
   podman build -f jenkins/agent.Dockerfile -t \
     image-registry.openshift-image-registry.svc:5000/cp-catalog-cicd/jenkins-agent:latest \
     jenkins/
   podman push --tls-verify=false \
     image-registry.openshift-image-registry.svc:5000/cp-catalog-cicd/jenkins-agent:latest
   ```
3. Pre-load the **offline Trivy DB** into the `trivy-db-cache` PVC referenced by
   `agent-pod.yaml` (download `trivy --download-db-only` on a connected host, copy
   the `~/.cache/trivy` contents into the PVC).

Register the agent in Jenkins: **Manage Jenkins → Clouds → Kubernetes → Pod
Templates**, label `cp-catalog`, paste `jenkins/agent-pod.yaml`.

---

## 4. Create Jenkins credentials

Add these (Manage Jenkins → Credentials). IDs must match the Jenkinsfile.

| ID | Type | Value |
|---|---|---|
| `nexus-pip-index-url` | Secret text | `https://nexus/.../pypi/simple` |
| `nexus-npm-registry` | Secret text | `https://nexus/.../npm/` |
| `ocp-api-server` | Secret text | `https://api.ocp.example.com:6443` |
| `ocp-token-dev` / `-uat` / `-prod` | Secret text | SA token per env |
| `cosign-private-key` | Secret file | cosign `cosign.key` |
| `cosign-password` | Secret text | cosign key password |
| `metacat-dev` / `-uat` / `-prod` | Username/password | METACAT schema creds (migrations) |

Generate the SA token for each env:
```bash
oc create token jenkins-builder -n cp-catalog-dev --duration=8760h
```
Generate a cosign keypair (on a connected host, store the key in Jenkins):
```bash
cosign generate-key-pair      # produces cosign.key / cosign.pub
```
Keep `cosign.pub` in the repo (`deploy/cosign.pub`) for verification at admission.

> **No secrets in code** — everything above is injected at runtime. The
> `deploy/openshift/01-config.yaml` Secret is applied separately by a platform
> admin (or sourced from Vault), never baked into images.

---

## 5. Create the pipeline job

1. **New Item → Pipeline** (or Multibranch Pipeline for per-branch builds).
2. **Pipeline script from SCM** → your Git repo → **Script Path** `jenkins/Jenkinsfile`.
3. For Multibranch, set branch sources and the same Script Path.
4. Save. The first run will prompt for the build parameters (`ENVIRONMENT`,
   `DEPLOY`, `RUN_DB_MIGRATIONS`).

---

## 6. Run a build

- **Dev:** `ENVIRONMENT=dev`, `DEPLOY=true`, `RUN_DB_MIGRATIONS=true` on first run
  (to create the METACAT schema), then `false` afterwards.
- **UAT/Prod:** the pipeline pauses for a manual **input** approval before DB
  migrations and before deploy.

What each gate fails on:
- **Secret scan (gitleaks):** any detected secret → fail.
- **Bandit (SAST):** medium+ severity findings → fail.
- **pip-audit / npm audit:** known-vulnerable deps (high+) → fail.
- **Trivy:** HIGH/CRITICAL image vulns → fail.
- All gates archive SARIF/JSON reports as build artifacts.

---

## 7. First-time database setup

The `DB migrations` stage runs the four SQL scripts in order against METACAT:
```
sql/01_schema.sql
sql/02_schema_additions.sql
sql/03_quality_gate_observability.sql
sql/04_security_governance_versioning.sql
```
Run it once with `RUN_DB_MIGRATIONS=true`. The scripts create tables/triggers; some
are not idempotent (e.g. `CREATE TABLE`), so subsequent runs may warn on
already-applied objects — that's expected. For repeatable migrations later, adopt
Liquibase/Flyway (Phase 2).

> The platform admin must also apply the config once per env:
> `oc apply -f <filled>/01-config.yaml` (Secret + ConfigMap), and ensure the
> read-only DB principals exist (`catalog_ro`, `catalog_preview_ro`, Airflow RO).

---

## 8. Deploy & verify

The `Deploy` stage applies the API/UI/CronJob manifests and rolls the new image
tag (`oc set image ... :<git-sha>`), then waits for rollout. The `Smoke test`
stage curls `/health` inside the API pod.

Manual verification:
```bash
oc get route cp-catalog -n cp-catalog-dev -o jsonpath='{.spec.host}'
# open the URL: the badge should read LIVE, search/lineage/health should populate
```

---

## 9. Seeding the catalog (ingestion)

Ingestion is the API image run with `python -m ingestion.run`. Either:
- the **CronJob** (`04-ingestion-cronjob.yaml`, applied by the pipeline) runs on
  schedule after the dbt build, **or**
- trigger an immediate seed:
  ```bash
  oc create job --from=cronjob/cp-catalog-ingestion seed-now -n cp-catalog-dev
  oc logs -f job/seed-now -n cp-catalog-dev
  ```
Ensure the dbt artifacts PVC is mounted (the dbt build must write `target/*.json`
to it).

---

## 10. Image signing & admission (optional, recommended)

The pipeline signs both images with cosign. To enforce only-signed-images at
deploy, add a Sigstore policy controller or an admission policy referencing
`deploy/cosign.pub`. In air-gapped clusters use `--tlog-upload=false` (already set)
and verify with the public key:
```bash
cosign verify --key deploy/cosign.pub <image>:<tag> --insecure-ignore-tlog=true
```

---

## 11. Promotion flow

```
 dev  ──(green build + manual QA)──▶  uat  ──(input approval)──▶  prod
```
Use the same commit SHA tag across envs (immutable promotion). Re-running the
pipeline with a different `ENVIRONMENT` and the same commit redeploys the identical
image; only config (Secret/ConfigMap per env) differs.

---

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `podman build` permission denied | rootless storage | ensure `agent-pod.yaml` SETUID/SETGID caps + emptyDir storage mount |
| pip/npm cannot resolve | Nexus URL/creds | check `nexus-pip-index-url` / `nexus-npm-registry` credentials |
| Trivy "DB not found" | offline DB missing | pre-load `trivy-db-cache` PVC; set `TRIVY_OFFLINE`/cache dir |
| push denied to registry | SA permissions | `system:image-builder` on the build project |
| `oc login` fails | token expired | regenerate SA token credential for that env |
| migrations re-warn | non-idempotent DDL | expected on re-run; adopt Flyway/Liquibase later |
| deploy rollout timeout | image pull / probe fail | check image tag pushed, readiness `/health`, METACAT reachability |

---

## 13. Hardening checklist (maps to ARB CI/CD controls)

- [x] Secret scanning (gitleaks) blocks on detection
- [x] SAST (bandit) blocks on medium+
- [x] Dependency audit (pip-audit, npm audit) blocks on high+
- [x] Image scanning (Trivy) blocks on HIGH/CRITICAL
- [x] SBOM generated (CycloneDX) per image
- [x] Images signed (cosign), verifiable from `cosign.pub`
- [x] No secrets in code/images (runtime injection only)
- [x] Non-root UBI images, rootless agent
- [x] Gated prod deploy + gated prod DB migration (manual input)
- [ ] Admission enforcement of signatures (platform task)
- [ ] Flyway/Liquibase for repeatable migrations (Phase 2)
```
