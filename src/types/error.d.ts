export interface IOpenAIError {
  message: string;
  type: string;
  param: string | null;
  code: string;
}
