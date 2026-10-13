export class AppError extends Error {
  constructor(public code: string, public retryable = false) { super(code); }
}
export function requireThat(condition: unknown, code: string): asserts condition {
  if (!condition) throw new AppError(code);
}
