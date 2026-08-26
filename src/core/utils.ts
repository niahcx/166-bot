import { createHash, randomUUID } from "node:crypto";

export const nowIso = () => new Date().toISOString();
export const makeId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const safeJson = <T>(value: string, fallback: T): T => { try { return JSON.parse(value) as T; } catch { return fallback; } };
export const normalizeColor = (value: string, fallback = "#7c3aed") => /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim().toLowerCase() : fallback;
export const colorNumber = (value: string) => Number.parseInt(normalizeColor(value).slice(1), 16);
export const slugify = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "produto";
export const channelSafe = (value: string) => slugify(value).slice(0, 80) || "ticket";
export const truncate = (value: string, max: number) => value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
export const normalizeName = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

export function parseMoney(value: string): number {
  const cleaned = value.replace(/R\$/gi, "").replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Valor monetário inválido.");
  return Math.round(parsed * 100);
}

export const formatMoney = (cents: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
export const parseBoolean = (value: string, fallback = false) => {
  const normalized = value.trim().toLowerCase();
  if (["sim", "true", "1", "on", "ativo", "ativado"].includes(normalized)) return true;
  if (["não", "nao", "false", "0", "off", "inativo", "desativado"].includes(normalized)) return false;
  return fallback;
};

export function parseDuration(value: string): number {
  const match = value.trim().toLowerCase().match(/^(\d+)\s*([smhd])$/);
  if (!match) throw new Error("Duração inválida. Use 30m, 2h ou 1d.");
  const amount = Number(match[1]);
  const unit = match[2];
  const factor = unit === "s" ? 1000 : unit === "m" ? 60000 : unit === "h" ? 3600000 : 86400000;
  return amount * factor;
}
