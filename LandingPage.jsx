// =====================================================================
// LandingPage.jsx — Catalog Platform landing page (BBH v6 design language)
//
// Single-file React component. React + inline styles only (no deps).
// 4 core "360" modules + Operations + Admin. Command palette (Cmd/Ctrl-K),
// light/dark toggle (light = BBH default), keyboard shortcuts, loading
// skeletons, reduced-motion aware, semantic HTML, desktop-only (>=1263px).
// All Unicode via \uXXXX escapes. Mock data only; handlers console.log.
// =====================================================================
import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";

/* ---------------------------------------------------------------- tokens */
const BBH = {
  navy: "#10193b", dark: "#0f4775", muted: "#5f87a7", tint: "#cae3ee",
  pop: "#31bced", hover: "#0091bf", pop2: "#e35f42",
  success: "#159943", successBg: "#d0ebd9",
  danger: "#c1113a", dangerBg: "#f3d2d7",
  warning: "#e67e22", warningBg: "#fae5d3",
  info: "#0091bf", infoBg: "#e0f5fd",
  modSystem: "#10193b", modApi: "#0091bf", modData: "#0f4775", modDatapoint: "#159943",
  white: "#fff", pageBg: "#f5f8f8", accordionBg: "#dfe6e9", hoverBg: "#eee",
  disabled: "#dbdae0", border: "#b5b6b6", textMuted: "#999", textHelp: "#666",
  text: "#333", black: "#000",
};
const BBH_DARK = {
  ...BBH, navy: "#0a0f24", pageBg: "#0b1220", white: "#0f172a", accordionBg: "#111c34",
  hoverBg: "#111c34", border: "#1e293b", text: "#e2e8f0", textMuted: "#94a3b8",
  textHelp: "#64748b", tint: "#15324a", disabled: "#1e293b",
};
const FONT = "Roboto, 'Helvetica Neue', Arial, sans-serif";
const SP = { xs: 5, sm: 10, md: 20, lg: 30, xl: 40, xxl: 50 };

/* glyphs as escapes */
const G = {
  wave: "\uD83D\uDC4B", arrow: "\u2192", chevR: "\u203A", enter: "\u21B5",
  caret: "\u25BE", sun: "\u2600", moon: "\u263E", bell: "\uD83D\uDD14",
  up: "\u25B2", down: "\u25BC", dot: "\u25CF", spark: "\u2728", neu: "\uD83C\uDD95",
  cmd: "\u2318", search: "\uD83D\uDD0D", laptop: "\uD83D\uDCBB", mid: "\u00B7",
};

