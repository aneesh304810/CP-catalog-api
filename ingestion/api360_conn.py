"""
API 360 connector.

Parses SEI API documentation into the catalog's API-360 tables:
  - Swagger / OpenAPI spec  -> endpoints, fields, $ref dependency edges
  - Postman collection      -> business flows, ordered steps, {{var}} edges
  - (optional) dictionary   -> field descriptions joined by field name

Reads files from the webfs share paths set in the ConfigMap:
  API360_SWAGGER_PATH / API360_SWAGGER_DIR
  API360_POSTMAN_PATH / API360_POSTMAN_DIR
  API360_DICTIONARY_PATH  (optional CSV: field,definition)

Pure parsing only — no transformation, no execution. Emits dataclasses the
loader upserts with idempotent MERGE.

Dependencies: PyYAML (Swagger may be YAML), stdlib json/csv. All available in
the air-gapped api image (PyYAML is a FastAPI/uvicorn transitive dep; if not,
add to api/requirements.txt).
"""
from __future__ import annotations

import json
import os
import re
import csv
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


# --------------------------------------------------------------------------
# normalized records
# --------------------------------------------------------------------------
@dataclass
class ApiSource:
    source_id: str
    name: str
    kind: str
    version: Optional[str] = None
    spec_path: Optional[str] = None
    endpoint_count: int = 0
    field_count: int = 0
    flow_count: int = 0


@dataclass
class ApiEndpoint:
    source_id: str
    method: str
    path: str
    operation_id: Optional[str] = None
    summary: Optional[str] = None
    ref_object: Optional[str] = None
    owner: Optional[str] = None

    @property
    def endpoint_key(self) -> str:
        return f"{self.source_id}:{self.method.upper()}:{self.path}".lower()


@dataclass
class ApiField:
    source_id: str
    endpoint_key: str
    name: str
    data_type: str = "string"
    is_key: bool = False
    nullable: bool = True
    description: Optional[str] = None
    ref_object: Optional[str] = None

    @property
    def field_key(self) -> str:
        return f"{self.endpoint_key}.{self.name.lower()}"


@dataclass
class ApiDependency:
    source_id: str
    from_endpoint: str
    to_endpoint: str
    kind: str          # 'ref' | 'runtime'
    via: Optional[str] = None

    @property
    def edge_id(self) -> str:
        return f"{self.from_endpoint}>{self.to_endpoint}:{self.via or ''}"


@dataclass
class ApiFlow:
    source_id: str
    name: str
    description: Optional[str] = None
    owner: Optional[str] = None
    schedule: Optional[str] = None
    step_count: int = 0

    @property
    def flow_key(self) -> str:
        return f"{self.source_id}:{self.name}".lower()


@dataclass
class ApiFlowStep:
    source_id: str
    flow_key: str
    step_no: int
    method: str
    path: str
    endpoint_key: Optional[str] = None
    note: Optional[str] = None
    input_vars: Optional[str] = None
    output_vars: Optional[str] = None

    @property
    def step_key(self) -> str:
        return f"{self.flow_key}:{self.step_no}"


@dataclass
class ApiFlowEdge:
    flow_key: str
    from_step: str
    to_step: str
    variable: Optional[str] = None

    @property
    def edge_id(self) -> str:
        return f"{self.from_step}>{self.to_step}:{self.variable or ''}"


@dataclass
class Api360Bundle:
    sources: list = field(default_factory=list)
    endpoints: list = field(default_factory=list)
    fields: list = field(default_factory=list)
    dependencies: list = field(default_factory=list)
    flows: list = field(default_factory=list)
    steps: list = field(default_factory=list)
    flow_edges: list = field(default_factory=list)


# --------------------------------------------------------------------------
# key/identifier heuristics
# --------------------------------------------------------------------------
_KEY_HINT = re.compile(r"(^|_)(id|key|no|num|number|code)$", re.I)


def _looks_like_key(name: str) -> bool:
    return bool(_KEY_HINT.search(name)) or name.lower().endswith("id")


