import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AppConfig } from "./types.js";

const DISCORD_ID = /^\d{15,22}$/;
const TOKEN_PLACEHOLDERS = new Set([
  "",
  "token-bot",
  "seu_token_aqui",
  "cole_o_token_do_bot",
  "cole_o_token_do_bot_aqui",
  "changeme"
]);

interface TokenFile { token?: unknown; }
interface RuntimeFile {
  clientId?: unknown;
  guildId?: unknown;
  ownerIds?: unknown;
  databasePath?: unknown;
  autoInstallEmojis?: unknown;
  emojiInstallLimit?: unknown;
  logLevel?: unknown;
  firebaseDbUrl?: unknown;
  verifyUrl?: unknown;
}

const text = (value: unknown): string => String(value ?? "").trim();

function ensureJsonFile(path: string, initialValue: unknown): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(initialValue, null, 2)}\n`, "utf8");
}

function readJson<T>(path: string, label: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`${label} não pôde ser lido como JSON válido: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function isUsableToken(value: unknown): value is string {
  const token = text(value);
  return token.length >= 20 && !TOKEN_PLACEHOLDERS.has(token.toLowerCase());
}

export function loadConfig(projectRoot = process.cwd()): AppConfig {
  const tokenPath = resolve(projectRoot, "Token.json");
  const runtimePath = resolve(projectRoot, "config/runtime.json");

  ensureJsonFile(tokenPath, { token: "" });
  ensureJsonFile(runtimePath, {
    clientId: "",
    guildId: "",
    ownerIds: [],
    databasePath: "database",
    autoInstallEmojis: true,
    emojiInstallLimit: 0,
    logLevel: "info"
  });

  const envToken = process.env.DISCORD_TOKEN?.trim();
  let botToken = "";
  if (envToken && isUsableToken(envToken)) {
    botToken = envToken;
  } else {
    const tokenFile = readJson<TokenFile>(tokenPath, "Token.json");
    if (isUsableToken(tokenFile.token)) {
      botToken = text(tokenFile.token);
    }
  }
  if (!botToken) {
    throw new Error("Nenhum token válido encontrado. Configure DISCORD_TOKEN (variável de ambiente) ou preencha Token.json.");
  }

  const runtime = readJson<RuntimeFile>(runtimePath, "config/runtime.json");
  const ownerIds = Array.isArray(runtime.ownerIds)
    ? [...new Set(runtime.ownerIds.map(text).filter((id) => DISCORD_ID.test(id)))]
    : [];
  const rawLimit = Number(runtime.emojiInstallLimit ?? 0);
  const databasePath = text(runtime.databasePath) || "database";

  return {
    botToken,
    clientId: DISCORD_ID.test(text(runtime.clientId)) ? text(runtime.clientId) : undefined,
    guildId: DISCORD_ID.test(text(runtime.guildId)) ? text(runtime.guildId) : undefined,
    ownerIds,
    databasePath,
    autoInstallEmojis: runtime.autoInstallEmojis !== false,
    emojiInstallLimit: Number.isFinite(rawLimit) && rawLimit >= 0 ? Math.trunc(rawLimit) : 0,
    logLevel: text(runtime.logLevel) || "info",
    firebaseDbUrl: text(runtime.firebaseDbUrl) || undefined,
    verifyUrl: text(runtime.verifyUrl) || undefined
  };
}
