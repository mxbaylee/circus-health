// Private parent/worker IPC. readQuery validates input before spawning the worker.
export interface QueryRequest {
  path: string;
  sql: string;
  params: Array<string | number | null>;
  limit: number;
}
export interface QueryData {
  columns: string[];
  rows: Array<Array<string | number | null>>;
  truncated: boolean;
  revision: number;
  elapsedMs: number;
}
export type QueryReply = { data: QueryData; error?: never } | { error: string; data?: never };
