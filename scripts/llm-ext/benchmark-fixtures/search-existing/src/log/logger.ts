// Benchmark fixture — real code with a KNOWN feature location (TRDD-828238b5 A6).
// Feature: leveled logger with a configurable minimum level.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  constructor(
    private readonly name: string,
    private minLevel: LogLevel = "info",
    private readonly sink: (line: string) => void = (line) =>
      process.stderr.write(line + "\n"),
  ) {}

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  log(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const ts = new Date().toISOString();
    this.sink(`${ts} [${level.toUpperCase()}] ${this.name}: ${message}`);
  }

  debug(message: string): void {
    this.log("debug", message);
  }
  info(message: string): void {
    this.log("info", message);
  }
  warn(message: string): void {
    this.log("warn", message);
  }
  error(message: string): void {
    this.log("error", message);
  }
}
