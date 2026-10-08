import { buildPrompt, checkReply, interpretViaApi, newRequestCode } from "../../src/main/services/ai-mayor/host/semantic-frontend";

describe("semantic frontend", () => {
  it("makes a short, look-alike-free code and an English prompt that carries the player's words and the code", () => {
    const code = newRequestCode(() => 0.5);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    const prompt = buildPrompt("扩建高密度住宅，不要买地", code);
    expect(prompt).toContain(`MAYOR-${code}`);
    expect(prompt).toContain("REQUEST: 扩建高密度住宅，不要买地");
    // Short enough to paste anywhere; it grew with the city-problem vocabulary (RESOLVE_ISSUES), still under 1,400.
    // The filter is a full translation guide (vocabulary, icon words, rules, examples): still well inside one paste and one cheap call.
    expect(prompt.length).toBeLessThan(8000);
  });

  it("accepts the line for THIS request, around chatty text or code fences", () => {
    const reply = 'Sure!\n```\nMAYOR-K7QP {"type":"EXPAND_RESIDENTIAL","scope":{"density":"HIGH","acquireLand":false},"priority":"NORMAL"}\n```';
    expect(checkReply(reply, "K7QP")).toMatchObject({ ok: true, intent: { kind: "GOAL", type: "EXPAND_RESIDENTIAL", priority: "NORMAL", scope: { density: "HIGH" } } });
  });

  it("reads the instruction subset: a goal with forbids, districts to keep and what cannot be expressed", () => {
    const reply = 'MAYOR-K7QP {"goal":{"type":"IMPROVE_TRAFFIC","priority":"HIGH"},"forbid":["demolition","land_purchase"],"preserve":["老城区"],"unsupported":["subway"]}';
    expect(checkReply(reply, "K7QP")).toEqual({ ok: true, summary: expect.anything(), intent: { kind: "GOAL", type: "IMPROVE_TRAFFIC", priority: "HIGH" },
      instruction: { goal: { kind: "GOAL", type: "IMPROVE_TRAFFIC", priority: "HIGH" }, forbid: ["demolition", "land_purchase"], preserve: ["老城区"], unsupported: ["subway"] } });
    // A pure limit with no goal is a valid instruction too.
    expect(checkReply('MAYOR-K7QP {"goal":null,"forbid":[],"preserve":["East Bank"]}', "K7QP")).toMatchObject({ ok: true, intent: null, instruction: { preserve: ["East Bank"] } });
    // Anything outside the subset is refused, not dropped silently.
    expect(checkReply('MAYOR-K7QP {"goal":null,"forbid":["everything"]}', "K7QP")).toMatchObject({ ok: false, error: "INVALID" });
  });

  it("refuses a paste that is not the answer to this request", () => {
    expect(checkReply("hello world", "K7QP")).toMatchObject({ ok: false, error: "NO_CODE" });
    expect(checkReply('MAYOR-ZZZZ {"type":"GROW_POPULATION"}', "K7QP")).toMatchObject({ ok: false, error: "WRONG_CODE" });
    expect(checkReply("MAYOR-K7QP {type: grow}", "K7QP")).toMatchObject({ ok: false, error: "NOT_JSON" });
  });

  it("refuses anything outside the vocabulary, and a service without its kind", () => {
    expect(checkReply('MAYOR-K7QP {"type":"DEMOLISH_EVERYTHING"}', "K7QP")).toMatchObject({ ok: false, error: "INVALID" });
    expect(checkReply('MAYOR-K7QP {"type":"PROVIDE_SERVICE"}', "K7QP")).toMatchObject({ ok: false, error: "INVALID" });
    expect(checkReply('MAYOR-K7QP {"type":"GROW_POPULATION","scope":{"serviceKind":"WATER"}}', "K7QP")).toMatchObject({ ok: false, error: "INVALID" });
    // Never a flat refusal: nothing actionable means the Mayor looks after the city and says what it left out.
    expect(checkReply('MAYOR-K7QP {"type":"UNSUPPORTED","reason":"metro lines"}', "K7QP")).toMatchObject({ ok: true, instruction: { fallback: true, unsupported: ["metro lines"], goal: { type: "RESOLVE_ISSUES" } } });
  });

  it("an API that fails or answers nonsense is 'not understood', never an exception", async () => {
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await interpretViaApi({ preset: "custom-openai", baseUrl: "https://x", apiKey: "k", model: "m" }, "grow", down)).toMatchObject({ ok: false });
    const chatty = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "I think you want houses" } }] }), { status: 200 })) as unknown as typeof fetch;
    expect(await interpretViaApi({ preset: "custom-openai", baseUrl: "https://x", apiKey: "k", model: "m" }, "grow", chatty)).toMatchObject({ ok: false, error: "NO_CODE" });
  });
});
