import type { PaymentCharge } from "../../types.js";
import type { ChargeInput, PaymentProvider } from "../contracts.js";
import { GatewayHttpClient, textAt, objectAt } from "../http-client.js";
import { pixQrDataUrl } from "../../services/pix.js";

function status(value: unknown): PaymentCharge["status"] {
  const current = textAt(value).toLowerCase();
  if (current === "paid") return "paid";
  if (current === "expired") return "expired";
  if (["refunded", "canceled", "failed", "cancelled"].includes(current)) return "canceled";
  return "pending";
}

export class VexoPayProvider implements PaymentProvider {
  readonly name = "VEXO_PAY" as const;
  private readonly http: GatewayHttpClient;

  constructor(private readonly ci: string, private readonly cs: string) {
    if (!ci.trim() || !cs.trim()) throw new Error("VexoPay requer client_id (ci) e client_secret (cs).");
    this.http = new GatewayHttpClient("VexoPay", "https://www.vexopay.com.br/api", {
      ci: ci.trim(),
      cs: cs.trim()
    });
  }

  async createCharge(input: ChargeInput): Promise<PaymentCharge> {
    if (input.amountCents < 200) throw new Error("A VexoPay exige cobrança mínima de R$ 2,00.");
    const amount = input.amountCents / 100;
    const result = await this.http.request("/gateway/pix-create", {
      method: "POST",
      retries: 2,
      json: {
        amount,
        payerName: input.customer.name.slice(0, 100),
        payerDocument: input.customer.document.replace(/\D/g, "").slice(0, 11),
        description: input.description.slice(0, 200)
      }
    });
    const data = result.data;
    const inner = objectAt(data, "data");
    const transactionId = textAt(inner.transactionId || data.transactionId);
    if (!transactionId) throw new Error("VexoPay não retornou transactionId.");
    const pixCode = textAt(inner.pixCode || inner.copyPaste || data.pixCode || data.copyPaste);
    const qrCodeBase64 = textAt(inner.qrCodeBase64 || inner.qrCode || data.qrCodeBase64 || data.qrCode);
    return {
      externalId: transactionId,
      status: status(inner.status || data.status || "pending"),
      pixCode: pixCode || undefined,
      qrCodeDataUrl: qrCodeBase64 || (pixCode ? await pixQrDataUrl(pixCode) : undefined),
      expiresAt: input.expiresAt,
      reference: input.orderId,
      raw: data
    };
  }

  async getCharge(externalId: string): Promise<PaymentCharge> {
    const result = await this.http.request(`/gateway/pix-status?transactionId=${encodeURIComponent(externalId)}`, { retries: 2 });
    const data = result.data;
    const inner = objectAt(data, "data");
    return {
      externalId,
      status: status(inner.status || data.status),
      raw: data
    };
  }

  async test(): Promise<string> {
    const result = await this.http.request("/gateway/balance", { retries: 1 });
    const data = result.data;
    const inner = objectAt(data, "data");
    const balance = textAt(inner.balance || data.balance);
    return `VexoPay conectado! Saldo: R$ ${balance}`;
  }
}
