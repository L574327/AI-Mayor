/**
 * The formal production descendant recovery, against the LIVE durable store.
 *
 * `activateDurableWorld()` is the production seam and the only thing that may
 * confirm a descendant reload. It performs, in order:
 *
 *   activate()                          -> DESCENDANT_SAVE_RELOAD, quarantined
 *   observeCommandEffectInCurrentWorld() x every pending command
 *   confirmDescendantSaveReload()       -> every command EFFECT_PRESENT
 *   certifyDescendantCheckpoint()       -> adopts the user's save as the boundary
 *   activate()                          -> SAME_WORLD_RECONNECT, ACTIVATED
 *
 * The Mayor drives no save: the boundary is the save the user made, read from
 * the Bridge's own catalogue. Native calls are READS; the call log is asserted
 * for that at the end.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCanonicalDurableStateStorage } from "../src/main/services/ai-mayor/v2/durable-storage";
import { certifyDeliveredRoad } from "../src/main/services/ai-mayor/v2/certified-road-delivery";
import { createV2FoundationPorts, parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const appData = process.env.APPDATA ?? "";
const liveStorePath = path.join(appData, "5ire", "ai-mayor-v2.json");
const evidencePath = process.env.WATER_DESCENDANT_EVIDENCE ?? "docs/ai-mayor/evidence/water-descendant-recovery-live-2026-09-23.json";

/** Tools that would take the world past this round's mandate. */
const FORBIDDEN_TOOLS = new Set([
  "cs2_save_game", "cs2_build_road", "cs2_mayor_execute_actions", "cs2_run_simulation",
  "cs2_bulldoze", "cs2_build", "cs2_zone", "cs2_place_building", "cs2_demolish",
]);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const sha256 = (file: string): string | null => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
};

const step = (message: string) => process.stderr.write(`[descendant-recover] ${message}\n`);

