# API 360 — integration into the existing cp-catalog

Three small edits to existing files, plus the new files dropped in. Nothing in
the existing Explore / Lineage / Health screens changes.

## 1. UI — `ui/src/App.jsx` (3 edits)

**a. import the new components** (top of file, with the other imports):

```jsx
import Api360 from "./Api360";
import Api360Help from "./Api360Help";
```

**b. add the screen to the nav `.map`** — find:

```jsx
{[["explore", "Explore"], ["lineage", "Lineage"], ["health", "Health & Quality"]].map(([k, l]) => (
```

change to:

```jsx
{[["explore", "Explore"], ["lineage", "Lineage"], ["api360", "API 360"], ["health", "Health & Quality"]].map(([k, l]) => (
```

**c. render the screen** — next to the other `{screen === "..." && (...)}` blocks:

```jsx
{screen === "api360" && <Api360 ST={ST} apiMode={apiMode} />}
```

(Optional) add a Help button in the top bar that opens the guide:

```jsx
const [showHelp, setShowHelp] = useState(false);
// ...in the top bar, when screen === "api360":
{screen === "api360" && (
  <button onClick={() => setShowHelp(true)} style={ghostBtn(ST)} title="API 360 help">?</button>
)}
{showHelp && <Api360Help ST={ST} onClose={() => setShowHelp(false)} />}
```

> `ST` is the light-token object in the uploaded `CP_Catalog_Full_UI.jsx`. If
> your live `App.jsx` uses the dark/light `t` object instead, pass `t` as the
> `ST` prop: `<Api360 ST={t} apiMode={apiMode} />` — the component only reads
> token names (bg, panel, panel2, border, text, sub, line, accent, and the
> optional nodeBg/chip/drawer), so either object works.

## 2. UI — `ui/src/api.js` (optional)

The `Api360.jsx` component fetches `/api360/...` directly, so no change is
required. If you prefer centralizing, add to the `api` object:

```js
api360: {
  sources:     () => get("/api360/sources"),
  endpoints:   (sid) => get(`/api360/endpoints${sid ? `?source_id=${sid}` : ""}`),
  dependencies:(sid) => get(`/api360/dependencies${sid ? `?source_id=${sid}` : ""}`),
  endpoint:    (key) => get(`/api360/endpoint?key=${encodeURIComponent(key)}`),
  flows:       (sid) => get(`/api360/flows${sid ? `?source_id=${sid}` : ""}`),
  flow:        (key) => get(`/api360/flow?key=${encodeURIComponent(key)}`),
  search:      (q) => get(`/api360/search?q=${encodeURIComponent(q || "")}`),
},
```

## 3. API — `api/app/main.py` (1 edit)

Register the router:

```python
from .routers_api360 import router as api360_router
app.include_router(api360_router)
```

`routers_api360.py` imports `get_conn` from `.db`. If your db helper has a
different name, adjust the import at the top of `routers_api360.py`.

## 4. Ingestion — `ingestion/run.py` (1 edit)

Add the api360 step (mirrors the existing connector blocks):

```python
from .api360_conn import Api360Connector
from .api360_loader import load_api360

# inside run(), with the other steps:
if "api360" in steps:
    print(">> api360: parsing swagger + postman from webfs")
    bundle = Api360Connector.from_env().extract()
    counts = load_api360(loader, bundle)
    print(f"   api360 loaded: {counts}")
```

And add `"api360"` to the default `steps` set near the top of `run()`.

## 5. Schema — apply the new tables

```bash
sqlplus metacat/pwd@dsn @sql/07_api360.sql
```

(or via the Jenkins DB-migrations stage — `07_api360.sql` is added to the list).

## 6. Files added (drop-in, no edits)

```
ui/src/Api360.jsx
ui/src/Api360Help.jsx
ingestion/api360_conn.py
ingestion/api360_loader.py
api/app/routers_api360.py
sql/07_api360.sql
deploy/openshift/05-webfs-storage.yaml
deploy/openshift/05a-webfs-secret.yaml
deploy/openshift/01-config.patch.yaml
deploy/openshift/04-ingestion-cronjob.patch.yaml
docs/WEBFS_MOUNT_SETUP.md
docs/INSTALL_API360.md
jenkins/Jenkinsfile.api360.snippet
```
