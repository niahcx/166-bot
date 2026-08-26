export type EmojiTheme = "neon" | "solid" | "badge" | "mono";
export type DeliveryType = "STOCK" | "ROLE" | "MANUAL";
export type PaymentProviderName = "MERCADO_PAGO" | "EFI_BANK" | "STRIPE" | "MISTIC_PAY" | "PURIN_CASH" | "IMAP_PIX" | "MANUAL_PIX";
export type ImapBank = "INTER" | "PICPAY" | "NUBANK";
export type ImapEmailProvider = "GMAIL" | "OUTLOOK" | "YAHOO" | "CUSTOM";
export type OrderStatus = "PENDING" | "PAID" | "DELIVERED" | "AWAITING_DELIVERY" | "CANCELED" | "EXPIRED" | "REFUNDED";
export type TicketStatus = "OPEN" | "CLOSED" | "ARCHIVED";
export type StockRequestStatus = "PENDING" | "CLAIMED" | "AVAILABLE" | "REJECTED";
export type ButtonStyleName = "PRIMARY" | "SECONDARY" | "SUCCESS" | "DANGER";
export type PurchaseComponentMode = "BUTTON" | "SELECT";
export type ProductStockMode = "UNIQUE" | "GHOST";
export type CartStatus = "ACTIVE" | "CHECKOUT" | "PAYMENT_PENDING" | "PAID" | "CANCELED" | "ABANDONED" | "EXPIRED";
export type PermissionScope = "ADMIN" | "AUTHORIZED" | "SUPPORT" | "TICKETS" | "PAYMENTS" | "PRODUCTS" | "ADMIN_COMMANDS" | "BACKUPS" | "LOCKS";

export interface AppConfig {
  botToken: string;
  clientId?: string;
  guildId?: string;
  ownerIds: string[];
  databasePath: string;
  autoInstallEmojis: boolean;
  emojiInstallLimit: number;
  logLevel: string;
}

export interface BrandSettings {
  name: string;
  color: string;
  footer: string;
  logoUrl: string;
  bannerUrl: string;
  storeTitle: string;
  storeDescription: string;
  ticketTitle: string;
  ticketDescription: string;
  presenceText: string;
  presenceType: "Playing" | "Watching" | "Listening" | "Competing";
  status: "online" | "idle" | "dnd" | "invisible";
}

export interface StockRequestSettings {
  enabled: boolean;
  title: string;
  description: string;
  color: string;
  imageUrl: string;
  thumbnailUrl: string;
  footer: string;
  buttonLabel: string;
  buttonStyle: ButtonStyleName;
  emojiSemantic: string;
  requestChannelId: string;
  notifyRoleIds: string[];
  confirmationMessage: string;
  panelChannelId?: string;
  panelMessageId?: string;
}

export interface RestockAnnouncementSettings {
  enabled: boolean;
  channelId: string;
  mentionRoleId: string;
  title: string;
  message: string;
  includeProductBanner: boolean;
}

export interface EmojiLibrarySettings { allowMembers: boolean; maxPerUser: number; }

export interface GuildPermissions {
  adminUserIds: string[];
  adminRoleIds: string[];
  authorizedUserIds: string[];
  authorizedRoleIds: string[];
  supportRoleIds: string[];
  ticketRoleIds: string[];
  paymentRoleIds: string[];
  productRoleIds: string[];
  adminCommandRoleIds: string[];
}

export interface LockSettings {
  ignoredChannelIds: string[];
  speakingRoleIds: string[];
  snapshots: Record<string, Array<{ id: string; type: number; allow: string; deny: string }>>;
}

export interface GuildSettings {
  guildId: string;
  adminRoleIds: string[];
  logChannelId: string;
  salesChannelId: string;
  ticketCategoryId: string;
  closedTicketCategoryId: string;
  archiveTicketCategoryId: string;
  purchaseCategoryId: string;
  ticketLogChannelId: string;
  staffRoleIds: string[];
  customerRoleId: string;
  welcomeChannelId: string;
  goodbyeChannelId: string;
  autoRoleId: string;
  emojiTheme: EmojiTheme;
  emojiOverrides: Record<string, string>;
  panelMessageId?: string;
  panelChannelId?: string;
  stockRequest: StockRequestSettings;
  restockAnnouncements: RestockAnnouncementSettings;
  emojiLibrary: EmojiLibrarySettings;
  permissions: GuildPermissions;
  locks: LockSettings;
}

