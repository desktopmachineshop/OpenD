/** An error with an HTTP status and a message fit to show the author. */
export class EditorError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
