import type { SpatialEntityRef, SpatialPoint3 } from "../spatial/types";
import { createHash } from "node:crypto";

/** Durable, generation-independent description of the one supported junction repair. */
export interface BoundedNetworkJunctionInsert {
  kind: "BOUNDED_NETWORK_JUNCTION_INSERT";
  utility: "ELECTRICITY";
  road: {
    prefab: "Medium Road";
    role: "PUMP_ACCESS_ROAD_CONTACT";
    contact: { x: number; z: number };
    course: { x1: number; z1: number; x2: number; z2: number };
  };
  segment2Terminal: {
    lineage: "SEGMENT_2_TERMINAL";
    prefab: "Low-voltage Ground Cable";
    endpoint: "PUMP_SIDE";
    anchor: { x: number; z: number };
  };
  replacementClasses: readonly [
    "PUMP_ACCESS_ROAD",
    "SEGMENT_2_TERMINAL_CABLE_EDGE",
    "PUMP_INTERNAL_CAR_PATH",
    "PUMP_INTERNAL_ROAD_PATH",
  ];
  replacementSemantics: readonly [
    { semanticClass: "PUMP_ACCESS_ROAD"; prefab: "Small Road"; anchorRole: "CONTAINS_PUMP_CONTACT" },
    { semanticClass: "SEGMENT_2_TERMINAL_CABLE_EDGE"; prefab: "Low-voltage Ground Cable"; anchorRole: "PUMP_SIDE_TERMINAL" },
    { semanticClass: "PUMP_INTERNAL_CAR_PATH"; prefab: "Invisible Car Path - 1xTwoway"; anchorRole: "PUMP_INTERNAL_PATH" },
    { semanticClass: "PUMP_INTERNAL_ROAD_PATH"; prefab: "Invisible Road Path - 2xTwoway"; anchorRole: "PUMP_INTERNAL_PATH" },
  ];
  expectedSuccessors: {
    segment2CableEdges: 1;
    pumpRoadEdges: 1;
    localConnectJunctionNodes: 1;
  };
  maximumCourseLengthMeters: 10;
}

export type JunctionReplacementClass = BoundedNetworkJunctionInsert["replacementClasses"][number];

/** Ephemeral preview evidence. Entity references here are current-generation observations only. */
export interface JunctionReplacementObservation {
  entity: SpatialEntityRef;
  semanticClass: JunctionReplacementClass | "SEGMENT_1" | "WATER_PIPE" | "PUMP_BUILDING" | "UNEXPECTED";
}

export interface JunctionReplacementCheck {
  valid: boolean;
  reason: string;
  observedClasses: JunctionReplacementClass[];
}

export interface BoundedJunctionAdmissionEvidence {
  operationKind: "BOUNDED_NETWORK_JUNCTION_INSERT";
  identityFingerprint: string;
  replacementFingerprint: string;
  nativeAllowApply: boolean;
  replacementObservations: readonly JunctionReplacementObservation[];
  /** Current-generation road contact witness used only for native ROAD submission. */
  nativeRoadContact?: {
    roadEdge: SpatialEntityRef;
    roadNode: SpatialEntityRef;
    position: SpatialPoint3;
    endpointRole: "START";
  };
  duplicateRisk: "NO" | "YES" | "UNKNOWN";
  segment1Touched: boolean;
  waterPipeTouched: boolean;
  pumpBuildingTouched: boolean;
  fullSegment2Rebuild: boolean;
  segment2TerminalLocalReplacementOnly: boolean;
  expectedSuccessorLineage: boolean;
  segment2SourceContinuity: boolean;
  pumpRoadFlowComponentContinuous: boolean;
  localConnectCompatibleMediumRoad: boolean;
  quote: number;
  quoteSource: "NATIVE_TOOL_TEMP_COST" | "UNKNOWN";
  nativeTempCount: number;
}

export function junctionIdentityFingerprint(contract: BoundedNetworkJunctionInsert): string {
  const identity = JSON.stringify({
    operationKind: contract.kind,
    roadPrefab: contract.road.prefab,
    course: contract.road.course,
    targetSemantic: { role: contract.road.role, contact: contract.road.contact },
    expectedReplacementClasses: [...contract.replacementClasses].sort(),
    replacementSemantics: contract.replacementSemantics,
    segment2TerminalLineage: contract.segment2Terminal,
  });
  return createHash("sha256").update(identity).digest("hex");
}

export function junctionReplacementFingerprint(observations: readonly JunctionReplacementObservation[]): string {
  return junctionReplacementClassFingerprint(observations.map((item) => item.semanticClass));
}

export function junctionReplacementClassFingerprint(classes: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...classes].sort())).digest("hex");
}

