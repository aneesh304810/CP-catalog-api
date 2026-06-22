"""
Common normalized metadata model.
Every connector emits these dataclasses regardless of source platform,
so the ingestion layer never has to branch on platform kind.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional


def dataset_key(platform_id: str, database: str | None,
                schema: str | None, obj: str) -> str:
    """Global canonical id: platform.database.schema.object (lower-cased)."""
    parts = [platform_id, database or "_", schema or "_", obj]
    return ".".join(p.lower() for p in parts)


def column_key(ds_key: str, column: str) -> str:
    return f"{ds_key}.{column.lower()}"


@dataclass
class Column:
    name: str
    ordinal: int
    data_type: str
    is_nullable: bool = True
    is_pk: bool = False
    tech_desc: Optional[str] = None


@dataclass
class Dataset:
    platform_id: str
    database: Optional[str]
    schema: Optional[str]
    object_name: str
    object_type: str = "TABLE"           # TABLE | VIEW
    layer: Optional[str] = None
    tech_desc: Optional[str] = None
    owner: Optional[str] = None
    row_count: Optional[int] = None
    columns: list[Column] = field(default_factory=list)

    @property
    def key(self) -> str:
        return dataset_key(self.platform_id, self.database,
                           self.schema, self.object_name)


@dataclass
class Transformation:
    target_key: str
    transform_type: str                  # dbt_model | view | manual
    dbt_model: Optional[str] = None
    compiled_sql: Optional[str] = None
    raw_sql: Optional[str] = None


@dataclass
class TableEdge:
    from_key: str
    to_key: str
    source: str                          # dbt | sqlglot | manual
    transform_id: Optional[str] = None

    @property
    def edge_id(self) -> str:
        return f"{self.from_key}>{self.to_key}"


@dataclass
class ColumnEdge:
    from_column: str                     # column_key
    to_column: str                       # column_key
    transform_expr: Optional[str] = None
    source: str = "sqlglot"

    @property
    def edge_id(self) -> str:
        return f"{self.from_column}>{self.to_column}"
