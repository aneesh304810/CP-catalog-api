# CP Data Catalog — webfs (CIFS) mount setup

Self-contained CIFS storage for the catalog, on the **same SMB server** as the
ODH notebook but in its **own folder** and its **own PV/PVC pair**. Nothing about
the ODH `opendatahub-wx` objects is reused or modified.

```
SMB share      : //qcwebfs.testbbh.com/fixedincomejupyteruser$
Catalog folder : /cp-datacatalog            (created by you on the share)
Pod mount path : /opt/approot/webfs         (files appear at
                 /opt/approot/webfs/cp-datacatalog/...)
Driver         : smb.csi.k8s.io  (static PV + PVC, RWX, read-write)
```

## 1. Create the folder on the share

From any host (or the ODH notebook) that can write the share, create:

```
cp-datacatalog/
  swagger/          # SEI Swagger / OpenAPI specs   (sei_swp.json, ...)
  postman/          # SEI Postman collections        (sei_flows.json, ...)
  overlay/          # business metadata Excel/Word template
  _catalog_output/  # (optional) catalog-written parsed snapshots/status
```

## 2. Create the SMB credentials secret (in the CATALOG namespace)

Secrets are namespace-scoped, so the catalog needs its own (same share creds):

```bash
oc project <CATALOG_NAMESPACE>          # e.g. cp-catalog-prod

oc create secret generic cp-datacatalog-smb-secret \
  --from-literal=username='<SHARE_USER>' \
  --from-literal=password='<SHARE_PASSWORD>' \
  --from-literal=domain='TESTBBH'        # omit if your share needs no domain
```

## 3. Apply the PV + PVC

Edit `deploy/openshift/05-webfs-storage.yaml`, replace `<CATALOG_NAMESPACE>`,
then:

```bash
oc apply -f deploy/openshift/05-webfs-storage.yaml
oc get pvc cp-datacatalog-webfs           # should show Bound
```

If it stays `Pending`, the PV/PVC didn't bind — check that `volumeName`,
`storageClassName: ""`, and `accessModes` match on both objects (they do in the
provided file), and that the secret name/namespace in the PV's
`nodeStageSecretRef` matches step 2.

## 4. Mount it into the workloads

The ingestion CronJob and (optionally) the API deployment mount the PVC at
`/opt/approot/webfs`. Merge the provided patches:

- `deploy/openshift/04-ingestion-cronjob.patch.yaml`  → adds the `webfs` volume + mount
- `deploy/openshift/01-config.patch.yaml`             → sets the file paths

```bash
oc apply -f deploy/openshift/01-config.yaml      # with the patch merged in
oc apply -f deploy/openshift/04-ingestion-cronjob.yaml
```

## 5. Verify the pod can read/write the share

```bash
oc run webfs-check --rm -it --restart=Never \
  --image=registry.access.redhat.com/ubi9/ubi-minimal \
  --overrides='{"spec":{"containers":[{"name":"c","image":"registry.access.redhat.com/ubi9/ubi-minimal","command":["sh","-c","ls -la /opt/approot/webfs/cp-datacatalog && touch /opt/approot/webfs/cp-datacatalog/_catalog_output/.write_test && echo WRITE_OK"],"volumeMounts":[{"name":"webfs","mountPath":"/opt/approot/webfs"}]}],"volumes":[{"name":"webfs","persistentVolumeClaim":{"claimName":"cp-datacatalog-webfs"}}]}}'
```

`WRITE_OK` confirms read-write access. If you see permission errors, the CIFS
`uid`/`gid` in the PV `mountOptions` don't match the share's enforced ownership —
adjust `uid=`/`gid=` in `05-webfs-storage.yaml` to the values your share grants.

## Notes / gotchas

- **volumeHandle uniqueness** — the catalog PV uses a distinct `volumeHandle`
  (`.../cp-datacatalog`) so it never collides with the ODH PV. Don't reuse ODH's.
- **RWX is required** — both ODH and the catalog mount CIFS concurrently; the PVC
  is `ReadWriteMany`.
- **Read-write** — mount is `readOnly: false` per requirement. To make ingestion
  strictly read-only later, set `readOnly: true` in the CronJob mount.
- **Reclaim policy is Retain** — deleting the PVC will not delete files on the
  share. Safe default for shared storage.
