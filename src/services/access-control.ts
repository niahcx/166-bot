import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface KeysData {
  keys: Record<string, { userId?: string; expiresAt?: number; plan?: string }>;
  blacklist: string[];
  maintenance: boolean;
}

const EMPTY: KeysData = { keys: {}, blacklist: [], maintenance: false };

export class AccessControlService {
  private readonly filePath: string;
  private data: KeysData;

  constructor(databasePath: string) {
    this.filePath = resolve(databasePath, "rave-access.json");
    this.data = this.load();
  }

  private load(): KeysData {
    try {
      if (!existsSync(this.filePath)) return { ...EMPTY };
      return JSON.parse(readFileSync(this.filePath, "utf8")) as KeysData;
    } catch {
      return { ...EMPTY };
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
    } catch {}
  }

  isBlacklisted(userId: string): boolean {
    return this.data.blacklist.includes(userId);
  }

  blacklistUser(userId: string): void {
    if (!this.data.blacklist.includes(userId)) this.data.blacklist.push(userId);
    this.save();
  }

  unblacklistUser(userId: string): void {
    this.data.blacklist = this.data.blacklist.filter((id) => id !== userId);
    this.save();
  }

  isMaintenance(): boolean {
    return this.data.maintenance;
  }

  toggleMaintenance(): boolean {
    this.data.maintenance = !this.data.maintenance;
    this.save();
    return this.data.maintenance;
  }

  redeemKey(key: string, userId: string): { success: boolean; message: string } {
    const entry = this.data.keys[key];
    if (!entry) return { success: false, message: "Chave inválida." };
    if (entry.userId && entry.userId !== userId) return { success: false, message: "Esta chave já foi usada por outro usuário." };
    if (entry.expiresAt && entry.expiresAt < Date.now()) return { success: false, message: "Esta chave expirou." };
    entry.userId = userId;
    this.save();
    return { success: true, message: `Chave resgatada!${entry.plan ? ` Plano: ${entry.plan}` : ""}${entry.expiresAt ? ` Expira: <t:${Math.floor(entry.expiresAt / 1000)}:R>` : ""}` };
  }

  createKey(key: string, plan?: string, durationMs?: number): void {
    this.data.keys[key] = {
      plan: plan || "basic",
      expiresAt: durationMs ? Date.now() + durationMs : undefined
    };
    this.save();
  }

  deleteKey(key: string): boolean {
    if (!this.data.keys[key]) return false;
    delete this.data.keys[key];
    this.save();
    return true;
  }

  listKeys(): Array<{ key: string; userId?: string; plan?: string; expiresAt?: number }> {
    return Object.entries(this.data.keys).map(([key, data]) => ({ key, ...data }));
  }
}
