import type { LocalMayorGrowthDomain } from "./local-mayor/types";
import type { SpatialPoint2, SpatialSiteDetail, SpatialTile, SpatialZoningCell } from "./spatial/types";
import { pointInTile } from "./spatial/world-scanner";
import type {
  MayorAction,
  MayorPlanningCandidate,
  MayorUrbanDesignCandidateMetadata,
  UrbanDesignDevelopmentPolicy,
} from "./types";

const MAX_PATCHES = 3;
export const MAX_ROAD_EXPANSION_CANDIDATES = 3;
const CANDIDATE_RADII = [32, 24, 16] as const;
const MIN_CELLS = 8;

type JsonObject = Record<string, unknown>;

export interface PrivateMayorCandidate {
  summary: MayorPlanningCandidate;
  action: MayorAction;
  center: SpatialPoint2;
  radius: number;
  /** Exact planner-selected cells used by the canonical zoning executor revalidation. */
  zoningCells?: Array<{ block: { index: number; version: number }; index: number }>;
  /** The authoritative road identity used when the frontage patch was generated. */
  frontageRoad?: { entity: { index: number; version: number }; prefab: string };
  snapshotRevision?: string | null;
}

export interface MayorCandidateSet {
  status: "available" | "unavailable";
  candidates: MayorPlanningCandidate[];
  note: string;
  registry: Map<string, PrivateMayorCandidate>;
  ownedTiles: SpatialTile[];
}

export interface UrbanDesignCandidateMetadataInput {
  metadata: Omit<MayorUrbanDesignCandidateMetadata, "designRole">;
}

export interface RoadExpansionSource {
  entity: { index: number; version: number };
  endpoint?: SpatialPoint2;
}

export interface RoadExpansionPreferences {
  seed: string;
  preferredHeadingDegrees: number;
  headingOffsetsDegrees: readonly number[];
  headingToleranceDegrees: number;
  targetLengths: readonly number[];
  topologyPreference: "grid_axis" | "cross_link" | "contour_connector" | "organic_branch";
  hierarchyPreference: "local_first" | "balanced" | "collector_spine" | "fine_grain";
}

export type RoadExpansionRejectionReason =
  | "invalid_source_geometry"
  | "outside_owned_land"
  | "water"
  | "slope"
  | "building_collision"
  | "duplicate_road";

export interface RoadExpansionAttemptDiagnostic {
  sourceRoad: { index: number; version: number };
  start: SpatialPoint2;
  end: SpatialPoint2;
  headingDegrees: number | null;
  headingOffsetDegrees: number;
  targetLength: number;
  outcome: "accepted" | "rejected";
  rejectionReason?: RoadExpansionRejectionReason;
}

export interface UrbanDesignCandidatePolicy {
  developmentPolicy: UrbanDesignDevelopmentPolicy;
  includeExistingFrontage: boolean;
  growthDomain?: LocalMayorGrowthDomain;
  roadExpansion?: RoadExpansionPreferences;
}

const record = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function squaredDistance(left: SpatialPoint2, right: SpatialPoint2): number {
  const dx = left.x - right.x;
  const dz = left.z - right.z;
  return dx * dx + dz * dz;
}

function headingDegrees(start: SpatialPoint2, end: SpatialPoint2): number {
  return (Math.atan2(end.z - start.z, end.x - start.x) * 180) / Math.PI;
}

function normalizeDegrees(value: number): number {
  const normalized = ((((value + 180) % 360) + 360) % 360) - 180;
  return Math.round(normalized * 1_000) / 1_000;
}

function angularDistance(left: number, right: number): number {
  return Math.abs(normalizeDegrees(left - right));
}

function closestEquivalentHeading(preferred: number, source: number): number {
  const alternatives = [preferred, preferred + 180, preferred - 180];
  return alternatives.sort((left, right) => angularDistance(left, source) - angularDistance(right, source))[0];
}

function pointAtHeading(start: SpatialPoint2, heading: number, length: number): SpatialPoint2 {
  const radians = (heading * Math.PI) / 180;
  return { x: start.x + Math.cos(radians) * length, z: start.z + Math.sin(radians) * length };
}

function deterministicUnit(seed: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 4_294_967_295;
}

function pointToSegmentDistance(point: SpatialPoint2, start: SpatialPoint2, end: SpatialPoint2): number {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 0.0001) return Math.sqrt(squaredDistance(point, start));
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared));
  return Math.hypot(point.x - (start.x + ratio * dx), point.z - (start.z + ratio * dz));
}

function isOwned(point: SpatialPoint2, ownedTiles: SpatialTile[]): boolean {
  return ownedTiles.some((tile) => pointInTile(point, tile));
}

