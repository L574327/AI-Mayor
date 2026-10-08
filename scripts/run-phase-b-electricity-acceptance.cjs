const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function inspectParent(requestedParent, cwd = process.cwd()) {
  if (typeof requestedParent !== "string" || requestedParent.trim().length === 0) {
    throw new Error("PHASE_B_PARENT_DURABLE_STATE_REQUIRED");
  }
  const resolvedParent = path.resolve(cwd, requestedParent);
  if (!fs.existsSync(resolvedParent) || !fs.statSync(resolvedParent).isFile()) {
    throw new Error(`PHASE_B_PARENT_DURABLE_STATE_NOT_FOUND:${resolvedParent}`);
  }
  const state = JSON.parse(fs.readFileSync(resolvedParent, "utf8"));
  const commands = Array.isArray(state.commands) ? state.commands : [];
  const unresolvedCommands = commands.filter((entry) => ["SUBMITTED", "UNKNOWN"].includes(String(entry?.outcome))).length;
  const checkpoints = Array.isArray(state.checkpoints) ? state.checkpoints : [];
  return {
    requestedParent,
    resolvedParent,
    parentExists: true,
    parentCheckpoint: state.active?.loadedCheckpointId ?? checkpoints.at(-1)?.checkpointId ?? null,
    parentJournalPosition: state.journalPosition ?? null,
    parentUnresolvedCommands: unresolvedCommands,
  };
}

function buildRunnerEnv(parent, evidenceDir, sourceEnv = process.env) {
  const env = {
    ...sourceEnv,
    AI_MAYOR_V2_PHASE_B_ELECTRICITY_ONLY: "1",
    AI_MAYOR_V2_DIRECT_CABLE_ONLY: "1",
    AI_MAYOR_EVIDENCE_DIR: evidenceDir,
    AI_MAYOR_PARENT_DURABLE_STATE_FILE: parent.resolvedParent,
  };
  delete env.AI_MAYOR_V2_PHASE_A_ONLY;
  return env;
}

function readChildReport(evidenceDir) {
  if (!fs.existsSync(evidenceDir)) return null;
  const files = fs.readdirSync(evidenceDir).filter((name) => name.startsWith("run-") && name.endsWith(".json")).sort();
  if (files.length === 0) return null;
  return JSON.parse(fs.readFileSync(path.join(evidenceDir, files.at(-1)), "utf8"));
}

function main() {
  const parent = inspectParent(process.env.AI_MAYOR_PARENT_DURABLE_STATE_FILE);
  const runId = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${crypto.randomBytes(4).toString("hex")}`;
  const evidenceDir = path.join(process.cwd(), "docs", "ai-mayor", "evidence", `phase-b-electricity-${runId}`);
  const env = buildRunnerEnv(parent, evidenceDir);
  process.stdout.write(`${JSON.stringify({ phaseBParentProvenance: parent, evidenceDir })}\n`);
  const result = spawnSync(process.execPath, [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "scripts/local-v2-gate1-battlefield.ts"], { cwd: process.cwd(), env, stdio: "inherit" });
  const childReport = readChildReport(evidenceDir);
  if (childReport && childReport.actualParentDurableStateFile !== parent.resolvedParent) {
    process.stderr.write(`PHASE_B_PARENT_PROVENANCE_MISMATCH:${JSON.stringify({ expected: parent.resolvedParent, actual: childReport.actualParentDurableStateFile ?? null })}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); }
}

module.exports = { inspectParent, buildRunnerEnv, readChildReport };
