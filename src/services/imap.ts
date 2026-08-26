import { createHash } from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { JsonDatabase } from "../core/json-db.js";
import type { Logger } from "../core/logger.js";
import type { ImapPixSettings, Order } from "../types.js";
import { normalizeName, nowIso } from "../core/utils.js";
import { bankProfile } from "./imap-profiles.js";

export interface ImapCheckResult { scanned: number; ignored: number; approved: number; review: number; errors: string[]; }

const bodyText = (text?: string, html?: string | false) => `${text ?? ""}\n${typeof html === "string" ? html.replace(/<[^>]+>/g, " ") : ""}`
  .replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/\s+/g, " ")
  .trim();

export function parseImapAmounts(source: string): number[] {
  const values: number[] = [];
  const regex = /(?:R\$\s*)?([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2}|[0-9]+[.,][0-9]{2})/gi;
  for (const match of source.matchAll(regex)) {
    const raw = match[1]?.replace(/\./g, "").replace(",", ".");
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) values.push(Math.round(value * 100));
  }
  return [...new Set(values)];
}

export function containsPayerFullName(source: string, fullName: string): boolean {
  const normalizedBody = normalizeName(source);
  const normalizedName = normalizeName(fullName);
  if (!normalizedName || normalizedName.length < 5) return false;
  if (normalizedBody.includes(normalizedName)) return true;
  const tokens = normalizedName.split(" ").filter((token) => token.length >= 2);
  return tokens.length >= 2 && tokens.every((token) => normalizedBody.split(" ").includes(token));
}

export function matchesSelectedBankNotification(
  settings: ImapPixSettings,
  addresses: string[],
  _senderText: string,
  subject: string,
  body: string,
  authenticationResults = ""
): boolean {
  const profile = bankProfile(settings.bank);
  const normalizedSubject = normalizeName(subject);
  const normalizedBody = normalizeName(body);
  const domainMatch = addresses.some((address) => {
    const domainPart = address.toLowerCase().trim().split("@").at(-1) ?? "";
    return profile.senderDomains.some((domain) => domainPart === domain || domainPart.endsWith(`.${domain}`));
  });
  const subjectMatch = profile.subjectKeywords.some((keyword) => normalizedSubject.includes(normalizeName(keyword)));
  const bodyMatch = profile.bodyKeywords.some((keyword) => normalizedBody.includes(normalizeName(keyword)));

  const auth = authenticationResults.toLowerCase();
  const hasAuthenticationHeaders = /(?:spf|dkim|dmarc)=/.test(auth);
  const authenticationPassed = /(?:spf|dkim|dmarc)=pass/.test(auth)
    && profile.senderDomains.some((domain) => auth.includes(domain));

  return domainMatch && (subjectMatch || bodyMatch) && (!hasAuthenticationHeaders || authenticationPassed);
}

export function matchPendingImapOrder(
  guildId: string,
  settings: ImapPixSettings,
  orders: Order[],
  amounts: number[],
  body: string,
  messageDate: Date
): { order?: Order; safe: boolean; reason: string } {
  const candidates = orders.filter((order) =>
    order.guildId === guildId
    && order.provider === "IMAP_PIX"
    && order.imapBank === settings.bank
    && Boolean(order.payerFullName)
    && amounts.includes(order.totalCents)
    && containsPayerFullName(body, order.payerFullName)
    && messageDate.getTime() >= Date.parse(order.createdAt) - 120_000
    && messageDate.getTime() <= Date.parse(order.expiresAt) + 300_000
  );

  if (candidates.length === 1) {
    return { order: candidates[0], safe: true, reason: "Banco, valor exato, nome do pagador e horário conferidos." };
  }
  if (candidates.length > 1) return { safe: false, reason: "Mais de um pedido possui o mesmo banco, valor e nome do pagador." };

  const sameAmount = orders.filter((order) => order.guildId === guildId && order.provider === "IMAP_PIX" && order.imapBank === settings.bank && amounts.includes(order.totalCents));
  if (sameAmount.length) return { safe: false, reason: "O valor foi encontrado, mas o nome completo do pagador não corresponde ao pedido." };
  return { safe: false, reason: "Nenhum pedido pendente corresponde ao banco, valor e horário do e-mail." };
}

