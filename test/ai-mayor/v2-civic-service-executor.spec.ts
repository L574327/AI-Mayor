import { V2DurabilityCoordinator, createMemoryDurableStateStorage } from "@/main/services/ai-mayor/v2/durability";
import { planStarterResidentialIntent } from "@/main/services/ai-mayor/v2/gate1";
import { createV2FoundationPorts } from "@/main/services/ai-mayor/v2/main-adapter";

/**
 * The civic placement runs the utility facility path end to end: durable activation, native object preflight to
 * choose a legal site facing a street, one journaled `place_building` (UTILITY / civic) submitted only after it is
 * SUBMITTED in the journal, and the restart reconciler's prefab-at-position census as the readback.
 */
const WORLD = "c1v1c0000000000000000000000000aa";
const WORLD_ID = `cs2-session:${WORLD}`;
const GENERATION = "c1v1cgeneration00000000000000000";

const gameState = () => ({
  gameMode: "Game", isLoading: false, cityLoaded: true,
  simulation: { paused: true, frameIndex: 1000 },
  world: {
    identityStatus: "AVAILABLE", worldReady: true, worldId: WORLD_ID, nativeSessionGuid: WORLD,
    loadPurpose: "LoadGame", loadAssetGuid: "meta", saveDataAssetGuid: "data", mapAssetGuid: "map",
    checkpointId: "save:meta:data", bridgeRuntimeEpoch: "bridge-runtime",
    generation: GENERATION, generationSequence: 2, generationOrigin: "LOAD_COMPLETED",
    nativeOperationBusy: false, nativeOperationStage: "Idle",
  },
});

function storageWithProject() {
  const storage = createMemoryDurableStateStorage();
  const coordinator = new V2DurabilityCoordinator(storage);
  coordinator.activate(gameState());
  coordinator.saveProjectState(planStarterResidentialIntent({
    intentId: "intent:civic-test", targetResidents: 12, maximumBudget: 10_000,
    planningEnvelope: { center: { x: 0, z: 0 }, radius: 100 },
    siteCandidates: [{ id: "site-a", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 1, blocked: false }],
  }));
  return storage;
}

