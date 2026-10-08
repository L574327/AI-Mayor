export type MayorEventType =
  | "PREPARE" | "ACT_START" | "ACT_SUCCESS" | "ACT_REJECT_RETRY" | "ACT_TERMINAL_FAIL"
  | "WAIT" | "PAUSE_ISSUE" | "RESUME" | "HARD_STOP" | "BLOCK_COMPLETE"
  | "DEMAND_CHANGE" | "POPULATION_CHANGE" | "LAND_NOT_FOUND" | "SERVICE_LOW" | "SERVICE_RESTORED";
export type MayorTone = "CASUAL" | "NEUTRAL" | "SERIOUS" | "CRITICAL";
export type MayorSubject = "ROAD" | "GRID" | "WATER" | "ELECTRICITY" | "SEWAGE" |
  "RESIDENTIAL" | "COMMERCIAL" | "INDUSTRIAL" | "OFFICE" | "GENERIC";

/** A fact-only event. Values are semantic keys and are never printed verbatim. */
export interface MayorEvent {
  eventType: MayorEventType;
  toneHint: MayorTone;
  subjectDomain: MayorSubject;
  observationKey?: "grid-aligned" | "demand-elevated" | "service-below-need" | "no-safe-land" | "world-uncertain";
  actionKey?: "prepare-grid" | "extend-grid" | "build-road" | "provide-service" | "wait-for-world" | "stop-expansion" | "resume-work";
  reasonKey?: "safe-expansion-window" | "candidate-refused" | "city-needs-service" | "no-legal-site" | "authoritative-uncertain" | "growth-condition-blocks";
  resultKey?: "road-confirmed" | "batch-complete" | "alternatives-exhausted" | "service-restored";
  continuityRef?: string;
}

export interface MayorCommentaryLine {
  text: string;
  tone: MayorTone;
  emittedAt: string;
}

type PhraseSlots = { observation: string[]; action: string[]; reason: string[]; result: string[]; ending: string[] };
const PHRASES: Record<MayorSubject, PhraseSlots> = {
  ROAD: { observation: ["路网这边", "这段路", "前面的路网"], action: ["先把路接上", "再往前接一段", "接着往外修"], reason: ["让这片地能用", "把街区接起来"], result: ["这段接上了", "路已经通了"], ending: ["先这样。", "行，接上了。"] },
  GRID: { observation: ["这片地挺平", "网格方向已经定了", "接着上次那片网格"], action: ["按网格往外接", "横平竖直地铺开", "照这个方向再修一段"], reason: ["规规矩矩来", "后面接起来省事"], result: ["这段对齐了", "网格接上了"], ending: ["行，开工。", "先接到这儿。"] },
  WATER: { observation: ["供水这边", "水网这边", "这片用水"], action: ["先补上供水", "把水网接起来", "先处理供水"], reason: ["现有供水跟不上", "先把服务稳住"], result: ["供水接上了", "水网恢复了"], ending: ["先稳住。", "这步完成了。"] },
  ELECTRICITY: { observation: ["电力这边", "这片用电", "供电网络"], action: ["先补上电力", "把电网接起来", "先处理供电"], reason: ["现有供电跟不上", "先把服务稳住"], result: ["电力接上了", "供电恢复了"], ending: ["先稳住。", "这步完成了。"] },
  SEWAGE: { observation: ["污水处理这边", "这片污水", "污水网络"], action: ["先补上处理能力", "把污水网接起来", "先处理污水"], reason: ["现有处理跟不上", "先把服务稳住"], result: ["污水接上了", "处理恢复了"], ending: ["先稳住。", "这步完成了。"] },
  RESIDENTIAL: { observation: ["住宅这边", "这片居住区", "这块地"], action: ["先准备一片住宅", "给住宅再留点地方", "把这片接着发展"], reason: ["还有合适的地", "先留一片发展空间"], result: ["住宅这片准备好了", "这片已经接上"], ending: ["先做一小片。", "行，接着来。"] },
  COMMERCIAL: { observation: ["商业这边", "这片街区", "这块地"], action: ["先准备一片商业", "给商业留点位置", "把这片接着发展"], reason: ["需求起来了", "现有街区接得上"], result: ["商业这片准备好了", "这片已经接上"], ending: ["先做一小片。", "行，接着来。"] },
  INDUSTRIAL: { observation: ["工业这边", "这片用地", "这块地"], action: ["先准备一片工业用地", "把工业区往外接", "给工业留出空间"], reason: ["现有条件允许", "先把用地接起来"], result: ["工业这片准备好了", "这片已经接上"], ending: ["先做一小片。", "行，接着来。"] },
  OFFICE: { observation: ["办公这边", "这片办公区", "这块地"], action: ["先准备一片办公用地", "给办公留点位置", "把这片接着发展"], reason: ["办公需求起来了", "现有街区接得上"], result: ["办公这片准备好了", "这片已经接上"], ending: ["先做一小片。", "行，接着来。"] },
  GENERIC: { observation: ["这边", "眼下", "这片"], action: ["先处理当前的问题", "先把这一步做完", "先稳住再继续"], reason: ["还需要再看一眼", "得先确认清楚"], result: ["这步完成了", "情况已经恢复"], ending: ["先这样。", "我接着看。"] },
};

