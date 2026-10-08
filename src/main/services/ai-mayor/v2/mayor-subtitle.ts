/**
 * The one line a player reads on screen while the Mayor works.
 *
 * Deterministic templates over state the runtime already publishes. No model
 * call, no new telemetry, and no claim the state does not carry: if a fact is
 * unread the line says what is known and stops. It exists because the Mayor can
 * narrate correctly for twenty minutes and still look inert to somebody
 * watching the city, which is a product failure regardless of what the code did.
 */

/** The slice of session state a subtitle is derived from. */
export interface MayorSubtitleState {
  status?: string;
  stopReason?: string;
  lastStatus?: string;
  runLedger?: {
    entries?: Array<{
      reason?: string;
      decision?: {
        goalId?: string | null;
        policyAnswer?: string | null;
        workOrderStage?: string | null;
        parkedFamily?: string | null;
        parkedReason?: string | null;
        haltReason?: string | null;
        applied?: { zoning?: number; road?: number; facility?: number };
        simulation?: { outcome?: string } | null;
      };
    }>;
  } | null;
}

const STAGE_TEXT: Record<string, string> = {
  PLANNED: "正在选址",
  SITE_SELECTED: "已选定地块，准备接入道路",
  ROAD_DELIVERED: "道路已交付，准备分区",
  ZONED_WAITING_FOR_BUILDING: "分区已交付，等待建筑生成",
  BUILDING_OBSERVED: "建筑已出现，正在接入市政",
  WAITING_FOR_OCCUPANCY: "已交付，等待入住",
  DIAGNOSING: "正在诊断停滞原因",
  RECOVERING: "正在恢复项目",
  OCCUPIED: "本批已有人入住",
};

const goalLabel = (goalId: string | null | undefined): string | null => {
  if (!goalId) return null;
  if (goalId.startsWith("EXPAND_RESIDENTIAL")) return "住宅片区";
  if (goalId.startsWith("EXPAND_COMMERCIAL")) return "商业片区";
  if (goalId.startsWith("EXPAND_INDUSTRIAL")) return "工业片区";
  if (goalId.startsWith("EXPAND_OFFICE")) return "办公片区";
  if (goalId.startsWith("ESTABLISH_ROAD_NETWORK")) return "道路网络";
  if (goalId.startsWith("PROVIDE_SERVICE:water")) return "供水";
  if (goalId.startsWith("PROVIDE_SERVICE:sewage")) return "排水";
  if (goalId.startsWith("PROVIDE_SERVICE:electricity")) return "电力";
  return null;
};

/** What the Mayor is doing right now, in one line, or null when there is nothing to say. */
export function mayorSubtitle(state: MayorSubtitleState | null | undefined): string | null {
  if (!state) return null;
  if (state.status === "stopped") {
    return state.stopReason ? `已停止：${state.stopReason}` : "已停止";
  }
  const entry = state.runLedger?.entries?.at(-1) ?? null;
  const decision = entry?.decision ?? null;
  if (decision?.haltReason) return `已停止：${decision.haltReason}`;

  // What was just delivered outranks what is being planned: it is the fact the
  // player can see on the map, and the one that proves the Mayor is not idle.
  const applied = decision?.applied;
  const delivered: string[] = [];
  if (applied?.road) delivered.push(`${applied.road} 段道路`);
  if (applied?.zoning) delivered.push(`${applied.zoning} 格分区`);
  if (applied?.facility) delivered.push(`${applied.facility} 个设施`);
  if (delivered.length > 0) return `刚完成：${delivered.join(" / ")}`;

  // A park is the case a player most needs explained: the Mayor looks stopped
  // when it is in fact re-siting.
  if (decision?.parkedReason) {
    const family = goalLabel(decision.parkedFamily) ?? decision.parkedFamily ?? "该片区";
    return `${family}地块不可用，正在换址（${decision.parkedReason}）`;
  }

  const goal = goalLabel(decision?.goalId);
  const stage = decision?.workOrderStage ?? null;
  if (stage === "DIAGNOSING" || stage === "RECOVERING") {
    return goal ? `${goal}${STAGE_TEXT[stage]}…` : `${STAGE_TEXT[stage]}…`;
  }
  if (stage) {
    const text = STAGE_TEXT[stage] ?? `当前阶段 ${stage}`;
    return goal ? `正在扩建${goal}：${text}` : text;
  }

  const policy = decision?.policyAnswer ?? null;
  if (policy?.includes("HAS_NO_GOAL")) return "当前没有可执行的增长目标，继续观察城市变化";
  if (policy?.includes("TARGET_RETRY")) return "上一处地块不可用，正在换一处候选地块";
  if (policy?.includes("PAUSED_FOR_BLOCKER")) return "存在阻塞增长的城市问题，暂缓扩建";
  // The Mayor changed direction inside one cycle because the first direction had
  // nowhere to build. That is the most misleading moment to say nothing: from
  // outside it looks like the city simply stopped asking for the first one.
  if (policy?.includes("DOMAIN_SWITCH")) {
    const admitted = goalLabel(policy.split("->").at(-1) ?? null) ?? "另一个方向";
    return `上一个方向暂时没有可用地块，已改扩建${admitted}`;
  }
  // Everything the city wanted was refused on its own land. This is a real
  // finding and it is bounded — the next cycle re-reads a city that has been
  // allowed to run — so it says what happened instead of sounding stuck.
  if (policy?.includes("ALL_DOMAINS_REFUSED")) return "各建设方向当前都没有可用地块，先让城市继续运行";
  if (policy?.includes("ADMITTED")) {
    const admitted = goalLabel(policy.split(":").slice(1).join(":")) ?? "新片区";
    return `已批准扩建${admitted}`;
  }
  if (policy?.includes("OBSERVES")) return "让城市继续运行，等待下一步事实";
  if (policy) return policy;

  return typeof state.lastStatus === "string" && state.lastStatus ? state.lastStatus : null;
}
