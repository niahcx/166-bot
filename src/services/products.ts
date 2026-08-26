import { createHash } from "node:crypto";
import type { CartSession, Coupon, CouponUsage, Product, ProductField, StockItem } from "../types.js";
import type { JsonDatabase } from "../core/json-db.js";
import { clamp, makeId, nowIso, normalizeColor, slugify } from "../core/utils.js";

export class ProductService {
  constructor(private readonly db: JsonDatabase) {}

  list(activeOnly = false, guildId?: string): Product[] {
    return Object.values(this.db.state.products)
      .filter((product) => (!guildId || product.guildId === guildId) && (!activeOnly || product.active))
      .sort((a, b) => Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name));
  }

  get(id: string, guildId?: string): Product {
    const product = this.db.state.products[id];
    if (!product || (guildId && product.guildId !== guildId)) throw new Error("Produto não encontrado neste servidor.");
    return product;
  }

  activeFields(productOrId: Product | string): ProductField[] {
    const product = typeof productOrId === "string" ? this.get(productOrId) : productOrId;
    return product.fields.filter((field) => field.active);
  }

  getField(productId: string, fieldId?: string): ProductField {
    const product = this.get(productId);
    const field = fieldId ? product.fields.find((item) => item.id === fieldId) : this.activeFields(product)[0] ?? product.fields[0];
    if (!field) throw new Error("Este produto não possui opções configuradas.");
    return field;
  }

  private newField(input: Partial<ProductField> = {}, product?: Product): ProductField {
    const now = nowIso();
    return {
      id: makeId("FLD"),
      name: (input.name || "Opção principal").trim().slice(0, 100),
      description: (input.description || "").trim().slice(0, 100),
      priceCents: Math.max(0, Math.trunc(input.priceCents ?? product?.priceCents ?? 0)),
      compareAtCents: Math.max(0, Math.trunc(input.compareAtCents ?? 0)),
      emoji: (input.emoji || product?.emojiSemantic || "cart").trim().slice(0, 100),
      active: input.active ?? true,
      stockMode: input.stockMode === "GHOST" ? "GHOST" : "UNIQUE",
      ghostStock: {
        content: String(input.ghostStock?.content ?? ""),
        quantity: Math.max(0, Math.trunc(input.ghostStock?.quantity ?? 0)),
        reserved: Math.max(0, Math.trunc(input.ghostStock?.reserved ?? 0)),
        sold: Math.max(0, Math.trunc(input.ghostStock?.sold ?? 0)),
        reservations: { ...(input.ghostStock?.reservations ?? {}) },
        updatedAt: input.ghostStock?.updatedAt || now
      },
      createdAt: input.createdAt || now,
      updatedAt: now
    };
  }

  create(input: Omit<Partial<Product>, "fields"> & { guildId: string; fields?: Array<Partial<ProductField>> } & Pick<Product, "name" | "description" | "priceCents">, actorId = "system"): Product {
    if (!/^\d{15,22}$/.test(input.guildId)) throw new Error("Servidor inválido para o produto.");
    const now = nowIso();
    const product: Product = {
      id: makeId("PRD"), guildId: input.guildId,
      name: input.name.trim().slice(0, 100), slug: slugify(input.name), description: input.description.trim().slice(0, 4000),
      priceCents: Math.max(0, Math.trunc(input.priceCents)), compareAtCents: Math.max(0, Math.trunc(input.compareAtCents ?? 0)),
      emojiSemantic: input.emojiSemantic || "products", customEmoji: input.customEmoji || "", color: normalizeColor(input.color || this.db.brand(input.guildId).color),
      imageUrl: input.imageUrl || "", bannerUrl: input.bannerUrl || "", active: input.active ?? true, featured: input.featured ?? false,
      deliveryType: input.deliveryType || "STOCK", roleId: input.roleId || "", deliveryMessage: input.deliveryMessage || "Obrigado pela compra!",
      purchaseMode: "BUTTON", buttonLabel: input.buttonLabel || "Comprar agora", buttonStyle: input.buttonStyle || "SUCCESS",
      buttonEmoji: input.buttonEmoji || input.emojiSemantic || "cart", selectPlaceholder: input.selectPlaceholder || "Selecione um produto",
      fields: [], demonstrationEnabled: input.demonstrationEnabled ?? false, demonstrationUrl: input.demonstrationUrl || "",
      demonstrationLabel: input.demonstrationLabel || "Demonstração", demonstrationEmoji: input.demonstrationEmoji || "information",
      minQuantity: clamp(input.minQuantity ?? 1, 1, 100), maxQuantity: clamp(input.maxQuantity ?? 1, 1, 100),
      perUserLimit: clamp(input.perUserLimit ?? 0, 0, 10000), lowStockThreshold: clamp(input.lowStockThreshold ?? 3, 0, 10000),
      requireTerms: input.requireTerms ?? false, termsText: input.termsText || "", couponGroup: String(input.couponGroup ?? "").slice(0, 50),
      publications: [], createdAt: now, updatedAt: now
    };
    if (!product.name) throw new Error("Informe o nome do produto.");
    product.fields = input.fields?.length ? input.fields.slice(0, 25).map((field) => this.newField(field, product)) : [this.newField({ name: "Opção principal", priceCents: product.priceCents, emoji: product.buttonEmoji }, product)];
    this.syncLegacyPrice(product);
    this.db.state.products[product.id] = product;
    this.db.audit(actorId, "PRODUCT_CREATE", "product", product.id, { guildId: product.guildId, name: product.name }, product.guildId);
    this.db.save(); return product;
  }

  update(id: string, patch: Partial<Product>, actorId = "system"): Product {
    const product = this.get(id); const protectedKeys = new Set(["id", "guildId", "createdAt", "fields"]);
    for (const [key, value] of Object.entries(patch)) if (!protectedKeys.has(key) && value !== undefined) (product as unknown as Record<string, unknown>)[key] = value;
    product.name = product.name.trim().slice(0, 100); product.slug = slugify(product.name); product.description = product.description.trim().slice(0, 4000);
    product.color = normalizeColor(product.color, this.db.brand(product.guildId).color); product.buttonLabel = (product.buttonLabel || "Comprar agora").trim().slice(0, 80);
    product.buttonEmoji = (product.buttonEmoji || product.emojiSemantic || "cart").trim().slice(0, 100); product.selectPlaceholder = (product.selectPlaceholder || "Selecione um produto").trim().slice(0, 150);
    product.demonstrationUrl = (product.demonstrationUrl || "").trim().slice(0, 1000); product.demonstrationLabel = (product.demonstrationLabel || "Demonstração").trim().slice(0, 80);
    product.demonstrationEmoji = (product.demonstrationEmoji || "information").trim().slice(0, 100); product.demonstrationEnabled = Boolean(product.demonstrationEnabled && /^https?:\/\//i.test(product.demonstrationUrl));
    product.minQuantity = clamp(product.minQuantity, 1, 100); product.maxQuantity = clamp(Math.max(product.maxQuantity, product.minQuantity), 1, 100);
    product.perUserLimit = clamp(product.perUserLimit || 0, 0, 10000); product.couponGroup = String(product.couponGroup || "").slice(0, 50);
    product.purchaseMode = this.activeFields(product).length > 1 ? "SELECT" : "BUTTON"; this.syncLegacyPrice(product); product.updatedAt = nowIso();
    this.db.audit(actorId, "PRODUCT_UPDATE", "product", product.id, { guildId: product.guildId, name: product.name }, product.guildId); this.db.save(); return product;
  }

  addField(productId: string, input: Partial<ProductField>, actorId = "system"): ProductField {
    const product = this.get(productId); if (product.fields.length >= 25) throw new Error("O Discord permite no máximo 25 opções por menu.");
    const field = this.newField(input, product); if (!field.name) throw new Error("Informe o nome da opção."); product.fields.push(field);
    product.purchaseMode = this.activeFields(product).length > 1 ? "SELECT" : "BUTTON"; this.syncLegacyPrice(product); product.updatedAt = nowIso();
    this.db.audit(actorId, "PRODUCT_FIELD_CREATE", "product", productId, { guildId: product.guildId, fieldId: field.id, name: field.name }, product.guildId); this.db.save(); return field;
  }

  updateField(productId: string, fieldId: string, patch: Partial<ProductField>, actorId = "system"): ProductField {
    const product = this.get(productId); const field = this.getField(productId, fieldId); const protectedKeys = new Set(["id", "createdAt", "ghostStock"]);
    for (const [key, value] of Object.entries(patch)) if (!protectedKeys.has(key) && value !== undefined) (field as unknown as Record<string, unknown>)[key] = value;
    field.name = (field.name || "Opção").trim().slice(0, 100); field.description = (field.description || "").trim().slice(0, 100);
    field.priceCents = Math.max(0, Math.trunc(field.priceCents)); field.compareAtCents = Math.max(0, Math.trunc(field.compareAtCents)); field.emoji = (field.emoji || product.emojiSemantic || "cart").trim().slice(0, 100);
    field.stockMode = field.stockMode === "GHOST" ? "GHOST" : "UNIQUE"; field.updatedAt = nowIso(); product.purchaseMode = this.activeFields(product).length > 1 ? "SELECT" : "BUTTON";
    this.syncLegacyPrice(product); product.updatedAt = nowIso(); this.db.audit(actorId, "PRODUCT_FIELD_UPDATE", "product", productId, { guildId: product.guildId, fieldId, name: field.name }, product.guildId); this.db.save(); return field;
  }

  deleteField(productId: string, fieldId: string, actorId = "system"): void {
    const product = this.get(productId); if (product.fields.length <= 1) throw new Error("O produto precisa ter pelo menos uma opção."); const field = this.getField(productId, fieldId);
    if (this.stockCount(productId, "RESERVED", fieldId) > 0) throw new Error("Esta opção possui estoque reservado."); product.fields = product.fields.filter((item) => item.id !== fieldId);
    delete this.db.state.stock[this.stockKey(productId, fieldId)]; for (const cart of Object.values(this.db.state.carts)) cart.items = cart.items.filter((item) => !(item.productId === productId && item.fieldId === fieldId));
    product.purchaseMode = this.activeFields(product).length > 1 ? "SELECT" : "BUTTON"; this.syncLegacyPrice(product); product.updatedAt = nowIso();
    this.db.audit(actorId, "PRODUCT_FIELD_DELETE", "product", productId, { guildId: product.guildId, fieldId, name: field.name }, product.guildId); this.db.save();
  }

  duplicate(id: string, actorId = "system"): Product {
    const source = this.get(id); const copy = this.create({ ...source, guildId: source.guildId, name: `${source.name} (cópia)`, fields: source.fields.map((field) => ({ ...field, ghostStock: { ...field.ghostStock, reserved: 0, sold: 0, reservations: {} } })) }, actorId);
    copy.publications = []; this.db.save(); return copy;
  }

  delete(id: string, actorId = "system"): void {
    const product = this.get(id); if (this.stockCount(id, "RESERVED") > 0) throw new Error("Produto possui estoque reservado.");
    delete this.db.state.products[id]; for (const key of Object.keys(this.db.state.stock)) if (key.startsWith(`${id}:`)) delete this.db.state.stock[key];
    for (const cart of Object.values(this.db.state.carts)) cart.items = cart.items.filter((item) => item.productId !== id);
    this.db.audit(actorId, "PRODUCT_DELETE", "product", id, { guildId: product.guildId, name: product.name }, product.guildId); this.db.save();
  }

  addPublication(productId: string, guildId: string, channelId: string, messageId: string): void {
    const product = this.get(productId, guildId); product.publications = product.publications.filter((p) => p.messageId !== messageId); product.publications.push({ guildId, channelId, messageId }); this.db.save();
  }
  removePublication(productId: string, messageId: string): void { const product = this.get(productId); product.publications = product.publications.filter((p) => p.messageId !== messageId); this.db.save(); }

  private stockKey(productId: string, fieldId: string): string { return `${productId}:${fieldId}`; }
  private stockItems(productId: string, fieldId: string): StockItem[] { const key = this.stockKey(productId, fieldId); return this.db.state.stock[key] ?? (this.db.state.stock[key] = []); }

  stockCount(productId: string, status: StockItem["status"] = "AVAILABLE", fieldId?: string): number {
    const product = this.get(productId); const fields = fieldId ? [this.getField(productId, fieldId)] : product.fields;
    return fields.reduce((total, field) => field.stockMode === "GHOST"
      ? total + (status === "AVAILABLE" ? Math.max(0, field.ghostStock.quantity - field.ghostStock.reserved - field.ghostStock.sold) : status === "RESERVED" ? field.ghostStock.reserved : field.ghostStock.sold)
      : total + this.stockItems(productId, field.id).filter((item) => item.status === status).length, 0);
  }

  addStock(productId: string, raw: string, actorId = "system", fieldId?: string): number {
    const product = this.get(productId);
    const field = this.getField(productId, fieldId);
    if (field.stockMode === "GHOST") throw new Error("Use a configuração de stock fantasma para esta opção.");

    const normalized = raw.replace(/\r\n/g, "\n").trim();
    const units = normalized.includes("\n\n")
      ? normalized.split(/\n[ \t]*\n+/).map((block) => block.trim()).filter(Boolean)
      : normalized.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!units.length) throw new Error("Nenhuma unidade válida foi informada.");
    const oversized = units.find((content) => content.length > 1900);
    if (oversized) throw new Error("Cada unidade de stock deve possuir no máximo 1900 caracteres para permitir a cópia privada pelo Discord.");

    const items = this.stockItems(productId, field.id);
    const hashes = new Set(items.map((item) => item.contentHash));
    let added = 0;
    for (const content of units) {
      const hash = createHash("sha256").update(content).digest("hex");
      if (hashes.has(hash)) continue;
      items.push({ id: makeId("STK"), guildId: product.guildId, productId, fieldId: field.id, content, contentHash: hash, status: "AVAILABLE", createdAt: nowIso() });
      hashes.add(hash);
      added++;
    }
    this.db.audit(actorId, "STOCK_ADD", "product", productId, { guildId: product.guildId, fieldId: field.id, added }, product.guildId);
    this.db.save();
    return added;
  }

  useUniqueStock(productId: string, fieldId?: string, limit = 1900): string {
    const field = this.getField(productId, fieldId); if (field.stockMode === "GHOST") return field.ghostStock.content.slice(0, limit);
    return this.stockItems(productId, field.id).filter((item) => item.status === "AVAILABLE").map((item) => item.content).join("\n").slice(0, limit);
  }

  clearStock(productId: string, actorId = "system", fieldId?: string): number {
    const product = this.get(productId); const field = this.getField(productId, fieldId); if (field.stockMode === "GHOST") { const removed = Math.max(0, field.ghostStock.quantity - field.ghostStock.reserved - field.ghostStock.sold); field.ghostStock.quantity = field.ghostStock.reserved + field.ghostStock.sold; field.ghostStock.updatedAt = nowIso(); this.db.save(); return removed; }
    const items = this.stockItems(productId, field.id); const keep = items.filter((item) => item.status !== "AVAILABLE"); const removed = items.length - keep.length; this.db.state.stock[this.stockKey(productId, field.id)] = keep;
    this.db.audit(actorId, "STOCK_CLEAR", "product", productId, { guildId: product.guildId, fieldId: field.id, removed }, product.guildId); this.db.save(); return removed;
  }

  setGhostStock(productId: string, fieldId: string, content: string, quantity: number, actorId = "system"): ProductField {
    const product = this.get(productId); const field = this.getField(productId, fieldId); if (field.ghostStock.reserved > 0 && quantity < field.ghostStock.reserved + field.ghostStock.sold) throw new Error("Quantidade menor que unidades reservadas/vendidas.");
    if (content.length > 1900) throw new Error("O conteúdo do stock fantasma deve possuir no máximo 1900 caracteres para permitir a cópia privada pelo Discord.");
    field.stockMode = "GHOST"; field.ghostStock.content = content; field.ghostStock.quantity = Math.max(0, Math.trunc(quantity)); field.ghostStock.updatedAt = nowIso(); field.updatedAt = nowIso();
    this.db.audit(actorId, "GHOST_STOCK_SET", "product", productId, { guildId: product.guildId, fieldId, quantity }, product.guildId); this.db.save(); return field;
  }

  reserveStock(productId: string, fieldId: string, quantity: number, orderId: string, expiresAt: string): string[] {
    const field = this.getField(productId, fieldId); const requested = Math.max(1, Math.trunc(quantity));
    if (field.stockMode === "GHOST") { const available = this.stockCount(productId, "AVAILABLE", fieldId); if (available < requested) throw new Error(`Stock insuficiente para ${field.name}.`); field.ghostStock.reserved += requested; field.ghostStock.reservations[orderId] = (field.ghostStock.reservations[orderId] ?? 0) + requested; field.ghostStock.updatedAt = nowIso(); this.db.save(); return [`GHOST:${fieldId}:${orderId}`]; }
    const available = this.stockItems(productId, fieldId).filter((item) => item.status === "AVAILABLE").slice(0, requested); if (available.length < requested) throw new Error(`Stock insuficiente para ${field.name}.`);
    for (const item of available) { item.status = "RESERVED"; item.orderId = orderId; item.reservedUntil = expiresAt; } this.db.save(); return available.map((item) => item.id);
  }

  releaseReservation(productId: string, fieldId: string, orderId: string): void {
    const field = this.getField(productId, fieldId); if (field.stockMode === "GHOST") { const quantity = field.ghostStock.reservations[orderId] ?? 0; field.ghostStock.reserved = Math.max(0, field.ghostStock.reserved - quantity); delete field.ghostStock.reservations[orderId]; field.ghostStock.updatedAt = nowIso(); this.db.save(); return; }
    for (const item of this.stockItems(productId, fieldId)) if (item.orderId === orderId && item.status === "RESERVED") { item.status = "AVAILABLE"; delete item.orderId; delete item.reservedUntil; } this.db.save();
  }

  consumeReservation(productId: string, fieldId: string, orderId: string): string[] {
    const field = this.getField(productId, fieldId); if (field.stockMode === "GHOST") { const quantity = field.ghostStock.reservations[orderId] ?? 0; if (!quantity) return []; field.ghostStock.reserved = Math.max(0, field.ghostStock.reserved - quantity); field.ghostStock.sold += quantity; delete field.ghostStock.reservations[orderId]; field.ghostStock.updatedAt = nowIso(); this.db.save(); return Array.from({ length: quantity }, () => field.ghostStock.content); }
    const sold: string[] = []; for (const item of this.stockItems(productId, fieldId)) if (item.orderId === orderId && item.status === "RESERVED") { item.status = "SOLD"; item.soldAt = nowIso(); sold.push(item.content); } this.db.save(); return sold;
  }

  getCartSession(guildId: string, userId: string): CartSession | undefined { return Object.values(this.db.state.carts).find((cart) => cart.guildId === guildId && cart.userId === userId && ["ACTIVE", "CHECKOUT", "PAYMENT_PENDING"].includes(cart.status)); }
  ensureCart(guildId: string, userId: string, sourceChannelId = "", sourceMessageId = ""): CartSession {
    const existing = this.getCartSession(guildId, userId); if (existing) { if (sourceChannelId) existing.sourceChannelId = sourceChannelId; if (sourceMessageId) existing.sourceMessageId = sourceMessageId; existing.updatedAt = nowIso(); return existing; }
    const id = makeId("CRT"); const cart: CartSession = { id, guildId, userId, channelId: "", messageId: "", sourceChannelId, sourceMessageId, items: [], couponCode: "", selectedProvider: "", status: "ACTIVE", orderId: "", createdAt: nowIso(), updatedAt: nowIso(), expiresAt: new Date(Date.now() + 86400000).toISOString() };
    this.db.state.carts[id] = cart; this.db.save(); return cart;
  }
  cart(userId: string, guildId?: string): CartSession["items"] { if (guildId) return this.getCartSession(guildId, userId)?.items ?? []; return Object.values(this.db.state.carts).find((cart) => cart.userId === userId && cart.status === "ACTIVE")?.items ?? []; }

  addToCart(userId: string, productId: string, fieldId?: string, quantity = 1, guildId?: string): CartSession["items"] {
    const product = this.get(productId, guildId); const field = this.getField(productId, fieldId); if (!product.active || !field.active) throw new Error("Produto indisponível.");
    const cart = this.ensureCart(product.guildId, userId); const existing = cart.items.find((item) => item.productId === productId && item.fieldId === field.id);
    const next = clamp((existing?.quantity ?? 0) + Math.max(1, quantity), product.minQuantity, this.quantityLimit(product, field));
    if (existing) existing.quantity = next; else cart.items.push({ productId, fieldId: field.id, quantity: next }); cart.updatedAt = nowIso(); this.db.save(); return cart.items;
  }

  setCartQuantity(userId: string, productId: string, fieldId: string, quantity: number, guildId?: string): CartSession["items"] {
    const product = this.get(productId, guildId); const field = this.getField(productId, fieldId); const cart = this.ensureCart(product.guildId, userId); const requested = Math.trunc(quantity); const limit = this.quantityLimit(product, field);
    if (requested < 1) throw new Error("A quantidade mínima é 1."); if (requested > limit) throw new Error(`A quantidade máxima disponível é ${limit}.`);
    const item = cart.items.find((entry) => entry.productId === productId && entry.fieldId === fieldId); if (item) item.quantity = requested; else cart.items.push({ productId, fieldId, quantity: requested }); cart.updatedAt = nowIso(); this.db.save(); return cart.items;
  }

  quantityLimit(product: Product, field: ProductField): number {
    const configured = Math.max(product.minQuantity, product.maxQuantity); const stock = product.deliveryType === "STOCK" ? this.stockCount(product.id, "AVAILABLE", field.id) : configured;
    const personal = product.perUserLimit > 0 ? product.perUserLimit : configured; return Math.max(0, Math.min(configured, personal, product.deliveryType === "STOCK" ? stock : configured));
  }

  removeFromCart(userId: string, productId: string, fieldId?: string, guildId?: string): CartSession["items"] {
    const product = this.get(productId, guildId); const cart = this.getCartSession(product.guildId, userId); if (!cart) return [];
    cart.items = cart.items.filter((item) => !(item.productId === productId && (!fieldId || item.fieldId === fieldId))); cart.updatedAt = nowIso(); this.db.save(); return cart.items;
  }
  clearCart(userId: string, guildId?: string): void { const carts = Object.values(this.db.state.carts).filter((cart) => cart.userId === userId && (!guildId || cart.guildId === guildId)); for (const cart of carts) cart.items = []; this.db.save(); }
  archiveCartById(cartId: string, status: CartSession["status"]): CartSession | undefined {
    const cart = this.db.state.carts[cartId] ?? this.db.state.abandonedCarts[cartId];
    if (!cart) return;
    cart.status = status; cart.updatedAt = nowIso();
    this.db.state.abandonedCarts[cart.id] = cart;
    delete this.db.state.carts[cart.id];
    this.db.save();
    return cart;
  }
  abandonCart(guildId: string, userId: string, status: CartSession["status"] = "CANCELED"): CartSession | undefined {
    const cart = Object.values(this.db.state.carts).find((entry) => entry.guildId === guildId && entry.userId === userId);
    return cart ? this.archiveCartById(cart.id, status) : undefined;
  }

  createCoupon(input: Omit<Coupon, "id" | "uses" | "createdAt" | "updatedAt">, actorId = "system"): Coupon {
    const code = input.code.trim().toUpperCase().replace(/\s+/g, "").slice(0, 30); if (!code) throw new Error("Código inválido.");
    if (Object.values(this.db.state.coupons).some((c) => c.guildId === input.guildId && c.code === code)) throw new Error("Já existe um cupom com esse código.");
    const now = nowIso(); const coupon: Coupon = {
      ...input, id: makeId("CPN"), code,
      value: input.type === "PERCENT" ? Math.min(100, Math.max(0, input.value)) : Math.max(0, input.value),
      minOrderCents: Math.max(0, input.minOrderCents), maxUses: input.maxUses === null ? null : Math.max(0, Math.trunc(input.maxUses)),
      perUserLimit: Math.max(0, Math.trunc(input.perUserLimit)), productIds: [...new Set(input.productIds)].filter((productId) => this.db.state.products[productId]?.guildId === input.guildId),
      productGroups: [...new Set(input.productGroups.map((group) => group.trim()).filter(Boolean))], uses: 0, createdAt: now, updatedAt: now
    };
    if (coupon.value <= 0) throw new Error("O desconto precisa ser maior que zero.");
    if (coupon.startsAt && coupon.expiresAt && Date.parse(coupon.startsAt) >= Date.parse(coupon.expiresAt)) throw new Error("A expiração precisa ser posterior ao início.");
    this.db.state.coupons[coupon.id] = coupon; this.db.audit(actorId, "COUPON_CREATE", "coupon", coupon.id, { guildId: coupon.guildId, code }, coupon.guildId); this.db.save(); return coupon;
  }
  getCoupon(guildId: string, idOrCode: string): Coupon { const coupon = this.db.state.coupons[idOrCode] ?? Object.values(this.db.state.coupons).find((c) => c.guildId === guildId && c.code === idOrCode.trim().toUpperCase()); if (!coupon || coupon.guildId !== guildId) throw new Error("Cupom não encontrado."); return coupon; }
  updateCoupon(guildId: string, id: string, patch: Partial<Coupon>, actorId = "system"): Coupon {
    const coupon = this.getCoupon(guildId, id); const protectedKeys = new Set(["id", "guildId", "uses", "createdAt"]);
    for (const [key, value] of Object.entries(patch)) if (!protectedKeys.has(key) && value !== undefined) (coupon as unknown as Record<string, unknown>)[key] = value;
    coupon.code = coupon.code.trim().toUpperCase().replace(/\s+/g, "").slice(0, 30);
    if (!coupon.code) throw new Error("Código inválido.");
    if (Object.values(this.db.state.coupons).some((item) => item.guildId === guildId && item.id !== id && item.code === coupon.code)) throw new Error("Já existe outro cupom com esse código.");
    coupon.value = Math.max(0, coupon.value); if (coupon.type === "PERCENT") coupon.value = Math.min(100, coupon.value);
    coupon.minOrderCents = Math.max(0, coupon.minOrderCents); coupon.maxUses = coupon.maxUses === null ? null : Math.max(0, Math.trunc(coupon.maxUses)); coupon.perUserLimit = Math.max(0, Math.trunc(coupon.perUserLimit));
    coupon.productIds = [...new Set(coupon.productIds)].filter((productId) => this.db.state.products[productId]?.guildId === guildId);
    coupon.productGroups = [...new Set(coupon.productGroups.map((group) => group.trim()).filter(Boolean))];
    coupon.updatedAt = nowIso(); this.db.audit(actorId, "COUPON_UPDATE", "coupon", id, { guildId, code: coupon.code }, guildId); this.db.save(); return coupon;
  }
  deleteCoupon(guildId: string, id: string, actorId = "system"): void { const coupon = this.getCoupon(guildId, id); delete this.db.state.coupons[coupon.id]; this.db.audit(actorId, "COUPON_DELETE", "coupon", coupon.id, { guildId, code: coupon.code }, guildId); this.db.save(); }

  applyCoupon(code: string, subtotalCents: number, context?: { guildId: string; userId: string; productIds: string[] }): { coupon?: Coupon; discountCents: number } {
    if (!code.trim()) return { discountCents: 0 };
    const guildId = context?.guildId ?? ""; const coupon = Object.values(this.db.state.coupons).find((item) => (!guildId || item.guildId === guildId) && item.code === code.trim().toUpperCase());
    if (!coupon) throw new Error("Cupom inválido."); if (!coupon.active) throw new Error("Este cupom está desativado."); const now = Date.now();
    if (coupon.startsAt && Date.parse(coupon.startsAt) > now) throw new Error("Este cupom ainda não está disponível."); if (coupon.expiresAt && Date.parse(coupon.expiresAt) <= now) throw new Error("Cupom expirado.");
    if (coupon.maxUses !== null && coupon.uses >= coupon.maxUses) throw new Error("O limite total de usos deste cupom foi atingido."); if (subtotalCents < coupon.minOrderCents) throw new Error("O pedido não atingiu o valor mínimo do cupom.");
    if (context) {
      const userUses = this.db.state.couponUsages.filter((usage) => usage.guildId === context.guildId && usage.couponId === coupon.id && usage.userId === context.userId).length;
      if (coupon.perUserLimit > 0 && userUses >= coupon.perUserLimit) throw new Error("Você já atingiu o limite de uso deste cupom.");
      if (coupon.productIds.length || coupon.productGroups.length) {
        const invalid = context.productIds.some((productId) => {
          const product = this.db.state.products[productId];
          return !coupon.productIds.includes(productId) && !(product?.couponGroup && coupon.productGroups.includes(product.couponGroup));
        });
        if (invalid) throw new Error("Este cupom não é válido para um ou mais produtos selecionados.");
      }
    }
    const discountCents = coupon.type === "PERCENT" ? Math.min(subtotalCents, Math.round(subtotalCents * coupon.value / 100)) : Math.min(subtotalCents, coupon.value);
    return { coupon, discountCents };
  }

  registerCouponUsage(coupon: Coupon, userId: string, orderId: string, discountCents: number): CouponUsage {
    const existing = this.db.state.couponUsages.find((usage) => usage.orderId === orderId && usage.couponId === coupon.id); if (existing) return existing;
    const usage: CouponUsage = { id: makeId("CPU"), guildId: coupon.guildId, couponId: coupon.id, code: coupon.code, userId, orderId, discountCents, usedAt: nowIso() };
    this.db.state.couponUsages.unshift(usage); coupon.uses = this.db.state.couponUsages.filter((item) => item.couponId === coupon.id).length; coupon.updatedAt = nowIso(); this.db.save(); return usage;
  }

  cartTotals(guildId: string, userId: string): { subtotalCents: number; discountCents: number; totalCents: number; coupon?: Coupon } {
    const cart = this.getCartSession(guildId, userId); if (!cart) return { subtotalCents: 0, discountCents: 0, totalCents: 0 };
    let subtotalCents = 0; const productIds: string[] = [];
    for (const item of cart.items) { const product = this.get(item.productId, guildId); const field = this.getField(product.id, item.fieldId); subtotalCents += field.priceCents * item.quantity; productIds.push(product.id); }
    const applied = this.applyCoupon(cart.couponCode, subtotalCents, { guildId, userId, productIds }); return { subtotalCents, discountCents: applied.discountCents, totalCents: Math.max(0, subtotalCents - applied.discountCents), coupon: applied.coupon };
  }

  private syncLegacyPrice(product: Product): void { const first = this.activeFields(product)[0] ?? product.fields[0]; if (first) { product.priceCents = first.priceCents; product.compareAtCents = first.compareAtCents; } }
}
