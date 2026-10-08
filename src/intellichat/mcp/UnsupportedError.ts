/**
 * This error indicates that the MCP feature is not supported or that
 * the MCP Server returned a resource that cannot be parsed.
 */
export class UnsupportedError extends Error {
  static isInstance(error: any): error is UnsupportedError {
    return error instanceof UnsupportedError;
  }
}

export default UnsupportedError;
