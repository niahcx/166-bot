import type { PaymentCharge } from "../../types.js";
import type { ChargeInput, PaymentProvider } from "../contracts.js";
import { requireDocument } from "../contracts.js";
import { GatewayHttpClient, objectAt, textAt } from "../http-client.js";
import { pixQrDataUrl } from "../../services/pix.js";

function status(value: unknown): PaymentCharge["status"] {
  const current = textAt(value).toLowerCase();
  if (current === "succeeded") return "paid";
  if (current === "canceled") return "canceled";
  if (current === "requires_payment_method") return "canceled";
  return "pending";
}

export class StripePixProvider implements PaymentProvider {
  readonly name = "STRIPE" as const;
  private readonly http: GatewayHttpClient;

  constructor(secretKey: string, private readonly descriptor = "166COMMUNITY") {
    if (!/^sk_(?:live|test)_[A-Za-z0-9_]+$/.test(secretKey.trim())) throw new Error("A Secret Key da Stripe precisa começar com sk_live_ ou sk_test_.");
    this.http = new GatewayHttpClient("Stripe", "https://api.stripe.com", { Authorization: `Bearer ${secretKey.trim()}` });
  }

  async createCharge(input: ChargeInput): Promise<PaymentCharge> {
    const expiresSeconds = Math.max(10, Math.min(259_200, Math.floor((Date.parse(input.expiresAt) - Date.now()) / 1000)));
    const form = new URLSearchParams();
    const entries: Record<string, string> = {
      amount: String(input.amountCents),
      currency: "brl",
      confirm: "true",
      description: input.description.slice(0, 500),
      "payment_method_data[type]": "pix",
      "payment_method_data[billing_details][name]": input.customer.name.slice(0, 120),
      "payment_method_data[billing_details][email]": input.customer.email.slice(0, 255),
      "payment_method_data[billing_details][tax_id]": requireDocument(input.customer.document, "A Stripe PIX"),
      "payment_method_options[pix][expires_after_seconds]": String(expiresSeconds),
      "metadata[order_id]": input.orderId,
      "metadata[guild_id]": input.guildId,
      "metadata[discord_id]": input.customer.discordId,
      "statement_descriptor": this.descriptor.replace(/[^A-Za-z0-9 ]/g, "").slice(0, 22) || "166COMMUNITY"
    };
    for (const [key, value] of Object.entries(entries)) form.set(key, value);
    const result = await this.http.request("/v1/payment_intents", { method: "POST", form, idempotencyKey: input.orderId, retries: 1 });
    return this.toCharge(result.data);
  }

  async getCharge(externalId: string): Promise<PaymentCharge> {
    return this.toCharge((await this.http.request(`/v1/payment_intents/${encodeURIComponent(externalId)}`)).data);
  }

  async cancelCharge(externalId: string): Promise<PaymentCharge> {
    return this.toCharge((await this.http.request(`/v1/payment_intents/${encodeURIComponent(externalId)}/cancel`, { method: "POST", form: new URLSearchParams() })).data);
  }

  async test(): Promise<string> {
    const result = await this.http.request("/v1/account");
    return `Conta ${textAt(result.data.business_profile ? objectAt(result.data, "business_profile").name : result.data.id) || "autenticada"}`;
  }

  private async toCharge(data: Record<string, unknown>): Promise<PaymentCharge> {
    const externalId = textAt(data.id);
    if (!externalId) throw new Error("Stripe não retornou o ID do PaymentIntent.");
    const pix = objectAt(data, "next_action", "pix_display_qr_code");
    const pixCode = textAt(pix.data);
    const expiresUnix = Number(pix.expires_at ?? 0);
    return {
      externalId,
      status: status(data.status),
      pixCode: pixCode || undefined,
      qrCodeDataUrl: pixCode ? await pixQrDataUrl(pixCode) : textAt(pix.image_url_png) || undefined,
      expiresAt: expiresUnix > 0 ? new Date(expiresUnix * 1000).toISOString() : undefined,
      reference: externalId,
      raw: data
    };
  }
}
