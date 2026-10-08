import type { PlannedUtilityFacility } from "../../src/main/services/ai-mayor/spatial/types";
import type { UtilityPlacementOperation } from "../../src/main/services/ai-mayor/v2/durability";
import {
  createDurableGreenfieldUtilityState,
  createUtilityPlacementSuccessor,
  MAX_UTILITY_SUCCESSOR_PLACEMENT_SCOPES,
  type DurableGreenfieldUtilityKindState,
  type GreenfieldUtilityExecutionScope,
} from "../../src/main/services/ai-mayor/v2/greenfield-utility-bootstrap";
import type { FirstFacilityPlacementDurability } from "../../src/main/services/ai-mayor/v2/utility-placement-durability";

const scope: GreenfieldUtilityExecutionScope = {
  intentId: "intent", projectId: "project", trancheId: "tranche", reservationRef: "reservation",
  worldId: "world", worldEpochId: "world:generation:generation-1", generation: "generation-1", topologyRevision: "generation-1:production",
  certifiedRoadRefs: [{ index: 10, version: 1 }], targetServiceEntry: { road: { index: 10, version: 1 }, position: { x: 0, z: 0 } },
  spatialEnvelope: { center: { x: 0, z: 0 }, radius: 500 }, maximumSpend: 50_000, treasury: 50_000, treasurySafetyReserve: 0,
};
const plan = (x: number): PlannedUtilityFacility => ({
  kind: "power", prefab: "WindTurbine03", position: { x, z: -55.94 }, rotationCandidates: [0], constructionCost: 1_000,
  expectedCapacity: 100, siteEvidence: { roadDistance: 20, connectionDistance: 30 },
  serviceRoads: [{ start: { x, z: -50 }, end: { x, z: -45 } }],
  connection: { prefab: "Low-voltage Ground Cable", start: { x, z: -55 }, end: { x, z: -50 } },
});
const exhaustedSiteFingerprint = JSON.stringify({
  kind: "electricity", objectiveId: scope.intentId, projectId: scope.projectId, trancheId: scope.trancheId,
  worldEpochId: scope.worldEpochId, topologyRevision: scope.topologyRevision,
  facility: { prefab: "WindTurbine03", position: { x: -1073.62, z: -55.94 } },
});
const alternateSiteFingerprint = JSON.stringify({ kind: "electricity", prefab: "WindTurbine03", position: { x: -1194.55, z: -55.94 }, roadDistance: 20, connectionDistance: 30 });
const observedOperation: UtilityPlacementOperation = {
  commandId: "place-a", position: 1, outcome: "OBSERVED_MATCH", status: "OBSERVED_MATCH",
  effectAbsenceProven: false, failedBeforeSubmit: false,
};
const placed: FirstFacilityPlacementDurability = { status: "PLACED", commandId: "place-a" };

function predecessor() {
  const utility: DurableGreenfieldUtilityKindState = createDurableGreenfieldUtilityState(scope).utilities.electricity;
  utility.stage = "PLACED";
  utility.plan = plan(-1073.62);
  utility.planBinding = { projectId: scope.projectId, worldEpochId: scope.worldEpochId, topologyRevision: scope.topologyRevision };
  utility.facilityCommandId = "place-a";
  utility.facility = { entity: { index: 50, version: 1 }, prefab: "WindTurbine03", position: utility.plan.position };
  utility.connectionReplan.journal.push(
    { event: "UTILITY_SITE_CONTEXT_EXHAUSTED", siteFingerprint: exhaustedSiteFingerprint, reason: "all six contacts exhausted" },
    { event: "ALTERNATE_UTILITY_SITE_SELECTED", siteFingerprint: alternateSiteFingerprint,
      alternateSiteFingerprint, exhaustedSiteFingerprint, sitePosition: { x: -1194.55, z: -55.94 }, reason: "ranked alternate" },
  );
  return utility;
}

