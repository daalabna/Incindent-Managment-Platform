export class AiFailure extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}
