const LEVEL_WEIGHT: Record<string, number> = {
  debug: 10,
  info: 20,
  success: 20,
  warn: 30,
  error: 40
};

export class Logger {
  constructor(private readonly level = "info") {}

  private enabled(kind: string): boolean {
    const configured = LEVEL_WEIGHT[this.level.toLowerCase()] ?? 20;
    return (LEVEL_WEIGHT[kind] ?? 20) >= configured;
  }

  private emit(kind: string, message: string, data?: unknown): void {
    if (!this.enabled(kind)) return;
    const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
    const label = kind.toUpperCase().padEnd(7, " ");
    const row = `[${timestamp}] [${label}] ${message}`;
    if (data === undefined) console.log(row);
    else console.log(row, data);
  }

  section(title: string): void {
    const line = "═".repeat(Math.max(18, Math.min(72, title.length + 12)));
    console.log(`\n╔${line}╗`);
    console.log(`║  ${title}`);
    console.log(`╚${line}╝`);
  }

  info(message: string, data?: unknown): void { this.emit("info", message, data); }
  success(message: string, data?: unknown): void { this.emit("success", `✓ ${message}`, data); }
  warn(message: string, data?: unknown): void { this.emit("warn", `! ${message}`, data); }
  error(message: string, data?: unknown): void { this.emit("error", `✕ ${message}`, data); }
  debug(message: string, data?: unknown): void { this.emit("debug", message, data); }

  progress(scope: string, current: number, total: number, message: string): void {
    const width = String(Math.max(1, total)).length;
    this.info(`[${scope}] [${String(current).padStart(width, "0")}/${String(total).padStart(width, "0")}] ${message}`);
  }
}
