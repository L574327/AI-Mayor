/**
 * THE SEMANTIC FRONTEND — the only place an external AI touches the product, and it only READS LANGUAGE: a player's sentence in, one line of the
 * Mayor's own Goal vocabulary out (`MayorStructuredGoalIntent`, checked again by the runtime's capability map). It never sees the city, never picks a
 * place, a prefab or a tax rate, and never blocks the Mayor: no answer, a bad answer or no network simply means "not understood".
 *
 * Two ways in, one format back:
 *   API (fully automatic)  — the app asks an OpenAI-compatible endpoint the player configured.
 *   Assisted (no API)      — the app copies a short prompt; the player pastes it into any free AI and pastes the one-line reply back.
 * The reply must carry the one-time code of THIS request (`MAYOR-XXXX`), so a random paste is never taken for an answer, and it is validated
 * against the vocabulary before it can be sent.
 */
import type { MayorStructuredGoalIntent } from "../types";
import { type ProviderConfig, sendPrompt } from "./ai-providers";
import { capabilityLinesForPrompt } from "./capability-index";
import { FORBID_KINDS, type ForbidKind, type GrowthControl, type GrowthStyle, type Instruction, TARGET_POPULATION_RANGE } from "./intent-lowering";

const TYPES = ["GROW_POPULATION", "EXPAND_RESIDENTIAL", "EXPAND_COMMERCIAL", "EXPAND_INDUSTRIAL", "EXPAND_OFFICE", "PROVIDE_SERVICE", "IMPROVE_TRAFFIC",
  "ESTABLISH_ROAD_NETWORK", "REDEVELOP_AREA", "CONNECT_ACROSS_OBSTACLE", "RESOLVE_ISSUES"] as const;
const ISSUES = ["TRAFFIC", "NOISE", "RUINS", "ACCESS", "CRIME", "FIRE", "HEALTH", "DEATHCARE", "GARBAGE", "FINANCE"] as const;
const REGIONS = ["ANY", "NEAR_EXISTING", "WATERFRONT", "INFILL", "EDGE", "FAR"] as const;
const SERVICES = ["ELECTRICITY", "WATER", "SEWAGE", "EDUCATION", "HEALTHCARE", "FIRE", "POLICE", "PARK"] as const;
const DENSITIES = ["LOW", "MEDIUM", "HIGH"] as const;
const DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
const PRIORITIES = ["LOW", "NORMAL", "HIGH"] as const;

/** A short one-time code for one request (no look-alike characters). */
export function newRequestCode(random: () => number = Math.random): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
}

/**
 * THE FILTER: the prompt that lends a free AI's understanding to one translation — the player's words (any language, slang, several wishes at
 * once, negations) into the bounded instruction the compiler takes (`intent-lowering.ts`). The AI never plans: it does not see the city and never
 * picks places, buildings, budgets or tax numbers; the local Mayor decides all of that from the world. What it must get right is the MEANING:
 * which problems, which goals in which order, what is forbidden, what is kept, whether growth is held, and what cannot be expressed at all.
 * In English whatever the player's language (every model reads it); the player's own words are passed as they are.
 */
