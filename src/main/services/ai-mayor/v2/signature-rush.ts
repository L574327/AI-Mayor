import type { SpatialPoint2, SpatialRoadEdge } from "../spatial/types";
import { civicSiteCandidates, type CivicSiteCandidate } from "./civic-service";

/**
 * SIGNATURE BUILDINGS FOR XP (speedrun "Signature XP"; 新攻略补充: a design-level cheese, kept as a conditional strategy and watched on the books).
 *
 * Measured live 2026-10-05 (萨利克斯, milestone 3, 2,234 people): placing the unlocked `EU_ResidentialLowSignature01` gave +250 XP at once (with the
 * game paused), against about +70-80 XP a game hour the city earned by itself; the treasury did not move (964,553 before and after) and the service
 * upkeep did not move (74,457). The game raises a "signature building unlocked" popup when one unlocks, and the Mayor's popup guard already closes
 * it (`blocking-modal-runtime.ts`, SIGNATURE_UNLOCK). Signature buildings are private buildings (homes, offices, works), not the public services the
 * old P1 rule kept out of XP play, so placing one as soon as it unlocks is allowed; the XP it gave is read back and noted.
 *
 * Where: a lot that faces a street first (the building then works as what it is); the street frontage of a grown city is mostly taken (live: 150
 * street lots refused, all "overlap"), so free ground near a street follows, where it stands without its own road access and still gives the XP.
 */

/** Lots put to the game's preflight per signature per cycle (each is one Bridge call). */
export const SIGNATURE_MAXIMUM_PREFLIGHTS = 48;
/** Setbacks from a street for a lot facing it. */
export const SIGNATURE_STREET_SETBACKS_METERS: readonly number[] = [14, 20, 28];
/** Free-ground fallback: points this far from a street node, in eight directions. */
export const SIGNATURE_OFF_STREET_OFFSETS_METERS: readonly number[] = [45, 70];

export interface SignatureCandidate extends CivicSiteCandidate { facesStreet: boolean }

/** The signature buildings that are unlocked and not yet standing (each stands at most once). */
export function signaturesToPlace(offered: ReadonlyArray<{ name: string; locked: boolean }>, standing: ReadonlySet<string>): string[] {
  return offered.filter((entry) => !entry.locked && /Signature/.test(entry.name) && !standing.has(entry.name)).map((entry) => entry.name).sort();
}

/**
 * Lots to offer the game: street-facing lots spread over the whole network (every k-th, so the whole city is sampled, not only the dense centre),
 * then free ground beside street nodes (no frontage). Only owned land.
 */
export function signatureCandidates(input: { edges: readonly SpatialRoadEdge[]; nodes: readonly SpatialPoint2[]; isOwned(point: SpatialPoint2): boolean;
  centre: SpatialPoint2; limit?: number }): SignatureCandidate[] {
  // Half the preflights for each kind: in a grown city the frontage is all taken, and the free ground must still be reached within the budget.
  const limit = input.limit ?? SIGNATURE_MAXIMUM_PREFLIGHTS;
  const street = civicSiteCandidates({ target: input.centre, edges: input.edges, setbacksMeters: SIGNATURE_STREET_SETBACKS_METERS, maximumDistanceMeters: 5_000,
    maximumCandidates: 20_000 }).filter((site) => input.isOwned(site.position));
  const stride = Math.max(1, Math.floor(street.length / Math.max(1, Math.floor(limit / 2))));
  const facing = street.filter((_, index) => index % stride === 0).slice(0, Math.floor(limit / 2)).map((site) => ({ ...site, facesStreet: true }));
  const off: SignatureCandidate[] = [];
  const nodeStride = Math.max(1, Math.floor(input.nodes.length / 24));
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]] as const;
  for (let index = 0; index < input.nodes.length && off.length < limit - facing.length; index += nodeStride) {
    const node = input.nodes[index]!;
    for (const meters of SIGNATURE_OFF_STREET_OFFSETS_METERS) for (const [dx, dz] of directions) {
      const position = { x: node.x + dx * meters, z: node.z + dz * meters };
      if (!input.isOwned(position)) continue;
      // Facing the node it stands off from (degrees; 0 faces +Z).
      const rotation = (Math.atan2(-dx, -dz) * 180) / Math.PI;
      off.push({ position, street: node, setbackMeters: meters, rotation: (rotation + 360) % 360, facesStreet: false });
    }
  }
  return [...facing, ...off].slice(0, limit);
}
