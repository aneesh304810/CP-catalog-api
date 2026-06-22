"""
API 360 loader mixin.

Add these methods to the existing ingestion/loader.py Loader class (or use this
as a standalone helper that takes the same cursor). They MERGE the Api360Bundle
into the api_* tables idempotently, matching the existing loader's _merge style.

Usage in ingestion/run.py:

    from ingestion.api360_conn import Api360Connector
    from ingestion.api360_loader import load_api360

    if "api360" in steps:
        bundle = Api360Connector.from_env().extract()
        load_api360(loader, bundle)
"""
from __future__ import annotations


def load_api360(loader, bundle) -> dict:
    """Upsert a full Api360Bundle. `loader` must expose ._merge(table, pk, dict)
    and .commit() exactly like the existing Loader."""
    counts = {}

    for s in bundle.sources:
        loader._merge("api_sources", "source_id", {
            "source_id": s.source_id, "name": s.name, "kind": s.kind,
            "version": s.version, "spec_path": s.spec_path,
            "endpoint_count": s.endpoint_count, "field_count": s.field_count,
            "flow_count": s.flow_count,
        })
    counts["sources"] = len(bundle.sources)

    for e in bundle.endpoints:
        loader._merge("api_endpoints", "endpoint_key", {
            "endpoint_key": e.endpoint_key, "source_id": e.source_id,
            "method": e.method, "path": e.path, "operation_id": e.operation_id,
            "summary": e.summary, "ref_object": e.ref_object, "owner": e.owner,
        })
    counts["endpoints"] = len(bundle.endpoints)

    for f in bundle.fields:
        loader._merge("api_fields", "field_key", {
            "field_key": f.field_key, "endpoint_key": f.endpoint_key,
            "source_id": f.source_id, "name": f.name, "data_type": f.data_type,
            "is_key": "Y" if f.is_key else "N",
            "nullable": "Y" if f.nullable else "N",
            "description": f.description, "ref_object": f.ref_object,
        })
    counts["fields"] = len(bundle.fields)

    for d in bundle.dependencies:
        loader._merge("api_dependencies", "edge_id", {
            "edge_id": d.edge_id, "source_id": d.source_id,
            "from_endpoint": d.from_endpoint, "to_endpoint": d.to_endpoint,
            "kind": d.kind, "via": d.via,
        })
    counts["dependencies"] = len(bundle.dependencies)

    for fl in bundle.flows:
        loader._merge("api_flows", "flow_key", {
            "flow_key": fl.flow_key, "source_id": fl.source_id, "name": fl.name,
            "description": fl.description, "owner": fl.owner,
            "schedule": fl.schedule, "step_count": fl.step_count,
        })
    counts["flows"] = len(bundle.flows)

    for st in bundle.steps:
        loader._merge("api_flow_steps", "step_key", {
            "step_key": st.step_key, "flow_key": st.flow_key,
            "source_id": st.source_id, "step_no": st.step_no, "method": st.method,
            "path": st.path, "endpoint_key": st.endpoint_key, "note": st.note,
            "input_vars": st.input_vars, "output_vars": st.output_vars,
        })
    counts["steps"] = len(bundle.steps)

    for fe in bundle.flow_edges:
        loader._merge("api_flow_edges", "edge_id", {
            "edge_id": fe.edge_id, "flow_key": fe.flow_key,
            "from_step": fe.from_step, "to_step": fe.to_step,
            "variable": fe.variable,
        })
    counts["flow_edges"] = len(bundle.flow_edges)

    loader.commit()
    return counts