const CRITICAL_LINES: Record<MayorEventType, string> = {
  PREPARE: "当前状态无法确认，我先停止施工。",
  ACT_START: "当前施工结果无法确认，我先停止后续操作。",
  ACT_SUCCESS: "施工结果无法确认，我不会重复提交。",
  ACT_REJECT_RETRY: "施工方案被拒，我先停止后续操作并重新确认。",
  ACT_TERMINAL_FAIL: "施工未能确认完成，我先停下，不会重复提交。",
  WAIT: "当前世界状态尚未确认，我先停止施工，等待重新读取。",
  PAUSE_ISSUE: "检测到安全问题，我已停止施工，不会继续扩张。",
  RESUME: "世界状态已重新确认，可以继续施工。",
  HARD_STOP: "施工结果无法确认。为避免重复效果，我已停止后续操作。",
  BLOCK_COMPLETE: "施工结果无法确认，我不会继续执行。",
  DEMAND_CHANGE: "世界状态无法确认，我已停止后续操作。",
  POPULATION_CHANGE: "世界状态无法确认，我已停止后续操作。",
  LAND_NOT_FOUND: "可建设土地状态无法确认，我已停止施工。",
  SERVICE_LOW: "服务状态无法确认，我已停止扩张。",
  SERVICE_RESTORED: "服务状态无法确认，我已停止后续操作。",
};

const lastByStream = new Map<string, string>();
const recentByStream = new Map<string, string[]>();
const recentRenderedLines: string[] = [];
const counts = new Map<string, number>();
const pick = (values: string[], index: number) => values[index % values.length] ?? "";

