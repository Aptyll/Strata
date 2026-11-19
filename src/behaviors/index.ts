import type { Behavior } from "../core/contracts";

// Every `*.behavior.ts` file in this folder is registered automatically, so
// adding a behavior never requires touching a shared file.
const modules = import.meta.glob<{ default: Behavior }>("./*.behavior.ts", { eager: true });

export const behaviors: readonly Behavior[] = Object.keys(modules)
  .sort()
  .map((path) => modules[path].default);

const byId = new Map(behaviors.map((b) => [b.id, b]));
if (byId.size !== behaviors.length) throw new Error("Duplicate behavior ids");
// The label is the name people see, and the Esc menu groups a behavior's sliders under it, so two
// behaviors with one label show up as one. Not fatal (the world still runs), so warn instead of throwing.
const seenLabels = new Map<string, string>();
for (const b of behaviors) {
  const label = (b.label ?? b.id).toLowerCase();
  const other = seenLabels.get(label);
  if (other) console.warn(`Behaviors "${other}" and "${b.id}" share the label "${b.label ?? b.id}". Give each its own name.`);
  else seenLabels.set(label, b.id);
}

export function getBehavior(id: string): Behavior {
  const b = byId.get(id);
  if (!b) throw new Error(`Unknown behavior "${id}". Known: ${[...byId.keys()].join(", ")}`);
  return b;
}
