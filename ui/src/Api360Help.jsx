// =====================================================================
// Api360Help.jsx — in-app help & navigation guide for the API 360 feature.
//
// Render as a help panel/modal, or route it. Uses the ST theme tokens.
// Explains every screen, every function, with tooltips and usage steps so a
// new user (developer or business analyst) can self-serve.
//
//   import Api360Help from "./Api360Help";
//   {showHelp && <Api360Help ST={ST} onClose={() => setShowHelp(false)} />}
// =====================================================================
import React, { useState } from "react";

const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "sources", label: "Sources & ingestion" },
  { id: "apiview", label: "API dependency view" },
  { id: "flowview", label: "Business flow view" },
  { id: "drilldown", label: "Drill-down drawer" },
  { id: "search", label: "Search" },
  { id: "roles", label: "For developers & BAs" },
  { id: "faq", label: "FAQ & troubleshooting" },
];

export default function Api360Help({ ST, onClose }) {
  const t = ST;
  const [sec, setSec] = useState("overview");
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,.5)", zIndex: 60, display: "grid", placeItems: "center" }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(960px, 94vw)", height: "min(680px, 90vh)",
        background: t.panel, border: `1px solid ${t.border}`, borderRadius: 14, display: "flex", overflow: "hidden",
        boxShadow: "0 24px 60px rgba(2,6,23,.4)", color: t.text, fontFamily: "'Inter',system-ui,sans-serif" }}>
        {/* side index */}
        <div style={{ width: 220, flexShrink: 0, background: t.panel2, borderRight: `1px solid ${t.border}`, padding: 14, overflow: "auto" }}>
          <div style={{ fontWeight: 700, fontSize: 14, padding: "4px 8px 12px" }}>API 360 — Help</div>
          {SECTIONS.map((s) => (
            <button key={s.id} onClick={() => setSec(s.id)} style={{ display: "block", width: "100%", textAlign: "left",
              border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, padding: "8px 10px", borderRadius: 8, marginBottom: 2,
              background: sec === s.id ? t.accent : "transparent", color: sec === s.id ? "#fff" : t.sub }}>{s.label}</button>
          ))}
        </div>
        {/* content */}
        <div style={{ flex: 1, overflow: "auto", padding: "22px 26px", position: "relative" }}>
          <button onClick={onClose} style={{ position: "absolute", top: 16, right: 18, border: `1px solid ${t.border}`,
            background: t.panel2, color: t.text, borderRadius: 8, width: 30, height: 30, cursor: "pointer" }}>✕</button>
          <Content sec={sec} t={t} />
        </div>
      </div>
    </div>
  );
}