def _load_file(path: str) -> dict:
    """Load a JSON or YAML document."""
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    if p.suffix.lower() in (".yaml", ".yml"):
        import yaml  # lazy import; only needed for YAML specs
        return yaml.safe_load(text)
    return json.loads(text)


# --------------------------------------------------------------------------
# Swagger / OpenAPI parsing
# --------------------------------------------------------------------------
class SwaggerParser:
    """Parses one resolved OpenAPI/Swagger doc into endpoints/fields/deps."""

    def __init__(self, source_id: str, spec: dict, spec_path: str = "",
                 dictionary: dict | None = None):
        self.source_id = source_id
        self.spec = spec
        self.spec_path = spec_path
        self.dictionary = dictionary or {}

    def _resolve_ref(self, ref: str) -> tuple[str, dict]:
        """#/components/schemas/Account -> ('Account', {schema})."""
        name = ref.split("/")[-1]
        node = self.spec
        for part in ref.lstrip("#/").split("/"):
            node = node.get(part, {}) if isinstance(node, dict) else {}
        return name, node if isinstance(node, dict) else {}

    def _schema_fields(self, schema: dict) -> tuple[str, list[tuple[str, str]]]:
        """Return (ref_object_name, [(field, type), ...]) flattening one $ref/allOf."""
        ref_name = None
        props = {}
        if "$ref" in schema:
            ref_name, resolved = self._resolve_ref(schema["$ref"])
            props = resolved.get("properties", {}) or {}
        elif "allOf" in schema:
            for part in schema["allOf"]:
                if "$ref" in part:
                    ref_name, resolved = self._resolve_ref(part["$ref"])
                    props.update(resolved.get("properties", {}) or {})
                else:
                    props.update(part.get("properties", {}) or {})
        else:
            props = schema.get("properties", {}) or {}
        fields = [(n, (p.get("type") or "object")) for n, p in props.items()]
        return ref_name, fields

    def parse(self) -> Api360Bundle:
        b = Api360Bundle()
        info = self.spec.get("info", {})
        paths = self.spec.get("paths", {}) or {}

        ref_to_endpoints: dict[str, list[str]] = {}

        for path, ops in paths.items():
            if not isinstance(ops, dict):
                continue
            for method, op in ops.items():
                if method.lower() not in ("get", "post", "put", "delete", "patch"):
                    continue
                if not isinstance(op, dict):
                    continue
                ep = ApiEndpoint(
                    source_id=self.source_id,
                    method=method.upper(),
                    path=path,
                    operation_id=op.get("operationId"),
                    summary=op.get("summary") or op.get("description"),
                    owner=(op.get("x-owner") if isinstance(op, dict) else None),
                )

                # primary response schema -> fields + ref object
                schema = self._response_schema(op)
                ref_name, fields = self._schema_fields(schema) if schema else (None, [])
                ep.ref_object = ref_name
                b.endpoints.append(ep)

                if ref_name:
                    ref_to_endpoints.setdefault(ref_name, []).append(ep.endpoint_key)

                for fname, ftype in fields:
                    desc = self.dictionary.get(fname.lower())
                    b.fields.append(ApiField(
                        source_id=self.source_id,
                        endpoint_key=ep.endpoint_key,
                        name=fname,
                        data_type=ftype,
                        is_key=_looks_like_key(fname),
                        description=desc,
                        ref_object=ref_name,
                    ))

        # dependency edges: endpoints that share a $ref object are related
        for ref_name, eps in ref_to_endpoints.items():
            for i in range(len(eps)):
                for j in range(i + 1, len(eps)):
                    b.dependencies.append(ApiDependency(
                        source_id=self.source_id,
                        from_endpoint=eps[i],
                        to_endpoint=eps[j],
                        kind="ref",
                        via=ref_name,
                    ))

        b.sources.append(ApiSource(
            source_id=self.source_id,
            name=info.get("title", self.source_id),
            kind="openapi" if str(self.spec.get("openapi", "")).startswith("3") else "swagger2",
            version=info.get("version"),
            spec_path=self.spec_path,
            endpoint_count=len(b.endpoints),
            field_count=len(b.fields),
        ))
        return b

    @staticmethod
    def _response_schema(op: dict) -> dict | None:
        resp = op.get("responses", {}) or {}
        ok = resp.get("200") or resp.get("201") or next(iter(resp.values()), {})
        if not isinstance(ok, dict):
            return None
        # OpenAPI 3: responses.200.content.application/json.schema
        content = ok.get("content", {})
        if content:
            for _, media in content.items():
                if isinstance(media, dict) and "schema" in media:
                    return media["schema"]
        # Swagger 2: responses.200.schema
        return ok.get("schema")


