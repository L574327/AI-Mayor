import type { V2ActionFamily } from "./foundation";
import type { BoundedNetworkJunctionInsert } from "./bounded-network-junction";

export const V2_FINANCE_SCHEMA_VERSION = "ai-mayor-v2-finance/1";

export type FinanceProvenance = "OBSERVED_NATIVE" | "PLANNED_RESERVED";
export type QuoteState = "VALID" | "STALE" | "EXPIRED" | "INVALID" | "REJECTED";
export type AttributionStatus = "BOUNDED_ATTRIBUTION" | "INCONCLUSIVE" | "NO_RELIABLE_ATTRIBUTION";

export interface FinanceObservation {
  schemaVersion: typeof V2_FINANCE_SCHEMA_VERSION;
  treasuryAmount: number;
  unlimitedMoney: boolean;
  runtimeEpoch: string;
  frame: number;
  observedAt: string;
  freshness: "FRESH" | "STALE" | "UNKNOWN";
  provenance: "OBSERVED_NATIVE";
  monthlyBudget?: { income: number; expenses: number; balance: number };
}

export interface ProposalIdentity {
  proposalId: string;
  actionFamily: V2ActionFamily;
  exactInput: string;
  runtimeEpoch: string;
  frame: number;
  validationState: "VALID" | "INVALID";
}

export interface NativeTempEntity {
  tempId: string;
  ownerProposalId: string;
  signedCost: number;
  cancelled: boolean;
  hasTempComponent?: boolean;
}

export interface ProposalQuote {
  schemaVersion: typeof V2_FINANCE_SCHEMA_VERSION;
  proposalId: string;
  quoteId: string;
  actionFamily: V2ActionFamily;
  signedAmount: number;
  eligibleTempEntityCount: number;
  provenance: "OBSERVED_NATIVE";
  sourceKind: "NATIVE_TOOL_TEMP_COST";
  validationResult: "VALID" | "INVALID";
  runtimeEpoch: string;
  frame: number;
  state: QuoteState;
  expiresAt: string;
  exactInput: string;
}

export interface SpendAuthorization {
  schemaVersion: typeof V2_FINANCE_SCHEMA_VERSION;
  proposalId: string;
  quoteId: string;
  authorizedMaxSpend: number;
  provenance: "PLANNED_RESERVED";
  treasurySafetyReserve: number;
  expiry: string;
  decision: "AUTHORIZED" | "REJECTED";
  reason: string;
}

export interface ApplyFinanceReceipt {
  schemaVersion: typeof V2_FINANCE_SCHEMA_VERSION;
  commandId: string;
  proposalId: string;
  quoteId: string;
  actionFamily: V2ActionFamily;
  applyFrame: number;
  signedAppliedAmount: number;
  applySetIdentity: string;
  applySetCount: number;
  unlimitedMoney: boolean;
  completionState: "COMPLETED" | "REJECTED" | "UNKNOWN";
  attribution: AttributionStatus;
}

export function stableRoadInput(input: {
  prefab: string; x1: number; z1: number; x2: number; z2: number;
  cx?: number; cz?: number; e1?: number; e2?: number;
  networkJunctionInsert?: BoundedNetworkJunctionInsert;
}, planningContext?: {
  objectiveId: string;
  worldEpochId: string;
  topologyRevision: string;
  facility: { prefab: string; position: { x: number; z: number }; entity?: { index: number; version: number } };
  sourceEndpoint?: { entity?: { index: number; version: number }; position: { x: number; z: number } };
  targetContact?: { road: { index: number; version: number }; position: { x: number; z: number } };
}): string {
  return JSON.stringify({ actionFamily: "ROAD", ...input, ...(planningContext ? { planningContext } : {}) });
}

export function quoteNativeTempCost(identity: ProposalIdentity, quoteId: string, temps: NativeTempEntity[], now: Date, ttlMs = 2_000): ProposalQuote {
  if (identity.validationState !== "VALID" || !identity.proposalId || !identity.runtimeEpoch || identity.frame < 0) {
    return { schemaVersion: V2_FINANCE_SCHEMA_VERSION, proposalId: identity.proposalId, quoteId, actionFamily: identity.actionFamily, signedAmount: 0, eligibleTempEntityCount: 0, provenance: "OBSERVED_NATIVE", sourceKind: "NATIVE_TOOL_TEMP_COST", validationResult: "INVALID", runtimeEpoch: identity.runtimeEpoch, frame: identity.frame, state: "INVALID", expiresAt: now.toISOString(), exactInput: identity.exactInput };
  }
  const owned = temps.filter((temp) => temp.ownerProposalId === identity.proposalId);
  if (owned.length === 0 || owned.length !== temps.length || new Set(owned.map((temp) => temp.tempId)).size !== owned.length || owned.some((temp) => temp.hasTempComponent === false)) {
    return { schemaVersion: V2_FINANCE_SCHEMA_VERSION, proposalId: identity.proposalId, quoteId, actionFamily: identity.actionFamily, signedAmount: 0, eligibleTempEntityCount: 0, provenance: "OBSERVED_NATIVE", sourceKind: "NATIVE_TOOL_TEMP_COST", validationResult: "INVALID", runtimeEpoch: identity.runtimeEpoch, frame: identity.frame, state: "REJECTED", expiresAt: now.toISOString(), exactInput: identity.exactInput };
  }
  const eligible = owned.filter((temp) => !temp.cancelled && Number.isFinite(temp.signedCost));
  return { schemaVersion: V2_FINANCE_SCHEMA_VERSION, proposalId: identity.proposalId, quoteId, actionFamily: identity.actionFamily, signedAmount: eligible.reduce((sum, temp) => sum + temp.signedCost, 0), eligibleTempEntityCount: eligible.length, provenance: "OBSERVED_NATIVE", sourceKind: "NATIVE_TOOL_TEMP_COST", validationResult: "VALID", runtimeEpoch: identity.runtimeEpoch, frame: identity.frame, state: "VALID", expiresAt: new Date(now.getTime() + ttlMs).toISOString(), exactInput: identity.exactInput };
}