/* ------------------------------------------------------------- icons (svg) */
const Ico = ({ d, s = 20, c = "currentColor", sw = 1.7, fill = "none", vb = 24 }) => (
  <svg width={s} height={s} viewBox={`0 0 ${vb} ${vb}`} fill={fill} stroke={c}
    strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const I = {
  system: <Ico d={<><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M10 6.5h4M6.5 10v4M17.5 10v4M10 17.5h4"/></>} />,
  api: <Ico d={<><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/><circle cx="12" cy="12" r="2.5"/><path d="M12 7v2.5M12 14.5V17M7 12h2.5M14.5 12H17"/></>} />,
  data: <Ico d={<><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></>} />,
  datapoint: <Ico d={<><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l2.5 2.5M16.5 16.5L19 19M19 5l-2.5 2.5M7.5 16.5L5 19"/></>} />,
  health: <Ico d={<path d="M3 12h4l2 5 4-12 2 7h6"/>} />,
  obs: <Ico d={<><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></>} />,
  impact: <Ico d={<><circle cx="12" cy="12" r="2"/><path d="M12 2v4M12 18v4M22 12h-4M6 12H2"/><circle cx="12" cy="12" r="9" strokeDasharray="3 3"/></>} />,
  ingest: <Ico d={<><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/></>} />,
  src: <Ico d={<><path d="M4 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2M4 7h16M4 7v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7"/><path d="M8 11h8M8 15h5"/></>} />,
  access: <Ico d={<><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></>} />,
  settings: <Ico d={<><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M22 12h-3M5 12H2M19 5l-2 2M7 17l-2 2M19 19l-2-2M7 7L5 5"/></>} />,
  help: <Ico d={<><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 5 .3c0 1.7-2.5 2.2-2.5 3.7M12 17h.01"/></>} />,
  whatsnew: <Ico d={<><path d="M12 2l2.4 5 5.6.5-4.2 3.7 1.3 5.5L12 19l-5.1 2.7 1.3-5.5L4 12.5 9.6 12z"/></>} />,
  bell: <Ico d={<><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></>} />,
  searchIco: <Ico d={<><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></>} s={16} />,
};

/* --------------------------------------------------------------- mock data */
const MODULES = [
  { id: "system", name: "System Interface 360", color: BBH.modSystem, icon: I.system,
    desc: "System-to-system integration map",
    kpis: [["828", "interfaces"], ["48", "systems"], ["12", "marked Replace"]],
    status: ["24 mapped flows", "info"], go: "g i" },
  { id: "api", name: "API 360", color: BBH.modApi, icon: I.api,
    desc: "API dependency, business flows, endpoint detail",
    kpis: [["215", "endpoints"], ["12", "business flows"], ["4", "sources"]],
    status: ["LIVE", "success"], go: "g a" },
  { id: "data", name: "Data 360", color: BBH.modData, icon: I.data,
    desc: "Lineage across Oracle, dbt, Airflow",
    kpis: [["1,247", "datasets"], ["89", "pipelines"], ["92.4%", "avg DQ"]],
    status: ["3 failing", "danger"], go: "g d" },
  { id: "datapoint", name: "Datapoint 360", color: BBH.modDatapoint, icon: I.datapoint,
    desc: "Cross-cutting business term tracking",
    kpis: [["4,892", "terms"], ["3", "modules linked"], ["100%", "coverage"]],
    status: ["linked", "info"], go: "g p" },
];
const ALERTS = [
  { sev: "danger", origin: "data", title: "GLD_position_summary quality gate failed", ctx: "Data 360 \u00B7 Gold layer", time: "2h ago" },
  { sev: "danger", origin: "system", title: "AddVantage \u2192 CAM interface stale", ctx: "System Interface 360 \u00B7 4h overdue", time: "30m ago" },
  { sev: "danger", origin: "api", title: "POST /reconciliation latency spike", ctx: "API 360 \u00B7 p95 1.8s", time: "1h ago" },
  { sev: "warning", origin: "system", title: "12 systems pending migration decision", ctx: "System Interface 360", time: "today" },
  { sev: "warning", origin: "data", title: "New unmapped column in SLV_clients", ctx: "Data 360 \u00B7 Silver layer", time: "yesterday" },
];
const HEALTH = [
  { label: "AVG DQ SCORE", val: "92.4%", state: "success", trend: "up", delta: "+0.3" },
  { label: "DATASETS FAILING", val: "3", state: "danger", trend: "down", delta: "-1" },
  { label: "GATES P / W / F", val: "6 / 1 / 1", state: "warning", trend: null, delta: "" },
  { label: "FAILED RUNS (7D)", val: "2", state: "success", trend: "down", delta: "-2" },
];
const OPS = [
  { id: "health", name: "Health & Quality", desc: "DQ scores, gates", icon: I.health },
  { id: "obs", name: "Observability", desc: "Runs, latency, SLAs", icon: I.obs },
  { id: "impact", name: "Impact Analysis", desc: "Downstream blast radius", icon: I.impact },
  { id: "ingest", name: "Ingestion Status", desc: "Connector runs", icon: I.ingest },
];
const ADMIN = [
  { id: "src", name: "Sources / Connectors", desc: "Manage ingestion", icon: I.src },
  { id: "access", name: "Access Control", desc: "Roles & permissions", icon: I.access },
  { id: "settings", name: "Settings", desc: "Preferences", icon: I.settings },
  { id: "help", name: "Help & Docs", desc: "Guides & reference", icon: I.help },
  { id: "whatsnew", name: "What's New", desc: "Release notes", icon: I.whatsnew },
];
const PALETTE = {
  recent: ["GLD_position_summary", "POST /reconciliation", "AddVantage interface"],
  systems: [["AddVantage", "ledger \u00B7 48 interfaces"], ["CAM", "custody \u00B7 31 interfaces"], ["STAR", "legacy \u00B7 22 interfaces"]],
  endpoints: [["GET /accounts", "API 360 \u00B7 SEI SWP"], ["POST /reconciliation", "API 360 \u00B7 SEI SWP"]],
  datasets: [["GLD_position_summary", "Data 360 \u00B7 Gold"], ["SLV_clients", "Data 360 \u00B7 Silver"]],
  datapoints: [["accountId", "Datapoint 360 \u00B7 12 endpoints"], ["securityId", "Datapoint 360 \u00B7 8 endpoints"]],
  actions: [["Go to Data 360", "g d"], ["Open Settings", ""], ["Open Help", ""]],
};
const WHATS_NEW = [
  [G.neu, "System Interface 360 launched", "Mar 15"],
  [G.spark, "Datapoint 360 cross-module linking", "Mar 12"],
];
const SEMS = { success: "success", danger: "danger", warning: "warning", info: "info" };
const moduleColor = (id) => (MODULES.find((m) => m.id === id) || {}).color || BBH.muted;

/* ============================================================ component */
export default function LandingPage() {
  const [dark, setDark] = useState(false);
  const [loading, setLoading] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const t = dark ? BBH_DARK : BBH;
  const reduce = usePrefersReducedMotion();

  // load Roboto + skeleton delay
  useEffect(() => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap";
    document.head.appendChild(l);
    const tm = setTimeout(() => setLoading(false), 600);
    return () => { clearTimeout(tm); };
  }, []);

  // narrow-screen guard
  useEffect(() => {
    const check = () => setNarrow(window.innerWidth < 1024);
    check(); window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // keyboard: Cmd/Ctrl-K, Esc, and "g <key>" leader sequences
  const leaderRef = useRef({ active: false, tmr: null });
  useEffect(() => {
    const onKey = (e) => {
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === "k") { e.preventDefault(); setPaletteOpen((v) => !v); return; }
      if (k === "escape") { setPaletteOpen(false); return; }
      if (paletteOpen) return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (k === "g" && !leaderRef.current.active) {
        leaderRef.current.active = true;
        clearTimeout(leaderRef.current.tmr);
        leaderRef.current.tmr = setTimeout(() => (leaderRef.current.active = false), 1000);
        return;
      }
      if (leaderRef.current.active) {
        leaderRef.current.active = false;
        clearTimeout(leaderRef.current.tmr);
        const map = { h: "Home", d: "Data 360", i: "System Interface 360", a: "API 360", p: "Datapoint 360" };
        if (map[k]) nav(map[k]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen]);

  const nav = useCallback((label) => console.log("Navigate to " + label), []);
  const lift = !reduce;

  if (narrow) return <NarrowGuard t={t} />;

  return (
    <div style={{ minHeight: "100vh", background: t.pageBg, fontFamily: FONT, color: t.text, fontSize: 14 }}>
      <SkipLink t={t} />
      <Header t={t} dark={dark} setDark={setDark} onSearch={() => setPaletteOpen(true)} nav={nav} />
      <main id="main" style={{ padding: "0 40px 50px", maxWidth: 1600, margin: "0 auto" }}>
        <Hero t={t} nav={nav} />
        <SectionHeader t={t} title="Your workspace" />
        {loading ? <CardSkeletons t={t} /> : <ModuleGrid t={t} nav={nav} lift={lift} />}
        <SectionHeader t={t} title="Needs attention" />
        <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: SP.md, alignItems: "start" }}>
          {loading ? <PanelSkeleton t={t} h={320} /> : <AttentionPanel t={t} nav={nav} />}
          {loading ? <PanelSkeleton t={t} h={320} /> : <HealthPanel t={t} nav={nav} />}
        </div>
        <SectionHeader t={t} title="More tools" />
        <ToolsGrid t={t} nav={nav} lift={lift} />
        <WhatsNew t={t} nav={nav} />
      </main>
      {paletteOpen && <CommandPalette t={t} onClose={() => setPaletteOpen(false)} nav={(x) => { nav(x); }} reduce={reduce} />}
    </div>
  );
}

/* ----------------------------------------------------------------- header */
function Header({ t, dark, setDark, onSearch, nav }) {
  const [userOpen, setUserOpen] = useState(false);
  return (
    <header style={{ position: "sticky", top: 0, zIndex: 30, height: 64, background: t.white,
      borderBottom: `1px solid ${t.border}`, display: "flex", alignItems: "center", gap: SP.md, padding: "0 40px" }}>
      <button onClick={() => nav("Home")} aria-label="Catalog Platform home"
        style={{ display: "flex", alignItems: "center", gap: SP.sm, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
        <span style={{ width: 32, height: 32, borderRadius: 3, background: BBH.navy, color: "#fff",
          display: "grid", placeItems: "center", fontWeight: 700, fontSize: 13, letterSpacing: -0.3 }}>CP</span>
        <span style={{ fontSize: 16, fontWeight: 500, color: t.text }}>Catalog Platform</span>
      </button>

      <button onClick={onSearch} aria-label="Search (Command K)"
        style={{ flex: 1, maxWidth: 480, height: 34, display: "flex", alignItems: "center", gap: 8,
          background: t.white, border: `1px solid ${t.border}`, borderRadius: 2, padding: "0 12px",
          cursor: "text", color: t.textMuted, transition: "0.25s ease-out" }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = t.hover)}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = t.border)}>
        <span style={{ color: t.textMuted, display: "flex" }}>{I.searchIco}</span>
        <span style={{ fontSize: 13, flex: 1, textAlign: "left" }}>Search across systems, APIs, datasets, datapoints</span>
        <kbd style={{ fontSize: 11, fontWeight: 500, color: t.textMuted, border: `1px solid ${t.border}`,
          borderRadius: 2, padding: "1px 5px", fontFamily: FONT }}>{G.cmd}K</kbd>
      </button>

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: BBH.success }} aria-hidden="true" />
        <span style={{ fontSize: 11, fontWeight: 600, color: t.textHelp }}>LIVE {G.mid} 6m ago</span>
      </div>

      <button aria-label="Notifications, 3 unread" onClick={() => nav("Notifications")}
        style={{ position: "relative", width: 34, height: 34, borderRadius: 2, border: "none", background: "none",
          cursor: "pointer", color: t.textHelp, display: "grid", placeItems: "center", transition: "0.25s ease-out" }}
        onMouseEnter={(e) => (e.currentTarget.style.color = t.hover)}
        onMouseLeave={(e) => (e.currentTarget.style.color = t.textHelp)}>
        {I.bell}
        <span style={{ position: "absolute", top: 6, right: 6, width: 7, height: 7, borderRadius: "50%", background: BBH.danger }} />
      </button>

      <button aria-label={dark ? "Switch to light mode" : "Switch to dark mode"} onClick={() => setDark((v) => !v)}
        style={{ width: 34, height: 34, borderRadius: 2, border: `1px solid ${t.border}`, background: t.white,
          cursor: "pointer", color: t.text, fontSize: 15, transition: "0.25s ease-out" }}
        onMouseEnter={(e) => (e.currentTarget.style.color = t.hover)}
        onMouseLeave={(e) => (e.currentTarget.style.color = t.text)}>{dark ? G.sun : G.moon}</button>

      <div style={{ position: "relative" }}>
        <button onClick={() => setUserOpen((v) => !v)} aria-haspopup="true" aria-expanded={userOpen}
          style={{ display: "flex", alignItems: "center", gap: 7, background: "none", border: "none", cursor: "pointer", padding: 0, color: t.text }}>
          <span style={{ width: 28, height: 28, borderRadius: "50%", background: BBH.dark, color: "#fff",
            display: "grid", placeItems: "center", fontWeight: 600, fontSize: 12 }}>AN</span>
          <span style={{ fontSize: 14, fontWeight: 500 }}>Aneesh</span>
          <span style={{ fontSize: 11, color: t.textMuted }}>{G.caret}</span>
        </button>
        {userOpen && (
          <div role="menu" style={{ position: "absolute", right: 0, top: 38, width: 180, background: t.white,
            border: `1px solid ${t.border}`, borderRadius: 3, boxShadow: "0 10px 30px rgba(0,0,0,0.18)", padding: 5 }}>
            {["Profile", "Preferences", "Sign out"].map((x) => (
              <button key={x} role="menuitem" onClick={() => { setUserOpen(false); nav(x); }}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", fontSize: 13,
                  border: "none", background: "none", cursor: "pointer", color: t.text, borderRadius: 2 }}
                onMouseEnter={(e) => (e.currentTarget.style.background = t.hoverBg)}
                onMouseLeave={(e) => (e.currentTarget.style.background = "none")}>{x}</button>
            ))}
          </div>
        )}
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------- hero */
function Hero({ t, nav }) {
  const chips = [["3 datasets", "data"], ["2 API", "api"], ["1 system alert", "system"]];
  return (
    <section style={{ paddingTop: 30, paddingBottom: 20 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, color: t.text, margin: 0, letterSpacing: -0.2, lineHeight: 1.2 }}>
        Good morning, Aneesh {G.wave}
      </h1>
      <p style={{ fontSize: 14, color: t.textHelp, margin: "8px 0 0", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span>You have</span>
        {chips.map(([label, mod], i) => (
          <React.Fragment key={label}>
            <button onClick={() => nav(label)} style={{ border: "none", cursor: "pointer", background: t.tint,
              color: t.dark, fontSize: 13, fontWeight: 500, padding: "2px 8px", borderRadius: 2, transition: "0.25s ease-out" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = t.hover; e.currentTarget.style.color = "#fff"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = t.tint; e.currentTarget.style.color = t.dark; }}>
              {label}</button>
            {i < chips.length - 1 && <span style={{ color: t.textMuted }}>{G.mid}</span>}
          </React.Fragment>
        ))}
        <span>needing attention.</span>
      </p>
    </section>
  );
}

/* ---------------------------------------------------------- section header */
function SectionHeader({ t, title }) {
  return (
    <h2 style={{ fontSize: 24, fontWeight: 500, color: t.dark, borderBottom: `2px solid ${t.dark}`,
      paddingBottom: 12, marginBottom: 24, marginTop: 30, lineHeight: 1 }}>{title}</h2>
  );
}

/* ------------------------------------------------------------ module cards */
function ModuleGrid({ t, nav, lift }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(260px, 1fr))", gap: SP.md }}>
      {MODULES.map((m) => <ModuleCard key={m.id} t={t} m={m} nav={nav} lift={lift} />)}
    </div>
  );
}
function ModuleCard({ t, m, nav, lift }) {
  const [hov, setHov] = useState(false);
  const sem = SEMS[m.status[1]] || "info";
  const semColor = BBH[sem], semBg = BBH[sem + "Bg"];
  return (
    <button onClick={() => nav(m.name)} aria-label={`Explore ${m.name}`}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ position: "relative", textAlign: "left", height: 240, background: t.white,
        border: `1px solid ${hov ? m.color : t.border}`, borderRadius: 3, padding: 20, cursor: "pointer",
        display: "flex", flexDirection: "column", transition: "0.25s ease-out", overflow: "hidden",
        transform: lift && hov ? "translateY(-2px)" : "none",
        boxShadow: hov ? "0 3px 5px rgba(0,0,0,0.2)" : "0 1px 2px rgba(15,23,42,0.04)" }}>
      {/* colored left spine — disambiguates the modules beyond color alone */}
      <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: m.color }} aria-hidden="true" />
      <span style={{ width: 40, height: 40, borderRadius: 3, background: m.color + "1F", color: m.color,
        display: "grid", placeItems: "center" }} aria-hidden="true">{m.icon}</span>
      <h3 style={{ fontSize: 18, fontWeight: 500, color: t.text, margin: "12px 0 2px" }}>{m.name}</h3>
      <p style={{ fontSize: 12, color: t.textMuted, margin: 0 }}>{m.desc}</p>
      <div style={{ marginTop: "auto", display: "flex", gap: 16 }}>
        {m.kpis.map(([n, l]) => (
          <div key={l}>
            <div style={{ fontSize: 22, fontWeight: 700, color: t.text, lineHeight: 1.1 }}>{n}</div>
            <div style={{ fontSize: 12, color: t.textMuted }}>{l}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14 }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3,
          color: sem === "info" ? t.dark : semColor, background: sem === "info" ? t.tint : semBg,
          padding: "4px 6px", borderRadius: 2 }}>
          {m.status[1] === "success" ? G.dot + " " : ""}{m.status[0]}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: m.color }}>
          Explore <span style={{ display: "inline-block", transition: "0.25s ease-out", transform: hov ? "translateX(2px)" : "none" }}>{G.arrow}</span>
        </span>
      </div>
    </button>
  );
}

