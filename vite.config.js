import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 8791 },
  build: { target: "es2022" },
});
