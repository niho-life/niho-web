export const API_VERSION: "v1";
export const API_PREFIX: "/api/cli/v1";
export const SERVICE_CLIENT_ID: RegExp;
export const SCOPE_ID: RegExp;

export type CliOperation = {
  readonly id: string;
  readonly capability: string;
  readonly method: "GET" | "POST" | "PUT";
  readonly bridgePath: string;
  readonly parameters: readonly string[];
  readonly action?: string;
  readonly owner?: true;
  readonly releasePending?: true;
};

export const OPERATIONS: readonly CliOperation[];
export function resolveOperation(id: string, args: readonly string[]): { readonly spec: CliOperation; readonly bridgePath: string } | null;