/* --------------------------------------------------------- attention panel */
function AttentionPanel({ t, nav }) {
  const [filter, setFilter] = useState("all");
  const rows = useMemo(() => filter === "all" ? ALERTS : ALERTS.filter((a) => a.sev === filter), [filter]);
  return (
    <section style={{ background: t.white, border: `1px solid ${t.border}`, borderRadius: 3, padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <h3 style={{ fontSize: 18, fontWeight: 500, color: t.text, margin: 0 }}>Needs your attention</h3>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by severity"
          style={{ background: t.disabled, border: "none", borderRadius: 2, padding: "3px 10px", fontSize: 12,
            fontWeight: 500, color: t.text, cursor: "pointer", fontFamily: FONT }}>
          <option value="all">All severities</option>
          <option value="danger">Critical</option>
          <option value="warning">Warnings</option>
        </select>
      </div>
      {rows.length === 0 ? (
        <Empty t={t} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {rows.map((a, i) => <AlertRow key={i} t={t} a={a} nav={nav} />)}
        </div>
      )}
      <button onClick={() => nav("All alerts")} style={{ marginTop: 14, background: "none", border: "none", cursor: "pointer",
        fontSize: 13, fontWeight: 500, color: t.text, padding: 0, transition: "0.25s ease-out" }}
        onMouseEnter={(e) => (e.currentTarget.style.color = t.hover)}
        onMouseLeave={(e) => (e.currentTarget.style.color = t.text)}>
        See all 8 alerts {G.arrow}</button>
    </section>
  );
}
function AlertRow({ t, a, nav }) {
  const [hov, setHov] = useState(false);
  const sevColor = a.sev === "danger" ? BBH.danger : BBH.warning;
  const oColor = moduleColor(a.origin);
  return (
    <button onClick={() => nav(a.title)} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left", padding: 10,
        borderRadius: 2, border: "none", background: hov ? t.hoverBg : "transparent", cursor: "pointer", transition: "0.25s ease-out" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: sevColor, flexShrink: 0 }} aria-hidden="true" />
      <span style={{ width: 22, height: 22, borderRadius: 2, background: oColor + "1F", color: oColor,
        display: "grid", placeItems: "center", flexShrink: 0 }} aria-hidden="true">
        {React.cloneElement((MODULES.find((m) => m.id === a.origin) || {}).icon || I.data, {})}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 14, fontWeight: 500, color: t.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          <span style={{ color: sevColor, fontWeight: 700, fontSize: 11, textTransform: "uppercase", marginRight: 6 }}>{a.sev === "danger" ? "Critical" : "Warning"}</span>
          {a.title}</span>
        <span style={{ display: "block", fontSize: 12, color: t.textHelp }}>{a.ctx}</span>
      </span>
      <span style={{ fontSize: 11, fontWeight: 500, color: t.textMuted, flexShrink: 0 }}>{a.time}</span>
      <span style={{ color: t.textMuted, opacity: hov ? 1 : 0, transition: "0.25s ease-out" }}>{G.chevR}</span>
    </button>
  );
}