function terrainSample(point: SpatialPoint2, terrain: SpatialSiteDetail["terrain"]) {
  const columns = terrain.resolution;
  const column = Math.max(0, Math.min(columns - 1, Math.round((point.x - terrain.bounds.minX) / terrain.cellSize.x)));
  const row = Math.max(0, Math.min(columns - 1, Math.round((point.z - terrain.bounds.minZ) / terrain.cellSize.z)));
  const index = row * columns + column;
  return { waterDepth: terrain.waterDepths[index] ?? 0, height: terrain.heights[index] ?? 0 };
}

function isSafeUnzonedCell(cell: SpatialZoningCell, ownedTiles: SpatialTile[]): boolean {
  return (
    cell.visible === true &&
    cell.occupied === false &&
    cell.blocked === false &&
    cell.overridden === false &&
    cell.zoneType === 0 &&
    isOwned(cell.position, ownedTiles)
  );
}

/** One frontage contract shared by candidate generation and execution revalidation. */
export function isCanonicalZoningFrontageCell(cell: SpatialZoningCell): boolean {
  return cell.roadside === true;
}

export function parseSpatialSiteDetail(value: unknown): SpatialSiteDetail {
  const detail = record(value) as Partial<SpatialSiteDetail>;
  if (!detail.center || !detail.terrain || !detail.roadGraph) throw new Error("spatial site detail is incomplete");
  if (
    !Array.isArray(detail.roadGraph.edges) ||
    !Array.isArray(detail.buildings) ||
    !Array.isArray(detail.zoningCells)
  ) {
    throw new Error("spatial site detail lacks roads, buildings, or zoning cells");
  }
  return detail as SpatialSiteDetail;
}

export function candidateQuery(snapshot: unknown): { x: number; z: number; radius: number } {
  const anchors = Array.isArray(record(record(snapshot).planningCatalog).roadAnchors)
    ? (record(record(snapshot).planningCatalog).roadAnchors as unknown[]).map(record)
    : [];
  const points = anchors.flatMap((anchor) => {
    const start = record(anchor.start);
    const end = record(anchor.end);
    const values = [
      { x: finite(start.x), z: finite(start.z) },
      { x: finite(end.x), z: finite(end.z) },
    ];
    return values.filter((point): point is SpatialPoint2 => point.x !== null && point.z !== null);
  });
  if (points.length === 0) throw new Error("planning catalog has no finite road anchors for candidate discovery");
  const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const z = points.reduce((sum, point) => sum + point.z, 0) / points.length;
  const farthest = Math.max(...points.map((point) => Math.hypot(point.x - x, point.z - z)));
  return { x, z, radius: Math.max(128, Math.min(2_048, Math.ceil(farthest + 160))) };
}

interface Patch {
  anchor: {
    entity: { index: number; version: number };
    prefab: string;
    start: SpatialPoint2;
    end: SpatialPoint2;
  };
  seed: SpatialZoningCell;
  radius: number;
  cells: SpatialZoningCell[];
}

export type ZoningCandidateValidation =
  | { ok: true; cells: SpatialZoningCell[] }
  | {
      ok: false;
      code: "residual_zoning_payload_incomplete" | "residual_zoning_revalidation_failure";
      reason: "missing_exact_cells" | "cell_missing" | "occupied_cell" | "ownership_changed" | "not_frontage";
    };

function roadAnchors(snapshot: unknown): Patch["anchor"][] {
  const catalog = record(record(snapshot).planningCatalog);
  return (Array.isArray(catalog.roadAnchors) ? catalog.roadAnchors : [])
    .map(record)
    .map((anchor) => {
      const entity = record(anchor.entity);
      const start = record(anchor.start);
      const end = record(anchor.end);
      return {
        entity: { index: finite(entity.index), version: finite(entity.version) },
        prefab: typeof anchor.prefab === "string" ? anchor.prefab : null,
        start: { x: finite(start.x), z: finite(start.z) },
        end: { x: finite(end.x), z: finite(end.z) },
      };
    })
    .filter(
      (anchor): anchor is Patch["anchor"] =>
        anchor.entity.index !== null &&
        anchor.entity.version !== null &&
        anchor.prefab !== null &&
        anchor.start.x !== null &&
        anchor.start.z !== null &&
        anchor.end.x !== null &&
        anchor.end.z !== null,
    );
}

function sameEntity(left: { index: number; version: number }, right: { index: number; version: number }): boolean {
  return left.index === right.index && left.version === right.version;
}

interface ZoneOption {
  prefix: string;
  zone: string;
  areaType: NonNullable<MayorPlanningCandidate["areaType"]>;
  demandCategory: MayorPlanningCandidate["relevantDemand"]["category"];
  demand: number | null;
}

export type ResidentialDensity = "low" | "medium" | "high";

