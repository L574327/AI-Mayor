/**
 * Encodes a Tool ID for an MCP Server in the format `TOOL::<server>/<tool>`.
 *
 * @param {string} server - The server hosting the tool.
 * @param {string} tool - The tool ID.
 * @returns {string} The encoded Tool ID in the format `TOOL::<server>/<tool>`.
 */
export const encodeToolId = (server: string, tool: string): string => {
  return `TOOL::${encodeURIComponent(server)}/${encodeURIComponent(tool)}`;
};

/**
 * Encodes a Prompt ID for an MCP Server in the format `PROMPT::<server>/<prompt>`.
 *
 * @param {string} server - The server hosting the prompt.
 * @param {string} prompt - The prompt ID.
 * @returns {string} The encoded Prompt ID in the format `PROMPT::<server>/<prompt>`.
 */
export const encodePromptId = (server: string, prompt: string): string => {
  return `PROMPT::${encodeURIComponent(server)}/${encodeURIComponent(prompt)}`;
};

/**
 * Decodes a Tool ID from an MCP Server in the format `TOOL::<server>/<tool>`.
 *
 * @param {string} id - The encoded Tool ID to decode. Must follow the format `TOOL::<server>/<tool>`.
 * @returns {{ server: string; tool: string }} An object containing:
 *  - `server`: The server hosting the tool.
 *  - `tool`: The decoded tool ID.
 */
export const decodeToolId = (id: string): { server: string; tool: string } => {
  const [server, tool] = id.split('::')[1].split('/');
  return {
    server: decodeURIComponent(server),
    tool: decodeURIComponent(tool),
  };
};

/**
 * Decodes a Prompt ID from an MCP Server in the format `PROMPT::<server>/<prompt>`.
 *
 * @param {string} id - The encoded Prompt ID to decode. Must follow the format `PROMPT::<server>/<prompt>`.
 * @returns {{ server: string; prompt: string }} An object containing:
 *  - `server`: The server hosting the prompt.
 *  - `prompt`: The decoded prompt ID.
 */
export const decodePromptId = (
  id: string,
): { server: string; prompt: string } => {
  const [server, prompt] = id.split('::')[1].split('/');
  return {
    server: decodeURIComponent(server),
    prompt: decodeURIComponent(prompt),
  };
};

export default {
  encodeToolId,
  decodeToolId,
  encodePromptId,
  decodePromptId,
};
