export const API_VERSION: "v1";
export const API_PREFIX: "/api/cli/v1";
export const SERVICE_CLIENT_ID: RegExp;
export const SCOPE_ID: RegExp;
export const OPERATION_KEY_HEADER: "X-Studio-Operation-Key";
export const UUID_V4: RegExp;
export const DRAFT_RECOVERY_MAX_INPUT_BYTES: number;
export const DRAFT_RECOVERY_MAX_OUTPUT_BYTES: number;
export function normalizeOperationKey(value: unknown): string | null;

export type CliOperation = {
  readonly id: string;
  readonly capability: string;
  readonly method: "GET" | "POST" | "PUT";
  readonly bridgePath: string;
  readonly parameters: readonly string[];
  readonly action?: string;
  readonly upload?: "asset" | "cms" | "localization";
  readonly owner?: true;
  readonly releasePending?: true;
};

export const OPERATIONS: readonly CliOperation[];
export function resolveOperation(id: string, args: readonly string[]): { readonly spec: CliOperation; readonly bridgePath: string } | null;
