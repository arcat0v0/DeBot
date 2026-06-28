export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|private[_-]?key|access[_-]?key|client[_-]?secret|credential|authorization|api[_-]?key)/i;

export type LogFields = Record<string, unknown>;

export interface Logger {
  level: LogLevel;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export function redact(value: unknown, keyHint = ""): unknown {
  if (SECRET_KEY_PATTERN.test(keyHint)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (
      const [key, inner] of Object.entries(value as Record<string, unknown>)
    ) {
      out[key] = redact(inner, key);
    }
    return out;
  }
  return value;
}

export function createLogger(
  level: LogLevel = "info",
  bindings: LogFields = {},
  sink: (line: string) => void = (line) => console.log(line),
): Logger {
  function emit(
    entryLevel: LogLevel,
    message: string,
    fields?: LogFields,
  ): void {
    if (LEVEL_ORDER[entryLevel] < LEVEL_ORDER[level]) return;
    const record: Record<string, unknown> = {
      time: new Date().toISOString(),
      level: entryLevel,
      msg: message,
      ...bindings,
      ...(fields ?? {}),
    };
    sink(JSON.stringify(redact(record)));
  }

  return {
    level,
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (extra) => createLogger(level, { ...bindings, ...extra }, sink),
  };
}
