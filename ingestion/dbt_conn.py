"""
dbt connector. Parses target/manifest.json (+ optional catalog.json) to produce:
  - dbt_models (with compiled SQL = the transformation rule, materialization, tests)
  - table-level lineage edges  source/model -> model -> produced table
  - the produced-dataset mapping (model -> relation it materializes in the DB)

This is the authoritative source for TABLE lineage (dbt's own ref/source graph),
so sqlglot is NOT used at the table level - only later for COLUMN lineage.

No DB access needed; pure file parse. Safe to run anywhere the dbt target/
artifacts are mounted (e.g. an artifacts PVC written by the dbt build).
"""
from __future__ import annotations
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .model import Dataset, Column, Transformation, TableEdge, dataset_key


@dataclass
class DbtModel:
    model_key: str               # <project>.<model_name>
    name: str
    project: str
    schema: str
    database: Optional[str]
    materialization: str
    layer: Optional[str]
    description: Optional[str]
    compiled_sql: Optional[str]
    raw_sql: Optional[str]
    tests: list[str] = field(default_factory=list)
    depends_on: list[str] = field(default_factory=list)   # upstream unique_ids
    produced_key: str = ""       # dataset_key of the relation it materializes
    columns: list[Column] = field(default_factory=list)
    unique_id: str = ""


class DbtConnector:
    """
    platform_id: the platform the dbt models materialize INTO (e.g. 'oracle_prod').
    This lets produced tables share keys with the Oracle connector's datasets.
    """
    def __init__(self, platform_id: str, manifest_path: str,
                 catalog_path: str | None = None,
                 layer_from_tag: bool = True):
        self.platform_id = platform_id
        self.manifest_path = Path(manifest_path)
        self.catalog_path = Path(catalog_path) if catalog_path else None
        self.layer_from_tag = layer_from_tag
        self._manifest = None
        self._catalog = None

    # ---- public API ----------------------------------------------------
    def load(self):
        self._manifest = json.loads(self.manifest_path.read_text())
        if self.catalog_path and self.catalog_path.exists():
            self._catalog = json.loads(self.catalog_path.read_text())
        return self

    def extract_models(self) -> list[DbtModel]:
        nodes = self._manifest["nodes"]
        # collect tests per model (data tests attach to their parent node)
        tests_by_model: dict[str, list[str]] = {}
        for uid, node in nodes.items():
            if node.get("resource_type") == "test":
                for parent in node.get("depends_on", {}).get("nodes", []):
                    tests_by_model.setdefault(parent, []).append(
                        node.get("name", uid.split(".")[-1]))

        models: list[DbtModel] = []
        for uid, node in nodes.items():
            if node.get("resource_type") != "model":
                continue
            cfg = node.get("config", {}) or {}
            mat = cfg.get("materialized", node.get("materialized", "view"))
            tags = node.get("tags", []) or []
            layer = self._infer_layer(tags, node.get("fqn", []))
            produced = self._relation_key(node)

            cols = []
            for i, (cname, cmeta) in enumerate(node.get("columns", {}).items()):
                cols.append(Column(
                    name=cname,
                    ordinal=i + 1,
                    data_type=(cmeta.get("data_type") or "").upper() or "UNKNOWN",
                    tech_desc=cmeta.get("description") or None,
                ))
            # enrich types from catalog.json when present
            if self._catalog:
                cat = self._catalog.get("nodes", {}).get(uid, {})
                cat_cols = cat.get("columns", {})
                for c in cols:
                    meta = cat_cols.get(c.name) or cat_cols.get(c.name.upper())
                    if meta and meta.get("type"):
                        c.data_type = meta["type"]

            models.append(DbtModel(
                model_key=f"{node['package_name']}.{node['name']}",
                unique_id=uid,
                name=node["name"],
                project=node["package_name"],
                schema=node.get("schema"),
                database=node.get("database"),
                materialization=mat,
                layer=layer,
                description=node.get("description") or None,
                compiled_sql=node.get("compiled_code") or node.get("compiled_sql"),
                raw_sql=node.get("raw_code") or node.get("raw_sql"),
                tests=sorted(set(tests_by_model.get(uid, []))),
                depends_on=node.get("depends_on", {}).get("nodes", []),
                produced_key=produced,
                columns=cols,
            ))
        return models

    def extract_table_lineage(self, models: list[DbtModel]) -> list[TableEdge]:
        """
        Build edges:  upstream_relation -> produced_relation
        Upstream may be a source (resource_type=source) or another model.
        We resolve each dependency unique_id to the relation key it represents.
        """
        nodes = self._manifest["nodes"]
        sources = self._manifest.get("sources", {})
        by_uid = {m.unique_id: m for m in models}
        edges: list[TableEdge] = []

        for m in models:
            for dep_uid in m.depends_on:
                up_key = None
                if dep_uid in by_uid:
                    up_key = by_uid[dep_uid].produced_key
                elif dep_uid in sources:
                    up_key = self._relation_key(sources[dep_uid])
                elif dep_uid in nodes:                      # seed / snapshot
                    up_key = self._relation_key(nodes[dep_uid])
                if up_key and m.produced_key:
                    edges.append(TableEdge(
                        from_key=up_key, to_key=m.produced_key,
                        source="dbt", transform_id=m.produced_key))
        return edges

    def extract_transformations(self, models: list[DbtModel]) -> list[Transformation]:
        return [
            Transformation(
                target_key=m.produced_key,
                transform_type="dbt_model",
                dbt_model=m.model_key,
                compiled_sql=m.compiled_sql,
                raw_sql=m.raw_sql,
            )
            for m in models if m.produced_key
        ]

    def produced_datasets(self, models: list[DbtModel]) -> list[Dataset]:
        """Datasets that the models materialize (so they exist even if the
        Oracle/MSSQL harvest hasn't seen them yet, e.g. first build)."""
        out = []
        for m in models:
            if not m.produced_key:
                continue
            out.append(Dataset(
                platform_id=self.platform_id,
                database=m.database,
                schema=m.schema,
                object_name=m.name,
                object_type="TABLE" if m.materialization in ("table", "incremental") else "VIEW",
                layer=m.layer,
                tech_desc=m.description,
                columns=m.columns,
            ))
        return out

    # ---- helpers -------------------------------------------------------
    def _relation_key(self, node: dict) -> str:
        """dataset_key for the relation a node points at."""
        db = node.get("database")
        schema = node.get("schema")
        # sources use identifier/name; models use name
        obj = node.get("identifier") or node.get("alias") or node.get("name")
        return dataset_key(self.platform_id, db, schema, obj)

    def _infer_layer(self, tags: list[str], fqn: list[str]) -> Optional[str]:
        if not self.layer_from_tag:
            return None
        hay = " ".join(tags + fqn).lower()
        for layer in ("bronze", "silver", "gold"):
            if layer in hay:
                return layer
        # common alt naming
        if "staging" in hay or "stg" in hay:
            return "bronze"
        if "mart" in hay:
            return "gold"
        return None