# --------------------------------------------------------------------------
# Postman collection parsing
# --------------------------------------------------------------------------
_VAR = re.compile(r"\{\{(\w+)\}\}")


class PostmanParser:
    """Parses a Postman v2.1 collection into flows/steps/edges.

    Each top-level folder becomes a flow; each request becomes an ordered step.
    {{variables}} in a request URL/body are the inputs; values captured in a
    request's test script (pm.*.set) are the outputs feeding later steps.
    """

    def __init__(self, source_id: str, coll: dict, spec_path: str = ""):
        self.source_id = source_id
        self.coll = coll
        self.spec_path = spec_path

    def parse(self) -> Api360Bundle:
        b = Api360Bundle()
        info = self.coll.get("info", {})
        items = self.coll.get("item", []) or []

        for folder in items:
            # a folder with nested items == a flow; a bare request == single-step flow
            if "item" in folder:
                self._flow_from_folder(folder, b)
            else:
                self._flow_from_folder({"name": folder.get("name", "request"),
                                        "item": [folder]}, b)

        b.sources.append(ApiSource(
            source_id=self.source_id,
            name=info.get("name", self.source_id),
            kind="postman",
            version=(info.get("version") if isinstance(info.get("version"), str) else None),
            spec_path=self.spec_path,
            flow_count=len(b.flows),
        ))
        return b

    def _flow_from_folder(self, folder: dict, b: Api360Bundle):
        name = folder.get("name", "flow")
        desc = folder.get("description") if isinstance(folder.get("description"), str) else None
        flow = ApiFlow(source_id=self.source_id, name=name, description=desc)
        steps_raw = folder.get("item", []) or []
        prev_outputs: list[tuple[str, str]] = []  # (step_key, var) produced so far

        step_objs: list[ApiFlowStep] = []
        for i, req_item in enumerate(steps_raw, start=1):
            req = req_item.get("request", {})
            method = (req.get("method") or "GET").upper()
            url = req.get("url", {})
            raw_url = url.get("raw") if isinstance(url, dict) else url
            path = self._path_of(raw_url)
            inputs = sorted(set(_VAR.findall(raw_url or "")))
            # also scan body
            body = req.get("body", {})
            if isinstance(body, dict):
                inputs += [v for v in _VAR.findall(json.dumps(body)) if v not in inputs]
            outputs = self._captured_vars(req_item)

            step = ApiFlowStep(
                source_id=self.source_id,
                flow_key=flow.flow_key,
                step_no=i,
                method=method,
                path=path,
                endpoint_key=f"{self.source_id}:{method}:{path}".lower(),
                note=req_item.get("name"),
                input_vars=", ".join(inputs) if inputs else None,
                output_vars=", ".join(outputs) if outputs else None,
            )
            step_objs.append(step)
            b.steps.append(step)

            # edge: any prior step that produced a var this step consumes
            for var in inputs:
                for (src_step_key, src_var) in prev_outputs:
                    if src_var == var:
                        b.flow_edges.append(ApiFlowEdge(
                            flow_key=flow.flow_key,
                            from_step=src_step_key,
                            to_step=step.step_key,
                            variable=var,
                        ))
            for ov in outputs:
                prev_outputs.append((step.step_key, ov))

        # if no var-based edges were found, chain sequentially so the flow still renders
        if not b.flow_edges and len(step_objs) > 1:
            for a, c in zip(step_objs, step_objs[1:]):
                b.flow_edges.append(ApiFlowEdge(
                    flow_key=flow.flow_key, from_step=a.step_key,
                    to_step=c.step_key, variable=None))

        flow.step_count = len(step_objs)
        b.flows.append(flow)

    @staticmethod
    def _path_of(raw_url: str | None) -> str:
        if not raw_url:
            return "/"
        # strip protocol/host and query
        u = re.sub(r"^https?://[^/]+", "", raw_url)
        u = u.split("?")[0]
        # collapse {{baseUrl}} style host vars
        u = re.sub(r"^\{\{[^}]+\}\}", "", u)
        return u or "/"

    @staticmethod
    def _captured_vars(req_item: dict) -> list[str]:
        """Vars set in a test script: pm.collectionVariables.set("x", ...) / pm.environment.set."""
        out: list[str] = []
        for ev in req_item.get("event", []) or []:
            if ev.get("listen") == "test":
                script = "\n".join(ev.get("script", {}).get("exec", []) or [])
                out += re.findall(r'\.set\(\s*["\'](\w+)["\']', script)
        return sorted(set(out))


