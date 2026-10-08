/**
 * The local, free, offline reading of a player's instruction (Chinese or English) into the runtime's own Goal vocabulary
 * (`MayorStructuredGoalIntent`, executed and capability-checked by `runtime.setPendingUserCommand`). It never invents coordinates, prefabs or tax
 * numbers: only the kind of goal, the service, the density, the region, land permission and priority — the rest is the local Mayor's to choose.
 *
 * An external AI may later replace or refine this reading (same output type); when it is absent, offline or out of quota, this one answers, and
 * when this one cannot read an instruction it says so (`understood: false`) instead of guessing.
 */
import type { MayorStructuredGoalIntent } from "../types";
import { combineGoals, type ForbidKind, type GrowthControl, type Instruction } from "./intent-lowering";

export interface ParsedInstruction {
  understood: boolean;
  intent: MayorStructuredGoalIntent | null;
  /** The whole instruction for the compiler subset (`intent-lowering.ts`): the goal, what is forbidden, the districts to keep. */
  instruction: Instruction;
  /** What was understood, in the player's language, to show back for confirmation. */
  summary: string;
  /** Parts of the instruction this reader recognised but the Mayor cannot carry out yet. */
  unsupported: string[];
  /**
   * Every part of the sentence was read (each clause gave a goal, a limit or a growth setting) and nothing in it is unsupported: the local reading can be
   * sent as it is, without asking an AI. False: the sentence has parts this reader did not understand — the AI filter (API or pasted) reads it.
   */
  confident: boolean;
}

type Lang = "zh" | "en";
const isChinese = (text: string) => /[一-鿿]/.test(text);

const has = (text: string, ...patterns: RegExp[]) => patterns.some((pattern) => pattern.test(text));

/** "十五" -> 15, "两百" -> 200, "一百二十" -> 120 (below 1000: what stands before 万/千); null when it is not a numeral. */
function zhNumber(text: string): number | null {
  const digit: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0; let current = 0; let seen = false;
  for (const char of text) {
    if (char in digit) { current = digit[char]!; seen = true; }
    else if (char === "十") { total += (current || 1) * 10; current = 0; seen = true; }
    else if (char === "百") { total += (current || 1) * 100; current = 0; seen = true; }
    else return null;
  }
  return seen ? total + current : null;
}

/** The compass side a sentence names ("西边", "城北", "东北部", "to the north-east"), or null. Words like 北京 do not count: a side word must follow. */
export function compassOf(text: string): NonNullable<NonNullable<MayorStructuredGoalIntent["scope"]>["direction"]> | null {
  const zh = /(东北|西北|东南|西南|东|西|南|北)(?:边|面|侧|部|方|头|郊)|城(东北|西北|东南|西南|东|西|南|北)(?![区路街镇县])|(?:往|向|朝)(东北|西北|东南|西南|东|西|南|北)(?:方向)?/.exec(text);
  const en = /\b(north-?east|north-?west|south-?east|south-?west|north|south|east|west)(?:ern|ward)?\s+(?:side|part|end|edge)|\b(?:to|on|in) the (north-?east|north-?west|south-?east|south-?west|north|south|east|west)\b/i.exec(text);
  const word = zh ? (zh[1] ?? zh[2] ?? zh[3]) : en ? (en[1] ?? en[2])?.toLowerCase().replace("-", "") : undefined;
  if (!word) return null;
  const table: Record<string, "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW"> = { 东北: "NE", 西北: "NW", 东南: "SE", 西南: "SW", 东: "E", 西: "W", 南: "S", 北: "N",
    northeast: "NE", northwest: "NW", southeast: "SE", southwest: "SW", north: "N", south: "S", east: "E", west: "W" };
  return table[word] ?? null;
}

