// Mirrors the Bridge spatial net preflight contract: 8 <= length <= 1500m.
export const MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS = 8;
export const MAX_SUPPORTED_NET_SEGMENT_LENGTH_METERS = 1500;

// Numeric tolerance only; this does not change the Bridge business threshold.
export const NET_SEGMENT_LENGTH_NUMERIC_EPSILON_METERS = 1e-6;

export interface BridgeDomainPoint2 { x: number; z: number; }

/** Mirrors Bridge query parsing and Unity.Mathematics float2 distance. */
export function projectToBridgeDomain(point: BridgeDomainPoint2): BridgeDomainPoint2 {
  return { x: Math.fround(point.x), z: Math.fround(point.z) };
}

export function bridgeDomainNetSegmentLength(start: BridgeDomainPoint2, end: BridgeDomainPoint2): number {
  const projectedStart = projectToBridgeDomain(start);
  const projectedEnd = projectToBridgeDomain(end);
  const dx = Math.fround(projectedEnd.x - projectedStart.x);
  const dz = Math.fround(projectedEnd.z - projectedStart.z);
  const squared = Math.fround(Math.fround(dx * dx) + Math.fround(dz * dz));
  return Math.fround(Math.sqrt(squared));
}

export function isBridgeDomainNetSegmentLengthValid(start: BridgeDomainPoint2, end: BridgeDomainPoint2): boolean {
  const length = bridgeDomainNetSegmentLength(start, end);
  return length >= MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS && length <= MAX_SUPPORTED_NET_SEGMENT_LENGTH_METERS;
}

/** Find the first along-ray endpoint whose transmitted float32 coordinates pass Bridge's length contract. */
export function minimumBridgeDomainEndpoint(start: BridgeDomainPoint2, unit: BridgeDomainPoint2, minimum = MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS): BridgeDomainPoint2 | null {
  const at = (distance: number): BridgeDomainPoint2 => ({ x: start.x + unit.x * distance, z: start.z + unit.z * distance });
  let low = 0;
  let high = Math.max(minimum, 1);
  for (let attempt = 0; attempt < 32 && bridgeDomainNetSegmentLength(start, at(high)) < minimum; attempt += 1) high *= 2;
  if (bridgeDomainNetSegmentLength(start, at(high)) < minimum) return null;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const middle = (low + high) / 2;
    if (bridgeDomainNetSegmentLength(start, at(middle)) >= minimum) high = middle;
    else low = middle;
  }
  return at(high);
}
