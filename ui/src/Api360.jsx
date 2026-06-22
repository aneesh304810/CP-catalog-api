// =====================================================================
// Api360.jsx — "API 360" tab for the CP Metadata Catalog (4th top-level tab).
//
// Self-contained screen rendered when screen === "api360". Uses the catalog's
// ST tokens. FIVE inner views:
//   1. Sources        — registered Swagger / Postman artifacts
//   2. API dependency — endpoint graph + drill-down drawer
//   3. Business flow  — Postman call-sequence graph + step drill-down
//   4. Datapoint 360  — a field/datapoint across endpoints + flows
//   5. Search         — unified search over endpoints, fields, flows
//
// Real feature with the catalog's DEMO->LIVE fallback: it fetches /api360/*
// and, only if unreachable, renders embedded SEI sample data.
//
// Wire-up in App.jsx (see docs/INTEGRATION.md):
//   import Api360 from "./Api360";
//   ...add ["api360","API 360"] to the nav .map...
//   {screen === "api360" && <Api360 ST={ST} />}
// =====================================================================
import React, { useState, useEffect, useMemo, useRef } from "react";

const METHOD = { GET: "#0f766e", POST: "#7c3aed", PUT: "#2563eb", DELETE: "#dc2626", PATCH: "#ca8a04" };
const FLOW_C = "#7c3aed", CANON_C = "#0f766e";

/* =========================== DEMO data (SEI) =========================== */
const DEMO = {
  sources: [
    { source_id: "sei_swp", name: "SEI SWP", kind: "openapi", version: "v3.2", endpoint_count: 4, field_count: 11, flow_count: 2, ingested_at: "2026-06-21 14:32" },
    { source_id: "sei_swp_flows", name: "SEI Flows", kind: "postman", version: "v2.1", endpoint_count: 0, field_count: 0, flow_count: 2, ingested_at: "2026-06-21 14:32" },
  ],
  endpoints: [
    { endpoint_key: "ep_accounts", source_id: "sei_swp", method: "GET", path: "/accounts", ref_object: "Account", summary: "Returns active investment accounts.", owner: "Aneesh",
      fields: [
        { name: "accountId", data_type: "string", is_key: "Y", description: "Unique investment account identifier" },
        { name: "baseCurrency", data_type: "string", is_key: "N", description: "ISO currency of the account" },
        { name: "status", data_type: "string", is_key: "N", description: "Account lifecycle status" }],
      flows: ["Daily Reconciliation", "Position Load"] },
    { endpoint_key: "ep_positions", source_id: "sei_swp", method: "GET", path: "/positions", ref_object: "Position", summary: "Holdings per account.", owner: "Jorge",
      fields: [
        { name: "acctId", data_type: "string", is_key: "Y", description: "Account identifier for the position" },
        { name: "securityId", data_type: "string", is_key: "Y", description: "Security identifier held" },
        { name: "qty", data_type: "decimal", is_key: "N", description: "Quantity of the security held" }],
      flows: ["Daily Reconciliation", "Position Load"] },
    { endpoint_key: "ep_transactions", source_id: "sei_swp", method: "GET", path: "/transactions", ref_object: "Transaction", summary: "Executed transactions for an account.", owner: "Jorge",
      fields: [
        { name: "account_no", data_type: "string", is_key: "Y", description: "Account number on the transaction" },
        { name: "tradeDate", data_type: "date", is_key: "N", description: "Date the trade executed" },
        { name: "amount", data_type: "decimal", is_key: "N", description: "Transaction amount" }],
      flows: ["Daily Reconciliation"] },
    { endpoint_key: "ep_recon", source_id: "sei_swp", method: "POST", path: "/reconciliation", ref_object: "Recon", summary: "Submit reconciliation for an account.", owner: "Hema",
      fields: [
        { name: "accountId", data_type: "string", is_key: "Y", description: "Unique investment account identifier" },
        { name: "reconId", data_type: "string", is_key: "N", description: "Reconciliation run identifier" }],
      flows: ["Daily Reconciliation"] },
  ],
  dependencies: [
    { from_endpoint: "ep_accounts", to_endpoint: "ep_positions", kind: "ref", via: "Account" },
    { from_endpoint: "ep_accounts", to_endpoint: "ep_transactions", kind: "ref", via: "Account" },
    { from_endpoint: "ep_positions", to_endpoint: "ep_recon", kind: "ref", via: "Account" },
    { from_endpoint: "ep_transactions", to_endpoint: "ep_recon", kind: "runtime", via: "recon job" },
  ],
  flows: [
    { flow_key: "fl_recon", name: "Daily Reconciliation", owner: "Hema", schedule: "06:00 weekdays",
      description: "Reconcile each account's positions and transactions.",
      steps: [
        { step_no: 1, method: "GET", path: "/accounts", endpoint_key: "ep_accounts", note: "List active accounts", input_vars: null, output_vars: "accountId" },
        { step_no: 2, method: "GET", path: "/positions", endpoint_key: "ep_positions", note: "Positions per account", input_vars: "accountId", output_vars: "securityId, qty" },
        { step_no: 3, method: "GET", path: "/transactions", endpoint_key: "ep_transactions", note: "Day's transactions", input_vars: "accountId", output_vars: "tradeDate, amount" },
        { step_no: 4, method: "POST", path: "/reconciliation", endpoint_key: "ep_recon", note: "Submit recon", input_vars: "accountId, positions, txns", output_vars: "reconId" }],
      edges: [
        { from_step: 1, to_step: 2, variable: "accountId" },
        { from_step: 1, to_step: 3, variable: "accountId" },
        { from_step: 2, to_step: 4, variable: "positions" },
        { from_step: 3, to_step: 4, variable: "txns" }] },
    { flow_key: "fl_posload", name: "Position Load", owner: "Jorge", schedule: "hourly",
      description: "Load current positions into bronze.",
      steps: [
        { step_no: 1, method: "GET", path: "/accounts", endpoint_key: "ep_accounts", note: "Account list", input_vars: null, output_vars: "accountId" },
        { step_no: 2, method: "GET", path: "/positions", endpoint_key: "ep_positions", note: "Load positions", input_vars: "accountId", output_vars: "securityId, qty" }],
      edges: [{ from_step: 1, to_step: 2, variable: "accountId" }] },
  ],
};

