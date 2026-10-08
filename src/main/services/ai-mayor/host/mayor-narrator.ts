/**
 * THE LANGUAGE EXPRESSOR — what the Mayor says on screen (the subtitle), made only from facts the cycle already recorded: the district builder's
 * notes, the finance step's verdict, the player's command. No model call and no claim the facts do not carry: "the road was changed", "waiting for
 * the traffic to settle" and "the traffic got better" are three different facts and are never merged into "solved".
 *
 * The voice (the player's ruling, 2026-10-08): few words, first person, plain statements with the figures in them, a little human but never invented.
 * No map coordinates (a player cannot read them) and no internal building names; several things of one kind in a cycle are one sentence with a count.
 *
 * Pure: the engine decides when to say a line (and not to repeat one); this only turns a fact into a sentence, in the player's language.
 */

export type NarratorLang = "zh" | "en";
export type Tone = "done" | "blocked" | "info" | "warn";
/**
 * `key` is the KIND of line (a family, e.g. "access"): the engine says one line of a kind at most every few minutes, whatever its figures.
 * `many` turns several lines of one kind in one cycle into one sentence with the count.
 */
export interface Line { text: string; tone: Tone; key: string; many?: (count: number) => string }

const SERVICE_ZH: Record<string, string> = { garbage: "垃圾", healthcare: "医疗", deathcare: "殡葬", fire: "消防", police: "治安", education: "教育" };
const SERVICE_EN: Record<string, string> = { garbage: "garbage", healthcare: "healthcare", deathcare: "deathcare", fire: "fire", police: "police", education: "education" };

/** A building as a player calls it, from the game's internal prefab name. */
export function facilityName(prefab: string, lang: NarratorLang): string {
  const table: Array<[RegExp, string, string]> = [
    [/Wind/i, "风力发电机", "wind turbine"], [/Coal/i, "燃煤电厂", "coal plant"], [/Gas|Oil.*Power/i, "燃气电厂", "gas plant"], [/Solar/i, "太阳能电站", "solar plant"],
    [/Nuclear/i, "核电站", "nuclear plant"], [/Hydro|Dam/i, "水电站", "hydro plant"], [/Transformer/i, "变电站", "transformer"], [/Ground ?water/i, "地下水泵站", "groundwater pump"],
    [/WaterPumping|Pumping/i, "水泵站", "water pump"], [/WaterTower|Tower/i, "水塔", "water tower"], [/SewageTreatment|Treatment/i, "污水处理厂", "sewage plant"],
    [/Sewage|Outlet/i, "排污口", "sewage outlet"], [/Clinic/i, "诊所", "clinic"], [/Hospital/i, "医院", "hospital"], [/Police/i, "警察局", "police station"],
    [/Fire/i, "消防站", "fire station"], [/Cemetery/i, "墓地", "cemetery"], [/Crematorium/i, "火葬场", "crematorium"], [/Landfill/i, "垃圾填埋场", "landfill"],
    [/Incinerat/i, "垃圾焚烧厂", "incinerator"], [/Recycl/i, "回收中心", "recycling centre"], [/School|College|University/i, "学校", "school"],
    [/Depot|Maintenance/i, "维护站", "maintenance depot"], [/Train|Rail/i, "火车站", "train station"], [/Park/i, "公园", "park"],
  ];
  const hit = table.find(([pattern]) => pattern.test(prefab));
  return hit ? (lang === "zh" ? hit[1] : hit[2]) : lang === "zh" ? "设施" : "facility";
}

