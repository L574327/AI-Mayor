import { rankRoadPlanningCandidates, scoreRoadPlanningCandidate, shouldPreviewRoadCandidate, DEFAULT_MAYOR_PLANNING_POLICY, durableUtilityPlanningJournal } from "../../src/main/services/ai-mayor/v2/road-planning-policy";

describe("road planning policy", () => {
  const direct = { segments: [{ id: "direct", role: "side" as const, start: { x: 0, z: 0 }, end: { x: 100, z: 0 } }] };
  const hook = { segments: [
    { id: "a", role: "side" as const, start: { x: 0, z: 0 }, end: { x: 40, z: 28 } },
    { id: "b", role: "side" as const, start: { x: 40, z: 28 }, end: { x: 100, z: 0 } },
  ] };

  test("soft score prefers direct, simple courses without removing candidates", () => {
    expect(scoreRoadPlanningCandidate(direct)).toBeGreaterThan(scoreRoadPlanningCandidate(hook));
    expect(rankRoadPlanningCandidates([hook, direct])).toEqual([direct, hook]);
    expect(rankRoadPlanningCandidates([hook, direct])).toHaveLength(2);
  });

  test("deterministic default policy exists without a Runtime Skill or LLM", () => {
    expect(DEFAULT_MAYOR_PLANNING_POLICY).toMatchObject({
      roadRolePreference: "LOCAL_GRID",
      expansionPreference: "COMPACT",
      utilitySitingPreference: "ROAD_CONNECTED",
    });
  });

  test("grid is a soft-scored road family ahead of a free corridor", () => {
    const free = { ...direct, family: "FREE_CORRIDOR" };
    const grid = { ...direct, family: "ORTHOGONAL_GRID", gridAlignmentErrorMeters: 4 };
    expect(rankRoadPlanningCandidates([free, grid])).toEqual([grid, free]);
  });

  test("same-context native-invalid candidate is not previewed again, but material context change is eligible", () => {
    const memory = [{ event: "ROAD_PLANNING_CANDIDATE_REJECTED", planningContextFingerprint: "context-A", candidateFingerprint: "road-A" }];
    expect(shouldPreviewRoadCandidate({ planningContextFingerprint: "context-A", candidateFingerprint: "road-A", memory })).toBe(false);
    expect(shouldPreviewRoadCandidate({ planningContextFingerprint: "context-A", candidateFingerprint: "road-B", memory })).toBe(true);
    expect(shouldPreviewRoadCandidate({ planningContextFingerprint: "context-B", candidateFingerprint: "road-A", memory })).toBe(true);
  });

  test("reads electricity rejection memory from the durable Gate 1 electricity key", () => {
    const journal = [{ event: "ROAD_PLANNING_CANDIDATE_REJECTED", planningContextFingerprint: "site-A", candidateFingerprint: "road-A" }];
    const projectState = { tranche: { utilityExecution: { utilities: { electricity: { connectionReplan: { journal } } } } } };
    const memory = durableUtilityPlanningJournal(projectState, "electricity");
    expect(memory).toEqual(journal);
    expect(shouldPreviewRoadCandidate({ planningContextFingerprint: "site-A", candidateFingerprint: "road-A", memory })).toBe(false);
    expect(durableUtilityPlanningJournal(projectState, "power")).toEqual([]);
  });
});