/* ------------------------------------------------------------ health panel */
function HealthPanel({ t, nav }) {
  return (
    <section style={{ background: t.white, border: `1px solid ${t.border}`, borderRadius: 3, padding: 20 }}>
      <h3 style={{ fontSize: 18, fontWeight: 500, color: t.text, margin: "0 0 14px" }}>Health &amp; quality</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {HEALTH.map((h) => {
          const c = BBH[h.state];
          return (
            <div key={h.label} style={{ padding: 15, background: t.pageBg, border: `1px solid ${t.border}`, borderRadius: 2 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: t.textMuted }}>{h.label}</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 6 }}>
                <span style={{ fontSize: 24, fontWeight: 700, color: c }}>{h.val}</span>
                {h.trend && (
                  <span style={{ fontSize: 11, fontWeight: 600, color: h.trend === "up" ? BBH.success : BBH.success }}>
                    {h.trend === "up" ? G.up : G.down} {h.delta}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <button onClick={() => nav("Health & Quality")} style={{ marginTop: 14, background: "none", border: "none", cursor: "pointer",
        fontSize: 13, fontWeight: 500, color: t.text, padding: 0, transition: "0.25s ease-out" }}
        onMouseEnter={(e) => (e.currentTarget.style.color = t.hover)}
        onMouseLeave={(e) => (e.currentTarget.style.color = t.text)}>
        Open dashboard {G.arrow}</button>
    </section>
  );
}

/* ------------------------------------------------------------- tools grid */
function ToolsGrid({ t, nav, lift }) {
  return (
    <div>
      <ToolGroup t={t} label="Operations" items={OPS} nav={nav} lift={lift} />
      <div style={{ height: 24 }} />
      <ToolGroup t={t} label="Admin" items={ADMIN} nav={nav} lift={lift} />
    </div>
  );
}
function ToolGroup({ t, label, items, nav, lift }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: t.textMuted, marginBottom: 10 }}>{label}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        {items.map((it) => <ToolTile key={it.id} t={t} it={it} nav={nav} lift={lift} />)}
      </div>
    </div>
  );
}
function ToolTile({ t, it, nav, lift }) {
  const [hov, setHov] = useState(false);
  return (
    <button onClick={() => nav(it.name)} aria-label={it.name}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ textAlign: "left", height: 96, background: t.white, border: `1px solid ${hov ? t.hover : t.border}`,
        borderRadius: 3, padding: 15, cursor: "pointer", transition: "0.25s ease-out",
        transform: lift && hov ? "translateY(-2px)" : "none",
        boxShadow: hov ? "0 3px 5px rgba(0,0,0,0.2)" : "0 1px 2px rgba(15,23,42,0.04)",
        display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
      <span style={{ color: hov ? t.hover : t.dark, transition: "0.25s ease-out" }} aria-hidden="true">{it.icon}</span>
      <span>
        <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: t.text }}>{it.name}</span>
        <span style={{ display: "block", fontSize: 11, color: t.textHelp }}>{it.desc}</span>
      </span>
    </button>
  );
}