/** The density a residential zone type builds, from its catalogue name. `null` = not a density this reads. */
export function residentialZoneDensity(name: string): ResidentialDensity | null {
  if (/low\s*rent/i.test(name)) return null;
  if (/high/i.test(name)) return "high";
  if (/medium|row|mixed/i.test(name)) return "medium";
  if (/low/i.test(name)) return "low";
  return null;
}

/**
 * The residential zone this city should lay, and the demand that zone actually answers.
 *
 * The game keeps a separate building demand per density, and the zone laid and the demand read must be the same density (measured
 * 2026-10-03: the product laid the first unlocked zone, low, while reading the MAX demand over densities — low 0, medium 100 — and zoned
 * land nobody would build on).
 *
 * V2 (P3 of FAST_EXPANSION_V2): the density is the DENSEST UNLOCKED one, not the one whose demand bar is tallest — picking by bar height was
 * the direct reason a 10k city was still laid in low density. The bar only EXCLUDES: a density whose demand is exactly nil is skipped. When
 * every density's demand is nil or unread the densest unlocked still answers (whether to zone at all is decided upstream). The district
 * builder judges vacancy and the low-density quota on top of this (`growth-policy.ts`); this is the choice for the callers that do not.
 */
export function residentialZoneChoice(types: readonly JsonObject[], residentialDemand: JsonObject):
  { zone: string; demand: number | null } | null {
  const growable = types.filter((zone) => zone.locked !== true && zone.areaType === "Residential" &&
    typeof zone.name === "string" && zone.name.length > 0 &&
    !(typeof zone.spawnableBuildingCount === "number" && zone.spawnableBuildingCount <= 0));
  if (growable.length === 0) return null;
  const firstName = String(growable[0]!.name);
  const demandOf = (density: ResidentialDensity) => finite(residentialDemand[density]);
  const densities = (["high", "medium", "low"] as const)
    .filter((density) => growable.some((zone) => residentialZoneDensity(String(zone.name)) === density));
  if (densities.length === 0) return { zone: firstName, demand: null };
  const density = densities.find((candidate) => (demandOf(candidate) ?? 1) > 0) ?? densities[0]!;
  const theme = firstName.split(" ")[0]!;
  const zone = growable
    .filter((entry) => residentialZoneDensity(String(entry.name)) === density)
    .sort((left, right) =>
      Number(String(right.name).startsWith(`${theme} `)) - Number(String(left.name).startsWith(`${theme} `)) ||
      (finite(right.spawnableBuildingCount) ?? 0) - (finite(left.spawnableBuildingCount) ?? 0))[0]!;
  return { zone: String(zone.name), demand: demandOf(density) };
}

/**
 * What the zone catalogue has unlocked and can grow: the residential densities (a zone of that density exists with buildings to spawn) and
 * whether an office zone exists. This is the stage signal of the V2 policy when the game does not report the milestone, and the density
 * ladder it chooses from. `null` when the catalogue was not read.
 */
export function unlockedZoneCapabilities(snapshot: unknown): { densities: Record<ResidentialDensity, boolean>; office: boolean } | null {
  const zones = record(record(snapshot).planningCatalog).zoneTypes;
  if (!Array.isArray(zones)) return null;
  const types = zones.map(record).filter((zone) => zone.locked !== true && typeof zone.name === "string" &&
    !(typeof zone.spawnableBuildingCount === "number" && zone.spawnableBuildingCount <= 0));
  const densities = { low: false, medium: false, high: false } as Record<ResidentialDensity, boolean>;
  for (const zone of types) {
    if (zone.areaType !== "Residential") continue;
    const density = residentialZoneDensity(String(zone.name));
    if (density) densities[density] = true;
  }
  return { densities, office: types.some((zone) => zone.office === true) };
}

/** The residential demand the zone this city lays actually answers. See `residentialZoneChoice`. */
export function residentialZoneDemand(snapshot: unknown): number | null {
  const root = record(snapshot);
  const types = (Array.isArray(record(root.planningCatalog).zoneTypes) ? record(root.planningCatalog).zoneTypes as unknown[] : []).map(record);
  const residential = record(record(root.demand).residential);
  const choice = residentialZoneChoice(types, residential);
  if (choice?.demand !== null && choice?.demand !== undefined) return choice.demand;
  const values = [finite(residential.low), finite(residential.medium), finite(residential.high)]
    .filter((value): value is number => value !== null);
  return values.length > 0 ? Math.max(...values) : finite(record(root.demand).residential);
}

