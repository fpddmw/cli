export class CliError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly exitCode: number;

  constructor(
    message: string,
    optionsOrExitCode: { code?: string; details?: unknown; exitCode?: number } | number = {},
  ) {
    super(message);
    this.name = "CliError";
    const options =
      typeof optionsOrExitCode === "number" ? { exitCode: optionsOrExitCode } : optionsOrExitCode;
    this.code = options.code ?? "CLI_ERROR";
    this.details = options.details;
    this.exitCode = options.exitCode ?? 1;
  }
}

export class HttpError extends CliError {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryAfterSeconds: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message, {
      code: "HTTP_ERROR",
      details: { status, retryAfterSeconds, retryable },
    });
  }
}

export type ErrorPayload = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export function toErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof CliError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }

  if (error instanceof Error) {
    return {
      error: {
        code: "UNEXPECTED_ERROR",
        message: error.message,
      },
    };
  }

  return {
    error: {
      code: "UNKNOWN_THROWN_VALUE",
      message: String(error),
    },
  };
}
