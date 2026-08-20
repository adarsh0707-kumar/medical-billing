import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from "@tailwindcss/vite"
import path from "path"

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    babel({ presets: [reactCompilerPreset()] }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    // The SPA calls /api on its own origin, so the dev server has to forward it
    // the same way nginx does on port 80. Both entry points are then
    // same-origin and CORS never enters the picture.
    proxy: {
      "/api": {
        target: process.env.VITE_PROXY_TARGET || "http://localhost:5000",
        changeOrigin: true,
        // Forward the caller's address; without it the API rate-limits every
        // dev request as if it came from this container.
        xfwd: true,
      },
    },
  },
});
