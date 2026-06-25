import { defineConfig } from "vite";

// @ts-expect-error process es un global de Node
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // Debe igualar al dev server (moderno, sin transpilar). Bajar el target a un
    // Safari viejo transpila xterm v6 y rompe el repaint de las TUI alt-screen
    // (vim/lazyworktree quedan congelados tras el primer frame) solo en el .app
    // empaquetado; en dev nunca se nota porque sirve el código sin downlevel.
    target: "esnext",
    // Keep stack traces in the crash log mapped to source instead of minified.
    sourcemap: true,
    rolldownOptions: {
      input: {
        main: "index.html",
        settings: "settings.html",
        hud: "hud.html",
      },
      output: {
        codeSplitting: {
          groups: [
            { name: "codemirror-vim", test: /@replit\/codemirror-vim/ },
            { name: "codemirror", test: /@codemirror\// },
          ],
        },
      },
    },
  },
});
