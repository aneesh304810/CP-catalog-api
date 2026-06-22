// Embedded demo data (used when API is unreachable)
export const PLATFORMS = {
  oracle: { label: "ORACLE", badge: "#b91c1c", badgeBg: "#fef2f2" },
  mssql:  { label: "SQL SERVER", badge: "#1d4ed8", badgeBg: "#eff6ff" },
  dbt:    { label: "dbt", badge: "#ea580c", badgeBg: "#fff7ed" },
  airflow:{ label: "AIRFLOW", badge: "#0f766e", badgeBg: "#f0fdfa" },
};

export const LAYER_STRIPE = {
  bronze: "#b45309",
  silver: "#64748b",
  gold:   "#ca8a04",
  none:   "#cbd5e1",
};

// type: dataset | model | pipeline
// plane visibility derived from type
export const NODES = [
  {
    id: "mssql.risk.positions", type: "dataset", platform: "mssql",
    name: "positions", schema: "risk", layer: "none", objectType: "TABLE",
    desc: "Raw intraday positions feed from risk system.",
    columns: [
      { name: "position_id", type: "bigint", pk: true },
      { name: "account", type: "varchar(20)" },
      { name: "instrument", type: "varchar(32)" },
      { name: "qty", type: "decimal(18,4)" },
    ],
  },
  {
    id: "oracle.star.trades", type: "dataset", platform: "oracle",
    name: "TRADES", schema: "STAR", layer: "none", objectType: "TABLE",
    desc: "Legacy STAR trade records (system of record, pre-SWP).",
    columns: [
      { name: "trade_id", type: "NUMBER(18)", pk: true },
      { name: "account", type: "VARCHAR2(20)" },
      { name: "price", type: "NUMBER(18,6)" },
      { name: "qty", type: "NUMBER(18,4)" },
    ],
  },
  {
    id: "oracle.pbdw.brz_positions", type: "dataset", platform: "oracle",
    name: "BRZ_POSITIONS", schema: "PBDW", layer: "bronze", objectType: "TABLE",
    desc: "Bronze landing of positions, 1:1 ingest.",
    columns: [
      { name: "position_id", type: "NUMBER(18)", pk: true },
      { name: "account", type: "VARCHAR2(20)" },
      { name: "instrument", type: "VARCHAR2(32)" },
      { name: "qty", type: "NUMBER(18,4)" },
    ],
  },
  {
    id: "oracle.pbdw.brz_trades", type: "dataset", platform: "oracle",
    name: "BRZ_TRADES", schema: "PBDW", layer: "bronze", objectType: "TABLE",
    desc: "Bronze landing of STAR trades.",
    columns: [
      { name: "trade_id", type: "NUMBER(18)", pk: true },
      { name: "account", type: "VARCHAR2(20)" },
      { name: "price", type: "NUMBER(18,6)" },
      { name: "qty", type: "NUMBER(18,4)" },
    ],
  },
  {
    id: "model.cp.slv_positions", type: "model", platform: "dbt",
    name: "slv_positions", schema: "cp", layer: "silver", materialization: "incremental",
    desc: "Cleansed positions with market value.",
    produces: "oracle.pbdw.slv_positions",
    sql: "select\n  position_id,\n  account,\n  instrument,\n  qty,\n  qty * p.price as mkt_value\nfrom {{ ref('brz_positions') }} pos\njoin {{ ref('brz_trades') }} p using (account)",
    tests: ["unique: position_id", "not_null: account"],
    columns: [
      { name: "position_id", type: "NUMBER(18)", pk: true },
      { name: "account", type: "VARCHAR2(20)" },
      { name: "instrument", type: "VARCHAR2(32)" },
      { name: "mkt_value", type: "NUMBER(18,4)" },
    ],
  },
  {
    id: "oracle.pbdw.slv_positions", type: "dataset", platform: "oracle",
    name: "SLV_POSITIONS", schema: "PBDW", layer: "silver", objectType: "TABLE",
    desc: "Silver positions (materialized by slv_positions).",
    columns: [
      { name: "position_id", type: "NUMBER(18)", pk: true },
      { name: "account", type: "VARCHAR2(20)" },
      { name: "instrument", type: "VARCHAR2(32)" },
      { name: "mkt_value", type: "NUMBER(18,4)" },
    ],
  },
  {
    id: "model.cp.gld_position_summary", type: "model", platform: "dbt",
    name: "gld_position_summary", schema: "cp", layer: "gold", materialization: "table",
    desc: "Gold position summary per account.",
    produces: "oracle.imdw.gld_position_summary",
    sql: "select\n  account,\n  count(*) as position_count,\n  sum(mkt_value) as total_mkt_value\nfrom {{ ref('slv_positions') }}\ngroup by account",
    tests: ["not_null: account"],
    columns: [
      { name: "account", type: "VARCHAR2(20)", pk: true },
      { name: "position_count", type: "NUMBER(10)" },
      { name: "total_mkt_value", type: "NUMBER(20,4)" },
    ],
  },
  {
    id: "oracle.imdw.gld_position_summary", type: "dataset", platform: "oracle",
    name: "GLD_POSITION_SUMMARY", schema: "IMDW", layer: "gold", objectType: "TABLE",
    desc: "Published gold summary (IMDW).",
    columns: [
      { name: "account", type: "VARCHAR2(20)", pk: true },
      { name: "position_count", type: "NUMBER(10)" },
      { name: "total_mkt_value", type: "NUMBER(20,4)" },
    ],
  },
  // Airflow orchestration nodes (orchestration plane only)
  {
    id: "dag.swp_medallion", type: "pipeline", platform: "airflow",
    name: "swp_medallion_dag", schema: "airflow", layer: "none",
    desc: "Cosmos-rendered dbt DAG; one task per model.",
    schedule: "0 6 * * 1-5",
    runs: [
      { run: "2026-06-18", status: "success", dur: "4m12s" },
      { run: "2026-06-17", status: "success", dur: "4m03s" },
      { run: "2026-06-16", status: "failed",  dur: "1m22s" },
    ],
  },
];