export function buildPrompt(request: string, code: string): string {
  const line = (json: string) => `MAYOR-${code} ${json}`;
  return [
    "You translate one request from a Cities: Skylines II player into a structured instruction for the AI Mayor, an app that runs the player's city.",
    "You are a translator, not a planner: never invent coordinates, buildings, budgets, tax numbers or district names. Reply with ONE line only, no explanation.",
    "",
    `FORMAT: ${line('{"goals":[GOAL,...],"growth":null,"style":null,"targetPopulation":null,"forbid":[],"preserve":[],"unsupported":[]}')}`,
    "GOAL = {\"type\":TYPE,\"scope\":{...optional},\"priority\":\"LOW\"|\"NORMAL\"|\"HIGH\"}. 0-3 goals, in the player's order.",
    "",
    "TYPES (what each means):",
    "- RESOLVE_ISSUES: fix problems of the existing city. scope.issues = any of:",
    "    TRAFFIC (jams, congestion, gridlock, traffic bottleneck icons), ACCESS (buildings with \"No Road Access\"/\"No Car Access\"/\"No Pedestrian Access\", power lines or water pipes \"Not Connected\", roads that do not join, dead ends, \"fix the roads\"),",
    "    GARBAGE (garbage piling up, trash icons, landfill full), RUINS (abandoned, collapsed, burned-down or condemned buildings, rubble), NOISE (noise pollution),",
    "    CRIME (crime, theft, police icons), FIRE (fires, burning), HEALTH (sick citizens, ambulance icons), DEATHCARE (dead bodies, hearse icons),",
    "    FINANCE (losing money, deficit, negative balance, debt, no cash, \"stop the bleeding\", \"save money\").",
    "  issues [] = every problem (\"fix all the problem icons\", \"make the city healthy/livable\", \"the city is a mess\"). FINANCE is only included when money is mentioned.",
    "- IMPROVE_TRAFFIC: traffic is the ONLY thing asked (\"too much traffic\", \"the highway exit is jammed\"). Traffic plus anything else = RESOLVE_ISSUES with TRAFFIC in issues.",
    "- PROVIDE_SERVICE with scope.serviceKind ELECTRICITY|WATER|SEWAGE|EDUCATION|HEALTHCARE|FIRE|POLICE|PARK: more capacity or coverage of that service (\"we need schools\", \"no water\", \"blackout\").",
    "  A building that is not CONNECTED to power/water is ACCESS, not PROVIDE_SERVICE.",
    "- EXPAND_RESIDENTIAL | EXPAND_COMMERCIAL | EXPAND_INDUSTRIAL | EXPAND_OFFICE: build a new district of that use. Not enough jobs / unemployment = EXPAND_INDUSTRIAL.",
    "  scope: \"density\": LOW|MEDIUM|HIGH; \"region\": NEAR_EXISTING|WATERFRONT|INFILL|EDGE|FAR|ANY; \"acquireLand\": true only if the player allows buying land;",
    "  \"direction\": N|NE|E|SE|S|SW|W|NW when the player says on which side of the city (\"the west side\", 西边, 城北, \"to the north-east\") — only for a new district (EXPAND_*/GROW_POPULATION), never for problems.",
    "  A place that is not a compass side (\"near the river bend\", a street name, \"the old factory\") cannot be expressed: say so in unsupported.",
    "- GROW_POPULATION: make the city bigger in general. ESTABLISH_ROAD_NETWORK: lay new streets. CONNECT_ACROSS_OBSTACLE: bridge/tunnel across water.",
    "- REDEVELOP_AREA: rebuild or upgrade an old area.",
    "",
    "OTHER FIELDS:",
    "- growth: \"PAUSE\" when the player wants no more expansion (\"stop expanding\", \"don't build new districts\", \"先别扩张\"); \"RESUME\" when they want it back. Otherwise null.",
    "  A pause never becomes a goal; the Mayor keeps fixing problems while paused.",
    "- style: \"SNOWBALL\" when the player wants growth all out (\"全力扩张\", \"滚雪球\", \"有钱就建\", \"don't stop\", \"as fast as possible\"); \"STEADY\" when they want growth that saves money (\"稳健\", \"攒钱\"). Otherwise null.",
    "  Any wish to expand (\"扩张\", \"扩展\", \"别发呆\", \"动起来\", \"把城市搞大\") is GROW_POPULATION — never RESOLVE_ISSUES or traffic.",
    "- targetPopulation: a number only when the player names a population to reach (\"grow to 50k\" = 50000, \"5万人\" = 50000, \"10万\" = 100000). Otherwise null.",
    `- forbid: any of ${FORBID_KINDS.join(", ")} — ONLY what the player forbids (\"don't demolish\" = demolition, \"no loans\" = loan, \"don't touch the roads\" = road_rebuild, \"don't buy land\" = land_purchase, \"don't rezone\" = zoning_change).`,
    "  A \"don't\" must never become a goal or a permission.",
    "- preserve: names of districts the player wants left untouched, exactly as written (\"leave Old Town alone\" -> [\"Old Town\"]).",
    "- unsupported: short notes for wishes none of the fields can express (a metro or bus line, a specific tax rate, building a specific landmark, an airport...).",
    "  Do NOT force an unsupported wish into the nearest goal; put it here. If nothing is expressible, goals is [] and unsupported says why.",
    "- priority: HIGH for urgent/now/马上/立刻, LOW for no rush/不急, else NORMAL.",
    "",
    "VAGUE WISHES — never answer with nothing when a sensible reading exists (an empty answer is useless to the player):",
    "- \"beautiful / pretty / tidy / clean / nice city\" (漂亮, 好看, 整洁, 宜居) = RESOLVE_ISSUES with issues [] (the Mayor cleans up every problem).",
    "- \"skyscrapers / high-rises / tall buildings / 高楼大厦 / 摩天楼\" = density HIGH. With no land use named, use EXPAND_RESIDENTIAL; if offices or shops are named, EXPAND_OFFICE / EXPAND_COMMERCIAL.",
    "- \"build me a city / develop / 建设一个城市\" with nothing else = GROW_POPULATION (or the expansion above when a style is given).",
    "- Put in unsupported ONLY what really cannot be done (a named landmark, a specific building, a metro line, tax numbers, a place that is not a compass side).",
    "",
    ...capabilityLinesForPrompt(),
    "",
    "EXAMPLES:",
    `\"给我全力扩张建设，不要停\" -> ${line('{"goals":[{"type":"GROW_POPULATION","priority":"NORMAL"}],"growth":"RESUME","style":"SNOWBALL","targetPopulation":null,"forbid":[],"preserve":[],"unsupported":[]}')}`,
    `\"给我建设一个漂亮的城市，要高楼大厦\" -> ${line('{"goals":[{"type":"RESOLVE_ISSUES","scope":{"issues":[]},"priority":"NORMAL"},{"type":"EXPAND_RESIDENTIAL","scope":{"density":"HIGH"},"priority":"NORMAL"}],"growth":null,"targetPopulation":null,"forbid":[],"preserve":[],"unsupported":[]}')}`,
    `\"垃圾堆成山了，还有好多房子没接上路\" -> ${line('{"goals":[{"type":"RESOLVE_ISSUES","scope":{"issues":["GARBAGE","ACCESS"]},"priority":"NORMAL"}],"growth":null,"targetPopulation":null,"forbid":[],"preserve":[],"unsupported":[]}')}`,
    `\"城市太堵了，别拆房子\" -> ${line('{"goals":[{"type":"IMPROVE_TRAFFIC","priority":"NORMAL"}],"growth":null,"targetPopulation":null,"forbid":["demolition"],"preserve":[],"unsupported":[]}')}`,
    `\"先别扩张了，把地图上的问题图标都处理掉\" -> ${line('{"goals":[{"type":"RESOLVE_ISSUES","scope":{"issues":[]},"priority":"NORMAL"}],"growth":"PAUSE","targetPopulation":null,"forbid":[],"preserve":[],"unsupported":[]}')}`,
    `\"财政亏得厉害，马上止血，不要贷款\" -> ${line('{"goals":[{"type":"RESOLVE_ISSUES","scope":{"issues":["FINANCE"]},"priority":"HIGH"}],"growth":null,"targetPopulation":null,"forbid":["loan"],"preserve":[],"unsupported":[]}')}`,
    `\"清理废墟，然后在河边建高密度住宅，可以买地\" -> ${line('{"goals":[{"type":"RESOLVE_ISSUES","scope":{"issues":["RUINS"]},"priority":"NORMAL"},{"type":"EXPAND_RESIDENTIAL","scope":{"density":"HIGH","region":"WATERFRONT","acquireLand":true},"priority":"NORMAL"}],"growth":null,"targetPopulation":null,"forbid":[],"preserve":[],"unsupported":[]}')}`,
    `\"在城市西边建一片商业区，别动老城区\" -> ${line('{"goals":[{"type":"EXPAND_COMMERCIAL","scope":{"direction":"W"},"priority":"NORMAL"}],"growth":null,"targetPopulation":null,"forbid":[],"preserve":["老城区"],"unsupported":[]}')}`,
    `\"Grow the city to 80k but leave Old Town alone\" -> ${line('{"goals":[{"type":"GROW_POPULATION","priority":"NORMAL"}],"growth":null,"targetPopulation":80000,"forbid":[],"preserve":["Old Town"],"unsupported":[]}')}`,
    `\"失业的人太多了，再建个地铁\" -> ${line('{"goals":[{"type":"EXPAND_INDUSTRIAL","priority":"NORMAL"}],"growth":null,"targetPopulation":null,"forbid":[],"preserve":[],"unsupported":["metro line"]}')}`,
    `\"继续扩张吧\" -> ${line('{"goals":[],"growth":"RESUME","targetPopulation":null,"forbid":[],"preserve":[],"unsupported":[]}')}`,
    "",
    `REQUEST: ${request.trim().replace(/\s+/g, " ").slice(0, 600)}`,
  ].join("\n");
}
export type ReplyCheck =
  | { ok: true; instruction: Instruction; intent: MayorStructuredGoalIntent | null; /** What the instruction MEANS, in words, for the player to read before confirming (a free AI may have read the sentence the wrong way round). */ summary: { zh: string; en: string } }
  | { ok: false; error: "NO_CODE" | "WRONG_CODE" | "NOT_JSON" | "UNSUPPORTED" | "INVALID"; detail: string };

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && (values as readonly string[]).includes(value);

