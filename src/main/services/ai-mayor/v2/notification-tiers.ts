/**
 * Notifications in three tiers (P7 of the FAST_EXPANSION V2 candidate), instead of a construction job per icon.
 *
 *   IMMEDIATE     fix this cycle: no power / a power bottleneck, no water or sewage backing up, no road access, garbage piling,
 *                 a citizen waiting for an ambulance or hearse, polluted water, fire, collapse, abandonment
 *   DEFERRED      batched on a period, never one icon at a time: missing skilled workers, rent too high, a facility at capacity, pollution
 *   NO_REACTION   not answered mechanically — find the root first (supply chain, purchasing, one broken route): not enough customers,
 *                 high resource costs, a level-up, a single pathfinding failure
 *   READ_FIRST    congestion: the icon needs ten cars blocking each other and is checked once per 64 ticks, so it is not the measure;
 *                 only a traffic-flow reading is (the Bridge has none yet — a capability gap, reported, not guessed)
 *
 * The type names are the game's own icon prefab names (as read from the world). A name this table does not know is UNCLASSIFIED: counted and
 * shown, never acted on.
 */
export type NotificationTier = "IMMEDIATE" | "DEFERRED" | "NO_REACTION" | "READ_FIRST" | "UNCLASSIFIED";

const IMMEDIATE = [
  /^Electricity Notification/i, /Electricity.*(Bottleneck|Shortage)/i, /^Powerline Not Connected/i, /^Transformer/i,
  /^Water Notification/i, /^Sewage Notification/i, /Water Destroyed/i, /Sewage.*(Overflow|Backed)/i, /Water.*Pollut/i, /Polluted Water/i,
  /^No Road Access/i, /Road Access/i, /^Garbage Notification/i, /Garbage.*Pil/i,
  /Ambulance/i, /Hearse/i, /Sick/i, /Dead|Death/i,
  /Burned Down/i, /On Fire/i, /Fire (Hazard|Notification)/i, /Collapsed/i, /Destroyed/i, /Abandoned/i, /Condemned/i,
];
const DEFERRED = [
  /MissingEducatedWorkers/i, /Missing(Un)?educatedWorkers/i, /Missing.*Workers/i, /High Rent/i, /Rent/i, /(At|Over) Capacity|Capacity Full|Full Capacity/i,
  /Noise Pollution/i, /Air Pollution/i, /Ground Pollution/i, /Pollution/i,
];
const NO_REACTION = [/No Customers|Not Enough Customers/i, /High Resource Costs?/i, /Leveling Building|Leveled Up|Level Up/i, /Path ?find|No Path|Cannot Reach/i];
const READ_FIRST = [/Traffic Bottleneck/i, /Traffic Jam/i, /Congestion/i];

export function notificationTier(type: string): NotificationTier {
  // Order matters: "Water Destroyed" is a loss (IMMEDIATE) although "Destroyed" alone is checked after the level-up names.
  if (NO_REACTION.some((pattern) => pattern.test(type))) return "NO_REACTION";
  if (READ_FIRST.some((pattern) => pattern.test(type))) return "READ_FIRST";
  if (IMMEDIATE.some((pattern) => pattern.test(type))) return "IMMEDIATE";
  if (DEFERRED.some((pattern) => pattern.test(type))) return "DEFERRED";
  return "UNCLASSIFIED";
}

export interface TriageReading { counts: Record<string, number> }

export interface Triage {
  byTier: Record<NotificationTier, Array<{ type: string; count: number }>>;
  totals: Record<NotificationTier, number>;
}

export function triageNotifications(reading: TriageReading): Triage {
  const byTier: Triage["byTier"] = { IMMEDIATE: [], DEFERRED: [], NO_REACTION: [], READ_FIRST: [], UNCLASSIFIED: [] };
  const totals: Triage["totals"] = { IMMEDIATE: 0, DEFERRED: 0, NO_REACTION: 0, READ_FIRST: 0, UNCLASSIFIED: 0 };
  for (const [type, raw] of Object.entries(reading.counts)) {
    const count = Number(raw);
    if (!Number.isFinite(count) || count <= 0) continue;
    const tier = notificationTier(type);
    byTier[tier].push({ type, count });
    totals[tier] += count;
  }
  for (const tier of Object.keys(byTier) as NotificationTier[]) byTier[tier].sort((left, right) => right.count - left.count);
  return { byTier, totals };
}

/**
 * The immediate types this Mayor has a local answer to, and the answer. Everything else in IMMEDIATE is reported as a capability gap
 * with its count: it is not answered by a hard-coded construction job and not pretended answered.
 */
export const IMMEDIATE_RESPONSES: ReadonlyArray<{ pattern: RegExp; answer: string }> = [
  { pattern: /Hearse|Dead|Death/i, answer: "cemetery near the icons (district-services)" },
  { pattern: /Ambulance|Sick/i, answer: "clinic near the icons (district-services)" },
  { pattern: /^(Electricity|Water|Sewage) Notification|Water Destroyed/i, answer: "utility repair on a real shortage (runtime) / recovery repairs" },
  { pattern: /No Road Access/i, answer: "a road from where the game puts the notice (in front of the lot) to the nearest street (district-builder)" },
  { pattern: /No (Car|Pedestrian) Access|Road Access/i, answer: "the same access road, or a footpath for pedestrians (district-builder)" },
  { pattern: /Not Connected/i, answer: "a buried cable or pipe from the building to the nearest street (district-builder #reconnectUtilities)" },
  { pattern: /Garbage/i, answer: "a landfill beside a street, away from homes; essential when icons pile up (district-builder)" },
  { pattern: /Abandoned|Collapsed|Burned Down|Destroyed|Condemned/i, answer: "ruins taken down so the lot grows again (district-builder #clearRuins)" },
  { pattern: /On Fire|Fire (Hazard|Notification)/i, answer: "a fire station where buildings burn (district-services)" },
];

export function immediateWithoutAnswer(triage: Triage): Array<{ type: string; count: number }> {
  return triage.byTier.IMMEDIATE.filter((entry) => !IMMEDIATE_RESPONSES.some((response) => response.pattern.test(entry.type)));
}

/** A period (in cycles) for the deferred batch: the deferred tier is looked at on this rhythm, not on every cycle. */
export const DEFERRED_REVIEW_EVERY_CYCLES = 5;
/** The same period in game hours (`game-clock.ts`); the cycle count above is the fallback when the game clock cannot be read. */
export const DEFERRED_REVIEW_EVERY_HOURS = 5;