function bridge(options: { population: number; preflightValidAfter: number; placementLands: boolean; nativeRefusals?: number; preflightThrows?: boolean; treasury?: number; monthlyBalance?: number }) {
  let refusalsLeft = options.nativeRefusals ?? 0;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const placed: Array<{ prefab: string; x: number; z: number }> = [];
  let preflights = 0;
  const homes = [{ entity: { index: 1, version: 1 }, prefab: "EU_ResidentialMedium01_L1_2x2", position: { x: 0, z: 30 } }];
  const manager = {
    legacyList: async () => ({ tools: ["cs2_game_state", "cs2_statistics", "cs2_list_buildings", "cs2_mayor_snapshot",
      "cs2_spatial", "cs2_city_overview", "cs2_budget", "cs2_mayor_execute_actions", "cs2_save_status", "cs2_saves"]
      .map((name) => ({ name: `cs2--${name}` })) }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      calls.push({ name, args });
      let payload: unknown = {};
      if (name === "cs2_game_state") payload = gameState();
      else if (name === "cs2_statistics") payload = { type: "Population", current: options.population };
      else if (name === "cs2_list_buildings") {
        const rows = [...homes, ...placed.map((item, index) => ({ entity: { index: 900 + index, version: 1 },
          prefab: item.prefab, position: { x: item.x, z: item.z } }))]
          .filter((row) => typeof args.query !== "string" || row.prefab.includes(String(args.query)));
        payload = { buildings: rows, returned: rows.length, totalMatches: rows.length, complete: true };
      } else if (name === "cs2_mayor_snapshot") {
        payload = { planningCatalog: { buildingPrefabs: { healthcare: ["MedicalClinic01"], education: ["ElementarySchool01"] } } };
      } else if (name === "cs2_spatial" && args.mode === "scan") {
        payload = {
          world: { min: -500, max: 500, size: 1000 },
          tiles: [{ entity: { index: 1, version: 1 }, owned: true, bounds: { min: { x: -500, z: -500 }, max: { x: 500, z: 500 } }, center: { x: 0, z: 0 }, polygon: [] }],
          outsideConnections: [], bootstrapAssets: [],
          roadGraph: { truncated: false,
            nodes: [{ entity: { index: 10, version: 1 }, position: { x: -60, y: 0, z: 0 }, native: false, outsideConnection: false, roadDegree: 1 },
              { entity: { index: 11, version: 1 }, position: { x: 60, y: 0, z: 0 }, native: false, outsideConnection: false, roadDegree: 1 }],
            edges: [{ entity: { index: 20, version: 1 }, prefab: "Medium Road", native: false, startNode: { index: 10, version: 1 },
              endNode: { index: 11, version: 1 }, start: { x: -60, z: 0 }, end: { x: 60, z: 0 }, length: 120 }] },
        };
      } else if (name === "cs2_spatial" && args.mode === "preflight") {
        preflights += 1;
        // The live bridge THROWS a 409 for an invalid object position rather than returning valid:false.
        if (preflights <= options.preflightValidAfter && options.preflightThrows) {
          throw new Error("operation blocked by game validation (overlap, water, steep terrain, protected entity...); try a different position or target");
        }
        payload = preflights > options.preflightValidAfter
          ? { valid: true, previewOnly: true, cost: 1000 }
          : { valid: false, previewOnly: true, reason: "OVERLAP" };
      } else if (name === "cs2_city_overview") payload = { treasury: options.treasury ?? 500_000, population: options.population };
      else if (name === "cs2_budget") payload = { balance: options.monthlyBalance ?? -1_000 };
      else if (name === "cs2_mayor_execute_actions") {
        if (refusalsLeft > 0) {
          refusalsLeft -= 1;
          throw new Error("operation blocked by game validation (overlap, water, steep terrain, protected entity...)");
        }
        const action = (args.actions as Array<{ prefab: string; x: number; z: number }>)[0]!;
        if (options.placementLands) placed.push({ prefab: action.prefab, x: action.x, z: action.z });
        payload = { ok: true, requested: 1, executed: 1, results: [{ index: 0, type: "place_building", ok: true }] };
      } else if (name === "cs2_save_status") payload = { status: "IDLE", state: "IDLE" };
      else if (name === "cs2_saves") payload = { saves: [] };
      return { structuredContent: payload };
    },
  };
  return { manager, calls, placed };
}

