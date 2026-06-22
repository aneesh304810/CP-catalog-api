"""
SQL Server connector. Harvests tables/views, columns, types, MS_Description
extended properties and PKs. Works with pyodbc.
"""
from __future__ import annotations
from collections import defaultdict
from .model import Dataset, Column
from .base import ConnectorBase


class SqlServerConnector(ConnectorBase):
    kind = "mssql"
    sqlglot_dialect = "tsql"

    def extract_datasets(self) -> list[Dataset]:
        cur = self.conn.cursor()
        sch = self._schema_filter_sql("TABLE_SCHEMA")

        cur.execute("SELECT DB_NAME()")
        database = cur.fetchone()[0]

        # objects
        cur.execute(f"""
            SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
            FROM   INFORMATION_SCHEMA.TABLES
            WHERE  {sch}
        """)
        objects = {
            (s, n): ("VIEW" if t == "VIEW" else "TABLE")
            for (s, n, t) in cur.fetchall()
        }

        # columns
        cur.execute(f"""
            SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION,
                   DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION,
                   NUMERIC_SCALE, IS_NULLABLE
            FROM   INFORMATION_SCHEMA.COLUMNS
            WHERE  {sch}
            ORDER  BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
        """)
        cols_by_obj = defaultdict(list)
        rows = cur.fetchall()

        # primary keys
        cur.execute(f"""
            SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME
            FROM   INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
            JOIN   INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
              ON   tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
            WHERE  tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
              AND  {self._schema_filter_sql('ku.TABLE_SCHEMA')}
        """)
        pks = {(s, t, c) for (s, t, c) in cur.fetchall()}

        # extended-property descriptions (table + column level)
        cur.execute("""
            SELECT sch.name, o.name, c.name AS col, CAST(ep.value AS NVARCHAR(MAX))
            FROM   sys.extended_properties ep
            JOIN   sys.objects o   ON ep.major_id = o.object_id
            JOIN   sys.schemas sch ON o.schema_id = sch.schema_id
            LEFT   JOIN sys.columns c
                   ON ep.major_id = c.object_id AND ep.minor_id = c.column_id
            WHERE  ep.name = 'MS_Description'
        """)
        tdesc, cdesc = {}, {}
        for (s, o, col, val) in cur.fetchall():
            if col is None:
                tdesc[(s, o)] = val
            else:
                cdesc[(s, o, col)] = val

        for (s, t, cname, pos, dtype, clen, prec, scale, nullable) in rows:
            cols_by_obj[(s, t)].append(Column(
                name=cname,
                ordinal=pos or 0,
                data_type=self._fmt_type(dtype, clen, prec, scale),
                is_nullable=(nullable == 'YES'),
                is_pk=(s, t, cname) in pks,
                tech_desc=cdesc.get((s, t, cname)),
            ))

        datasets = []
        for (s, n), otype in objects.items():
            datasets.append(Dataset(
                platform_id=self.platform_id,
                database=database,
                schema=s,
                object_name=n,
                object_type=otype,
                tech_desc=tdesc.get((s, n)),
                columns=cols_by_obj.get((s, n), []),
            ))
        cur.close()
        return datasets

    @staticmethod
    def _fmt_type(dtype, clen, prec, scale) -> str:
        if dtype in ("varchar", "nvarchar", "char", "nchar") and clen:
            length = "max" if clen == -1 else clen
            return f"{dtype}({length})"
        if dtype in ("decimal", "numeric") and prec:
            return f"{dtype}({prec},{scale or 0})"
        return dtype