export interface MercadoPagoSettings { enabled: boolean; payerEmail: string; statementDescriptor: string; pixKey: string; }
export interface EfiBankSettings { enabled: boolean; sandbox: boolean; pixKey: string; merchantName: string; merchantCity: string; certificateConfigured: boolean; }
export interface StripeSettings {
  enabled: boolean;
  statementDescriptor: string;
  webhookUrl: string;
}
export interface MisticPaySettings {
  enabled: boolean;
  webhookUrl: string;
}
export interface PurinCashSettings {
  enabled: boolean;
  callbackUrl: string;
}
export interface ImapPixSettings {
  enabled: boolean;
  bank: ImapBank;
  emailProvider: ImapEmailProvider;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  mailbox: string;
  pollIntervalSeconds: number;
  lookbackMinutes: number;
  maxWaitMinutes: number;
  markSeen: boolean;
  pixKey: string;
  pixKeyType: "cpf" | "cnpj" | "email" | "phone" | "random" | "unknown";
  merchantName: string;
  merchantCity: string;
}
export interface PaymentSettings {
  defaultProvider: PaymentProviderName;
  orderExpiresMinutes: number;
  pollIntervalSeconds: number;
  manualPixCode: string;
  manualPixKey: string;
  mercadoPago: MercadoPagoSettings;
  efiBank: EfiBankSettings;
  stripe: StripeSettings;
  misticPay: MisticPaySettings;
  purinCash: PurinCashSettings;
  imapPix: ImapPixSettings;
}

export interface AutomationSettings {
  welcomeEnabled: boolean;
  welcomeMessage: string;
  goodbyeEnabled: boolean;
  goodbyeMessage: string;
  autoRoleEnabled: boolean;
  autoResponsesEnabled: boolean;
  autoResponses: Array<{ trigger: string; response: string; exact: boolean }>;
  channelSchedules: ChannelSchedule[];
}
export interface ChannelSchedule {
  id: string;
  name: string;
  enabled: boolean;
  channelIds: string[];
  lockTime: string;
  unlockTime: string;
  timezone: string;
  lockMessage: string;
  unlockMessage: string;
  lastLockDate: string;
  lastUnlockDate: string;
  createdAt: string;
  updatedAt: string;
}
export interface ProtectionSettings {
  antiLink: boolean;
  allowedDomains: string[];
  antiSpam: boolean;
  spamMessages: number;
  spamWindowSeconds: number;
  spamTimeoutSeconds: number;
  blockInvites: boolean;
  logDeletedMessages: boolean;
  logEditedMessages: boolean;
}

