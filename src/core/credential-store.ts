import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Logger } from "./logger.js";

interface CredentialDocument {
  guilds: Record<string, Record<string, string>>;
}

const EMPTY_DOCUMENT: CredentialDocument = { guilds: {} };
const SECRET_NAME = /^[a-z][a-z0-9_]{1,80}$/;
const GUILD_ID = /^\d{15,22}$/;

function clone<T>(value: T): T { return structuredClone(value); }

export class CredentialStore {
  readonly path: string;
  private state: CredentialDocument;
  private writing = false;
  private pendingWrite = false;

  constructor(path = "config/private-credentials.json", private readonly logger?: Logger) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) this.atomicWrite(EMPTY_DOCUMENT);
    this.state = this.load();
  }

  private load(): CredentialDocument {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<CredentialDocument>;
      const guilds = parsed.guilds && typeof parsed.guilds === "object" ? parsed.guilds : {};
      const normalized: CredentialDocument = { guilds: {} };
      for (const [guildId, credentials] of Object.entries(guilds)) {
        if (!GUILD_ID.test(guildId) || !credentials || typeof credentials !== "object") continue;
        normalized.guilds[guildId] = {};
        for (const [key, value] of Object.entries(credentials)) {
          if (SECRET_NAME.test(key) && typeof value === "string" && value.trim()) normalized.guilds[guildId]![key] = value.trim();
        }
      }
      return normalized;
    } catch (error) {
      throw new Error(`config/private-credentials.json está inválido: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private atomicWrite(value: CredentialDocument): void {
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, this.path);
    try { chmodSync(this.path, 0o600); } catch { /* Sistemas sem suporte a permissões POSIX podem ignorar esta etapa. */ }
  }

  private persist(): void {
    this.pendingWrite = true;
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.pendingWrite) {
        this.pendingWrite = false;
        this.atomicWrite(this.state);
      }
    } finally {
      this.writing = false;
    }
  }

  get(guildId: string, key: string): string | undefined {
    if (!GUILD_ID.test(guildId) || !SECRET_NAME.test(key)) return undefined;
    const value = this.state.guilds[guildId]?.[key];
    return value?.trim() || undefined;
  }

  has(guildId: string, key: string): boolean { return Boolean(this.get(guildId, key)); }

  set(guildId: string, key: string, value: string): void {
    if (!GUILD_ID.test(guildId)) throw new Error("ID do servidor inválido para salvar a credencial.");
    if (!SECRET_NAME.test(key)) throw new Error("Nome interno de credencial inválido.");
    const clean = value.trim();
    this.state.guilds[guildId] ??= {};
    if (clean) this.state.guilds[guildId]![key] = clean;
    else delete this.state.guilds[guildId]![key];
    this.persist();
    this.logger?.info("Credencial privada atualizada no arquivo protegido do projeto.", { guildId, key });
  }

  remove(guildId: string, key: string): void { this.set(guildId, key, ""); }

  configuredKeys(guildId: string): string[] { return Object.keys(this.state.guilds[guildId] ?? {}).sort(); }

  snapshotWithoutValues(): Record<string, string[]> {
    return Object.fromEntries(Object.entries(this.state.guilds).map(([guildId, values]) => [guildId, Object.keys(values).sort()]));
  }

  reload(): void { this.state = clone(this.load()); }
}
