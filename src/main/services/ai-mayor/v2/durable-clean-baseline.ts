type RecordValue = Record<string, unknown>;

const record = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : {};

export interface DurableCleanBaselineDiagnostics {
  ledgerState: string;
  commandId: string | null | "UNKNOWN";
  primitiveEffect: string;
  unresolvedCommands: number | "UNKNOWN";
}

export interface DurableCleanBaselineResult {
  pass: boolean;
  diagnostics: DurableCleanBaselineDiagnostics;
}

export interface UtilityConnectorResidueDiagnostics {
  connector: unknown;
  attached: boolean | "UNKNOWN";
  orphan: boolean | "UNKNOWN";
  connectedEdges: unknown[];
  prefab: string;
  type: string;
  generation: string;
}

export function selectCurrentGenerationFacility(input: {
  buildings: unknown[];
  prefab: string;
  position: { x: number; z: number };
  radius?: number;
}): { status: "MATCH"; facility: { entity: { index: number; version: number }; prefab: string; position: { x: number; z: number } }; evidence: RecordValue } | { status: "CURRENT_CONNECTOR_NOT_FOUND" | "CURRENT_CONNECTOR_AMBIGUOUS"; evidence: RecordValue } {
  const radius = input.radius ?? 96;
  const candidates = input.buildings.map(record).filter((building) => {
    const entity = record(building.entity);
    const position = record(building.position);
    return building.prefab === input.prefab && building.isSubBuilding !== true &&
      Number.isInteger(Number(entity.index)) && Number.isInteger(Number(entity.version)) &&
      Number.isFinite(Number(position.x)) && Number.isFinite(Number(position.z)) &&
      Math.hypot(Number(position.x) - input.position.x, Number(position.z) - input.position.z) <= radius;
  });
  const evidence = { kind: "WindTurbineElectricityFacility", candidateCount: candidates.length, prefab: input.prefab, anchor: input.position, radius };
  if (candidates.length === 0) return { status: "CURRENT_CONNECTOR_NOT_FOUND", evidence };
  if (candidates.length > 1) return { status: "CURRENT_CONNECTOR_AMBIGUOUS", evidence };
  const candidate = candidates[0];
  const entity = record(candidate.entity); const position = record(candidate.position);
  return {
    status: "MATCH",
    facility: { entity: { index: Number(entity.index), version: Number(entity.version) }, prefab: String(candidate.prefab), position: { x: Number(position.x), z: Number(position.z) } },
    evidence: { ...evidence, selectedFacility: entity },
  };
}

export function selectCurrentGenerationElectricityConnector(input: {
  connectors: unknown[];
  facilityPosition: { x: number; z: number };
}): { status: "MATCH"; connector: RecordValue; evidence: RecordValue } | { status: "CURRENT_CONNECTOR_NOT_FOUND" | "CURRENT_CONNECTOR_AMBIGUOUS"; evidence: RecordValue } {
  const candidates = input.connectors.map(record).filter((connector) => {
    const position = record(connector.worldPosition);
    return connector.type === "electricity" && Number.isFinite(Number(position.x)) && Number.isFinite(Number(position.z)) &&
      Math.hypot(Number(position.x) - input.facilityPosition.x, Number(position.z) - input.facilityPosition.z) <= 2;
  });
  const evidence = { kind: "ElectricityConnector", candidateCount: candidates.length, facilityPosition: input.facilityPosition, radius: 2 };
  if (candidates.length === 0) return { status: "CURRENT_CONNECTOR_NOT_FOUND", evidence };
  if (candidates.length > 1) return { status: "CURRENT_CONNECTOR_AMBIGUOUS", evidence };
  return { status: "MATCH", connector: candidates[0], evidence: { ...evidence, selectedNode: record(candidates[0].node) } };
}

export function inspectUtilityConnectorResidue(value: unknown, generation: string): {
  status: "CLEAN" | "RESIDUE" | "UNKNOWN";
  diagnostics: UtilityConnectorResidueDiagnostics;
} {
  const connector = record(value);
  const node = record(connector.node);
  const edges = Array.isArray(connector.connectedEdges)
    ? connector.connectedEdges.slice(0, 16)
    : undefined;
  const attached = typeof connector.attached === "boolean" ? connector.attached : "UNKNOWN";
  const orphan = typeof connector.orphan === "boolean" ? connector.orphan : "UNKNOWN";
  const type = typeof connector.type === "string" ? connector.type : "UNKNOWN";
  const prefab = typeof connector.prefab === "string" ? connector.prefab : "UNKNOWN";
  const diagnostics: UtilityConnectorResidueDiagnostics = {
    connector: Object.keys(node).length > 0 ? node : connector.entity ?? "UNKNOWN",
    attached,
    orphan,
    connectedEdges: edges ?? [],
    prefab,
    type,
    generation,
  };
  // `orphan` is recorded as a diagnostic only, matching matchConnectionObjective:
  // a building's utility connector node is normally orphaned in the engine's own
  // building graph, so it cannot decide CLEAN/RESIDUE either way.
  if (!edges || attached === "UNKNOWN") return { status: "UNKNOWN", diagnostics };
  const hasUtilityEdge = edges.some((edge) => {
    const item = record(edge);
    const edgePrefab = String(item.prefab ?? item.type ?? "").toLowerCase();
    return edgePrefab.includes("low-voltage") || edgePrefab.includes("electric") || edgePrefab.includes("utility") ||
      item.utility !== undefined || item.networkType !== undefined;
  });
  return { status: edges.length === 0 && attached === false && !hasUtilityEdge ? "CLEAN" : "RESIDUE", diagnostics };
}

export function inspectDurableCleanElectricityBaseline(value: unknown): DurableCleanBaselineResult {
  const root = record(value);
  const project = record(root.projectState);
  const electricity = record(record(record(project.tranche).utilityExecution).utilities).electricity;
  const electricityState = record(electricity);
  const candidates = Array.isArray(electricityState.candidateLedger) ? electricityState.candidateLedger : [];
  const directCable = candidates.map(record).find((candidate) => candidate.kind === "direct-cable");
  const ledgerState = typeof directCable?.ledgerState === "string" ? directCable.ledgerState : "UNKNOWN";
  const primitiveEffect = typeof directCable?.primitiveEffect === "string" ? directCable.primitiveEffect : "UNKNOWN";
  const hasCommandId = directCable !== undefined && Object.prototype.hasOwnProperty.call(directCable, "commandId");
  const commandId = hasCommandId && (directCable?.commandId === null || typeof directCable?.commandId === "string")
    ? directCable.commandId as string | null
    : "UNKNOWN";
  const commands = root.commands;
  const unresolvedCommands = Array.isArray(commands)
    ? commands.map(record).filter((entry) => ["SUBMITTED", "UNKNOWN"].includes(String(entry.outcome))).length
    : "UNKNOWN";
  const pass = ledgerState === "NOT_ATTEMPTED" && commandId === null &&
    primitiveEffect === "NOT_OBSERVED" && unresolvedCommands === 0;
  return { pass, diagnostics: { ledgerState, commandId, primitiveEffect, unresolvedCommands } };
}
