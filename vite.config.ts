import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.indexOf("@mlightcad/libredwg-web") >= 0) {
            return "cad-runtime";
          }

          if (id.indexOf("jspdf") >= 0) {
            return "pdf-runtime";
          }

          if (id.indexOf("react") >= 0 || id.indexOf("react-dom") >= 0 || id.indexOf("zustand") >= 0) {
            return "app-vendor";
          }
        }
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 4173
  },
  test: {
    environment: "jsdom",
    fileParallelism: false,
    maxWorkers: 1
  }
});
