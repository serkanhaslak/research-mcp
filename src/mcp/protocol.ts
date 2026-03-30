export function jsonRpcResponse(id: string | number | undefined, result: unknown) {
  return {
    jsonrpc: '2.0' as const,
    result,
    id: id ?? null,
  };
}

export function jsonRpcError(
  id: string | number | undefined,
  code: number,
  message: string,
  data?: unknown
) {
  return {
    jsonrpc: '2.0' as const,
    error: { code, message, ...(data ? { data } : {}) },
    id: id ?? null,
  };
}

export const MCP_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNAUTHORIZED: -32001,
  TOOL_NOT_FOUND: -32002,
  CAPABILITY_MISSING: -32003,
} as const;
