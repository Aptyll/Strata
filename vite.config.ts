import { resolve } from "node:path";
import { defineConfig } from "vite";

// Pages that ship in the production build next to the app. Everything else
// under src/**/demo stays dev-only (npm run dev serves every page).
const pages = {
  main: "index.html",
  challenge: "src/challenge/index.html",
  offline: "src/offline/web/index.html",
  proof: "src/proof/web/index.html",
  bench: "src/perf/bench/index.html",
  verify: "src/verify/index.html",
  colorLife: "src/color-life/demo/index.html",
  design: "src/ux/design/demo/index.html",
};

export default defineConfig({
  build: {
    rollupOptions: {
      input: Object.fromEntries(Object.entries(pages).map(([name, path]) => [name, resolve(__dirname, path)])),
    },
  },
});