// Table-level edges. kind: data | transform | orchestration
export const EDGES = [
  // data plane (table -> table, conceptual)
  { from: "mssql.risk.positions", to: "oracle.pbdw.brz_positions", kind: "data" },
  { from: "oracle.star.trades",   to: "oracle.pbdw.brz_trades",    kind: "data" },
  { from: "oracle.pbdw.brz_positions", to: "oracle.pbdw.slv_positions", kind: "data" },
  { from: "oracle.pbdw.brz_trades",    to: "oracle.pbdw.slv_positions", kind: "data" },
  { from: "oracle.pbdw.slv_positions", to: "oracle.imdw.gld_position_summary", kind: "data" },
  // transform plane (through dbt models)
  { from: "oracle.pbdw.brz_positions", to: "model.cp.slv_positions", kind: "transform" },
  { from: "oracle.pbdw.brz_trades",    to: "model.cp.slv_positions", kind: "transform" },
  { from: "model.cp.slv_positions",    to: "oracle.pbdw.slv_positions", kind: "transform" },
  { from: "oracle.pbdw.slv_positions", to: "model.cp.gld_position_summary", kind: "transform" },
  { from: "model.cp.gld_position_summary", to: "oracle.imdw.gld_position_summary", kind: "transform" },
  // orchestration plane (dag runs models)
  { from: "dag.swp_medallion", to: "model.cp.slv_positions", kind: "orchestration" },
  { from: "dag.swp_medallion", to: "model.cp.gld_position_summary", kind: "orchestration" },
];

