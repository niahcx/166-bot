import type { PaymentCharge } from "../../types.js";
import type { ChargeInput, PaymentProvider } from "../contracts.js";
import { GatewayHttpClient, objectAt, textAt } from "../http-client.js";
import { pixQrDataUrl } from "../../services/pix.js";

function status(value: unknown): PaymentCharge["status"] {
  const current = textAt(value).toLowerCase();
  if (current === "paid") return "paid";
  if (current === "expired") return "expired";
  if (["refunded", "canceled", "failed"].includes(current)) return "canceled";
  return "pending";
}

export class PurinCashProvider implements PaymentProvider {
  readonly name = "PURIN_CASH" as const;
  private readonly http: GatewayHttpClient;

  constructor(apiKey: string, private readonly callbackUrl = "") {
    if (!/^ps_(?:live|test)_[A-Za-z0-9_-]{8,}$/.test(apiKey.trim())) throw new Error("A chave Purin Cash precisa começar com ps_live_ ou ps_test_.");
    this.http = new GatewayHttpClient("Purin Cash", "https://api.purincash.com", { Authorization: `Bearer ${apiKey.trim()}` });
  }

  async createCharge(input: ChargeInput): Promise<PaymentCharge> {
    if (input.amountCents < 80) throw new Error("A Purin Cash exige cobrança mínima de R$ 0,80.");
    const result = await this.http.request("/v1/payments", {
      method: "POST",
      retries: 2,
      json: {
        valueCents: input.amountCents,
        description: input.description.slice(0, 200),
        paymentMethod: "pix",
        ...(this.callbackUrl ? { callbackUrl: this.callbackUrl } : {}),
        customer: {
          name: input.customer.name.slice(0, 100),
          email: input.customer.email.slice(0, 255),
          externalId: input.customer.discordId.slice(0, 200)
        },
        metadata: JSON.stringify({ orderId: input.orderId, guildId: input.guildId }).slice(0, 2048)
      }
    });
    const pix = objectAt(result.data, "pix");
    const externalId = textAt(result.data.paymentId);
    if (!externalId) throw new Error("Purin Cash não retornou paymentId.");
    return {
      externalId,
      status: status(result.data.status),
      pixCode: textAt(pix.brCode) || undefined,
      qrCodeDataUrl: textAt(pix.qrCodeImage) || (textAt(pix.brCode) ? await pixQrDataUrl(textAt(pix.brCode)) : undefined),
      expiresAt: textAt(result.data.expiresAt) || input.expiresAt,
      reference: input.orderId,
      raw: result.data
    };
  }

  async getCharge(externalId: string): Promise<PaymentCharge> {
    const result = await this.http.request(`/v1/payments/${encodeURIComponent(externalId)}`, { retries: 2 });
    return { externalId, status: status(result.data.status), expiresAt: textAt(result.data.expiresAt) || undefined, raw: result.data };
  }

  async test(): Promise<string> {
    await this.http.request("/v1/payments?limit=1&offset=0", { retries: 1 });
    return "Chave autenticada e API acessível";
  }
}