# --------------------------------------------------------------------------
# top-level connector
# --------------------------------------------------------------------------
class Api360Connector:
    """Reads swagger + postman files from configured paths and returns one bundle."""

    def __init__(self,
                 swagger_paths: list[str] | None = None,
                 postman_paths: list[str] | None = None,
                 dictionary_path: str | None = None):
        self.swagger_paths = swagger_paths or []
        self.postman_paths = postman_paths or []
        self.dictionary_path = dictionary_path

    @classmethod
    def from_env(cls) -> "Api360Connector":
        sw = _collect(os.getenv("API360_SWAGGER_PATH"), os.getenv("API360_SWAGGER_DIR"),
                      (".json", ".yaml", ".yml"))
        pm = _collect(os.getenv("API360_POSTMAN_PATH"), os.getenv("API360_POSTMAN_DIR"),
                      (".json",))
        return cls(sw, pm, os.getenv("API360_DICTIONARY_PATH"))

    def _dictionary(self) -> dict:
        if not self.dictionary_path or not Path(self.dictionary_path).exists():
            return {}
        d: dict[str, str] = {}
        with open(self.dictionary_path, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                # accept field/definition or name/description headers
                key = (row.get("field") or row.get("name") or "").strip().lower()
                val = (row.get("definition") or row.get("description") or "").strip()
                if key:
                    d[key] = val
        return d

    def extract(self) -> Api360Bundle:
        bundle = Api360Bundle()
        dictionary = self._dictionary()

        for sp in self.swagger_paths:
            source_id = _source_id_from_path(sp)
            spec = _load_file(sp)
            sub = SwaggerParser(source_id, spec, sp, dictionary).parse()
            _merge(bundle, sub)

        for pp in self.postman_paths:
            source_id = _source_id_from_path(pp) + "_flows"
            coll = _load_file(pp)
            sub = PostmanParser(source_id, coll, pp).parse()
            _merge(bundle, sub)

        return bundle


def _collect(single: str | None, directory: str | None, exts: tuple) -> list[str]:
    out: list[str] = []
    if single and Path(single).exists():
        out.append(single)
    if directory and Path(directory).is_dir():
        for p in sorted(Path(directory).iterdir()):
            if p.suffix.lower() in exts and str(p) not in out:
                out.append(str(p))
    return out


def _source_id_from_path(path: str) -> str:
    stem = Path(path).stem.lower()
    return re.sub(r"[^a-z0-9_]+", "_", stem)


def _merge(into: Api360Bundle, sub: Api360Bundle):
    into.sources += sub.sources
    into.endpoints += sub.endpoints
    into.fields += sub.fields
    into.dependencies += sub.dependencies
    into.flows += sub.flows
    into.steps += sub.steps
    into.flow_edges += sub.flow_edges
