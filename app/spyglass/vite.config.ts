import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so `dist/` opens straight from disk as well as from a
  // server — handy for demoing without running anything.
  base: "./",
  build: { outDir: "dist" },
});
