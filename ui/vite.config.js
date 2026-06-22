import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { host: "0.0.0.0", port: 8080 },
  build: { outDir: "dist", sourcemap: false },
  define: {
    // API base injected at build or runtime; defaults to same-origin /api
    "import.meta.env.VITE_API_BASE": JSON.stringify(process.env.VITE_API_BASE || "/api"),
  },
});
