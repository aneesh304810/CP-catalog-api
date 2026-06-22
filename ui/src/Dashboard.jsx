import React, { useState, useEffect } from "react";
import { api } from "./api.js";

/* ============================================================
   Observability / Data Quality / Gate dashboards.
   Two audience modes: 'support' (operational) and 'business' (trust).
   Falls back to demo data when API unreachable.
   ============================================================ */

const DEMO = {
  qualitySummary: {
    rollup: { datasets: 8, avg_score: 92.4, datasets_failing: 1 },
    by_dimension: [
      { dimension: "completeness", pass_pct: 98.0, total: 20 },
      { dimension: "uniqueness", pass_pct: 90.0, total: 10 },
      { dimension: "validity", pass_pct: 95.0, total: 12 },
      { dimension: "consistency", pass_pct: 88.0, total: 8 },
      { dimension: "freshness", pass_pct: 100.0, total: 6 },
    ],
    datasets: [
      { dataset_key: "oracle_prod._.pbdw.slv_positions", object_name: "SLV_POSITIONS", layer: "silver", platform_id: "oracle_prod", score_pct: 66.7, tests_total: 3, tests_passed: 2, tests_failed: 1, tests_warn: 0 },
      { dataset_key: "oracle_prod._.imdw.gld_position_summary", object_name: "GLD_POSITION_SUMMARY", layer: "gold", platform_id: "oracle_prod", score_pct: 100, tests_total: 2, tests_passed: 2, tests_failed: 0, tests_warn: 0 },
      { dataset_key: "oracle_prod._.pbdw.brz_positions", object_name: "BRZ_POSITIONS", layer: "bronze", platform_id: "oracle_prod", score_pct: 100, tests_total: 2, tests_passed: 2, tests_failed: 0, tests_warn: 0 },
      { dataset_key: "mssql_risk.risk.positions", object_name: "positions", layer: "none", platform_id: "mssql_risk", score_pct: 95, tests_total: 4, tests_passed: 3, tests_failed: 0, tests_warn: 1 },
    ],
  },
  gates: {
    counts: { pass: 6, warn: 1, fail: 1 },
    gates: [
      { scope_key: "oracle_prod._.pbdw.slv_positions", gate_name: "model:slv_positions", verdict: "fail", blocking: "Y", rules_total: 3, rules_passed: 2, rules_failed: 1, object_name: "SLV_POSITIONS", layer: "silver", platform_id: "oracle_prod" },
      { scope_key: "mssql_risk.risk.positions", gate_name: "model:positions", verdict: "warn", blocking: "N", rules_total: 4, rules_passed: 3, rules_failed: 0, object_name: "positions", layer: "none", platform_id: "mssql_risk" },
      { scope_key: "oracle_prod._.imdw.gld_position_summary", gate_name: "model:gld_position_summary", verdict: "pass", blocking: "N", rules_total: 2, rules_passed: 2, rules_failed: 0, object_name: "GLD_POSITION_SUMMARY", layer: "gold", platform_id: "oracle_prod" },
    ],
  },
  runs: {
    by_day: [
      { day: "Jun 12", total: 8, succeeded: 8, failed: 0, avg_duration_s: 245 },
      { day: "Jun 13", total: 8, succeeded: 7, failed: 1, avg_duration_s: 250 },
      { day: "Jun 14", total: 8, succeeded: 8, failed: 0, avg_duration_s: 243 },
      { day: "Jun 15", total: 8, succeeded: 8, failed: 0, avg_duration_s: 238 },
      { day: "Jun 16", total: 8, succeeded: 6, failed: 2, avg_duration_s: 261 },
      { day: "Jun 17", total: 8, succeeded: 8, failed: 0, avg_duration_s: 244 },
      { day: "Jun 18", total: 8, succeeded: 8, failed: 0, avg_duration_s: 240 },
    ],
    recent_failures: [
      { dag_id: "swp_medallion_dag", task_id: "slv_positions", status: "failed", start_ts: "2026-06-16 06:03", duration_s: 82 },
    ],
  },
  freshness: {
    freshness: [
      { dataset_key: "oracle_prod._.imdw.gld_position_summary", object_name: "GLD_POSITION_SUMMARY", layer: "gold", platform_id: "oracle_prod", lag_minutes: 35, status: "fresh", row_count: 1240 },
      { dataset_key: "oracle_prod._.pbdw.slv_positions", object_name: "SLV_POSITIONS", layer: "silver", platform_id: "oracle_prod", lag_minutes: 42, status: "fresh", row_count: 58210 },
      { dataset_key: "oracle_prod._.pbdw.brz_positions", object_name: "BRZ_POSITIONS", layer: "bronze", platform_id: "oracle_prod", lag_minutes: 50, status: "fresh", row_count: 58210 },
      { dataset_key: "mssql_risk.risk.positions", object_name: "positions", layer: "none", platform_id: "mssql_risk", lag_minutes: 190, status: "stale", row_count: 57800 },
    ],
  },
};

