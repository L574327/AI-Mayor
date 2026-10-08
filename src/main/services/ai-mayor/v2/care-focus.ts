/**
 * CARE FOCUS — what a player's sentence about the city's problems ("too noisy", "fix the traffic", "ruins everywhere", "make it livable") asks the
 * Mayor to see to, and what the Mayor does about each, in the player's words.
 *
 * The goal vocabulary carries it: IMPROVE_TRAFFIC, PROVIDE_SERVICE (police, fire, healthcare) and RESOLVE_ISSUES with `scope.issues`. A focus does
 * not invent a new machine: it puts the matching answer of the cycle's own care round first and past its usual waits (`district-builder.ts`
 * provideServices, `road-care.ts`). Each issue's answer is the game's own (the cs2 wiki notification list and traffic/pollution pages):
 *   TRAFFIC    the jam's head intersection: lights off where they hold an arterial for side streets, lights where two heavy streams cross, a two-lane
 *              road carrying arterial traffic re-laid one size up in place (never when a building would go); each change judged again and taken
 *              back if worse
 *   NOISE      road noise: trees on the road beside the noisy homes, sound barriers on a highway; and the traffic that makes it
 *   RUINS      burned-down, collapsed and abandoned buildings bulldozed (the game's own fix); the zoned lot grows a new one
 *   ACCESS     a road from the lot to the nearest street where the game says a building has no road / car access
 *   CRIME      a police station where the crime scenes gather
 *   FIRE       a fire station where buildings burned
 *   HEALTH     a clinic where citizens wait for an ambulance
 *   DEATHCARE  a cemetery where citizens wait for a hearse
 *   FINANCE    the player said the city loses money: the mature finance loop (`finance-recovery.ts`) takes the lead at once — growth stops, measured reversible steps
 *              (service budgets, taxes, unattached facilities) until the books hold, then the previous mode returns by itself. The player's word outranks the growth path
 *   GARBAGE    a landfill on free land beside a street, kept away from homes (`GARBAGE_HOME_BUFFER_METERS`), where garbage notices pile up
 */
import type { MayorStructuredGoalIntent } from "../types";
import type { ServiceNeed } from "./district-services";

export type CareFocus = "TRAFFIC" | "NOISE" | "RUINS" | "ACCESS" | "CRIME" | "FIRE" | "HEALTH" | "DEATHCARE" | "GARBAGE" | "FINANCE" | "EDUCATION";
export const CARE_ISSUES: readonly CareFocus[] = ["TRAFFIC", "NOISE", "RUINS", "ACCESS", "CRIME", "FIRE", "HEALTH", "DEATHCARE", "GARBAGE", "FINANCE"];
/** The issues the Mayor answers by a write today. */
export const ANSWERED_ISSUES: ReadonlySet<CareFocus> = new Set<CareFocus>(["TRAFFIC", "NOISE", "RUINS", "ACCESS", "CRIME", "FIRE", "HEALTH", "DEATHCARE", "GARBAGE", "FINANCE"]);

export const SERVICE_FOCUS: Readonly<Record<ServiceNeed, CareFocus>> = { deathcare: "DEATHCARE", healthcare: "HEALTH", police: "CRIME", fire: "FIRE", roads: "TRAFFIC", garbage: "GARBAGE", education: "EDUCATION" };

/** The problems a goal names, or null for a goal that is not about the city's problems (expansion, utilities, ...). */
export function careFocusFrom(intent: MayorStructuredGoalIntent | null | undefined): CareFocus[] | null {
  if (!intent) return null;
  if (intent.type === "IMPROVE_TRAFFIC") return ["TRAFFIC"];
  if (intent.type === "PROVIDE_SERVICE") {
    const kind = intent.scope?.serviceKind;
    return kind === "POLICE" ? ["CRIME"] : kind === "FIRE" ? ["FIRE"] : kind === "HEALTHCARE" ? ["HEALTH"] : null;
  }
  if (intent.type === "RESOLVE_ISSUES") {
    const issues = ((intent.scope?.issues ?? []) as readonly string[]).filter((issue): issue is CareFocus => (CARE_ISSUES as readonly string[]).includes(issue));
    // "All the problems" is not "stop the bleeding": finance (growth stops, the recovery loop leads) only when the player names it.
    return issues.length > 0 ? [...new Set(issues)] : CARE_ISSUES.filter((issue) => issue !== "FINANCE");
  }
  return null;
}

const PLAN: Readonly<Record<CareFocus, { zh: string; en: string }>> = {
  TRAFFIC: { zh: "交通：找到拥堵的源头路口，按机制处理——给干道让路的多余红绿灯撤掉、两股大车流交汇处加红绿灯、扛着干道车流的双车道原地升一级（拆房子就不做）；每次改动几小时后回读，变差就撤回",
    en: "traffic: find the intersection where the jam starts and fix it by the game's mechanics — lights off where they hold an arterial for side streets, lights where two heavy streams cross, a two-lane road carrying arterial traffic re-laid one size up in place (never if a building would go); each change is judged again and taken back if worse" },
  NOISE: { zh: "噪音：给噪音住宅旁边的道路种行道树（高速加隔音墙），同时治理制造噪音的车流",
    en: "noise: trees on the roads beside the noisy homes (sound barriers on highways), and the traffic that makes the noise" },
  RUINS: { zh: "废墟：拆掉烧毁、坍塌、废弃的建筑，地块会自己长出新房子", en: "ruins: burned-down, collapsed and abandoned buildings are bulldozed; their zoned lots grow new ones" },
  ACCESS: { zh: "道路连通：给提示“无道路/无车辆通行”的建筑修一条接到最近街道的路", en: "access: a road from each building the game marks without road or car access to the nearest street" },
  CRIME: { zh: "治安：在犯罪现场聚集的地方建警察局", en: "crime: a police station where the crime scenes gather" },
  FIRE: { zh: "消防：在建筑被烧毁的地方建消防站", en: "fire: a fire station where buildings burned" },
  HEALTH: { zh: "医疗：在等救护车的地方建诊所", en: "healthcare: a clinic where citizens wait for an ambulance" },
  DEATHCARE: { zh: "殡葬：在等灵车的地方建墓地", en: "deathcare: a cemetery where citizens wait for a hearse" },
  FINANCE: { zh: "财政：城市在亏钱——暂停扩张，按已有的止血流程小步、可撤回地调整（过剩的服务预算、税率、没接上网络的设施），账本稳住后自动恢复原来的模式", en: "finance: the city loses money — growth pauses and the existing recovery loop takes small, reversible steps (surplus service budgets, taxes, unattached facilities); the previous mode returns once the books hold" },
  GARBAGE: { zh: "垃圾：在远离住宅、靠街的空地上建垃圾填埋场", en: "garbage: a landfill on free land beside a street, away from homes" },
  EDUCATION: { zh: "教育：高学历岗位空着等人时，建中学/学院/大学，让居民学历跟上岗位", en: "education: while jobs for educated workers stand open, schools, a college and a university so the citizens' schooling catches up with the jobs" },
};

/** What the Mayor will do about each named problem, for the player to read when they ask. */
export function describeCarePlan(focus: readonly CareFocus[], lang: "zh" | "en"): string[] {
  return focus.map((issue) => PLAN[issue][lang]);
}
