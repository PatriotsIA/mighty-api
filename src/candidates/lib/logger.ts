type LogValue = string | number | boolean | null | undefined;
type LogContext = Record<string, LogValue>;

function write(level: "INFO" | "WARN" | "ERROR", event: string, context: LogContext): void {
  const entry = JSON.stringify({
    level,
    event,
    timestamp: new Date().toISOString(),
    ...context,
  });

  if (level === "ERROR") {
    console.error(entry);
  } else if (level === "WARN") {
    console.warn(entry);
  } else {
    console.info(entry);
  }
}

export const logger = {
  info: (event: string, context: LogContext = {}) => write("INFO", event, context),
  warn: (event: string, context: LogContext = {}) => write("WARN", event, context),
  error: (event: string, context: LogContext = {}) => write("ERROR", event, context),
};

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