function zoneOptions(snapshot: unknown): ZoneOption[] {
  const root = record(snapshot);
  const catalog = record(root.planningCatalog);
  const demand = record(root.demand);
  const residential = record(demand.residential);
  const residentialDemand = [finite(residential.low), finite(residential.medium), finite(residential.high)].filter(
    (value): value is number => value !== null,
  );
  // A zone type that can grow no building is not a zone this city can use.
  const types = (Array.isArray(catalog.zoneTypes) ? catalog.zoneTypes : []).map(record)
    .filter((zone) => !(typeof zone.spawnableBuildingCount === "number" && zone.spawnableBuildingCount <= 0));
  const residentialChoice = residentialZoneChoice(types, residential);
  const first = (predicate: (zone: JsonObject) => boolean) => {
    const zone = types.find(predicate);
    return typeof zone?.name === "string" ? zone.name : null;
  };
  // A locked zone type is not a capability this bridge has: offering it would
  // authorize a category native then refuses. `locked` is read here rather than
  // at each consumer so the candidate generator and the capability reader agree
  // by construction.
  const unlocked = (predicate: (zone: JsonObject) => boolean) => (zone: JsonObject) =>
    zone.locked !== true && predicate(zone);
  const definitions = [
    {
      prefix: "R",
      zone: residentialChoice?.zone ?? null,
      areaType: "Residential" as const,
      demandCategory: "residential" as const,
      demand: residentialChoice?.demand ?? (residentialDemand.length > 0 ? Math.max(...residentialDemand) : null),
    },
    {
      prefix: "C",
      zone: first(unlocked((zone) => zone.areaType === "Commercial")),
      areaType: "Commercial" as const,
      demandCategory: "commercial" as const,
      demand: finite(demand.commercial),
    },
    {
      prefix: "I",
      zone: first(unlocked((zone) => zone.areaType === "Industrial" && zone.office !== true)),
      areaType: "Industrial" as const,
      demandCategory: "industrial" as const,
      demand: finite(demand.industrial),
    },
    {
      // Office is the office-labelled Industrial zone type, not a zone whose
      // own areaType is "Office" — the catalogue names none that way. Reading it
      // as `areaType === "Office"` is how the ZONING step came to refuse a
      // category the game had actually unlocked.
      prefix: "O",
      zone: first(unlocked((zone) => zone.areaType === "Industrial" && zone.office === true)),
      areaType: "Office" as const,
      demandCategory: "office" as const,
      demand: finite(demand.office),
    },
  ];
  return definitions.flatMap((definition): ZoneOption[] =>
    definition.zone === null ? [] : [{ ...definition, zone: definition.zone }],
  );
}

/**
 * Which growable domains this catalogue exposes an unlocked zone for.
 *
 * The SAME rule `zoneOptions` uses to build a candidate, read through the same
 * function rather than copied, so a domain can never be planned for a category
 * the candidate generator would then refuse to produce.
 *
 * This is a capability of the bridge, not a fact about the land, and no amount
 * of building changes it. Measured live (2026-10-01): the Brain admitted an
 * Office Goal every other tick, built its access road, and then refused its own
 * ZONING step by name (`GATE1_OFFICE_ZONE_PREFAB_UNAVAILABLE`) — this map
 * exposes no `office: true` zone at all. Half the run's ticks built nothing
 * usable. The catalogue is re-read every cycle, so a caller that filters on this
 * releases the domain by itself the moment the category unlocks: there is no
 * park to expire and nothing to remember.
 */
export function availableZoneDomains(snapshot: unknown): LocalMayorGrowthDomain[] | null {
  if (!Array.isArray(record(record(snapshot).planningCatalog).zoneTypes)) return null;
  const options = zoneOptions(snapshot);
  // A catalogue this reader recognized NO domain in is a catalogue it did not
  // read — not one that has nothing. An entry without the `areaType`
  // discriminator is unreadable, not absent, and reporting "none available"
  // there would stand every growth domain down on the strength of a read that
  // answered nothing. `null` says "not observed", and callers suppress nothing
  // on it.
  if (options.length === 0) return null;
  const domains: LocalMayorGrowthDomain[] = [];
  for (const option of options) {
    const domain = option.areaType.toLowerCase();
    if (domain === "residential" || domain === "commercial" || domain === "industrial" || domain === "office") {
      if (!domains.includes(domain)) domains.push(domain);
    }
  }
  return domains;
}

/**
 * The unlocked zone prefab this catalogue would use for one growable domain.
 *
 * Read through `zoneOptions`, so the prefab the ZONING step authorizes is the
 * same one the candidate that produced the Goal was built from. The two used to
 * disagree about Office — the generator reads the office-labelled `Industrial`
 * zone type, while the ZONING reader looked for an `areaType` of `"Office"`,
 * which no catalogue names — so a category the game HAD unlocked would still be
 * refused by name.
 *
 * `null` means the catalogue exposes no unlocked zone for this domain.
 */
export function zonePrefabForDomain(snapshot: unknown, domain: LocalMayorGrowthDomain): string | null {
  if (!Array.isArray(record(record(snapshot).planningCatalog).zoneTypes)) return null;
  const option = zoneOptions(snapshot).find((candidate) => candidate.areaType.toLowerCase() === domain);
  if (!option) return null;
  // An option exists only when the zone prefab's own name resolved, so this is
  // the same prefab the Goal's candidate was built from.
  return option.zone;
}