const WAIT_ZH: Record<string, string> = {
  HOUSING_HELD: "现在不缺房子，先不开新住宅区。",
  BATCH_BELOW_ONE_DISTRICT: "手里的钱还不够开一整片区，先让城市赚着。",
  FINANCIAL_RECOVERY: "在止血，暂停扩张，只处理已有的问题。",
  EXPANSION_HELD_BY_PLAYER: "按你说的，不往外扩，只照看现有城市。",
  TREASURY_COVER: "存款撑不起再往外建，先攒一攒。",
  FINANCE_FROZEN: "连着亏了几个月，扩张先冻结，只做维修。",
  LAND_PURCHASE_UNAVAILABLE: "游戏暂时不卖地，要等下一个里程碑。",
  TARGET_REACHED: "人口到目标了，不再往外扩，接下来只维护。",
};
const WAIT_EN: Record<string, string> = {
  HOUSING_HELD: "Homes are not short right now; no new housing district yet.",
  BATCH_BELOW_ONE_DISTRICT: "Not enough cash for a whole district yet; letting the city earn.",
  FINANCIAL_RECOVERY: "Stopping the losses: no expansion, only the city's problems.",
  EXPANSION_HELD_BY_PLAYER: "As you asked: no outward growth, only looking after the city.",
  TREASURY_COVER: "The savings can't carry more building outward yet.",
  FINANCE_FROZEN: "Several months of losses: expansion frozen, repairs only.",
  LAND_PURCHASE_UNAVAILABLE: "The game sells no land until the next milestone.",
  TARGET_REACHED: "Target population reached: no more outward growth.",
};

const num = (value: string | number, lang: NarratorLang) => Number(value).toLocaleString(lang === "zh" ? "zh-CN" : "en-US");

