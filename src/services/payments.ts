import { createHash, randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { JsonDatabase } from "../core/json-db.js";
import type { Logger } from "../core/logger.js";
import type { PaymentCharge, PaymentProviderName } from "../types.js";
import type { ChargeInput, PaymentProvider as Provider } from "../payments/contracts.js";
import { MisticPayProvider } from "../payments/providers/mistic-pay.js";
import { PurinCashProvider } from "../payments/providers/purin-cash.js";
import { StripePixProvider } from "../payments/providers/stripe.js";
import { createStaticPixPayload, pixQrDataUrl } from "./pix.js";
import { makeId, nowIso } from "../core/utils.js";

const text = (value: unknown) => String(value ?? "").trim();
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
function normalizeStatus(value: unknown): PaymentCharge["status"] {
  const status = text(value).toLowerCase();
  if (["paid", "approved", "completed", "succeeded", "concluida", "concluído", "recebido", "CONCLUIDA".toLowerCase()].includes(status)) return "paid";
  if (["canceled", "cancelled", "refused", "failed", "rejected", "removida_pelo_usuario_recebedor", "removida_pelo_psp"].includes(status)) return "canceled";
  if (["expired", "timeout", "expirada"].includes(status)) return "expired";
  return "pending";
}
async function fetchJson(url: string, init: RequestInit, provider: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(25_000), headers: { Accept: "application/json", "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const body = await response.text();
  let data: Record<string, unknown> = {};
  try { data = body ? JSON.parse(body) as Record<string, unknown> : {}; } catch { throw new Error(`${provider} retornou resposta inválida.`); }
  if (!response.ok) throw new Error(text(data.message ?? data.error ?? `${provider} respondeu HTTP ${response.status}`).slice(0, 500));
  return data;
}
async function mutualTlsJson(url: string, options: { pfx: Buffer; passphrase?: string; headers?: Record<string, string>; body?: string; method: string }, provider: string): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpsRequest({
      protocol: target.protocol, hostname: target.hostname, port: target.port ? Number(target.port) : 443,
      path: `${target.pathname}${target.search}`, method: options.method, pfx: options.pfx, passphrase: options.passphrase,
      minVersion: "TLSv1.2", timeout: 25_000,
      headers: { Accept: "application/json", "Accept-Encoding": "identity", ...(options.body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(options.body) } : {}), ...(options.headers ?? {}) }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        try {
          const body = Buffer.concat(chunks).toString("utf8");
          const data = body ? JSON.parse(body) as Record<string, unknown> : {};
          const status = response.statusCode ?? 500;
          if (status < 200 || status >= 300) throw new Error(text(data.mensagem ?? data.message ?? `${provider} respondeu HTTP ${status}`).slice(0, 500));
          resolve(data);
        } catch (error) { reject(error); }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`${provider} excedeu o tempo limite.`)));
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

class ManualProvider implements Provider {
  readonly name = "MANUAL_PIX" as const;
  constructor(private readonly pixEmail: string, private readonly merchantName: string) {}
  async createCharge(input: ChargeInput): Promise<PaymentCharge> {
    const email = this.pixEmail.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Configure um e-mail válido como chave PIX manual.");
    const reference = input.orderId.replace(/[^A-Za-z0-9]/g, "").slice(-25).toUpperCase();
    const pixCode = createStaticPixPayload({
      pixKey: email,
      pixKeyType: "email",
      merchantName: this.merchantName || "166 Community",
      merchantCity: "SAO PAULO",
      amountCents: input.amountCents,
      txid: reference,
      description: `Pedido ${reference}`
    });
    return { externalId: `manual_${input.orderId}`, status: "pending", pixCode, qrCodeDataUrl: await pixQrDataUrl(pixCode), expiresAt: input.expiresAt, reference };
  }
  async getCharge(externalId: string): Promise<PaymentCharge> { return { externalId, status: "pending" }; }
  async test() { if (!/^\S+@\S+\.\S+$/.test(this.pixEmail.trim())) throw new Error("E-mail PIX manual não configurado."); return "PIX manual pronto para gerar cobranças"; }
}

