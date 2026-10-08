import { inspectDurableCleanElectricityBaseline, inspectUtilityConnectorResidue, selectCurrentGenerationElectricityConnector, selectCurrentGenerationFacility } from "../../src/main/services/ai-mayor/v2/durable-clean-baseline";

const state = (commandId: unknown, includeCommandId = true) => ({
  commands: [],
  projectState: { tranche: { utilityExecution: { utilities: { electricity: {
    candidateLedger: [{ kind: "direct-cable", ledgerState: "NOT_ATTEMPTED",
      ...(includeCommandId ? { commandId } : {}), primitiveEffect: "NOT_OBSERVED" }],
  } } } } },
});

test("commandId=null is a clean baseline", () => {
  expect(inspectDurableCleanElectricityBaseline(state(null))).toEqual({
    pass: true,
    diagnostics: { ledgerState: "NOT_ATTEMPTED", commandId: null, primitiveEffect: "NOT_OBSERVED", unresolvedCommands: 0 },
  });
});

test("non-null commandId fails the clean baseline", () => {
  const result = inspectDurableCleanElectricityBaseline(state("command-1"));
  expect(result.pass).toBe(false);
  expect(result.diagnostics.commandId).toBe("command-1");
});

test("connector-local empty topology is clean", () => {
  expect(inspectUtilityConnectorResidue({
    type: "electricity", node: { index: 328132, version: 9 }, attached: false, orphan: true, connectedEdges: [],
  }, "generation-1")).toMatchObject({ status: "CLEAN", diagnostics: { generation: "generation-1" } });
});

test("connector-local cable residue blocks clean baseline", () => {
  expect(inspectUtilityConnectorResidue({
    type: "electricity", node: { index: 328132, version: 9 }, attached: true, orphan: true,
    connectedEdges: [{ entity: { index: 322708, version: 23 }, prefab: "Low-voltage Ground Cable" }],
  }, "generation-1")).toMatchObject({ status: "RESIDUE", diagnostics: { attached: true } });
});

test("missing connector topology fails closed", () => {
  expect(inspectUtilityConnectorResidue({ type: "electricity", attached: false, orphan: true }, "generation-1").status).toBe("UNKNOWN");
});

test("missing or invalid commandId fails with UNKNOWN diagnostics", () => {
  expect(inspectDurableCleanElectricityBaseline(state(undefined, false)).diagnostics.commandId).toBe("UNKNOWN");
  expect(inspectDurableCleanElectricityBaseline(state(42)).diagnostics.commandId).toBe("UNKNOWN");
  expect(inspectDurableCleanElectricityBaseline(state(undefined, false)).pass).toBe(false);
});

test("rebinds a stale durable connector through a unique current-generation facility", () => {
  const facility = selectCurrentGenerationFacility({
    buildings: [{ prefab: "WindTurbine03", entity: { index: 900, version: 2 }, position: { x: 10, z: 20 } }],
    prefab: "WindTurbine03", position: { x: 10, z: 20 },
  });
  expect(facility.status).toBe("MATCH");
  if (facility.status !== "MATCH") return;
  const connector = selectCurrentGenerationElectricityConnector({
    connectors: [{ type: "electricity", node: { index: 901, version: 3 }, worldPosition: { x: 10, z: 20 }, attached: false, orphan: true, connectedEdges: [] }],
    facilityPosition: facility.facility.position,
  });
  expect(connector.status).toBe("MATCH");
  if (connector.status !== "MATCH") return;
  expect(connector.connector.node).toEqual({ index: 901, version: 3 });
  expect(inspectUtilityConnectorResidue(connector.connector, "generation-2").status).toBe("CLEAN");
});

test("current connector rebinding fails closed for zero and multiple matches", () => {
  expect(selectCurrentGenerationElectricityConnector({ connectors: [], facilityPosition: { x: 0, z: 0 } }).status)
    .toBe("CURRENT_CONNECTOR_NOT_FOUND");
  expect(selectCurrentGenerationElectricityConnector({
    connectors: [
      { type: "electricity", node: { index: 1, version: 1 }, worldPosition: { x: 0, z: 0 } },
      { type: "electricity", node: { index: 2, version: 1 }, worldPosition: { x: 0, z: 0 } },
    ], facilityPosition: { x: 0, z: 0 },
  }).status).toBe("CURRENT_CONNECTOR_AMBIGUOUS");
});

test("facility rebinding never falls back to the durable entity", () => {
  const result = selectCurrentGenerationFacility({
    buildings: [{ prefab: "WindTurbine03", entity: { index: 901, version: 1 }, position: { x: 100, z: 100 } }],
    prefab: "WindTurbine03", position: { x: 0, z: 0 },
  });
  expect(result.status).toBe("CURRENT_CONNECTOR_NOT_FOUND");
});