/* =========================== api client =========================== */
const BASE = (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_API_BASE) || "/api";
async function jget(path) {
  const res = await fetch(`${BASE}/api360${path}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

/* layout helper: columns by dependency depth */
function layoutEndpoints(endpoints, deps) {
  const depth = {}; endpoints.forEach((e) => (depth[e.endpoint_key] = 0));
  for (let i = 0; i < endpoints.length; i++)
    deps.forEach((d) => { if (depth[d.to_endpoint] <= depth[d.from_endpoint]) depth[d.to_endpoint] = depth[d.from_endpoint] + 1; });
  const byCol = {}; endpoints.forEach((e) => { const c = depth[e.endpoint_key] || 0; (byCol[c] = byCol[c] || []).push(e); });
  const pos = {};
  Object.entries(byCol).forEach(([c, list]) => list.forEach((e, i) => { pos[e.endpoint_key] = { x: 70 + Number(c) * 250, y: 80 + i * 110 }; }));
  return pos;
}

const INNER = [
  ["sources", "Sources"],
  ["api", "API dependency"],
  ["flow", "Business flow"],
  ["datapoint", "Datapoint 360"],
  ["search", "Search"],
];

export default function Api360({ ST }) {
  const t = ST;
  const [tab, setTab] = useState("api");
  const [data, setData] = useState(DEMO);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [sources, endpoints, dependencies, flows] = await Promise.all([
          jget("/sources"), jget("/endpoints"), jget("/dependencies"), jget("/flows"),
        ]);
        if (cancelled) return;
        if ((endpoints && endpoints.length) || (flows && flows.length)) {
          setData({ sources, endpoints, dependencies, flows });
          setLive(true);
        }
      } catch { /* stay DEMO */ }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: t.bg, color: t.text }}>
      {/* inner sub-nav */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: `1px solid ${t.border}`, background: t.panel, flexShrink: 0 }}>
        <div style={{ display: "flex", background: t.panel2, border: `1px solid ${t.border}`, borderRadius: 9, padding: 3, gap: 2 }}>
          {INNER.map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} style={{ border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 600,
              padding: "5px 12px", borderRadius: 6, background: tab === k ? t.accent : "transparent", color: tab === k ? "#fff" : t.sub }}>{l}</button>
          ))}
        </div>
        <span style={{ marginLeft: "auto", fontSize: 11, color: t.sub }}>{live ? "LIVE" : "DEMO data"}</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {tab === "sources" && <SourcesView t={t} data={data} />}
        {tab === "api" && <GraphView t={t} data={data} mode="api" />}
        {tab === "flow" && <GraphView t={t} data={data} mode="flow" />}
        {tab === "datapoint" && <DatapointView t={t} data={data} />}
        {tab === "search" && <SearchView t={t} data={data} />}
      </div>
    </div>
  );
}

/* =========================== 1. Sources =========================== */
function SourcesView({ t, data }) {
  const kindColor = { openapi: "#0f766e", swagger2: "#0f766e", postman: "#7c3aed", jsonschema: "#2563eb" };
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "auto", padding: 24 }}>
      <div style={{ maxWidth: 920, margin: "0 auto" }}>
        <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>Sources</h2>
        <p style={{ fontSize: 13, color: t.sub, margin: "0 0 18px", maxWidth: 720, lineHeight: 1.5 }}>
          API documentation artifacts ingested from the shared drive
          (<code style={{ fontFamily: "monospace", fontSize: 12 }}>/opt/approot/webfs/cp-datacatalog/</code>):
          Swagger / OpenAPI specs and Postman collections.
        </p>
        <div style={{ background: t.panel, border: `1px solid ${t.border}`, borderRadius: 12, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>{["Source", "Kind", "Version", "Endpoints", "Fields", "Flows", "Last ingested"].map((h) =>
              <th key={h} style={th(t)}>{h}</th>)}</tr></thead>
            <tbody>
              {(data.sources || []).map((s) => (
                <tr key={s.source_id} style={{ borderTop: `1px solid ${t.border}` }}>
                  <td style={td(t)}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 9, height: 9, borderRadius: "50%", background: kindColor[s.kind] || t.sub }} />
                      <b>{s.name}</b></span>
                    <div style={{ fontSize: 11, color: t.sub, marginLeft: 17 }}>{s.source_id}</div>
                  </td>
                  <td style={td(t)}><span style={chip(t)}>{s.kind}</span></td>
                  <td style={td(t)}>{s.version || "—"}</td>
                  <td style={td(t)}>{s.endpoint_count || 0}</td>
                  <td style={td(t)}>{s.field_count || 0}</td>
                  <td style={td(t)}>{s.flow_count || 0}</td>
                  <td style={{ ...td(t), color: t.sub, fontSize: 12 }}>{s.ingested_at || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 11.5, color: t.sub, marginTop: 12 }}>
          To refresh, drop an updated Swagger or Postman file in the webfs folder; the next ingestion run re-parses it.
        </p>
      </div>
    </div>
  );
}

/* =========================== 2&3. Graph (api | flow) =========================== */
function GraphView({ t, data, mode }) {
  const [selApi, setSelApi] = useState(null);
  const [selFlowKey, setSelFlowKey] = useState(null);
  const [selStep, setSelStep] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);
  const NW = 170, NH = 58;

  const flows = data.flows || [];
  const activeFlowKey = selFlowKey || (flows[0] && (flows[0].flow_key || flows[0].name));
  const activeFlow = flows.find((f) => (f.flow_key || f.name) === activeFlowKey) || flows[0];
  const epPos = useMemo(() => layoutEndpoints(data.endpoints || [], data.dependencies || []), [data]);

  const onMouseDown = (e) => {
    if (e.target.closest("[data-node]") || e.target.closest("button")) return;
    dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  };
  useEffect(() => {
    const move = (e) => { if (!dragRef.current) return;
      setPan({ x: dragRef.current.px + (e.clientX - dragRef.current.x), y: dragRef.current.py + (e.clientY - dragRef.current.y) }); };
    const up = () => (dragRef.current = null);
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []);

  const xf = `translate(${pan.x}px,${pan.y}px) scale(${zoom})`;
  const curve = (a, b) => { const dx = Math.max(50, (b.x - a.x) * 0.5);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`; };

  const apiGraph = () => {
    const eps = data.endpoints || [], deps = data.dependencies || [];
    return (
      <>
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
          <defs><marker id="ga" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill={t.sub} /></marker></defs>
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
            {deps.map((d, i) => {
              const pa = epPos[d.from_endpoint], pb = epPos[d.to_endpoint]; if (!pa || !pb) return null;
              const a = { x: pa.x + NW, y: pa.y + NH / 2 }, b = { x: pb.x, y: pb.y + NH / 2 };
              const hot = selApi && (d.from_endpoint === selApi || d.to_endpoint === selApi), fade = selApi && !hot;
              return <g key={i}>
                <path d={curve(a, b)} fill="none" stroke={d.kind === "runtime" ? "#ca8a04" : t.sub} strokeWidth={hot ? 2.4 : 1.5}
                  strokeDasharray={d.kind === "runtime" ? "6 4" : undefined} markerEnd="url(#ga)" opacity={fade ? 0.18 : 0.8} />
                <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6} textAnchor="middle" fontSize="9.5" fill={t.sub} opacity={fade ? 0.18 : 0.9}>{d.via}</text>
              </g>;
            })}
          </g>
        </svg>
        <div style={{ position: "absolute", inset: 0, transform: xf, transformOrigin: "0 0" }}>
          {eps.map((ep) => {
            const p = epPos[ep.endpoint_key]; if (!p) return null;
            const mc = METHOD[ep.method] || t.accent;
            const related = selApi && (selApi === ep.endpoint_key ||
              (data.dependencies || []).some((d) => (d.from_endpoint === selApi && d.to_endpoint === ep.endpoint_key) || (d.to_endpoint === selApi && d.from_endpoint === ep.endpoint_key)));
            const dim = selApi && !related;
            return <div key={ep.endpoint_key} data-node onClick={() => setSelApi(ep.endpoint_key)}
              style={{ position: "absolute", left: p.x, top: p.y, width: NW, cursor: "pointer", background: t.panel, border: `1px solid ${t.border}`,
                borderTop: `3px solid ${mc}`, borderRadius: 10, boxShadow: selApi === ep.endpoint_key ? `0 0 0 3px ${t.accent}55` : "0 1px 5px rgba(2,6,23,.08)", opacity: dim ? 0.4 : 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 11px" }}>
                <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4, background: mc + "22", color: mc }}>{ep.method}</span>
                <span style={{ fontSize: 12.5, fontWeight: 650, fontFamily: "'SF Mono',ui-monospace,monospace" }}>{ep.path}</span>
              </div>
              <div style={{ fontSize: 10, color: t.sub, padding: "0 11px 8px" }}>{(ep.fields ? ep.fields.length + " fields" : "")}{ep.ref_object ? " · " + ep.ref_object : ""}</div>
            </div>;
          })}
        </div>
      </>
    );
  };

  const flowGraph = () => {
    if (!activeFlow) return null;
    const steps = activeFlow.steps || [], edges = activeFlow.edges || [];
    const pos = {}; steps.forEach((s, i) => { pos[s.step_no] = { x: 70 + i * 230, y: 120 }; });
    return (
      <>
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
          <defs><marker id="gf" markerWidth="11" markerHeight="11" refX="9" refY="3.2" orient="auto"><path d="M0,0 L9,3.2 L0,6.4 Z" fill={FLOW_C} /></marker></defs>
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
            {edges.map((e, i) => {
              const pa = pos[e.from_step], pb = pos[e.to_step]; if (!pa || !pb) return null;
              const a = { x: pa.x + NW, y: pa.y + NH / 2 }, b = { x: pb.x, y: pb.y + NH / 2 };
              const hot = selStep && (e.from_step === selStep || e.to_step === selStep), fade = selStep && !hot;
              return <g key={i}>
                <path d={curve(a, b)} fill="none" stroke={FLOW_C} strokeWidth={hot ? 2.6 : 1.8} markerEnd="url(#gf)" opacity={fade ? 0.18 : 0.85} />
                {e.variable && <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 5} textAnchor="middle" fontSize="9.5" fill={FLOW_C} opacity={fade ? 0.3 : 1}>{"{{" + e.variable + "}}"}</text>}
              </g>;
            })}
          </g>
        </svg>
        <div style={{ position: "absolute", inset: 0, transform: xf, transformOrigin: "0 0" }}>
          {steps.map((s) => {
            const p = pos[s.step_no]; const dim = selStep && selStep !== s.step_no;
            return <div key={s.step_no} data-node onClick={() => setSelStep(s.step_no)}
              style={{ position: "absolute", left: p.x, top: p.y, width: NW, cursor: "pointer", background: t.panel, border: `1px solid ${t.border}`,
                borderLeft: `3px solid ${FLOW_C}`, borderRadius: 10, boxShadow: selStep === s.step_no ? `0 0 0 3px ${t.accent}55` : "0 1px 5px rgba(2,6,23,.08)", opacity: dim ? 0.4 : 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 11px" }}>
                <span style={{ width: 20, height: 20, borderRadius: "50%", background: FLOW_C, color: "#fff", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700 }}>{s.step_no}</span>
                <span style={{ fontSize: 12, fontWeight: 650, fontFamily: "'SF Mono',ui-monospace,monospace" }}>{s.method} {s.path}</span>
              </div>
              <div style={{ fontSize: 10, color: t.sub, padding: "0 11px 8px" }}>{s.note}</div>
            </div>;
          })}
        </div>
      </>
    );
  };

  /* drawers */
  const selEndpoint = (data.endpoints || []).find((e) => e.endpoint_key === selApi);
  const drawer = () => {
    if (mode === "api") {
      if (!selEndpoint) return <Empty t={t} text="Select an endpoint to see its fields, $ref dependencies, and the business flows that use it." />;
      const ep = selEndpoint, mc = METHOD[ep.method] || t.accent;
      const deps = (data.dependencies || []).filter((d) => d.from_endpoint === selApi || d.to_endpoint === selApi);
      return <div>
        <DH t={t}>
          <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4, background: mc + "22", color: mc }}>{ep.method}</span>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 8, fontFamily: "'SF Mono',ui-monospace,monospace" }}>{ep.path}</div>
          <div style={{ fontSize: 12.5, color: t.sub, marginTop: 4 }}>{ep.summary}</div>
        </DH>
        <div style={{ padding: 18 }}>
          <Sect t={t} title="Schema object"><KV t={t} k="$ref" v={ep.ref_object || "—"} /><KV t={t} k="Owner" v={ep.owner || "—"} /></Sect>
          <Sect t={t} title={`Fields (${(ep.fields || []).length})`}>
            {(ep.fields || []).map((f) => (
              <div key={f.name} style={{ padding: "8px 0", borderBottom: `1px solid ${t.border}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ fontFamily: "'SF Mono',ui-monospace,monospace", fontWeight: (f.is_key === "Y" || f.is_key === true) ? 700 : 400 }}>
                    {(f.is_key === "Y" || f.is_key === true) ? "🔑 " : ""}{f.name}</span>
                  <span style={chip(t)}>{f.data_type}</span></div>
                {f.description && <div style={{ fontSize: 11, color: t.sub, marginTop: 3 }}>{f.description}</div>}
              </div>))}
          </Sect>
          <Sect t={t} title={`Dependencies (${deps.length})`}>
            {deps.map((d, i) => { const other = d.from_endpoint === selApi ? d.to_endpoint : d.from_endpoint;
              const o = (data.endpoints || []).find((e) => e.endpoint_key === other);
              return <KV key={i} t={t} k={(d.from_endpoint === selApi ? "→ " : "← ") + (o ? o.path : other)} v={d.kind === "runtime" ? "runtime" : "$ref " + d.via} mono />; })}
          </Sect>
          <Sect t={t} title={`Used in flows (${(ep.flows || []).length})`}>
            {(ep.flows || []).map((fn) => <KV key={fn} t={t} k={fn} v="flow" />)}
          </Sect>
        </div>
      </div>;
    }
    // flow drawer
    if (!activeFlow) return <Empty t={t} text="No flows available." />;
    if (!selStep) return <div>
      <DH t={t}>
        <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: FLOW_C + "1e", color: FLOW_C }}>business flow</span>
        <div style={{ fontSize: 16, fontWeight: 700, marginTop: 8 }}>{activeFlow.name}</div>
        <div style={{ fontSize: 12.5, color: t.sub, marginTop: 4 }}>{activeFlow.description}</div>
      </DH>
      <div style={{ padding: 18 }}>
        <Sect t={t} title="Overview">
          <KV t={t} k="Owner" v={activeFlow.owner || "—"} /><KV t={t} k="Schedule" v={activeFlow.schedule || "—"} />
          <KV t={t} k="Steps" v={String((activeFlow.steps || []).length)} /><KV t={t} k="Source" v="SEI Postman" /></Sect>
        <Sect t={t} title="Sequence">
          {(activeFlow.steps || []).map((s) => (
            <div key={s.step_no} style={{ padding: "8px 0", borderBottom: `1px solid ${t.border}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ width: 20, height: 20, borderRadius: "50%", background: FLOW_C, color: "#fff", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700 }}>{s.step_no}</span>
                <b style={{ fontFamily: "'SF Mono',ui-monospace,monospace" }}>{s.method} {s.path}</b></div>
              <div style={{ fontSize: 11, color: t.sub, marginTop: 4 }}>in <span style={{ fontFamily: "monospace" }}>{s.input_vars || "—"}</span> · out <b style={{ color: CANON_C }}>{s.output_vars || "—"}</b></div>
            </div>))}
        </Sect>
      </div>
    </div>;
    const s = (activeFlow.steps || []).find((x) => x.step_no === selStep);
    const inE = (activeFlow.edges || []).find((e) => e.to_step === selStep);
    const outE = (activeFlow.edges || []).find((e) => e.from_step === selStep);
    return <div>
      <DH t={t}>
        <span style={{ width: 20, height: 20, borderRadius: "50%", background: FLOW_C, color: "#fff", display: "inline-grid", placeItems: "center", fontSize: 11, fontWeight: 700 }}>{s.step_no}</span>
        <div style={{ fontSize: 15, fontWeight: 700, marginTop: 8, fontFamily: "'SF Mono',ui-monospace,monospace" }}>{s.method} {s.path}</div>
        <div style={{ fontSize: 12.5, color: t.sub, marginTop: 4 }}>{s.note}</div>
      </DH>
      <div style={{ padding: 18 }}>
        <Sect t={t} title="Step I/O"><KV t={t} k="Input" v={s.input_vars || "—"} mono /><KV t={t} k="Output" v={s.output_vars || "—"} /><KV t={t} k="Position" v={`step ${s.step_no} of ${(activeFlow.steps || []).length}`} /></Sect>
        <Sect t={t} title="Data flow">
          <KV t={t} k={inE ? `← from step ${inE.from_step}` : "entry"} v={inE ? inE.variable : "first call"} mono={!!inE} />
          <KV t={t} k={outE ? "→ to next" : "terminal"} v={outE ? outE.variable : "flow output"} mono={!!outE} /></Sect>
      </div>
    </div>;
  };

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex" }}>
      <div onMouseDown={onMouseDown} style={{ flex: 1, position: "relative", overflow: "hidden", cursor: "grab",
        background: t.bg, backgroundImage: `radial-gradient(circle at 1px 1px, ${t.border} 1px, transparent 0)`, backgroundSize: "22px 22px" }}>
        {mode === "flow" && (
          <div style={{ position: "absolute", top: 14, left: 14, display: "flex", gap: 6, zIndex: 4 }}>
            {flows.map((f) => { const fk = f.flow_key || f.name;
              return <button key={fk} onClick={() => { setSelFlowKey(fk); setSelStep(null); }}
                style={{ border: `1px solid ${t.border}`, cursor: "pointer", fontSize: 12, fontWeight: 600, padding: "5px 11px", borderRadius: 7,
                  background: fk === activeFlowKey ? FLOW_C : t.panel, color: fk === activeFlowKey ? "#fff" : t.sub }}>{f.name}</button>; })}
          </div>
        )}
        {mode === "api" ? apiGraph() : flowGraph()}
        <div style={{ position: "absolute", top: 14, right: 14, display: "flex", gap: 6 }}>
          <button onClick={() => setZoom((z) => Math.min(2.2, z * 1.15))} style={zoomBtn(t)}>＋</button>
          <button onClick={() => setZoom((z) => Math.max(0.4, z / 1.15))} style={zoomBtn(t)}>－</button>
          <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} style={zoomBtn(t)}>⤢</button>
        </div>
        <div style={{ position: "absolute", left: 14, bottom: 14, background: t.panel, border: `1px solid ${t.border}`, borderRadius: 10, padding: "9px 12px", fontSize: 11.5, color: t.sub, display: "flex", flexDirection: "column", gap: 5 }}>
          {mode === "api" ? <>
            <span><span style={{ display: "inline-block", width: 16, borderTop: `2px solid ${t.sub}`, verticalAlign: "middle", marginRight: 6 }} />shared $ref dependency</span>
            <span><span style={{ display: "inline-block", width: 16, borderTop: "2px dashed #ca8a04", verticalAlign: "middle", marginRight: 6 }} />runtime call</span>
          </> : <span><span style={{ display: "inline-block", width: 16, borderTop: `2px solid ${FLOW_C}`, verticalAlign: "middle", marginRight: 6 }} />call sequence ( variable passed )</span>}
        </div>
      </div>
      <div style={{ width: 380, flexShrink: 0, overflow: "auto", background: t.panel, borderLeft: `1px solid ${t.border}` }}>{drawer()}</div>
    </div>
  );
}

