"""
Oracle connector. Harvests tables/views, columns, types, comments and PKs
from the Oracle data dictionary. Works with oracledb (thin mode).
"""
from __future__ import annotations
from collections import defaultdict
from .model import Dataset, Column
from .base import ConnectorBase


class OracleConnector(ConnectorBase):
    kind = "oracle"
    sqlglot_dialect = "oracle"

    def extract_datasets(self) -> list[Dataset]:
        cur = self.conn.cursor()
        sch = self._schema_filter_sql("owner")

        # objects (tables + views)
        cur.execute(f"""
            SELECT owner, object_name, object_type
            FROM   all_objects
            WHERE  object_type IN ('TABLE','VIEW') AND {sch}
        """)
        objects = {(o, n): t for (o, n, t) in cur.fetchall()}

        # table comments
        cur.execute(f"""
            SELECT owner, table_name, comments
            FROM   all_tab_comments WHERE {sch}
        """)
        tcomments = {(o, n): c for (o, n, c) in cur.fetchall()}

        # column comments
        cur.execute(f"""
            SELECT owner, table_name, column_name, comments
            FROM   all_col_comments WHERE {sch}
        """)
        ccomments = {(o, t, c): cm for (o, t, c, cm) in cur.fetchall()}

        # primary key columns
        cur.execute(f"""
            SELECT acc.owner, acc.table_name, acc.column_name
            FROM   all_constraints ac
            JOIN   all_cons_columns acc
              ON   ac.owner = acc.owner AND ac.constraint_name = acc.constraint_name
            WHERE  ac.constraint_type = 'P' AND {self._schema_filter_sql('ac.owner')}
        """)
        pks = {(o, t, c) for (o, t, c) in cur.fetchall()}

        # columns
        cur.execute(f"""
            SELECT owner, table_name, column_name, column_id,
                   data_type, data_length, data_precision, data_scale, nullable
            FROM   all_tab_columns WHERE {sch}
            ORDER  BY owner, table_name, column_id
        """)
        cols_by_obj: dict = defaultdict(list)
        for (owner, tbl, cname, cid, dtype, dlen, dprec, dscale, nullable) in cur.fetchall():
            cols_by_obj[(owner, tbl)].append(Column(
                name=cname,
                ordinal=cid or 0,
                data_type=self._fmt_type(dtype, dlen, dprec, dscale),
                is_nullable=(nullable == 'Y'),
                is_pk=(owner, tbl, cname) in pks,
                tech_desc=ccomments.get((owner, tbl, cname)),
            ))

        datasets = []
        for (owner, name), otype in objects.items():
            datasets.append(Dataset(
                platform_id=self.platform_id,
                database=None,                # Oracle: schema == owner
                schema=owner,
                object_name=name,
                object_type=otype,
                tech_desc=tcomments.get((owner, name)),
                columns=cols_by_obj.get((owner, name), []),
            ))
        cur.close()
        return datasets

    @staticmethod
    def _fmt_type(dtype, dlen, dprec, dscale) -> str:
        if dtype in ("VARCHAR2", "CHAR", "NVARCHAR2", "RAW") and dlen:
            return f"{dtype}({dlen})"
        if dtype == "NUMBER" and dprec:
            return f"NUMBER({dprec},{dscale or 0})"
        return dtype