describe("civic service placement", () => {
  test("places the first owed service at the first legal site facing a street, journaled and read back", async () => {
    const tools = bridge({ population: 1_600, preflightValidAfter: 2, placementLands: true });
    const ports = createV2FoundationPorts({ getToolsManager: () => tools.manager as never, durableStateStorage: storageWithProject() });
    const outcome = await ports.civicServices!.provide();

    expect(outcome).toMatchObject({ status: "PLACED", kind: "healthcare", prefab: "MedicalClinic01", verdict: "MATCH" });
    expect(tools.placed).toHaveLength(1);
    // Native was asked to place only after the command was SUBMITTED in the journal.
    const command = ports.commandJournal.list().find((entry) => entry.authorizedScope.actionFamily === "UTILITY");
    expect(command?.authorizedScope).toMatchObject({ actionFamily: "UTILITY", utilityKind: "civic", placementScopeId: "civic:healthcare" });
    expect(command?.statusHistory.map((entry) => entry.status)).toEqual(
      expect.arrayContaining(["CREATED", "AUTHORIZED", "SUBMITTED", "NATIVE_COMPLETED"]));
    expect(command?.status).toBe("OBSERVED_MATCH");
    // Three preflights: two refused sites, then the legal one.
    expect(tools.calls.filter((call) => call.name === "cs2_spatial" && call.args.mode === "preflight")).toHaveLength(3);
  });

  test("a placement the world does not contain is reconciled as a proven absence, not a success", async () => {
    const tools = bridge({ population: 1_600, preflightValidAfter: 0, placementLands: false });
    const ports = createV2FoundationPorts({ getToolsManager: () => tools.manager as never, durableStateStorage: storageWithProject() });
    const outcome = await ports.civicServices!.provide();
    expect(outcome).toMatchObject({ status: "PLACED", verdict: "MISMATCH" });
    expect(ports.commandJournal.list().find((entry) => entry.authorizedScope.actionFamily === "UTILITY")?.status).toBe("OBSERVED_MISMATCH");
  });

  test("a site native refuses after a valid preflight is journaled REJECTED and the next site is tried", async () => {
    const tools = bridge({ population: 1_600, preflightValidAfter: 0, placementLands: true, nativeRefusals: 2 });
    const ports = createV2FoundationPorts({ getToolsManager: () => tools.manager as never, durableStateStorage: storageWithProject() });
    const outcome = await ports.civicServices!.provide();

    expect(outcome).toMatchObject({ status: "PLACED", kind: "healthcare", verdict: "MATCH" });
    const commands = ports.commandJournal.list().filter((entry) => entry.authorizedScope.actionFamily === "UTILITY");
    expect(commands.map((entry) => entry.status).sort()).toEqual(["OBSERVED_MATCH", "REJECTED", "REJECTED"]);
    expect(tools.placed).toHaveLength(1);
  });

  test("native refusing every site gives up for the cycle after a bounded number of attempts", async () => {
    const tools = bridge({ population: 1_600, preflightValidAfter: 0, placementLands: true, nativeRefusals: 99 });
    const ports = createV2FoundationPorts({ getToolsManager: () => tools.manager as never, durableStateStorage: storageWithProject() });
    const outcome = await ports.civicServices!.provide();
    expect(outcome.status).toBe("NO_PLACEMENT");
    expect(tools.calls.filter((call) => call.name === "cs2_mayor_execute_actions").length).toBeLessThanOrEqual(3 * 5);
    expect(tools.placed).toHaveLength(0);
  });

  test("an invalid position makes the preflight throw a 409; that refuses the site, it does not abort the call", async () => {
    const tools = bridge({ population: 1_600, preflightValidAfter: 3, placementLands: true, preflightThrows: true });
    const ports = createV2FoundationPorts({ getToolsManager: () => tools.manager as never, durableStateStorage: storageWithProject() });
    const outcome = await ports.civicServices!.provide();
    expect(outcome).toMatchObject({ status: "PLACED", kind: "healthcare", verdict: "MATCH" });
    expect(tools.calls.filter((call) => call.name === "cs2_spatial" && call.args.mode === "preflight")).toHaveLength(4);
  });

  test("a city that cannot carry more upkeep places nothing (runway 1.4 months, measured live)", async () => {
    const tools = bridge({ population: 1_600, preflightValidAfter: 0, placementLands: true, treasury: 169_688, monthlyBalance: -121_759 });
    const ports = createV2FoundationPorts({ getToolsManager: () => tools.manager as never, durableStateStorage: storageWithProject() });
    expect(await ports.civicServices!.provide()).toMatchObject({ status: "SKIPPED" });
    expect(tools.calls.some((call) => call.name === "cs2_mayor_execute_actions")).toBe(false);
  });

  test("a small town owes nothing and nothing is written", async () => {
    const tools = bridge({ population: 40, preflightValidAfter: 0, placementLands: true });
    const ports = createV2FoundationPorts({ getToolsManager: () => tools.manager as never, durableStateStorage: storageWithProject() });
    expect(await ports.civicServices!.provide()).toMatchObject({ status: "NOTHING_OWED" });
    expect(tools.calls.some((call) => call.name === "cs2_mayor_execute_actions")).toBe(false);
  });

  test("no legal site anywhere is reported by name and nothing is written", async () => {
    const tools = bridge({ population: 1_600, preflightValidAfter: 1_000, placementLands: true });
    const ports = createV2FoundationPorts({ getToolsManager: () => tools.manager as never, durableStateStorage: storageWithProject() });
    const outcome = await ports.civicServices!.provide();
    expect(outcome.status).toBe("NO_PLACEMENT");
    expect(JSON.stringify(outcome)).toContain("NO_LEGAL_SITE");
    expect(tools.calls.some((call) => call.name === "cs2_mayor_execute_actions")).toBe(false);
  });
});
