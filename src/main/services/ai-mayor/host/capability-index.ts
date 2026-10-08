/**
 * THE CAPABILITY INDEX — everything the Mayor can be asked for in words, in one table: what it does, the instruction it becomes, and sentences that must
 * trigger it (Chinese and English). Two readers use it, so they cannot drift apart:
 *   - the AI filter's prompt (`semantic-frontend.ts`) lists the capabilities from it;
 *   - the test of the local reader (`test/ai-mayor/capability-index.spec.ts`) reads every example sentence and checks it lands on the capability.
 * A capability added to the Mayor is added here with its sentences; one that cannot be done yet is listed under `NOT_YET`, so a player is told so plainly.
 */
import type { MayorStructuredGoalIntent } from "../types";
import type { ForbidKind, GrowthControl, GrowthStyle } from "./intent-lowering";

type Scope = NonNullable<MayorStructuredGoalIntent["scope"]>;
export interface CapabilityExpectation {
  type?: MayorStructuredGoalIntent["type"];
  issue?: NonNullable<Scope["issues"]>[number];
  service?: NonNullable<Scope["serviceKind"]>;
  density?: NonNullable<Scope["density"]>;
  direction?: NonNullable<Scope["direction"]>;
  region?: NonNullable<Scope["region"]>;
  acquireLand?: true;
  growth?: GrowthControl;
  style?: GrowthStyle;
  targetPopulation?: number;
  forbid?: ForbidKind;
  preserve?: string;
}
export interface Capability {
  id: string;
  zh: string;
  en: string;
  examples: { zh: string[]; en: string[] };
  expect: CapabilityExpectation;
}

const goal = (type: MayorStructuredGoalIntent["type"], more: Omit<CapabilityExpectation, "type"> = {}): CapabilityExpectation => ({ type, ...more });

