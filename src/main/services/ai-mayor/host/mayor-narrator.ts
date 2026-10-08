/**
 * THE LANGUAGE EXPRESSOR — what the Mayor says on screen (the subtitle), made only from facts the cycle already recorded: the district builder's
 * notes, the finance step's verdict, the player's command. No model call and no claim the facts do not carry: "the road was changed", "waiting for
 * the traffic to settle" and "the traffic got better" are three different facts and are never merged into "solved".
 *
 * Pure: the engine decides when to say a line (and not to repeat one); this only turns a fact into a sentence, in the player's language.
 */

export type NarratorLang = "zh" | "en";
export type Tone = "done" | "blocked" | "info" | "warn";
export interface Line { text: string; tone: Tone; key: string }

const SERVICE_ZH: Record<string, string> = { garbage: "垃圾", healthcare: "医疗", deathcare: "殡葬", fire: "消防", police: "治安", education: "教育" };
const SERVICE_EN: Record<string, string> = { garbage: "garbage", healthcare: "healthcare", deathcare: "deathcare", fire: "fire", police: "police", education: "education" };

const WAIT_ZH: Record<string, string> = {
  HOUSING_HELD: "住房不是眼下的短板（空房或缺岗位），这轮不开新住宅区",
  BATCH_BELOW_ONE_DISTRICT: "手头的钱不够开一整片新区，先让城市运转攒钱",
  FINANCIAL_RECOVERY: "财政恢复中：暂停扩张，只处理城市已有的问题",
  EXPANSION_HELD_BY_PLAYER: "按你的指令暂停扩张，只处理城市已有的问题",
  TREASURY_COVER: "存款撑不起新的扩张，先不往外建",
  FINANCE_FROZEN: "连续亏损，扩张冻结，只做维修",
  LAND_PURCHASE_UNAVAILABLE: "游戏暂时不卖新地块（要先到下一个里程碑）",
  TARGET_REACHED: "已到目标人口，不再往外扩张，只维护城市",
};
const WAIT_EN: Record<string, string> = {
  HOUSING_HELD: "Housing is not what the city lacks right now; no new residential district this round",
  BATCH_BELOW_ONE_DISTRICT: "Not enough cash for a whole new district; letting the city earn first",
  FINANCIAL_RECOVERY: "Financial recovery: expansion paused, only the city's problems are handled",
  EXPANSION_HELD_BY_PLAYER: "Expansion paused as you asked; only the city's problems are handled",
  TREASURY_COVER: "The treasury cannot carry more expansion yet",
  FINANCE_FROZEN: "Losing money for months: expansion frozen, repairs only",
  LAND_PURCHASE_UNAVAILABLE: "The game does not sell new tiles until the next milestone",
  TARGET_REACHED: "Target population reached: no more outward growth, the city is kept running",
};

const point = (x: string, z: string) => `(${Math.round(Number(x))}, ${Math.round(Number(z))})`;