// Column-level edges: from "nodeId::col" to "nodeId::col"
export const COL_EDGES = [
  { from: "mssql.risk.positions::position_id", to: "oracle.pbdw.brz_positions::position_id", expr: "1:1" },
  { from: "mssql.risk.positions::account", to: "oracle.pbdw.brz_positions::account", expr: "1:1" },
  { from: "mssql.risk.positions::instrument", to: "oracle.pbdw.brz_positions::instrument", expr: "1:1" },
  { from: "mssql.risk.positions::qty", to: "oracle.pbdw.brz_positions::qty", expr: "1:1" },
  { from: "oracle.star.trades::price", to: "oracle.pbdw.brz_trades::price", expr: "1:1" },
  { from: "oracle.star.trades::account", to: "oracle.pbdw.brz_trades::account", expr: "1:1" },

  { from: "oracle.pbdw.brz_positions::position_id", to: "oracle.pbdw.slv_positions::position_id", expr: "1:1" },
  { from: "oracle.pbdw.brz_positions::account", to: "oracle.pbdw.slv_positions::account", expr: "1:1" },
  { from: "oracle.pbdw.brz_positions::instrument", to: "oracle.pbdw.slv_positions::instrument", expr: "1:1" },
  { from: "oracle.pbdw.brz_positions::qty", to: "oracle.pbdw.slv_positions::mkt_value", expr: "qty * price" },
  { from: "oracle.pbdw.brz_trades::price", to: "oracle.pbdw.slv_positions::mkt_value", expr: "qty * price" },

  { from: "oracle.pbdw.slv_positions::account", to: "oracle.imdw.gld_position_summary::account", expr: "group by" },
  { from: "oracle.pbdw.slv_positions::mkt_value", to: "oracle.imdw.gld_position_summary::total_mkt_value", expr: "SUM(mkt_value)" },
  { from: "oracle.pbdw.slv_positions::position_id", to: "oracle.imdw.gld_position_summary::position_count", expr: "COUNT(*)" },
];

// ---------- LAYOUT (simple longest-path layering, L->R) ------------------
function computeLayout(nodes, edges, planes) {
  const visible = nodes.filter((n) => {
    if (n.type === "dataset") return true;
    if (n.type === "model") return planes.transform || planes.orchestration;
    if (n.type === "pipeline") return planes.orchestration;
    return true;
  });
  const visIds = new Set(visible.map((n) => n.id));
  const activeEdges = edges.filter((e) => {
    if (!visIds.has(e.from) || !visIds.has(e.to)) return false;
    if (e.kind === "data") return planes.data && !planes.transform; // data edges hidden when transform on (models replace them)
    if (e.kind === "transform") return planes.transform || planes.orchestration;
    if (e.kind === "orchestration") return planes.orchestration;
    return false;
  });

  // longest-path layering
  const depth = {};
  visible.forEach((n) => (depth[n.id] = 0));
  const adj = {};
  activeEdges.forEach((e) => {
    (adj[e.from] = adj[e.from] || []).push(e.to);
  });
  let changed = true, guard = 0;
  while (changed && guard++ < 50) {
    changed = false;
    activeEdges.forEach((e) => {
      if (depth[e.to] < depth[e.from] + 1) {
        depth[e.to] = depth[e.from] + 1;
        changed = true;
      }
    });
  }
  // pipelines float to a top band at their own column
  const cols = {};
  visible.forEach((n) => {
    const d = depth[n.id];
    (cols[d] = cols[d] || []).push(n);
  });

  const COL_W = 300, NODE_W = 230, ROW_GAP = 28, TOP = 40, LEFT = 40;
  const pos = {};
  Object.keys(cols).sort((a, b) => a - b).forEach((d) => {
    let y = TOP;
    cols[d].forEach((n) => {
      const h = nodeHeight(n);
      pos[n.id] = { x: LEFT + d * COL_W, y, w: NODE_W, h };
      y += h + ROW_GAP;
    });
  });
  return { visible, activeEdges, pos };
}

const HEADER_H = 46, COL_ROW_H = 24, COL_PAD = 8;
function nodeHeight(n, expanded) {
  const hasCols = (n.columns && n.columns.length) || 0;
  if (n.type === "pipeline") return HEADER_H + 8;
  if (!expanded) return HEADER_H + 8;
  return HEADER_H + COL_PAD + hasCols * COL_ROW_H + COL_PAD;
}

