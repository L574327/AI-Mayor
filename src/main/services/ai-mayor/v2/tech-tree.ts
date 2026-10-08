/**
 * THE DEVELOPMENT TREE (the game's own way to unlock a service's buildings — not a milestone reward).
 *
 * Read from the game's code (Game.City.DevTreeSystem, 2026-10-05): the city holds development points, granted per milestone; a node costs points; a
 * node can be bought when it is still locked, its service is unlocked and — if it lists previous nodes — AT LEAST ONE of them is unlocked; buying it
 * unlocks the buildings that list the node among their unlock requirements. The Mayor used to wait for a milestone to unlock the passenger railway; on
 * this save the stations and tracks stood locked at milestone 8 because their nodes had never been bought.
 *
 * This module decides WHICH node to buy for a goal (the nodes the railway prefabs require, and the chain of previous nodes under them) and never spends
 * a point on anything else. The world gives every fact (points, nodes, reasons); nothing is assumed from a node's name except as a last resort.
 */

export interface TechNode {
  name: string;
  service: string | null;
  serviceLocked: boolean;
  cost: number;
  locked: boolean;
  requirements: Array<{ name: string | null; locked: boolean }>;
  purchasable: boolean;
  refusals: string[];
}

export interface TechTree { points: number; nodes: TechNode[] }

export interface PrefabLock {
  prefab: string;
  locked: boolean;
  /** The lot (grid cells) and bounding size of the prefab, before anything is placed (`big-building-site.ts`). */
  lotSize?: { x: number; z: number } | null;
  size?: { x: number; y?: number; z: number } | null;
  requirements: Array<{ name: string | null; kind: string; locked: boolean; cost: number | null; flags: string }>;
}

export interface TechPlan {
  /** The nodes to buy, previous nodes first. */
  steps: TechNode[];
  totalCost: number;
  reachable: boolean;
  reason: string;
}

/** Last resort when the prefabs report no node requirement of their own: nodes whose name or service names the railway. */
export const RAIL_NODE_PATTERN = /train|rail|station.*train|cargo.*train/i;

/** The locked development-tree nodes the given prefabs require (the railway's station, depot and track), without repeats. */
export function requiredNodeNames(locks: readonly PrefabLock[]): string[] {
  const names: string[] = [];
  for (const lock of locks) {
    if (!lock.locked) continue;
    for (const requirement of lock.requirements) {
      if (requirement.kind === "devTreeNode" && requirement.locked && requirement.name && !names.includes(requirement.name)) names.push(requirement.name);
    }
  }
  return names;
}

/**
 * The cheapest way to unlock `targets`: for each locked target its previous nodes are followed (one unlocked previous node is enough; when none is,
 * the cheapest chain down to one that is), so the steps come out previous-first. A target that cannot be reached (a cycle, a node the tree does not list)
 * makes the plan unreachable and says why.
 */
export function planPath(tree: TechTree, targets: readonly string[]): TechPlan {
  const byName = new Map(tree.nodes.map((node) => [node.name, node]));
  const memo = new Map<string, TechNode[] | null>();
  const chainFor = (name: string, trail: ReadonlySet<string>): TechNode[] | null => {
    const node = byName.get(name);
    if (!node) return null;
    if (!node.locked) return [];
    if (memo.has(name)) return memo.get(name)!;
    if (trail.has(name)) return null;
    const next = new Set(trail).add(name);
    const required = node.requirements.filter((requirement): requirement is { name: string; locked: boolean } => requirement.name !== null);
    let best: TechNode[] | null = null;
    if (required.length === 0 || required.some((requirement) => !requirement.locked)) best = [node];
    else {
      for (const requirement of required) {
        const below = chainFor(requirement.name, next);
        if (below === null) continue;
        const candidate = [...below, node];
        if (best === null || cost(candidate) < cost(best)) best = candidate;
      }
    }
    memo.set(name, best);
    return best;
  };
  const cost = (steps: readonly TechNode[]) => steps.reduce((sum, node) => sum + node.cost, 0);
  const steps: TechNode[] = [];
  for (const target of targets) {
    const chain = chainFor(target, new Set());
    if (chain === null) return { steps, totalCost: cost(steps), reachable: false, reason: `the node ${target} cannot be reached through the tree the world listed` };
    for (const node of chain) if (!steps.some((step) => step.name === node.name)) steps.push(node);
  }
  return { steps, totalCost: cost(steps), reachable: true, reason: steps.length === 0 ? "every node the railway needs is already unlocked" : `${steps.length} node(s) to buy, ${cost(steps)} points` };
}