export class ImapMonitor {
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastChecks = new Map<string, number>();

  constructor(
    private readonly db: JsonDatabase,
    private readonly logger: Logger,
    private readonly getPending: () => Order[],
    private readonly onPaid: (orderId: string, proof: Record<string, unknown>) => Promise<void>
  ) {}

  settings(guildId: string): ImapPixSettings { return this.db.payments(guildId).imapPix; }

  private key(guildId: string, settings: ImapPixSettings) {
    return createHash("sha256")
      .update(`${guildId}:${settings.host}:${settings.port}:${settings.username}:${settings.mailbox}:${settings.bank}`)
      .digest("hex")
      .slice(0, 24);
  }

  private validate(guildId: string, settings: ImapPixSettings, password: string, requireEnabled = true) {
    if (requireEnabled && !settings.enabled) throw new Error("A verificação IMAP está desativada.");
    if (!settings.host || !settings.username || !password) throw new Error("Configure a conta de e-mail e a senha de aplicativo do IMAP.");
    if (!settings.pixKey) throw new Error("Configure a chave PIX usada para receber os pagamentos.");
    if (!settings.bank) throw new Error("Escolha Banco Inter, PicPay ou Nubank no painel IMAP.");
    if (!this.getPending().some((order) => order.guildId === guildId && order.provider === "IMAP_PIX")) return;
  }

  private client(settings: ImapPixSettings, password: string) {
    return new ImapFlow({
      host: settings.host,
      port: settings.port || (settings.secure ? 993 : 143),
      secure: settings.secure,
      auth: { user: settings.username, pass: password },
      logger: false,
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 30_000,
      tls: { rejectUnauthorized: true }
    });
  }

