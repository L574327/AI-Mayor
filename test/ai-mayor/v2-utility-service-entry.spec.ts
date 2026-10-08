import type { GreenfieldUtilityExecutionScope } from "../../src/main/services/ai-mayor/v2/greenfield-utility-bootstrap";
import { currentUtilityServiceEntry } from "../../src/main/services/ai-mayor/v2/utility-service-entry";

const scope: GreenfieldUtilityExecutionScope = {
  intentId: "intent", projectId: "project", trancheId: "tranche", reservationRef: "reservation",
  worldId: "world", worldEpochId: "world:generation:g1", generation: "g1", topologyRevision: "g1:production",
  certifiedRoadRefs: [{ index: 20, version: 3 }],
  targetServiceEntry: { road: { index: 20, version: 3 }, position: { x: 12, z: 8 }, prefab: "Small Road",
    farEnd: { x: 24, z: 8 } },
  targetSemantics: { schemaVersion: "ai-mayor-v2-electricity-target/1", utility: "ELECTRICITY", role: "NETWORK_ENTRY",
    attachmentRole: "END", approvedContact: { x: 12, z: 8 },
    targetRoad: { prefab: "Small Road", endpointRole: "start", anchor: { x: 12, z: 8 } }, approvedPlanRevision: "g1:production" },
  spatialEnvelope: { center: { x: 0, z: 0 }, radius: 100 }, maximumSpend: 1000, treasury: 2000,
  treasurySafetyReserve: 0,
};

const identity = { projectId: "project", trancheId: "tranche", worldId: "world", worldEpochId: "world:generation:g1", generation: "g1" };
const fallback = { target: { entity: { index: 10, version: 1 }, position: { x: 0, z: 0 }, prefab: "Medium Road" },
  refs: [{ index: 10, version: 1 }] };

describe("current utility service-entry binding", () => {
  test("carries the same-branch admitted successor target through K05 re-entry", () => {
    expect(currentUtilityServiceEntry({ scope, ...identity, fallback })).toEqual({
      target: { entity: { index: 20, version: 3 }, position: { x: 12, z: 8 }, prefab: "Small Road",
        farEnd: { x: 24, z: 8 } },
      refs: [{ index: 20, version: 3 }],
    });
  });

  test("falls back to root delivery when generation or semantic binding is stale", () => {
    expect(currentUtilityServiceEntry({ scope, ...identity, worldEpochId: "world:generation:g2", fallback })).toBe(fallback);
    const invalid = structuredClone(scope);
    invalid.targetSemantics!.approvedContact.x += 1;
    expect(currentUtilityServiceEntry({ scope: invalid, ...identity, fallback })).toBe(fallback);
  });
});