/** One goal object, validated against the runtime's vocabulary. */
function checkGoal(parsed: Record<string, unknown>): { ok: true; goal: MayorStructuredGoalIntent } | { ok: false; detail: string } {
  if (!oneOf(TYPES, parsed.type)) return { ok: false, detail: `unknown goal type ${String(parsed.type)}` };
  const priority = parsed.priority === undefined ? "NORMAL" : parsed.priority;
  if (!oneOf(PRIORITIES, priority)) return { ok: false, detail: `unknown priority ${String(parsed.priority)}` };
  const rawScope = (typeof parsed.scope === "object" && parsed.scope !== null ? parsed.scope : {}) as Record<string, unknown>;
  const scope: NonNullable<MayorStructuredGoalIntent["scope"]> = {};
  if (rawScope.region !== undefined) { if (!oneOf(REGIONS, rawScope.region)) return { ok: false, detail: `unknown region ${String(rawScope.region)}` }; scope.region = rawScope.region; }
  if (rawScope.serviceKind !== undefined) {
    if (!oneOf(SERVICES, rawScope.serviceKind) || parsed.type !== "PROVIDE_SERVICE") return { ok: false, detail: "serviceKind only with PROVIDE_SERVICE and a known service" };
    scope.serviceKind = rawScope.serviceKind;
  }
  if (rawScope.density !== undefined) { if (!oneOf(DENSITIES, rawScope.density)) return { ok: false, detail: `unknown density ${String(rawScope.density)}` }; scope.density = rawScope.density; }
  if (rawScope.direction !== undefined) {
    if (!oneOf(DIRECTIONS, rawScope.direction) || !(String(parsed.type).startsWith("EXPAND_") || parsed.type === "GROW_POPULATION")) return { ok: false, detail: `direction only with a new district, one of ${DIRECTIONS.join(", ")}` };
    scope.direction = rawScope.direction;
  }
  if (rawScope.acquireLand !== undefined) { if (typeof rawScope.acquireLand !== "boolean") return { ok: false, detail: "acquireLand must be true or false" }; if (rawScope.acquireLand) scope.acquireLand = true; }
  if (rawScope.issues !== undefined) {
    if (parsed.type !== "RESOLVE_ISSUES" || !Array.isArray(rawScope.issues) || !rawScope.issues.every((issue) => oneOf(ISSUES, issue))) {
      return { ok: false, detail: `issues only with RESOLVE_ISSUES, each one of ${ISSUES.join(", ")}` };
    }
    if (rawScope.issues.length > 0) scope.issues = [...new Set(rawScope.issues as Array<(typeof ISSUES)[number]>)];
  }
  if (parsed.type === "PROVIDE_SERVICE" && !scope.serviceKind) return { ok: false, detail: "PROVIDE_SERVICE needs a serviceKind" };
  return { ok: true, goal: { kind: "GOAL", type: parsed.type, priority, ...(Object.keys(scope).length > 0 ? { scope } : {}) } };
}