/* -------------------------------------------------------------- whats new */
function WhatsNew({ t, nav }) {
  return (
    <section style={{ marginTop: 30, minHeight: 80, background: t.accordionBg, borderRadius: 3, padding: 20,
      display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
      <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: t.textMuted }}>What's new</span>
      {WHATS_NEW.map(([ico, txt, date], i) => (
        <span key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, color: t.text }}>
          <span aria-hidden="true">{ico}</span>{txt}
          <span style={{ fontSize: 11, color: t.textHelp }}>{date}</span>
          {i < WHATS_NEW.length - 1 && <span style={{ color: t.textMuted, marginLeft: 10 }}>{G.mid}</span>}
        </span>
      ))}
      <button onClick={() => nav("Release notes")} style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer",
        fontSize: 14, fontWeight: 500, color: t.dark, padding: 0, transition: "0.25s ease-out" }}
        onMouseEnter={(e) => (e.currentTarget.style.color = t.hover)}
        onMouseLeave={(e) => (e.currentTarget.style.color = t.dark)}>
        Release notes {G.arrow}</button>
    </section>
  );
}

/* -------------------------------------------------------- command palette */
function CommandPalette({ t, onClose, nav, reduce }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current && inputRef.current.focus(); }, []);

  const groups = useMemo(() => {
    const s = q.trim().toLowerCase();
    const match = (txt) => !s || txt.toLowerCase().includes(s);
    const g = [];
    if (!s) g.push(["Recent", PALETTE.recent.map((r) => ({ label: r, meta: "", icon: I.searchIco, run: () => nav(r) }))]);
    const sys = PALETTE.systems.filter(([n]) => match(n)).map(([n, m]) => ({ label: n, meta: m, icon: I.system, run: () => nav(n) }));
    const ep = PALETTE.endpoints.filter(([n]) => match(n)).map(([n, m]) => ({ label: n, meta: m, icon: I.api, run: () => nav(n) }));
    const ds = PALETTE.datasets.filter(([n]) => match(n)).map(([n, m]) => ({ label: n, meta: m, icon: I.data, run: () => nav(n) }));
    const dp = PALETTE.datapoints.filter(([n]) => match(n)).map(([n, m]) => ({ label: n, meta: m, icon: I.datapoint, run: () => nav(n) }));
    const ac = PALETTE.actions.filter(([n]) => match(n)).map(([n, m]) => ({ label: n, meta: m, icon: I.settings, run: () => nav(n) }));
    if (sys.length) g.push(["Systems", sys]);
    if (ep.length) g.push(["Endpoints", ep]);
    if (ds.length) g.push(["Datasets", ds]);
    if (dp.length) g.push(["Datapoints", dp]);
    if (ac.length) g.push(["Actions", ac]);
    return g;
  }, [q, nav]);

  const flat = useMemo(() => groups.flatMap(([, items]) => items), [groups]);
  useEffect(() => { setActive(0); }, [q]);

  const onKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, flat.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); flat[active] && flat[active].run(); onClose(); }
  };

  let idx = -1;
  return (
    <div onClick={onClose} role="dialog" aria-modal="true" aria-label="Command palette"
      style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.4)",
        backdropFilter: "blur(4px)", display: "flex", justifyContent: "center", alignItems: "flex-start", paddingTop: "15vh",
        animation: reduce ? "none" : "cpFade .2s ease-out" }}>
      <style>{"@keyframes cpFade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}"}</style>
      <div onClick={(e) => e.stopPropagation()} onKeyDown={onKey}
        style={{ width: 640, maxWidth: "92vw", background: t.white, border: `1px solid ${t.border}`, borderRadius: 3,
          boxShadow: "0 10px 30px rgba(0,0,0,0.18)", overflow: "hidden" }}>
        <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search across systems, APIs, datasets, datapoints" aria-label="Search"
          style={{ width: "100%", height: 48, border: "none", outline: "none", fontSize: 16, padding: "0 20px",
            background: t.white, color: t.text, fontFamily: FONT, borderBottom: `1px solid ${t.border}`, boxSizing: "border-box" }} />
        <div style={{ maxHeight: "50vh", overflow: "auto" }}>
          {flat.length === 0 ? (
            <div style={{ padding: 30, textAlign: "center", color: t.textMuted, fontSize: 14 }}>
              No matches. Try a system, endpoint, dataset, or datapoint name.</div>
          ) : groups.map(([label, items]) => (
            <div key={label}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6,
                color: t.textMuted, padding: "10px 20px 5px" }}>{label}</div>
              {items.map((it) => {
                idx++; const isActive = idx === active; const myIdx = idx;
                return (
                  <button key={it.label} onMouseEnter={() => setActive(myIdx)} onClick={() => { it.run(); onClose(); }}
                    style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left", height: 40,
                      padding: "0 20px", border: "none", cursor: "pointer", background: isActive ? t.pageBg : "transparent",
                      borderLeft: `3px solid ${isActive ? BBH.pop : "transparent"}`, color: t.text, transition: "0.1s" }}>
                    <span style={{ color: t.muted, display: "flex" }} aria-hidden="true">{it.icon}</span>
                    <span style={{ fontSize: 14, fontWeight: 500, flex: 1 }}>{it.label}</span>
                    {it.meta && <span style={{ fontSize: 12, color: t.textMuted }}>{it.meta}</span>}
                    {isActive && <span style={{ fontSize: 13, color: t.textMuted }}>{G.enter}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- skeletons */
function CardSkeletons({ t }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(260px, 1fr))", gap: SP.md }}>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} style={{ height: 240, background: t.white, border: `1px solid ${t.border}`, borderRadius: 3, padding: 20 }}>
          <Pulse t={t} w={40} h={40} r={3} />
          <Pulse t={t} w="70%" h={16} mt={14} /><Pulse t={t} w="90%" h={10} mt={8} />
          <div style={{ marginTop: 40, display: "flex", gap: 16 }}>{[0,1,2].map((j) => <Pulse key={j} t={t} w={44} h={28} />)}</div>
          <Pulse t={t} w="100%" h={20} mt={26} />
        </div>
      ))}
    </div>
  );
}
function PanelSkeleton({ t, h }) {
  return <div style={{ height: h, background: t.white, border: `1px solid ${t.border}`, borderRadius: 3, padding: 20 }}>
    <Pulse t={t} w="40%" h={16} /><div style={{ height: 14 }} />
    {[0,1,2,3].map((i) => <Pulse key={i} t={t} w="100%" h={36} mt={8} />)}</div>;
}
function Pulse({ t, w, h, r = 2, mt = 0 }) {
  return <div style={{ width: w, height: h, borderRadius: r, marginTop: mt, background: t.disabled, animation: "cpPulse 1.2s ease-in-out infinite" }} />;
}

