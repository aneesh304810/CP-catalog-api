// Lightweight API client for the catalog backend.
// Falls back to embedded mock data when the API is unreachable, so the UI
// renders in demo mode (e.g. before ingestion has populated the catalog).

const BASE = import.meta.env.VITE_API_BASE || "/api";

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

export const api = {
  base: BASE,
  health: () => get("/health"),
  search: (q, opts = {}) => {
    const p = new URLSearchParams({ q: q || "" });
    if (opts.platform) p.set("platform", opts.platform);
    if (opts.layer) p.set("layer", opts.layer);
    if (opts.type) p.set("type", opts.type);
    return get(`/search?${p.toString()}`);
  },
  searchColumns: (q, opts = {}) => {
    const p = new URLSearchParams({ q: q || "" });
    if (opts.sensitivity) p.set("sensitivity", opts.sensitivity);
    if (opts.platform) p.set("platform", opts.platform);
    return get(`/search/columns?${p.toString()}`);
  },
  asset: (key) => get(`/assets/${encodeURIComponent(key)}`),
  tableLineage: (root, plane = "data", depth = 3) =>
    get(`/lineage/table?root=${encodeURIComponent(root)}&plane=${plane}&depth=${depth}`),
  columnLineage: (root) => get(`/lineage/column?root=${encodeURIComponent(root)}`),
  impact: (col) => get(`/impact/column?col=${encodeURIComponent(col)}`),
  pipelines: () => get("/pipelines"),
  pipeline: (id) => get(`/pipelines/${encodeURIComponent(id)}`),
};

export async function probeApi() {
  try {
    await api.health();
    return true;
  } catch {
    return false;
  }
}