function findPatches(
  snapshot: unknown,
  detail: SpatialSiteDetail,
  ownedTiles: SpatialTile[],
  minimumCells = MIN_CELLS,
): Patch[] {
  const allVisible = detail.zoningCells.filter((cell) => cell.visible === true);
  const safeRoadside = allVisible.filter(
    (cell) => isCanonicalZoningFrontageCell(cell) && isSafeUnzonedCell(cell, ownedTiles),
  );
  const patches: Patch[] = [];

  for (const anchor of roadAnchors(snapshot)) {
    const midpoint = { x: (anchor.start.x + anchor.end.x) / 2, z: (anchor.start.z + anchor.end.z) / 2 };
    const seeds = safeRoadside
      .filter(
        (cell) =>
          pointToSegmentDistance(cell.position, anchor.start, anchor.end) <= 48 &&
          Math.sqrt(squaredDistance(cell.position, midpoint)) <= 96,
      )
      .sort(
        (left, right) =>
          squaredDistance(left.position, midpoint) - squaredDistance(right.position, midpoint) ||
          left.block.index - right.block.index ||
          left.index - right.index,
      );
    let best: Patch | null = null;
    for (const seed of seeds) {
      for (const radius of CANDIDATE_RADII) {
        const radiusSquared = radius * radius;
        const affected = allVisible.filter(
          (cell) =>
            squaredDistance(cell.position, seed.position) <= radiusSquared &&
            isCanonicalZoningFrontageCell(cell) &&
            isSafeUnzonedCell(cell, ownedTiles),
        );
        if (affected.length < minimumCells) continue;
        const candidate = { anchor, seed, radius, cells: affected };
        if (
          !best ||
          candidate.cells.length > best.cells.length ||
          (candidate.cells.length === best.cells.length && candidate.radius < best.radius)
        ) {
          best = candidate;
        }
      }
    }
    if (best) patches.push(best);
  }

  return patches
    .sort(
      (left, right) =>
        right.cells.length - left.cells.length ||
        left.anchor.entity.index - right.anchor.entity.index ||
        left.seed.block.index - right.seed.block.index ||
        left.seed.index - right.seed.index,
    )
    .filter((patch, index, ordered) =>
      ordered
        .slice(0, index)
        .every(
          (existing) =>
            Math.sqrt(squaredDistance(patch.seed.position, existing.seed.position)) >
            patch.radius + existing.radius + 8,
        ),
    )
    .slice(0, MAX_PATCHES);
}

interface ExpansionCandidate {
  summary: MayorPlanningCandidate;
  action: MayorAction;
  center: SpatialPoint2;
  radius: number;
}