const GOAL_WORDS: Record<MayorStructuredGoalIntent["type"], [string, string]> = {
  GROW_POPULATION: ["发展人口", "grow the population"], EXPAND_RESIDENTIAL: ["扩建住宅", "expand residential"], EXPAND_COMMERCIAL: ["扩建商业", "expand commercial"],
  EXPAND_INDUSTRIAL: ["扩建工业", "expand industry"], EXPAND_OFFICE: ["扩建办公", "expand offices"], PROVIDE_SERVICE: ["保障服务", "provide a service"], IMPROVE_TRAFFIC: ["改善交通", "improve traffic"],
  ESTABLISH_ROAD_NETWORK: ["扩展路网", "extend the road network"], REDEVELOP_AREA: ["改造片区", "redevelop an area"], CONNECT_ACROSS_OBSTACLE: ["跨水面/障碍连通", "connect across an obstacle"], RESOLVE_ISSUES: ["处理问题", "fix problems"],
};
const ISSUE_WORDS: Record<(typeof ISSUES)[number], [string, string]> = { TRAFFIC: ["交通", "traffic"], NOISE: ["噪音", "noise"], RUINS: ["废墟", "ruins"], ACCESS: ["道路连通", "road access"], CRIME: ["治安", "crime"],
  FIRE: ["消防", "fire"], HEALTH: ["医疗", "health"], DEATHCARE: ["殡葬", "deathcare"], GARBAGE: ["垃圾", "garbage"], FINANCE: ["财政", "finances"] };
