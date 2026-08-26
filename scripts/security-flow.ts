import assert from "node:assert/strict";
import { MessageFlags } from "discord.js";
import { InteractionRouter } from "../src/discord/router.ts";
import type { Order } from "../src/types.ts";

const buyerId = "223456789012345678";
const guildId = "123456789012345678";
const paymentKey = "123e4567-e89b-12d3-a456-426614174000";
const deliveredContent = "usuario:senha\nhttps://conteudo.exemplo/licenca";

const order: Order = {
  id: "ORD_TESTE",
  guildId,
  userId: buyerId,
  status: "DELIVERED",
  items: [],
  subtotalCents: 1000,
  discountCents: 0,
  totalCents: 1000,
  couponCode: "",
  couponUsageRegistered: false,
  provider: "MANUAL_PIX",
  providerPaymentId: "manual_ORD_TESTE",
  pixCode: "000201010212",
  qrCodeDataUrl: "",
  discordDisplayName: "Cliente",
  payerEmail: "",
  payerFullName: "",
  payerDocument: "",
  imapBank: "",
  purchaseChannelId: "323456789012345678",
  cartId: "CRT_TESTE",
  paymentReference: "ORDTESTE",
  verificationStatus: "MATCHED",
  verificationDetails: {},
  paymentKey,
  deliveredProducts: [{
    id: "DLV_TESTE",
    productId: "PRD_TESTE",
    fieldId: "FLD_TESTE",
    productName: "Produto",
    fieldName: "Padrão",
    content: deliveredContent,
    deliveredAt: new Date().toISOString()
  }],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  paidAt: new Date().toISOString(),
  deliveredAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

async function invoke(methodName: "paymentButton" | "deliveryCopyButton", interaction: Record<string, unknown>, ...args: unknown[]) {
  const method = (InteractionRouter.prototype as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>)[methodName];
  assert.equal(typeof method, "function");
  return method!.call({ orders: { get: () => order } }, interaction, ...args);
}

async function main() {
  let paymentPayload: Record<string, unknown> | undefined;
  await invoke("paymentButton", {
    user: { id: buyerId },
    reply: async (payload: Record<string, unknown>) => { paymentPayload = payload; }
  }, `payment:key:${order.id}`, guildId);
  assert.deepEqual(paymentPayload, {
    content: order.pixCode,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] }
  });
  assert.equal(paymentPayload?.content, order.pixCode);

  let secondPixPayload: Record<string, unknown> | undefined;
  await invoke("paymentButton", {
    user: { id: buyerId },
    reply: async (payload: Record<string, unknown>) => { secondPixPayload = payload; }
  }, `payment:code:${order.id}`, guildId);
  assert.deepEqual(secondPixPayload, paymentPayload);
  assert.notEqual(secondPixPayload?.content, paymentKey);

  let deliveryPayload: Record<string, unknown> | undefined;
  await invoke("deliveryCopyButton", {
    user: { id: buyerId },
    guildId,
    reply: async (payload: Record<string, unknown>) => { deliveryPayload = payload; }
  }, `delivery:copy:${order.id}:DLV_TESTE`);
  assert.equal(deliveryPayload?.content, deliveredContent);
  assert.equal(deliveryPayload?.flags, MessageFlags.Ephemeral);
  assert.equal(Object.keys(deliveryPayload ?? {}).sort().join(","), "allowedMentions,content,flags");

  await assert.rejects(() => invoke("paymentButton", {
    user: { id: "999999999999999999" },
    reply: async () => undefined
  }, `payment:key:${order.id}`, guildId), /outro usuário/);

  await assert.rejects(() => invoke("deliveryCopyButton", {
    user: { id: "999999999999999999" },
    guildId,
    reply: async () => undefined
  }, `delivery:copy:${order.id}:DLV_TESTE`), /outro cliente/);

  console.log("SECURITY_FLOW_OK: os dois botões PIX retornam somente o copia-e-cola; produto e pagamento bloqueiam outros usuários");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
