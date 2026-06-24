export type ErrorCode =
  | "io"
  | "session-not-found"
  | "pty"
  | "not-found"
  | "unreadable"
  | "write-conflict"
  | "too-large"
  | "config"
  | "os"
  | "network"
  | "zip"
  | "invalid-font"
  | "screencast-permission-denied"
  | "screencast-unsupported"
  | "screencast"
  | "db";

interface BackendError {
  code: string;
  message: string;
}

function isBackendError(err: unknown): err is BackendError {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as BackendError).code === "string" &&
    typeof (err as BackendError).message === "string"
  );
}

/** Stable discriminant from src-tauri/src/error.rs; null for foreign errors. */
export function errorCode(err: unknown): ErrorCode | null {
  return isBackendError(err) ? (err.code as ErrorCode) : null;
}

export function errorMessage(err: unknown): string {
  if (isBackendError(err)) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
