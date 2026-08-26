import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type {
  AuditLog,
  AutomationSettings,
  BackupSummary,
  BrandSettings,
  CartSession,
  DatabaseSchema,
  GuildSettings,
  PaymentSettings,
  Product,
  ProtectionSettings,
  UserProfile
} from "../types.js";
import { makeId, nowIso, normalizeColor } from "./utils.js";
import type { Logger } from "./logger.js";
import type { CredentialStore } from "./credential-store.js";

const BRAND_DEFAULTS: BrandSettings = {
  name: "166 Community",
  color: "#3155ff",
  footer: "166 Community • Automação completa para Discord",
  logoUrl: "",
  bannerUrl: "",
  storeTitle: "Produtos",
  storeDescription: "Escolha um produto para iniciar uma compra privada.",
  ticketTitle: "Central de Atendimento",
  ticketDescription: "Selecione o assunto para abrir um atendimento privado.",
  presenceText: "suas vendas funcionarem 24/7",
  presenceType: "Watching",
  status: "online"
};

const PAYMENT_DEFAULTS: PaymentSettings = {
  defaultProvider: "MANUAL_PIX",
  orderExpiresMinutes: 15,
  pollIntervalSeconds: 15,
  manualPixCode: "",
  manualPixKey: "",
  mercadoPago: { enabled: false, payerEmail: "", statementDescriptor: "166COMMUNITY", pixKey: "" },
  efiBank: { enabled: false, sandbox: true, pixKey: "", merchantName: "166 Community", merchantCity: "SAO PAULO", certificateConfigured: false },
  stripe: { enabled: false, statementDescriptor: "166COMMUNITY", webhookUrl: "" },
  misticPay: { enabled: false, webhookUrl: "" },
  purinCash: { enabled: false, callbackUrl: "" },
  imapPix: {
    enabled: false,
    bank: "INTER",
    emailProvider: "GMAIL",
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    username: "",
    mailbox: "INBOX",
    pollIntervalSeconds: 30,
    lookbackMinutes: 90,
    maxWaitMinutes: 15,
    markSeen: false,
    pixKey: "",
    pixKeyType: "random",
    merchantName: "166 Community",
    merchantCity: "SAO PAULO"
  }
};

const AUTOMATION_DEFAULTS: AutomationSettings = {
  welcomeEnabled: false,
  welcomeMessage: "Bem-vindo(a), {user}! Agora somos {count} membros.",
  goodbyeEnabled: false,
  goodbyeMessage: "{user} saiu do servidor.",
  autoRoleEnabled: false,
  autoResponsesEnabled: false,
  autoResponses: [],
  channelSchedules: []
};

const PROTECTION_DEFAULTS: ProtectionSettings = {
  antiLink: false,
  allowedDomains: [],
  antiSpam: true,
  spamMessages: 6,
  spamWindowSeconds: 8,
  spamTimeoutSeconds: 60,
  blockInvites: true,
  logDeletedMessages: true,
  logEditedMessages: true
};

const clone = <T>(value: T): T => structuredClone(value);
const uniqueIds = (value: unknown): string[] => [...new Set(Array.isArray(value) ? value.map(String).filter((id) => /^\d{15,22}$/.test(id)) : [])];

export function guildDefaults(guildId: string): GuildSettings {
  return {
    guildId,
    adminRoleIds: [],
    logChannelId: "",
    salesChannelId: "",
    ticketCategoryId: "",
    closedTicketCategoryId: "",
    archiveTicketCategoryId: "",
    purchaseCategoryId: "",
    ticketLogChannelId: "",
    staffRoleIds: [],
    customerRoleId: "",
    welcomeChannelId: "",
    goodbyeChannelId: "",
    autoRoleId: "",
    emojiTheme: "solid",
    emojiOverrides: {},
    stockRequest: {
      enabled: true,
      title: "Não encontrou o produto que procura?",
      description: "Nossa equipe pode verificar a disponibilidade para você.\n\nClique no botão abaixo e informe o item, a quantidade e os detalhes importantes.",
      color: "#3155ff",
      imageUrl: "",
      thumbnailUrl: "",
      footer: "166 Community • Pedidos de stock",
      buttonLabel: "Pedir Stock",
      buttonStyle: "PRIMARY",
      emojiSemantic: "stock_request",
      requestChannelId: "",
      notifyRoleIds: [],
      confirmationMessage: "Seu pedido de stock foi registrado. A equipe avisará quando houver disponibilidade."
    },
    restockAnnouncements: {
      enabled: false,
      channelId: "",
      mentionRoleId: "",
      title: "Estoque atualizado",
      message: "Um produto acaba de receber novas unidades.",
      includeProductBanner: true
    },
    emojiLibrary: { allowMembers: true, maxPerUser: 25 },
    permissions: {
      adminUserIds: [], adminRoleIds: [], authorizedUserIds: [], authorizedRoleIds: [], supportRoleIds: [],
      ticketRoleIds: [], paymentRoleIds: [], productRoleIds: [], adminCommandRoleIds: []
    },
    locks: { ignoredChannelIds: [], speakingRoleIds: [], snapshots: {} }
  };
}

