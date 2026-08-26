import type { PaymentCharge } from "../../types.js";
import type { ChargeInput, PaymentProvider } from "../contracts.js";
import { requireDocument } from "../contracts.js";
import { GatewayHttpClient, objectAt, textAt } from "../http-client.js";

function status(value: unknown): PaymentCharge["status"] {
  const current = textAt(value).toUpperCase();
  if (current === "COMPLETO") return "paid";
  if (["FALHA", "CANCELADO"].includes(current)) return "canceled";
  return "pending";
}

export class MisticPayProvider implements PaymentProvider {
  readonly name = "MISTIC_PAY" as const;
  private readonly http: GatewayHttpClient;

  constructor(clientId: string, clientSecret: string, private readonly webhookUrl = "") {
    if (!clientId.trim() || !clientSecret.trim()) throw new Error("Configure o Client ID e o Client Secret da MisticPay.");
    this.http = new GatewayHttpClient("MisticPay", "https://api.misticpay.com", { ci: clientId.trim(), cs: clientSecret.trim() });
  }

  async createCharge(input: ChargeInput): Promise<PaymentCharge> {
    const result = await this.http.request("/api/transactions/create", {
      method: "POST",
      retries: 1,
      json: {
        amount: Number((input.amountCents / 100).toFixed(2)),
        payerName: input.customer.name.trim().slice(0, 120),
        payerDocument: requireDocument(input.customer.document, "A MisticPay"),
        transactionId: input.orderId,
        description: input.description.slice(0, 255),
        ...(this.webhookUrl ? { projectWebhook: this.webhookUrl } : {})
      }
    });
    const data = objectAt(result.data, "data");
    const externalId = textAt(data.transactionId);
    if (!externalId) throw new Error("MisticPay não retornou o ID da transação.");
    return {
      externalId,
      status: status(data.transactionState),
      pixCode: textAt(data.copyPaste) || undefined,
      qrCodeDataUrl: textAt(data.qrCodeBase64) || undefined,
      expiresAt: input.expiresAt,
      reference: input.orderId,
      raw: result.data
    };
  }

  async getCharge(externalId: string): Promise<PaymentCharge> {
    const result = await this.http.request("/api/transactions/check", { method: "POST", json: { transactionId: externalId } });
    const transaction = objectAt(result.data, "transaction");
    return { externalId, status: status(transaction.transactionState), reference: textAt(transaction.clientTransactionId) || undefined, raw: result.data };
  }

  async test(): Promise<string> {
    const result = await this.http.request("/api/users/info");
    const data = objectAt(result.data, "data");
    return `Conta ${textAt(data.name) || "autenticada"}`;
  }
}