class MercadoPagoProvider implements Provider {
  readonly name = "MERCADO_PAGO" as const;
  private readonly baseUrl = "https://api.mercadopago.com";
  constructor(private readonly token: string, private readonly payerEmail: string, private readonly descriptor: string) {
    if (token.length < 20) throw new Error("Access Token do Mercado Pago inválido.");
  }
  private request(path: string, init: RequestInit) { return fetchJson(`${this.baseUrl}${path}`, { ...init, headers: { Authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) } }, "Mercado Pago"); }
  async test() { const data = await this.request("/users/me", { method: "GET" }); return `Conta ${text(data.nickname ?? data.email ?? data.id) || "autenticada"}`; }
  async createCharge(input: ChargeInput): Promise<PaymentCharge> {
    const email = input.customer.email || this.payerEmail;
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Configure um e-mail padrão válido no painel do Mercado Pago.");
    const parts = input.customer.name.trim().split(/\s+/);
    const payload = {
      transaction_amount: Number((input.amountCents / 100).toFixed(2)), description: input.description.slice(0, 255), payment_method_id: "pix",
      external_reference: input.orderId, date_of_expiration: input.expiresAt,
      payer: { email, first_name: parts[0], last_name: parts.slice(1).join(" ") || undefined },
      metadata: { order_id: input.orderId, discord_id: input.customer.discordId },
      statement_descriptor: this.descriptor.replace(/[^A-Za-z0-9 ]/g, "").slice(0, 22) || undefined
    };
    const data = await this.request("/v1/payments", { method: "POST", headers: { "X-Idempotency-Key": input.orderId || randomUUID() }, body: JSON.stringify(payload) });
    return this.toCharge(data);
  }
  async getCharge(id: string) { return this.toCharge(await this.request(`/v1/payments/${encodeURIComponent(id)}`, { method: "GET" })); }
  private toCharge(data: Record<string, unknown>): PaymentCharge {
    const transaction = asRecord(asRecord(data.point_of_interaction).transaction_data);
    const id = text(data.id); if (!id) throw new Error("Mercado Pago não retornou o ID do pagamento.");
    const base64 = text(transaction.qr_code_base64);
    return { externalId: id, status: normalizeStatus(data.status), pixCode: text(transaction.qr_code) || undefined, qrCodeDataUrl: base64 ? `data:image/png;base64,${base64}` : undefined, expiresAt: text(data.date_of_expiration) || undefined, reference: text(data.external_reference) || undefined, raw: data };
  }
}