/** One note of a cycle as a sentence, or null when it is bookkeeping a player does not need. */
export function narrateNote(note: string, lang: NarratorLang): Line | null {
  const say = (zh: string, en: string) => (lang === "zh" ? zh : en);
  let m: RegExpExecArray | null;
  if ((m = /^ruins: (\d+) of (\d+) ([a-z ]+?) building\(s\) taken down/.exec(note)) && Number(m[1]) > 0)
    return { key: "ruins", tone: "done", text: say(`清理废墟：拆掉了 ${m[1]} 栋废弃/坍塌的建筑，空出的地块会重新长出房子`, `Ruins: took down ${m[1]} derelict building(s); the lots will grow new ones`) };
  if ((m = /^road access: (.+?) (\d+) m laid to \((-?\d+),(-?\d+)\)/.exec(note)))
    return { key: `access:${m[3]},${m[4]}`, tone: "done", text: say(`道路连通：给 ${point(m[3]!, m[4]!)} 的建筑修了一条 ${m[2]} 米的接入路`, `Road access: laid a ${m[2]} m road to the building at ${point(m[3]!, m[4]!)}`) };
  if ((m = /^road access: frontage road to \((-?\d+),(-?\d+)\) — .*?, (\d+) piece/.exec(note)))
    return { key: `access:${m[1]},${m[2]}`, tone: "done", text: say(`道路连通：给 ${point(m[1]!, m[2]!)} 的建筑修了临街路（${m[3]} 段）`, `Road access: a frontage road (${m[3]} piece(s)) to ${point(m[1]!, m[2]!)}`) };
  if ((m = /^road access: no (?:frontage )?road the game accepts to \((-?\d+),(-?\d+)\)(?: yet)? \((?:(\d+) course\(s\) dry-run; the game said: )?([^)]*)/.exec(note))) {
    // "blocked by game validation (overlap, wat…" is the Bridge's generic refusal (its list of possible causes cut short), not a finding of water.
    const reason = /blocked by game validation/i.test(note) ? say("游戏校验没通过：会压到别的东西或坡太陡", "the game's check failed: an overlap or too steep")
      : /SteepSlope/i.test(note) ? say("坡太陡", "too steep") : /\bwater\b/i.test(note) ? say("挡在水面上", "water is in the way") : /overlap/i.test(note) ? say("会压到别的东西", "it would overlap something")
      : /EDGE_NOT_IDENTIFIED/.test(note) ? say("游戏认不出接入点", "the game cannot identify the junction") : say("游戏拒绝", "the game refused");
    return { key: `access-blocked:${m[1]},${m[2]}`, tone: "blocked", text: say(`道路连通：${point(m[1]!, m[2]!)} 的建筑暂时接不上路（${m[3] ? `试了 ${m[3]} 种走法，` : ""}${reason}），稍后换条件再试`,
      `Road access: the building at ${point(m[1]!, m[2]!)} cannot be connected yet (${m[3] ? `${m[3]} routes tried, ` : ""}${reason}); trying again later`) };
  }
  if ((m = /^road access: (.+?) at \((-?\d+),(-?\d+)\) got no road after (\d+) tries; it was placed by this Mayor and is taken down/.exec(note)))
    return { key: `access-removed:${m[2]},${m[3]}`, tone: "warn", text: say(`道路连通：市长自己放的 ${m[1]} 试了 ${m[4]} 次都接不上路，已拆除，换地方再建`, `Road access: the Mayor's own ${m[1]} got no road after ${m[4]} tries and was taken down`) };
  if ((m = /^road access: (.+?) at \((-?\d+),(-?\d+)\) got no road; a costly facility is never taken down/.exec(note)))
    return { key: `access-costly:${m[2]},${m[3]}`, tone: "warn", text: say(`道路连通：${m[1]}（${point(m[2]!, m[3]!)}）怎么都接不上路。贵设施不拆，留给你处理；同类设施在它接上之前不会再建`,
      `Road access: ${m[1]} at ${point(m[2]!, m[3]!)} cannot get a road. Costly facilities are not taken down; it is left to you, and no other of its kind is built until it is joined`) };
  if ((m = /^costly facility held: (\S+): HIGH_VALUE_(COOLDOWN|STRANDED)/.exec(note)))
    return { key: `costly-held:${m[1]}`, tone: "info", text: m[2] === "COOLDOWN"
      ? say(`省钱：${m[1]} 很贵，一天之内只建一座贵设施，等下一天再说`, `Saving: ${m[1]} is costly; one costly facility a game day, it waits for the next`)
      : say(`省钱：同类的 ${m[1]} 还有一座没接上，先不建新的`, `Saving: another ${m[1]} still is not joined; no new one meanwhile`) };
  if ((m = /^service (\w+): (\S+) at \((-?\d+),(-?\d+)\) for .*? — (stands|accepted)/.exec(note)))
    return { key: `service:${m[1]}:${m[3]},${m[4]}`, tone: "done", text: say(`${SERVICE_ZH[m[1]!] ?? m[1]}：在问题集中的 ${point(m[3]!, m[4]!)} 建了 ${m[2]}`, `${SERVICE_EN[m[1]!] ?? m[1]}: built ${m[2]} at ${point(m[3]!, m[4]!)} where the icons are`) };
  if ((m = /^service (\w+): icons: (\d+), but the runway does not carry another building/.exec(note)))
    return { key: `service-money:${m[1]}`, tone: "blocked", text: say(`${SERVICE_ZH[m[1]!] ?? m[1]}：有 ${m[2]} 个问题图标，但现在的钱撑不起新设施的维护费，先等财政好转`, `${SERVICE_EN[m[1]!] ?? m[1]}: ${m[2]} icons, but the books cannot carry another building's upkeep yet`) };
  if ((m = /^service (\w+): .*but no legal lot near them \((\d+) sites tried/.exec(note)))
    return { key: `service-lot:${m[1]}`, tone: "blocked", text: say(`${SERVICE_ZH[m[1]!] ?? m[1]}：问题附近试了 ${m[2]} 个位置，游戏都不允许建，继续找`, `${SERVICE_EN[m[1]!] ?? m[1]}: ${m[2]} sites near the icons tried, none allowed; still looking`) };
  if ((m = /^power: (\d+) dark homes near \((-?\d+),(-?\d+)\): (\d+) generator/.exec(note)) && Number(m[4]) > 0)
    return { key: `power:${m[2]},${m[3]}`, tone: "done", text: say(`供电：${point(m[2]!, m[3]!)} 有 ${m[1]} 户断电，在旁边放了 ${m[4]} 台发电设施`, `Power: ${m[1]} dark home(s) near ${point(m[2]!, m[3]!)}; placed ${m[4]} generator(s) beside them`) };
  if ((m = /^noise: (\d+) noise icon\(s\) on homes; (\d+) of (\d+) road/.exec(note)) && Number(m[2]) > 0)
    return { key: "noise", tone: "done", text: say(`噪音：给 ${m[2]} 条吵闹住宅旁的路种上了行道树`, `Noise: planted trees along ${m[2]} road(s) beside noisy homes`) };
  if ((m = /^traffic trial: flow (\d+)% → (\d+)% after "(.+?)": (.+)$/.exec(note))) {
    const kept = /kept/.test(m[4]!);
    const better = Number(m[2]) > Number(m[1]);
    return { key: `trial:${m[3]}`, tone: kept ? "done" : "warn", text: say(
      `交通：改动后观察了几个小时，堵点流量 ${m[1]}% → ${m[2]}%，${kept ? (better ? "有改善，保留" : "没有变差，保留") : "变差了，已撤回"}`,
      `Traffic: after watching for a few hours the jam's flow went ${m[1]}% → ${m[2]}%; ${kept ? (better ? "better, kept" : "no worse, kept") : "worse, undone"}`) };
  }
  if ((m = /^utility link: (.+?) (\d+) m laid from \((-?\d+),(-?\d+)\) to the street for "(.+?)"/.exec(note))) {
    const what = /Cable/i.test(m[1]!) ? say("电缆", "cable") : /Sewage/i.test(m[1]!) ? say("污水管", "sewage pipe") : say("水管", "water pipe");
    return { key: `link:${m[3]},${m[4]}`, tone: "done", text: say(`管线连通：${point(m[3]!, m[4]!)} 的建筑没接上，拉了 ${m[2]} 米${what}到街道`, `Utility link: laid ${m[2]} m of ${what} from the unconnected building at ${point(m[3]!, m[4]!)} to the street`) };
  }
  if ((m = /^utility link: no (.+?) the game accepts from \((-?\d+),(-?\d+)\)/.exec(note)))
    return { key: `link-blocked:${m[2]},${m[3]}`, tone: "blocked", text: say(`管线连通：${point(m[2]!, m[3]!)} 的建筑这次没拉通（游戏拒绝了几种走法），稍后再试`, `Utility link: no route the game accepts from ${point(m[2]!, m[3]!)} yet; trying again later`) };
  if ((m = /^traffic: (\d+) of (\d+) bottleneck icon/.exec(note)) && Number(m[1]) > 0)
    return { key: "hotspots", tone: "info", text: say(`交通：地图上 ${m[1]} 个拥堵图标已对应到具体路段，先查这些路口`, `Traffic: ${m[1]} bottleneck icon(s) matched to their roads; their junctions go first`) };
  if ((m = /^traffic: (.+?) at \((-?\d+),(-?\d+)\) \((\d+)%\): the (.+?) corridor is slow from end to end .*?(\d+) of (\d+) pieces re-laid as (.+?)(?: \(| — )/.exec(note)))
    return { key: `corridor:${m[2]},${m[3]}`, tone: "done", text: say(`交通：${point(m[2]!, m[3]!)} 一带整条路都慢（流量 ${m[4]}%），把 ${m[7]} 段里的 ${m[6]} 段原地升级为${m[8]}，几小时后复查`,
      `Traffic: the whole ${m[5]} near ${point(m[2]!, m[3]!)} is slow (${m[4]}%); ${m[6]} of ${m[7]} pieces upgraded to ${m[8]}, judged again in a few hours`) };  if ((m = /^traffic: (.+?) at \((-?\d+),(-?\d+)\) \((\d+)%\): (.+?) — done, judged again/.exec(note))) {
    const why = m[5]!;
    const action = /re-laid as (.+)$/.exec(why) ? say(`把路升级为 ${/re-laid as (.+)$/.exec(why)![1]}`, `upgraded the road to ${/re-laid as (.+)$/.exec(why)![1]}`)
      : /roundabout/i.test(why) ? say("把路口改成了环岛（车辆减速通过，不用停车等灯）", "turned the junction into a roundabout (traffic slows instead of stopping)")
      : /no ?lights|lights? (off|removed)|hold the arterial/i.test(why) ? say("撤掉了拖慢主干道的红绿灯", "removed traffic lights that held the arterial")
      : /lights|cross uncontrolled/i.test(why) ? say("在两股大车流交汇处加了红绿灯", "added traffic lights where two heavy streams cross")
      : /widen|lane/i.test(why) ? say("拓宽了道路", "widened the road") : say("调整了路口", "changed the junction");
    return { key: `traffic-change:${m[2]},${m[3]}`, tone: "done", text: say(`交通：在 ${point(m[2]!, m[3]!)}（流量 ${m[4]}%）${action}，几小时后复查，变差就撤回`, `Traffic: at ${point(m[2]!, m[3]!)} (flow ${m[4]}%) ${action}; judged again in a few hours, undone if worse`) };
  }  if ((m = /^traffic: (.+?) at \((-?\d+),(-?\d+)\): (.+?)(?: —|$)/.exec(note)))
    return { key: `jam:${m[2]},${m[3]}`, tone: "info", text: say(`交通：找到堵点 ${point(m[2]!, m[3]!)}（${m[1]}），从源头路口下手，改完会观察效果`, `Traffic: found the jam at ${point(m[2]!, m[3]!)} (${m[1]}); working on its source junction, then watching the effect`) };
  if ((m = /^signature (\S+): placed at \((-?\d+),(-?\d+)\)/.exec(note)))
    return { key: `signature:${m[1]}`, tone: "done", text: say(`标志性建筑：${m[1]} 建在了 ${point(m[2]!, m[3]!)}`, `Signature building: ${m[1]} placed at ${point(m[2]!, m[3]!)}`) };
  if ((m = /^electricity: short by (\d+) but no legal site/.exec(note)))
    return { key: "power-short", tone: "blocked", text: say(`供电：还差 ${m[1]} 的电力，但地图上找不到游戏允许的电厂位置`, `Power: short by ${m[1]}, but the game allows no power plant site`) };
  if ((m = /^growth: near the target population \((\d+) of (\d+)\): a new district is cut to (\d+) m2, what the (\d+) people still to come would fill(; that is less than the smallest district, so none is opened)?/.exec(note)))
    return { key: `near-target:${m[5] ? "stop" : "cut"}`, tone: "info", text: m[5]
      ? say(`人口 ${Number(m[1]).toLocaleString("zh-CN")}，快到目标 ${Number(m[2]).toLocaleString("zh-CN")} 了：剩下的名额装不下一个新区，不再开新区，让现有的区慢慢住满`,
        `Population ${Number(m[1]).toLocaleString("en-US")} is near the target ${Number(m[2]).toLocaleString("en-US")}: what is left cannot fill a district, so no new one is opened; the existing ones fill up`)
      : say(`人口 ${Number(m[1]).toLocaleString("zh-CN")}，快到目标 ${Number(m[2]).toLocaleString("zh-CN")} 了：新区缩小到 ${Number(m[3]).toLocaleString("zh-CN")} 平方米，只够再住 ${Number(m[4]).toLocaleString("zh-CN")} 人，避免冲过头`,
        `Population ${Number(m[1]).toLocaleString("en-US")} is near the target ${Number(m[2]).toLocaleString("en-US")}: the next district is cut to ${Number(m[3]).toLocaleString("en-US")} m2, room for the ${Number(m[4]).toLocaleString("en-US")} people still to come, so it does not overshoot`) };  if ((m = /^train: a (\S+) stands/.exec(note)))
    return { key: "train", tone: "done", text: say(`铁路：${m[1]} 已建成`, `Rail: ${m[1]} stands`) };
  // The growth policy's reading of what the city lacks, with the numbers it was read from.
  if ((m = /^pipeline: bottleneck (JOBS|HOUSING|MATCH) \(unemployment (\d+)% \((\d+) people\), (\d+) of (\d+) jobs open/.exec(note))) {
    const [, kind, rate, people, free, total] = m;
    if (kind === "JOBS") return { key: "gap-jobs", tone: "info", text: say(`缺的是岗位：${people} 人找不到工作（失业率 ${rate}%），${total} 个岗位只剩 ${free} 个空位。所以先找地方放工业，住宅暂时不再加`,
      `Jobs are the gap: ${people} people are out of work (${rate}%), only ${free} of ${total} jobs are open. Industry first; no more homes for now`) };
    if (kind === "HOUSING") return { key: "gap-housing", tone: "info", text: say(`缺的是住房：失业率只有 ${rate}%，${total} 个岗位里有 ${free} 个空着等人搬来，下一片开住宅`,
      `Homes are the gap: unemployment is only ${rate}% and ${free} of ${total} jobs wait for residents; the next district is housing`) };
    return { key: "gap-match", tone: "info", text: say(`岗位和人对不上：有 ${free} 个空岗，但 ${people} 人仍然失业（学历或距离不合），再多建同类也没用`,
      `Jobs and people do not fit: ${free} jobs stand open yet ${people} are out of work (skills or distance); more of the same would not help`) };
  }
  if ((m = /^role (\w+) has no site; held out/.exec(note)))
    return { key: `nosite:${m[1]}`, tone: "blocked", text: say(`${({ industrial: "工业", commercial: "商业", residential: "住宅" } as Record<string, string>)[m[1]!] ?? m[1]}区在已有的地块里找不到合规位置，几个游戏小时内先做别的`,
      `No legal site for a ${m[1]} district on the owned land; doing something else for a few game hours`) };
  if ((m = /^industry: no site (\d+) m from every home; the next search keeps (\d+) m/.exec(note)))
    return { key: `industry-relax:${m[2]}`, tone: "info", text: say(`工业区离住宅 ${m[1]} 米找不到位置，下次放宽到 ${m[2]} 米再找`, `No industrial site ${m[1]} m from every home; the next search accepts ${m[2]} m`) };
  if ((m = /^unfilled stock: (\d+) zoned homes stand empty/.exec(note)))
    return { key: "unfilled", tone: "info", text: say(`已经划好的住宅还空着 ${m[1]} 格，等居民搬进去再开新的住宅区；别的用途照常建`, `${m[1]} zoned home cells still stand empty; no new housing until they fill, other uses go on`) };
  if ((m = /^expansion held: the treasury \((-?\d+)\) covers fewer/.exec(note)))
    return { key: "treasury-cover", tone: "blocked", text: say(`国库 ${Number(m[1]).toLocaleString("zh-CN")}，撑不起再往外建的维护费，先攒钱`, `Treasury ${Number(m[1]).toLocaleString("en-US")} cannot carry more outward building; saving first`) };
  return null;
}

/** What the city looks like right now, read by the engine (null: not read). */
export interface Situation {
  population: number | null; targetPopulation: number | null; previousPopulation: number | null;
  treasury: number | null; monthlyBalance: number | null;
  unemploymentPct: number | null; jobsFree: number | null; jobsTotal: number | null;
  demand: { residential: number | null; commercial: number | null; industrial: number | null } | null;
}

/**
 * Lines made from the numbers of the moment (population against the target, the labour market, the game's demand bars, the books), for the stretches
 * when no cycle has anything new to say. Each carries the figures it reads, so a line is different whenever the city is; the engine never says one twice.
 */
export function narrateSituation(s: Situation, lang: NarratorLang): Line[] {
  const say = (zh: string, en: string) => (lang === "zh" ? zh : en);
  const n = (value: number) => Math.round(value).toLocaleString(lang === "zh" ? "zh-CN" : "en-US");
  const out: Line[] = [];
  if (s.population !== null && s.targetPopulation !== null && s.targetPopulation > s.population) {
    const delta = s.previousPopulation === null ? null : s.population - s.previousPopulation;
    const share = Math.min(100, Math.floor((s.population / s.targetPopulation) * 100));
    out.push({ key: "sit-progress", tone: "info", text: say(
      `人口 ${n(s.population)}${delta === null ? "" : delta === 0 ? "，和上次一样" : `，比上次${delta > 0 ? "多" : "少"}了 ${n(Math.abs(delta))}`}；离目标 ${n(s.targetPopulation)} 还差 ${n(s.targetPopulation - s.population)}（${share}%）`,
      `Population ${n(s.population)}${delta === null ? "" : delta === 0 ? ", unchanged" : `, ${delta > 0 ? "up" : "down"} ${n(Math.abs(delta))} since last look`}; ${n(s.targetPopulation - s.population)} short of the ${n(s.targetPopulation)} target (${share}%)`) });
  }
  if (s.unemploymentPct !== null && s.jobsFree !== null && s.jobsTotal !== null && s.population !== null) {
    const bar = (value: number | null, zh: string, en: string) => value === null ? null : say(`${zh}需求条${value >= 100 ? "已拉满" : `只有 ${n(value)}`}`, `${en} demand ${value >= 100 ? "is full" : `is only ${n(value)}`}`);
    const bars = [bar(s.demand?.industrial ?? null, "工业", "industrial"), bar(s.demand?.commercial ?? null, "商业", "commercial")].filter((x): x is string => x !== null);
    out.push({ key: "sit-labour", tone: "info", text: say(
      `劳动力：失业率 ${Math.round(s.unemploymentPct)}%，${n(s.jobsTotal)} 个岗位里空着 ${n(s.jobsFree)} 个${bars.length > 0 ? `；游戏的${bars.join("，")}` : ""}`,
      `Labour: unemployment ${Math.round(s.unemploymentPct)}%, ${n(s.jobsFree)} of ${n(s.jobsTotal)} jobs open${bars.length > 0 ? `; the game's ${bars.join(", ")}` : ""}`) });
  }
  if (s.treasury !== null && s.monthlyBalance !== null) {
    const months = s.monthlyBalance < 0 ? Math.floor(s.treasury / -s.monthlyBalance) : null;
    out.push({ key: "sit-books", tone: s.monthlyBalance < 0 ? "warn" : "info", text: say(
      `账上 ${n(s.treasury)}，每月${s.monthlyBalance < 0 ? `亏 ${n(-s.monthlyBalance)}${months !== null ? `，照这个速度约撑 ${months} 个月` : ""}` : `赚 ${n(s.monthlyBalance)}`}`,
      `Treasury ${n(s.treasury)}, ${s.monthlyBalance < 0 ? `losing ${n(-s.monthlyBalance)} a month${months !== null ? `, about ${months} month(s) of runway` : ""}` : `earning ${n(s.monthlyBalance)} a month`}`) });
  }
  return out;
}

/** The waiting reason of a cycle that built nothing outward. */
export function narrateWait(waitReason: string | null | undefined, lang: NarratorLang): Line | null {
  if (!waitReason) return null;
  const supply = /^NO_USABLE_(\w+)_SUPPLY$/.exec(waitReason);
  const lack = supply ? ({ JOBS: ["岗位", "jobs"], HOUSING: ["住房", "homes"], MATCH: ["岗位与人的匹配", "a job-skill fit"] } as Record<string, [string, string]>)[supply[1]!] : undefined;
  const text = (lang === "zh" ? WAIT_ZH : WAIT_EN)[waitReason] ?? (supply
    ? (lang === "zh" ? `城市缺${lack ? lack[0] : "的东西"}，但眼下没有能建它的合规地块，先把已有的问题处理掉` : `The city lacks ${lack ? lack[1] : "something"} but no legal site can build it right now; tending existing problems`) : null);
  return text ? { key: `wait:${waitReason}`, tone: "info", text } : null;
}

const BUDGET_ZH: Record<string, string> = { Electricity: "电力", "Health & Deathcare": "医疗殡葬", "Water & Sewage": "水务", "Garbage Management": "垃圾处理", Roads: "道路维护",
  "Police & Administration": "治安", "Fire & Rescue": "消防", Transportation: "交通", "Education & Research": "教育" };
const AREA_ZH: Record<string, string> = { Residential: "住宅", Commercial: "商业", Industrial: "工业", Office: "办公" };

/** One finance-recovery step's status line: the action taken and its verdict. */
export function narrateStatus(status: string, lang: NarratorLang): Line | null {
  return narrateFinance(status, lang);
}

export function narrateFinance(status: string, lang: NarratorLang): Line | null {
  const say = (zh: string, en: string) => (lang === "zh" ? zh : en);
  const action = (id: string) => {
    let m: RegExpExecArray | null;
    if ((m = /^restore:(.+):(\d+)$/.exec(id))) return say(`把${BUDGET_ZH[m[1]!] ?? m[1]}预算补回到 ${m[2]}%（之前压多了，有楼断电）`, `put the ${m[1]} budget back up to ${m[2]}% (it was cut too far; buildings went dark)`);
    if ((m = /^budget:(.+):(\d+)$/.exec(id))) return say(`把${BUDGET_ZH[m[1]!] ?? m[1]}预算降到 ${m[2]}%`, `cut the ${m[1]} budget to ${m[2]}%`);
    if ((m = /^tax:(\w+):(\d+)$/.exec(id))) return say(`把${AREA_ZH[m[1]!] ?? m[1]}税调到 ${m[2]}%`, `set ${m[1]} tax to ${m[2]}%`);
    if (/^connect:/.test(id)) return say("把没接上电网/水网的设施接上", "connect a facility that is off the network");
    if (/^demolish:/.test(id)) return say("拆掉一座多余的设施", "take down a surplus facility");
    if (/^provision:/.test(id)) return say("补一点水电容量", "add some utility capacity");
    return id;
  };
  const low = /^MEMORY_LOW:([\d.]+)/.exec(status);
  if (low) return { key: "memory-low", tone: "warn", text: say(`电脑内存紧张（可用约 ${low[1]} GB）：游戏占用很大，系统可能把它关掉。建议先存档，再重启一次游戏；市长暂时不再自动存档以免加重。`,
    `The computer is short of memory (about ${low[1]} GB free): the game is large and the system may close it. Save and restart the game soon; the Mayor holds its own saves meanwhile.`) };
  let m = /^V2 finance recovery \w+: \w+ (\S+): (KEEP|UNDO)/.exec(status);
  if (m) {
    const kept = m[2] === "KEEP";
    return { key: `finance:${m[1]}:${m[2]}`, tone: kept ? "done" : "warn", text: say(`财政：${action(m[1]!)}——${kept ? "观察后账本变好，保留" : "观察后情况变差，已撤回"}`,
      `Finances: ${action(m[1]!)} — ${kept ? "the books improved, kept" : "things got worse, undone"}`) };
  }
  m = /balance (-?\d+)\/month.*?\| chose \w+ (\S+):/.exec(status);
  if (m) return { key: `finance-try:${m[2]}`, tone: "info", text: say(`财政：每月 ${Number(m[1]).toLocaleString("zh-CN")}，先试一步：${action(m[2]!)}，几个小时后看效果`,
    `Finances: ${Number(m[1]).toLocaleString("en-US")} a month; trying one step: ${action(m[2]!)}, judged in a few hours`) };
  if (/finance recovery done at the player's word/.test(status)) return { key: "finance-done", tone: "done", text: say("财政：账本稳住了，恢复原来的模式", "Finances: the books hold; back to the usual mode") };
  return null;
}

/** The lines worth saying for one cycle: what was done first, then what is blocked, then why it waits. At most `limit`. */
export function narrateCycle(input: { notes: readonly string[]; waitReason?: string | null; status?: string | null }, lang: NarratorLang, limit = 3): Line[] {
  const lines = input.notes.map((note) => narrateNote(note, lang)).filter((line): line is Line => line !== null);
  if (input.status === "BUILT") {
    const area = /batch (\d+) m2/.exec(input.notes.find((note) => note.startsWith("V2 ")) ?? "");
    const hectares = area ? Math.round(Number(area[1]) / 10_000) : null;
    lines.unshift({ key: `district:${hectares ?? ""}`, tone: "done", text: lang === "zh"
      ? `扩张：新开了一片区${hectares ? `，约 ${hectares.toLocaleString("zh-CN")} 公顷` : ""}，路网和分区都已铺好`
      : `Expansion: a new district${hectares ? ` of about ${hectares.toLocaleString("en-US")} ha` : ""}, streets and zoning laid` });
  }
  const order: Tone[] = ["done", "warn", "blocked", "info"];
  const sorted = lines.sort((a, b) => order.indexOf(a.tone) - order.indexOf(b.tone));
  const unique = sorted.filter((line, index) => sorted.findIndex((other) => other.key === line.key) === index);
  const wait = narrateWait(input.waitReason, lang);
  return [...unique.slice(0, limit), ...(wait && unique.length < limit ? [wait] : [])];
}
