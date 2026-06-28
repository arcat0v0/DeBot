export class DebotError extends Error {
  readonly code: string;
  readonly userMessage: string;

  constructor(code: string, message: string, userMessage?: string) {
    super(message);
    this.name = "DebotError";
    this.code = code;
    this.userMessage = userMessage ?? message;
  }
}

export class ConfigError extends DebotError {
  constructor(message: string, userMessage?: string) {
    super("config_error", message, userMessage);
    this.name = "ConfigError";
  }
}

export class ValidationError extends DebotError {
  constructor(message: string, userMessage?: string) {
    super("validation_error", message, userMessage);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends DebotError {
  constructor(message: string, userMessage?: string) {
    super("not_found", message, userMessage);
    this.name = "NotFoundError";
  }
}

export class ProviderError extends DebotError {
  readonly provider: string;
  readonly status?: number;

  constructor(
    provider: string,
    message: string,
    options: { status?: number; userMessage?: string } = {},
  ) {
    super("provider_error", message, options.userMessage);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = options.status;
  }
}

export function toUserMessage(error: unknown): string {
  if (error instanceof DebotError) return error.userMessage;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
