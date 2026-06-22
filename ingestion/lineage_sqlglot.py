"""
Column-level lineage via sqlglot.

For each dbt model we have the COMPILED SQL (real schema/table names, no Jinja).
sqlglot.lineage() traces each output column back to the source columns and
captures the transforming expression. We emit ColumnEdge rows annotated with
the producing model.

Coverage note: clean SELECT/CTE/JOIN SQL traces reliably. SELECT * (without a
known schema), dynamic SQL, and logic pushed into PL/SQL procedures will not
resolve - those fall back to source='manual'. Passing a schema dict massively
improves SELECT * and ambiguous-column resolution.
"""
from __future__ import annotations
from typing import Optional

from .model import ColumnEdge, column_key

try:
    import sqlglot
    from sqlglot.lineage import lineage as sqlglot_lineage
    from sqlglot import exp
    _HAVE = True
except Exception:                       # pragma: no cover
    _HAVE = False


class ColumnLineageExtractor:
    """
    schema: optional {("db","schema","table"): {col: type}} to improve resolution.
    dialect: sqlglot dialect for the producing platform ('oracle' | 'tsql').
    """
    def __init__(self, dialect: str = "oracle", schema: dict | None = None):
        if not _HAVE:
            raise RuntimeError("sqlglot not installed: pip install sqlglot")
        self.dialect = dialect
        self.schema = schema or {}

    def extract_for_model(self, produced_key: str, compiled_sql: str,
                          output_columns: list[str],
                          relation_resolver) -> list[ColumnEdge]:
        """
        produced_key:    dataset_key of the table the model materializes
        compiled_sql:    model's compiled SQL (a SELECT)
        output_columns:  the model's output column names
        relation_resolver(table_name_parts) -> dataset_key for an upstream table
        """
        edges: list[ColumnEdge] = []
        if not compiled_sql:
            return edges

        for col in output_columns:
            try:
                node = sqlglot_lineage(
                    col, compiled_sql, schema=self.schema or None,
                    dialect=self.dialect)
            except Exception:
                continue  # unresolved column -> skip (manual fallback later)

            target_ck = column_key(produced_key, col)
            # walk leaves: nodes with a source table and no further upstream
            for leaf in self._leaves(node):
                src = self._leaf_source(leaf, relation_resolver)
                if not src:
                    continue
                src_key, src_col, expr = src
                edges.append(ColumnEdge(
                    from_column=column_key(src_key, src_col),
                    to_column=target_ck,
                    transform_expr=expr,
                    source="sqlglot",
                ))
        # de-dup
        seen, uniq = set(), []
        for e in edges:
            if e.edge_id not in seen:
                seen.add(e.edge_id); uniq.append(e)
        return uniq

    # ---- internals -----------------------------------------------------
    def _leaves(self, node):
        if not node.downstream:
            yield node
            return
        for d in node.downstream:
            yield from self._leaves(d)

    def _leaf_source(self, leaf, resolver) -> Optional[tuple[str, str, str]]:
        """Return (dataset_key, source_column, expr_sql) for a leaf node."""
        col_expr = leaf.expression
        # the underlying column reference
        target = None
        if isinstance(col_expr, exp.Column):
            target = col_expr
        else:
            target = col_expr.find(exp.Column)
        if target is None:
            return None

        table_name = target.table
        col_name = target.name
        # leaf.source is the table/subquery; get its real name
        src_node = getattr(leaf, "source", None)
        parts = self._table_parts(src_node, table_name)
        if not parts:
            return None
        ds_key = resolver(parts)
        if not ds_key:
            return None
        expr_sql = col_expr.sql(dialect=self.dialect)
        # 1:1 passthrough -> mark simply
        if isinstance(col_expr, exp.Column):
            expr_sql = "1:1"
        return ds_key, col_name, expr_sql

    def _table_parts(self, src_node, fallback_alias) -> Optional[tuple]:
        """Best-effort (db, schema, table) extraction."""
        tbl = None
        if src_node is not None and hasattr(src_node, "find"):
            tbl = src_node.find(exp.Table) if not isinstance(src_node, exp.Table) else src_node
        if tbl is None:
            return (None, None, fallback_alias) if fallback_alias else None
        return (tbl.catalog or None, tbl.db or None, tbl.name)