const promote = (utility: DurableGreenfieldUtilityKindState, options: {
  placement?: FirstFacilityPlacementDurability;
  operations?: UtilityPlacementOperation[] | null;
  alternate?: PlannedUtilityFacility;
} = {}) => createUtilityPlacementSuccessor({
  utility, plan: options.alternate ?? plan(-1194.55), alternateSiteFingerprint, exhaustedSiteFingerprint,
  projectId: scope.projectId,
  trancheId: scope.trancheId,
  worldId: scope.worldId, worldEpochId: scope.worldEpochId, generation: scope.generation, branchActivated: true,
  predecessorPlacement: options.placement ?? placed,
  predecessorOperations: options.operations === undefined ? [observedOperation] : options.operations,
});

describe("utility facility placement successor scopes", () => {
  test("A: exhausted, authoritatively placed site gets an independent successor and preserves predecessor", () => {
    const before = predecessor();
    const promoted = promote(before);
    expect(promoted).not.toBeNull();
    expect(promoted!.utility.stage).toBe("MISSING");
    expect(promoted!.utility.plan?.position).toEqual({ x: -1194.55, z: -55.94 });
    expect(promoted!.utility.placementScopeHistory).toEqual([expect.objectContaining({
      placementScopeId: "utility-placement:legacy", siteFingerprint: exhaustedSiteFingerprint,
      disposition: "EXHAUSTED_STRANDED", facilityCommandId: "place-a", facility: before.facility,
    })]);
  });

  test("B: same site re-entry cannot mint a successor scope", () => {
    expect(promote(predecessor(), { alternate: plan(-1073.62) })).toBeNull();
  });

  test("C: repeated progression for the same alternate site reuses its successor identity", () => {
    const first = promote(predecessor())!;
    const second = promote(first.utility)!;
    expect(second).toMatchObject({ placementScopeId: first.placementScopeId, reused: true });
    expect(second.utility.placementScopeHistory).toHaveLength(1);
  });

  test("D: unresolved predecessor Apply remains fail-closed", () => {
    expect(promote(predecessor(), {
      placement: { status: "UNRESOLVED", commandId: "place-a", outcome: "UNKNOWN" },
    })).toBeNull();
  });

  test("E: successor scope identity is site-specific and exactly one scope is promoted", () => {
    const promoted = promote(predecessor())!;
    expect(promoted.placementScopeId).toContain('"x":-1194.55');
    expect(promoted.utility.placementScopeHistory).toHaveLength(1);
  });

  test("F: successor site count is bounded", () => {
    const utility = predecessor();
    utility.placementScopeHistory = Array.from({ length: MAX_UTILITY_SUCCESSOR_PLACEMENT_SCOPES }, (_, index) => ({
      placementScopeId: `site-${index}`, siteFingerprint: `site-${index}`, disposition: "EXHAUSTED_STRANDED" as const,
      plan: plan(index), facilityCommandId: `place-${index}`,
      facility: { entity: { index, version: 1 }, prefab: "WindTurbine03", position: { x: index, z: -55.94 } },
      commandOutcome: "OBSERVED_MATCH" as const, networkCommandIds: [], serviceEvidence: null,
      worldEpochId: scope.worldEpochId, generation: scope.generation,
    }));
    expect(promote(utility)).toBeNull();
  });

  test("unknown or unavailable durable lineage never creates a successor", () => {
    expect(promote(predecessor(), { operations: null })).toBeNull();
    expect(promote(predecessor(), { operations: [{ ...observedOperation, status: "UNKNOWN_TRANSPORT", outcome: "UNKNOWN" }] })).toBeNull();
  });

  test("a previously journaled escaped exhaustion reference is normalized before re-entry", () => {
    const utility = predecessor();
    utility.connectionReplan.journal[1].exhaustedSiteFingerprint = JSON.stringify(exhaustedSiteFingerprint);
    expect(promote(utility)).not.toBeNull();
  });
});
