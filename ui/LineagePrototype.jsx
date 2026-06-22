import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";

/* ============================================================
   CP Metadata Catalog — Lineage Prototype (mock data)
   Neutral slate/blue, OpenMetadata-style.
   Self-contained: custom left-to-right layout + SVG edges,
   custom HTML nodes with per-column anchors. No external graph lib.
   ============================================================ */

// ---------- MOCK DATA ----------------------------------------------------
// Datasets, dbt models, and an Airflow DAG from a CP medallion slice.

const PLATFORMS = {
  oracle: { label: "ORACLE", badge: "#b91c1c", badgeBg: "#fef2f2" },
  mssql:  { label: "SQL SERVER", badge: "#1d4ed8", badgeBg: "#eff6ff" },
  dbt:    { label: "dbt", badge: "#ea580c", badgeBg: "#fff7ed" },
  airflow:{ label: "AIRFLOW", badge: "#0f766e", badgeBg: "#f0fdfa" },
};

const LAYER_STRIPE = {
  bronze: "#b45309",
  silver: "#64748b",
  gold:   "#ca8a04",
  none:   "#cbd5e1",
};

// type: dataset | model | pipeline
// plane visibility derived from type
const NODES = [
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
const EDGES = [
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
const COL_EDGES = [
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

// ---------- COMPONENT ----------------------------------------------------
export default function LineagePrototype() {
  const [dark, setDark] = useState(false);
  const [planes, setPlanes] = useState({ data: true, transform: false, orchestration: false });
  const [expanded, setExpanded] = useState({}); // nodeId -> bool
  const [selectedCol, setSelectedCol] = useState(null); // "nodeId::col"
  const [drawerNode, setDrawerNode] = useState(null);
  const [search, setSearch] = useState("");
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const dragRef = useRef(null);
  const svgRef = useRef(null);

  const planeMode = planes.orchestration ? "orchestration" : planes.transform ? "transform" : "data";

  // layout recomputes when planes or expansion change
  const layout = useMemo(() => {
    const base = computeLayout(NODES, EDGES, planes);
    // apply expansion heights
    const pos = { ...base.pos };
    // re-stack per column with expanded heights
    const byCol = {};
    base.visible.forEach((n) => {
      const col = Math.round((pos[n.id].x - 40) / 300);
      (byCol[col] = byCol[col] || []).push(n);
    });
    Object.values(byCol).forEach((list) => {
      let y = 40;
      list.forEach((n) => {
        const h = nodeHeight(n, !!expanded[n.id]);
        pos[n.id] = { ...pos[n.id], y, h };
        y += h + 28;
      });
    });
    return { ...base, pos };
  }, [planes, expanded]);

  // ---- column lineage path (upstream + downstream) -----------------------
  const colGraph = useMemo(() => {
    const up = {}, down = {};
    COL_EDGES.forEach((e) => {
      (down[e.from] = down[e.from] || []).push(e.to);
      (up[e.to] = up[e.to] || []).push(e.from);
    });
    return { up, down };
  }, []);

  const highlightedCols = useMemo(() => {
    if (!selectedCol) return null;
    const set = new Set([selectedCol]);
    const walk = (start, map) => {
      const stack = [start];
      while (stack.length) {
        const cur = stack.pop();
        (map[cur] || []).forEach((nx) => {
          if (!set.has(nx)) { set.add(nx); stack.push(nx); }
        });
      }
    };
    walk(selectedCol, colGraph.up);
    walk(selectedCol, colGraph.down);
    return set;
  }, [selectedCol, colGraph]);

  const impactCount = useMemo(() => {
    if (!selectedCol) return 0;
    const set = new Set();
    const stack = [selectedCol];
    while (stack.length) {
      const cur = stack.pop();
      (colGraph.down[cur] || []).forEach((nx) => {
        if (!set.has(nx)) { set.add(nx); stack.push(nx); }
      });
    }
    return set.size;
  }, [selectedCol, colGraph]);

  // ---- search focus ------------------------------------------------------
  const searchMatch = useMemo(() => {
    if (!search.trim()) return new Set();
    const q = search.toLowerCase();
    return new Set(
      layout.visible.filter((n) =>
        n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)
      ).map((n) => n.id)
    );
  }, [search, layout.visible]);

  // ---- pan / zoom --------------------------------------------------------
  const onWheel = useCallback((e) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.0015;
    setView((v) => {
      const k = Math.min(2.2, Math.max(0.35, v.k * (1 + delta)));
      return { ...v, k };
    });
  }, []);
  const onMouseDown = (e) => {
    if (e.target.closest("[data-node]") || e.target.closest("[data-col]")) return;
    dragRef.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  };
  const onMouseMove = (e) => {
    if (!dragRef.current) return;
    setView((v) => ({
      ...v,
      x: dragRef.current.vx + (e.clientX - dragRef.current.x),
      y: dragRef.current.vy + (e.clientY - dragRef.current.y),
    }));
  };
  const onMouseUp = () => (dragRef.current = null);

  const fitView = () => setView({ x: 0, y: 0, k: 1 });

  // ---- theme tokens ------------------------------------------------------
  const t = dark
    ? {
        bg: "#0b1220", panel: "#0f172a", panel2: "#111c34", border: "#1e293b",
        text: "#e2e8f0", sub: "#94a3b8", line: "#334155", lineHi: "#60a5fa",
        nodeBg: "#0f1a30", nodeHead: "#15233f", chip: "#1e293b",
        accent: "#3b82f6", drawer: "#0d1729",
      }
    : {
        bg: "#f1f5f9", panel: "#ffffff", panel2: "#f8fafc", border: "#e2e8f0",
        text: "#0f172a", sub: "#64748b", line: "#cbd5e1", lineHi: "#2563eb",
        nodeBg: "#ffffff", nodeHead: "#f8fafc", chip: "#f1f5f9",
        accent: "#2563eb", drawer: "#ffffff",
      };

  // anchor coords for a column
  const colAnchor = (nodeId, col, side) => {
    const p = layout.pos[nodeId];
    const node = NODES.find((n) => n.id === nodeId);
    if (!p || !node || !node.columns) return null;
    const idx = node.columns.findIndex((c) => c.name === col);
    if (idx < 0) return null;
    const y = p.y + HEADER_H + COL_PAD + idx * COL_ROW_H + COL_ROW_H / 2;
    const x = side === "right" ? p.x + p.w : p.x;
    return { x, y };
  };

  // table edge endpoints
  const tableAnchor = (id, side) => {
    const p = layout.pos[id];
    if (!p) return null;
    return { x: side === "right" ? p.x + p.w : p.x, y: p.y + HEADER_H / 2 };
  };

  const showCols = Object.values(expanded).some(Boolean);

  return (
    <div style={{ position: "fixed", inset: 0, background: t.bg, color: t.text,
      fontFamily: "'Inter', system-ui, sans-serif", display: "flex", flexDirection: "column" }}>
      {/* ---------- TOP BAR ---------- */}
      <div style={{ height: 56, borderBottom: `1px solid ${t.border}`, background: t.panel,
        display: "flex", alignItems: "center", padding: "0 16px", gap: 16, flexShrink: 0, zIndex: 5 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, background: t.accent,
            display: "grid", placeItems: "center", color: "#fff", fontWeight: 700, fontSize: 13 }}>CP</div>
          <span style={{ fontWeight: 650, letterSpacing: -0.2 }}>Metadata Catalog</span>
          <span style={{ fontSize: 11, color: t.sub, border: `1px solid ${t.border}`,
            padding: "2px 7px", borderRadius: 20 }}>Lineage</span>
        </div>

        <div style={{ position: "relative", flex: 1, maxWidth: 360 }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search assets…  (⌘K)"
            style={{ width: "100%", height: 34, borderRadius: 8, border: `1px solid ${t.border}`,
              background: t.panel2, color: t.text, padding: "0 12px", fontSize: 13, outline: "none" }}
          />
        </div>

        {/* plane segmented control */}
        <PlaneToggle planes={planes} setPlanes={setPlanes} t={t} />

        <div style={{ flex: 1 }} />
        <button onClick={() => setDark((d) => !d)} title="Toggle theme"
          style={ghostBtn(t)}>{dark ? "☀" : "☾"}</button>
      </div>

      {/* ---------- CANVAS ---------- */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}
        onWheel={onWheel} onMouseDown={onMouseDown} onMouseMove={onMouseMove}
        onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>

        {/* impact banner */}
        {selectedCol && (
          <div style={{ position: "absolute", top: 14, left: 14, zIndex: 4,
            background: t.panel, border: `1px solid ${t.border}`, borderRadius: 10,
            padding: "10px 14px", boxShadow: "0 4px 18px rgba(0,0,0,.12)", maxWidth: 320 }}>
            <div style={{ fontSize: 11, color: t.sub, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Impact analysis
            </div>
            <div style={{ fontSize: 13, marginTop: 3 }}>
              <b>{selectedCol.split("::")[1]}</b> in {selectedCol.split("::")[0].split(".").pop()}
            </div>
            <div style={{ fontSize: 13, marginTop: 4, color: t.accent, fontWeight: 600 }}>
              {impactCount} downstream column{impactCount === 1 ? "" : "s"} affected
            </div>
            <button onClick={() => setSelectedCol(null)} style={{ ...ghostBtn(t), marginTop: 8, height: 26, fontSize: 12 }}>
              Clear selection
            </button>
          </div>
        )}

        <div style={{ position: "absolute", transformOrigin: "0 0",
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          {/* edges layer */}
          <svg ref={svgRef} style={{ position: "absolute", overflow: "visible", pointerEvents: "none" }}
            width={2000} height={1400}>
            <defs>
              <marker id="arrow" markerWidth="9" markerHeight="9" refX="7" refY="3"
                orient="auto" markerUnits="userSpaceOnUse">
                <path d="M0,0 L7,3 L0,6 Z" fill={t.line} />
              </marker>
              <marker id="arrowHi" markerWidth="9" markerHeight="9" refX="7" refY="3"
                orient="auto" markerUnits="userSpaceOnUse">
                <path d="M0,0 L7,3 L0,6 Z" fill={t.lineHi} />
              </marker>
            </defs>

            {/* table-level edges */}
            {layout.activeEdges.map((e, i) => {
              const a = tableAnchor(e.from, "right");
              const b = tableAnchor(e.to, "left");
              if (!a || !b) return null;
              const dimmed = selectedCol ? true : false;
              return <Edge key={"t" + i} a={a} b={b} color={t.line}
                opacity={dimmed ? 0.18 : 0.7} marker="arrow" dashed={e.kind === "orchestration"} />;
            })}

            {/* column-level edges (only when some node expanded) */}
            {showCols && COL_EDGES.map((e, i) => {
              const [fn, fc] = e.from.split("::");
              const [tn, tc] = e.to.split("::");
              if (!expanded[fn] || !expanded[tn]) return null;
              const a = colAnchor(fn, fc, "right");
              const b = colAnchor(tn, tc, "left");
              if (!a || !b) return null;
              const hi = highlightedCols && (highlightedCols.has(e.from) && highlightedCols.has(e.to));
              const dim = highlightedCols && !hi;
              return (
                <g key={"c" + i}>
                  <Edge a={a} b={b}
                    color={hi ? t.lineHi : t.line}
                    opacity={dim ? 0.08 : hi ? 1 : 0.5}
                    marker={hi ? "arrowHi" : "arrow"}
                    width={hi ? 2.2 : 1.3}
                    title={e.expr} />
                </g>
              );
            })}
          </svg>

          {/* nodes layer */}
          {layout.visible.map((n) => {
            const p = layout.pos[n.id];
            const plat = PLATFORMS[n.platform];
            const isExpanded = !!expanded[n.id];
            const matched = searchMatch.size > 0 && searchMatch.has(n.id);
            const faded = searchMatch.size > 0 && !matched;
            return (
              <div key={n.id} data-node
                onClick={(e) => { e.stopPropagation(); setDrawerNode(n); }}
                style={{
                  position: "absolute", left: p.x, top: p.y, width: p.w,
                  background: t.nodeBg, border: `1px solid ${matched ? t.accent : t.border}`,
                  borderRadius: 12, boxShadow: matched
                    ? `0 0 0 3px ${t.accent}33, 0 6px 20px rgba(2,6,23,.18)`
                    : "0 4px 14px rgba(2,6,23,.10)",
                  opacity: faded ? 0.35 : 1, cursor: "pointer", overflow: "hidden",
                  transition: "box-shadow .15s, opacity .15s",
                }}>
                {/* layer stripe */}
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4,
                  background: LAYER_STRIPE[n.layer] || LAYER_STRIPE.none }} />
                {/* header */}
                <div style={{ height: HEADER_H, display: "flex", alignItems: "center",
                  gap: 8, padding: "0 10px 0 14px", background: t.nodeHead,
                  borderBottom: isExpanded ? `1px solid ${t.border}` : "none" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: plat.badge,
                    background: dark ? "#0b1220" : plat.badgeBg, border: `1px solid ${plat.badge}33`,
                    padding: "2px 6px", borderRadius: 5 }}>{plat.label}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 650, whiteSpace: "nowrap",
                      overflow: "hidden", textOverflow: "ellipsis" }}>{n.name}</div>
                    <div style={{ fontSize: 10, color: t.sub }}>
                      {n.type === "model" ? "dbt model" : n.type === "pipeline" ? "airflow dag" : n.schema}
                    </div>
                  </div>
                  {n.columns && (
                    <button data-col onClick={(e) => { e.stopPropagation();
                      setExpanded((s) => ({ ...s, [n.id]: !s[n.id] })); }}
                      title={isExpanded ? "Collapse columns" : "Expand columns"}
                      style={{ ...ghostBtn(t), width: 24, height: 24, padding: 0, fontSize: 11 }}>
                      {isExpanded ? "▾" : "▸"}
                    </button>
                  )}
                </div>
                {/* columns */}
                {isExpanded && n.columns && (
                  <div style={{ padding: `${COL_PAD}px 0` }}>
                    {n.columns.map((c) => {
                      const cid = `${n.id}::${c.name}`;
                      const hi = highlightedCols && highlightedCols.has(cid);
                      const dim = highlightedCols && !hi;
                      return (
                        <div key={c.name} data-col
                          onClick={(e) => { e.stopPropagation();
                            setSelectedCol(selectedCol === cid ? null : cid); }}
                          style={{ height: COL_ROW_H, display: "flex", alignItems: "center",
                            gap: 6, padding: "0 14px", fontSize: 12, cursor: "pointer",
                            background: hi ? (dark ? "#13233f" : "#eff6ff") : "transparent",
                            opacity: dim ? 0.4 : 1, position: "relative" }}>
                          {/* anchors */}
                          <span style={anchorDot(t, "left")} />
                          <span style={anchorDot(t, "right")} />
                          <span style={{ width: 7, height: 7, borderRadius: 2,
                            background: c.pk ? "#ca8a04" : "transparent",
                            border: c.pk ? "none" : `1px solid ${t.line}` }} title={c.pk ? "primary key" : ""} />
                          <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden",
                            textOverflow: "ellipsis", fontWeight: hi ? 650 : 400 }}>{c.name}</span>
                          <span style={{ fontSize: 10, color: t.sub }}>{c.type}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* zoom controls */}
        <div style={{ position: "absolute", right: 16, bottom: 16, display: "flex",
          flexDirection: "column", gap: 6, zIndex: 4 }}>
          <button onClick={() => setView((v) => ({ ...v, k: Math.min(2.2, v.k * 1.15) }))} style={zoomBtn(t)}>＋</button>
          <button onClick={() => setView((v) => ({ ...v, k: Math.max(0.35, v.k / 1.15) }))} style={zoomBtn(t)}>－</button>
          <button onClick={fitView} style={zoomBtn(t)} title="Reset view">⤢</button>
        </div>

        {/* legend */}
        <div style={{ position: "absolute", left: 16, bottom: 16, zIndex: 4,
          background: t.panel, border: `1px solid ${t.border}`, borderRadius: 10,
          padding: "10px 12px", fontSize: 11, color: t.sub, display: "flex", gap: 14 }}>
          <Legend c={LAYER_STRIPE.bronze} label="bronze" />
          <Legend c={LAYER_STRIPE.silver} label="silver" />
          <Legend c={LAYER_STRIPE.gold} label="gold" />
          <span style={{ color: t.sub }}>·  click a column to trace lineage</span>
        </div>
      </div>

      {/* ---------- DRAWER ---------- */}
      {drawerNode && (
        <Drawer node={drawerNode} t={t} onClose={() => setDrawerNode(null)} />
      )}
    </div>
  );
}

// ---------- SUBCOMPONENTS ------------------------------------------------
function Edge({ a, b, color, opacity = 0.7, marker = "arrow", dashed, width = 1.5, title }) {
  const dx = Math.max(40, (b.x - a.x) * 0.5);
  const d = `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  return (
    <path d={d} fill="none" stroke={color} strokeWidth={width} opacity={opacity}
      strokeDasharray={dashed ? "5 4" : "none"} markerEnd={`url(#${marker})`}>
      {title && <title>{title}</title>}
    </path>
  );
}

function PlaneToggle({ planes, setPlanes, t }) {
  const opts = [
    { key: "data", label: "Data" },
    { key: "transform", label: "Transform" },
    { key: "orchestration", label: "Orchestration" },
  ];
  const active = planes.orchestration ? "orchestration" : planes.transform ? "transform" : "data";
  const pick = (k) => {
    if (k === "data") setPlanes({ data: true, transform: false, orchestration: false });
    if (k === "transform") setPlanes({ data: true, transform: true, orchestration: false });
    if (k === "orchestration") setPlanes({ data: true, transform: true, orchestration: true });
  };
  return (
    <div style={{ display: "flex", background: t.panel2, border: `1px solid ${t.border}`,
      borderRadius: 9, padding: 3, gap: 2 }}>
      {opts.map((o) => (
        <button key={o.key} onClick={() => pick(o.key)}
          style={{ border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 600,
            padding: "5px 12px", borderRadius: 6,
            background: active === o.key ? t.accent : "transparent",
            color: active === o.key ? "#fff" : t.sub }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Drawer({ node, t, onClose }) {
  const plat = PLATFORMS[node.platform];
  return (
    <div style={{ position: "absolute", top: 56, right: 0, bottom: 0, width: 360,
      background: t.drawer, borderLeft: `1px solid ${t.border}`, zIndex: 6,
      boxShadow: "-8px 0 24px rgba(2,6,23,.12)", display: "flex", flexDirection: "column",
      animation: "slideIn .18s ease" }}>
      <style>{`@keyframes slideIn{from{transform:translateX(20px);opacity:.6}to{transform:none;opacity:1}}`}</style>
      <div style={{ padding: "16px 18px", borderBottom: `1px solid ${t.border}`,
        display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: plat.badge,
            border: `1px solid ${plat.badge}33`, padding: "2px 6px", borderRadius: 5 }}>{plat.label}</span>
          <div style={{ fontSize: 16, fontWeight: 680, marginTop: 8 }}>{node.name}</div>
          <div style={{ fontSize: 12, color: t.sub }}>
            {node.type === "model" ? "dbt model · " + node.materialization
              : node.type === "pipeline" ? "airflow dag" : node.schema + " · " + node.objectType}
          </div>
        </div>
        <button onClick={onClose} style={ghostBtn(t)}>✕</button>
      </div>

      <div style={{ overflow: "auto", padding: 18, fontSize: 13, lineHeight: 1.5 }}>
        {node.desc && <p style={{ color: t.sub, marginTop: 0 }}>{node.desc}</p>}

        {node.columns && (
          <Section t={t} title="Schema">
            {node.columns.map((c) => (
              <div key={c.name} style={{ display: "flex", justifyContent: "space-between",
                padding: "5px 0", borderBottom: `1px solid ${t.border}` }}>
                <span>{c.pk && <span style={{ color: "#ca8a04" }}>● </span>}{c.name}</span>
                <span style={{ color: t.sub, fontSize: 12 }}>{c.type}</span>
              </div>
            ))}
          </Section>
        )}

        {node.sql && (
          <Section t={t} title="Transformation (compiled SQL)">
            <pre style={{ background: t.panel2, border: `1px solid ${t.border}`, borderRadius: 8,
              padding: 12, fontSize: 11.5, overflow: "auto", margin: 0,
              fontFamily: "'SF Mono', ui-monospace, monospace" }}>{node.sql}</pre>
          </Section>
        )}

        {node.tests && (
          <Section t={t} title="Tests">
            {node.tests.map((x, i) => (
              <div key={i} style={{ fontSize: 12, padding: "3px 0", color: t.sub }}>✓ {x}</div>
            ))}
          </Section>
        )}

        {node.runs && (
          <Section t={t} title="Recent runs">
            {node.runs.map((r, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between",
                alignItems: "center", padding: "6px 0", borderBottom: `1px solid ${t.border}` }}>
                <span style={{ fontSize: 12 }}>{r.run}</span>
                <span style={{ fontSize: 11, color: r.status === "success" ? "#16a34a" : "#dc2626" }}>
                  {r.status} · {r.dur}
                </span>
              </div>
            ))}
          </Section>
        )}

        {node.schedule && (
          <Section t={t} title="Schedule">
            <code style={{ fontSize: 12 }}>{node.schedule}</code>
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({ title, children, t }) {
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6,
        color: t.sub, marginBottom: 8, fontWeight: 700 }}>{title}</div>
      {children}
    </div>
  );
}

function Legend({ c, label }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, background: c }} />{label}
    </span>
  );
}

// ---------- style helpers ------------------------------------------------
function ghostBtn(t) {
  return { background: t.panel2, border: `1px solid ${t.border}`, color: t.text,
    borderRadius: 8, height: 32, minWidth: 32, padding: "0 10px", cursor: "pointer",
    fontSize: 14, display: "inline-flex", alignItems: "center", justifyContent: "center" };
}
function zoomBtn(t) {
  return { ...ghostBtn(t), width: 38, height: 38, fontSize: 16, boxShadow: "0 2px 8px rgba(2,6,23,.12)" };
}
function anchorDot(t, side) {
  return { position: "absolute", [side]: -3.5, top: "50%", transform: "translateY(-50%)",
    width: 7, height: 7, borderRadius: "50%", background: t.panel, border: `1.5px solid ${t.line}` };
}
