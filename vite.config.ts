import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": process.env.ROAST_API_PROXY || "http://localhost:8787",
    },
  },
});
