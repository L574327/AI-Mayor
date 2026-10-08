import { CAPABILITIES, capabilityLinesForPrompt, NOT_YET } from "../../src/main/services/ai-mayor/host/capability-index";
import { parseInstruction } from "../../src/main/services/ai-mayor/host/intent-parser";
import { buildPrompt, checkReply } from "../../src/main/services/ai-mayor/host/semantic-frontend";

// Every sentence the index promises must be read by the local reader (free, offline) as the capability it names: the index and the reader cannot drift apart.
const cases = CAPABILITIES.flatMap((capability) => [...capability.examples.zh, ...capability.examples.en].map((sentence) => [capability.id, sentence, capability.expect] as const));

describe("the capability index: every promised sentence triggers its capability", () => {
  it.each(cases)("%s: %s", (_id, sentence, expect_) => {
    const read = parseInstruction(sentence);
    expect(read.understood).toBe(true);
    const goals = [read.instruction.goal, ...(read.instruction.goals ?? [])].filter((goal) => goal !== null);
    if (expect_.type) expect(goals.map((goal) => goal!.type)).toContain(expect_.type);
    const scoped = goals.find((goal) => goal!.type === (expect_.type ?? goal!.type));
    if (expect_.issue) expect(goals.flatMap((goal) => goal!.scope?.issues ?? [])).toContain(expect_.issue);
    if (expect_.service) expect(scoped?.scope?.serviceKind).toBe(expect_.service);
    if (expect_.density) expect(scoped?.scope?.density).toBe(expect_.density);
    if (expect_.direction) expect(scoped?.scope?.direction).toBe(expect_.direction);
    if (expect_.region) expect(scoped?.scope?.region).toBe(expect_.region);
    if (expect_.acquireLand) expect(scoped?.scope?.acquireLand).toBe(true);
    if (expect_.growth) expect(read.instruction.growth).toBe(expect_.growth);
    if (expect_.style) expect(read.instruction.style).toBe(expect_.style);
    if (expect_.targetPopulation) expect(read.instruction.targetPopulation).toBe(expect_.targetPopulation);
    if (expect_.forbid) expect(read.instruction.forbid).toContain(expect_.forbid);
    if (expect_.preserve) expect(read.instruction.preserve).toContain(expect_.preserve);
    // A wish to grow never comes back as care of the city (traffic and the like).
    if (expect_.type === "GROW_POPULATION" || expect_.style === "SNOWBALL") expect(goals.some((goal) => goal!.type === "IMPROVE_TRAFFIC")).toBe(false);
  });

  it("the AI filter's prompt carries the whole index and the growth mode, and its replies are checked for it", () => {
    const prompt = buildPrompt("全力扩张", "ABCD");
    for (const line of capabilityLinesForPrompt()) expect(prompt).toContain(line);
    expect(prompt).toMatch(/"style"/);
    expect(NOT_YET.length).toBeGreaterThan(3);
    const reply = checkReply('MAYOR-ABCD {"goals":[{"type":"GROW_POPULATION"}],"growth":"RESUME","style":"SNOWBALL","targetPopulation":null,"forbid":[],"preserve":[],"unsupported":[]}', "ABCD");
    expect(reply.ok).toBe(true);
    if (reply.ok) { expect(reply.instruction.style).toBe("SNOWBALL"); expect(reply.summary.zh).toMatch(/滚雪球/); }
    expect(checkReply('MAYOR-ABCD {"goals":[],"style":"FAST"}', "ABCD").ok).toBe(false);
  });
});