const SERVICE_WORDS: Record<(typeof SERVICES)[number], [string, string]> = { ELECTRICITY: ["供电", "electricity"], WATER: ["供水", "water"], SEWAGE: ["污水", "sewage"], EDUCATION: ["教育", "education"],
  HEALTHCARE: ["医疗", "healthcare"], FIRE: ["消防", "fire"], POLICE: ["治安", "police"], PARK: ["公园", "parks"] };
const SIDE_WORDS: Record<(typeof DIRECTIONS)[number], [string, string]> = { N: ["北", "north"], NE: ["东北", "north-east"], E: ["东", "east"], SE: ["东南", "south-east"], S: ["南", "south"], SW: ["西南", "south-west"], W: ["西", "west"], NW: ["西北", "north-west"] };
const FORBID_WORDS: Record<ForbidKind, [string, string]> = { demolition: ["不拆除", "no demolition"], loan: ["不贷款", "no loans"], zoning_change: ["不改区划", "no rezoning"], road_rebuild: ["不改路", "no road changes"], land_purchase: ["不买地", "no land purchase"] };

/** The whole instruction in plain words (both languages): shown back so a wrongly read sentence is seen before it is sent. */
export function describeInstruction(instruction: Instruction): { zh: string; en: string } {
  const goals = [instruction.goal, ...(instruction.goals ?? [])].filter((goal): goal is MayorStructuredGoalIntent => goal !== null);
  const part = (index: 0 | 1): string[] => {
    const out: string[] = [];
    for (const goal of goals) {
      const scope = goal.scope ?? {};
      const what = goal.type === "RESOLVE_ISSUES" ? `${GOAL_WORDS.RESOLVE_ISSUES[index]}${index === 0 ? "：" : ": "}${scope.issues?.length ? scope.issues.map((issue) => ISSUE_WORDS[issue][index]).join(index === 0 ? "、" : ", ") : index === 0 ? "所有问题" : "all of them"}`
        : goal.type === "PROVIDE_SERVICE" && scope.serviceKind ? `${GOAL_WORDS.PROVIDE_SERVICE[index]}${index === 0 ? "：" : ": "}${SERVICE_WORDS[scope.serviceKind][index]}` : GOAL_WORDS[goal.type][index];
      const extras = [scope.direction ? (index === 0 ? `城市${SIDE_WORDS[scope.direction][0]}侧` : `${SIDE_WORDS[scope.direction][1]} side`) : null, scope.region && scope.region !== "ANY" ? scope.region.toLowerCase() : null,
        scope.density ? scope.density.toLowerCase() : null, scope.acquireLand ? (index === 0 ? "可买地" : "may buy land") : null, goal.priority === "HIGH" ? (index === 0 ? "优先" : "urgent") : null].filter(Boolean);
      out.push(extras.length > 0 ? `${what}（${extras.join(index === 0 ? "，" : ", ")}）` : what);
    }
    if (instruction.growth) out.push(instruction.growth === "PAUSE" ? (index === 0 ? "暂停扩张" : "hold expansion") : (index === 0 ? "恢复扩张" : "resume expansion"));
    if (instruction.style) out.push(instruction.style === "SNOWBALL" ? (index === 0 ? "滚雪球：有钱就建" : "snowball: cash goes into building") : (index === 0 ? "稳健：边扩张边攒钱" : "steady: grow while saving"));
    if (instruction.targetPopulation !== undefined) out.push(index === 0 ? `目标人口 ${instruction.targetPopulation.toLocaleString("zh-CN")}` : `target population ${instruction.targetPopulation.toLocaleString("en-US")}`);
    for (const kind of instruction.forbid) out.push(FORBID_WORDS[kind][index]);
    for (const name of instruction.preserve) out.push(index === 0 ? `保护“${name}”` : `keep "${name}"`);
    for (const note of instruction.unsupported) out.push(index === 0 ? `不支持：${note}` : `not supported: ${note}`);
    return out;
  };
  return { zh: part(0).join("；") || "没有可执行的内容", en: part(1).join("; ") || "nothing to carry out" };
}

