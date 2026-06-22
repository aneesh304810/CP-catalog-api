"""
Quality / gate / freshness connector.

Parses dbt artifacts produced by `dbt build` / `dbt test` / `dbt source freshness`:
  - run_results.json  -> per-test pass/fail -> QualityResult rows
  - manifest.json     -> map test unique_id back to the dataset + dimension
  - sources.json      -> source freshness -> FreshnessSnapshot rows (optional)

Gate evaluation is OBSERVE-ONLY: we roll quality results up to a verdict per
model and per layer boundary and record it. Nothing is enforced.

Dimensions are inferred from dbt test names (unique/not_null/relationships/
accepted_values/...) and from any 'dimension' meta tag on the test.
"""
from __future__ import annotations
import json
import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .model import dataset_key


@dataclass
class QualityResult:
    dataset_key: str
    column_name: Optional[str]
    test_name: str
    dimension: str
    status: str
    observed_value: Optional[float]
    threshold: Optional[float]
    message: Optional[str]
    run_id: Optional[str]
    run_ts: Optional[str]

    @property
    def result_id(self) -> str:
        raw = f"{self.dataset_key}|{self.test_name}|{self.run_ts}"
        return hashlib.sha1(raw.encode()).hexdigest()


@dataclass
class GateEvaluation:
    gate_name: str
    scope_type: str
    scope_key: str
    verdict: str
    blocking: bool
    rules_total: int
    rules_passed: int
    rules_failed: int
    detail: str
    run_id: Optional[str]
    run_ts: Optional[str]

    @property
    def gate_eval_id(self) -> str:
        raw = f"{self.scope_key}|{self.gate_name}|{self.run_ts}"
        return hashlib.sha1(raw.encode()).hexdigest()


@dataclass
class FreshnessSnapshot:
    dataset_key: str
    row_count: Optional[int]
    max_loaded_at: Optional[str]
    lag_minutes: Optional[float]
    status: str
    captured_ts: str

    @property
    def snapshot_id(self) -> str:
        raw = f"{self.dataset_key}|{self.captured_ts}"
        return hashlib.sha1(raw.encode()).hexdigest()


# test name -> quality dimension
_DIMENSION_MAP = {
    "not_null": "completeness",
    "unique": "uniqueness",
    "relationships": "consistency",
    "accepted_values": "validity",
    "accepted_range": "validity",
    "freshness": "freshness",
}