/* =========================== 4. Datapoint 360 =========================== */
function DatapointView({ t, data }) {
  // build a datapoint index: field name -> [{endpoint, key}], and flows touching it
  const index = useMemo(() => {
    const m = {};
    (data.endpoints || []).forEach((ep) => (ep.fields || []).forEach((f) => {
      const key = f.name.toLowerCase();
      (m[key] = m[key] || { name: f.name, type: f.data_type, occ: [], flows: new Set(), desc: f.description });
      m[key].occ.push({ ep: ep.path, key: ep.endpoint_key, desc: f.description });
      (ep.flows || []).forEach((fl) => m[key].flows.add(fl));
    }));
    return m;
  }, [data]);
  const names = Object.keys(index).sort();
  const [sel, setSel] = useState(names[0] || null);
  const dp = sel && index[sel];

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex" }}>
      {/* list */}
      <div style={{ width: 240, flexShrink: 0, borderRight: `1px solid ${t.border}`, background: t.panel, overflow: "auto" }}>
        <div style={{ padding: "12px 14px", fontSize: 10.5, fontWeight: 700, color: t.sub, textTransform: "uppercase", letterSpacing: 0.6 }}>Datapoints</div>
        {names.map((n) => (
          <button key={n} onClick={() => setSel(n)} style={{ display: "block", width: "100%", textAlign: "left", border: "none", cursor: "pointer",
            padding: "9px 14px", fontSize: 13, fontWeight: 600, background: sel === n ? t.accent : "transparent", color: sel === n ? "#fff" : t.text,
            fontFamily: "'SF Mono',ui-monospace,monospace" }}>
            {index[n].name}
            <span style={{ float: "right", fontSize: 10, opacity: 0.7, fontFamily: "Inter" }}>{index[n].occ.length}×</span>
          </button>
        ))}
      </div>
      {/* detail */}
      <div style={{ flex: 1, overflow: "auto", padding: 24 }}>
        {!dp ? <Empty t={t} text="No datapoints parsed yet." /> : (
          <div style={{ maxWidth: 760 }}>
            <h2 style={{ fontSize: 20, margin: "0 0 4px", fontFamily: "'SF Mono',ui-monospace,monospace" }}>{dp.name}</h2>
            <p style={{ fontSize: 13, color: t.sub, margin: "0 0 6px" }}>{dp.desc || "—"}</p>
            <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
              <span style={chip(t)}>{dp.type}</span>
              <span style={chip(t)}>{dp.occ.length} endpoints</span>
              <span style={chip(t)}>{dp.flows.size} flows</span>
            </div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: t.sub, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 10 }}>Appears in endpoints</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
              {dp.occ.map((o, i) => (
                <div key={i} style={{ background: t.panel, border: `1px solid ${t.border}`, borderRadius: 10, padding: "12px 14px", display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ width: 9, height: 9, borderRadius: "50%", background: CANON_C }} />
                  <b style={{ fontFamily: "'SF Mono',ui-monospace,monospace", fontSize: 13 }}>{o.ep}</b>
                  <span style={{ fontSize: 12, color: t.sub, marginLeft: "auto" }}>{o.desc}</span>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: t.sub, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 10 }}>Flows it moves through</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[...dp.flows].map((f) => <span key={f} style={{ fontSize: 12, fontWeight: 600, padding: "5px 11px", borderRadius: 20, background: FLOW_C + "1e", color: FLOW_C }}>{f}</span>)}
              {dp.flows.size === 0 && <span style={{ fontSize: 12, color: t.sub }}>none</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* =========================== 5. Search =========================== */
function SearchView({ t, data }) {
  const [q, setQ] = useState("account");
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const out = [];
    (data.endpoints || []).forEach((ep) => {
      if (ep.path.toLowerCase().includes(s) || (ep.summary || "").toLowerCase().includes(s))
        out.push({ kind: "endpoint", label: `${ep.method} ${ep.path}`, context: ep.summary });
      (ep.fields || []).forEach((f) => {
        if (f.name.toLowerCase().includes(s) || (f.description || "").toLowerCase().includes(s))
          out.push({ kind: "field", label: f.name, context: `${ep.path} · ${f.description || ""}` });
      });
    });
    (data.flows || []).forEach((fl) => {
      if (fl.name.toLowerCase().includes(s) || (fl.description || "").toLowerCase().includes(s))
        out.push({ kind: "flow", label: fl.name, context: fl.description });
    });
    return out;
  }, [q, data]);
  const kindStyle = { endpoint: [CANON_C, "endpoint"], field: [t.sub, "field"], flow: [FLOW_C, "flow"] };

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "auto", padding: 24 }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <h2 style={{ fontSize: 18, margin: "0 0 12px" }}>Search</h2>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search endpoints, fields, flows…"
          style={{ width: "100%", height: 44, borderRadius: 10, border: `1px solid ${t.border}`, background: t.panel, padding: "0 16px", fontSize: 15, outline: "none", marginBottom: 16 }} />
        <div style={{ fontSize: 12, color: t.sub, marginBottom: 10 }}>{results.length} results</div>
        <div style={{ background: t.panel, border: `1px solid ${t.border}`, borderRadius: 12, overflow: "hidden" }}>
          {results.map((r, i) => { const ks = kindStyle[r.kind];
            return <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderTop: i ? `1px solid ${t.border}` : "none" }}>
              <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: ks[0] + "1e", color: ks[0] }}>{ks[1]}</span>
              <b style={{ fontFamily: r.kind === "flow" ? "Inter" : "'SF Mono',ui-monospace,monospace", fontSize: 13 }}>{r.label}</b>
              <span style={{ fontSize: 12, color: t.sub, marginLeft: "auto", maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.context}</span>
            </div>; })}
          {results.length === 0 && <div style={{ padding: 20, textAlign: "center", color: t.sub, fontSize: 13 }}>No matches.</div>}
        </div>
      </div>
    </div>
  );
}