export interface GhostStockState {
  content: string;
  quantity: number;
  reserved: number;
  sold: number;
  reservations: Record<string, number>;
  updatedAt: string;
}
export interface ProductField {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  compareAtCents: number;
  emoji: string;
  active: boolean;
  stockMode: ProductStockMode;
  ghostStock: GhostStockState;
  createdAt: string;
  updatedAt: string;
}
export interface Product {
  id: string;
  guildId: string;
  name: string;
  slug: string;
  description: string;
  priceCents: number;
  compareAtCents: number;
  emojiSemantic: string;
  customEmoji: string;
  color: string;
  imageUrl: string;
  bannerUrl: string;
  active: boolean;
  featured: boolean;
  deliveryType: DeliveryType;
  roleId: string;
  deliveryMessage: string;
  purchaseMode: PurchaseComponentMode;
  buttonLabel: string;
  buttonStyle: ButtonStyleName;
  buttonEmoji: string;
  selectPlaceholder: string;
  fields: ProductField[];
  demonstrationEnabled: boolean;
  demonstrationUrl: string;
  demonstrationLabel: string;
  demonstrationEmoji: string;
  minQuantity: number;
  maxQuantity: number;
  perUserLimit: number;
  lowStockThreshold: number;
  requireTerms: boolean;
  termsText: string;
  couponGroup: string;
  publications: Array<{ guildId: string; channelId: string; messageId: string }>;
  createdAt: string;
  updatedAt: string;
}
export interface StockItem {
  id: string;
  guildId: string;
  productId: string;
  fieldId: string;
  content: string;
  contentHash: string;
  status: "AVAILABLE" | "RESERVED" | "SOLD";
  orderId?: string;
  reservedUntil?: string;
  soldAt?: string;
  createdAt: string;
}
export interface CartItem { productId: string; fieldId: string; quantity: number; }
export interface CartSession {
  id: string;
  guildId: string;
  userId: string;
  channelId: string;
  messageId: string;
  sourceChannelId: string;
  sourceMessageId: string;
  items: CartItem[];
  couponCode: string;
  selectedProvider: PaymentProviderName | "";
  status: CartStatus;
  orderId: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface Coupon {
  id: string;
  guildId: string;
  code: string;
  type: "PERCENT" | "FIXED";
  value: number;
  minOrderCents: number;
  maxUses: number | null;
  perUserLimit: number;
  uses: number;
  active: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  productIds: string[];
  productGroups: string[];
  createdAt: string;
  updatedAt: string;
}
export interface CouponUsage {
  id: string;
  guildId: string;
  couponId: string;
  code: string;
  userId: string;
  orderId: string;
  discountCents: number;
  usedAt: string;
}

export interface OrderItem {
  productId: string;
  fieldId: string;
  productName: string;
  fieldName: string;
  quantity: number;
  unitPriceCents: number;
  deliveryType: DeliveryType;
  roleId: string;
  deliveryMessage: string;
  reservedStockIds: string[];
}
export interface DeliveredProduct {
  id: string;
  productId: string;
  fieldId: string;
  productName: string;
  fieldName: string;
  content: string;
  deliveredAt: string;
}

export interface Order {
  id: string;
  guildId: string;
  userId: string;
  status: OrderStatus;
  items: OrderItem[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  couponCode: string;
  couponUsageRegistered: boolean;
  provider: PaymentProviderName;
  providerPaymentId: string;
  pixCode: string;
  qrCodeDataUrl: string;
  discordDisplayName: string;
  payerEmail: string;
  payerFullName: string;
  payerDocument: string;
  imapBank: ImapBank | "";
  purchaseChannelId: string;
  cartId: string;
  paymentReference: string;
  verificationStatus: "PENDING" | "MATCHED" | "MANUAL_REVIEW" | "REJECTED";
  verificationDetails: Record<string, unknown>;
  paymentKey: string;
  deliveredProducts: DeliveredProduct[];
  expiresAt: string;
  paidAt?: string;
  deliveredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TicketOption {
  id: string;
  name: string;
  description: string;
  emojiSemantic: string;
  categoryId: string;
  supportRoleIds: string[];
  channelPrefix: string;
  openingTitle: string;
  openingDescription: string;
  closeMessage: string;
  askSubject: boolean;
  maxOpenTicketsPerUser: number;
  mentionSupport: boolean;
  active: boolean;
  position: number;
}
export interface TicketPanelField { id: string; name: string; value: string; inline: boolean; }
export interface TicketPanel {
  id: string;
  guildId: string;
  name: string;
  title: string;
  description: string;
  color: string;
  imageUrl: string;
  thumbnailUrl: string;
  footer: string;
  mode: "SELECT" | "BUTTONS";
  buttonLabel: string;
  buttonStyle: ButtonStyleName;
  emojiSemantic: string;
  fields: TicketPanelField[];
  options: TicketOption[];
  channelId?: string;
  messageId?: string;
  createdAt: string;
  updatedAt: string;
}
export interface TicketRecord {
  id: string;
  guildId: string;
  channelId: string;
  ownerId: string;
  panelId: string;
  optionId: string;
  subject: string;
  claimedBy: string;
  status: TicketStatus;
  purchaseGateStatus: "PENDING" | "RESOLVED" | "NOT_REQUIRED";
  selectedOrderId: string;
  gateMessageId: string;
  lastNotifiedAt?: string;
  notificationCount?: number;
  createdAt: string;
  closedAt?: string;
  archivedAt?: string;
}

export interface StockRequest { id: string; guildId: string; userId: string; username: string; productName: string; quantity: number; details: string; status: StockRequestStatus; claimedBy: string; channelId: string; messageId: string; createdAt: string; updatedAt: string; }
export interface SavedApplicationEmoji { id: string; name: string; animated: boolean; ownerId: string; guildId: string; originalName: string; createdAt: string; }
export interface Giveaway { id: string; guildId: string; channelId: string; messageId: string; prize: string; winnersCount: number; endsAt: string; entries: string[]; status: "ACTIVE" | "ENDED" | "CANCELED"; createdBy: string; createdAt: string; }
export interface UserProfile { guildId: string; discordId: string; username: string; totalSpentCents: number; purchases: number; createdAt: string; updatedAt: string; }
export interface BotMessageTemplate {
  id: string;
  guildId: string;
  name: string;
  content: string;
  title: string;
  description: string;
  color: string;
  bannerUrl: string;
  thumbnailUrl: string;
  footer: string;
  links: Array<{ id: string; label: string; url: string; emoji: string }>;
  publications: Array<{ channelId: string; messageId: string; publishedAt: string }>;
  createdAt: string;
  updatedAt: string;
}
export interface AuditLog { id: string; guildId: string; actorId: string; action: string; targetType: string; targetId: string; details: Record<string, unknown>; createdAt: string; }
export interface RestockAnnouncement {
  id: string;
  guildId: string;
  productId: string;
  fieldId: string;
  actorId: string;
  channelId: string;
  messageId: string;
  addedQuantity: number;
  totalQuantity: number;
  status: "SENT" | "SKIPPED" | "FAILED";
  error: string;
  createdAt: string;
}
export interface GatewayTransaction {
  id: string;
  guildId: string;
  orderId: string;
  provider: PaymentProviderName;
  externalId: string;
  operation: "CREATE" | "STATUS" | "WEBHOOK" | "CANCEL";
  status: PaymentCharge["status"] | "error";
  httpStatus?: number;
  attempt: number;
  durationMs: number;
  errorCode: string;
  createdAt: string;
}
export interface InstalledEmoji { id: string; name: string; semantic: string; theme: EmojiTheme; sha256: string; installedAt: string; }
export interface ProcessedEmail { key: string; uid: string; messageId: string; orderId: string; status: string; processedAt: string; amountCents?: number; reference?: string; }

export interface BackupSummary {
  id: string;
  guildId: string;
  name: string;
  path: string;
  createdBy: string;
  createdAt: string;
  counts: Record<string, number>;
  warnings: string[];
}

export interface DatabaseSchema {
  version: 13;
  brand: BrandSettings;
  guildBrands: Record<string, BrandSettings>;
  guilds: Record<string, GuildSettings>;
  payments: PaymentSettings;
  guildPayments: Record<string, PaymentSettings>;
  automations: AutomationSettings;
  guildAutomations: Record<string, AutomationSettings>;
  protection: ProtectionSettings;
  guildProtection: Record<string, ProtectionSettings>;
  products: Record<string, Product>;
  stock: Record<string, StockItem[]>;
  carts: Record<string, CartSession>;
  abandonedCarts: Record<string, CartSession>;
  coupons: Record<string, Coupon>;
  couponUsages: CouponUsage[];
  orders: Record<string, Order>;
  ticketPanels: Record<string, TicketPanel>;
  tickets: Record<string, TicketRecord>;
  ticketHistory: TicketRecord[];
  stockRequests: Record<string, StockRequest>;
  restockAnnouncements: Record<string, RestockAnnouncement>;
  gatewayTransactions: GatewayTransaction[];
  savedEmojis: Record<string, SavedApplicationEmoji>;
  giveaways: Record<string, Giveaway>;
  messageTemplates: Record<string, BotMessageTemplate>;
  users: Record<string, UserProfile>;
  emojis: Record<string, InstalledEmoji>;
  processedEmails: Record<string, ProcessedEmail>;
  auditLogs: AuditLog[];
  paymentLogs: AuditLog[];
  errorLogs: AuditLog[];
  backups: Record<string, BackupSummary>;
  meta: { createdAt: string; updatedAt: string; lastBackupAt?: string; emojiPackId?: string; migratedFrom?: string };
}

export interface PaymentCharge {
  externalId: string;
  status: "pending" | "paid" | "canceled" | "expired";
  pixCode?: string;
  qrCodeDataUrl?: string;
  expiresAt?: string;
  reference?: string;
  raw?: Record<string, unknown>;
}