/** One note of a cycle as a sentence, or null when it is bookkeeping a player does not need. */
export function narrateNote(note: string, lang: NarratorLang): Line | null {
  const say = (zh: string, en: string) => (lang === "zh" ? zh : en);
  let m: RegExpExecArray | null;
  if ((m = /^ruins: (\d+) of (\d+) ([a-z ]+?) building\(s\) taken down/.exec(note)) && Number(m[1]) > 0)
    return { key: "ruins", tone: "done", text: say(`拆掉了 ${m[1]} 栋废弃的房子，空出来的地会重新长楼。`, `Took down ${m[1]} derelict building(s); the lots will grow new ones.`) };
  if ((m = /^road access: (.+?) (\d+) m laid to \((-?\d+),(-?\d+)\)/.exec(note)))
    return { key: "access", tone: "done", text: say(`给一栋没通路的建筑修了 ${m[2]} 米路。`, `Laid ${m[2]} m of road to a building that had none.`),
      many: (count) => say(`给 ${count} 栋没通路的建筑接上了路。`, `Joined ${count} buildings to the roads.`) };
  if ((m = /^road access: frontage road to \((-?\d+),(-?\d+)\) — .*?, (\d+) piece/.exec(note)))
    return { key: "access", tone: "done", text: say("给一栋大建筑修了临街路。", "Laid a frontage road to a large building."),
      many: (count) => say(`给 ${count} 栋没通路的建筑接上了路。`, `Joined ${count} buildings to the roads.`) };
  if ((m = /^road access: no (?:frontage )?road the game accepts to \((-?\d+),(-?\d+)\)/.exec(note))) {
    // "blocked by game validation (overlap, wat…" is the Bridge's generic refusal (its list of possible causes cut short), not a finding of water.
    const reason = /blocked by game validation/i.test(note) ? say("会压到别的东西或坡太陡", "an overlap or too steep")
      : /SteepSlope/i.test(note) ? say("坡太陡", "too steep") : /\bwater\b/i.test(note) ? say("挡在水上", "water in the way") : /overlap/i.test(note) ? say("会压到别的东西", "it would overlap something")
      : /EDGE_NOT_IDENTIFIED/.test(note) ? say("游戏认不出接入点", "the game can't find the junction") : say("游戏不让修", "the game refused");
    return { key: "access-blocked", tone: "blocked", text: say(`有栋建筑暂时接不上路（${reason}），过会儿换个走法。`, `A building can't be joined yet (${reason}); another way later.`),
      many: (count) => say(`${count} 栋建筑暂时接不上路，过会儿换个走法。`, `${count} buildings can't be joined yet; other ways later.`) };
  }
  if ((m = /^road access: (.+?) at \((-?\d+),(-?\d+)\) got no road after (\d+) tries; it was placed by this Mayor and is taken down/.exec(note)))
    return { key: "access-removed", tone: "warn", text: say(`我放的${facilityName(m[1]!, lang)}试了 ${m[4]} 次都接不上路，拆了换个地方。`, `My ${facilityName(m[1]!, lang)} got no road after ${m[4]} tries; taken down to go elsewhere.`) };
  if ((m = /^road access: (.+?) at \((-?\d+),(-?\d+)\) got no road; a costly facility is never taken down/.exec(note)))
    return { key: "access-costly", tone: "warn", text: say(`${facilityName(m[1]!, lang)}怎么都接不上路。它太贵我没拆，留给你；接上之前不再建同类。`,
      `The ${facilityName(m[1]!, lang)} can't get a road. Too costly to take down, so it's yours to decide; no other of its kind until it's joined.`) };
  if ((m = /^costly facility held: (\S+): HIGH_VALUE_(COOLDOWN|STRANDED)/.exec(note)))
    return { key: "costly-held", tone: "info", text: m[2] === "COOLDOWN"
      ? say(`${facilityName(m[1]!, lang)}很贵，一天只建一座，明天再说。`, `A ${facilityName(m[1]!, lang)} is costly: one a day, the next tomorrow.`)
      : say(`还有一座${facilityName(m[1]!, lang)}没接上，先不建新的。`, `Another ${facilityName(m[1]!, lang)} isn't joined yet; no new one meanwhile.`) };
  if ((m = /^service (\w+): (\S+) at \((-?\d+),(-?\d+)\) for .*? — (stands|accepted)/.exec(note)))
    return { key: `service:${m[1]}`, tone: "done", text: say(`${SERVICE_ZH[m[1]!] ?? ""}图标扎堆的地方，建了一座${facilityName(m[2]!, lang)}。`, `Built a ${facilityName(m[2]!, lang)} where the ${SERVICE_EN[m[1]!] ?? m[1]} icons gather.`) };
  if ((m = /^service (\w+): icons: (\d+), but the runway does not carry another building/.exec(note)))
    return { key: `service-money:${m[1]}`, tone: "blocked", text: say(`${SERVICE_ZH[m[1]!] ?? m[1]}问题有 ${m[2]} 个，可现在养不起新设施，等钱宽裕些。`, `${m[2]} ${SERVICE_EN[m[1]!] ?? m[1]} icons, but another building's upkeep can't be carried yet.`) };
  if ((m = /^service (\w+): .*but no legal lot near them \((\d+) sites tried/.exec(note)))
    return { key: `service-lot:${m[1]}`, tone: "blocked", text: say(`${SERVICE_ZH[m[1]!] ?? m[1]}设施在问题附近试了 ${m[2]} 个位置，游戏都不让建，还在找。`, `${m[2]} sites near the ${SERVICE_EN[m[1]!] ?? m[1]} icons tried, none allowed; still looking.`) };
  if ((m = /^power: (\d+) dark homes near \((-?\d+),(-?\d+)\): (\d+) generator/.exec(note)) && Number(m[4]) > 0)
    return { key: "power", tone: "done", text: say(`${m[1]} 户断电，在旁边加了 ${m[4]} 台发电设施。`, `${m[1]} homes were dark; added ${m[4]} generator(s) beside them.`) };
  if ((m = /^noise: (\d+) noise icon\(s\) on homes; (\d+) of (\d+) road/.exec(note)) && Number(m[2]) > 0)
    return { key: "noise", tone: "done", text: say(`给 ${m[2]} 条吵的路种了行道树。`, `Planted trees along ${m[2]} noisy road(s).`) };
  if ((m = /^noise: \d+ noise icon\(s\) on homes; the nearest industry, (\S+) at \((-?\d+),(-?\d+)\) (\d+) m from them, was taken down/.exec(note)))
    return { key: "noise-industry", tone: "done", text: say(`住宅旁 ${m[4]} 米的工厂太吵，拆了，那块地不再划工业。`, `The factory ${m[4]} m from the homes was too loud: taken down, its lot no longer industrial.`) };
  if ((m = /^big service (\S+): (\d+) of \d+ building\(s\) taken down at \((-?\d+),(-?\d+)\)/.exec(note)) && Number(m[2]) > 0)
    return { key: "clear", tone: "done", text: say(`${facilityName(m[1]!, lang)}没地方放，拆了 ${m[2]} 栋房子给它腾地。`, `No room for a ${facilityName(m[1]!, lang)}: took down ${m[2]} building(s) to make some.`) };
  if ((m = /^EXPERIMENT service (\w+): bulldozed (\S+) at \((-?\d+),(-?\d+)\) — gone/.exec(note)))
    return { key: "clear", tone: "done", text: say(`${SERVICE_ZH[m[1]!] ?? m[1]}设施没地方放，拆了一栋房子腾地。`, `No lot for the ${SERVICE_EN[m[1]!] ?? m[1]} building: a house was taken down for it.`) };
  if ((m = /^traffic trial: flow (\d+)% → (\d+)% after "(.+?)": (.+)$/.exec(note))) {
    const kept = /kept/.test(m[4]!);
    const better = Number(m[2]) > Number(m[1]);
    return { key: "trial", tone: kept ? "done" : "warn", text: say(
      `改完观察了几个小时：堵点流量 ${m[1]}% → ${m[2]}%，${kept ? (better ? "有改善，留着" : "没变差，留着") : "变差了，已撤回"}。`,
      `Watched it for a few hours: the jam's flow went ${m[1]}% → ${m[2]}%; ${kept ? (better ? "better, kept" : "no worse, kept") : "worse, undone"}.`) };
  }
  if ((m = /^utility link: (.+?) (\d+) m laid from \((-?\d+),(-?\d+)\) to the street for "(.+?)"/.exec(note))) {
    const what = /Cable/i.test(m[1]!) ? say("电缆", "cable") : /Sewage/i.test(m[1]!) ? say("污水管", "sewage pipe") : say("水管", "water pipe");
    return { key: "link", tone: "done", text: say(`给一栋没接上的建筑拉了 ${m[2]} 米${what}。`, `Laid ${m[2]} m of ${what} to a building that wasn't connected.`),
      many: (count) => say(`给 ${count} 栋建筑接上了水电管线。`, `Connected ${count} buildings to power or water.`) };
  }
  if (/^utility link: no (.+?) the game accepts from/.test(note))
    return { key: "link-blocked", tone: "blocked", text: say("有栋建筑的管线这次没拉通，稍后再试。", "A building's line couldn't be laid yet; trying later."),
      many: (count) => say(`${count} 栋建筑的管线这次没拉通，稍后再试。`, `${count} buildings' lines couldn't be laid yet; trying later.`) };
  if ((m = /^traffic: (\d+) of (\d+) bottleneck icon/.exec(note)) && Number(m[1]) > 0)
    return { key: "hotspots", tone: "info", text: say(`地图上 ${m[1]} 个拥堵点对上了具体路段，先从这些路口下手。`, `${m[1]} bottleneck icon(s) matched to their roads; their junctions first.`) };
  if ((m = /^traffic: (.+?) at \((-?\d+),(-?\d+)\) \((\d+)%\): the (.+?) corridor is slow from end to end .*?(\d+) of (\d+) pieces re-laid as (.+?)(?: \(| — )/.exec(note)))
    return { key: "traffic-change", tone: "done", text: say(`一整条路都慢（流量 ${m[4]}%），把其中 ${m[6]} 段升级成了 ${m[8]}，过几小时看效果。`,
      `A whole road was slow (${m[4]}%); ${m[6]} of its pieces upgraded to ${m[8]}, judged in a few hours.`) };
  if ((m = /^traffic: (.+?) at \((-?\d+),(-?\d+)\) \((\d+)%\): (.+?) — done, judged again/.exec(note))) {
    const why = m[5]!;
    const relaid = /re-laid as (.+)$/.exec(why);
    const action = relaid ? say(`把路升级成了 ${relaid[1]}`, `upgraded the road to ${relaid[1]}`)
      : /roundabout/i.test(why) ? say("把路口改成了环岛", "turned the junction into a roundabout")
      : /no ?lights|lights? (off|removed)|hold the arterial/i.test(why) ? say("撤掉了拖慢主路的红绿灯", "removed lights that held the main road")
      : /lights|cross uncontrolled/i.test(why) ? say("在两股大车流交汇处加了红绿灯", "added lights where two heavy streams cross")
      : /widen|lane/i.test(why) ? say("拓宽了路", "widened the road") : say("调整了路口", "changed the junction");
    return { key: "traffic-change", tone: "done", text: say(`一个流量 ${m[4]}% 的堵点：${action}。过几小时复查，变差就撤回。`, `A jam at ${m[4]}% flow: ${action}. Judged in a few hours, undone if worse.`) };
  }
  if (/^traffic: (.+?) at \((-?\d+),(-?\d+)\): (.+?)(?: —|$)/.test(note))
    return { key: "jam", tone: "info", text: say("找到一个堵点，先从它的源头路口改。", "Found a jam; working on its source junction first.") };
  if ((m = /^signature (\S+): placed at/.exec(note)))
    return { key: "signature", tone: "done", text: say(`一座标志性建筑落成了（${m[1]}）。`, `A signature building went up (${m[1]}).`) };
  if ((m = /^electricity: short by (\d+) but no legal site/.exec(note)))
    return { key: "power-short", tone: "blocked", text: say(`电还差 ${num(m[1]!, lang)}，可地图上找不到能建电厂的地方。`, `Power is ${num(m[1]!, lang)} short, but there's no site the game allows for a plant.`) };
  if ((m = /^growth: near the target population \((\d+) of (\d+)\): a new district is cut to (\d+) m2, what the (\d+) people still to come would fill(; that is less than the smallest district, so none is opened)?/.exec(note)))
    return { key: "near-target", tone: "info", text: m[5]
      ? say(`人口 ${num(m[1]!, lang)}，离目标 ${num(m[2]!, lang)} 很近了，不再开新区，让现有的慢慢住满。`, `Population ${num(m[1]!, lang)}, close to the ${num(m[2]!, lang)} target: no new district, the existing ones fill up.`)
      : say(`人口 ${num(m[1]!, lang)}，快到目标 ${num(m[2]!, lang)} 了：新区缩到约 ${num(Math.max(1, Math.round(Number(m[3]) / 10_000)), lang)} 公顷，只够再住 ${num(m[4]!, lang)} 人，免得冲过头。`,
        `Population ${num(m[1]!, lang)}, near the ${num(m[2]!, lang)} target: the next district is cut to about ${num(Math.max(1, Math.round(Number(m[3]) / 10_000)), lang)} ha, room for ${num(m[4]!, lang)} more people, so it doesn't overshoot.`) };
  if ((m = /^train: a (\S+) stands/.exec(note)))
    return { key: "train", tone: "done", text: say("火车站建好了，外面的人可以坐车来了。", "The train station stands; newcomers can arrive by rail.") };
  // The growth policy's reading of what the city lacks, with the numbers it was read from.
  if ((m = /^pipeline: bottleneck (JOBS|HOUSING|MATCH) \(unemployment (\d+)% \((\d+) people\), (\d+) of (\d+) jobs open/.exec(note))) {
    const [, kind, rate, people, free] = m;
    if (kind === "JOBS") return { key: "gap", tone: "info", text: say(`${people} 人没工作（失业 ${rate}%），先建工业，住宅缓一缓。`, `${people} people out of work (${rate}%): industry first, homes can wait.`) };
    if (kind === "HOUSING") return { key: "gap", tone: "info", text: say(`${free} 个岗位空着等人来，下一片建住宅。`, `${free} jobs are waiting for people; the next district is housing.`) };
    return { key: "gap", tone: "info", text: say(`有 ${free} 个空岗，${people} 人却还失业——学历或距离对不上，多建同类没用。`, `${free} jobs open yet ${people} out of work: skills or distance don't fit, more of the same won't help.`) };
  }
  if ((m = /^role (\w+) has no site; held out/.exec(note)))
    return { key: "nosite", tone: "blocked", text: say(`${({ industrial: "工业", commercial: "商业", residential: "住宅" } as Record<string, string>)[m[1]!] ?? m[1]}区在现有土地上找不到合规位置，先做别的。`,
      `No legal site for a ${m[1]} district on the land we have; doing something else.`) };
  if ((m = /^industry: no site (\d+) m from every home; the next search keeps (\d+) m/.exec(note)))
    return { key: "industry-relax", tone: "info", text: say(`离住宅 ${m[1]} 米放不下工业区，下次放宽到 ${m[2]} 米。`, `No room for industry ${m[1]} m from homes; next time ${m[2]} m.`) };
  if ((m = /^unreachable land: (\d+) ways in to tile \S+ were refused; the tile is set aside for (\d+) game hours/.exec(note)))
    return { key: "unreachable", tone: "blocked", text: say(`有块地的入口路连着被拒了 ${m[1]} 次（隔着水或障碍），先放一放，${m[2]} 个游戏小时后再试。`, `The way in to a piece of land was refused ${m[1]} times (water or an obstacle between); set aside, tried again in ${m[2]} game hours.`) };
  if ((m = /^homes: no site (\d+) m from every polluter; the next search keeps (\d+) m/.exec(note)))
    return { key: "homes-relax", tone: "info", text: say(`离工厂 ${m[1]} 米放不下新住宅，下次放宽到 ${m[2]} 米，把空地用起来。`, `No room for homes ${m[1]} m from industry; next time ${m[2]} m, so the free ground gets used.`) };
  if ((m = /^unfilled stock: (\d+) zoned homes stand empty/.exec(note)))
    return { key: "unfilled", tone: "info", text: say(`划好的住宅还空着 ${num(m[1]!, lang)} 格，等住满再开新区，别的照建。`, `${num(m[1]!, lang)} zoned home cells still empty; no new housing until they fill, other uses go on.`) };
  if ((m = /^expansion held: the treasury \((-?\d+)\) covers fewer/.exec(note)))
    return { key: "treasury-cover", tone: "blocked", text: say(`账上 ${num(m[1]!, lang)}，撑不起再往外建，先攒钱。`, `${num(m[1]!, lang)} in the bank can't carry more building outward; saving first.`) };
  return null;
}

/** The waiting reason of a cycle that built nothing outward. */
export function narrateWait(waitReason: string | null | undefined, lang: NarratorLang): Line | null {
  if (!waitReason) return null;
  const supply = /^NO_USABLE_(\w+)_SUPPLY$/.exec(waitReason);
  const lack = supply ? ({ JOBS: ["岗位", "jobs"], HOUSING: ["住房", "homes"], MATCH: ["对口的岗位", "the right jobs"] } as Record<string, [string, string]>)[supply[1]!] : undefined;
  const text = (lang === "zh" ? WAIT_ZH : WAIT_EN)[waitReason] ?? (supply
    ? (lang === "zh" ? `城市缺${lack ? lack[0] : "东西"}，眼下没有合规的地块能建，先处理已有的问题。` : `The city lacks ${lack ? lack[1] : "something"} and no legal site can build it right now; tending the city meanwhile.`) : null);
  // One kind of line for every wait: a city that waits is said to wait once, not once per reason it rotates through.
  return text ? { key: "wait", tone: "info", text } : null;
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
    if ((m = /^restore:(.+):(\d+)$/.exec(id))) return say(`把${BUDGET_ZH[m[1]!] ?? m[1]}预算补回 ${m[2]}%（之前压多了，有楼断电）`, `put the ${m[1]} budget back to ${m[2]}% (it was cut too far; buildings went dark)`);
    if ((m = /^budget:(.+):(\d+)$/.exec(id))) return say(`把${BUDGET_ZH[m[1]!] ?? m[1]}预算降到 ${m[2]}%`, `cut the ${m[1]} budget to ${m[2]}%`);
    if ((m = /^tax:(\w+):(\d+)$/.exec(id))) return say(`把${AREA_ZH[m[1]!] ?? m[1]}税调到 ${m[2]}%`, `set ${m[1]} tax to ${m[2]}%`);
    if (/^connect:/.test(id)) return say("把没接上电网、水网的设施接上", "joined a facility that was off the network");
    if (/^demolish:/.test(id)) return say("拆掉一座多余的设施", "took down a surplus facility");
    if (/^provision:/.test(id)) return say("补了一点水电容量", "added some utility capacity");
    return id;
  };
  const low = /^MEMORY_LOW:([\d.]+)/.exec(status);
  if (low) return { key: "memory-low", tone: "warn", text: say(`电脑内存紧张（只剩约 ${low[1]} GB），游戏可能被系统关掉。建议存个档、重启一下游戏；这段时间我不自动存档。`,
    `The computer is short of memory (about ${low[1]} GB free); the system may close the game. Save and restart it soon; I hold my own saves meanwhile.`) };
  let m = /^V2 finance recovery \w+: \w+ (\S+): (KEEP|UNDO)/.exec(status);
  if (m) {
    const kept = m[2] === "KEEP";
    return { key: "finance", tone: kept ? "done" : "warn", text: say(`${action(m[1]!)}——${kept ? "账本变好了，留着" : "情况变差了，已撤回"}。`, `${action(m[1]!)} — ${kept ? "the books improved, kept" : "things got worse, undone"}.`) };
  }
  m = /balance (-?\d+)\/month.*?\| chose \w+ (\S+):/.exec(status);
  if (m) return { key: "finance", tone: "info", text: say(`每月 ${num(m[1]!, lang)}，先试一步：${action(m[2]!)}，几小时后看效果。`, `${num(m[1]!, lang)} a month; one step first: ${action(m[2]!)}, judged in a few hours.`) };
  if (/finance recovery done at the player's word/.test(status)) return { key: "finance", tone: "done", text: say("账本稳住了，回到原来的节奏。", "The books hold; back to the usual pace.") };
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
 * Lines made from the numbers of the moment (population against the target, the labour market, the books), for the stretches when no cycle has anything
 * new to say. Each carries the figures it reads, so a line is different whenever the city is; the engine never says one twice.
 */
export function narrateSituation(s: Situation, lang: NarratorLang): Line[] {
  const say = (zh: string, en: string) => (lang === "zh" ? zh : en);
  const n = (value: number) => Math.round(value).toLocaleString(lang === "zh" ? "zh-CN" : "en-US");
  const out: Line[] = [];
  if (s.population !== null && s.targetPopulation !== null && s.targetPopulation > s.population) {
    const delta = s.previousPopulation === null ? null : s.population - s.previousPopulation;
    const share = Math.min(100, Math.floor((s.population / s.targetPopulation) * 100));
    out.push({ key: "sit-progress", tone: "info", text: say(
      `人口 ${n(s.population)}${delta === null ? "" : delta === 0 ? "，和上回一样" : `，比上回${delta > 0 ? "多" : "少"}了 ${n(Math.abs(delta))}`}；离目标 ${n(s.targetPopulation)} 还差 ${n(s.targetPopulation - s.population)}（${share}%）。`,
      `Population ${n(s.population)}${delta === null ? "" : delta === 0 ? ", same as last time" : `, ${delta > 0 ? "up" : "down"} ${n(Math.abs(delta))} since last time`}; ${n(s.targetPopulation - s.population)} to the ${n(s.targetPopulation)} target (${share}%).`) });
  }
  if (s.unemploymentPct !== null && s.jobsFree !== null && s.jobsTotal !== null && s.population !== null) {
    const bar = (value: number | null, zh: string, en: string) => value === null ? null : say(`${zh}需求${value >= 100 ? "拉满" : ` ${n(value)}`}`, `${en} demand ${value >= 100 ? "full" : n(value)}`);
    const bars = [bar(s.demand?.industrial ?? null, "工业", "industrial"), bar(s.demand?.commercial ?? null, "商业", "commercial")].filter((x): x is string => x !== null);
    out.push({ key: "sit-labour", tone: "info", text: say(
      `失业 ${Math.round(s.unemploymentPct)}%，${n(s.jobsTotal)} 个岗位空着 ${n(s.jobsFree)} 个${bars.length > 0 ? `；${bars.join("，")}` : ""}。`,
      `Unemployment ${Math.round(s.unemploymentPct)}%, ${n(s.jobsFree)} of ${n(s.jobsTotal)} jobs open${bars.length > 0 ? `; ${bars.join(", ")}` : ""}.`) });
  }
  if (s.treasury !== null && s.monthlyBalance !== null) {
    const months = s.monthlyBalance < 0 ? Math.floor(s.treasury / -s.monthlyBalance) : null;
    out.push({ key: "sit-books", tone: s.monthlyBalance < 0 ? "warn" : "info", text: say(
      `账上 ${n(s.treasury)}，每月${s.monthlyBalance < 0 ? `亏 ${n(-s.monthlyBalance)}${months !== null ? `，照这样能撑 ${months} 个月` : ""}` : `进账 ${n(s.monthlyBalance)}`}。`,
      `${n(s.treasury)} in the bank, ${s.monthlyBalance < 0 ? `losing ${n(-s.monthlyBalance)} a month${months !== null ? `, about ${months} month(s) of runway` : ""}` : `earning ${n(s.monthlyBalance)} a month`}.`) });
  }
  return out;
}

/**
 * The lines worth saying for one cycle: what was done first, then what is blocked, then why it waits. Lines of one kind are merged into one sentence with
 * their count; at most `limit` lines.
 */
export function narrateCycle(input: { notes: readonly string[]; waitReason?: string | null; status?: string | null }, lang: NarratorLang, limit = 2): Line[] {
  const raw = input.notes.map((note) => narrateNote(note, lang)).filter((line): line is Line => line !== null);
  if (input.status === "BUILT") {
    const area = /batch (\d+) m2/.exec(input.notes.find((note) => note.startsWith("V2 ")) ?? "");
    const role = input.notes.map((note) => /^district \(.*?\) \d+x\d+ (\w+):/.exec(note)?.[1]).find(Boolean);
    const hectares = area ? Math.round(Number(area[1]) / 10_000) : null;
    const use = role ? (lang === "zh" ? ({ residential: "住宅", commercial: "商业", industrial: "工业", office: "办公" } as Record<string, string>)[role] ?? "" : role) : "";
    raw.unshift({ key: "district", tone: "done", text: lang === "zh"
      ? `新开了一片${hectares ? `约 ${hectares.toLocaleString("zh-CN")} 公顷的` : ""}${use}区，路和分区都铺好了。`
      : `Opened a new ${use ? `${use} ` : ""}district${hectares ? ` of about ${hectares.toLocaleString("en-US")} ha` : ""}; streets and zoning are down.` });
  }
  // Several lines of one kind in one cycle: one sentence with the count.
  const byKey = new Map<string, Line[]>();
  for (const line of raw) byKey.set(line.key, [...(byKey.get(line.key) ?? []), line]);
  const merged = [...byKey.values()].map((group) => (group.length > 1 && group[0]!.many ? { ...group[0]!, text: group[0]!.many(group.length) } : group[0]!));
  const order: Tone[] = ["done", "warn", "blocked", "info"];
  const sorted = merged.sort((a, b) => order.indexOf(a.tone) - order.indexOf(b.tone));
  const wait = narrateWait(input.waitReason, lang);
  return [...sorted.slice(0, limit), ...(wait && sorted.length < limit ? [wait] : [])];
}