function findRoadExpansionCandidates(
  snapshot: unknown,
  detail: SpatialSiteDetail,
  ownedTiles: SpatialTile[],
  source?: RoadExpansionSource,
  preferences?: RoadExpansionPreferences,
  diagnostics?: RoadExpansionAttemptDiagnostic[],
): ExpansionCandidate[] {
  const candidates: ExpansionCandidate[] = [];
  for (const anchor of roadAnchors(snapshot).filter((item) => !source || sameEntity(item.entity, source.entity))) {
    const expansionStart = source?.endpoint ?? anchor.end;
    const dx = anchor.end.x - anchor.start.x;
    const dz = anchor.end.z - anchor.start.z;
    const length = Math.hypot(dx, dz);
    if (length < 1) {
      diagnostics?.push({
        sourceRoad: anchor.entity,
        start: expansionStart,
        end: expansionStart,
        headingDegrees: null,
        headingOffsetDegrees: 0,
        targetLength: 0,
        outcome: "rejected",
        rejectionReason: "invalid_source_geometry",
      });
      continue;
    }
    const direction =
      Math.hypot(expansionStart.x - anchor.start.x, expansionStart.z - anchor.start.z) <
      Math.hypot(expansionStart.x - anchor.end.x, expansionStart.z - anchor.end.z)
        ? { x: -dx / length, z: -dz / length }
        : { x: dx / length, z: dz / length };
    const baseHeading = headingDegrees(expansionStart, {
      x: expansionStart.x + direction.x,
      z: expansionStart.z + direction.z,
    });
    const offsets = preferences ? preferences.headingOffsetsDegrees.filter(Number.isFinite).slice(0, 7) : [0];
    const lengths = preferences ? preferences.targetLengths.filter(Number.isFinite).slice(0, 3) : [80];
    const headingTolerance = preferences ? Math.max(0, Math.min(45, preferences.headingToleranceDegrees)) : 0;
    const preferredHeading = preferences
      ? closestEquivalentHeading(preferences.preferredHeadingDegrees, baseHeading)
      : baseHeading;
    const candidatesForAnchor: ExpansionCandidate[] = [];
    for (const [offsetIndex, offset] of offsets.entries()) {
      const boundedOffset = Math.max(-180, Math.min(180, offset));
      for (const requestedLength of lengths) {
        const length = Math.max(32, Math.min(220, requestedLength));
        const jitter = preferences
          ? (deterministicUnit(`${preferences.seed}|${anchor.entity.index}|${offsetIndex}|${length}`) * 2 - 1) *
            headingTolerance
          : 0;
        const actualHeading = normalizeDegrees(preferredHeading + boundedOffset + jitter);
        const end = pointAtHeading(expansionStart, actualHeading, length);
        const samples = Array.from({ length: preferences ? 5 : 2 }, (_, index) => {
          const ratio = index / (preferences ? 4 : 1);
          return {
            x: expansionStart.x + (end.x - expansionStart.x) * ratio,
            z: expansionStart.z + (end.z - expansionStart.z) * ratio,
          };
        });
        const terrainSamples = samples.map((point) => terrainSample(point, detail.terrain));
        const safePath =
          !preferences ||
          (samples.slice(1).every((point) => isOwned(point, ownedTiles)) &&
            terrainSamples.every((sample) => sample.waterDepth <= 0) &&
            terrainSamples.slice(1).every((sample, index) => {
              const step = Math.max(1, length / 4);
              return Math.abs(sample.height - terrainSamples[index].height) / step <= 0.2;
            }) &&
            samples.every((point) =>
              detail.buildings.every(
                (building) => Math.hypot(building.position.x - point.x, building.position.z - point.z) >= 28,
              ),
            ) &&
            samples
              .slice(1)
              .every((point) =>
                detail.roadGraph.edges.every((edge) => pointToSegmentDistance(point, edge.start, edge.end) >= 18),
              ));
        const terrainStart = terrainSamples[0];
        const terrainEnd = terrainSamples[terrainSamples.length - 1];
        const terrainVariation = Math.max(
          ...terrainSamples.slice(1).map((sample, index) => Math.abs(sample.height - terrainSamples[index].height)),
        );
        const diagnostic = {
          sourceRoad: anchor.entity,
          start: expansionStart,
          end,
          headingDegrees: actualHeading,
          headingOffsetDegrees: boundedOffset,
          targetLength: length,
          outcome: "rejected" as const,
        };
        if (!isOwned(end, ownedTiles)) {
          diagnostics?.push({ ...diagnostic, rejectionReason: "outside_owned_land" });
          continue;
        }
        if (terrainEnd.waterDepth > 0) {
          diagnostics?.push({ ...diagnostic, rejectionReason: "water" });
          continue;
        }
        if (Math.abs(terrainEnd.height - terrainStart.height) / length > 0.2) {
          diagnostics?.push({ ...diagnostic, rejectionReason: "slope" });
          continue;
        }
        if (
          detail.buildings.some((building) => Math.hypot(building.position.x - end.x, building.position.z - end.z) < 28)
        ) {
          diagnostics?.push({ ...diagnostic, rejectionReason: "building_collision" });
          continue;
        }
        if (detail.roadGraph.edges.some((edge) => pointToSegmentDistance(end, edge.start, edge.end) < 18)) {
          diagnostics?.push({ ...diagnostic, rejectionReason: "duplicate_road" });
          continue;
        }
        if (!safePath) {
          const rejectionReason: RoadExpansionRejectionReason = samples
            .slice(1)
            .some((point) => !isOwned(point, ownedTiles))
            ? "outside_owned_land"
            : terrainSamples.some((sample) => sample.waterDepth > 0)
              ? "water"
              : terrainSamples.slice(1).some((sample, index) => {
                    const step = Math.max(1, length / 4);
                    return Math.abs(sample.height - terrainSamples[index].height) / step > 0.2;
                  })
                ? "slope"
                : samples.some((point) =>
                      detail.buildings.some(
                        (building) => Math.hypot(building.position.x - point.x, building.position.z - point.z) < 28,
                      ),
                    )
                  ? "building_collision"
                  : "duplicate_road";
          diagnostics?.push({ ...diagnostic, rejectionReason });
          continue;
        }
        const directionName =
          Math.abs(Math.cos((actualHeading * Math.PI) / 180)) >= Math.abs(Math.sin((actualHeading * Math.PI) / 180))
            ? Math.cos((actualHeading * Math.PI) / 180) > 0
              ? "east"
              : "west"
            : Math.sin((actualHeading * Math.PI) / 180) > 0
              ? "south"
              : "north";
        const role = preferences?.topologyPreference;
        const id = `E-${anchor.entity.index}-${anchor.entity.version}-${directionName}-${Math.round(length)}-${Math.round(
          boundedOffset,
        )}`;
        candidatesForAnchor.push({
          summary: {
            id,
            actionType: "build_road",
            candidateType: "road_expansion",
            approximateLength: length,
            approximateNewFrontage: length,
            approximateDirection: directionName,
            sourceRoad: anchor.entity,
            adjacentRoad: { entity: anchor.entity, prefab: anchor.prefab },
            accessibility: "connected_endpoint",
            spatialRole: "small_expansion",
            relevantDemand: { category: "residential", value: null },
            estimatedCost: null,
            constraints: ["inside_owned_land", "clear_terrain", "no_building_collision", "native_preview_required"],
            validationStatus: "validated",
            conflictGroup: `E-${anchor.entity.index}-${anchor.entity.version}`,
            ...(preferences
              ? {
                  roadHeadingDegrees: actualHeading,
                  roadHeadingDeltaDegrees: Math.round(angularDistance(actualHeading, baseHeading) * 1_000) / 1_000,
                  roadTopologyRole: role,
                  roadLength: length,
                  roadTerrainVariation: Math.round(terrainVariation * 1_000) / 1_000,
                }
              : {}),
          },
          action: {
            type: "build_road",
            prefab: anchor.prefab,
            x1: expansionStart.x,
            z1: expansionStart.z,
            x2: end.x,
            z2: end.z,
          },
          center: end,
          radius: length,
        });
        diagnostics?.push({ ...diagnostic, outcome: "accepted" });
      }
    }
    candidates.push(
      ...candidatesForAnchor
        .sort(
          (left, right) =>
            (preferences?.topologyPreference === "contour_connector"
              ? (left.summary.roadTerrainVariation ?? 0) - (right.summary.roadTerrainVariation ?? 0)
              : 0) ||
            angularDistance(
              left.summary.roadHeadingDegrees ?? baseHeading,
              preferences?.preferredHeadingDegrees ?? baseHeading,
            ) -
              angularDistance(
                right.summary.roadHeadingDegrees ?? baseHeading,
                preferences?.preferredHeadingDegrees ?? baseHeading,
              ) ||
            (preferences?.hierarchyPreference === "collector_spine"
              ? (right.summary.roadLength ?? 0) - (left.summary.roadLength ?? 0)
              : preferences?.hierarchyPreference === "fine_grain"
                ? (left.summary.roadLength ?? 0) - (right.summary.roadLength ?? 0)
                : 0) ||
            (right.summary.approximateNewFrontage ?? 0) - (left.summary.approximateNewFrontage ?? 0) ||
            left.summary.id.localeCompare(right.summary.id),
        )
        .slice(0, MAX_ROAD_EXPANSION_CANDIDATES),
    );
  }
  return candidates.slice(0, MAX_ROAD_EXPANSION_CANDIDATES);
}

