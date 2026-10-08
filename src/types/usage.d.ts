export interface IUsage {
  id: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  inputPrice: number;
  outputPrice: number;
  createdAt: number;
}

export interface IUsageStatistics {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
}