export const CAPABILITIES: readonly Capability[] = [
  // Growth: how much and how fast the city spreads.
  { id: "grow", zh: "向外扩张城市（新片区、买地）", en: "grow the city outward (new districts, land)", expect: goal("GROW_POPULATION", { growth: "RESUME" }),
    examples: { zh: ["给我扩张", "直接扩展，不要发呆了", "把城市面积搞大", "给我动起来，别发呆"], en: ["grow the city", "expand the city"] } },
  { id: "grow-land", zh: "扩张并允许买地", en: "grow and buy land", expect: goal("GROW_POPULATION", { acquireLand: true }),
    examples: { zh: ["不能建就买地，那么多空地"], en: ["expand and buy more land"] } },
  { id: "snowball", zh: "全力扩张：有钱就建（滚雪球模式）", en: "expand all out: cash goes into building (snowball mode)", expect: { style: "SNOWBALL", growth: "RESUME" },
    examples: { zh: ["全力扩张", "给我全力扩张建设，不要停", "滚雪球", "有钱就建"], en: ["expand all out", "snowball the city"] } },
  { id: "steady", zh: "稳健扩张：边扩张边攒钱", en: "steady growth: grow while saving", expect: { style: "STEADY" },
    examples: { zh: ["稳健扩张", "边扩张边攒钱"], en: ["grow steady and save money"] } },
  { id: "hold", zh: "暂停扩张，只维护现有城市", en: "hold expansion, keep the city running", expect: { growth: "PAUSE" },
    examples: { zh: ["先别扩张了", "暂停扩张"], en: ["stop expanding"] } },
  { id: "resume", zh: "恢复扩张", en: "resume expansion", expect: { growth: "RESUME" },
    examples: { zh: ["继续扩张", "不要停止扩张"], en: ["resume expansion"] } },
  { id: "target", zh: "目标人口（到了就不再向外扩）", en: "a population target (outward growth stops there)", expect: { targetPopulation: 50_000 },
    examples: { zh: ["人口目标5万"], en: ["grow to 50k people"] } },
  // New districts of one use, and where.
  { id: "residential", zh: "新建住宅区（可指定密度）", en: "a new residential district (density may be named)", expect: goal("EXPAND_RESIDENTIAL", { density: "HIGH" }),
    examples: { zh: ["扩建一些高密度住宅", "多建高楼"], en: ["build more high-density housing"] } },
  { id: "commercial", zh: "新建商业区", en: "a new commercial district", expect: goal("EXPAND_COMMERCIAL"), examples: { zh: ["扩建商业区"], en: ["expand commercial"] } },
  { id: "industrial", zh: "新建工业区（失业多时）", en: "a new industrial district (for jobs)", expect: goal("EXPAND_INDUSTRIAL"),
    examples: { zh: ["扩建工业", "失业的人太多了"], en: ["expand industry", "too much unemployment"] } },
  { id: "office", zh: "新建办公区", en: "a new office district", expect: goal("EXPAND_OFFICE"), examples: { zh: ["扩建办公"], en: ["expand offices"] } },
  { id: "side", zh: "在城市某一侧建新区", en: "a new district on one side of the city", expect: goal("EXPAND_COMMERCIAL", { direction: "W" }),
    examples: { zh: ["在城市西边建一片商业区"], en: ["build commercial on the west side"] } },
  { id: "waterfront", zh: "在水边建新区", en: "a new district by the water", expect: goal("EXPAND_COMMERCIAL", { region: "WATERFRONT" }),
    examples: { zh: ["在水边扩建商业区"], en: ["expand commercial by the river"] } },
  // Services.
  { id: "power", zh: "供电", en: "electricity", expect: goal("PROVIDE_SERVICE", { service: "ELECTRICITY" }), examples: { zh: ["城市缺电了"], en: ["we have a blackout"] } },
  { id: "water", zh: "供水", en: "water", expect: goal("PROVIDE_SERVICE", { service: "WATER" }), examples: { zh: ["缺水了，保障供水"], en: ["no water supply"] } },
  { id: "sewage", zh: "污水处理", en: "sewage", expect: goal("PROVIDE_SERVICE", { service: "SEWAGE" }), examples: { zh: ["处理污水"], en: ["handle the sewage"] } },
  { id: "healthcare", zh: "医疗", en: "healthcare", expect: goal("PROVIDE_SERVICE", { service: "HEALTHCARE" }), examples: { zh: ["保障医疗"], en: ["provide healthcare"] } },
  { id: "education", zh: "教育", en: "education", expect: goal("PROVIDE_SERVICE", { service: "EDUCATION" }), examples: { zh: ["多建学校"], en: ["we need schools"] } },
  { id: "fire-service", zh: "消防", en: "fire service", expect: goal("PROVIDE_SERVICE", { service: "FIRE" }), examples: { zh: ["加强消防"], en: ["more fire stations"] } },
  { id: "police", zh: "治安", en: "police", expect: goal("PROVIDE_SERVICE", { service: "POLICE" }), examples: { zh: ["加强治安"], en: ["more police"] } },
  { id: "parks", zh: "公园", en: "parks", expect: goal("PROVIDE_SERVICE", { service: "PARK" }), examples: { zh: ["多建公园"], en: ["build parks"] } },
  // The city's problems (the care round).
  { id: "all-icons", zh: "处理所有问题图标", en: "deal with every problem icon", expect: goal("RESOLVE_ISSUES"),
    examples: { zh: ["把问题图标都解决掉", "让城市宜居一点"], en: ["fix all the problem icons"] } },
  { id: "traffic", zh: "改善交通", en: "improve traffic", expect: goal("IMPROVE_TRAFFIC"), examples: { zh: ["解决堵车问题"], en: ["fix the traffic congestion"] } },
  { id: "noise", zh: "噪音（种树；规避不了就拆最近的工业）", en: "noise (trees; the nearest industry goes if that fails)", expect: goal("RESOLVE_ISSUES", { issue: "NOISE" }), examples: { zh: ["太吵了"], en: ["the homes are too noisy"] } },
  { id: "ruins", zh: "清理废墟", en: "clear ruins", expect: goal("RESOLVE_ISSUES", { issue: "RUINS" }), examples: { zh: ["清理废墟"], en: ["clear the ruins"] } },
  { id: "access", zh: "接上没通路/没接水电的建筑", en: "join buildings with no road, power or water", expect: goal("RESOLVE_ISSUES", { issue: "ACCESS" }), examples: { zh: ["好多房子没接上路"], en: ["buildings are not connected"] } },
  { id: "garbage", zh: "垃圾", en: "garbage", expect: goal("RESOLVE_ISSUES", { issue: "GARBAGE" }), examples: { zh: ["垃圾堆成山了"], en: ["garbage is piling up"] } },
  { id: "deathcare", zh: "殡葬", en: "deathcare", expect: goal("RESOLVE_ISSUES", { issue: "DEATHCARE" }), examples: { zh: ["灵车不够"], en: ["hearse icons everywhere"] } },
  { id: "finance", zh: "财政止血", en: "stop the losses", expect: goal("RESOLVE_ISSUES", { issue: "FINANCE" }), examples: { zh: ["财政亏得厉害，马上止血"], en: ["we are losing money"] } },
  // Roads.
  { id: "road-network", zh: "扩展路网", en: "extend the road network", expect: goal("ESTABLISH_ROAD_NETWORK"), examples: { zh: ["修一下路网"], en: ["extend the road grid"] } },
  { id: "bridge", zh: "跨河连通", en: "connect across water", expect: goal("CONNECT_ACROSS_OBSTACLE"), examples: { zh: ["建一座过河的桥"], en: ["build a bridge across the river"] } },
  { id: "redevelop", zh: "改造旧区", en: "redevelop an old area", expect: goal("REDEVELOP_AREA"), examples: { zh: ["改造旧区"], en: ["redevelop the old area"] } },
  // Limits.
  { id: "no-demolition", zh: "不拆除", en: "no demolition", expect: { forbid: "demolition" }, examples: { zh: ["别拆房子"], en: ["don't demolish anything"] } },
  { id: "no-loan", zh: "不贷款", en: "no loans", expect: { forbid: "loan" }, examples: { zh: ["不要贷款"], en: ["no loans"] } },
  { id: "no-rezone", zh: "不改分区", en: "no rezoning", expect: { forbid: "zoning_change" }, examples: { zh: ["别改分区"], en: ["don't rezone"] } },
  { id: "no-road-change", zh: "不改路", en: "no road changes", expect: { forbid: "road_rebuild" }, examples: { zh: ["别动路"], en: ["don't touch the roads"] } },
  { id: "no-land", zh: "不买地", en: "no land purchase", expect: { forbid: "land_purchase" }, examples: { zh: ["不要买地"], en: ["don't buy land"] } },
  { id: "keep-district", zh: "保护某个命名的区", en: "keep a named district untouched", expect: { preserve: "老城区" }, examples: { zh: ["别动老城区"], en: [] } },
];