class EfiProvider implements Provider {
  readonly name = "EFI_BANK" as const;
  private token?: { value: string; expiresAt: number };
  constructor(private readonly clientId: string, private readonly clientSecret: string, private readonly pfx: Buffer, private readonly passphrase: string | undefined, private readonly sandbox: boolean, private readonly pixKey: string) {
    if (!clientId || !clientSecret) throw new Error("Configure Client ID e Client Secret da Efí Bank.");
    if (!pfx.length) throw new Error("Configure o certificado P12/PFX da Efí Bank.");
    if (!pixKey) throw new Error("Configure a chave PIX da Efí Bank.");
  }
  private get baseUrl() { return this.sandbox ? "https://pix-h.api.efipay.com.br" : "https://pix.api.efipay.com.br"; }
  private async accessToken() {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const data = await mutualTlsJson(`${this.baseUrl}/oauth/token`, { method: "POST", pfx: this.pfx, passphrase: this.passphrase, body: JSON.stringify({ grant_type: "client_credentials" }), headers: { Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}` } }, "Efí Bank");
    const value = text(data.access_token); if (!value) throw new Error("Efí Bank não retornou access_token.");
    this.token = { value, expiresAt: Date.now() + Math.max(300, Number(data.expires_in ?? 3600)) * 1000 };
    return value;
  }
  private async request(path: string, method: string, body?: Record<string, unknown>) {
    return mutualTlsJson(`${this.baseUrl}${path}`, { method, pfx: this.pfx, passphrase: this.passphrase, body: body ? JSON.stringify(body) : undefined, headers: { Authorization: `Bearer ${await this.accessToken()}` } }, "Efí Bank");
  }
  private txid(orderId: string) { return createHash("sha256").update(orderId).digest("hex").slice(0, 26).toUpperCase(); }
  async test() { await this.accessToken(); return this.sandbox ? "OAuth homologação autenticado" : "OAuth produção autenticado"; }
  async createCharge(input: ChargeInput): Promise<PaymentCharge> {
    const txid = this.txid(input.orderId);
    const seconds = Math.max(300, Math.min(86400, Math.floor((Date.parse(input.expiresAt) - Date.now()) / 1000)));
    const charge = await this.request(`/v2/cob/${txid}`, "PUT", { calendario: { expiracao: seconds }, valor: { original: (input.amountCents / 100).toFixed(2) }, chave: this.pixKey, solicitacaoPagador: input.description.slice(0, 140), infoAdicionais: [{ nome: "Pedido", valor: input.orderId }, { nome: "Discord", valor: input.customer.discordId }] });
    const locationId = text(asRecord(charge.loc).id);
    const qr = locationId ? await this.request(`/v2/loc/${encodeURIComponent(locationId)}/qrcode`, "GET") : {};
    const pixCode = text(qr.qrcode);
    return { externalId: txid, status: normalizeStatus(charge.status), pixCode: pixCode || undefined, qrCodeDataUrl: pixCode ? await pixQrDataUrl(pixCode) : undefined, expiresAt: input.expiresAt, reference: txid, raw: { charge, qr } };
  }
  async getCharge(id: string): Promise<PaymentCharge> { const data = await this.request(`/v2/cob/${encodeURIComponent(id)}`, "GET"); return { externalId: id, status: normalizeStatus(data.status), reference: id, raw: data }; }
}

class ImapPixProvider implements Provider {
  readonly name = "IMAP_PIX" as const;
  constructor(private readonly settings: { pixKey: string; pixKeyType: "cpf" | "cnpj" | "email" | "phone" | "random" | "unknown"; merchantName: string; merchantCity: string }) {}
  async createCharge(input: ChargeInput): Promise<PaymentCharge> {
    const reference = input.orderId.replace(/[^A-Za-z0-9]/g, "").slice(-25).toUpperCase();
    const pixCode = createStaticPixPayload({ pixKey: this.settings.pixKey, pixKeyType: this.settings.pixKeyType, merchantName: this.settings.merchantName, merchantCity: this.settings.merchantCity, amountCents: input.amountCents, txid: reference, description: `Pedido ${reference}` });
    return { externalId: `imap_${input.orderId}`, status: "pending", pixCode, qrCodeDataUrl: await pixQrDataUrl(pixCode), expiresAt: input.expiresAt, reference };
  }
  async getCharge(id: string): Promise<PaymentCharge> { return { externalId: id, status: "pending" }; }
  async test() { return "Cobrança PIX estática gerada; a caixa IMAP será testada separadamente"; }
}

export class PaymentManager {
  constructor(private readonly db: JsonDatabase, private readonly logger: Logger) {}

  provider(guildId: string, name: PaymentProviderName): Provider {
    const settings = this.db.payments(guildId);
    if (name === "MERCADO_PAGO") return new MercadoPagoProvider(
      this.db.getSecret("mp_access_token", guildId) ?? "",
      settings.mercadoPago.payerEmail,
      settings.mercadoPago.statementDescriptor
    );
    if (name === "EFI_BANK") return new EfiProvider(
      this.db.getSecret("efi_client_id", guildId) ?? "",
      this.db.getSecret("efi_client_secret", guildId) ?? "",
      Buffer.from(this.db.getSecret("efi_certificate_base64", guildId) ?? "", "base64"),
      this.db.getSecret("efi_certificate_password", guildId),
      settings.efiBank.sandbox,
      settings.efiBank.pixKey
    );
    if (name === "STRIPE") return new StripePixProvider(
      this.db.getSecret("stripe_secret_key", guildId) ?? "",
      settings.stripe.statementDescriptor
    );
    if (name === "MISTIC_PAY") return new MisticPayProvider(
      this.db.getSecret("mistic_client_id", guildId) ?? "",
      this.db.getSecret("mistic_client_secret", guildId) ?? "",
      settings.misticPay.webhookUrl
    );
    if (name === "PURIN_CASH") return new PurinCashProvider(
      this.db.getSecret("purin_api_key", guildId) ?? "",
      settings.purinCash.callbackUrl
    );
    if (name === "IMAP_PIX") return new ImapPixProvider(settings.imapPix);
    return new ManualProvider(settings.manualPixKey, this.db.brand(guildId).name);
  }


  paymentKey(guildId: string, name: PaymentProviderName): string {
    const settings = this.db.payments(guildId);
    if (name === "MERCADO_PAGO") return settings.mercadoPago.pixKey.trim();
    if (name === "EFI_BANK") return settings.efiBank.pixKey.trim();
    if (name === "IMAP_PIX") return settings.imapPix.pixKey.trim();
    if (["STRIPE", "MISTIC_PAY", "PURIN_CASH"].includes(name)) return "";
    return settings.manualPixKey.trim();
  }

  enabled(guildId: string, name: PaymentProviderName): boolean {
    const s = this.db.payments(guildId);
    if (name === "MERCADO_PAGO") return s.mercadoPago.enabled && Boolean(s.mercadoPago.pixKey.trim() && this.db.getSecret("mp_access_token", guildId));
    if (name === "EFI_BANK") return s.efiBank.enabled && Boolean(s.efiBank.pixKey.trim() && this.db.getSecret("efi_client_id", guildId) && this.db.getSecret("efi_client_secret", guildId) && this.db.getSecret("efi_certificate_base64", guildId));
    if (name === "IMAP_PIX") return s.imapPix.enabled && Boolean(s.imapPix.bank && s.imapPix.host && s.imapPix.username && s.imapPix.pixKey && this.db.getSecret("imap_password", guildId));
    if (name === "STRIPE") return s.stripe.enabled && Boolean(this.db.getSecret("stripe_secret_key", guildId));
    if (name === "MISTIC_PAY") return s.misticPay.enabled && Boolean(this.db.getSecret("mistic_client_id", guildId) && this.db.getSecret("mistic_client_secret", guildId));
    if (name === "PURIN_CASH") return s.purinCash.enabled && Boolean(this.db.getSecret("purin_api_key", guildId));
    return /^\S+@\S+\.\S+$/.test(s.manualPixKey.trim());
  }

  enabledMethods(guildId: string): PaymentProviderName[] {
    return (["MERCADO_PAGO", "EFI_BANK", "STRIPE", "MISTIC_PAY", "PURIN_CASH", "IMAP_PIX", "MANUAL_PIX"] as PaymentProviderName[]).filter((name) => this.enabled(guildId, name));
  }

  async create(name: PaymentProviderName, input: ChargeInput): Promise<PaymentCharge> {
    if (!this.enabled(input.guildId, name)) throw new Error(`${name.replaceAll("_", " ")} está desativado ou incompleto.`);
    this.logger.info(`Criando cobrança ${name} para ${input.orderId}.`, { guildId: input.guildId });
    const startedAt = Date.now();
    try {
      const charge = await this.provider(input.guildId, name).createCharge(input);
      this.db.paymentAudit(input.guildId, "PAYMENT_CREATE", input.orderId, { provider: name, externalId: charge.externalId, status: charge.status });
      this.db.state.gatewayTransactions.unshift({ id: makeId("GTX"), guildId: input.guildId, orderId: input.orderId, provider: name, externalId: charge.externalId, operation: "CREATE", status: charge.status, attempt: 1, durationMs: Date.now() - startedAt, errorCode: "", createdAt: nowIso() });
      if (this.db.state.gatewayTransactions.length > 20000) this.db.state.gatewayTransactions.length = 20000;
      this.db.save();
      return charge;
    } catch (error) {
      this.db.paymentAudit(input.guildId, "PAYMENT_CREATE_ERROR", input.orderId, { provider: name, error: String(error) });
      this.db.state.gatewayTransactions.unshift({ id: makeId("GTX"), guildId: input.guildId, orderId: input.orderId, provider: name, externalId: "", operation: "CREATE", status: "error", attempt: 1, durationMs: Date.now() - startedAt, errorCode: error instanceof Error ? error.name : "Error", createdAt: nowIso() });
      this.db.save();
      throw error;
    }
  }

  async status(guildId: string, name: PaymentProviderName, externalId: string): Promise<PaymentCharge> {
    const startedAt = Date.now();
    try {
      const charge = await this.provider(guildId, name).getCharge(externalId);
      this.db.state.gatewayTransactions.unshift({ id: makeId("GTX"), guildId, orderId: "", provider: name, externalId, operation: "STATUS", status: charge.status, attempt: 1, durationMs: Date.now() - startedAt, errorCode: "", createdAt: nowIso() });
      this.db.save();
      return charge;
    } catch (error) {
      this.db.state.gatewayTransactions.unshift({ id: makeId("GTX"), guildId, orderId: "", provider: name, externalId, operation: "STATUS", status: "error", attempt: 1, durationMs: Date.now() - startedAt, errorCode: error instanceof Error ? error.name : "Error", createdAt: nowIso() });
      this.db.save();
      throw error;
    }
  }

  async test(guildId: string, name: PaymentProviderName): Promise<string> {
    const provider = this.provider(guildId, name);
    return provider.test ? await provider.test() : "Configuração válida";
  }
}