/** Read the reply (it may carry text around the line, or markdown fences) and validate it against the code and the instruction subset. */
export function checkReply(reply: string, code: string): ReplyCheck {
  const match = /MAYOR-([A-Z0-9]{4})\s*(\{[\s\S]*\})\s*(?:```|$)/m.exec(reply) ?? /MAYOR-([A-Z0-9]{4})\s*(\{[\s\S]*\})/m.exec(reply);
  if (!match) return { ok: false, error: "NO_CODE", detail: "the reply has no MAYOR-code line" };
  if (match[1] !== code) return { ok: false, error: "WRONG_CODE", detail: `the reply answers request ${match[1]}, not ${code}` };
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(match[2]!) as Record<string, unknown>; } catch { return { ok: false, error: "NOT_JSON", detail: "the line after the code is not valid JSON" }; }
  // The earlier one-goal line is still read (a model may answer in it).
  const rawGoal = parsed.type !== undefined ? parsed : (typeof parsed.goal === "object" && parsed.goal !== null ? parsed.goal as Record<string, unknown> : null);
  const rawGoals = [...(rawGoal ? [rawGoal] : []), ...(Array.isArray(parsed.goals) ? parsed.goals : [])]
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  if (rawGoals.length > 4) return { ok: false, error: "INVALID", detail: "at most 3 goals in one instruction" };
  const goals: MayorStructuredGoalIntent[] = [];
  for (const raw of rawGoals) {
    if (raw.type === "UNSUPPORTED") continue;
    const checked = checkGoal(raw);
    if (!checked.ok) return { ok: false, error: "INVALID", detail: checked.detail };
    goals.push(checked.goal);
  }
  const goal = goals[0] ?? null;
  let growth: GrowthControl | undefined;
  if (parsed.growth !== undefined && parsed.growth !== null) {
    if (parsed.growth !== "PAUSE" && parsed.growth !== "RESUME") return { ok: false, error: "INVALID", detail: "growth must be PAUSE, RESUME or null" };
    growth = parsed.growth;
  }
  let style: GrowthStyle | undefined;
  if (parsed.style !== undefined && parsed.style !== null) {
    if (parsed.style !== "SNOWBALL" && parsed.style !== "STEADY") return { ok: false, error: "INVALID", detail: "style must be SNOWBALL, STEADY or null" };
    style = parsed.style;
  }
  let targetPopulation: number | undefined;
  if (parsed.targetPopulation !== undefined && parsed.targetPopulation !== null) {
    const value = Number(parsed.targetPopulation);
    if (!Number.isFinite(value) || value < TARGET_POPULATION_RANGE.minimum || value > TARGET_POPULATION_RANGE.maximum) {
      return { ok: false, error: "INVALID", detail: `targetPopulation must be ${TARGET_POPULATION_RANGE.minimum}-${TARGET_POPULATION_RANGE.maximum}` };
    }
    targetPopulation = Math.round(value);
  }
  const forbidRaw = Array.isArray(parsed.forbid) ? parsed.forbid : [];
  if (forbidRaw.some((item) => !oneOf(FORBID_KINDS, item))) return { ok: false, error: "INVALID", detail: `unknown forbid item (allowed: ${FORBID_KINDS.join(", ")})` };
  const preserveRaw = Array.isArray(parsed.preserve) ? parsed.preserve : [];
  if (preserveRaw.some((item) => typeof item !== "string" || !item.trim() || item.length > 60)) return { ok: false, error: "INVALID", detail: "preserve must be district names" };
  const unsupported = [...(Array.isArray(parsed.unsupported) ? parsed.unsupported : []), ...(rawGoal?.type === "UNSUPPORTED" ? [rawGoal.reason ?? parsed.reason ?? "not supported"] : [])]
    .map((item) => String(item).slice(0, 120)).filter(Boolean).slice(0, 5);
  const instruction: Instruction = { goal, ...(goals.length > 1 ? { goals: goals.slice(1) } : {}), ...(growth ? { growth } : {}), ...(style ? { style } : {}), ...(targetPopulation !== undefined ? { targetPopulation } : {}),
    forbid: [...new Set(forbidRaw as ForbidKind[])], preserve: [...new Set((preserveRaw as string[]).map((item) => item.trim()))], unsupported };
  if (!goal && !growth && !style && targetPopulation === undefined && instruction.forbid.length === 0 && instruction.preserve.length === 0) {
    // Never a flat refusal: nothing here can be carried out as said, so the Mayor keeps looking after the city (the same as without any instruction) and says what it left out.
    const care: MayorStructuredGoalIntent = { kind: "GOAL", type: "RESOLVE_ISSUES", priority: "NORMAL" };
    const softened: Instruction = { ...instruction, goal: care, fallback: true };
    return { ok: true, instruction: softened, intent: care, summary: describeInstruction(softened) };
  }
  return { ok: true, instruction, intent: goal, summary: describeInstruction(instruction) };
}
/** Ask the player's configured AI service (OpenAI or Anthropic format, `ai-providers.ts`): bounded, never retried in a loop; a failure is "not understood". */
export async function interpretViaApi(config: ProviderConfig, request: string, fetchImpl: typeof fetch = fetch, timeoutMs = 25_000): Promise<ReplyCheck & { raw?: string }> {
  const code = newRequestCode();
  const answer = await sendPrompt(config, buildPrompt(request, code), fetchImpl, timeoutMs);
  if (!answer.ok) return { ok: false, error: "NO_CODE", detail: `the AI service: ${answer.detail}` };
  return { ...checkReply(answer.text, code), raw: answer.text.slice(0, 400) };
}