/** The first step the game would let us buy now (previous-first order, enough points), or null. */
export function nextPurchase(plan: TechPlan, points: number): TechNode | null {
  for (const step of plan.steps) if (step.locked && step.purchasable && step.cost <= points) return step;
  return null;
}

/** Targets when the prefabs name no node: the locked nodes that look like the railway (service or name). */
export function railNodeFallback(tree: TechTree): string[] {
  return tree.nodes.filter((node) => node.locked && (RAIL_NODE_PATTERN.test(node.name) || (node.service !== null && RAIL_NODE_PATTERN.test(node.service)))).map((node) => node.name);
}

export interface TechTreePort {
  read(signal?: AbortSignal): Promise<TechTree | null>;
  /** The unlock requirements the game keeps for these prefabs (null: the Bridge cannot read them). */
  prefabLocks(prefabs: ReadonlyArray<{ prefab: string; category: "building" | "net" }>, signal?: AbortSignal): Promise<PrefabLock[] | null>;
  purchase(node: string, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }>;
}

export type TechOutcome =
  | { status: "BOUGHT"; node: string; cost: number; pointsLeft: number }
  | { status: "WAITING_POINTS" | "NOTHING_TO_BUY" | "UNREADABLE" | "UNREACHABLE" | "REFUSED" };

/** The railway's prefabs, whose locks name the nodes to buy. */
export const RAIL_PREFABS: ReadonlyArray<{ prefab: string; category: "building" | "net" }> = [
  { prefab: "TrainStation01", category: "building" }, { prefab: "TrainStation02", category: "building" }, { prefab: "TrainStation03", category: "building" },
  { prefab: "Double Train Track", category: "net" }, { prefab: "Twoway Train Track", category: "net" },
];

/** One look at the tree and, if the game allows, one purchase toward the railway. Facts come from the world; the notes say what it answered. */
export async function unlockRailway(port: TechTreePort, notes: string[], signal?: AbortSignal): Promise<TechOutcome> {
  return unlockPrefabs(port, RAIL_PREFABS, "the railway", notes, railNodeFallback, signal);
}

/**
 * One look at the tree and, if the game allows, one purchase toward the development nodes these prefabs require (the railway, a road maintenance
 * depot, ...). Only a node a prefab names (or, as a last resort, `fallback` picks) is ever bought.
 */
export async function unlockPrefabs(port: TechTreePort, prefabs: ReadonlyArray<{ prefab: string; category: "building" | "net" }>, label: string, notes: string[],
  fallback?: (tree: TechTree) => string[], signal?: AbortSignal): Promise<TechOutcome> {
  const tree = await port.read(signal);
  if (!tree) { notes.push("tech: the development tree cannot be read (the Bridge needs the /city/devtree read; restart the game after the Bridge build)"); return { status: "UNREADABLE" }; }
  const locks = await port.prefabLocks(prefabs, signal);
  let targets = locks ? requiredNodeNames(locks) : [];
  let source = `the prefabs' own unlock requirements (${label})`;
  if (targets.length === 0) {
    const open = locks?.filter((lock) => lock.locked).length ?? 0;
    if (locks && open === 0) { notes.push(`tech: ${label}: the prefabs are not locked`); return { status: "NOTHING_TO_BUY" }; }
    targets = fallback ? fallback(tree) : [];
    source = `nodes named like ${label} (the prefabs list no node requirement of their own)`;
  }
  const plan = planPath(tree, targets);
  if (!plan.reachable) { notes.push(`tech: ${label}: ${plan.reason}`); return { status: "UNREACHABLE" }; }
  if (plan.steps.length === 0) { notes.push(`tech: ${plan.reason} (from ${source})`); return { status: "NOTHING_TO_BUY" }; }
  const step = nextPurchase(plan, tree.points);
  if (!step) {
    const first = plan.steps.find((candidate) => candidate.locked)!;
    notes.push(`tech: ${label} needs ${plan.steps.map((node) => `${node.name} (${node.cost})`).join(" -> ")} = ${plan.totalCost} points; ${tree.points} available` +
      `${first.refusals.length > 0 ? `; ${first.name}: ${first.refusals.join(", ")}` : ""}; waiting for the next milestone's points`);
    return { status: "WAITING_POINTS" };
  }
  const result = await port.purchase(step.name, signal);
  if (!result.ok) { notes.push(`tech: the game refused ${step.name}: ${result.detail.slice(0, 140)}`); return { status: "REFUSED" }; }
  notes.push(`tech: bought ${step.name} (cost ${step.cost}, ${tree.points - step.cost} points left) on the way to ${label} (${plan.reason})`);
  return { status: "BOUGHT", node: step.name, cost: step.cost, pointsLeft: tree.points - step.cost };
}
