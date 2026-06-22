"""
Connector base. Each source platform implements extract_datasets().
The ingestion DAG loops over registered connectors uniformly.
"""
from __future__ import annotations
from abc import ABC, abstractmethod
from .model import Dataset


class ConnectorBase(ABC):
    """One instance per registered source (platform_id)."""

    kind: str = ""              # 'oracle' | 'mssql'
    sqlglot_dialect: str = ""   # 'oracle' | 'tsql'

    def __init__(self, platform_id: str, conn, schemas: list[str] | None = None):
        self.platform_id = platform_id
        self.conn = conn                       # live DBAPI connection
        self.schemas = schemas                 # restrict harvest to these schemas

    @abstractmethod
    def extract_datasets(self) -> list[Dataset]:
        """Return datasets + their columns from the source catalog."""
        ...

    def _schema_filter_sql(self, col: str) -> str:
        if not self.schemas:
            return "1=1"
        names = ",".join(f"'{s.upper()}'" for s in self.schemas)
        return f"UPPER({col}) IN ({names})"