export function buildMayorCandidateSet(input: {
  snapshot: unknown;
  detail: SpatialSiteDetail;
  ownedTiles: SpatialTile[];
  validatedRoadExpansionIds?: Set<string>;
  urbanDesign?: UrbanDesignCandidateMetadataInput;
  urbanDesignPolicy?: UrbanDesignCandidatePolicy;
  forceRoadExpansion?: boolean;
  roadExpansionSource?: RoadExpansionSource;
  minimumZoningCells?: number;
  roadExpansionDiagnostics?: RoadExpansionAttemptDiagnostic[];
}): MayorCandidateSet {
  if (input.ownedTiles.length === 0) throw new Error("candidate discovery requires owned tiles");
  const policy = input.urbanDesignPolicy;
  const includeZoning =
    !input.forceRoadExpansion &&
    (policy ? policy.includeExistingFrontage : true) &&
    policy?.developmentPolicy !== "expand_first";
  const allowRoadExpansion = policy ? policy.developmentPolicy !== "infill" : true;
  const patches = includeZoning
    ? findPatches(
        input.snapshot,
        input.detail,
        input.ownedTiles,
        Math.max(1, Math.min(MIN_CELLS, input.minimumZoningCells ?? MIN_CELLS)),
      )
    : [];
  const registry = new Map<string, PrivateMayorCandidate>();
  for (const patch of patches) {
    const conflictGroup = `P-${patch.anchor.entity.index}-${patch.seed.block.index}-${patch.seed.index}`;
    const options = zoneOptions(input.snapshot);
    if (policy?.growthDomain) {
      options.sort(
        (left, right) =>
          Number(right.demandCategory === policy.growthDomain) - Number(left.demandCategory === policy.growthDomain),
      );
    }
    for (const option of options) {
      const id = `${option.prefix}-${patch.anchor.entity.index}-${patch.seed.block.index}-${patch.seed.index}`;
      const summary: MayorPlanningCandidate = {
        id,
        actionType: "zone",
        candidateType: "zoning",
        zoneType: option.zone,
        areaType: option.areaType,
        approximateCells: patch.cells.length,
        adjacentRoad: { entity: patch.anchor.entity, prefab: patch.anchor.prefab },
        accessibility: "roadside",
        spatialRole: "infill",
        relevantDemand: { category: option.demandCategory, value: option.demand },
        estimatedCost: 0,
        constraints: [
          "inside_owned_land",
          "adjacent_to_existing_road",
          "live_unzoned_cells",
          "no_occupied_or_blocked_cells",
          "no_existing_zone_overwrite",
        ],
        validationStatus: "validated",
        ...(policy?.growthDomain ? { growthDomain: policy.growthDomain } : {}),
        conflictGroup,
        ...(input.urbanDesign
          ? { urbanDesign: { ...input.urbanDesign.metadata, designRole: "district_infill" as const } }
          : {}),
      };
      registry.set(id, {
        summary,
        action: {
          type: "zone",
          zone: option.zone,
          x: patch.seed.position.x,
          z: patch.seed.position.z,
          radius: patch.radius,
        },
        center: patch.seed.position,
        radius: patch.radius,
        zoningCells: patch.cells.map((cell) => ({ block: cell.block, index: cell.index })),
        frontageRoad: { entity: patch.anchor.entity, prefab: patch.anchor.prefab },
        snapshotRevision:
          typeof record(input.snapshot).snapshotRevision === "string"
            ? (record(input.snapshot).snapshotRevision as string)
            : null,
      });
    }
  }
  if (
    allowRoadExpansion &&
    (registry.size === 0 || policy?.developmentPolicy === "mixed" || input.forceRoadExpansion)
  ) {
    for (const expansion of findRoadExpansionCandidates(
      input.snapshot,
      input.detail,
      input.ownedTiles,
      input.roadExpansionSource,
      policy?.roadExpansion,
      input.roadExpansionDiagnostics,
    )) {
      if (input.validatedRoadExpansionIds && !input.validatedRoadExpansionIds.has(expansion.summary.id)) continue;
      registry.set(
        expansion.summary.id,
        input.urbanDesign
          ? {
              ...expansion,
              summary: {
                ...expansion.summary,
                ...(policy?.growthDomain ? { growthDomain: policy.growthDomain } : {}),
                urbanDesign: { ...input.urbanDesign.metadata, designRole: "primary_road" as const },
              },
            }
          : policy?.growthDomain
            ? { ...expansion, summary: { ...expansion.summary, growthDomain: policy.growthDomain } }
            : expansion,
      );
    }
  }
  return {
    status: "available",
    candidates: [...registry.values()].map((candidate) => candidate.summary),
    note:
      patches.length > 0
        ? "Choose a validated candidate by id; raw geometry remains private and is revalidated immediately before execution. Candidates sharing a conflictGroup are mutually exclusive."
        : registry.size > 0
          ? "No zoning frontage is currently available; choose a validated road expansion candidate to open future buildable frontage."
          : "No non-overlapping zoning patch or validated road expansion candidate is currently available.",
    registry,
    ownedTiles: input.ownedTiles,
  };
}