async function main() {
  if (!appData) throw new Error("APPDATA is not set");
  const report: Record<string, unknown> = {
    mode: "LIVE_PRODUCTION_DESCENDANT_RECOVERY",
    liveStorePath,
    liveStoreSha256Before: sha256(liveStorePath),
  };

  const client = new Client({ name: "5ire-ai-mayor-descendant-recover-live", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));
  step("mcp connected");

  const calls: string[] = [];
  const manager = {
    legacyList: async () => ({ tools: (await client.listTools()).tools.map((tool) => ({ name: `live--${tool.name}` })) }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      calls.push(name);
      if (FORBIDDEN_TOOLS.has(name)) throw new Error(`FORBIDDEN_TOOL_CALLED:${name}`);
      return { content: [{ type: "text", text: JSON.stringify(parseV2McpJson(await client.callTool({ name, arguments: args }))) }] };
    },
  };

  try {
    const storage = createCanonicalDurableStateStorage(appData);
    const foundation = createV2FoundationPorts({ getToolsManager: () => manager as never, durableStateStorage: storage });
    const durability = foundation.durability;
    if (!durability) throw new Error("V2_PRODUCTION_DURABILITY_NOT_CONFIGURED");
    if (!foundation.activateDurableWorld) throw new Error("V2_PRODUCTION_ACTIVATE_WORLD_NOT_CONFIGURED");
    report.storageNamespace = storage.namespaceId ?? null;

    const before = durability.snapshot();
    report.before = {
      journalPosition: before.journalPosition,
      commands: before.commands.length,
      checkpoints: before.checkpoints.length,
      projectStateSchema: before.projectState?.schemaVersion ?? null,
      baselineActivation: before.baselineActivation ?? null,
    };

    // How the loaded world is classified, read before the seam runs. This is
    // exactly the first step `activateDurableWorld()` itself performs, so it
    // repeats an idempotent read rather than adding a state transition — and it
    // is the only place the classification is visible, because the seam returns
    // the activation it reached *after* confirming the lineage.
    const gameState = parseV2McpJson(await client.callTool({ name: "cs2_game_state", arguments: {} }));
    calls.push("cs2_game_state");
    const classified = durability.activate(gameState);
    report.classification = {
      kind: classified.kind,
      status: classified.status,
      blockedReason: classified.blockedReason,
    };

    const activation = await foundation.activateDurableWorld();
    report.activation = {
      kind: activation.kind,
      status: activation.status,
      blockedReason: activation.blockedReason,
      worldId: activation.world.worldId,
      generation: activation.world.generation,
      nativeSessionGuid: activation.world.nativeSessionGuid,
    };
    const durablyActivated = durability.isExecutionDurablyActivated(activation);
    const after = durability.snapshot();
    const state = after.projectState as unknown as {
      intent: { id: string };
      project: { id: string; status: string; maximumBudget: number; utilityReservation: { center: { x: number; z: number }; radius: number } };
      tranche: {
        id: string;
        stage: string;
        utilityExecution?: {
          scope?: { maximumSpend?: number };
          utilities?: Record<string, { stage?: string; facility?: { entity?: unknown }; connector?: { node?: unknown }; networkCommandIds?: unknown[]; candidateLedger?: Array<{ kind: string; ledgerState: string }> }>;
        } | null;
      };
    };
    const water = state.tranche?.utilityExecution?.utilities?.water;

    report.after = {
      journalPosition: after.journalPosition,
      commands: after.commands.length,
      checkpoints: after.checkpoints.map((checkpoint) => ({
        checkpointId: checkpoint.checkpointId,
        durable: checkpoint.durable,
        journalPosition: checkpoint.journalPosition,
        purpose: checkpoint.purpose ?? null,
      })),
      baselineActivation: after.baselineActivation ?? null,
      active: after.active ?? null,
      projectAuthority: after.projectAuthority
        ? { status: after.projectAuthority.status, inheritedJournalPosition: after.projectAuthority.inheritedJournalPosition }
        : null,
      descendantConfirmation: after.descendantConfirmation
        ? {
            inheritedJournalPosition: after.descendantConfirmation.inheritedJournalPosition,
            confirmedAt: after.descendantConfirmation.confirmedAt,
            effects: after.descendantConfirmation.effects,
          }
        : null,
    };

    const verdict: Record<string, unknown> = {
      DESCENDANT_SAVE_RELOAD_RECOGNIZED: classified.kind === "DESCENDANT_SAVE_RELOAD" ? "YES" : "NO",
      DESCENDANT_CONFIRMATION_REQUIRED: classified.status === "DESCENDANT_CONFIRMATION_REQUIRED" ? "YES" : "NO",
      AUTHORITATIVE_WORLD_CONFIRMATION: durablyActivated ? "PASS" : "FAIL",
      INHERITED_ACTIONS_QUARANTINED: activation.blockedReason === null ? "NO" : "YES",
      DURABLY_ACTIVATED: durablyActivated ? "YES" : "NO",
      FORCED_SAVE_COUNT: calls.filter((name) => name === "cs2_save_game").length,
      NATIVE_MUTATION_COUNT: calls.filter((name) => FORBIDDEN_TOOLS.has(name)).length,
    };

    if (state.intent && state.tranche) {
      verdict.WATER_PROJECT_AUTHORITY_RESTORED = "YES";
      verdict.WATER_TRANCHE_STAGE = state.tranche.stage;
      verdict.WATER_SLICE_STAGE = water?.stage ?? null;
      verdict.WATER_FACILITY_RECORDED = water?.facility?.entity ?? null;
      verdict.WATER_CONNECTOR_RECORDED = water?.connector?.node ?? null;
      verdict.WATER_NETWORK_COMMAND_IDS = water?.networkCommandIds?.length ?? 0;
      verdict.WATER_SCOPE_MAXIMUM_SPEND = state.tranche.utilityExecution?.scope?.maximumSpend ?? null;
      report.project = {
        intentId: state.intent.id,
        projectId: state.project.id,
        status: state.project.status,
        maximumBudget: state.project.maximumBudget,
        utilityReservation: state.project.utilityReservation,
        trancheId: state.tranche.id,
        stage: state.tranche.stage,
        water: {
          stage: water?.stage ?? null,
          facility: water?.facility?.entity ?? null,
          connector: water?.connector?.node ?? null,
          networkCommandIds: water?.networkCommandIds ?? [],
          ledger: water?.candidateLedger ?? [],
        },
      };
      const delivered = certifyDeliveredRoad({ state: after.projectState as never, world: activation.world, journal: durability.commandJournal });
      verdict.CERTIFIED_ROAD = delivered.status;
      report.certifiedRoad = delivered.status === "CERTIFIED"
        ? { target: delivered.target, refs: delivered.refs, lineage: delivered.lineage, observedWorldGeneration: delivered.observedWorldGeneration }
        : { reason: delivered.reason };
    } else {
      verdict.WATER_PROJECT_AUTHORITY_RESTORED = "NO";
      verdict.PROJECT_STATE_SCHEMA = after.projectState?.schemaVersion ?? null;
    }

    report.lineagePerCommand = durability.commandJournal.list().map((command) => {
      const lineage = durability.commandJournal.durableLineage(command.commandId);
      return {
        actionFamily: command.actionFamily,
        actionType: command.actionType,
        commandId: command.commandId,
        status: command.status,
        proof: lineage?.proof ?? null,
      };
    });

    report.verdict = verdict;
    report.liveStoreSha256After = sha256(liveStorePath);
    await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
    await fs.promises.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ verdict, activation: report.activation, project: report.project, certifiedRoad: report.certifiedRoad }, null, 2)}\n`);
    step(`evidence written to ${evidencePath}`);
  } catch (error) {
    report.error = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    process.exitCode = 1;
  } finally {
    report.nativeMutationCalls = calls.filter((name) => FORBIDDEN_TOOLS.has(name));
    report.callLog = calls;
    if (report.error !== undefined) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await client.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