/** Deterministic local phrase composition with per-stream throttling and five-line de-duplication. */
export function renderMayorEvent(event: MayorEvent, emittedAt = new Date().toISOString()): MayorCommentaryLine | null {
  const stream = `${event.eventType}|${event.subjectDomain}`;
  const semanticKey = `${event.observationKey ?? ""}|${event.actionKey ?? ""}|${event.reasonKey ?? ""}|${event.resultKey ?? ""}`;
  const throttleKey = ["WAIT", "PAUSE_ISSUE", "SERVICE_LOW", "HARD_STOP"].includes(event.eventType)
    ? semanticKey : `${semanticKey}|${event.continuityRef ?? ""}`;
  if (lastByStream.get(stream) === throttleKey) return null;
  const index = counts.get(stream) ?? 0;
  counts.set(stream, index + 1);
  let text: string;
  if (event.toneHint === "CRITICAL") text = CRITICAL_LINES[event.eventType];
  else {
    const phrase = PHRASES[event.subjectDomain];
    const observation = event.observationKey === "grid-aligned"
      ? pick(["网格方向已经定了", "接着上次那片网格", "网格方向沿用原来的"], index)
      : event.observationKey === "demand-elevated" ? "需求有变化"
        : event.observationKey === "service-below-need" ? "服务供应有缺口"
          : event.observationKey === "no-safe-land" ? "附近暂时找不到合适的地"
            : event.observationKey === "world-uncertain" ? "当前状态还没确认" : "";
    const action = event.actionKey === "prepare-grid" || event.actionKey === "extend-grid"
      ? pick(PHRASES.GRID.action, index)
      : event.actionKey === "build-road" ? pick(PHRASES.ROAD.action, index)
        // A service Goal's own action, in its own domain. The grid phrases above
        // describe road work, and a city whose power is short is not having its
        // roads extended — saying so would describe something the Mayor is not
        // doing.
        : event.actionKey === "provide-service" ? pick(phrase.action, index)
          : event.actionKey === "wait-for-world" ? "先让城市跑一会儿" : "";
    const reason = event.reasonKey === "safe-expansion-window" ? pick(phrase.reason, index)
      : event.reasonKey === "candidate-refused" ? "这条不行，换个方向"
        : event.reasonKey === "city-needs-service" ? "得先把服务补上"
          : event.reasonKey === "no-legal-site" ? "附近暂时找不到合适的地"
            : event.reasonKey === "authoritative-uncertain" ? "结果还没确认，我先停一下" : "";
    const resolvedReason = event.reasonKey === "growth-condition-blocks" ? "当前条件不适合继续扩张"
      : reason;
    const result = event.resultKey === "road-confirmed" ? pick(phrase.result, index)
      : event.resultKey === "batch-complete" ? pick(["这一小片，弄好了", "这片先齐了", "这一段网格接完了"], index)
        : event.resultKey === "alternatives-exhausted" ? "这条不行，先找别的地" : "";
    const ending = pick(phrase.ending, index);
    if (event.eventType === "PREPARE") text = (observation ? observation + "，" : "") + action + "。";
    else if (event.eventType === "ACT_START") text = action === "先让城市跑一会儿" ? "行，开始吧。" : action + "。";
    else if (event.eventType === "ACT_SUCCESS" || event.eventType === "BLOCK_COMPLETE") text = result + "。";
    else if (event.eventType === "WAIT") text = (action || "先等等") + "，" + (resolvedReason || "等城市状态更新") + "。";
    else if (event.eventType === "ACT_REJECT_RETRY") text = (resolvedReason || "这条不行") + "，" + (action || "换个方向") + "。";
    else if (event.eventType === "ACT_TERMINAL_FAIL" || event.eventType === "HARD_STOP") text = (resolvedReason || "结果还没确认") + "，我先停下来。";
    else if (event.eventType === "PAUSE_ISSUE") text = (observation ? observation + "，" : "") + (resolvedReason || "这边有个问题得先处理") + "，扩张先停一下。";
    else text = (observation ? observation + "，" : "") + (action || result || resolvedReason || ending);
  }
  const recent = recentByStream.get(stream) ?? [];
  if (recent.includes(text) || recentRenderedLines.includes(text)) {
    const phrase = PHRASES[event.subjectDomain];
    const alternatives = event.resultKey === "road-confirmed" ? phrase.result
      : event.actionKey === "prepare-grid" || event.actionKey === "extend-grid" ? PHRASES.GRID.action
        : event.actionKey === "build-road" ? PHRASES.ROAD.action
          : phrase.ending;
    let offset = 1;
    let candidate = pick(alternatives, index + offset) + "。";
    while ((recent.includes(candidate) || recentRenderedLines.includes(candidate)) && offset < alternatives.length + 1) {
      offset += 1;
      candidate = pick(alternatives, index + offset) + "。";
    }
    text = candidate;
    // Distinct event types can still choose identical short phrases. A small
    // local suffix list keeps the full caption stream unique without exposing
    // event IDs or introducing generated language.
    const tails = ["先接到这儿。", "我接着看。", "这步先记下。", "继续往前接。", "先稳在这儿。", "再看下一步。"];
    let tail = 0;
    while ((recent.includes(text) || recentRenderedLines.includes(text)) && tail < tails.length) {
      text = `${candidate.slice(0, -1)}，${tails[tail]}`;
      tail += 1;
    }
  }
  recentByStream.set(stream, [...recent, text].slice(-5));
  recentRenderedLines.push(text);
  if (recentRenderedLines.length > 5) recentRenderedLines.shift();
  lastByStream.set(stream, throttleKey);
  return { text, tone: event.toneHint, emittedAt };
}

export function resetMayorCommentaryForTests() {
  lastByStream.clear(); recentByStream.clear(); recentRenderedLines.length = 0; counts.clear();
}