export function zoningCandidateRemainsValid(
  candidate: PrivateMayorCandidate,
  detail: SpatialSiteDetail,
  ownedTiles: SpatialTile[],
): boolean {
  return validateZoningCandidate(candidate, detail, ownedTiles).ok;
}

export function validateZoningCandidate(
  candidate: PrivateMayorCandidate,
  detail: SpatialSiteDetail,
  ownedTiles: SpatialTile[],
): ZoningCandidateValidation {
  const refs = candidate.zoningCells;
  if (!refs || refs.length < 4 || refs.some((ref) => !Number.isInteger(ref.index) || ref.index < 0)) {
    return { ok: false, code: "residual_zoning_payload_incomplete", reason: "missing_exact_cells" };
  }
  const cells: SpatialZoningCell[] = [];
  for (const ref of refs) {
    const cell = detail.zoningCells.find(
      (candidateCell) =>
        candidateCell.index === ref.index &&
        candidateCell.block.index === ref.block.index &&
        candidateCell.block.version === ref.block.version,
    );
    if (!cell) return { ok: false, code: "residual_zoning_revalidation_failure", reason: "cell_missing" };
    if (!isOwned(cell.position, ownedTiles))
      return { ok: false, code: "residual_zoning_revalidation_failure", reason: "ownership_changed" };
    if (!isCanonicalZoningFrontageCell(cell))
      return { ok: false, code: "residual_zoning_revalidation_failure", reason: "not_frontage" };
    if (!isSafeUnzonedCell(cell, ownedTiles))
      return { ok: false, code: "residual_zoning_revalidation_failure", reason: "occupied_cell" };
    cells.push(cell);
  }
  return { ok: true, cells };
}