function H({ t, children }) { return <h2 style={{ fontSize: 18, margin: "0 0 6px", color: t.text }}>{children}</h2>; }
function P({ t, children }) { return <p style={{ fontSize: 13.5, lineHeight: 1.6, color: t.text, margin: "0 0 12px", maxWidth: 640 }}>{children}</p>; }
function Tip({ t, term, children }) {
  return <span title={children} style={{ borderBottom: `1px dotted ${t.sub}`, cursor: "help", fontWeight: 600 }}>{term}</span>;
}
function Step({ t, n, children }) {
  return <div style={{ display: "flex", gap: 12, margin: "10px 0" }}>
    <span style={{ width: 24, height: 24, borderRadius: "50%", background: t.accent, color: "#fff", display: "grid", placeItems: "center", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{n}</span>
    <div style={{ fontSize: 13.5, lineHeight: 1.55, color: t.text }}>{children}</div></div>;
}
function Code({ t, children }) {
  return <code style={{ fontFamily: "'SF Mono',ui-monospace,monospace", fontSize: 12, background: t.panel2, border: `1px solid ${t.border}`, borderRadius: 5, padding: "1px 5px" }}>{children}</code>;
}

function Content({ sec, t }) {
  if (sec === "overview") return (
    <>
      <H t={t}>What is API 360?</H>
      <P t={t}>API 360 is a self-contained exploration view inside the CP Metadata Catalog for understanding the SEI API. It answers three questions the API documents can't answer on their own when read separately:</P>
      <ul style={{ fontSize: 13.5, lineHeight: 1.7, color: t.text, maxWidth: 640 }}>
        <li><b>What endpoints exist and how do they relate?</b> — from the Swagger / OpenAPI spec.</li>
        <li><b>What does each field mean?</b> — from the field definitions (dictionary), shown in the drawer.</li>
        <li><b>How are endpoints called together to do real work?</b> — from the Postman business-flow collections.</li>
      </ul>
      <P t={t}>It is exploration and documentation only. It does not call the SEI API and does not execute anything.</P>
    </>
  );
  if (sec === "sources") return (
    <>
      <H t={t}>Sources & ingestion</H>
      <P t={t}>API 360 reads three files from the shared drive folder <Code t={t}>/opt/approot/webfs/cp-datacatalog/</Code>:</P>
      <ul style={{ fontSize: 13.5, lineHeight: 1.7, color: t.text }}>
        <li><Code t={t}>swagger/</Code> — the SEI OpenAPI/Swagger spec → endpoints, fields, dependencies.</li>
        <li><Code t={t}>postman/</Code> — the SEI Postman collection → business flows and call sequences.</li>
        <li><Code t={t}>overlay/</Code> — optional field dictionary CSV → field definitions in the drawer.</li>
      </ul>
      <P t={t}>Ingestion runs on a schedule (the catalog's existing CronJob) and re-parses the files. Drop an updated Swagger or Postman file in the folder and the next run refreshes the view. The header badge shows <Tip t={t} term="LIVE / DEMO">LIVE = reading the catalog API; DEMO = API unreachable, showing embedded sample data.</Tip>.</P>
    </>
  );
  if (sec === "apiview") return (
    <>
      <H t={t}>API dependency view</H>
      <P t={t}>Each node is a SEI endpoint, colored by HTTP method (<span style={{ color: "#0f766e", fontWeight: 700 }}>GET</span>, <span style={{ color: "#7c3aed", fontWeight: 700 }}>POST</span>, …). Edges show how endpoints relate:</P>
      <ul style={{ fontSize: 13.5, lineHeight: 1.7, color: t.text }}>
        <li><b>Solid edge</b> — <Tip t={t} term="shared $ref dependency">Two endpoints reuse the same schema object (e.g. both return an Account). The spec proves they're related.</Tip>, labeled with the shared object.</li>
        <li><b>Dashed amber edge</b> — <Tip t={t} term="runtime call">An observed call relationship (e.g. a job that calls one after the other). Not provable from the spec alone.</Tip>.</li>
      </ul>
      <Step t={t} n="1">Click any endpoint node → the drawer on the right drills into its fields, dependencies, and flows.</Step>
      <Step t={t} n="2">When a node is selected, unrelated nodes/edges dim so you can read its neighborhood.</Step>
      <Step t={t} n="3">Drag the background to pan; use ＋ / － / ⤢ (top-right) to zoom and reset.</Step>
    </>
  );
  if (sec === "flowview") return (
    <>
      <H t={t}>Business flow view</H>
      <P t={t}>Switch to <b>Business flow</b> (toolbar, top-left). Each flow is a SEI Postman collection rendered as an ordered sequence of API calls.</P>
      <ul style={{ fontSize: 13.5, lineHeight: 1.7, color: t.text }}>
        <li>Numbered violet nodes are the <b>ordered steps</b> (call 1, 2, 3…).</li>
        <li>Edge labels show the <Tip t={t} term={"{{variable}}"}>The value captured from one step's response and passed into a later step — e.g. accountId from /accounts feeds /positions.</Tip> passed between steps.</li>
        <li>Pick a different flow with the buttons next to the toggle (e.g. Daily Reconciliation, Position Load).</li>
      </ul>
      <Step t={t} n="1">Click a step → the drawer shows its input/output and the data passed in from the previous step and out to the next.</Step>
      <Step t={t} n="2">From a step, click <b>Inspect … in API dependency</b> to jump to that endpoint in the other view.</Step>
    </>
  );
  if (sec === "drilldown") return (
    <>
      <H t={t}>Drill-down drawer</H>
      <P t={t}>The right-hand panel is context-sensitive. In the API view, selecting an endpoint shows:</P>
      <ul style={{ fontSize: 13.5, lineHeight: 1.7, color: t.text }}>
        <li><b>Schema object</b> — the $ref it returns, and the owner.</li>
        <li><b>Fields</b> — each field with type, definition (from the dictionary), and a 🔑 marker for <Tip t={t} term="key-like fields">Fields that look like identifiers (id, key, no, code) — the join points across endpoints.</Tip>.</li>
        <li><b>Dependencies</b> — which endpoints it links to, and via which shared object or runtime relationship.</li>
        <li><b>Used in flows</b> — the business flows that call this endpoint, with a jump button.</li>
      </ul>
      <P t={t}>In the flow view, selecting a step shows its I/O, the variable in from the prior step, the variable out to the next, and a link to inspect the underlying endpoint.</P>
    </>
  );
  if (sec === "search") return (
    <>
      <H t={t}>Search</H>
      <P t={t}>Use the catalog's top search box to find an endpoint, a field, or a flow by name. Results are typed (endpoint / field / flow) so you can tell what you're jumping to. Searching a business term like <Code t={t}>account</Code> surfaces every endpoint field and flow that mentions it.</P>
    </>
  );
  if (sec === "roles") return (
    <>
      <H t={t}>For developers & business analysts</H>
      <P t={t}><b>Developers</b> — use the API dependency view to see which endpoints share schema (impact/blast radius) and the business flow view to get the exact call sequence and the variables passed between calls, so you can build an integration without reverse-engineering tutorials.</P>
      <P t={t}><b>Business analysts</b> — start from the field definitions in the drawer to confirm what data each endpoint carries, and use the flow view to see, in business terms, how a process like reconciliation actually runs across the API. The owner and definitions give you a shared vocabulary with engineering.</P>
    </>
  );
  if (sec === "faq") return (
    <>
      <H t={t}>FAQ & troubleshooting</H>
      <P t={t}><b>It says DEMO, not LIVE.</b> The UI can't reach the catalog API, so it's showing embedded sample data. Check the API pod is up and the <Code t={t}>/api360</Code> routes respond; the view flips to LIVE automatically when they do.</P>
      <P t={t}><b>An endpoint in a flow looks missing/grey.</b> The Postman step references an endpoint not present in the current Swagger — a sign the collection and spec have drifted. Re-export both from SEI and re-drop them in the webfs folder.</P>
      <P t={t}><b>I updated the Swagger but don't see changes.</b> Ingestion runs on a schedule; wait for the next run or trigger the ingestion job. Confirm the file is in <Code t={t}>/opt/approot/webfs/cp-datacatalog/swagger/</Code>.</P>
      <P t={t}><b>Field has no definition.</b> The field isn't in the dictionary CSV, or names don't match. Add it to the overlay file with matching field name.</P>
    </>
  );
  return null;
}
