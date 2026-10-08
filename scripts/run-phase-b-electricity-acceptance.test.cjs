const assert = require("node:assert/strict");
const path = require("node:path");
const { inspectParent, buildRunnerEnv } = require("./run-phase-b-electricity-acceptance.cjs");

const parentPath = path.resolve(__dirname, "../docs/ai-mayor/evidence/phase-b-electricity-387b5af2-20260916-run8b/v2-durable-state.json");
assert.throws(() => inspectParent(undefined), /PHASE_B_PARENT_DURABLE_STATE_REQUIRED/);
const parent = inspectParent(parentPath);
assert.equal(parent.resolvedParent, parentPath);
assert.equal(parent.parentExists, true);
assert.equal(parent.parentJournalPosition, 3);
assert.equal(parent.parentUnresolvedCommands, 0);
const env = buildRunnerEnv(parent, "C:\\tmp\\phase-b-child", { ESBUILD_WORKER_THREADS: "0", PRESERVE_THIS: "yes" });
assert.equal(env.AI_MAYOR_PARENT_DURABLE_STATE_FILE, parentPath);
assert.equal(env.ESBUILD_WORKER_THREADS, "0");
assert.equal(env.PRESERVE_THIS, "yes");
assert.equal(env.AI_MAYOR_V2_PHASE_B_ELECTRICITY_ONLY, "1");
assert.equal(env.AI_MAYOR_V2_PHASE_A_ONLY, undefined);
console.log("run-phase-b-electricity-acceptance wiring tests PASS");
