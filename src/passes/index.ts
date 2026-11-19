import type { GpuContext, Pass } from "../core/contracts";

// Every `*.pass.ts` file in this folder is registered automatically. Each one
// default-exports a factory `(gpu) => Pass`. The pass' `stage` decides when it runs.
const modules = import.meta.glob<{ default: (gpu: GpuContext) => Pass }>("./*.pass.ts", { eager: true });

export function createPasses(gpu: GpuContext): Pass[] {
  return Object.keys(modules)
    .sort()
    .map((path) => modules[path].default(gpu));
}
