import {
  civicServicesWithEvidence,
  civicKindOfPrefab,
  civicPrefabFor,
  civicRotationToward,
  civicServicesOwed,
  civicSiteCandidates,
} from "../../src/main/services/ai-mayor/v2/civic-service";

const edge = (start: { x: number; z: number }, end: { x: number; z: number }, prefab = "Medium Road") => ({
  entity: { index: 1, version: 1 }, prefab, native: false, startNode: { index: 2, version: 1 },
  endNode: { index: 3, version: 1 }, start, end, length: Math.hypot(end.x - start.x, end.z - start.z),
}) as never;

describe("civic services", () => {
  test("recognises existing civic buildings, not their extensions", () => {
    expect(civicKindOfPrefab("MedicalClinic01")).toBe("healthcare");
    expect(civicKindOfPrefab("ElementarySchool03")).toBe("education");
    expect(civicKindOfPrefab("MedicalClinic01 Extension Wing")).toBeNull();
    expect(civicKindOfPrefab("EU_ResidentialLow01_L1_2x2")).toBeNull();
  });

  test("picks the first-tier unlocked prefab", () => {
    const unlocked = ["MedicalClinic02", "MedicalClinic01", "ElementarySchool03", "Landfill01", "FireHouse02", "FireHouse01"];
    expect(civicPrefabFor("healthcare", unlocked)).toBe("MedicalClinic01");
    expect(civicPrefabFor("education", unlocked)).toBe("ElementarySchool03");
    expect(civicPrefabFor("police", unlocked)).toBeNull();
  });

  test("owes a service once population reaches its threshold and none exists", () => {
    expect(civicServicesOwed({ population: 45, existingPrefabs: [] })).toEqual([]);
    expect(civicServicesOwed({ population: 1_600, existingPrefabs: [] })).toEqual(["healthcare", "education", "garbage", "fire"]);
    expect(civicServicesOwed({ population: 1_600, existingPrefabs: ["MedicalClinic01", "Landfill01"] }))
      .toEqual(["education", "fire"]);
    expect(civicServicesOwed({ population: null, existingPrefabs: [] })).toEqual([]);
  });

  test("candidates stand beside a street, on both sides, facing it", () => {
    const candidates = civicSiteCandidates({ target: { x: 0, z: 0 },
      edges: [edge({ x: -50, z: 0 }, { x: 50, z: 0 })], setbacksMeters: [20] });
    // Three positions along the street (30/50/70%), both sides; nearest the target first.
    expect(candidates).toHaveLength(6);
    expect(candidates[0]!.position.x).toBeCloseTo(0, 6);
    for (const candidate of candidates) {
      expect(Math.abs(candidate.position.z)).toBeCloseTo(20, 6);
      expect(Math.abs(candidate.position.x)).toBeLessThanOrEqual(20 + 1e-6);
      // Facing the street point (0,0): north of it faces -Z (180), south faces +Z (0).
      expect(candidate.rotation).toBeCloseTo(candidate.position.z > 0 ? 180 : 0, 6);
    }
  });

  test("ignores short stubs, pipes and highways, and streets out of reach", () => {
    expect(civicSiteCandidates({ target: { x: 0, z: 0 }, setbacksMeters: [20], edges: [
      edge({ x: 0, z: 0 }, { x: 10, z: 0 }),
      edge({ x: -50, z: 10 }, { x: 50, z: 10 }, "Water Pipe"),
      edge({ x: -50, z: 20 }, { x: 50, z: 20 }, "Highway Oneway"),
      edge({ x: 900, z: 0 }, { x: 1000, z: 0 }),
    ] })).toEqual([]);
  });

  test("yaw convention matches the utility planner: 0 faces +Z, 90 faces +X", () => {
    expect(civicRotationToward({ x: 0, z: 0 }, { x: 0, z: 10 })).toBeCloseTo(0, 6);
    expect(civicRotationToward({ x: 0, z: 0 }, { x: 10, z: 0 })).toBeCloseTo(90, 6);
  });

  test("a service is placed only when an icon asks for it, however large the population", () => {
    const owed = ["healthcare", "education", "garbage", "fire", "police"] as const;
    expect(civicServicesWithEvidence(owed, {})).toEqual([]);
    expect(civicServicesWithEvidence(owed, { "Hearse Notification": 8, "Noise Pollution": 25 })).toEqual([]);
    expect(civicServicesWithEvidence(owed, { "Crime Scene": 2, "Garbage Notification": 1 })).toEqual(["garbage", "police"]);
    expect(civicServicesWithEvidence(owed, { "Building On Fire": 0 })).toEqual([]);
    expect(civicServicesWithEvidence(owed, { "Medical Emergency": 3, "Building On Fire": 1 })).toEqual(["healthcare", "fire"]);
  });
});