export function createPumpSegment2JunctionContract(): BoundedNetworkJunctionInsert {
  return {
    kind: "BOUNDED_NETWORK_JUNCTION_INSERT",
    utility: "ELECTRICITY",
    road: {
      prefab: "Medium Road",
      role: "PUMP_ACCESS_ROAD_CONTACT",
      contact: { x: -215.4844512939453, z: 1319.075439453125 },
      course: { x1: -215.4844512939453, z1: 1319.075439453125, x2: -214.08384704589844, z2: 1310.9451904296875 },
    },
    segment2Terminal: {
      lineage: "SEGMENT_2_TERMINAL",
      prefab: "Low-voltage Ground Cable",
      endpoint: "PUMP_SIDE",
      anchor: { x: -226.90899658203125, z: 1316.5 },
    },
    replacementClasses: [
      "PUMP_ACCESS_ROAD",
      "SEGMENT_2_TERMINAL_CABLE_EDGE",
      "PUMP_INTERNAL_CAR_PATH",
      "PUMP_INTERNAL_ROAD_PATH",
    ],
    replacementSemantics: [
      { semanticClass: "PUMP_ACCESS_ROAD", prefab: "Small Road", anchorRole: "CONTAINS_PUMP_CONTACT" },
      { semanticClass: "SEGMENT_2_TERMINAL_CABLE_EDGE", prefab: "Low-voltage Ground Cable", anchorRole: "PUMP_SIDE_TERMINAL" },
      { semanticClass: "PUMP_INTERNAL_CAR_PATH", prefab: "Invisible Car Path - 1xTwoway", anchorRole: "PUMP_INTERNAL_PATH" },
      { semanticClass: "PUMP_INTERNAL_ROAD_PATH", prefab: "Invisible Road Path - 2xTwoway", anchorRole: "PUMP_INTERNAL_PATH" },
    ],
    expectedSuccessors: { segment2CableEdges: 1, pumpRoadEdges: 1, localConnectJunctionNodes: 1 },
    maximumCourseLengthMeters: 10,
  };
}

export function validateBoundedNetworkJunctionInsert(input: {
  contract: BoundedNetworkJunctionInsert;
  prefab: string;
  course: { x1: number; z1: number; x2: number; z2: number };
  lengthMeters: number;
  observations: readonly JunctionReplacementObservation[];
}): JunctionReplacementCheck {
  const { contract, observations } = input;
  const classes = observations.map((observation) => observation.semanticClass);
  const observedClasses = classes.filter((value): value is JunctionReplacementClass =>
    (contract.replacementClasses as readonly string[]).includes(value));
  const reject = (reason: string): JunctionReplacementCheck => ({ valid: false, reason, observedClasses });
  if (contract.kind !== "BOUNDED_NETWORK_JUNCTION_INSERT" || contract.utility !== "ELECTRICITY") return reject("CONTRACT_KIND_MISMATCH");
  const approved = createPumpSegment2JunctionContract();
  if (junctionIdentityFingerprint(contract) !== junctionIdentityFingerprint(approved)) return reject("JUNCTION_IDENTITY_NOT_AUTHORIZED");
  if (input.prefab !== contract.road.prefab || !Number.isFinite(input.lengthMeters) || input.lengthMeters <= 0 ||
    input.lengthMeters > contract.maximumCourseLengthMeters) return reject("JUNCTION_COURSE_OUT_OF_BOUNDS");
  if (JSON.stringify(input.course) !== JSON.stringify(contract.road.course)) return reject("JUNCTION_EXACT_COURSE_MISMATCH");
  if (observations.some((item) => item.semanticClass === "SEGMENT_1" || item.semanticClass === "WATER_PIPE" || item.semanticClass === "PUMP_BUILDING")) {
    return reject("FORBIDDEN_REPLACEMENT_CLASS");
  }
  if (observations.some((item) => item.semanticClass === "UNEXPECTED")) return reject("UNEXPECTED_REPLACEMENT_ENTITY");
  if (new Set(observations.map((item) => `${item.entity.index}:${item.entity.version}`)).size !== observations.length) {
    return reject("DUPLICATE_REPLACEMENT_ENTITY");
  }
  const expected = [...contract.replacementClasses].sort();
  if ([...observedClasses].sort().join("|") !== expected.join("|")) return reject("REPLACEMENT_CLASS_SET_MISMATCH");
  return { valid: true, reason: "CERTIFIED_BOUNDED_SUCCESSOR_REPLACEMENT", observedClasses };
}