  start() {
    this.stop();
    this.timer = setInterval(() => void this.checkNow(), 20_000);
    this.timer.unref?.();
    setTimeout(() => void this.checkNow(), 5000).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async testConnection(guildId?: string): Promise<string> {
    const id = guildId || Object.keys(this.db.state.guilds).find((candidate) => this.settings(candidate).enabled);
    if (!id) throw new Error("Nenhum servidor com IMAP ativo.");
    const settings = this.settings(id);
    const password = this.db.getSecret("imap_password", id) ?? "";
    this.validate(id, settings, password, false);
    const client = this.client(settings, password);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(settings.mailbox || "INBOX");
      try {
        const count = Number(client.mailbox && client.mailbox.exists ? client.mailbox.exists : 0);
        return `${settings.mailbox || "INBOX"}: ${count} mensagens • banco monitorado: ${bankProfile(settings.bank).label}`;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  private match(guildId: string, settings: ImapPixSettings, orders: Order[], amounts: number[], body: string, messageDate: Date) {
    return matchPendingImapOrder(guildId, settings, orders, amounts, body, messageDate);
  }

  async checkNow(guildId?: string): Promise<ImapCheckResult> {
    const total: ImapCheckResult = { scanned: 0, ignored: 0, approved: 0, review: 0, errors: [] };
    if (this.running) return total;
    this.running = true;
    try {
      const guildIds = guildId ? [guildId] : Object.keys(this.db.state.guilds).filter((id) => this.settings(id).enabled);
      for (const id of guildIds) {
        const settings = this.settings(id);
        const last = this.lastChecks.get(id) ?? 0;
        if (!guildId && Date.now() - last < Math.max(20, settings.pollIntervalSeconds) * 1000) continue;
        this.lastChecks.set(id, Date.now());
        const result = await this.checkGuild(id);
        total.scanned += result.scanned;
        total.ignored += result.ignored;
        total.approved += result.approved;
        total.review += result.review;
        total.errors.push(...result.errors);
      }
    } finally {
      this.running = false;
    }
    return total;
  }

  private async checkGuild(guildId: string): Promise<ImapCheckResult> {
    const result: ImapCheckResult = { scanned: 0, ignored: 0, approved: 0, review: 0, errors: [] };
    const settings = this.settings(guildId);
    if (!settings.enabled) return result;

    const password = this.db.getSecret("imap_password", guildId) ?? "";
    try {
      this.validate(guildId, settings, password);
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
      return result;
    }

    const client = this.client(settings, password);
    const accountKey = this.key(guildId, settings);
    const mailbox = settings.mailbox || "INBOX";

    try {
      await client.connect();
      const lock = await client.getMailboxLock(mailbox);
      try {
        const since = new Date(Date.now() - Math.max(5, settings.lookbackMinutes) * 60000);
        for await (const message of client.fetch({ since }, { uid: true, envelope: true, source: true, flags: true })) {
          const uid = String(message.uid ?? "");
          if (!uid || !message.source) continue;
          const processedKey = `${accountKey}:${mailbox}:${uid}`;
          if (this.db.state.processedEmails[processedKey]) continue;
          result.scanned++;

          try {
            const parsed = await simpleParser(message.source);
            const from = parsed.from?.value.map((entry) => (entry.address ?? "").toLowerCase()).filter(Boolean) ?? [];
            const senderText = parsed.from?.text ?? "";
            const subject = parsed.subject ?? "";
            const body = `${subject}\n${bodyText(parsed.text, parsed.html)}`;
            const authenticationResults = [parsed.headers.get("authentication-results"), parsed.headers.get("received-spf")]
              .filter(Boolean)
              .map((value) => String(value))
              .join(" ");

            if (!matchesSelectedBankNotification(settings, from, senderText, subject, body, authenticationResults)) {
              this.db.state.processedEmails[processedKey] = { key: processedKey, uid, messageId: parsed.messageId ?? "", orderId: "", status: "IGNORED", processedAt: nowIso() };
              result.ignored++;
              this.db.save();
              continue;
            }

            const amounts = parseImapAmounts(body);
            const match = this.match(guildId, settings, this.getPending(), amounts, body, parsed.date ?? new Date());
            if (match.safe && match.order) {
              await this.onPaid(match.order.id, {
                source: "imap",
                bank: settings.bank,
                uid,
                messageId: parsed.messageId,
                reason: match.reason,
                amountCents: match.order.totalCents,
                payerFullName: match.order.payerFullName
              });
              this.db.state.processedEmails[processedKey] = {
                key: processedKey,
                uid,
                messageId: parsed.messageId ?? "",
                orderId: match.order.id,
                status: "APPROVED",
                processedAt: nowIso(),
                amountCents: match.order.totalCents,
                reference: match.order.paymentReference
              };
              result.approved++;
              this.db.paymentAudit(guildId, "IMAP_APPROVED", match.order.id, { uid, bank: settings.bank, reason: match.reason });
            } else {
              this.db.state.processedEmails[processedKey] = { key: processedKey, uid, messageId: parsed.messageId ?? "", orderId: "", status: "REVIEW", processedAt: nowIso() };
              result.review++;
              this.db.paymentAudit(guildId, "IMAP_REVIEW", "", { uid, bank: settings.bank, reason: match.reason, amounts });
            }
            this.db.save();
            if (settings.markSeen && message.uid) await client.messageFlagsAdd(message.uid, ["\\Seen"], { uid: true }).catch(() => undefined);
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            result.errors.push(messageText);
            this.db.errorAudit(guildId, "IMAP_MESSAGE_ERROR", { error: messageText });
          }
        }
      } finally {
        lock.release();
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      result.errors.push(messageText);
      this.logger.warn("Falha temporária na verificação IMAP.", { guildId, error: messageText });
      this.db.errorAudit(guildId, "IMAP_CONNECTION_ERROR", { error: messageText });
    } finally {
      await client.logout().catch(() => undefined);
    }
    return result;
  }
}
