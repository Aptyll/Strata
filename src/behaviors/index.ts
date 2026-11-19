import type { Behavior } from "../core/contracts";

// Every `*.behavior.ts` file in this folder is registered automatically, so
// adding a behavior never requires touching a shared file.
const modules = import.meta.glob<{ default: Behavior }>("./*.behavior.ts", { eager: true });

export const behaviors: readonly Behavior[] = Object.keys(modules)
  .sort()
  .map((path) => modules[path].default);

const byId = new Map(behaviors.map((b) => [b.id, b]));
if (byId.size !== behaviors.length) throw new Error("Duplicate behavior ids");

export function getBehavior(id: string): Behavior {
  const b = byId.get(id);
  if (!b) throw new Error(`Unknown behavior "${id}". Known: ${[...byId.keys()].join(", ")}`);
  return b;
}