/* ----------------------------------------------------------------- misc */
function Empty({ t }) {
  return (
    <div style={{ padding: "30px 10px", textAlign: "center" }}>
      <div style={{ fontSize: 14, color: t.text, fontWeight: 500 }}>No alerts at this severity. You're all caught up {G.spark}</div>
      <div style={{ fontSize: 12, color: t.textHelp, marginTop: 4 }}>Switch the filter to see other items.</div>
    </div>
  );
}
function NarrowGuard({ t }) {
  return (
    <div style={{ minHeight: "100vh", background: t.pageBg, fontFamily: FONT, display: "grid", placeItems: "center", padding: 40 }}>
      <div style={{ textAlign: "center", maxWidth: 360 }}>
        <div style={{ fontSize: 40 }}>{G.laptop}</div>
        <h1 style={{ fontSize: 20, fontWeight: 500, color: t.text }}>Best on desktop</h1>
        <p style={{ fontSize: 14, color: t.textHelp }}>The Catalog Platform is built for wide screens. Please open it on a display wider than 1024px.</p>
      </div>
    </div>
  );
}
function SkipLink({ t }) {
  return (
    <a href="#main" style={{ position: "absolute", left: -9999, top: 8, zIndex: 60, background: t.white, color: t.dark,
      padding: "8px 14px", borderRadius: 2, border: `1px solid ${t.border}`, fontSize: 13, fontWeight: 500 }}
      onFocus={(e) => { e.currentTarget.style.left = "8px"; }}
      onBlur={(e) => { e.currentTarget.style.left = "-9999px"; }}>Skip to content</a>
  );
}

/* --------------------------------------------------------- reduced motion */
function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduce(mq.matches); on();
    mq.addEventListener ? mq.addEventListener("change", on) : mq.addListener(on);
    return () => { mq.removeEventListener ? mq.removeEventListener("change", on) : mq.removeListener(on); };
  }, []);
  return reduce;
}

/* global keyframes for pulse (injected once) */
if (typeof document !== "undefined" && !document.getElementById("cp-kf")) {
  const s = document.createElement("style"); s.id = "cp-kf";
  s.textContent = "@keyframes cpPulse{0%,100%{opacity:1}50%{opacity:.45}}";
  document.head.appendChild(s);
}