export function parseInstruction(raw: string): ParsedInstruction {
  const text = raw.trim();
  const lang: Lang = isChinese(text) ? "zh" : "en";
  const whole = text.toLowerCase();
  const unsupported: string[] = [];
  const say = (zh: string, en: string) => (lang === "zh" ? zh : en);

  // Limits first (what the player forbids, which districts to keep), then the goal read on what is left: "don't tear down the houses" must not
  // read as "build houses", and "leave the old town alone" names a district, not a goal.
  const forbidPatterns: Array<[ForbidKind, RegExp, RegExp]> = [
    ["land_purchase", /(?:don'?t|do not|no|never|without)\s+(?:buy(?:ing)?|purchas(?:e|ing))\s+(?:any\s+|more\s+)?(?:land|tiles?)/g, /不(?:要|许|准)?买地|别买地|不购买地块?/g],
    ["demolition", /(?:don'?t|do not|no|never|without)\s+(?:demolish|bulldoz|tear)\w*(?:\s+down)?(?:\s+(?:any|the|my)?\s*\w+)?/g, /(?:不(?:要|许|准)?|别|禁止)再?(?:拆|铲)[^，,。.；;！!？?\s]{0,4}/g],
    ["loan", /(?:no|don'?t|do not|never|without)\s+(?:take\s+)?(?:loans?|borrow\w*)/g, /不(?:要)?(?:贷款|借钱)|别(?:贷款|借钱)/g],
    ["zoning_change", /(?:don'?t|do not|never)\s+(?:rezone|change\s+(?:the\s+)?zon\w*)/g, /(?:不(?:要)?|别)改(?:区划|分区)/g],
    ["road_rebuild", /(?:don'?t|do not|never)\s+(?:change|rebuild|touch|move)\s+(?:the\s+|any\s+)?roads?/g, /(?:不(?:要)?|别)(?:改|动)(?:道)?路|不拆路/g],
  ];
  const forbid: ForbidKind[] = [];
  let rest = whole;
  for (const [kind, en, zh] of forbidPatterns) {
    if (en.test(rest) || zh.test(rest)) forbid.push(kind);
    en.lastIndex = 0; zh.lastIndex = 0;
    rest = rest.replace(en, " ").replace(zh, " ");
  }
  const preserve: string[] = [];
  // "别动A和B" / "A、B" / "leave A and B alone" name several districts. A name may itself hold 和 (和平区, 人和镇): the list is split only when
  // every piece is a name of its own (two characters at least); otherwise the whole is one name.
  const namesIn = (said: string): string[] => {
    const pieces = said.split(/、|，|,|以及|和|与|及|跟|\s+and\s+|\s*&\s*/i).map((piece) => piece.trim());
    return pieces.length > 1 && pieces.every((piece) => piece.length >= 2) ? pieces : [said.trim()];
  };
  const zhStop = /^(?:我|我的|我建的|已有|现有|所有|路|道路|建筑|房子)/;
  // "keep burning", "keep growing": keep as "go on", not a district.
  const enStop = /^(?:my|existing|all|any|roads?|buildings?|houses?|it|them|land|on|up|going)\b|^[a-z]+ing\b/i;
  const zhKeep = /(?:别动|不要动|别碰|不要碰|保护好?|保留|别改|不要改)([^，,。.；;！!？?\s]{1,40})/g;
  // "麋鹿树林别动" / "老城区不要动": the name before the verb, at the start of its clause.
  const zhKeepAfter = /(?:^|[，,。.；;！!？?\s])([^，,。.；;！!？?\s]{2,40}?)(?:别动|不要动|别碰|不要碰|保持原样|不要改|别改)/g;
  const nameChars = "a-z0-9\\u3400-\\u9fff";
  const enKeep = new RegExp(`(?:don'?t touch|do not touch|leave|keep|protect|preserve)\\s+(?:the\\s+)?([${nameChars}][${nameChars} '-]{1,40}?)(?:\\s+(?:alone|as it is|untouched|intact))?(?=[,.;!?]|$|\\s+(?:and|but)\\s)`, "gi");
  // A list is read only where the sentence closes it ("leave A and B alone"): "keep the roads and expand housing" names no district.
  const enKeepList = new RegExp(`(?:don'?t touch|do not touch|leave|keep)\\s+(?:the\\s+)?([${nameChars}][${nameChars} '&,-]{1,80}?)\\s+(?:alone|as it is|untouched|intact)\\b`, "gi");
  for (const pattern of [zhKeep, zhKeepAfter]) {
    for (const match of rest.matchAll(pattern)) {
      for (const piece of namesIn(match[1]!.replace(/(?:里面|里|内|的建筑|的房子|的东西)$/, "").replace(/^(?:另外|还有|并且|同时|然后|顺便|而且|以及|再就|就|也|再|还要|还)+/, "").replace(/(?:千万|一定|务必|绝对|可|都|也|先)+$/, ""))) {
        if (piece && !zhStop.test(piece)) preserve.push(piece);
      }
    }
  }
  for (const pattern of [enKeepList, enKeep]) {
    for (const match of text.matchAll(pattern)) {
      for (const piece of namesIn(match[1]!).map((name) => name.replace(/^the\s+/i, ""))) if (piece && !enStop.test(piece)) preserve.push(piece);
    }
  }
  // Only words that named a district leave the sentence ("keep burning" stays, for the goal reading below).
  const strip = (stop: RegExp) => (match: string, name: string) => (namesIn(name.replace(/^the\s+/i, "")).every((piece) => !piece || stop.test(piece)) ? match : " ");
  rest = rest.replace(zhKeep, " ").replace(zhKeepAfter, " ").replace(enKeepList, strip(enStop)).replace(enKeep, strip(enStop));
  const lower = rest;
  // Growth control and a population target, read and taken out before the goals: "先别扩张了" is a hold, never "grow the population".
  let growth: GrowthControl | undefined;
  const pauseZh = /(?:先|暂时)?(?:别|不要|不许|暂停|停止|停下|先停|停)(?:再|继续)?(?:一切|所有|全部|任何|进一步)?(?:往外)?(?:的)?(?:扩张|扩建|扩展|扩大|发展人口|发展|增长|长大|变大|做大|开发新区|建新区|开新区|建设|搞建设)了?/g;
  const pauseEn = /\b(?:stop|pause|halt|hold|freeze)\s+(?:all\s+|any\s+|further\s+|more\s+)?(?:the\s+)?(?:expan\w*|expanding|growing|growth|building(?: outward)?|development)\b|\bno more (?:expansion|expanding|new districts)\b|\bdon'?t expand\b/g;
  const resumeZh = /(?:继续|恢复|重新开始|接着)(?:往外)?(?:扩张|扩建|扩展|开发|建设|发展)/g;
  const resumeEn = /\b(?:resume|continue|restart|keep)\s+(?:the\s+)?(?:expan\w*|growing|growth|building|development)\b/g;
  let rest2 = lower.replace(/([零一二两三四五六七八九十百]+)(万|千)/g, (whole, digits: string, unit: string) => { const value = zhNumber(digits); return value === null ? whole : `${value}${unit}`; });
  if (pauseZh.test(rest2) || pauseEn.test(rest2)) growth = "PAUSE";
  else if (resumeZh.test(rest2) || resumeEn.test(rest2)) growth = "RESUME";
  for (const pattern of [pauseZh, pauseEn, resumeZh, resumeEn]) { pattern.lastIndex = 0; rest2 = rest2.replace(pattern, " "); }
  let targetPopulation: number | undefined;
  const targetZh = /(?:人口(?:目标)?(?:定为|设为|到|达到|发展到)?|发展到|达到|长到|做到|到)\s*(\d+(?:\.\d+)?)\s*(万|千)?\s*(?:人口|人|居民)?/;
  const targetEn = /(\d+(?:\.\d+)?)\s*(k|thousand|m|million)?\s*(?:people|population|residents|citizens|pop)\b|population (?:of |to |target (?:of )?)?(\d+(?:\.\d+)?)\s*(k|thousand|m|million)?/;
  const zhTarget = targetZh.exec(rest2);
  if (zhTarget && (/人口|人|居民/.test(rest2))) {
    const value = Number(zhTarget[1]) * (zhTarget[2] === "万" ? 10_000 : zhTarget[2] === "千" ? 1_000 : 1);
    if (value >= 1_000) { targetPopulation = value; rest2 = rest2.replace(zhTarget[0], " "); }
  } else {
    const enTarget = targetEn.exec(rest2);
    if (enTarget) {
      const digits = enTarget[1] ?? enTarget[3];
      const unit = enTarget[2] ?? enTarget[4];
      const value = Number(digits) * (unit === "k" || unit === "thousand" ? 1_000 : unit === "m" || unit === "million" ? 1_000_000 : 1);
      if (value >= 1_000) { targetPopulation = value; rest2 = rest2.replace(enTarget[0], " "); }
    }
  }

  const priority: MayorStructuredGoalIntent["priority"] = has(lower, /urgent|asap|immediately|right now|high priority/, /紧急|马上|立刻|立即|优先/) ? "HIGH"
    : has(lower, /when you can|low priority|no rush/, /有空|不急|慢慢/) ? "LOW" : "NORMAL";
  const noLand = forbid.includes("land_purchase");

  type Scope = NonNullable<MayorStructuredGoalIntent["scope"]>;
  type Issue = NonNullable<Scope["issues"]>[number];
  const service: Array<[NonNullable<Scope["serviceKind"]>, RegExp, RegExp, string, string]> = [
    ["ELECTRICITY", /electric|power (?:plant|supply|shortage)|blackout|no power/, /电力|供电|发电|停电|缺电|没电/, "供电", "electricity"],
    ["WATER", /water supply|fresh water|water shortage|no water|\bwater\b/, /供水|自来水|缺水|水源|没水|停水|断水/, "供水", "water"],
    ["SEWAGE", /sewage|sewer|wastewater/, /污水|排水|下水/, "污水处理", "sewage"],
    ["HEALTHCARE", /health|clinic|hospital|ambulance|sick/, /医疗|医院|诊所|救护|生病/, "医疗", "healthcare"],
    ["EDUCATION", /school|education|university|college/, /学校|教育|大学/, "教育", "education"],
    ["FIRE", /\bfire\b|firefight/, /消防|火灾/, "消防", "fire"],
    ["POLICE", /police|crime/, /警察|治安|犯罪/, "治安", "police"],
    ["PARK", /\bparks?\b|green space/, /公园|绿地/, "公园", "parks"],
  ];
  // The city's problems, as a player describes them (abstractly: "too noisy", "ruins everywhere", "make it livable"). Each maps to the answer the
  // care round has for it (`v2/care-focus.ts`); several in one sentence are one RESOLVE_ISSUES goal.
  const issueWords: Array<[Issue, RegExp, RegExp, string, string]> = [
    ["TRAFFIC", /traffic|congest|\bjams?\b|gridlock|bottleneck/, /堵|拥挤|交通|塞车|车太多/, "交通", "traffic"],
    ["NOISE", /\bnois[ey]|\bloud\b/, /噪音|太吵|好吵|吵死|很吵|吵闹/, "噪音", "noise"],
    ["RUINS", /ruins?\b|collaps|abandon|burn(ed|t)[- ]?(down|out)?|derelict|rubble/, /废墟|坍塌|塌了|倒塌|烧毁|烧掉|烧了|废弃|危房|残骸/, "废墟", "ruins"],
    ["ACCESS", /no (road|car|pedestrian|vehicle) access|not connected|unconnected|can'?t reach|disconnected|fix (the )?roads?/, /没有?路|连不上|未连通|未连接|没连上|没接上|接不上|进不去|无道路|无法通行|车辆通行|车进不去|修一下路(?!网)|修修路|修复道路|道路问题|断头路/, "道路连通", "road access"],
    ["CRIME", /crime|police|theft|robber/, /犯罪|治安|小偷|抢劫|警察|偷/, "治安", "crime"],
    ["FIRE", /\bfires?\b|firefight|burning/, /火灾|着火|消防|失火/, "消防", "fire"],
    ["HEALTH", /health|clinic|hospital|ambulance|sick/, /医疗|医院|诊所|救护|生病/, "医疗", "healthcare"],
    ["DEATHCARE", /hearse|cemetery|dead bodies|deaths\b/, /灵车|墓地|尸体|死人|殡葬/, "殡葬", "deathcare"],
    ["GARBAGE", /garbage|trash|rubbish|waste\b|landfill/, /垃圾/, "垃圾", "garbage"],
    ["FINANCE", /deficit|losing money|in the red|bleed(ing)? (money|cash)|save money|cut (the )?(costs?|spending|expenses)|\bbroke\b|bankrupt|going under|stop the bleeding|out of money|no money|debt/, /亏钱|亏损|赤字|止血|省钱|财政|没钱|钱不够|缺钱|入不敷出|破产|开源节流|收不抵支|烧钱|负债|欠债|省点钱/, "财政", "finances"],
  ];
  // "电线没接上" is a connection problem, not a request for power: the connection words win over the service they mention.
  const connection = /没接上|接不上|没连上|未连接|not connected|unconnected|disconnected/;

  const readGoal = (clause: string): { goal: MayorStructuredGoalIntent; what: string; extras: string[] } | null => {
    const scope: Scope = {};
    // Where, how dense and whether land may be bought are often said in a clause of their own ("扩建住宅，可以买地"): read on the whole sentence.
    const wantLand = !noLand && has(rest2, /buy (more )?land|purchase (land|tiles?)|new tiles?/, /买地|购买地块|扩大地块/);
    const whole = rest2;
    if (has(whole, /waterfront|by the (water|river|sea|lake)|coast/, /水边|河边|海边|湖边|滨水/)) scope.region = "WATERFRONT";
    else if (has(whole, /edge|outskirts|outer/, /边缘|郊区|外围/)) scope.region = "EDGE";
    else if (has(whole, /infill|fill (in|the gaps)|empty lots/, /填空|空地|补齐/)) scope.region = "INFILL";
    else if (has(whole, /near (the )?(existing|city|centre|center)/, /附近|靠近市中心|市中心旁/)) scope.region = "NEAR_EXISTING";
    if (has(whole, /high[- ]density|tower|skyscraper|high[- ]rise|tall buildings?/, /高密|高楼|摩天|大厦|高层/)) scope.density = "HIGH";
    else if (has(whole, /medium[- ]density|mid[- ]density/, /中密/)) scope.density = "MEDIUM";
    else if (has(whole, /low[- ]density|houses|suburb/, /低密/)) scope.density = "LOW";
    if (wantLand) scope.acquireLand = true;
    // "城市西边" / "西北部" / "城北" / "to the north-east": a compass side of the city, for a new district only (set below once the goal type is known).
    const compass = compassOf(whole);
    const named = connection.test(clause) ? undefined : service.find(([, en, zh]) => has(clause, en, zh));
    const livable = has(clause, /livab|beautiful|pretty|tidy|nice city|happiness|unhappy|quality of life|all (the |these )?(problems|issues)|every (problem|icon)|problem icons?|warning icons?|healthy city|fix (the )?city/,
      /宜居|漂亮|好看|美观|整洁|干净的城市|幸福|不开心|满意度|生活质量|所有问题|各种问题|问题图标|这些图标|城市问题|居民不满|问题都|解决问题|健康一点|健康的城市|所有图标|图标都/);
    const issues = issueWords.filter(([issue, en, zh]) => has(clause, en, zh) && !(issue === "HEALTH" && /健康一点|健康的城市/.test(clause)));
    let type: MayorStructuredGoalIntent["type"] | null = null;
    let what = "";
    if (livable || issues.length > 1 || (issues.length === 1 && ["NOISE", "RUINS", "ACCESS", "DEATHCARE", "GARBAGE", "FINANCE"].includes(issues[0]![0]))) {
      type = "RESOLVE_ISSUES";
      if (!livable) scope.issues = issues.map(([issue]) => issue);
      what = livable ? say("处理城市的各种问题（交通、道路连通、垃圾、废墟、治安、消防、医疗……）", "see to the city's problems (traffic, road access, garbage, ruins, crime, fire, healthcare, ...)")
        : say(`处理${issues.map((entry) => entry[3]).join("、")}问题`, `see to ${issues.map((entry) => entry[4]).join(", ")}`);
    }
    else if (issues.length === 1 && issues[0]![0] === "TRAFFIC") { type = "IMPROVE_TRAFFIC"; what = say("改善交通", "improve traffic"); }
    else if (issues.length === 1 && !named) {
      // "burning buildings", "theft" — a service problem described without the service's own name.
      const kind = ({ CRIME: "POLICE", FIRE: "FIRE", HEALTH: "HEALTHCARE" } as const)[issues[0]![0] as "CRIME" | "FIRE" | "HEALTH"];
      type = "PROVIDE_SERVICE"; scope.serviceKind = kind; what = say(`保障${issues[0]![3]}`, `provide ${issues[0]![4]}`);
    }
    else if (scope.density === "HIGH" && has(clause, /高楼|摩天|大厦|skyscraper|high[- ]rise|tall buildings?|tower/)) { type = "EXPAND_RESIDENTIAL"; what = say("扩建住宅", "expand residential"); }
    else if (has(clause, /bridge|cross the (river|water)|tunnel/, /过河|跨河|桥|隧道/)) { type = "CONNECT_ACROSS_OBSTACLE"; what = say("跨越水面/障碍连通", "connect across the obstacle"); }
    else if (named) { type = "PROVIDE_SERVICE"; scope.serviceKind = named[0]; what = say(`保障${named[3]}`, `provide ${named[4]}`); }
    else if (has(clause, /redevelop|rebuild|regenerate|upgrade (the )?(old|area)/, /改造|重建|旧区|升级(老|旧)/)) { type = "REDEVELOP_AREA"; what = say("改造片区", "redevelop the area"); }
    else if (has(clause, /\bjobs?\b|unemploy|employment|work places?/, /岗位|失业|就业|没工作|找不到工作|工作不够/)) { type = "EXPAND_INDUSTRIAL"; what = say("增加就业岗位（扩建工业）", "add jobs (expand industry)"); }
    else if (has(clause, /residential|housing|homes|houses/, /住宅|住房|居民区|房子/)) { type = "EXPAND_RESIDENTIAL"; what = say("扩建住宅", "expand residential"); }
    else if (has(clause, /commercial|shops|retail/, /商业|商店|零售/)) { type = "EXPAND_COMMERCIAL"; what = say("扩建商业", "expand commercial"); }
    else if (has(clause, /industr|factor/, /工业|工厂/)) { type = "EXPAND_INDUSTRIAL"; what = say("扩建工业", "expand industry"); }
    else if (has(clause, /office/, /办公/)) { type = "EXPAND_OFFICE"; what = say("扩建办公", "expand offices"); }
    else if (has(clause, /road network|new roads?|street|grid/, /路网|街道|修路|新路/)) { type = "ESTABLISH_ROAD_NETWORK"; what = say("扩展路网", "extend the road network"); }
    else if (has(clause, /grow|population|expand|develop|bigger|more people|build (me )?a(n)? \w+ city/, /人口|发展|扩张|扩建|长大|增长|做大|变大|大一点|规模|建设(?:一个|个)?\S{0,6}城市|建(?:一个|个)\S{0,6}城市/)) { type = "GROW_POPULATION"; what = say("发展人口", "grow the population"); }
    if (!type) return null;
    if (compass && (type.startsWith("EXPAND_") || type === "GROW_POPULATION")) scope.direction = compass;
    const extras = [
      scope.direction ? say(`城市${{ N: "北", NE: "东北", E: "东", SE: "东南", S: "南", SW: "西南", W: "西", NW: "西北" }[scope.direction]}侧`, `${scope.direction} side of the city`) : null,
      scope.density ? say(`${{ HIGH: "高", MEDIUM: "中", LOW: "低" }[scope.density]}密度`, `${scope.density.toLowerCase()} density`) : null,
      scope.region ? say({ WATERFRONT: "水边", EDGE: "城市边缘", INFILL: "填补空地", NEAR_EXISTING: "现有城区附近", ANY: "任意位置", FAR: "远处" }[scope.region], scope.region.toLowerCase().replace("_", " ")) : null,
      scope.acquireLand ? say("允许买地", "may buy land") : null,
    ].filter((item): item is string => !!item);
    return { goal: { kind: "GOAL", type, priority, ...(Object.keys(scope).length > 0 ? { scope } : {}) }, what, extras };
  };

  // One sentence may carry several requests ("清理废墟然后扩建住宅"): each clause is read on its own, in the player's order.
  const clauses = rest2.split(/然后|之后|接着|再去|并且|同时|另外|还有|顺便|，|,|；|;|。|\band then\b|\bthen\b|\balso\b|\bafter that\b/).map((clause) => clause.trim()).filter(Boolean);
  // "污水倒灌和垃圾堆积": two wishes joined by 和/、/and read as two when EACH side is a wish of its own (a name with 和 in it stays whole).
  const pieces = (clauses.length > 0 ? clauses : [rest2]).flatMap((clause) => {
    const parts = clause.split(/和|、|以及|\s+and\s+/i).map((part) => part.trim()).filter(Boolean);
    return parts.length > 1 && parts.every((part) => readGoal(part) !== null) ? parts : [clause];
  });
  const read = pieces.map(readGoal).filter((entry): entry is NonNullable<ReturnType<typeof readGoal>> => entry !== null);
  // Clauses with real words that gave nothing: the part of the sentence this reader did not understand (filler and politeness are not such a part).
  const filler = /^(?:[\s吧了啊呀嘛呢哦的一下请帮我你给把都先再就也还要好行麻烦谢谢处理解决弄搞做一点下]|please|thanks|ok|okay|now|the|a|and|just|all|them|it)*$/i;
  const unread = clauses.filter((clause) => !filler.test(clause) && readGoal(clause) === null).length;
  // The same goal said twice in one sentence is one goal.
  const seen = new Set<string>();
  const goals = read.filter((entry) => { const key = JSON.stringify(entry.goal); if (seen.has(key)) return false; seen.add(key); return true; });

  // A compass side is carried only by a new district; for anything else it is a place the Mayor cannot act on, and the player is told.
  if (compassOf(rest2) && !goals.some((entry) => entry.goal.scope?.direction)) unsupported.push(say("按方位指定地点（只对新建片区有效；整治类和改造类没法限定在“西边”之类的位置）", "naming a side of the city (only for a new district; fixes and redevelopment cannot be limited to a side)"));
  // "a beautiful city with skyscrapers": the clean-up and the tall buildings are two wishes read from one clause — the care goal keeps the problems, the density goes to a build goal.
  for (const entry of [...goals]) {
    const density = entry.goal.type === "RESOLVE_ISSUES" ? entry.goal.scope?.density : undefined;
    if (!density) continue;
    const hasBuild = goals.some((other) => other.goal.type.startsWith("EXPAND_") || other.goal.type === "GROW_POPULATION");
    const { density: _density, region, acquireLand, ...rest } = entry.goal.scope ?? {};
    entry.goal = { ...entry.goal, ...(Object.keys(rest).length > 0 ? { scope: rest } : { scope: undefined }) };
    if (!entry.goal.scope) delete (entry.goal as { scope?: unknown }).scope;
    if (hasBuild) continue;
    goals.push({ goal: { kind: "GOAL", type: "EXPAND_RESIDENTIAL", priority: entry.goal.priority, scope: { density, ...(region ? { region } : {}), ...(acquireLand ? { acquireLand } : {}) } },
      what: say(`扩建住宅（${{ HIGH: "高", MEDIUM: "中", LOW: "低" }[density]}密度）`, `expand residential (${density.toLowerCase()} density)`), extras: [] });
  }
  // Recognised wishes the vocabulary cannot carry: shown to the player, never turned into another task.
  if (has(lower, /\bmetro\b|subway|\bbus\b|\btram\b|transit line/, /地铁|公交|电车/)) unsupported.push(say("新建公交/地铁线路（暂不支持）", "new bus/metro lines (not supported yet)"));
  if (has(lower, /train station|railway|\brail\b|highway|motorway|airport|harbou?r|\bport\b/, /火车站|铁路|高速|机场|港口|码头/) && !goals.some((entry) => entry.goal.type === "IMPROVE_TRAFFIC" || entry.goal.type === "RESOLVE_ISSUES"))
    unsupported.push(say("指定修建火车站/铁路/高速/机场（暂不支持，市长会按需自己接入铁路和高速）", "building a station/railway/highway/airport on request (not yet; the Mayor links rail and highways itself when needed)"));
  if (has(lower, /air pollution|smog|polluted air/, /空气污染|雾霾|废气|地面污染|地下水污染/)) unsupported.push(say("空气/地面污染（暂无专门处理；市长放垃圾设施、电厂时已避开住宅）", "air/ground pollution (no dedicated answer yet; the Mayor already keeps plants and garbage sites away from homes)"));
  if (has(lower, /tax|budget|loan/, /税|预算|贷款/) && !goals.some((entry) => entry.goal.scope?.issues?.includes("FINANCE")))
    unsupported.push(say("指定税率/预算（市长按财政状况自行调整，需在授权中允许；可以说“财政在亏钱，先止血”）", "set taxes/budgets directly (the Mayor adjusts them itself when allowed; say \"we are losing money\")"));
  if (!goals.some((entry) => entry.goal.scope?.issues?.includes("RUINS")) && has(lower, /demolish|bulldoze|tear down/, /拆除|推平|铲掉/)) unsupported.push(say("指定拆除（接管默认不拆玩家建筑）", "demolition on request (player buildings are kept by default)"));

  // Every problem named across the clauses is one care goal (as the compiler would make it), the first building goal follows it.
  const combined = combineGoals(goals.map((entry) => entry.goal));
  const ordered = [combined.care, combined.build].filter((goal): goal is MayorStructuredGoalIntent => goal !== null);
  const first = ordered[0] ?? null;
  const instruction: Instruction = { goal: first, ...(ordered.length > 1 ? { goals: ordered.slice(1) } : {}),
    ...(growth ? { growth } : {}), ...(targetPopulation !== undefined ? { targetPopulation } : {}),
    forbid: [...new Set(forbid)], preserve: [...new Set(preserve)], unsupported };
  const FORBID_ZH: Record<ForbidKind, string> = { demolition: "不拆除", loan: "不贷款", zoning_change: "不改区划", road_rebuild: "不改路", land_purchase: "不买地" };
  const FORBID_EN: Record<ForbidKind, string> = { demolition: "no demolition", loan: "no loans", zoning_change: "no rezoning", road_rebuild: "no road changes", land_purchase: "no land purchase" };
  const limits = [...new Set(forbid)].map((kind) => say(FORBID_ZH[kind], FORBID_EN[kind])).concat([...new Set(preserve)].map((name) => say(`保护“${name}”`, `keep "${name}"`)));
  const control = [
    growth === "PAUSE" ? say("暂停扩张（继续处理城市问题）", "hold expansion (the city's problems are still handled)") : growth === "RESUME" ? say("恢复扩张", "resume expansion") : null,
    targetPopulation !== undefined ? say(`目标人口 ${targetPopulation.toLocaleString("zh-CN")}`, `target population ${targetPopulation.toLocaleString("en-US")}`) : null,
  ].filter((item): item is string => !!item);

  if (goals.length === 0) {
    if (limits.length > 0 || control.length > 0) return { understood: true, confident: unread === 0 && unsupported.length === 0, intent: null, instruction, unsupported, summary: [...control, ...limits].join(lang === "zh" ? "，" : ", ") };
    return { understood: false, confident: false, intent: null, instruction, unsupported,
      summary: say("没能把这句话对应到市长能执行的目标。可以试试：把问题图标都解决掉、改善交通、清理垃圾、把没接上路的建筑接上、暂停扩张、人口目标5万、扩建住宅。",
        "I could not map this to a goal the Mayor can carry out. Try: fix all the problem icons, improve traffic, clean up garbage, connect the unconnected buildings, stop expanding, target 50k population, expand residential.") };
  }
  const parts = goals.map((entry) => `${entry.what}${entry.extras.length > 0 ? `（${entry.extras.join(lang === "zh" ? "，" : ", ")}）` : ""}`);
  const tail = [...(priority !== "NORMAL" ? [say(priority === "HIGH" ? "优先" : "不急", priority === "HIGH" ? "high priority" : "low priority")] : []), ...control, ...limits];
  return { understood: true, confident: unread === 0 && unsupported.length === 0, intent: first, instruction, unsupported,
    summary: `${parts.join(lang === "zh" ? "；然后" : "; then ")}${tail.length > 0 ? (lang === "zh" ? `（${tail.join("，")}）` : ` (${tail.join(", ")})`) : ""}` };
}