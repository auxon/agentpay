import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/agentpay/",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5177,
    proxy: { "/api": "http://localhost:8788" },
  },
});