/** What cannot be asked for yet: said back to the player as it is, never turned into another task. */
export const NOT_YET: ReadonlyArray<{ zh: string; en: string }> = [
  { zh: "新建公交、地铁、电车线路", en: "new bus, metro or tram lines" },
  { zh: "按要求修火车站、高速、机场、港口、立交桥", en: "a station, highway, airport, port or interchange on request" },
  { zh: "指定税率或某项预算的具体数字", en: "a specific tax rate or budget figure" },
  { zh: "指定某个地标或某栋建筑", en: "a named landmark or building" },
  { zh: "方位以外的具体地点（某条街、某个河湾）", en: "a place that is not a side of the city (a street, a river bend)" },
  { zh: "空气、地面污染的专项治理", en: "dedicated air or ground pollution clean-up" },
  { zh: "宏伟城市规划、复杂交通设施的整体设计", en: "grand city plans or complex transport designs" },
];

/** The capability list as the AI filter reads it (one line each, English: every model reads it). */
export function capabilityLinesForPrompt(): string[] {
  // What the Mayor CAN do is the TYPES and fields above it in the prompt (each capability here maps onto one of them); what it cannot is listed, so the
  // model puts it in unsupported instead of forcing it into the nearest goal. Short on purpose: the prompt is pasted into free AI chats.
  return [`NOT POSSIBLE YET (put in unsupported): ${NOT_YET.map((item) => item.en).join("; ")}.`];
}