export function validateBoundedJunctionAdmission(input: {
  contract: BoundedNetworkJunctionInsert;
  evidence: BoundedJunctionAdmissionEvidence;
}): { valid: boolean; reason: string; replacementFingerprint: string } {
  const { contract, evidence } = input;
  const replacementFingerprint = junctionReplacementFingerprint(evidence.replacementObservations);
  const reject = (reason: string) => ({ valid: false, reason, replacementFingerprint });
  if (evidence.operationKind !== contract.kind || evidence.identityFingerprint !== junctionIdentityFingerprint(contract)) return reject("JUNCTION_PROPOSAL_IDENTITY_MISMATCH");
  if (!evidence.nativeAllowApply) return reject("NATIVE_ALLOW_APPLY_FALSE");
  const replacement = validateBoundedNetworkJunctionInsert({ contract, prefab: contract.road.prefab, course: contract.road.course,
    lengthMeters: Math.hypot(contract.road.course.x2 - contract.road.course.x1, contract.road.course.z2 - contract.road.course.z1),
    observations: evidence.replacementObservations });
  if (!replacement.valid) return reject(replacement.reason);
  if (evidence.replacementFingerprint !== replacementFingerprint) return reject("FRESH_REPLACEMENT_FINGERPRINT_MISMATCH");
  if (evidence.duplicateRisk !== "NO") return reject("JUNCTION_DUPLICATE_RISK_NOT_CLEAR");
  if (evidence.segment1Touched) return reject("SEGMENT1_TOUCHED");
  if (evidence.waterPipeTouched) return reject("WATER_PIPE_TOUCHED");
  if (evidence.pumpBuildingTouched) return reject("PUMP_BUILDING_TOUCHED");
  if (evidence.fullSegment2Rebuild) return reject("FULL_SEGMENT2_REBUILD_FORBIDDEN");
  if (!evidence.segment2TerminalLocalReplacementOnly) return reject("SEGMENT2_TERMINAL_LOCAL_REPLACEMENT_REQUIRED");
  if (!evidence.expectedSuccessorLineage) return reject("EXPECTED_SUCCESSOR_LINEAGE_MISSING");
  if (!evidence.segment2SourceContinuity) return reject("SEGMENT2_SOURCE_CONTINUITY_MISSING");
  if (!evidence.pumpRoadFlowComponentContinuous) return reject("PUMP_ROAD_FLOW_COMPONENT_DISCONTINUOUS");
  if (!evidence.localConnectCompatibleMediumRoad) return reject("LOCALCONNECT_MEDIUM_ROAD_NOT_PROVEN");
  if (evidence.quoteSource !== "NATIVE_TOOL_TEMP_COST" || !Number.isInteger(evidence.nativeTempCount) || evidence.nativeTempCount <= 0 ||
    !Number.isFinite(evidence.quote) || evidence.quote < 0) return reject("JUNCTION_NATIVE_QUOTE_INVALID");
  return { valid: true, reason: "BOUNDED_NETWORK_JUNCTION_ADMITTED", replacementFingerprint };
}

export function validateSegment2SuccessorLineage(input: {
  oldEdgePresent: boolean;
  successorEdgeCount: number;
  sourceToSuccessorReachable: boolean;
  successorToPumpRoadReachable: boolean;
}): boolean {
  return input.oldEdgePresent === false && input.successorEdgeCount === 1 &&
    input.sourceToSuccessorReachable && input.successorToPumpRoadReachable;
}

export interface BoundedJunctionPostApplyEvidence {
  oldSegment2TerminalPresent: boolean;
  successorCableEdges: readonly SpatialEntityRef[];
  successorRoadEdges: readonly SpatialEntityRef[];
  newJunctionNode: SpatialEntityRef | null;
  localConnectCompatibleNode: boolean;
  sourceToSegment2SuccessorReachable: boolean;
  segment2SuccessorToPumpRoadReachable: boolean;
  pumpRoadFlowComponentContinuous: boolean;
}

/** The old edge is expected to be replaced; only successor topology proves success. */
export function reconcileBoundedJunctionPostApply(evidence: BoundedJunctionPostApplyEvidence): {
  valid: boolean;
  segment2SuccessorLineage: boolean;
  segment2SourceContinuity: boolean;
  pumpRoadFlowComponentContinuous: boolean;
  localConnectCompatibleNodeFound: boolean;
  reason: string;
} {
  const segment2SuccessorLineage = evidence.oldSegment2TerminalPresent === false &&
    evidence.successorCableEdges.length >= 1 && evidence.successorRoadEdges.length >= 1 && evidence.newJunctionNode !== null;
  const segment2SourceContinuity = evidence.sourceToSegment2SuccessorReachable && evidence.segment2SuccessorToPumpRoadReachable;
  const pumpRoadFlowComponentContinuous = evidence.pumpRoadFlowComponentContinuous;
  const localConnectCompatibleNodeFound = evidence.localConnectCompatibleNode;
  const valid = segment2SuccessorLineage && segment2SourceContinuity && pumpRoadFlowComponentContinuous && localConnectCompatibleNodeFound;
  return {
    valid, segment2SuccessorLineage, segment2SourceContinuity, pumpRoadFlowComponentContinuous,
    localConnectCompatibleNodeFound,
    reason: valid ? "BOUNDED_JUNCTION_SUCCESSOR_TOPOLOGY_PASS" : "BOUNDED_JUNCTION_SUCCESSOR_TOPOLOGY_INCOMPLETE",
  };
}
