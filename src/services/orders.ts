import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder } from "discord.js";
import type { JsonDatabase } from "../core/json-db.js";
import type { Logger } from "../core/logger.js";
import { formatMoney, makeId, normalizeName, nowIso, truncate } from "../core/utils.js";
import type { DeliveredProduct, Order, OrderItem, PaymentProviderName } from "../types.js";
import { PaymentManager } from "./payments.js";
import { ProductService } from "./products.js";

type OrderListener = (order: Order) => void | Promise<void>;

export class OrderService {
  private timer?: NodeJS.Timeout;
  private running = false;
  private listeners = new Set<OrderListener>();

  constructor(
    private readonly client: Client,
    private readonly db: JsonDatabase,
    private readonly products: ProductService,
    private readonly payments: PaymentManager,
    private readonly logger: Logger
  ) {}

  onUpdate(listener: OrderListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private async emit(order: Order): Promise<void> {
    for (const listener of this.listeners) {
      try { await listener(order); }
      catch (error) { this.logger.warn("Falha ao atualizar uma interface vinculada ao pedido.", { orderId: order.id, error: String(error) }); }
    }
  }

  pendingImap(): Order[] {
    return Object.values(this.db.state.orders).filter((order) => order.status === "PENDING" && order.provider === "IMAP_PIX" && Date.parse(order.expiresAt) > Date.now());
  }
  get(id: string, guildId?: string): Order { const order = this.db.state.orders[id]; if (!order || (guildId && order.guildId !== guildId)) throw new Error("Pedido não encontrado."); return order; }
  userOrders(userId: string, guildId?: string): Order[] { return Object.values(this.db.state.orders).filter((order) => order.userId === userId && (!guildId || order.guildId === guildId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }

  async createFromCart(input: { guildId: string; userId: string; username: string; couponCode?: string; purchaseChannelId?: string; provider?: PaymentProviderName; payerFullName?: string; payerDocument?: string }): Promise<Order> {
    const cart = this.products.getCartSession(input.guildId, input.userId);
    if (!cart?.items.length) throw new Error("Seu carrinho está vazio.");
    if (cart.status === "PAYMENT_PENDING" && cart.orderId) return this.get(cart.orderId, input.guildId);
    const paymentSettings = this.db.payments(input.guildId);
    const provider = input.provider ?? (cart.selectedProvider || paymentSettings.defaultProvider);
    if (!this.payments.enabled(input.guildId, provider)) throw new Error("A forma de pagamento selecionada não está disponível.");
    const payerFullNameRaw = (input.payerFullName ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
    const payerFullName = normalizeName(payerFullNameRaw);
    const payerDocument = (input.payerDocument ?? "").replace(/\D/g, "").slice(0, 14);
    if (provider === "IMAP_PIX" && payerFullName.split(" ").filter(Boolean).length < 2) {
      throw new Error("Informe o nome completo de quem fará o Pix para a verificação IMAP.");
    }
    if (["STRIPE", "MISTIC_PAY"].includes(provider)) {
      if (payerFullName.split(" ").filter(Boolean).length < 2) throw new Error("Informe o nome completo de quem fará o PIX.");
      if (![11, 14].includes(payerDocument.length)) throw new Error("Informe um CPF com 11 dígitos ou CNPJ com 14 dígitos.");
    }

    const now = nowIso();
    const expirationMinutes = provider === "IMAP_PIX" ? Math.min(paymentSettings.orderExpiresMinutes, paymentSettings.imapPix.maxWaitMinutes) : paymentSettings.orderExpiresMinutes;
    // Pagamentos manuais permanecem pendentes até uma decisão da equipe. O
    // vencimento distante também mantém a reserva de stock íntegra durante a
    // análise, sem depender de um temporizador de carrinho.
    const expiresAt = provider === "MANUAL_PIX"
      ? "9999-12-31T23:59:59.999Z"
      : new Date(Date.now() + Math.max(1, expirationMinutes) * 60000).toISOString();
    const orderId = makeId("ORD").toUpperCase();
    const items: OrderItem[] = []; let subtotalCents = 0;
    try {
      for (const cartItem of cart.items) {
        const product = this.products.get(cartItem.productId, input.guildId); const field = this.products.getField(product.id, cartItem.fieldId);
        if (!product.active || !field.active) throw new Error(`${product.name} • ${field.name} está indisponível.`);
        const limit = this.products.quantityLimit(product, field); if (cartItem.quantity < 1 || cartItem.quantity > limit) throw new Error(`Quantidade inválida para ${product.name} • ${field.name}. Máximo: ${limit}.`);
        if (product.perUserLimit > 0) {
          const alreadyPurchased = this.userOrders(input.userId, input.guildId).filter((order) => ["PAID", "DELIVERED", "AWAITING_DELIVERY"].includes(order.status)).flatMap((order) => order.items).filter((item) => item.productId === product.id && item.fieldId === field.id).reduce((sum, item) => sum + item.quantity, 0);
          if (alreadyPurchased + cartItem.quantity > product.perUserLimit) throw new Error(`Seu limite individual para ${product.name} • ${field.name} é ${product.perUserLimit}.`);
        }
        const reservedStockIds = product.deliveryType === "STOCK" ? this.products.reserveStock(product.id, field.id, cartItem.quantity, orderId, expiresAt) : [];
        items.push({ productId: product.id, fieldId: field.id, productName: product.name, fieldName: field.name, quantity: cartItem.quantity, unitPriceCents: field.priceCents, deliveryType: product.deliveryType, roleId: product.roleId, deliveryMessage: product.deliveryMessage, reservedStockIds });
        subtotalCents += field.priceCents * cartItem.quantity;
      }
      const applied = this.products.applyCoupon(input.couponCode ?? cart.couponCode, subtotalCents, { guildId: input.guildId, userId: input.userId, productIds: items.map((item) => item.productId) });
      const order: Order = {
        id: orderId, guildId: input.guildId, userId: input.userId, status: "PENDING", items, subtotalCents,
        discountCents: applied.discountCents, totalCents: Math.max(0, subtotalCents - applied.discountCents), couponCode: applied.coupon?.code ?? "", couponUsageRegistered: false,
        provider, providerPaymentId: "", pixCode: "", qrCodeDataUrl: "", discordDisplayName: input.username.trim() || `Discord ${input.userId}`,
        payerEmail: paymentSettings.mercadoPago.payerEmail.trim() || `${input.userId}@discord.invalid`,
        payerFullName: ["IMAP_PIX", "STRIPE", "MISTIC_PAY"].includes(provider) ? payerFullNameRaw : "",
        payerDocument,
        imapBank: provider === "IMAP_PIX" ? paymentSettings.imapPix.bank : "",
        purchaseChannelId: input.purchaseChannelId || cart.channelId,
        cartId: cart.id, paymentReference: orderId.replace(/[^A-Za-z0-9]/g, "").slice(-25), verificationStatus: "PENDING", verificationDetails: {},
        paymentKey: this.payments.paymentKey(input.guildId, provider), deliveredProducts: [], expiresAt, createdAt: now, updatedAt: now
      };
      this.db.state.orders[order.id] = order; this.db.ensureUser(input.guildId, input.userId, input.username);
      cart.status = "PAYMENT_PENDING"; cart.orderId = order.id; cart.selectedProvider = provider; cart.updatedAt = nowIso(); this.db.save();

      if (order.totalCents === 0) {
        order.providerPaymentId = `free_${order.id}`; await this.markPaid(order.id, { source: "zero-total" }); return order;
      }
      const charge = await this.payments.create(provider, { guildId: input.guildId, orderId: order.id, amountCents: order.totalCents, description: `Pedido ${order.id} - ${items.map((item) => `${item.productName} (${item.fieldName})`).join(", ")}`, customer: { discordId: input.userId, name: order.payerFullName || order.discordDisplayName, email: order.payerEmail, document: order.payerDocument }, expiresAt });
      order.providerPaymentId = charge.externalId; order.pixCode = charge.pixCode ?? ""; order.qrCodeDataUrl = charge.qrCodeDataUrl ?? ""; order.paymentReference = charge.reference ?? order.paymentReference; order.expiresAt = charge.expiresAt ?? order.expiresAt; order.updatedAt = nowIso();
      cart.status = "PAYMENT_PENDING"; cart.orderId = order.id; cart.selectedProvider = provider; cart.updatedAt = nowIso();
      this.db.audit(input.userId, "ORDER_CREATE", "order", order.id, { guildId: input.guildId, totalCents: order.totalCents, provider, imapBank: order.imapBank }, input.guildId); this.db.save();
      if (charge.status === "paid") await this.markPaid(order.id, { source: "provider-create" }); else await this.emit(order);
      return order;
    } catch (error) {
      this.releaseOrderReservations({ id: orderId, items } as Order); delete this.db.state.orders[orderId];
      cart.status = "ACTIVE"; cart.orderId = ""; cart.updatedAt = nowIso(); this.db.save(); throw error;
    }
  }

  async markPaid(orderId: string, proof: Record<string, unknown> = {}): Promise<void> {
    const order = this.get(orderId); if (["DELIVERED", "AWAITING_DELIVERY", "PAID"].includes(order.status)) return; if (order.status !== "PENDING") throw new Error(`Pedido ${order.id} não está pendente.`);
    order.status = "PAID"; order.paidAt = nowIso(); order.verificationStatus = "MATCHED"; order.verificationDetails = proof; order.updatedAt = nowIso();
    if (order.couponCode && !order.couponUsageRegistered) {
      const coupon = this.products.getCoupon(order.guildId, order.couponCode); this.products.registerCouponUsage(coupon, order.userId, order.id, order.discountCents); order.couponUsageRegistered = true;
    }
    this.products.archiveCartById(order.cartId, "PAID");
    this.db.paymentAudit(order.guildId, "PAYMENT_APPROVED", order.id, { provider: order.provider, proof: this.safeProof(proof) }); this.db.save(); await this.fulfill(order); await this.emit(order);
  }

  async approveManual(orderId: string, actorId: string): Promise<void> {
    const order = this.get(orderId);
    if (order.provider !== "MANUAL_PIX") throw new Error("A aprovação manual só pode ser usada em pagamentos PIX manuais.");
    if (order.status !== "PENDING") throw new Error("Este pagamento manual não está pendente.");
    await this.markPaid(orderId, { source: "manual-approval", actorId });
    this.db.audit(actorId, "ORDER_APPROVE", "order", orderId, { guildId: order.guildId }, order.guildId);
  }

  async completeManualDelivery(orderId: string, actorId: string): Promise<void> {
    const order = this.get(orderId);
    if (order.status !== "AWAITING_DELIVERY") throw new Error("Este pedido não está aguardando entrega manual.");
    order.status = "DELIVERED";
    order.deliveredAt = nowIso();
    order.updatedAt = nowIso();
    this.db.audit(actorId, "ORDER_MANUAL_DELIVERY_COMPLETE", "order", order.id, { guildId: order.guildId }, order.guildId);
    this.db.save();
    const user = await this.client.users.fetch(order.userId).catch(() => undefined);
    const channel = order.purchaseChannelId ? await this.client.channels.fetch(order.purchaseChannelId).catch(() => undefined) : undefined;
    const message = `✅ A entrega manual do pedido **${order.id}** foi concluída pela equipe.`;
    if (user) await user.send(message).catch(() => undefined);
    if (channel?.isTextBased() && "send" in channel) await channel.send({ content: `<@${order.userId}> ${message}`, allowedMentions: { users: [order.userId] } }).catch(() => undefined);
    await this.emit(order);
  }

  cancel(orderId: string, actorId: string): void {
    const order = this.get(orderId); if (order.status !== "PENDING") throw new Error("Somente pedidos pendentes podem ser cancelados.");
    order.status = "CANCELED"; order.updatedAt = nowIso(); this.releaseOrderReservations(order); this.products.archiveCartById(order.cartId, "CANCELED");
    this.db.audit(actorId, "ORDER_CANCEL", "order", order.id, { guildId: order.guildId }, order.guildId); this.db.paymentAudit(order.guildId, "PAYMENT_CANCELED", order.id); this.db.save(); void this.emit(order);
  }

  markEnded(orderId: string, status: "CANCELED" | "EXPIRED", actorId = "provider"): void {
    const order = this.get(orderId); if (order.status !== "PENDING") return;
    order.status = status; order.updatedAt = nowIso(); this.releaseOrderReservations(order); this.products.archiveCartById(order.cartId, status);
    this.db.audit(actorId, status === "EXPIRED" ? "ORDER_EXPIRE" : "ORDER_CANCEL", "order", order.id, { guildId: order.guildId, source: actorId }, order.guildId);
    this.db.paymentAudit(order.guildId, status === "EXPIRED" ? "PAYMENT_EXPIRED" : "PAYMENT_CANCELED", order.id, { source: actorId });
    this.db.save(); void this.emit(order);
  }

  private releaseOrderReservations(order: Pick<Order, "id" | "items">): void { for (const item of order.items) this.products.releaseReservation(item.productId, item.fieldId, order.id); }
  private safeProof(proof: Record<string, unknown>): Record<string, unknown> { const copy = { ...proof }; for (const key of Object.keys(copy)) if (/token|password|secret|authorization/i.test(key)) copy[key] = "[REMOVIDO]"; return copy; }

  private async fulfill(order: Order): Promise<void> {
    const guild = await this.client.guilds.fetch(order.guildId).catch(() => undefined);
    const user = await this.client.users.fetch(order.userId).catch(() => undefined);
    const member = guild ? await guild.members.fetch(order.userId).catch(() => undefined) : undefined;
    const deliveredProducts: DeliveredProduct[] = Array.isArray(order.deliveredProducts) ? [...order.deliveredProducts] : [];
    let manual = false;

    for (const item of order.items) {
      if (item.deliveryType === "STOCK") {
        const contents = this.products.consumeReservation(item.productId, item.fieldId, order.id);
        for (const content of contents) {
          deliveredProducts.push({
            id: makeId("DLV"),
            productId: item.productId,
            fieldId: item.fieldId,
            productName: item.productName,
            fieldName: item.fieldName,
            content,
            deliveredAt: nowIso()
          });
        }
      } else if (item.deliveryType === "ROLE") {
        if (!member || !item.roleId) {
          manual = true;
          continue;
        }
        await member.roles.add(item.roleId, `Compra ${order.id}`).catch(() => { manual = true; });
      } else {
        manual = true;
      }
    }

    const guildSettings = this.db.guild(order.guildId);
    if (member && guildSettings.customerRoleId) await member.roles.add(guildSettings.customerRoleId, `Cliente ${order.id}`).catch(() => undefined);

    order.deliveredProducts = deliveredProducts;
    order.status = manual ? "AWAITING_DELIVERY" : "DELIVERED";
    order.deliveredAt = manual ? undefined : nowIso();
    order.updatedAt = nowIso();
    const profile = this.db.ensureUser(order.guildId, order.userId, user?.username ?? "");
    profile.totalSpentCents += order.totalCents;
    profile.purchases += 1;
    profile.updatedAt = nowIso();
    this.db.save();

    const brand = this.db.brand(order.guildId);
    const summary = new EmbedBuilder()
      .setColor(manual ? 0xf59e0b : 0x22c55e)
      .setTitle(manual ? `Pagamento aprovado • ${order.id}` : `Pedido entregue • ${order.id}`)
      .setDescription(manual ? "Pagamento confirmado. A equipe fará a entrega manual no canal privado." : "Pagamento confirmado e entrega automática processada.")
      .addFields(
        { name: "Valor", value: formatMoney(order.totalCents), inline: true },
        { name: "Método", value: order.provider.replaceAll("_", " "), inline: true },
        { name: "Itens", value: order.items.map((item) => `${item.quantity}× ${item.productName} • ${item.fieldName}`).join("\n").slice(0, 1024) }
      )
      .setFooter({ text: brand.footer })
      .setTimestamp();

    const purchaseChannel = order.purchaseChannelId
      ? await this.client.channels.fetch(order.purchaseChannelId).catch(() => undefined)
      : undefined;

    if (user) await user.send({ embeds: [summary] }).catch(() => undefined);
    if (purchaseChannel?.isTextBased() && "send" in purchaseChannel) {
      await purchaseChannel.send({ content: `<@${order.userId}>`, embeds: [summary], allowedMentions: { users: [order.userId] } }).catch(() => undefined);
    }

    for (const delivery of deliveredProducts) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`delivery:copy:${order.id}:${delivery.id}`)
          .setLabel("Copiar produto")
          .setStyle(ButtonStyle.Primary)
      );
      const payload = {
        content: delivery.content,
        components: [row],
        allowedMentions: { parse: [] as never[] }
      };
      const sentInDm = user ? await user.send(payload).then(() => true).catch(() => false) : false;
      if (!sentInDm && purchaseChannel?.isTextBased() && "send" in purchaseChannel) {
        await purchaseChannel.send({
          content: `<@${order.userId}> não foi possível enviar o produto por mensagem privada. Ative suas DMs e peça à equipe para reenviar.`,
          allowedMentions: { users: [order.userId] }
        }).catch(() => undefined);
      }
    }

    const logChannel = guildSettings.logChannelId ? await this.client.channels.fetch(guildSettings.logChannelId).catch(() => undefined) : undefined;
    if (logChannel?.isTextBased() && "send" in logChannel) {
      await logChannel.send({ embeds: [new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle(`Venda aprovada • ${order.id}`)
        .setDescription(`<@${order.userId}> • ${formatMoney(order.totalCents)} • ${order.provider}`)
        .addFields({ name: "Unidades entregues", value: String(deliveredProducts.length), inline: true })
        .setTimestamp()] }).catch(() => undefined);
    }
  }

  qrAttachment(order: Order): AttachmentBuilder | undefined { if (!order.qrCodeDataUrl.startsWith("data:image/")) return undefined; const match = order.qrCodeDataUrl.match(/^data:image\/[a-zA-Z0-9+.-]+;base64,(.+)$/); return match?.[1] ? new AttachmentBuilder(Buffer.from(match[1], "base64"), { name: "pix.png" }) : undefined; }

  startPolling() { this.stopPolling(); this.timer = setInterval(() => void this.poll(), 15_000); this.timer.unref?.(); setTimeout(() => void this.poll(), 7000).unref?.(); }
  stopPolling() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async poll() {
    if (this.running) return; this.running = true;
    try {
      for (const order of Object.values(this.db.state.orders).filter((item) => item.status === "PENDING")) {
        if (order.provider === "MANUAL_PIX") continue;
        if (Date.parse(order.expiresAt) <= Date.now()) { this.markEnded(order.id, "EXPIRED", "system-expiration"); continue; }
        if (order.provider === "IMAP_PIX" || !order.providerPaymentId) continue;
        try {
          const charge = await this.payments.status(order.guildId, order.provider, order.providerPaymentId);
          if (charge.status === "paid") await this.markPaid(order.id, { source: "poll", externalId: charge.externalId });
          else if (["canceled", "expired"].includes(charge.status)) this.markEnded(order.id, charge.status === "expired" ? "EXPIRED" : "CANCELED", "provider-poll");
        } catch (error) { this.logger.warn(`Falha ao consultar ${order.id}.`, error); this.db.errorAudit(order.guildId, "PAYMENT_POLL_ERROR", { orderId: order.id, error: String(error) }); }
      }
    } finally { this.running = false; }
  }
}
