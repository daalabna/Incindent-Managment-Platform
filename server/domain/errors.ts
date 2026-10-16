export class DomainError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}

export const formatError = (error: unknown) => {
  if (!(error instanceof Error)) return "unknown error";
  const code =
    "code" in error &&
    (typeof error.code === "string" || typeof error.code === "number")
      ? ` code=${error.code}`
      : "";
  return redact(
    `${error.name}: ${error.message}${code}${error.stack ? `\n${error.stack}` : ""}`,
  );
};

export const redact = (text: string) =>
  text
    .replace(/amqp:\/\/[^@\s/]+@/gi, "amqp://redacted@")
    .replace(/postgres(?:ql)?:\/\/[^@\s/]+@/gi, "postgresql://redacted@")
    .replace(/redis:\/\/[^@\s/]+@/gi, "redis://redacted@");