function defaults(): DatabaseSchema {
  const now = nowIso();
  return {
    version: 13,
    brand: clone(BRAND_DEFAULTS),
    guildBrands: {},
    guilds: {},
    payments: clone(PAYMENT_DEFAULTS),
    guildPayments: {},
    automations: clone(AUTOMATION_DEFAULTS),
    guildAutomations: {},
    protection: clone(PROTECTION_DEFAULTS),
    guildProtection: {},
    products: {}, stock: {}, carts: {}, abandonedCarts: {}, coupons: {}, couponUsages: [], orders: {},
    ticketPanels: {}, tickets: {}, ticketHistory: [], stockRequests: {}, restockAnnouncements: {}, gatewayTransactions: [], savedEmojis: {}, giveaways: {}, messageTemplates: {}, users: {},
    emojis: {}, processedEmails: {}, auditLogs: [], paymentLogs: [], errorLogs: [], backups: {},
    meta: { createdAt: now, updatedAt: now }
  };
}

function merge<T extends Record<string, unknown>>(base: T, current: Partial<T> | undefined): T {
  const out = clone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(current ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      out[key] = merge(out[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else if (value !== undefined) out[key] = value;
  }
  return out as T;
}

function readJson<T>(path: string, fallback: T, logger?: Logger): T {
  if (!existsSync(path)) return clone(fallback);
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch (error) {
    const corrupted = `${path}.corrupted-${Date.now()}`;
    let backupPreserved = true;
    try { copyFileSync(path, corrupted); }
    catch (copyError) {
      backupPreserved = false;
      logger?.warn("O arquivo inválido não pôde ser copiado antes da recuperação.", { path, corrupted, error: String(copyError) });
    }
    logger?.error("Arquivo JSON inválido; o padrão foi carregado.", { path, corrupted: backupPreserved ? corrupted : "não criado", error: String(error) });
    return clone(fallback);
  }
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function inferGuild(record: Record<string, unknown>, guilds: Record<string, GuildSettings>): string {
  const direct = String(record.guildId ?? "");
  if (/^\d{15,22}$/.test(direct)) return direct;
  const publications = Array.isArray(record.publications) ? record.publications as Array<Record<string, unknown>> : [];
  const publicationGuild = String(publications.find((entry) => /^\d{15,22}$/.test(String(entry.guildId ?? "")))?.guildId ?? "");
  if (publicationGuild) return publicationGuild;
  const firstGuild = Object.keys(guilds)[0];
  return firstGuild || "legacy";
}

function normalizeGuild(raw: Partial<GuildSettings> | undefined, guildId: string): GuildSettings {
  const out = merge(guildDefaults(guildId) as unknown as Record<string, unknown>, raw as unknown as Record<string, unknown>) as unknown as GuildSettings;
  out.guildId = guildId;
  out.adminRoleIds = uniqueIds(out.adminRoleIds);
  out.staffRoleIds = uniqueIds(out.staffRoleIds);
  out.stockRequest.color = normalizeColor(out.stockRequest.color, "#3155ff");
  for (const key of Object.keys(out.permissions) as Array<keyof typeof out.permissions>) out.permissions[key] = uniqueIds(out.permissions[key]);
  out.locks.ignoredChannelIds = uniqueIds(out.locks.ignoredChannelIds);
  out.locks.speakingRoleIds = uniqueIds(out.locks.speakingRoleIds);
  out.locks.snapshots ||= {};
  return out;
}

export class JsonDatabase {
  readonly root: string;
  readonly legacyPath: string;
  state: DatabaseSchema;
  private saving = false;
  private dirty = false;

  constructor(path: string, private readonly logger: Logger, private readonly credentials: CredentialStore) {
    const resolved = resolve(path || "database");
    const isFile = extname(resolved).toLowerCase() === ".json";
    this.legacyPath = isFile ? resolved : resolve("storage/database.json");
    this.root = isFile ? resolve(dirname(resolved), "../database") : resolved;
    mkdirSync(this.root, { recursive: true });
    this.state = this.load();
    this.save();
  }

  private load(): DatabaseSchema {
    const state = defaults();
    const globalDir = join(this.root, "global");
    state.brand = merge(BRAND_DEFAULTS as unknown as Record<string, unknown>, readJson(join(globalDir, "marca.json"), {}, this.logger)) as unknown as BrandSettings;
    state.brand.color = normalizeColor(state.brand.color, "#3155ff");
    state.emojis = readJson(join(globalDir, "emojis", "instalados.json"), {}, this.logger);
    state.savedEmojis = readJson(join(globalDir, "emojis", "salvos.json"), {}, this.logger);
    state.meta = merge(state.meta as unknown as Record<string, unknown>, readJson(join(globalDir, "meta.json"), {}, this.logger)) as unknown as DatabaseSchema["meta"];

    const guildDirs = existsSync(this.root)
      ? readdirSync(this.root).filter((name) => /^\d{15,22}$/.test(name) && statSync(join(this.root, name)).isDirectory())
      : [];
    for (const guildId of guildDirs) this.loadGuild(state, guildId);

    if (existsSync(this.legacyPath) && !state.meta.migratedFrom) {
      try {
        const legacy = JSON.parse(readFileSync(this.legacyPath, "utf8")) as Record<string, unknown>;
        this.importLegacy(state, legacy);
        state.meta.migratedFrom = this.legacyPath;
        this.logger.success("Migração automática do banco antigo concluída sem apagar o arquivo original.");
      } catch (error) {
        this.logger.error("Não foi possível migrar o banco antigo; o arquivo foi preservado.", error);
      }
    }
    this.normalize(state);
    return state;
  }

  private loadGuild(state: DatabaseSchema, guildId: string): void {
    const root = join(this.root, guildId);
    state.guilds[guildId] = normalizeGuild(readJson(join(root, "loja", "configuracoes.json"), {}, this.logger), guildId);
    state.guildBrands[guildId] = merge(BRAND_DEFAULTS as unknown as Record<string, unknown>, readJson(join(root, "loja", "marca.json"), {}, this.logger)) as unknown as BrandSettings;
    state.guildPayments[guildId] = merge(PAYMENT_DEFAULTS as unknown as Record<string, unknown>, readJson(join(root, "pagamentos", "configuracoes.json"), {}, this.logger)) as unknown as PaymentSettings;
    state.guildAutomations[guildId] = merge(AUTOMATION_DEFAULTS as unknown as Record<string, unknown>, readJson(join(root, "loja", "automacoes.json"), {}, this.logger)) as unknown as AutomationSettings;
    state.guildProtection[guildId] = merge(PROTECTION_DEFAULTS as unknown as Record<string, unknown>, readJson(join(root, "loja", "protecao.json"), {}, this.logger)) as unknown as ProtectionSettings;
    Object.assign(state.products, readJson(join(root, "produtos", "produtos.json"), {}, this.logger));
    Object.assign(state.stock, readJson(join(root, "produtos", "estoque.json"), {}, this.logger));
    Object.assign(state.carts, readJson(join(root, "carrinhos", "ativos.json"), {}, this.logger));
    Object.assign(state.abandonedCarts, readJson(join(root, "carrinhos", "abandonados.json"), {}, this.logger));
    Object.assign(state.coupons, readJson(join(root, "cupons", "cupons.json"), {}, this.logger));
    state.couponUsages.push(...readJson(join(root, "cupons", "usos.json"), [], this.logger));
    for (const file of ["pendentes", "aprovados", "cancelados", "expirados"]) Object.assign(state.orders, readJson(join(root, "pagamentos", `${file}.json`), {}, this.logger));
    Object.assign(state.ticketPanels, readJson(join(root, "tickets", "configuracoes.json"), {}, this.logger));
    Object.assign(state.tickets, readJson(join(root, "tickets", "tickets-abertos.json"), {}, this.logger));
    state.ticketHistory.push(...readJson(join(root, "tickets", "historico.json"), [], this.logger));
    Object.assign(state.users, readJson(join(root, "usuarios", "clientes.json"), {}, this.logger));
    Object.assign(state.stockRequests, readJson(join(root, "loja", "pedidos-stock.json"), {}, this.logger));
    Object.assign(state.restockAnnouncements, readJson(join(root, "produtos", "avisos-restock.json"), {}, this.logger));
    state.gatewayTransactions.push(...readJson(join(root, "pagamentos", "transacoes-gateway.json"), [], this.logger));
    Object.assign(state.giveaways, readJson(join(root, "loja", "sorteios.json"), {}, this.logger));
    Object.assign(state.messageTemplates, readJson(join(root, "loja", "mensagens.json"), {}, this.logger));
    Object.assign(state.processedEmails, readJson(join(root, "pagamentos", "emails-processados.json"), {}, this.logger));
    state.auditLogs.push(...readJson(join(root, "logs", "administracao.json"), [], this.logger));
    state.paymentLogs.push(...readJson(join(root, "logs", "pagamentos.json"), [], this.logger));
    state.errorLogs.push(...readJson(join(root, "logs", "erros.json"), [], this.logger));
    Object.assign(state.backups, readJson(join(root, "backups", "indice.json"), {}, this.logger));
  }

  private importLegacy(state: DatabaseSchema, legacy: Record<string, unknown>): void {
    const legacyGuilds = (legacy.guilds ?? {}) as Record<string, Partial<GuildSettings>>;
    for (const [guildId, settings] of Object.entries(legacyGuilds)) state.guilds[guildId] = normalizeGuild(settings, guildId);
    if (legacy.brand && typeof legacy.brand === "object") state.brand = merge(BRAND_DEFAULTS as unknown as Record<string, unknown>, legacy.brand as Record<string, unknown>) as unknown as BrandSettings;
    if (legacy.payments && typeof legacy.payments === "object") state.payments = merge(PAYMENT_DEFAULTS as unknown as Record<string, unknown>, legacy.payments as Record<string, unknown>) as unknown as PaymentSettings;
    if (legacy.automations && typeof legacy.automations === "object") state.automations = merge(AUTOMATION_DEFAULTS as unknown as Record<string, unknown>, legacy.automations as Record<string, unknown>) as unknown as AutomationSettings;
    if (legacy.protection && typeof legacy.protection === "object") state.protection = merge(PROTECTION_DEFAULTS as unknown as Record<string, unknown>, legacy.protection as Record<string, unknown>) as unknown as ProtectionSettings;
    if (legacy.guildBrands && typeof legacy.guildBrands === "object") Object.assign(state.guildBrands, legacy.guildBrands as object);
    if (legacy.guildPayments && typeof legacy.guildPayments === "object") Object.assign(state.guildPayments, legacy.guildPayments as object);
    if (legacy.guildAutomations && typeof legacy.guildAutomations === "object") Object.assign(state.guildAutomations, legacy.guildAutomations as object);
    if (legacy.guildProtection && typeof legacy.guildProtection === "object") Object.assign(state.guildProtection, legacy.guildProtection as object);
    for (const key of ["products", "stock", "coupons", "orders", "ticketPanels", "tickets", "stockRequests", "restockAnnouncements", "savedEmojis", "giveaways", "messageTemplates", "users", "emojis", "processedEmails", "backups"] as const) {
      if (legacy[key] && typeof legacy[key] === "object") Object.assign(state[key] as object, legacy[key] as object);
    }
    if (Array.isArray(legacy.auditLogs)) state.auditLogs.push(...legacy.auditLogs as AuditLog[]);
    if (Array.isArray(legacy.paymentLogs)) state.paymentLogs.push(...legacy.paymentLogs as AuditLog[]);
    if (Array.isArray(legacy.errorLogs)) state.errorLogs.push(...legacy.errorLogs as AuditLog[]);
    if (Array.isArray(legacy.couponUsages)) state.couponUsages.push(...legacy.couponUsages as DatabaseSchema["couponUsages"]);
    if (Array.isArray(legacy.ticketHistory)) state.ticketHistory.push(...legacy.ticketHistory as DatabaseSchema["ticketHistory"]);
    if (legacy.abandonedCarts && typeof legacy.abandonedCarts === "object") Object.assign(state.abandonedCarts, legacy.abandonedCarts as object);
    const oldCarts = (legacy.carts ?? {}) as Record<string, unknown>;
    for (const [key, raw] of Object.entries(oldCarts)) {
      if (raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as Partial<CartSession>).items)) {
        const session = raw as CartSession; const id = session.id || key || makeId("CRT");
        state.carts[id] = { ...session, id, guildId: session.guildId || Object.keys(state.guilds)[0] || "legacy" };
        continue;
      }
      if (!Array.isArray(raw)) continue;
      const guildId = Object.keys(state.guilds)[0] || "legacy";
      const id = makeId("CRT");
      state.carts[id] = {
        id, guildId, userId: key, channelId: "", messageId: "", sourceChannelId: "", sourceMessageId: "",
        items: raw as CartSession["items"], couponCode: "", selectedProvider: "", status: "ACTIVE", orderId: "",
        createdAt: nowIso(), updatedAt: nowIso(), expiresAt: new Date(Date.now() + 86400000).toISOString()
      };
    }
  }

  private normalize(state: DatabaseSchema): void {
    state.version = 13;
    state.brand.color = normalizeColor(state.brand.color, "#3155ff");
    state.automations = merge(AUTOMATION_DEFAULTS as unknown as Record<string, unknown>, state.automations as unknown as Record<string, unknown>) as unknown as AutomationSettings;
    for (const [guildId, settings] of Object.entries(state.guildAutomations)) {
      const normalized = merge(AUTOMATION_DEFAULTS as unknown as Record<string, unknown>, settings as unknown as Record<string, unknown>) as unknown as AutomationSettings;
      normalized.channelSchedules = Array.isArray(normalized.channelSchedules) ? normalized.channelSchedules.slice(0, 25).map((schedule) => ({
        ...schedule,
        id: String(schedule.id || makeId("SCH")),
        name: String(schedule.name || "Horário de canais").slice(0, 80),
        enabled: schedule.enabled ?? true,
        channelIds: uniqueIds(schedule.channelIds).slice(0, 25),
        lockTime: /^\d{2}:\d{2}$/.test(String(schedule.lockTime)) ? String(schedule.lockTime) : "22:00",
        unlockTime: /^\d{2}:\d{2}$/.test(String(schedule.unlockTime)) ? String(schedule.unlockTime) : "08:00",
        timezone: String(schedule.timezone || "America/Sao_Paulo").slice(0, 80),
        lockMessage: String(schedule.lockMessage || "Este canal foi fechado automaticamente.").slice(0, 1800),
        unlockMessage: String(schedule.unlockMessage || "Este canal foi aberto automaticamente.").slice(0, 1800),
        lastLockDate: String(schedule.lastLockDate || ""),
        lastUnlockDate: String(schedule.lastUnlockDate || ""),
        createdAt: String(schedule.createdAt || nowIso()),
        updatedAt: String(schedule.updatedAt || nowIso())
      })) : [];
      state.guildAutomations[guildId] = normalized;
    }
    for (const [guildId, raw] of Object.entries(state.guilds)) state.guilds[guildId] = normalizeGuild(raw, guildId);
    for (const product of Object.values(state.products)) {
      product.guildId = inferGuild(product as unknown as Record<string, unknown>, state.guilds);
      product.perUserLimit = Math.max(0, Math.trunc(product.perUserLimit ?? product.maxQuantity ?? 0));
      product.couponGroup = String(product.couponGroup ?? "").slice(0, 50);
      product.publications = Array.isArray(product.publications) ? product.publications : [];
      product.fields = Array.isArray(product.fields) ? product.fields.slice(0, 25) : [];
      const fieldIds = new Set<string>();
      for (const field of product.fields) {
        if (!field.id || fieldIds.has(field.id)) field.id = makeId("FLD");
        fieldIds.add(field.id);
      }
      product.purchaseMode = product.fields.filter((field) => field.active).length > 1 ? "SELECT" : "BUTTON";
    }
    for (const [key, items] of Object.entries(state.stock)) {
      state.stock[key] = Array.isArray(items) ? items.map((item) => ({ ...item, guildId: item.guildId || state.products[item.productId]?.guildId || "legacy", content: String(item.content ?? "") })) : [];
    }
    for (const cart of Object.values(state.carts)) {
      cart.guildId ||= "legacy"; cart.status ||= "ACTIVE"; cart.items ||= []; cart.couponCode ||= ""; cart.selectedProvider ||= ""; cart.orderId ||= "";
      cart.updatedAt ||= nowIso(); cart.createdAt ||= nowIso(); cart.expiresAt ||= new Date(Date.now() + 86400000).toISOString();
    }
    for (const coupon of Object.values(state.coupons)) {
      coupon.guildId ||= "legacy"; coupon.perUserLimit = Math.max(0, Math.trunc(coupon.perUserLimit ?? 0)); coupon.startsAt ??= null;
      coupon.productIds ||= []; coupon.productGroups ||= []; coupon.updatedAt ||= coupon.createdAt || nowIso();
    }
    for (const settings of Object.values(state.guildPayments)) {
      settings.imapPix.bank = ["INTER", "PICPAY", "NUBANK"].includes(settings.imapPix.bank) ? settings.imapPix.bank : "INTER";
      settings.imapPix.emailProvider = ["GMAIL", "OUTLOOK", "YAHOO", "CUSTOM"].includes(settings.imapPix.emailProvider) ? settings.imapPix.emailProvider : "GMAIL";
      delete (settings.imapPix as unknown as Record<string, unknown>).senderAllowlist;
      delete (settings.imapPix as unknown as Record<string, unknown>).subjectContains;
      delete (settings.imapPix as unknown as Record<string, unknown>).requireExactFullName;
    }
    state.payments.imapPix.bank = ["INTER", "PICPAY", "NUBANK"].includes(state.payments.imapPix.bank) ? state.payments.imapPix.bank : "INTER";
    state.payments.imapPix.emailProvider = ["GMAIL", "OUTLOOK", "YAHOO", "CUSTOM"].includes(state.payments.imapPix.emailProvider) ? state.payments.imapPix.emailProvider : "GMAIL";
    delete (state.payments.imapPix as unknown as Record<string, unknown>).senderAllowlist;
    delete (state.payments.imapPix as unknown as Record<string, unknown>).subjectContains;
    delete (state.payments.imapPix as unknown as Record<string, unknown>).requireExactFullName;
    for (const order of Object.values(state.orders)) {
      order.couponUsageRegistered ??= false;
      order.cartId ||= "";
      order.payerFullName ||= "";
      order.payerDocument ||= "";
      order.imapBank ||= "";
      order.paymentKey ||= "";
      order.deliveredProducts = Array.isArray(order.deliveredProducts) ? order.deliveredProducts : [];
    }
    for (const panel of Object.values(state.ticketPanels)) {
      panel.guildId = panel.guildId || inferGuild(panel as unknown as Record<string, unknown>, state.guilds);
      const optionIds = new Set<string>();
      panel.options = Array.isArray(panel.options) ? panel.options.map((option, index) => ({
        ...option,
        maxOpenTicketsPerUser: Math.max(1, Math.min(10, Math.trunc(option.maxOpenTicketsPerUser ?? 1))),
        mentionSupport: option.mentionSupport ?? true,
        active: option.active ?? true,
        position: Number.isFinite(option.position) ? Math.trunc(option.position) : index
      })).map((option) => {
        if (!option.id || optionIds.has(option.id)) option.id = makeId("OPT");
        optionIds.add(option.id);
        return option;
      }).sort((a, b) => a.position - b.position) : [];
      const fieldIds = new Set<string>();
      panel.fields = Array.isArray(panel.fields) ? panel.fields.slice(0, 25).map((field) => {
        if (!field.id || fieldIds.has(field.id)) field.id = makeId("TFD");
        fieldIds.add(field.id);
        return field;
      }) : [];
    }
    for (const user of Object.values(state.users)) user.guildId ||= "legacy";
    for (const template of Object.values(state.messageTemplates)) {
      template.guildId ||= "legacy";
      template.name = String(template.name || "Mensagem").slice(0, 80);
      template.content = String(template.content || "").slice(0, 2000);
      template.title = String(template.title || "").slice(0, 300);
      template.description = String(template.description || "").slice(0, 4000);
      template.color = normalizeColor(template.color, "#3155ff");
      template.bannerUrl = String(template.bannerUrl || "").slice(0, 1000);
      template.thumbnailUrl = String(template.thumbnailUrl || "").slice(0, 1000);
      template.footer = String(template.footer || "").slice(0, 1900);
      template.links = Array.isArray(template.links) ? template.links.slice(0, 5) : [];
      template.publications = Array.isArray(template.publications) ? template.publications : [];
      template.createdAt ||= nowIso();
      template.updatedAt ||= template.createdAt;
    }
    for (const log of [...state.auditLogs, ...state.paymentLogs, ...state.errorLogs]) log.guildId ||= String(log.details?.guildId ?? "global");
  }

  save(): void {
    this.dirty = true;
    if (this.saving) return;
    this.saving = true;
    try {
      while (this.dirty) {
        this.dirty = false;
        this.state.meta.updatedAt = nowIso();
        this.validate();
        this.persistGlobal();
        for (const guildId of this.guildIds()) this.persistGuild(guildId);
      }
    } finally { this.saving = false; }
  }

  private validate(): void {
    if (this.state.version !== 13) throw new Error("Versão interna do banco inválida.");
    for (const product of Object.values(this.state.products)) {
      if (!product.id || !product.guildId || !product.name) throw new Error(`Produto inválido: ${product.id || "sem ID"}`);
      if (product.fields.length > 25) throw new Error(`Produto ${product.id} ultrapassa 25 campos.`);
      if (new Set(product.fields.map((field) => field.id)).size !== product.fields.length) throw new Error(`Produto ${product.id} possui campos com IDs duplicados.`);
    }
    for (const panel of Object.values(this.state.ticketPanels)) {
      if (new Set(panel.options.map((option) => option.id)).size !== panel.options.length) throw new Error(`Painel ${panel.id} possui opções com IDs duplicados.`);
      if (new Set(panel.fields.map((field) => field.id)).size !== panel.fields.length) throw new Error(`Painel ${panel.id} possui campos com IDs duplicados.`);
    }
    for (const cart of Object.values(this.state.carts)) if (!cart.id || !cart.guildId || !cart.userId || !Array.isArray(cart.items)) throw new Error(`Carrinho inválido: ${cart.id}`);
  }

  private guildIds(): string[] {
    const ids = new Set(Object.keys(this.state.guilds));
    const collect = (records: Record<string, { guildId?: string }>) => Object.values(records).forEach((record) => { if (/^\d{15,22}$/.test(record.guildId || "")) ids.add(record.guildId!); });
    collect(this.state.products); collect(this.state.carts); collect(this.state.orders); collect(this.state.ticketPanels); collect(this.state.tickets); collect(this.state.coupons); collect(this.state.messageTemplates);
    return [...ids];
  }

  private persistGlobal(): void {
    const root = join(this.root, "global");
    atomicWrite(join(root, "marca.json"), this.state.brand);
    atomicWrite(join(root, "emojis", "instalados.json"), this.state.emojis);
    atomicWrite(join(root, "emojis", "salvos.json"), this.state.savedEmojis);
    atomicWrite(join(root, "meta.json"), this.state.meta);
  }

  private recordsFor<T extends { guildId?: string }>(records: Record<string, T>, guildId: string): Record<string, T> {
    return Object.fromEntries(Object.entries(records).filter(([, value]) => value.guildId === guildId));
  }

  private persistGuild(guildId: string): void {
    const root = join(this.root, guildId);
    const settings = this.guild(guildId, false);
    atomicWrite(join(root, "loja", "configuracoes.json"), settings);
    atomicWrite(join(root, "loja", "marca.json"), this.brand(guildId));
    atomicWrite(join(root, "loja", "automacoes.json"), this.automations(guildId));
    atomicWrite(join(root, "loja", "protecao.json"), this.protection(guildId));
    atomicWrite(join(root, "loja", "pedidos-stock.json"), this.recordsFor(this.state.stockRequests, guildId));
    atomicWrite(join(root, "loja", "sorteios.json"), this.recordsFor(this.state.giveaways, guildId));
    atomicWrite(join(root, "loja", "mensagens.json"), this.recordsFor(this.state.messageTemplates, guildId));
    atomicWrite(join(root, "produtos", "produtos.json"), this.recordsFor(this.state.products, guildId));
    atomicWrite(join(root, "produtos", "avisos-restock.json"), this.recordsFor(this.state.restockAnnouncements, guildId));
    const productIds = new Set(Object.values(this.state.products).filter((p) => p.guildId === guildId).map((p) => p.id));
    atomicWrite(join(root, "produtos", "estoque.json"), Object.fromEntries(Object.entries(this.state.stock).filter(([, items]) => items.some((item) => item.guildId === guildId || productIds.has(item.productId)))));
    atomicWrite(join(root, "produtos", "entregas.json"), Object.fromEntries(Object.entries(this.state.orders).filter(([, order]) => order.guildId === guildId && ["DELIVERED", "AWAITING_DELIVERY"].includes(order.status))));
    atomicWrite(join(root, "carrinhos", "ativos.json"), Object.fromEntries(Object.entries(this.state.carts).filter(([, cart]) => cart.guildId === guildId && ["ACTIVE", "CHECKOUT", "PAYMENT_PENDING"].includes(cart.status))));
    atomicWrite(join(root, "carrinhos", "abandonados.json"), Object.fromEntries([...Object.entries(this.state.abandonedCarts), ...Object.entries(this.state.carts).filter(([, cart]) => cart.guildId === guildId && !["ACTIVE", "CHECKOUT", "PAYMENT_PENDING"].includes(cart.status))].filter(([, cart]) => cart.guildId === guildId)));
    atomicWrite(join(root, "cupons", "cupons.json"), this.recordsFor(this.state.coupons, guildId));
    atomicWrite(join(root, "cupons", "usos.json"), this.state.couponUsages.filter((usage) => usage.guildId === guildId));
    atomicWrite(join(root, "pagamentos", "configuracoes.json"), this.payments(guildId));
    const statuses: Record<string, string[]> = { pendentes: ["PENDING"], aprovados: ["PAID", "DELIVERED", "AWAITING_DELIVERY"], cancelados: ["CANCELED", "REFUNDED"], expirados: ["EXPIRED"] };
    for (const [file, values] of Object.entries(statuses)) atomicWrite(join(root, "pagamentos", `${file}.json`), Object.fromEntries(Object.entries(this.state.orders).filter(([, order]) => order.guildId === guildId && values.includes(order.status))));
    atomicWrite(join(root, "pagamentos", "emails-processados.json"), Object.fromEntries(Object.entries(this.state.processedEmails).filter(([, email]) => this.state.orders[email.orderId]?.guildId === guildId)));
    atomicWrite(join(root, "pagamentos", "transacoes-gateway.json"), this.state.gatewayTransactions.filter((entry) => entry.guildId === guildId).slice(0, 10000));
    atomicWrite(join(root, "tickets", "configuracoes.json"), this.recordsFor(this.state.ticketPanels, guildId));
    atomicWrite(join(root, "tickets", "tickets-abertos.json"), Object.fromEntries(Object.entries(this.state.tickets).filter(([, ticket]) => ticket.guildId === guildId && ticket.status === "OPEN")));
    atomicWrite(join(root, "tickets", "historico.json"), [...this.state.ticketHistory.filter((ticket) => ticket.guildId === guildId), ...Object.values(this.state.tickets).filter((ticket) => ticket.guildId === guildId && ticket.status !== "OPEN")]);
    atomicWrite(join(root, "usuarios", "clientes.json"), this.recordsFor(this.state.users, guildId));
    atomicWrite(join(root, "usuarios", "permissoes.json"), settings.permissions);
    atomicWrite(join(root, "logs", "administracao.json"), this.state.auditLogs.filter((log) => log.guildId === guildId).slice(0, 5000));
    atomicWrite(join(root, "logs", "pagamentos.json"), this.state.paymentLogs.filter((log) => log.guildId === guildId).slice(0, 5000));
    atomicWrite(join(root, "logs", "erros.json"), this.state.errorLogs.filter((log) => log.guildId === guildId).slice(0, 5000));
    atomicWrite(join(root, "backups", "indice.json"), this.recordsFor(this.state.backups, guildId));
    atomicWrite(join(root, "README.json"), { guildId, generatedAt: nowIso(), note: "Dados legíveis e editáveis. Credenciais privadas ficam em config/private-credentials.json e não são misturadas com pedidos, tickets ou produtos." });
  }

  mutate(fn: (state: DatabaseSchema) => void): void { fn(this.state); this.save(); }

  guild(guildId: string, persist = true): GuildSettings {
    if (!this.state.guilds[guildId]) {
      this.state.guilds[guildId] = guildDefaults(guildId);
      this.claimLegacy(guildId);
      if (persist) this.save();
    }
    return this.state.guilds[guildId]!;
  }
  updateGuild(guildId: string, fn: (guild: GuildSettings) => void): GuildSettings { const guild = this.guild(guildId); fn(guild); this.save(); return guild; }
  brand(guildId: string): BrandSettings { return this.state.guildBrands[guildId] ?? (this.state.guildBrands[guildId] = clone(this.state.brand)); }
  payments(guildId: string): PaymentSettings { return this.state.guildPayments[guildId] ?? (this.state.guildPayments[guildId] = clone(this.state.payments)); }
  automations(guildId: string): AutomationSettings { return this.state.guildAutomations[guildId] ?? (this.state.guildAutomations[guildId] = clone(this.state.automations)); }
  protection(guildId: string): ProtectionSettings { return this.state.guildProtection[guildId] ?? (this.state.guildProtection[guildId] = clone(this.state.protection)); }

  private claimLegacy(guildId: string): void {
    const hasReal = Object.values(this.state.products).some((p) => p.guildId === guildId);
    if (hasReal) return;
    for (const collection of [this.state.products, this.state.carts, this.state.abandonedCarts, this.state.coupons, this.state.orders, this.state.ticketPanels, this.state.tickets, this.state.stockRequests, this.state.giveaways, this.state.messageTemplates, this.state.users] as Array<Record<string, { guildId?: string }>>) {
      for (const record of Object.values(collection)) if (record.guildId === "legacy" || !record.guildId) record.guildId = guildId;
    }
    for (const items of Object.values(this.state.stock)) for (const item of items) if (item.guildId === "legacy" || !item.guildId) item.guildId = guildId;
  }

  setSecret(key: string, value: string, guildId = ""): void {
    if (!guildId) throw new Error("O ID do servidor é obrigatório para salvar credenciais privadas.");
    this.credentials.set(guildId, key, value);
  }

  getSecret(key: string, guildId = ""): string | undefined {
    if (!guildId) return undefined;
    return this.credentials.get(guildId, key);
  }

  ensureUser(guildId: string, discordId: string, username = ""): UserProfile {
    const key = `${guildId}:${discordId}`; const now = nowIso(); const existing = this.state.users[key];
    if (existing) { existing.username = username || existing.username; existing.updatedAt = now; this.save(); return existing; }
    const profile: UserProfile = { guildId, discordId, username, totalSpentCents: 0, purchases: 0, createdAt: now, updatedAt: now };
    this.state.users[key] = profile; this.save(); return profile;
  }

  audit(actorId: string, action: string, targetType: string, targetId = "", details: Record<string, unknown> = {}, guildId = String(details.guildId ?? "global")): void {
    const log: AuditLog = { id: makeId("AUD"), guildId, actorId, action, targetType, targetId, details, createdAt: nowIso() };
    this.state.auditLogs.unshift(log); if (this.state.auditLogs.length > 10000) this.state.auditLogs.length = 10000; this.save();
  }
  paymentAudit(guildId: string, action: string, orderId: string, details: Record<string, unknown> = {}): void {
    this.state.paymentLogs.unshift({ id: makeId("PAYLOG"), guildId, actorId: "system", action, targetType: "order", targetId: orderId, details, createdAt: nowIso() });
    if (this.state.paymentLogs.length > 10000) this.state.paymentLogs.length = 10000; this.save();
  }
  errorAudit(guildId: string, action: string, details: Record<string, unknown> = {}): void {
    this.state.errorLogs.unshift({ id: makeId("ERR"), guildId, actorId: "system", action, targetType: "error", targetId: "", details, createdAt: nowIso() });
    if (this.state.errorLogs.length > 10000) this.state.errorLogs.length = 10000; this.save();
  }

  stats(guildId?: string) {
    const orders = Object.values(this.state.orders).filter((o) => !guildId || o.guildId === guildId);
    const paid = new Set(["PAID", "DELIVERED", "AWAITING_DELIVERY"]); const today = new Date().toISOString().slice(0, 10); const monthAgo = Date.now() - 30 * 86400000;
    const products = Object.values(this.state.products).filter((p) => !guildId || p.guildId === guildId);
    const productIds = new Set(products.map((p) => p.id));
    const individualAvailable = Object.values(this.state.stock).flat().filter((s) => productIds.has(s.productId) && s.status === "AVAILABLE").length;
    const ghostAvailable = products.reduce((total, product) => total + product.fields.reduce((sum, field) => sum + (field.stockMode === "GHOST" ? Math.max(0, field.ghostStock.quantity - field.ghostStock.reserved - field.ghostStock.sold) : 0), 0), 0);
    return {
      revenueToday: orders.filter((o) => paid.has(o.status) && (o.paidAt ?? "").slice(0, 10) === today).reduce((s, o) => s + o.totalCents, 0),
      revenue30d: orders.filter((o) => paid.has(o.status) && Date.parse(o.paidAt ?? "") >= monthAgo).reduce((s, o) => s + o.totalCents, 0),
      pendingOrders: orders.filter((o) => o.status === "PENDING").length,
      awaitingDelivery: orders.filter((o) => o.status === "AWAITING_DELIVERY").length,
      totalOrders: orders.length,
      activeProducts: products.filter((p) => p.active).length,
      availableStock: individualAvailable + ghostAvailable,
      openTickets: Object.values(this.state.tickets).filter((t) => (!guildId || t.guildId === guildId) && t.status === "OPEN").length,
      customers: Object.values(this.state.users).filter((u) => !guildId || u.guildId === guildId).length
    };
  }

  backupData(guildId: string, name: string, actorId: string): BackupSummary {
    const id = makeId("DBB"); const dir = join(this.root, guildId, "backups", id); mkdirSync(dir, { recursive: true });
    const source = join(this.root, guildId); const files = this.walk(source).filter((path) => !path.includes(`${join("backups", id)}`));
    for (const file of files) {
      const relative = file.slice(source.length + 1); const target = join(dir, "database", relative); mkdirSync(dirname(target), { recursive: true }); copyFileSync(file, target);
    }
    const summary: BackupSummary = { id, guildId, name: name || `Backup ${new Date().toLocaleString("pt-BR")}`, path: dir, createdBy: actorId, createdAt: nowIso(), counts: { files: files.length }, warnings: [] };
    this.state.backups[id] = summary; this.state.meta.lastBackupAt = summary.createdAt; this.save(); return summary;
  }

  private walk(root: string): string[] {
    if (!existsSync(root)) return [];
    const result: string[] = [];
    for (const name of readdirSync(root)) {
      const path = join(root, name); const stat = statSync(path);
      if (stat.isDirectory()) { if (name !== "backups") result.push(...this.walk(path)); }
      else result.push(path);
    }
    return result;
  }

  backup(): string { return this.legacyBackup(); }

  legacyBackup(): string {
    const target = resolve(this.root, "global", `estado-completo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    atomicWrite(target, this.state); return target;
  }
}
