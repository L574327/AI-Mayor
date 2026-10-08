/** Profile ranks admitted candidates; admission remains the sole hard decision. */
import { admitCandidate } from "./admit";
import type { Candidate, ConflictPause, Diagnostic, MissionRecord, ProfileInput, SemanticArtifact, WorldSnapshot } from "./types";

export interface ProfileCandidate { candidate: Candidate; soft_index?: number }
export interface ProfileLivenessInput { profile: ProfileInput; mission: MissionRecord; artifact: SemanticArtifact; world: WorldSnapshot; candidates: ProfileCandidate[]; pause?:ConflictPause|null }
export interface ProfileLivenessResult { admissible:string[]; blocked:Array<{ candidate_ref:string; reasons:Diagnostic[] }>; soft_concessions:string[]; diagnostics:Diagnostic[] }

export function evaluateProfileLiveness(input:ProfileLivenessInput):ProfileLivenessResult {
  const diagnostics:Diagnostic[] = [];
  const admissible:string[] = [];
  const blocked:Array<{ candidate_ref:string; reasons:Diagnostic[] }> = [];
  const soft_concessions:string[] = [];
  if (input.profile.requested_grants?.length) diagnostics.push({ code:"PERMISSION_DENIED",severity:"BLOCK",
    refs:input.profile.requested_grants.map((g) => g.clause_ref),detail:"Profile cannot grant authority" });
  const floor = Math.max(Number.NEGATIVE_INFINITY,...input.profile.soft_thresholds.map((s) => s.index));
  for (const entry of [...input.candidates].sort((a,b) => a.candidate.candidate_ref.localeCompare(b.candidate.candidate_ref))) {
    const assessed = admitCandidate({ artifact:input.artifact,world:input.world,candidate:entry.candidate,pause:input.pause });
    if (!assessed.admitted) { blocked.push({ candidate_ref:entry.candidate.candidate_ref,reasons:assessed.diagnostics }); continue; }
    admissible.push(entry.candidate.candidate_ref);
    if (input.mission.requires_advance_now && entry.soft_index !== undefined && entry.soft_index < floor) {
      soft_concessions.push(entry.candidate.candidate_ref + ": Profile soft floor yielded");
      diagnostics.push({ code:"PROFILE_ONLY_STALL",severity:"INFO",refs:[entry.candidate.candidate_ref,input.profile.profile],
        detail:"authorized candidate remains in the legal set despite Profile preference" });
    }
  }
  return { admissible,blocked,soft_concessions,diagnostics };
}
