export class CoreError extends Error {
  constructor(readonly code: string, message: string, readonly effect: "not-committed" | "unknown" = "not-committed") {
    super(message);
  }
}
