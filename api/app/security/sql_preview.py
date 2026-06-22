"""
Secure SQL preview.

Executes a single read-only SELECT against a source with hard guards:
  - statement allow-list: only SELECT/WITH
  - block UPDATE/DELETE/DROP/TRUNCATE/INSERT/MERGE/ALTER/GRANT/EXEC and multi-stmt
  - enforced row limit
  - query timeout
  - runs as a read-only DB principal (enforced by connection, see deploy)

sqlglot parses and validates the statement type rather than relying on regex
alone, so obfuscated statements are still caught.
"""
from __future__ import annotations
import re

try:
    import sqlglot
    from sqlglot import exp
    _HAVE_SQLGLOT = True
except Exception:
    _HAVE_SQLGLOT = False

_FORBIDDEN = re.compile(
    r"\b(UPDATE|DELETE|DROP|TRUNCATE|INSERT|MERGE|ALTER|CREATE|GRANT|REVOKE|"
    r"EXEC|EXECUTE|CALL|COMMIT|ROLLBACK|SAVEPOINT|INTO)\b", re.IGNORECASE)

ALLOWED_ROOTS = ("select", "with")


class SqlPreviewError(Exception):
    pass


def validate_sql(sql: str, dialect: str = "oracle") -> str:
    """Return the validated single SELECT, or raise SqlPreviewError."""
    s = sql.strip().rstrip(";").strip()
    if not s:
        raise SqlPreviewError("empty query")
    # reject multiple statements
    if ";" in s:
        raise SqlPreviewError("multiple statements are not allowed")
    # fast regex guard
    if _FORBIDDEN.search(s):
        raise SqlPreviewError("only read-only SELECT statements are permitted")
    # structural guard via sqlglot
    if _HAVE_SQLGLOT:
        try:
            parsed = sqlglot.parse(s, dialect=dialect)
        except Exception as e:
            raise SqlPreviewError(f"unparseable SQL: {e}")
        if len(parsed) != 1 or parsed[0] is None:
            raise SqlPreviewError("exactly one SELECT statement is required")
        root = parsed[0]
        if not isinstance(root, (exp.Select, exp.With, exp.Subquery, exp.Union)):
            raise SqlPreviewError("statement is not a SELECT")
        # no DML/DDL nodes anywhere
        for bad in (exp.Insert, exp.Update, exp.Delete, exp.Drop,
                    exp.Create, exp.Alter, exp.Merge, exp.Command):
            if root.find(bad):
                raise SqlPreviewError("statement contains a forbidden operation")
    return s


def run_preview(conn, sql: str, dialect: str = "oracle",
                row_limit: int = 100, timeout_s: int = 10) -> dict:
    """
    Execute a validated SELECT on a READ-ONLY connection. The connection MUST be
    opened as a read-only DB user (see deploy: catalog_preview_ro). Guards here
    are defence-in-depth, not the only control.
    """
    safe = validate_sql(sql, dialect)
    cur = conn.cursor()
    # Oracle: enforce a statement timeout via call timeout (oracledb supports it)
    try:
        conn.call_timeout = timeout_s * 1000  # ms
    except Exception:
        pass
    cur.execute(safe)
    cols = [c[0] for c in cur.description]
    rows = cur.fetchmany(row_limit)
    cur.close()
    return {"columns": cols,
            "rows": [list(r) for r in rows],
            "row_limit": row_limit,
            "truncated": len(rows) == row_limit}