const V = {
  pass: "#16a34a", warn: "#d97706", fail: "#dc2626",
  fresh: "#16a34a", stale: "#d97706", error: "#dc2626",
};

export default function Dashboard({ t, audience, setAudience }) {
  const [q, setQ] = useState(null);
  const [gates, setGates] = useState(null);
  const [runs, setRuns] = useState(null);
  const [fresh, setFresh] = useState(null);

  useEffect(() => {
    api.base && Promise.allSettled([
      api.health(),
    ]).then(async ([h]) => {
      const live = h.status === "fulfilled";
      try {
        setQ(live ? await fetchJSON("/quality/summary") : DEMO.qualitySummary);
      } catch { setQ(DEMO.qualitySummary); }
      try { setGates(live ? await fetchJSON("/gates") : DEMO.gates); }
      catch { setGates(DEMO.gates); }
      try { setRuns(live ? await fetchJSON("/observability/runs") : DEMO.runs); }
      catch { setRuns(DEMO.runs); }
      try { setFresh(live ? await fetchJSON("/observability/freshness") : DEMO.freshness); }
      catch { setFresh(DEMO.freshness); }
    });
  }, []);

  if (!q || !gates) return <div style={{ padding: 40, color: t.sub }}>Loading…</div>;

  return (
    <div style={{ flex: 1, overflow: "auto", padding: 24, background: t.bg }}>
      {/* audience switch */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 680, color: t.text }}>
          {audience === "support" ? "Platform Health & Operations" : "Data Trust & Quality"}
        </h2>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", background: t.panel2, border: `1px solid ${t.border}`,
          borderRadius: 9, padding: 3 }}>
          {["support", "business"].map((a) => (
            <button key={a} onClick={() => setAudience(a)}
              style={{ border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 600,
                padding: "6px 14px", borderRadius: 6,
                background: audience === a ? t.accent : "transparent",
                color: audience === a ? "#fff" : t.sub }}>
              {a === "support" ? "Global Support" : "Business"}
            </button>
          ))}
        </div>
      </div>

      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
        gap: 14, marginBottom: 22 }}>
        <KPI t={t} label="Avg quality score" value={`${q.rollup.avg_score ?? "—"}%`}
          tone={scoreTone(q.rollup.avg_score)} />
        <KPI t={t} label="Datasets failing" value={q.rollup.datasets_failing ?? 0}
          tone={q.rollup.datasets_failing ? V.fail : V.pass} />
        <KPI t={t} label="Gates: pass / warn / fail"
          value={`${gates.counts.pass || 0} / ${gates.counts.warn || 0} / ${gates.counts.fail || 0}`} />
        {audience === "support" && runs && (
          <KPI t={t} label="Failed runs (7d)"
            value={runs.by_day.reduce((s, d) => s + (d.failed || 0), 0)}
            tone={V.fail} />
        )}
        {audience === "business" && fresh && (
          <KPI t={t} label="Stale datasets"
            value={fresh.freshness.filter((f) => f.status !== "fresh").length}
            tone={V.warn} />
        )}
      </div>

      {/* DQ by dimension */}
      <Panel t={t} title="Quality by dimension">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
          {q.by_dimension.map((d) => (
            <div key={d.dimension} style={{ padding: 12, background: t.panel2,
              border: `1px solid ${t.border}`, borderRadius: 10 }}>
              <div style={{ fontSize: 12, color: t.sub, textTransform: "capitalize" }}>{d.dimension}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: scoreTone(d.pass_pct) }}>{d.pass_pct}%</div>
              <Bar pct={d.pass_pct} color={scoreTone(d.pass_pct)} t={t} />
              <div style={{ fontSize: 11, color: t.sub, marginTop: 4 }}>{d.total} tests</div>
            </div>
          ))}
        </div>
      </Panel>

      {/* Support: run trend + failures. Business: freshness. */}
      {audience === "support" && runs && (
        <Panel t={t} title="Run success (last 7 days)">
          <RunTrend data={runs.by_day} t={t} />
          {runs.recent_failures.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: t.sub, marginBottom: 6 }}>RECENT FAILURES</div>
              {runs.recent_failures.map((f, i) => (
                <Row key={i} t={t}>
                  <span style={{ color: V.fail, fontWeight: 600 }}>✕</span>
                  <span style={{ flex: 1 }}>{f.dag_id} · {f.task_id}</span>
                  <span style={{ color: t.sub, fontSize: 12 }}>{f.start_ts}</span>
                </Row>
              ))}
            </div>
          )}
        </Panel>
      )}

      {(audience === "business" || audience === "support") && fresh && (
        <Panel t={t} title="Freshness">
          {fresh.freshness.map((f) => (
            <Row key={f.dataset_key} t={t}>
              <Dot color={V[f.status] || t.sub} />
              <span style={{ flex: 1 }}>{f.object_name}
                <span style={{ color: t.sub, fontSize: 11 }}> · {f.layer !== "none" ? f.layer : f.platform_id}</span>
              </span>
              <span style={{ fontSize: 12, color: t.sub }}>
                {f.row_count != null ? `${Number(f.row_count).toLocaleString()} rows · ` : ""}
                {f.lag_minutes != null ? `${Math.round(f.lag_minutes)}m old` : "—"}
              </span>
            </Row>
          ))}
        </Panel>
      )}

      {/* Gate view (both audiences) */}
      <Panel t={t} title={audience === "support" ? "Runtime gates (observe-only)" : "Data approval status"}>
        {gates.gates.map((g) => (
          <Row key={g.scope_key} t={t}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#fff",
              background: V[g.verdict], padding: "2px 8px", borderRadius: 5, minWidth: 44,
              textAlign: "center" }}>{g.verdict.toUpperCase()}</span>
            <span style={{ flex: 1 }}>{g.object_name || g.scope_key}
              <span style={{ color: t.sub, fontSize: 11 }}> · {g.layer !== "none" ? g.layer : g.platform_id}</span>
            </span>
            <span style={{ fontSize: 12, color: t.sub }}>
              {g.rules_passed}/{g.rules_total} checks passed
              {g.blocking === "Y" && <span style={{ color: V.fail }}> · would block</span>}
            </span>
          </Row>
        ))}
        {audience === "support" && (
          <div style={{ fontSize: 11, color: t.sub, marginTop: 10, fontStyle: "italic" }}>
            Observe-only: verdicts are recorded and surfaced but do not halt pipelines.
          </div>
        )}
      </Panel>

      {/* Dataset scorecards */}
      <Panel t={t} title="Dataset quality scorecards">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 12 }}>
          {q.datasets.map((d) => (
            <div key={d.dataset_key} style={{ padding: 14, background: t.panel2,
              border: `1px solid ${t.border}`, borderRadius: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontWeight: 650, fontSize: 13 }}>{d.object_name}</span>
                <span style={{ fontSize: 20, fontWeight: 700, color: scoreTone(d.score_pct) }}>{d.score_pct}%</span>
              </div>
              <div style={{ fontSize: 11, color: t.sub, marginBottom: 8 }}>
                {d.layer !== "none" ? d.layer : d.platform_id}
              </div>
              <Bar pct={d.score_pct} color={scoreTone(d.score_pct)} t={t} />
              <div style={{ display: "flex", gap: 10, marginTop: 8, fontSize: 11 }}>
                <span style={{ color: V.pass }}>✓ {d.tests_passed}</span>
                {d.tests_warn > 0 && <span style={{ color: V.warn }}>⚠ {d.tests_warn}</span>}
                {d.tests_failed > 0 && <span style={{ color: V.fail }}>✕ {d.tests_failed}</span>}
                <span style={{ color: t.sub }}>of {d.tests_total}</span>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

// ---------- small pieces -------------------------------------------------
async function fetchJSON(path) {
  const res = await fetch(`${api.base}${path}`);
  if (!res.ok) throw new Error(path);
  return res.json();
}
function scoreTone(p) {
  if (p == null) return "#64748b";
  if (p >= 95) return V.pass;
  if (p >= 80) return V.warn;
  return V.fail;
}
function KPI({ t, label, value, tone }) {
  return (
    <div style={{ padding: 16, background: t.panel, border: `1px solid ${t.border}`, borderRadius: 12 }}>
      <div style={{ fontSize: 12, color: t.sub }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 730, color: tone || t.text, marginTop: 4 }}>{value}</div>
    </div>
  );
}
function Panel({ t, title, children }) {
  return (
    <div style={{ background: t.panel, border: `1px solid ${t.border}`, borderRadius: 12,
      padding: 18, marginBottom: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: t.text, marginBottom: 14 }}>{title}</div>
      {children}
    </div>
  );
}
function Row({ t, children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0",
      borderBottom: `1px solid ${t.border}`, fontSize: 13 }}>{children}</div>
  );
}
function Bar({ pct, color, t }) {
  return (
    <div style={{ height: 6, background: t.border, borderRadius: 4, overflow: "hidden", marginTop: 6 }}>
      <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: "100%", background: color }} />
    </div>
  );
}
function Dot({ color }) {
  return <span style={{ width: 9, height: 9, borderRadius: "50%", background: color, flexShrink: 0 }} />;
}
function RunTrend({ data, t }) {
  const max = Math.max(...data.map((d) => d.total), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height: 120 }}>
      {data.map((d) => (
        <div key={d.day} style={{ flex: 1, display: "flex", flexDirection: "column",
          alignItems: "center", gap: 4 }}>
          <div style={{ width: "100%", display: "flex", flexDirection: "column-reverse",
            height: 90, justifyContent: "flex-start" }}>
            <div style={{ height: `${(d.succeeded / max) * 90}px`, background: V.pass, borderRadius: "3px 3px 0 0" }} />
            {d.failed > 0 && <div style={{ height: `${(d.failed / max) * 90}px`, background: V.fail }} />}
          </div>
          <span style={{ fontSize: 10, color: t.sub }}>{d.day}</span>
        </div>
      ))}
    </div>
  );
}
