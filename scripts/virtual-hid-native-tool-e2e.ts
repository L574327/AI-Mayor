import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";
import { sendVirtualHidMouseClick } from "../src/main/services/ai-mayor/v2/virtual-hid-mouse-adapter";

const record = (value: unknown): Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, any> : {};

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const category = process.env.CS2_E2E_PREFAB_CATEGORY ?? "building";
const prefab = process.env.CS2_E2E_PREFAB ?? "WindTurbine03";
const targetX = Number(process.env.CS2_E2E_TARGET_X ?? "1100");
const targetY = Number(process.env.CS2_E2E_TARGET_Y ?? "550");

function finiteScreenCoordinate(value: number, field: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function moveSteps(current: Record<string, any>): Array<{ deltaX: number; deltaY: number }> {
  const position = record(current.inputManagerMousePosition);
  let x = Math.round(Number(position.x));
  let y = Math.round(Number(position.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("NATIVE_TOOL_MOUSE_POSITION_UNAVAILABLE");

  const steps: Array<{ deltaX: number; deltaY: number }> = [];
  while (x !== targetX || y !== targetY) {
    const deltaX = Math.max(-127, Math.min(127, targetX - x));
    const deltaY = Math.max(-127, Math.min(127, targetY - y));
    if (deltaX === 0 && deltaY === 0) throw new Error("NATIVE_TOOL_TARGET_MOVE_STALLED");
    steps.push({ deltaX, deltaY });
    x += deltaX;
    y += deltaY;
  }
  return steps;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const startedAt = new Date().toISOString();
  finiteScreenCoordinate(targetX, "CS2_E2E_TARGET_X");
  finiteScreenCoordinate(targetY, "CS2_E2E_TARGET_Y");
  const client = new Client({ name: "5ire-ai-mayor-v2-virtual-hid-e2e", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    parseV2McpJson(await client.callTool({ name, arguments: args }));
  const listed = await client.listTools();
  const required = ["cs2_native_tool_arm", "cs2_native_tool_observe", "cs2_list_buildings"];
  const missing = required.filter((name) => !listed.tools.some((tool) => tool.name === name));
  if (missing.length > 0) throw new Error(`E2E_REQUIRED_TOOLS_MISSING:${missing.join(",")}`);

  const before = record(await call("cs2_list_buildings", { query: prefab, limit: 500 }));
  const arm = record(await call("cs2_native_tool_arm", { category, prefab }));
  if (arm.status !== "NATIVE_TOOL_READY") throw new Error(`NATIVE_TOOL_ARM_FAILED:${JSON.stringify(arm)}`);
  const leaseId = typeof arm.leaseId === "string" ? arm.leaseId : null;
  if (!leaseId) throw new Error(`NATIVE_TOOL_LEASE_MISSING:${JSON.stringify(arm)}`);
  let armed: Record<string, any> = {};
  let move: unknown[] = [];
  let placementReady: Record<string, any> = {};
  let click: unknown = null;
  let after: Record<string, any> = {};
  let observed: Record<string, any> = {};
  try {
    armed = record(await call("cs2_native_tool_observe"));
    const steps = moveSteps(armed);
    for (const step of steps) {
      move.push(await sendVirtualHidMouseClick({ ...step, click: false }));
    }
    await delay(250);
    placementReady = record(await call("cs2_native_tool_observe"));
    if (placementReady.activeTool !== "Game.Tools.ObjectToolSystem" || placementReady.activePrefab !== prefab) {
      throw new Error(`NATIVE_TOOL_PLACEMENT_NOT_READY:${JSON.stringify(placementReady)}`);
    }
    click = await sendVirtualHidMouseClick({ click: true });
    after = record(await call("cs2_list_buildings", { query: prefab, limit: 500 }));
    observed = record(await call("cs2_native_tool_observe"));
  } finally {
    await call("cs2_native_tool_release", { leaseId });
  }
  const beforeCount = Array.isArray(before.buildings) ? before.buildings.length : Number(before.totalMatches ?? -1);
  const afterCount = Array.isArray(after.buildings) ? after.buildings.length : Number(after.totalMatches ?? -1);
  const effectObserved = beforeCount >= 0 && afterCount > beforeCount;
  const report = {
    schemaVersion: "ai-mayor-v2-virtual-hid-native-tool-e2e/1",
    status: effectObserved ? "PASS" : "FAILED_EFFECT_OBSERVATION",
    startedAt,
    completedAt: new Date().toISOString(),
    aiCommand: { type: "place_building_via_native_tool", category, prefab, targetX, targetY },
    pipeline: ["AI_COMMAND", "NATIVE_TOOL_ARM", "VIRTUAL_HID_CLICK", "CS2_READBACK"],
    nativeToolArm: arm,
    nativeToolArmedObservation: armed,
    virtualHidMove: move,
    nativeToolPlacementObservation: placementReady,
    virtualHidClick: click,
    before: { count: beforeCount, payload: before },
    after: { count: afterCount, payload: after },
    nativeToolAfterObservation: observed,
    effectObserved,
    evidenceRule: "PASS requires exact prefab building count to increase after the HID click",
  };
  const evidenceDir = path.join(process.cwd(), "docs/ai-mayor/evidence");
  await fs.mkdir(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, `virtual-hid-native-tool-e2e-${Date.now()}.json`);
  await fs.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report, evidencePath }, null, 2)}\n`);
  await client.close();
  if (!effectObserved) process.exitCode = 2;
}

if (process.argv[1]?.endsWith("virtual-hid-native-tool-e2e.ts")) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
