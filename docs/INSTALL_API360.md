# Install & deploy — API 360

End-to-end setup for the API 360 feature, from local dev to OpenShift.

## Prerequisites

- The base CP Metadata Catalog is already installed (schema, API, UI, ingestion).
- The CIFS webfs share is set up per `docs/WEBFS_MOUNT_SETUP.md` with the
  `cp-datacatalog/` folder and `swagger/ postman/ overlay/` subfolders.
- The SEI Swagger file and Postman collection are placed on the share:
  ```
  /opt/approot/webfs/cp-datacatalog/swagger/sei_swp.json
  /opt/approot/webfs/cp-datacatalog/postman/sei_flows.json
  /opt/approot/webfs/cp-datacatalog/overlay/sei_dictionary.csv   (optional)
  ```

## A. Local development

```bash
# 1. Apply the API 360 schema (dev Oracle)
sqlplus metacat/pwd@dsn @sql/07_api360.sql

# 2. Wire the code per docs/INTEGRATION.md (3 small edits + drop-in files)

# 3. Point the connector at local copies of the files
export API360_SWAGGER_PATH=./samples/sei_swp.json
export API360_POSTMAN_PATH=./samples/sei_flows.json
export API360_DICTIONARY_PATH=./samples/sei_dictionary.csv   # optional

# 4. Run ingestion just for api360
python -m ingestion.run --steps api360      # if run.py supports --steps; else run all

# 5. Start API + UI
uvicorn api.app.main:app --reload
cd ui && npm install && npm run dev
```

Open the UI → the **API 360** tab. With the API reachable it shows **LIVE**
data; otherwise it renders embedded **DEMO** data so you can still click through.

## B. OpenShift deploy

```bash
oc project <CATALOG_NAMESPACE>

# 1. webfs storage (one-time) — see docs/WEBFS_MOUNT_SETUP.md
oc create secret generic cp-datacatalog-smb-secret \
  --from-literal=username='<SHARE_USER>' \
  --from-literal=password='<SHARE_PASSWORD>' \
  --from-literal=domain='TESTBBH'
oc apply -f deploy/openshift/05-webfs-storage.yaml
oc get pvc cp-datacatalog-webfs            # -> Bound

# 2. config + ingestion mount (merge the patches into your live manifests)
oc apply -f deploy/openshift/01-config.yaml          # includes API360_* paths
oc apply -f deploy/openshift/04-ingestion-cronjob.yaml  # includes webfs mount

# 3. apply the API 360 schema (or use the Jenkins DB-migrations stage)
#    via a one-off job or sqlplus against METACAT
sqlplus $MUSER/$MPASS@$MDSN @sql/07_api360.sql

# 4. build + push the api and ui images (they now contain the new code)
#    -> use jenkins/Jenkinsfile.deploy (sql/07_api360.sql is in the migration list)

# 5. trigger ingestion once to populate the api_* tables
oc create job --from=cronjob/cp-catalog-ingestion api360-initial-ingest
oc logs -f job/api360-initial-ingest
```

Browse to the catalog route → **API 360** tab → **LIVE**.

## C. Refresh after SEI updates a spec

1. Drop the new `sei_swp.json` / `sei_flows.json` on the webfs share (same paths).
2. Wait for the scheduled ingestion, or trigger it:
   ```bash
   oc create job --from=cronjob/cp-catalog-ingestion api360-refresh
   ```
3. The view reflects the new spec on the next page load. Check **Coverage**:
   flow steps pointing at endpoints no longer in the spec indicate drift.

## Environment variables (added)

| Var | Purpose | Example |
|-----|---------|---------|
| `API360_SWAGGER_PATH` | single Swagger file | `/opt/approot/webfs/cp-datacatalog/swagger/sei_swp.json` |
| `API360_SWAGGER_DIR` | folder of Swagger specs | `/opt/approot/webfs/cp-datacatalog/swagger` |
| `API360_POSTMAN_PATH` | single Postman collection | `/opt/approot/webfs/cp-datacatalog/postman/sei_flows.json` |
| `API360_POSTMAN_DIR` | folder of collections | `/opt/approot/webfs/cp-datacatalog/postman` |
| `API360_DICTIONARY_PATH` | optional field-definition CSV | `/opt/approot/webfs/cp-datacatalog/overlay/sei_dictionary.csv` |

## Notes

- **No internet / air-gapped:** the connector reads local files only (the webfs
  share). It never calls the SEI API. PyYAML is the only extra dependency and is
  installed from your internal Nexus.
- **Read-only API:** all `/api360/*` routes are read-only; nothing writes to the
  SEI API or mutates source data.
- **Self-contained schema:** the `api_*` tables are independent of the dataset /
  lineage tables, so this feature cannot affect existing catalog data.
