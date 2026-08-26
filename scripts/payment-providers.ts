import assert from "node:assert/strict";
import { MisticPayProvider } from "../src/payments/providers/mistic-pay.ts";
import { PurinCashProvider } from "../src/payments/providers/purin-cash.ts";
import { StripePixProvider } from "../src/payments/providers/stripe.ts";
import type { ChargeInput } from "../src/payments/contracts.ts";

const input: ChargeInput = {
  guildId: "123456789012345678",
  orderId: "ORD_PROVIDER_TEST",
  amountCents: 1990,
  description: "Pedido de teste",
  customer: {
    discordId: "223456789012345678",
    name: "Cliente de Teste",
    email: "223456789012345678@discord.invalid",
    document: "12345678909"
  },
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
};

const calls: Array<{ url: string; init?: RequestInit }> = [];
let purinAttempts = 0;
const originalFetch = globalThis.fetch;

globalThis.fetch = (async (resource: string | URL | Request, init?: RequestInit) => {
  const url = String(resource);
  calls.push({ url, init });
  if (url.endsWith("/v1/payment_intents")) {
    const form = new URLSearchParams(String(init?.body ?? ""));
    assert.equal(form.get("amount"), "1990");
    assert.equal(form.get("payment_method_data[type]"), "pix");
    assert.equal(form.get("payment_method_data[billing_details][tax_id]"), "12345678909");
    assert.equal(new Headers(init?.headers).get("Idempotency-Key"), input.orderId);
    return Response.json({ id: "pi_test", status: "requires_action", next_action: { pix_display_qr_code: { data: "000201STRIPEPIX", expires_at: Math.floor(Date.now() / 1000) + 900 } } });
  }
  if (url.endsWith("/api/transactions/create")) {
    assert.equal(new Headers(init?.headers).get("ci"), "client-id");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.payerDocument, "12345678909");
    return Response.json({ data: { transactionId: "mistic_123", transactionState: "PENDENTE", copyPaste: "000201MISTICPIX", qrCodeBase64: "data:image/png;base64,AA==" } });
  }
  if (url.endsWith("/v1/payments")) {
    purinAttempts++;
    if (purinAttempts === 1) return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.valueCents, 1990);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer ps_test_abcdefgh12345678");
    return Response.json({ paymentId: "psa_test", status: "pending", expiresAt: input.expiresAt, pix: { brCode: "000201PURINPIX", qrCodeImage: null } });
  }
  throw new Error(`URL de teste inesperada: ${url}`);
}) as typeof fetch;

try {
  const stripe = await new StripePixProvider("sk_test_abcdefghijklmnopqrstuvwxyz", "166COMMUNITY").createCharge(input);
  assert.equal(stripe.externalId, "pi_test");
  assert.equal(stripe.pixCode, "000201STRIPEPIX");
  assert.match(stripe.qrCodeDataUrl ?? "", /^data:image\/png;base64,/);

  const mistic = await new MisticPayProvider("client-id", "client-secret").createCharge(input);
  assert.equal(mistic.externalId, "mistic_123");
  assert.equal(mistic.pixCode, "000201MISTICPIX");

  const purin = await new PurinCashProvider("ps_test_abcdefgh12345678").createCharge(input);
  assert.equal(purin.externalId, "psa_test");
  assert.equal(purin.pixCode, "000201PURINPIX");
  assert.equal(purinAttempts, 2);
  assert.ok(calls.length >= 4);
  console.log("PAYMENT_PROVIDERS_OK: Stripe, MisticPay e Purin Cash validaram contratos, PIX, autenticação, idempotência e retry");
} finally {
  globalThis.fetch = originalFetch;
}