class QualityConnector:
    def __init__(self, platform_id: str, run_results_path: str,
                 manifest_path: str, sources_path: str | None = None,
                 warn_threshold: float = 95.0):
        self.platform_id = platform_id
        self.run_results_path = Path(run_results_path)
        self.manifest_path = Path(manifest_path)
        self.sources_path = Path(sources_path) if sources_path else None
        self.warn_threshold = warn_threshold
        self._manifest = None

    def load(self):
        self._manifest = json.loads(self.manifest_path.read_text())
        return self

    # ---- quality results ----------------------------------------------
    def extract_quality(self) -> list[QualityResult]:
        rr = json.loads(self.run_results_path.read_text())
        nodes = self._manifest["nodes"]
        run_id = rr.get("metadata", {}).get("invocation_id")
        gen_at = rr.get("metadata", {}).get("generated_at")

        out: list[QualityResult] = []
        for res in rr.get("results", []):
            uid = res.get("unique_id", "")
            node = nodes.get(uid)
            if not node or node.get("resource_type") != "test":
                continue
            ds_key, col = self._test_target(node)
            if not ds_key:
                continue
            dim = self._dimension(node)
            status = self._status(res.get("status"))
            failures = res.get("failures")
            out.append(QualityResult(
                dataset_key=ds_key, column_name=col,
                test_name=node.get("name", uid.split(".")[-1]),
                dimension=dim, status=status,
                observed_value=float(failures) if failures is not None else None,
                threshold=0.0,
                message=(res.get("message") or "")[:1990] or None,
                run_id=run_id, run_ts=gen_at))
        return out

    # ---- gate evaluations (observe-only) ------------------------------
    def extract_gates(self, quality: list[QualityResult]) -> list[GateEvaluation]:
        by_ds: dict[str, list[QualityResult]] = {}
        for q in quality:
            by_ds.setdefault(q.dataset_key, []).append(q)

        gates: list[GateEvaluation] = []
        for ds_key, results in by_ds.items():
            total = len(results)
            failed = sum(1 for r in results if r.status in ("fail", "error"))
            passed = sum(1 for r in results if r.status == "pass")
            pct = 100 * passed / total if total else 100
            verdict = ("fail" if failed > 0 else
                       "warn" if pct < self.warn_threshold else "pass")
            run_ts = results[0].run_ts if results else None
            detail = json.dumps([
                {"test": r.test_name, "dim": r.dimension, "status": r.status}
                for r in results])
            gates.append(GateEvaluation(
                gate_name=f"model:{ds_key.split('.')[-1]}",
                scope_type="dataset", scope_key=ds_key,
                verdict=verdict, blocking=(verdict == "fail"),
                rules_total=total, rules_passed=passed, rules_failed=failed,
                detail=detail,
                run_id=results[0].run_id if results else None, run_ts=run_ts))
        return gates

    # ---- freshness -----------------------------------------------------
    def extract_freshness(self) -> list[FreshnessSnapshot]:
        if not (self.sources_path and self.sources_path.exists()):
            return []
        data = json.loads(self.sources_path.read_text())
        now = datetime.now(timezone.utc)
        out = []
        for res in data.get("results", []):
            node = res.get("unique_id", "")
            src = self._manifest.get("sources", {}).get(node, {})
            if not src:
                continue
            ds_key = dataset_key(self.platform_id, src.get("database"),
                                 src.get("schema"),
                                 src.get("identifier") or src.get("name"))
            max_loaded = res.get("max_loaded_at")
            lag = None
            if max_loaded:
                try:
                    ml = datetime.fromisoformat(max_loaded.replace("Z", "+00:00"))
                    lag = (now - ml).total_seconds() / 60
                except Exception:
                    pass
            status = {"pass": "fresh", "warn": "stale",
                      "error": "stale", "runtime error": "error"}.get(
                          res.get("status"), "fresh")
            out.append(FreshnessSnapshot(
                dataset_key=ds_key, row_count=None, max_loaded_at=max_loaded,
                lag_minutes=lag, status=status,
                captured_ts=now.isoformat()))
        return out

    # ---- helpers -------------------------------------------------------
    def _test_target(self, node) -> tuple[Optional[str], Optional[str]]:
        """Resolve a test node to (dataset_key, column_name)."""
        col = (node.get("column_name")
               or (node.get("test_metadata", {}) or {}).get("kwargs", {}).get("column_name"))
        # the dataset the test attaches to = its first model/source dependency
        deps = node.get("depends_on", {}).get("nodes", [])
        nodes = self._manifest["nodes"]
        sources = self._manifest.get("sources", {})
        for dep in deps:
            if dep in nodes:
                n = nodes[dep]
                key = dataset_key(self.platform_id, n.get("database"),
                                  n.get("schema"),
                                  n.get("identifier") or n.get("alias") or n.get("name"))
                return key, col
            if dep in sources:
                s = sources[dep]
                key = dataset_key(self.platform_id, s.get("database"),
                                  s.get("schema"),
                                  s.get("identifier") or s.get("name"))
                return key, col
        return None, col

    def _dimension(self, node) -> str:
        meta = (node.get("meta") or {})
        if meta.get("dimension"):
            return meta["dimension"]
        name = node.get("name", "").lower()
        tmeta = (node.get("test_metadata") or {}).get("name", "").lower()
        for key, dim in _DIMENSION_MAP.items():
            if key in name or key in tmeta:
                return dim
        return "validity"

    @staticmethod
    def _status(dbt_status) -> str:
        s = (dbt_status or "").lower()
        if s in ("pass", "success"):
            return "pass"
        if s in ("fail",):
            return "fail"
        if s in ("warn",):
            return "warn"
        if s in ("error", "runtime error"):
            return "error"
        return "skipped"
