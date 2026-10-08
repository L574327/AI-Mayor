import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFileUsageMeter } from "../../src/main/services/ai-mayor/host/ai-usage";
import { sendPrompt, setUsageMeter } from "../../src/main/services/ai-mayor/host/ai-providers";

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), "mayor-usage-"));
const reply = (body: unknown) => (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;

describe("token use and the daily cap", () => {
  afterEach(() => setUsageMeter(null));

  test("calls are counted by the service's own figure and held to the cap; the next local day starts at zero", () => {
    let day = new Date(2026, 9, 7, 10, 0, 0);
    const meter = createFileUsageMeter({ file: path.join(folder(), "usage.json"), limit: () => 1000, now: () => day });
    expect(meter.check()).toEqual({ ok: true });
    meter.record(600);
    expect(meter.snapshot()).toMatchObject({ tokens: 600, calls: 1, limit: 1000 });
    meter.record(450);
    const refused = meter.check();
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.detail).toMatch(/1050 of 1000 tokens.*local reader still works/);
    day = new Date(2026, 9, 8, 0, 5, 0);
    expect(meter.check()).toEqual({ ok: true });
    expect(meter.snapshot()).toMatchObject({ tokens: 0, calls: 0 });
  });

  test("0 means no cap, and the count survives a restart (it lives in a file)", () => {
    const file = path.join(folder(), "usage.json");
    const first = createFileUsageMeter({ file, limit: () => 0 });
    first.record(5_000_000);
    expect(first.check()).toEqual({ ok: true });
    expect(createFileUsageMeter({ file, limit: () => 0 }).snapshot().tokens).toBe(5_000_000);
  });

  test("a call to the AI service is counted (its own token figure, else an estimate) and refused past the cap without reaching the network", async () => {
    const meter = createFileUsageMeter({ file: path.join(folder(), "usage.json"), limit: () => 300 });
    setUsageMeter(meter);
    const config = { preset: "deepseek" as const, baseUrl: "", apiKey: "sk-test", model: "" };
    const openai = reply({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 180 } });
    expect((await sendPrompt(config, "hello", openai)).ok).toBe(true);
    expect(meter.snapshot().tokens).toBe(180);
    const claude = reply({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 90, output_tokens: 50 } });
    expect((await sendPrompt({ ...config, preset: "claude" }, "hello", claude)).ok).toBe(true);
    expect(meter.snapshot().tokens).toBe(320);
    let reached = false;
    const spy = (async () => { reached = true; return { ok: true, status: 200, json: async () => ({}) }; }) as unknown as typeof fetch;
    const blocked = await sendPrompt(config, "hello", spy);
    expect(blocked.ok).toBe(false);
    expect(blocked.detail).toMatch(/daily AI limit reached/);
    expect(reached).toBe(false);
    // No usage figure in the answer: about three characters a token.
    setUsageMeter(createFileUsageMeter({ file: path.join(folder(), "u2.json"), limit: () => 0 }));
    const plain = reply({ choices: [{ message: { content: "123456789" } }] });
    await sendPrompt(config, "123456", plain);
    expect(createFileUsageMeter({ file: path.join(folder(), "x.json"), limit: () => 0 }).snapshot().tokens).toBe(0);
  });
});