export function quoteState(quote: ProposalQuote, current: { runtimeEpoch: string; frame: number; now: Date }): QuoteState {
  if (quote.runtimeEpoch !== current.runtimeEpoch || quote.validationResult !== "VALID") return "STALE";
  if (current.now.getTime() >= Date.parse(quote.expiresAt)) return "EXPIRED";
  if (quote.frame !== current.frame) return "STALE";
  return "VALID";
}

export function authorizeSpend(input: { observation: FinanceObservation; quote: ProposalQuote | undefined; requiredGrossSpend: number; authorizedMaxSpend: number; treasurySafetyReserve: number; now: Date; operationKind?: "BOUNDED_NETWORK_JUNCTION_INSERT" }): SpendAuthorization {
  const { observation, quote } = input;
  const reject = (reason: string): SpendAuthorization => ({ schemaVersion: V2_FINANCE_SCHEMA_VERSION, proposalId: quote?.proposalId ?? "unknown", quoteId: quote?.quoteId ?? "unknown", authorizedMaxSpend: input.authorizedMaxSpend, provenance: "PLANNED_RESERVED", treasurySafetyReserve: input.treasurySafetyReserve, expiry: input.now.toISOString(), decision: "REJECTED", reason });
  if (observation.freshness !== "FRESH" || !Number.isFinite(observation.treasuryAmount)) return reject("treasury_observation_not_fresh");
  if (typeof observation.unlimitedMoney !== "boolean") return reject("unlimited_money_semantics_unknown");
  if (!quote || quoteState(quote, { runtimeEpoch: observation.runtimeEpoch, frame: observation.frame, now: input.now }) !== "VALID") return reject("quote_unknown_or_stale");
  // Native replacement/split junctions may be free: their actual cost witness
  // is the proposal-owned native Temp set. Scope that exception to the typed
  // operation and exact durable input; ordinary ROAD stays strictly positive.
  const typedZeroJunction = input.operationKind === "BOUNDED_NETWORK_JUNCTION_INSERT" &&
    quote.actionFamily === "ROAD" && quote.signedAmount === 0 && quote.eligibleTempEntityCount > 0 &&
    quote.provenance === "OBSERVED_NATIVE" && quote.sourceKind === "NATIVE_TOOL_TEMP_COST" &&
    quote.exactInput.includes('"kind":"BOUNDED_NETWORK_JUNCTION_INSERT"') && input.requiredGrossSpend === 0 &&
    input.authorizedMaxSpend === 0;
  if (input.operationKind === "BOUNDED_NETWORK_JUNCTION_INSERT" && quote.signedAmount === 0 && !typedZeroJunction) {
    return reject("typed_zero_quote_requires_zero_spend_cap");
  }
  if (quote.signedAmount === 0 && !typedZeroJunction) return reject("zero_quote_not_authorized_for_operation");
  if (input.authorizedMaxSpend <= 0 && !typedZeroJunction) return reject("authorized_maximum_must_be_positive");
  if (input.requiredGrossSpend > input.authorizedMaxSpend) return reject("required_spend_exceeds_authorized_maximum");
  if (!typedZeroJunction && !observation.unlimitedMoney && observation.treasuryAmount - input.treasurySafetyReserve < input.authorizedMaxSpend) return reject("treasury_below_safety_reserve");
  return { schemaVersion: V2_FINANCE_SCHEMA_VERSION, proposalId: quote.proposalId, quoteId: quote.quoteId, authorizedMaxSpend: input.authorizedMaxSpend, provenance: "PLANNED_RESERVED", treasurySafetyReserve: input.treasurySafetyReserve, expiry: quote.expiresAt, decision: "AUTHORIZED", reason: "fresh_quote_and_treasury_reservation_passed" };
}

export function applyFinanceReceipt(input: { commandId: string; identity: ProposalIdentity; quote: ProposalQuote; applyFrame: number; temps: NativeTempEntity[]; unlimitedMoney: boolean; completionState: ApplyFinanceReceipt["completionState"]; applySetIdentity: string; ownershipUnique: boolean }): ApplyFinanceReceipt {
  const owned = input.temps.filter((temp) => temp.ownerProposalId === input.identity.proposalId && !temp.cancelled && Number.isFinite(temp.signedCost));
  const valid = Boolean(input.commandId.trim()) && input.ownershipUnique && input.quote.proposalId === input.identity.proposalId && input.quote.runtimeEpoch === input.identity.runtimeEpoch && input.quote.frame === input.identity.frame && owned.length === input.temps.length;
  return { schemaVersion: V2_FINANCE_SCHEMA_VERSION, commandId: input.commandId, proposalId: input.identity.proposalId, quoteId: input.quote.quoteId, actionFamily: input.identity.actionFamily, applyFrame: input.applyFrame, signedAppliedAmount: valid ? owned.reduce((sum, temp) => sum + temp.signedCost, 0) : 0, applySetIdentity: input.applySetIdentity, applySetCount: input.temps.length, unlimitedMoney: input.unlimitedMoney, completionState: input.completionState, attribution: valid ? "BOUNDED_ATTRIBUTION" : "INCONCLUSIVE" };
}