/* =========================== shared atoms =========================== */
function Empty({ t, text }) { return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: t.sub, fontSize: 13, textAlign: "center", padding: "0 34px", lineHeight: 1.5 }}>{text}</div>; }
function DH({ t, children }) { return <div style={{ padding: "16px 18px", borderBottom: `1px solid ${t.border}` }}>{children}</div>; }
function Sect({ t, title, children }) { return <div style={{ marginTop: 18 }}><div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.6, color: t.sub, fontWeight: 700, marginBottom: 8 }}>{title}</div>{children}</div>; }
function KV({ t, k, v, mono }) { return <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: `1px solid ${t.border}`, fontSize: 12.5 }}><span style={{ color: t.sub }}>{k}</span><b style={mono ? { fontFamily: "'SF Mono',ui-monospace,monospace", fontWeight: 600 } : {}}>{v}</b></div>; }
function th(t) { return { textAlign: "left", fontSize: 10.5, fontWeight: 700, color: t.sub, textTransform: "uppercase", letterSpacing: 0.5, padding: "11px 14px", background: t.panel2 }; }
function td(t) { return { padding: "11px 14px", fontSize: 13, verticalAlign: "middle" }; }
function chip(t) { return { fontSize: 10.5, color: t.sub, background: t.panel2, border: `1px solid ${t.border}`, padding: "2px 8px", borderRadius: 20 }; }
function zoomBtn(t) { return { background: t.panel2, border: `1px solid ${t.border}`, color: t.text, borderRadius: 8, width: 38, height: 38, fontSize: 16, cursor: "pointer", boxShadow: "0 2px 8px rgba(2,6,23,.12)" }; }
