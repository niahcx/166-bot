import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelSelectMenuInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  Events,
  GuildMember,
  ModalBuilder,
  ModalSubmitInteraction,
  MessageContextMenuCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  RoleSelectMenuInteraction,
  UserSelectMenuInteraction,
  UserSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";
import { readFileSync } from "node:fs";
import type { AppConfig, BotMessageTemplate, ButtonStyleName, DeliveryType, ImapBank, ImapEmailProvider, PaymentProviderName, SavedApplicationEmoji, StockRequest } from "../types.js";
import type { JsonDatabase } from "../core/json-db.js";
import type { Logger } from "../core/logger.js";
import { channelSafe, colorNumber, formatMoney, makeId, normalizeColor, nowIso, parseBoolean, parseDuration, parseMoney, truncate } from "../core/utils.js";
import type { EmojiManager } from "../emojis/manager.js";
import type { ProductService } from "../services/products.js";
import type { PaymentManager } from "../services/payments.js";
import type { OrderService } from "../services/orders.js";
import type { ImapMonitor } from "../services/imap.js";
import type { TicketService } from "../services/tickets.js";
import type { GiveawayService } from "../services/giveaways.js";
import type { PermissionService } from "../services/permissions.js";
import type { LockService } from "../services/locks.js";
import type { ServerBackupService } from "../services/server-backups.js";
import type { RestockAnnouncementService } from "../services/restock-announcements.js";
import { applyEmailPreset, bankProfile } from "../services/imap-profiles.js";
import { Views } from "./views.js";
import { checkedDiscordPayload } from "./payload-validator.js";
import { saveImage } from "../core/image-store.js";

function input(id: string, label: string, value = "", style = TextInputStyle.Short, required = true, max = 1000, placeholder = "") {
  const safeMax = Math.max(1, Math.min(4000, Math.trunc(max) || 1000));
  const field = new TextInputBuilder()
    .setCustomId(truncate(id || "field", 100))
    .setLabel(truncate(label || "Campo", 45))
    .setStyle(style)
    .setRequired(required)
    .setMaxLength(safeMax);
  if (value) field.setValue(value.slice(0, safeMax));
  if (placeholder) field.setPlaceholder(truncate(placeholder, 100));
  return new ActionRowBuilder<TextInputBuilder>().addComponents(field);
}
function modal(id: string, title: string, rows: ActionRowBuilder<TextInputBuilder>[]) { return new ModalBuilder().setCustomId(id).setTitle(title.slice(0, 45)).addComponents(...rows.slice(0, 5)); }
function styleName(value: string): ButtonStyleName { const normalized = value.trim().toUpperCase(); return ["PRIMARY", "SECONDARY", "SUCCESS", "DANGER"].includes(normalized) ? normalized as ButtonStyleName : "SUCCESS"; }
function delivery(value: string): DeliveryType {
  const normalized = value.trim().toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (["AUTOMATICA", "AUTOMATICO", "AUTO", "STOCK"].includes(normalized)) return "STOCK";
  if (["CARGO", "ROLE"].includes(normalized)) return "ROLE";
  return "MANUAL";
}

export class InteractionRouter {
  readonly views: Views;
  private readonly purchaseGuards = new Map<string, number>();
  constructor(
    private readonly client: Client,
    private readonly config: AppConfig,
    private readonly db: JsonDatabase,
    private readonly emojis: EmojiManager,
    private readonly products: ProductService,
    private readonly payments: PaymentManager,
    private readonly orders: OrderService,
    private readonly imap: ImapMonitor,
    private readonly tickets: TicketService,
    private readonly giveaways: GiveawayService,
    private readonly permissions: PermissionService,
    private readonly locks: LockService,
    private readonly backups: ServerBackupService,
    private readonly restocks: RestockAnnouncementService,
    private readonly logger: Logger
  ) { this.views = new Views(db, emojis, products, tickets); }

  start() { this.client.on(Events.InteractionCreate, (interaction) => void this.route(interaction).catch((error) => this.fail(interaction as never, error))); }

  async refreshPublishedMessages(): Promise<number> {
    let updated = 0;
    for (const product of Object.values(this.db.state.products)) {
      for (const publication of [...product.publications]) {
        try {
          const channel = await this.client.channels.fetch(publication.channelId);
          if (!(channel instanceof TextChannel)) throw new Error("Canal não é de texto.");
          const message = await channel.messages.fetch(publication.messageId);
          await message.edit(this.views.publishedProductEdit(publication.guildId || channel.guild.id, product));
          updated++;
        } catch (error) {
          this.products.removePublication(product.id, publication.messageId);
          this.logger.warn("Publicação de produto inacessível foi removida do índice.", { productId: product.id, messageId: publication.messageId, error: String(error) });
        }
      }
    }
    for (const panel of Object.values(this.db.state.ticketPanels)) {
      if (!panel.channelId || !panel.messageId) continue;
      try {
        const channel = await this.client.channels.fetch(panel.channelId);
        if (channel instanceof TextChannel) {
          const message = await channel.messages.fetch(panel.messageId);
          await message.edit(this.views.publicTicketPanelEdit(channel.guild.id, panel));
          updated++;
        }
      } catch (error) { this.logger.warn("Não foi possível atualizar um painel de ticket publicado.", { panelId: panel.id, error: String(error) }); }
    }
    for (const template of Object.values(this.db.state.messageTemplates)) {
      for (const publication of [...template.publications]) {
        try {
          const channel = await this.client.channels.fetch(publication.channelId);
          if (!(channel instanceof TextChannel)) throw new Error("Canal não é de texto.");
          const message = await channel.messages.fetch(publication.messageId);
          await message.edit(this.views.botMessageEdit(template.guildId, template) as never);
          updated++;
        } catch (error) {
          template.publications = template.publications.filter((item) => item.messageId !== publication.messageId);
          this.db.save();
          this.logger.warn("Publicação de mensagem personalizada inacessível foi removida do índice.", { templateId: template.id, messageId: publication.messageId, error: String(error) });
        }
      }
    }
    for (const [guildId, guild] of Object.entries(this.db.state.guilds)) {
      const settings = guild.stockRequest;
      if (!settings.panelChannelId || !settings.panelMessageId) continue;
      try {
        const channel = await this.client.channels.fetch(settings.panelChannelId);
        if (!(channel instanceof TextChannel)) throw new Error("Canal não é de texto.");
        const message = await channel.messages.fetch(settings.panelMessageId);
        await message.edit(this.views.publicStockRequestPanel(guildId));
        updated++;
      } catch (error) {
        this.logger.warn("Não foi possível atualizar o painel Pedir Stock publicado.", { guildId, error: String(error) });
      }
    }
    return updated;
  }

  async refreshProductPublications(productId: string): Promise<{ updated: number; removed: number }> {
    const product = this.products.get(productId);
    let updated = 0;
    let removed = 0;
    for (const publication of [...product.publications]) {
      try {
        const channel = await this.client.channels.fetch(publication.channelId);
        if (!(channel instanceof TextChannel)) throw new Error("Canal não é de texto.");
        const message = await channel.messages.fetch(publication.messageId);
        await message.edit(this.views.publishedProductEdit(publication.guildId || channel.guild.id, product));
        updated++;
      } catch (error) {
        this.products.removePublication(product.id, publication.messageId);
        removed++;
        this.logger.warn("Publicação de produto inacessível foi removida do índice.", { productId: product.id, messageId: publication.messageId, error: String(error) });
      }
    }
    return { updated, removed };
  }

  async refreshOrderMessage(order: import("../types.js").Order): Promise<void> {
    const cart = this.db.state.carts[order.cartId] ?? this.db.state.abandonedCarts[order.cartId];
    if (!cart?.channelId || !cart.messageId) return;
    const channel = await this.client.channels.fetch(cart.channelId).catch(() => undefined);
    if (!(channel instanceof TextChannel)) return;
    const message = await channel.messages.fetch(cart.messageId).catch(() => undefined);
    if (!message) return;
    const attachment = this.orders.qrAttachment(order);
    const payload = this.views.paymentPending(order.guildId, order);
    if (["PAID", "DELIVERED", "AWAITING_DELIVERY"].includes(order.status)) {
      payload.embeds[0]!.setDescription(order.status === "DELIVERED" ? "Pagamento aprovado e entrega concluída." : "Pagamento aprovado. A entrega está sendo processada.");
      payload.components = [];
    } else if (["CANCELED", "EXPIRED"].includes(order.status)) {
      payload.embeds[0]!.setDescription(order.status === "EXPIRED" ? "O prazo do pagamento expirou." : "O pagamento foi cancelado.");
      payload.components = [];
    }
    await message.edit({ ...payload, files: attachment ? [attachment] : [], attachments: [] } as never).catch((error) => this.logger.warn("Não foi possível atualizar a mensagem do pagamento.", { orderId: order.id, error: String(error) }));
  }

  private async refreshCartMessage(guildId: string, userId: string): Promise<void> {
    const cart = this.products.getCartSession(guildId, userId);
    if (!cart?.channelId || !cart.messageId) return;
    const channel = await this.client.channels.fetch(cart.channelId).catch(() => undefined);
    if (!(channel instanceof TextChannel)) return;
    const message = await channel.messages.fetch(cart.messageId).catch(() => undefined);
    if (!message) return;
    const user = await this.client.users.fetch(userId).catch(() => undefined);
    await message.edit(this.views.cart(guildId, userId, user?.displayName ?? user?.username ?? "Cliente", user?.displayAvatarURL() ?? "") as never);
  }

  private assertCartOwner(guildId: string, userId: string, channelId?: string): import("../types.js").CartSession {
    const cart = this.products.getCartSession(guildId, userId);
    if (!cart) throw new Error("Você não possui um carrinho ativo.");
    if (channelId && cart.channelId && cart.channelId !== channelId) throw new Error("Use os controles no canal privado do seu carrinho.");
    return cart;
  }

  private guardPurchase(guildId: string, userId: string, productId: string, fieldId: string): boolean {
    const key = `${guildId}:${userId}:${productId}:${fieldId}`;
    const now = Date.now();
    const previous = this.purchaseGuards.get(key) ?? 0;
    if (now - previous < 2500) return false;
    this.purchaseGuards.set(key, now);
    setTimeout(() => this.purchaseGuards.delete(key), 3000).unref?.();
    return true;
  }

  private async fail(interaction: { id?: string; guildId?: string | null; customId?: string; commandName?: string; replied: boolean; deferred: boolean; reply: Function; followUp: Function; editReply: Function }, error: unknown) {
    const message = error instanceof Error ? error.message : "Falha inesperada.";
    this.logger.error("Falha em interação.", error);
    if (interaction.guildId) this.db.errorAudit(interaction.guildId, "INTERACTION_ERROR", { interactionId: interaction.id ?? "", customId: interaction.customId ?? "", commandName: interaction.commandName ?? "", error: message });
    const content = `❌ ${truncate(message, 1800)}`;
    try {
      if (interaction.deferred) await interaction.editReply({ content });
      else if (interaction.replied) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
    catch (replyError) { this.logger.warn("A interação expirou antes de receber a mensagem de erro.", { interactionId: interaction.id, error: String(replyError) }); }
  }

  private async route(interaction: import("discord.js").Interaction) {
    if (interaction.isMessageContextMenuCommand()) return this.contextMenu(interaction);
    if (interaction.isChatInputCommand()) return this.command(interaction);
    if (interaction.isButton()) {
      const target = interaction.customId.startsWith("admin:") && interaction.guildId ? this.adminInteraction(interaction, interaction.guildId) : interaction;
      const result = await this.button(target);
      if (/^admin:(?:product:(?:toggle|field-toggle|field-delete-confirm|delete-confirm)|stock:(?:unique|clear-confirm)|ticket:(?:delete|option-delete|field-delete)|message:links-clear|emoji:(?:set|reset))/.test(interaction.customId)) this.schedulePublishedRefresh();
      return result;
    }
    if (interaction.isStringSelectMenu()) {
      const target = interaction.customId.startsWith("admin:") && interaction.guildId ? this.adminInteraction(interaction, interaction.guildId) : interaction;
      const result = await this.select(target);
      if (/^admin:(?:product:(?:emoji-select|field-emoji-select)|ticket:emoji-select|ticket:option-emoji-select|emoji:asset-select)/.test(interaction.customId)) this.schedulePublishedRefresh();
      return result;
    }
    if (interaction.isChannelSelectMenu()) return this.channelSelect(interaction.customId.startsWith("admin:") && interaction.guildId ? this.adminInteraction(interaction, interaction.guildId) : interaction);
    if (interaction.isRoleSelectMenu()) return this.roleSelect(interaction.customId.startsWith("admin:") && interaction.guildId ? this.adminInteraction(interaction, interaction.guildId) : interaction);
    if (interaction.isUserSelectMenu()) return this.userSelect(interaction);
    if (interaction.isModalSubmit()) {
      const result = await this.modal(interaction);
      if (/^modal:(?:product:|stock:|ticket:(?:create|basic|option-add|option-edit|field-add|field-edit)|message:|brand:edit|store:edit)/.test(interaction.customId)) this.schedulePublishedRefresh();
      return result;
    }
  }

  private schedulePublishedRefresh(): void {
    setTimeout(() => void this.refreshPublishedMessages().catch((error) => this.logger.warn("Falha ao atualizar publicações automaticamente.", error)), 300).unref?.();
  }

  private member(interaction: { member: unknown }): GuildMember {
    if (!(interaction.member instanceof GuildMember)) throw new Error("Membro do servidor indisponível.");
    return interaction.member;
  }
  private isAdmin(interaction: { guildId: string | null; member: unknown; user: { id: string } }): boolean {
    if (this.config.ownerIds.includes(interaction.user.id)) return true;
    if (!interaction.guildId || !(interaction.member instanceof GuildMember)) return false;
    return this.permissions.has(interaction.member, "ADMIN");
  }
  private requireAdmin(interaction: { guildId: string | null; member: unknown; user: { id: string } }) {
    if (!interaction.guildId) throw new Error("Use esta função dentro de um servidor.");
    this.permissions.require(this.member(interaction), "ADMIN");
  }
  private requireScope(interaction: { guildId: string | null; member: unknown; user: { id: string } }, scope: import("../types.js").PermissionScope) {
    if (!interaction.guildId) throw new Error("Use esta função dentro de um servidor.");
    this.permissions.require(this.member(interaction), scope);
  }

  private adminScopeFor(id: string): import("../types.js").PermissionScope {
    if (/^(?:admin|modal):(?:product|stock:|restock|coupon)/.test(id)) return "PRODUCTS";
    if (/^(?:admin|modal):(?:payment|order|revenue)/.test(id)) return "PAYMENTS";
    if (/^(?:admin|modal):(?:ticket|stock-request)/.test(id)) return "TICKETS";
    if (/^(?:admin|modal):backup/.test(id)) return "BACKUPS";
    if (/^(?:admin|modal):(?:giveaway|message)/.test(id)) return "ADMIN_COMMANDS";
    if (/^(?:admin|modal):saved-emoji/.test(id)) return "AUTHORIZED";
    return "ADMIN";
  }

  private requireAdminAction(interaction: { guildId: string | null; member: unknown; user: { id: string } }, id: string) {
    if (id === "admin:home" || id === "admin:navigate") {
      if (!this.permissions.hasAnyManagement(this.member(interaction))) throw new Error("Você não possui permissão para abrir o painel.");
      return;
    }
    this.requireScope(interaction, this.adminScopeFor(id));
  }

  private async contextMenu(interaction: MessageContextMenuCommandInteraction) {
    if (!interaction.guildId) throw new Error("Use esta ação dentro de um servidor.");
    this.requireAdmin(interaction);
    const messageId = interaction.targetMessage.id;

    if (interaction.commandName === "Editar Produto" || interaction.commandName === "Gerenciar Estoque") {
      const product = Object.values(this.db.state.products).find((item) => item.publications.some((publication) => publication.messageId === messageId));
      if (!product) throw new Error("Esta mensagem não está vinculada a um produto publicado pelo 166 Community.");
      const payload = interaction.commandName === "Gerenciar Estoque"
        ? this.views.productFieldsView(interaction.guildId, product)
        : this.views.productDetail(interaction.guildId, product);
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === "Editar Painel de Ticket") {
      const panel = Object.values(this.db.state.ticketPanels).find((item) => item.messageId === messageId);
      if (!panel) throw new Error("Esta mensagem não está vinculada a um painel de ticket do 166 Community.");
      await interaction.reply({ ...this.views.ticketPanelDetail(interaction.guildId, panel), flags: MessageFlags.Ephemeral });
    }
  }

  private async command(interaction: ChatInputCommandInteraction) {
    if (!interaction.guildId) throw new Error("Use este comando dentro de um servidor.");
    if (interaction.commandName === "lock" || interaction.commandName === "unlock") {
      this.requireScope(interaction, "LOCKS");
      if (!interaction.guild || !(interaction.member instanceof GuildMember)) throw new Error("Servidor indisponível.");
      const all = interaction.options.getBoolean("all") ?? false;
      const reason = interaction.options.getString("motivo")?.trim() || (interaction.commandName === "lock" ? "Bloqueio administrativo" : "Desbloqueio administrativo");
      if (all) {
        const count = interaction.commandName === "lock" ? this.locks.eligible(interaction.guild).length : Object.keys(this.db.guild(interaction.guildId).locks.snapshots).length;
        await interaction.reply({
          embeds: [new EmbedBuilder().setColor(interaction.commandName === "lock" ? 0xef4444 : 0x22c55e).setTitle(`${interaction.commandName === "lock" ? "Trancar" : "Destrancar"} todos os canais`).setDescription(`Serão processados **${count}** canais.
Motivo: ${truncate(reason, 500)}

Canais configurados como exceção serão ignorados. Esta ação será registrada.`)],
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
            this.views.button(interaction.guildId, `lock:all-confirm:${interaction.commandName}:${encodeURIComponent(reason).slice(0, 50)}`, "Confirmar", interaction.commandName === "lock" ? "lock" : "unlock", interaction.commandName === "lock" ? ButtonStyle.Danger : ButtonStyle.Success),
            this.views.button(interaction.guildId, "lock:all-cancel", "Cancelar", "reject", ButtonStyle.Secondary)
          )], flags: MessageFlags.Ephemeral
        });
        return;
      }
      if (!(interaction.channel instanceof TextChannel)) throw new Error("Este comando só funciona em canais de texto.");
      if (interaction.commandName === "lock") await this.locks.lock(interaction.channel, interaction.member, reason);
      else await this.locks.unlock(interaction.channel, interaction.member, reason);
      await interaction.reply({ content: `✅ Canal ${interaction.commandName === "lock" ? "trancado" : "destrancado"}.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.commandName === "painel") {
      if (!this.permissions.hasAnyManagement(this.member(interaction))) throw new Error("Você não possui permissão para abrir o painel.");
      const payload = this.views.adminPage(interaction.guildId, this.views.adminHome(interaction.guildId, interaction.user.displayName));
      const files = this.db.brand(interaction.guildId).bannerUrl ? [] : [new AttachmentBuilder("assets/panel-banner.png", { name: "panel-banner.png" })];
      await interaction.reply({ ...payload, files, flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 }); return;
    }
    if (interaction.commandName === "meus-pedidos") { await interaction.reply({ embeds: [this.userOrdersEmbed(interaction.guildId, interaction.user.id)], flags: MessageFlags.Ephemeral }); return; }
    if (interaction.commandName === "ticket") {
      const panel = this.tickets.listPanels(interaction.guildId)[0]; if (!panel) throw new Error("Nenhum painel de ticket foi configurado.");
      await interaction.reply({ ...this.views.publicTicketPanel(interaction.guildId, panel), flags: MessageFlags.Ephemeral }); return;
    }
    if (interaction.commandName === "setupticket") {
      if (!this.permissions.hasAnyManagement(this.member(interaction))) throw new Error("Você não possui permissão para configurar tickets.");
      const gid = interaction.guildId;
      const brand = this.db.brand(gid);
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(colorNumber(brand.color))
          .setTitle(`${this.emojis.text("ticket", gid)} Configurar Painel de Ticket`)
          .setDescription("Vou te guiar passo a passo para criar um painel de ticket personalizado.\n\n**Passo 1:** Informe os dados básicos do painel.")],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.views.button(gid, "admin:setupticket:step1", "Iniciar configuração", "ticket", ButtonStyle.Success),
          this.views.button(gid, "admin:home", "Cancelar", "back", ButtonStyle.Secondary)
        )],
        flags: MessageFlags.Ephemeral
      }); return;
    }
    if (interaction.commandName === "pedir-stock") {
      const settings = this.db.guild(interaction.guildId).stockRequest;
      if (!settings.enabled) throw new Error("Os pedidos de stock estão desativados neste servidor.");
      await interaction.reply({ ...this.views.publicStockRequestPanel(interaction.guildId), flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.commandName === "salvar-emojis") {
      await this.savedEmojiCommand(interaction);
      return;
    }
    if (interaction.commandName === "emojis") {
      this.requireAdmin(interaction);
      const action = interaction.options.getSubcommand();
      if (action === "status") {
        const status = this.emojis.status;
        await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle(`${this.emojis.text("emoji", interaction.guildId)} Emojis do 166 Community`).setDescription(`Pacote: **${this.emojis.packName()}**\nInstalados: **${status.installed}/${status.total}**\nSincronizando: **${status.syncing ? `${status.completed}/${status.total}` : "não"}**${status.lastError ? `\nÚltimo erro: ${truncate(status.lastError, 1000)}` : ""}`)], flags: MessageFlags.Ephemeral });
        return;
      }
      if (action === "instalar") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.emojis.syncAutomatic(true);
        const refreshed = await this.refreshPublishedMessages();
        await interaction.editReply(`Pacote sincronizado: **${this.emojis.status.installed}/${this.emojis.status.total}** emojis. Mensagens atualizadas: **${refreshed}**.`);
        return;
      }
      if (action === "remover") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const removed = await this.emojis.removeAll();
        await interaction.editReply(`Foram removidos **${removed}** emojis do pacote 166 Community da aplicação.`);
        return;
      }
    }
    if (interaction.commandName === "status") {
      this.requireAdmin(interaction); const es = this.emojis.status; const stats = this.db.stats(interaction.guildId);
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle("Status 166 Community").addFields(
        { name: "Discord", value: this.client.isReady() ? "Conectado" : "Desconectado", inline: true },
        { name: "Emojis", value: `${es.installed}/${es.total}${es.syncing ? " sincronizando" : ""}`, inline: true },
        { name: "Produtos", value: String(stats.activeProducts), inline: true },
        { name: "Pedidos pendentes", value: String(stats.pendingOrders), inline: true },
        { name: "IMAP", value: this.db.payments(interaction.guildId).imapPix.enabled ? "Ativo" : "Desativado", inline: true },
        { name: "Banco", value: "JSON operacional", inline: true }
      ).setTimestamp()], flags: MessageFlags.Ephemeral });
    }
  }

  private async updateAdmin(interaction: ButtonInteraction | StringSelectMenuInteraction | ChannelSelectMenuInteraction | RoleSelectMenuInteraction, payload: ReturnType<Views["adminHome"]>) {
    await interaction.update(payload as never);
  }

  /** Mantém cada edição administrativa dentro do mesmo Container V2. */
  private adminInteraction<T extends ButtonInteraction | StringSelectMenuInteraction | ChannelSelectMenuInteraction | RoleSelectMenuInteraction>(interaction: T, guildId: string): T {
    const views = this.views;
    const hasDefaultBanner = interaction.message.attachments.some((attachment) => attachment.name === "panel-banner.png");
    return new Proxy(interaction, {
      get(target, property) {
        if (property === "update") return (payload: { content?: unknown; embeds?: unknown[]; components?: unknown[] }) => target.update(views.adminPageEdit(guildId, payload, hasDefaultBanner) as never);
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  }

  private async storeRespond(interaction: ButtonInteraction | StringSelectMenuInteraction, payload: Record<string, unknown>) {
    if (interaction.message.flags.has(MessageFlags.Ephemeral)) return interaction.update(payload as never);
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral } as never);
  }

  private async button(interaction: ButtonInteraction) {
    const id = interaction.customId;
    if (id.startsWith("delivery:copy:")) return this.deliveryCopyButton(interaction, id);
    const gid = interaction.guildId;
    if (!gid) throw new Error("Esta interação precisa ser utilizada dentro do servidor.");
    if (id.startsWith("admin:")) { this.requireAdminAction(interaction, id); return this.adminButton(interaction, id, gid); }
    if (id.startsWith("cart:")) return this.cartButton(interaction, id, gid);
    if (id.startsWith("payment:")) return this.paymentButton(interaction, id, gid);
    if (id.startsWith("lock:")) return this.lockButton(interaction, id, gid);
    if (id.startsWith("product:")) return this.productButton(interaction, id, gid);
    if (id.startsWith("store:")) return interaction.reply({ content: "Este painel antigo de loja foi desativado. Use um painel individual de produto publicado pela equipe.", flags: MessageFlags.Ephemeral });
    if (id.startsWith("stock-request:")) return this.stockRequestButton(interaction, id, gid);
    if (id.startsWith("ticket:")) return this.ticketButton(interaction, id, gid);
    if (id.startsWith("giveaway:")) return this.giveawayButton(interaction, id);
  }

  private async adminButton(i: ButtonInteraction, id: string, gid: string) {
    if (id === "admin:home") return this.updateAdmin(i, this.views.adminHome(gid, i.user.displayName));
    if (id === "admin:products") return i.update(this.views.productsHome(gid) as never);
    if (id === "admin:restock") return i.update(this.views.restockSettings(gid) as never);
    if (id === "admin:restock:channel") return i.update(this.views.channelPicker(gid, "admin:restock:channel-set", "Canal onde os avisos de reposição serão publicados") as never);
    if (id === "admin:restock:role") return i.update(this.views.rolePicker(gid, "admin:restock:role-set", "Cargo mencionado nos avisos de reposição", 1) as never);
    if (id === "admin:restock:toggle") {
      const settings = this.db.guild(gid).restockAnnouncements;
      if (!settings.enabled && !settings.channelId) throw new Error("Escolha o canal de restock antes de ativar os avisos.");
      settings.enabled = !settings.enabled; this.db.save(); return i.update(this.views.restockSettings(gid) as never);
    }
    if (id === "admin:restock:banner") {
      const settings = this.db.guild(gid).restockAnnouncements;
      settings.includeProductBanner = !settings.includeProductBanner; this.db.save(); return i.update(this.views.restockSettings(gid) as never);
    }
    if (id === "admin:restock:edit") {
      const settings = this.db.guild(gid).restockAnnouncements;
      return i.showModal(modal("modal:restock:edit", "Mensagem de restock", [
        input("title", "Título", settings.title, TextInputStyle.Short, true, 250),
        input("message", "Mensagem", settings.message, TextInputStyle.Paragraph, true, 1800)
      ]));
    }
    if (/^admin:products:\d+$/.test(id)) return i.update(this.views.productsHome(gid, Number(id.split(":")[2])) as never);
    if (id === "admin:store") return i.update(this.views.productsHome(gid) as never);
    if (id === "admin:payments") return i.update(this.views.paymentsHome(gid) as never);
    if (id === "admin:tickets") return i.update(this.views.ticketPanelsHome(gid) as never);
    if (id === "admin:messages") return i.update(this.botMessagesView(gid) as never);
    if (id === "admin:stock-requests") return i.update(this.views.stockRequestsHome(gid) as never);
    if (id === "admin:saved-emojis") return i.update(this.views.savedEmojisHome(gid) as never);
    if (/^admin:saved-emojis:\d+$/.test(id)) return i.update(this.views.savedEmojisHome(gid, Number(id.split(":")[2] ?? 0)) as never);
    if (id === "admin:emojis") return i.update(this.views.emojisHome(gid) as never);
    if (id === "admin:channels") return i.update(this.views.channelSettings(gid) as never);
    if (id === "admin:personalize") return i.update(this.personalizeView(gid) as never);
    if (id === "admin:automations") return i.update(this.automationsView(gid) as never);
    if (id === "admin:protection") return i.update(this.protectionView(gid) as never);
    if (id === "admin:revenue") return i.update(this.revenueView(gid) as never);
    if (id === "admin:orders") return i.update(this.ordersAdminView(gid) as never);
    if (id === "admin:giveaways") return i.update(this.giveawaysView(gid) as never);
    if (id === "admin:coupons") return i.update(this.couponsView(gid) as never);
    if (id === "admin:permissions") return i.update(this.permissionsView(gid) as never);
    if (id === "admin:backups") return i.update(this.backupsView(gid) as never);
    if (id === "admin:backup") {
      await i.deferReply({ flags: MessageFlags.Ephemeral }); const path = this.db.backup(); await i.editReply({ content: "Backup JSON criado.", files: [new AttachmentBuilder(path)] }); return;
    }
    if (id.startsWith("admin:coupon:CPN_")) return i.update(this.couponDetail(gid, id.split(":")[2]!) as never);
    if (id.startsWith("admin:backup:BKP_")) return i.update(this.backupDetail(gid, id.split(":")[2]!) as never);
    if (id === "admin:quick-setup") return i.update({
      embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle("Instalação rápida do servidor").setDescription("O bot criará os cargos **166 Community • Equipe** e **166 Community • Cliente**, categorias de tickets, um canal para painéis de produtos, canais de logs, um painel inicial de atendimento e publicará os painéis de suporte automaticamente. Itens já configurados serão reaproveitados.")],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.views.button(gid, "admin:quick-setup-confirm", "Criar estrutura", "approve", ButtonStyle.Success),
        this.views.button(gid, "admin:home", "Cancelar", "back", ButtonStyle.Danger)
      )]
    });
    if (id === "admin:quick-setup-confirm") return this.runQuickSetup(i, gid);
    if (id === "admin:setupticket:step1") {
      return i.showModal(modal("modal:setupticket:step1", "Dados do Painel de Ticket", [
        input("name", "Nome interno do painel", "Atendimento", TextInputStyle.Short, true, 80),
        input("title", "Título público", "Central de Atendimento", TextInputStyle.Short, true, 256),
        input("description", "Descrição pública", "Selecione o assunto para abrir um atendimento privado.", TextInputStyle.Paragraph, true, 4000),
        input("color", "Cor hexadecimal", this.db.brand(gid).color, TextInputStyle.Short, true, 7),
        input("footer", "Rodapé (opcional)", "166 Community • Atendimento", TextInputStyle.Short, false, 200)
      ]));
    }
    if (id === "admin:setupticket:step2-image") {
      return this.collectImage(i, "banner do painel de ticket", (url) => {
        i.client.emit("setupticket:image", { guildId: gid, imageUrl: url, userId: i.user.id });
      });
    }
    if (id === "admin:setupticket:step2-skip") {
      return i.update({
        embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle("Passo 3: Canal do painel").setDescription("Selecione o canal onde o painel de ticket será publicado.")],
        components: [
          new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId("admin:setupticket:channel-select")
              .setPlaceholder("Selecione o canal")
              .setChannelTypes(ChannelType.GuildText)
              .setMinValues(1)
              .setMaxValues(1)
          ),
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            this.views.button(gid, "admin:home", "Cancelar", "back", ButtonStyle.Secondary)
          )
        ]
      } as never);
    }
    if (id.startsWith("admin:setupticket:channel-select")) return;
    if (id === "admin:setupticket:publish") {
      const panelId = id.split(":")[3]!;
      const panel = this.tickets.getPanel(panelId);
      const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId(`admin:setupticket:do-publish:${panelId}`)
        .setPlaceholder("Canal para publicar o painel")
        .setChannelTypes(ChannelType.GuildText)
        .setMinValues(1)
        .setMaxValues(1);
      return i.update({
        embeds: [new EmbedBuilder().setColor(0x22c55e).setTitle("Painel criado com sucesso!").setDescription(`Painel **${panel.name}** criado. Agora selecione o canal para publicar.`)],
        components: [new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channelSelect), this.views.back(gid, "admin:tickets")]
      } as never);
    }
    if (id.startsWith("admin:permissions:user:")) {
      const key = id.split(":")[3]!;
      const current = key === "admins" ? this.db.guild(gid).permissions.adminUserIds : this.db.guild(gid).permissions.authorizedUserIds;
      return i.update({ embeds: [new EmbedBuilder().setColor(0x3155ff).setTitle(key === "admins" ? "Usuários administradores" : "Usuários autorizados").setDescription("Selecione os usuários. O proprietário do bot e o dono do servidor sempre mantêm acesso.")], components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(new UserSelectMenuBuilder().setCustomId(`admin:permissions-user-set:${key}`).setPlaceholder("Selecione usuários").setMinValues(0).setMaxValues(25).setDefaultUsers(current)), this.views.back(gid, "admin:permissions")] } as never);
    }
    if (id.startsWith("admin:permissions:role:")) {
      const key = id.split(":")[3]!;
      const map: Record<string, keyof import("../types.js").GuildPermissions> = { admins: "adminRoleIds", authorized: "authorizedRoleIds", support: "supportRoleIds", tickets: "ticketRoleIds", payments: "paymentRoleIds", products: "productRoleIds", commands: "adminCommandRoleIds" };
      const field = map[key]; if (!field) throw new Error("Grupo de permissão inválido.");
      const current = this.db.guild(gid).permissions[field] as string[];
      return i.update({ embeds: [new EmbedBuilder().setColor(0x3155ff).setTitle("Cargos autorizados").setDescription(`Grupo: **${key}**. Selecione até 25 cargos.`)], components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId(`admin:permissions-role-set:${key}`).setPlaceholder("Selecione cargos").setMinValues(0).setMaxValues(25).setDefaultRoles(current)), this.views.back(gid, "admin:permissions")] } as never);
    }
    if (id === "admin:locks:ignored") return i.update({ embeds: [new EmbedBuilder().setColor(0x3155ff).setTitle("Canais ignorados no /lock all").setDescription("Estes canais nunca serão bloqueados pelo comando em massa.")], components: [new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId("admin:locks-ignored-set").setPlaceholder("Selecione canais ignorados").setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(25).setDefaultChannels(this.db.guild(gid).locks.ignoredChannelIds)), this.views.back(gid, "admin:permissions")] } as never);
    if (id === "admin:locks:speaking") return i.update({ embeds: [new EmbedBuilder().setColor(0x3155ff).setTitle("Cargos que podem falar durante o bloqueio")], components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId("admin:locks-speaking-set").setPlaceholder("Selecione cargos").setMinValues(0).setMaxValues(25).setDefaultRoles(this.db.guild(gid).locks.speakingRoleIds)), this.views.back(gid, "admin:permissions")] } as never);
    if (id === "admin:product:create") return i.update({
      embeds: [new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle("Criar produto")
        .setDescription("Escolha como o produto será entregue. A opção poderá ser alterada depois sem recriar o produto.")
        .addFields(
          { name: "Entrega automática", value: "O bot reserva o stock e envia a unidade após a aprovação do pagamento." },
          { name: "Entrega manual", value: "O pagamento é aprovado e a equipe conclui a entrega no canal privado." }
        )],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.views.button(gid, "admin:product:create-type:STOCK", "Entrega automática", "delivery", ButtonStyle.Success),
        this.views.button(gid, "admin:product:create-type:MANUAL", "Entrega manual", "support", ButtonStyle.Primary),
        this.views.button(gid, "admin:products", "Cancelar", "back", ButtonStyle.Secondary)
      )]
    } as never);
    if (id.startsWith("admin:product:create-type:")) {
      const selectedDelivery = id.split(":")[3] === "STOCK" ? "STOCK" : "MANUAL";
      return i.showModal(modal(`modal:product:create:${selectedDelivery}`, selectedDelivery === "STOCK" ? "Produto automático" : "Produto manual", [
        input("name", "Nome do produto", "", TextInputStyle.Short, true, 100),
        input("description", "Descrição do produto", "", TextInputStyle.Paragraph, true, 4000),
        input("field_name", "Nome da primeira opção", "Opção principal", TextInputStyle.Short, true, 100),
        input("price", "Preço (ex: 9,90)", "", TextInputStyle.Short, true, 20, "9,90"),
        input("image", "URL da imagem do produto (opcional)", "", TextInputStyle.Short, false, 500, "https://..."),
        input("banner", "URL do banner (opcional)", "", TextInputStyle.Short, false, 500, "https://..."),
        input("color", "Cor hexadecimal (opcional)", "#3155ff", TextInputStyle.Short, false, 7)
      ]));
    }
    if (/^admin:product:PRD_[^:]+$/.test(id)) return i.update(this.views.productDetail(gid, this.products.get(id.split(":")[2]!, gid)) as never);
    if (/^admin:product:emoji:[^:]+:\d+$/.test(id)) {
      const [, , , productId, pageRaw] = id.split(":");
      return i.update(this.emojiAssetPicker(gid, "product", Number(pageRaw ?? 0), { productId }) as never);
    }
    if (/^admin:product:field-emoji:[^:]+:[^:]+:\d+$/.test(id)) {
      const [, , , productId, fieldId, pageRaw] = id.split(":");
      return i.update(this.emojiAssetPicker(gid, "product-field", Number(pageRaw ?? 0), { productId, fieldId }) as never);
    }
    if (id.startsWith("admin:product:basic:")) {
      const product = this.products.get(id.split(":")[3]!, gid);
      return i.showModal(modal(`modal:product:basic:${product.id}`, "Descrição do produto", [
        input("name", "Nome", product.name, TextInputStyle.Short, true, 100),
        input("description", "Descrição pública", product.description, TextInputStyle.Paragraph, true, 4000)
      ]));
    }
    if (id.startsWith("admin:product:visual:")) {
      const product = this.products.get(id.split(":")[3]!, gid);
      return i.showModal(modal(`modal:product:visual:${product.id}`, "Banner e visual do painel", [
        input("image", "URL da miniatura (opcional)", product.imageUrl, TextInputStyle.Short, false, 1000),
        input("banner", "URL do banner principal", product.bannerUrl, TextInputStyle.Short, false, 1000),
        input("color", "Cor hexadecimal", product.color, TextInputStyle.Short, true, 7)
      ]));
    }
    if (id.startsWith("admin:product:purchase:")) {
      const product = this.products.get(id.split(":")[3]!, gid);
      return i.showModal(modal(`modal:product:purchase:${product.id}`, "Texto da compra", [
        input("label", "Texto do botão quando houver 1 campo", product.buttonLabel, TextInputStyle.Short, true, 80),
        input("style", "Estilo: PRIMARY / SECONDARY / SUCCESS / DANGER", product.buttonStyle, TextInputStyle.Short, true, 20),
        input("placeholder", "Texto do select quando houver 2+ campos", product.selectPlaceholder, TextInputStyle.Short, true, 150)
      ]));
    }
    if (id.startsWith("admin:product:demo:")) {
      const product = this.products.get(id.split(":")[3]!, gid);
      return i.showModal(modal(`modal:product:demo:${product.id}`, "Botão de demonstração", [
        input("url", "Link da demonstração (vazio desativa)", product.demonstrationUrl, TextInputStyle.Short, false, 1000, "https://..."),
        input("label", "Texto do botão", product.demonstrationLabel, TextInputStyle.Short, true, 80),
        input("emoji", "Emoji: ID, saved:nome, Unicode ou função", product.demonstrationEmoji, TextInputStyle.Short, false, 100)
      ]));
    }
    if (id.startsWith("admin:product:delivery-type:")) {
      const productId = id.split(":")[3]!;
      const product = this.products.get(productId, gid);
      const select = new StringSelectMenuBuilder()
        .setCustomId(`admin:product:delivery-type-select:${product.id}`)
        .setPlaceholder("Escolha o tipo de entrega")
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel("Entrega automática").setDescription("Consome e envia o stock após o pagamento").setValue("STOCK").setEmoji(this.emojis.component("delivery", gid)).setDefault(product.deliveryType === "STOCK"),
          new StringSelectMenuOptionBuilder().setLabel("Entrega manual").setDescription("A equipe conclui a entrega no canal privado").setValue("MANUAL").setEmoji(this.emojis.component("support", gid)).setDefault(product.deliveryType === "MANUAL"),
          new StringSelectMenuOptionBuilder().setLabel("Entrega por cargo").setDescription("Adiciona o cargo configurado após o pagamento").setValue("ROLE").setEmoji(this.emojis.component("role", gid)).setDefault(product.deliveryType === "ROLE")
        );
      return i.update({
        embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle(`Tipo de entrega • ${product.name}`).setDescription("Selecione uma opção. A alteração é salva imediatamente e as mensagens publicadas podem ser atualizadas pelo painel do produto.")],
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), this.views.back(gid, `admin:product:delivery:${product.id}`)]
      } as never);
    }
    if (id.startsWith("admin:product:delivery-role:")) {
      const product = this.products.get(id.split(":")[3]!, gid);
      const select = new RoleSelectMenuBuilder()
        .setCustomId(`admin:product:delivery-role-set:${product.id}`)
        .setPlaceholder("Escolha o cargo entregue")
        .setMinValues(0)
        .setMaxValues(1);
      if (product.roleId) select.setDefaultRoles(product.roleId);
      return i.update({
        embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle(`Cargo entregue • ${product.name}`).setDescription("Selecione um cargo ou confirme sem seleção para remover o cargo atual.")],
        components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select), this.views.back(gid, `admin:product:delivery:${product.id}`)]
      } as never);
    }
    if (id.startsWith("admin:product:delivery-message:")) {
      const product = this.products.get(id.split(":")[3]!, gid);
      return i.showModal(modal(`modal:product:delivery-message:${product.id}`, "Mensagem de entrega", [
        input("message", "Mensagem exibida após o pagamento", product.deliveryMessage, TextInputStyle.Paragraph, false, 1800)
      ]));
    }
    if (id.startsWith("admin:product:delivery-limits:")) {
      const product = this.products.get(id.split(":")[3]!, gid);
      return i.showModal(modal(`modal:product:delivery-limits:${product.id}`, "Limites de compra", [
        input("minimum", "Quantidade mínima", String(product.minQuantity), TextInputStyle.Short, true, 4),
        input("maximum", "Quantidade máxima", String(product.maxQuantity), TextInputStyle.Short, true, 4),
        input("per_user", "Limite total por usuário (0 sem limite)", String(product.perUserLimit), TextInputStyle.Short, true, 6),
        input("coupon_group", "Grupo de cupons (opcional)", product.couponGroup, TextInputStyle.Short, false, 80)
      ]));
    }
    if (id.startsWith("admin:product:terms-toggle:")) {
      const product = this.products.get(id.split(":")[3]!, gid);
      const updated = this.products.update(product.id, { requireTerms: !product.requireTerms }, i.user.id);
      return i.update(this.productDeliveryView(gid, updated) as never);
    }
    if (id.startsWith("admin:product:terms-text:")) {
      const product = this.products.get(id.split(":")[3]!, gid);
      return i.showModal(modal(`modal:product:terms-text:${product.id}`, "Termos do produto", [
        input("terms", "Texto apresentado antes da compra", product.termsText, TextInputStyle.Paragraph, false, 1800)
      ]));
    }
    if (/^admin:product:delivery:PRD_[^:]+$/.test(id)) {
      const product = this.products.get(id.split(":")[3]!, gid);
      return i.update(this.productDeliveryView(gid, product) as never);
    }
    if (id.startsWith("admin:product:fields:")) {
      const product = this.products.get(id.split(":")[3]!, gid);
      return i.update(this.views.productFieldsView(gid, product) as never);
    }
    if (id.startsWith("admin:product:field:")) {
      const [, , , productId, fieldId] = id.split(":");
      const product = this.products.get(productId!, gid);
      return i.update(this.views.productFieldDetail(gid, product, this.products.getField(product.id, fieldId)) as never);
    }
    if (id.startsWith("admin:product:field-add:")) {
      const productId = id.split(":")[3]!;
      return i.showModal(modal(`modal:product:field-add:${productId}`, "Adicionar campo", [
        input("name", "Nome do campo", "", TextInputStyle.Short, true, 100),
        input("description", "Descrição curta no select", "", TextInputStyle.Short, false, 100),
        input("price", "Preço", "", TextInputStyle.Short, true, 20, "9,90"),
        input("compare", "Preço anterior (opcional)", "", TextInputStyle.Short, false, 20),
        input("emoji", "Emoji: ID, saved:nome, Unicode ou função", "cart", TextInputStyle.Short, false, 100)
      ]));
    }
    if (id.startsWith("admin:product:field-edit:")) {
      const [, , , productId, fieldId] = id.split(":");
      const field = this.products.getField(productId!, fieldId);
      return i.showModal(modal(`modal:product:field-edit:${productId}:${fieldId}`, "Editar campo", [
        input("name", "Nome do campo", field.name, TextInputStyle.Short, true, 100),
        input("description", "Descrição curta no select", field.description, TextInputStyle.Short, false, 100),
        input("price", "Preço", (field.priceCents / 100).toFixed(2), TextInputStyle.Short, true, 20),
        input("compare", "Preço anterior (opcional)", field.compareAtCents ? (field.compareAtCents / 100).toFixed(2) : "", TextInputStyle.Short, false, 20),
        input("emoji", "Emoji: ID, saved:nome, Unicode ou função", field.emoji, TextInputStyle.Short, false, 100)
      ]));
    }
    if (id.startsWith("admin:product:field-stock:")) {
      const [, , , productId, fieldId] = id.split(":");
      const product = this.products.get(productId!, gid);
      return i.update(this.views.stockView(gid, product, this.products.getField(product.id, fieldId)) as never);
    }
    if (id.startsWith("admin:product:field-toggle:")) {
      const [, , , productId, fieldId] = id.split(":");
      const product = this.products.get(productId!, gid);
      const field = this.products.getField(product.id, fieldId);
      this.products.updateField(product.id, field.id, { active: !field.active }, i.user.id);
      return i.update(this.views.productFieldDetail(gid, product, field) as never);
    }
    if (id.startsWith("admin:product:field-delete:")) {
      const [, , , productId, fieldId] = id.split(":");
      const product = this.products.get(productId!, gid);
      const field = this.products.getField(product.id, fieldId);
      return i.update({
        embeds: [new EmbedBuilder().setColor(0xef4444).setTitle("Excluir campo").setDescription(`Excluir **${field.name}** e o stock disponível desse campo?`)],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.views.button(gid, `admin:product:field-delete-confirm:${product.id}:${field.id}`, "Excluir", "trash", ButtonStyle.Danger),
          this.views.button(gid, `admin:product:field:${product.id}:${field.id}`, "Cancelar", "back")
        )]
      });
    }
    if (id.startsWith("admin:product:field-delete-confirm:")) {
      const [, , , productId, fieldId] = id.split(":");
      this.products.deleteField(productId!, fieldId!, i.user.id);
      return i.update(this.views.productFieldsView(gid, this.products.get(productId!, gid)) as never);
    }
    if (id.startsWith("admin:product:image-upload:")) {
      const productId = id.split(":")[3]!;
      return this.collectImage(i, "imagem do produto", (url) => {
        this.products.update(productId, { imageUrl: url }, i.user.id);
        this.schedulePublishedRefresh();
      });
    }
    if (id.startsWith("admin:product:banner-upload:")) {
      const productId = id.split(":")[3]!;
      return this.collectImage(i, "banner do produto", (url) => {
        this.products.update(productId, { bannerUrl: url }, i.user.id);
        this.schedulePublishedRefresh();
      });
    }
    if (id.startsWith("admin:stock:add:")) {
      const [, , , productId, fieldId] = id.split(":");
      return i.showModal(modal(`modal:stock:add:${productId}:${fieldId}`, "Adicionar stock individual", [input("items", "Itens (linha vazia separa blocos)", "", TextInputStyle.Paragraph, true, 4000, "Uma linha por unidade; use uma linha vazia entre unidades com várias linhas")]));
    }
    if (id.startsWith("admin:stock:ghost:")) {
      const [, , , productId, fieldId] = id.split(":");
      const field = this.products.getField(productId!, fieldId);
      return i.showModal(modal(`modal:stock:ghost:${productId}:${fieldId}`, "Configurar stock fantasma", [
        input("content", "Conteúdo entregue em todas as unidades", "", TextInputStyle.Paragraph, true, 4000),
        input("quantity", "Quantidade disponível", String(Math.max(1, this.products.stockCount(productId!, "AVAILABLE", field.id) || 1)), TextInputStyle.Short, true, 10)
      ]));
    }
    if (id.startsWith("admin:stock:unique:")) {
      const [, , , productId, fieldId] = id.split(":");
      this.products.updateField(productId!, fieldId!, { stockMode: "UNIQUE" }, i.user.id);
      const product = this.products.get(productId!, gid);
      return i.update(this.views.stockView(gid, product, this.products.getField(product.id, fieldId)) as never);
    }
    if (id.startsWith("admin:stock:clear:")) {
      const [, , , productId, fieldId] = id.split(":");
      const product = this.products.get(productId!, gid);
      const field = this.products.getField(product.id, fieldId);
      return i.update({
        embeds: [new EmbedBuilder().setColor(0xef4444).setTitle("Confirmar limpeza").setDescription(`Remover todo o stock disponível de **${product.name} • ${field.name}**?`) ],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.views.button(gid, `admin:stock:clear-confirm:${product.id}:${field.id}`, "Confirmar", "trash", ButtonStyle.Danger),
          this.views.button(gid, `admin:product:field-stock:${product.id}:${field.id}`, "Cancelar", "back")
        )]
      });
    }
    if (id.startsWith("admin:stock:clear-confirm:")) {
      const [, , , productId, fieldId] = id.split(":");
      const removed = this.products.clearStock(productId!, fieldId!, i.user.id);
      const product = this.products.get(productId!, gid);
      await i.update(this.views.stockView(gid, product, this.products.getField(product.id, fieldId)) as never);
      await i.followUp({ content: `${removed} unidade(s) disponível(is) removida(s).`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (id.startsWith("admin:product:update-message:")) {
      const productId = id.split(":")[3]!;
      await i.deferUpdate();
      const result = await this.refreshProductPublications(productId);
      await i.editReply(this.views.productDetail(gid, this.products.get(productId, gid)) as never);
      await i.followUp({ content: `✅ ${result.updated} mensagem(ns) atualizada(s)${result.removed ? `; ${result.removed} vínculo(s) inválido(s) removido(s)` : ""}.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (id.startsWith("admin:product:toggle:")) { const product = this.products.get(id.split(":")[3]!, gid); this.products.update(product.id, { active: !product.active }, i.user.id); return i.update(this.views.productDetail(gid, product) as never); }
    if (id.startsWith("admin:product:featured:")) { const product = this.products.get(id.split(":")[3]!, gid); this.products.update(product.id, { featured: !product.featured }, i.user.id); return i.update(this.views.productDetail(gid, product) as never); }
    if (id.startsWith("admin:product:duplicate:")) { const copy = this.products.duplicate(id.split(":")[3]!, i.user.id); return i.update(this.views.productDetail(gid, copy) as never); }
    if (id.startsWith("admin:product:delete:")) { const product = this.products.get(id.split(":")[3]!, gid); return i.update({ embeds: [new EmbedBuilder().setColor(0xef4444).setTitle("Excluir produto").setDescription(`Confirma a exclusão/arquivamento de **${product.name}**?`)], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(this.views.button(gid, `admin:product:delete-confirm:${product.id}`, "Excluir", "product_delete", ButtonStyle.Danger), this.views.button(gid, `admin:product:${product.id}`, "Cancelar", "back"))] }); }
    if (id.startsWith("admin:product:delete-confirm:")) { this.products.delete(id.split(":")[3]!, i.user.id); return i.update(this.views.productsHome(gid) as never); }
    if (id.startsWith("admin:product:publish:")) return i.update(this.views.channelPicker(gid, `admin:product:publish-channel:${id.split(":")[3]}`, "Selecione o canal de publicação") as never);

    if (id === "admin:stock-request:edit") {
      const settings = this.db.guild(gid).stockRequest;
      return i.showModal(modal("modal:stock-request:edit", "Mensagem • Pedir Stock", [
        input("title", "Título", settings.title, TextInputStyle.Short, true, 256),
        input("description", "Descrição", settings.description, TextInputStyle.Paragraph, true, 4000),
        input("footer", "Rodapé", settings.footer, TextInputStyle.Short, false, 2048),
        input("button", "Texto do botão", settings.buttonLabel, TextInputStyle.Short, true, 80),
        input("confirmation", "Confirmação enviada ao cliente", settings.confirmationMessage, TextInputStyle.Paragraph, true, 1500)
      ]));
    }
    if (id === "admin:stock-request:appearance") {
      const settings = this.db.guild(gid).stockRequest;
      return i.showModal(modal("modal:stock-request:appearance", "Aparência • Pedir Stock", [
        input("color", "Cor hexadecimal", settings.color, TextInputStyle.Short, true, 7),
        input("emoji", "Emoji/função", settings.emojiSemantic, TextInputStyle.Short, true, 40),
        input("style", "Estilo: PRIMARY/SECONDARY/SUCCESS/DANGER", settings.buttonStyle, TextInputStyle.Short, true, 12),
        input("image", "URL da imagem (opcional)", settings.imageUrl, TextInputStyle.Paragraph, false, 1000),
        input("thumbnail", "URL da miniatura (opcional)", settings.thumbnailUrl, TextInputStyle.Paragraph, false, 1000)
      ]));
    }
    if (id === "admin:stock-request:image-upload") return this.collectImage(i, "imagem do painel Pedir Stock", (url) => {
      this.db.guild(gid).stockRequest.imageUrl = url;
      this.db.save();
      this.schedulePublishedRefresh();
    });
    if (id === "admin:stock-request:toggle") {
      this.db.guild(gid).stockRequest.enabled = !this.db.guild(gid).stockRequest.enabled;
      this.db.audit(i.user.id, "STOCK_REQUEST_TOGGLE", "guild", gid, { enabled: this.db.guild(gid).stockRequest.enabled });
      this.db.save();
      this.schedulePublishedRefresh();
      return i.update(this.views.stockRequestsHome(gid) as never);
    }
    if (id === "admin:stock-request:destination") return i.update(this.views.channelPicker(gid, "admin:stock-request:destination-set", "Canal que receberá os pedidos de stock") as never);
    if (id === "admin:stock-request:roles") return i.update(this.views.rolePicker(gid, "admin:stock-request:roles-set", "Cargos notificados nos pedidos", 10) as never);
    if (id === "admin:stock-request:publish") return i.update(this.views.channelPicker(gid, "admin:stock-request:publish-channel", "Canal público do painel Pedir Stock") as never);
    if (id === "admin:stock-request:preview") return i.update({ ...this.views.publicStockRequestPanel(gid), components: [
      ...this.views.publicStockRequestPanel(gid).components,
      this.views.back(gid, "admin:stock-requests")
    ] } as never);
    if (id === "admin:stock-request:list") return i.update(this.views.stockRequestQueue(gid) as never);

    if (id === "admin:saved-emoji:add") return i.showModal(modal("modal:saved-emoji:prepare", "Salvar Emoji na Aplicação", [
      input("name", "Nome do emoji", "meu_emoji", TextInputStyle.Short, true, 32, "produto_vip")
    ]));
    if (id === "admin:saved-emoji:settings") {
      const settings = this.db.guild(gid).emojiLibrary;
      return i.update({
        embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle("Permissões • Salvar Emojis").setDescription(`Membros comuns: **${settings.allowMembers ? "podem salvar" : "não podem salvar"}**
Limite por membro: **${settings.maxPerUser}**`) ],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.views.button(gid, "admin:saved-emoji:members-toggle", settings.allowMembers ? "Bloquear membros" : "Permitir membros", settings.allowMembers ? "off" : "on", settings.allowMembers ? ButtonStyle.Danger : ButtonStyle.Success),
          this.views.button(gid, "admin:saved-emoji:limit", "Alterar limite", "settings", ButtonStyle.Primary),
          this.views.button(gid, "admin:saved-emojis", "Voltar", "back", ButtonStyle.Secondary)
        )]
      } as never);
    }
    if (id === "admin:saved-emoji:members-toggle") {
      const settings = this.db.guild(gid).emojiLibrary;
      settings.allowMembers = !settings.allowMembers;
      this.db.audit(i.user.id, "EMOJI_LIBRARY_MEMBER_ACCESS", "guild", gid, { allowMembers: settings.allowMembers });
      this.db.save();
      return i.update(this.views.savedEmojisHome(gid) as never);
    }
    if (id === "admin:saved-emoji:limit") {
      const settings = this.db.guild(gid).emojiLibrary;
      return i.showModal(modal("modal:saved-emoji:limit", "Limite de emojis por membro", [
        input("limit", "Quantidade máxima", String(settings.maxPerUser), TextInputStyle.Short, true, 4)
      ]));
    }
    if (id === "admin:saved-emoji:refresh") {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const removed = await this.emojis.reconcileSavedEmojis();
      await i.editReply(`Biblioteca atualizada. Registros inválidos removidos: **${removed}**.`);
      return;
    }
    if (id.startsWith("admin:saved-emoji:copy:")) {
      const item = this.emojis.findSaved(id.split(":")[3]!);
      if (!item) throw new Error("Emoji salvo não encontrado.");
      const mention = this.emojis.mentionSaved(item);
      return i.reply({ content: `**Código pronto para copiar:**\n\`\`\`\n${mention}\n\`\`\`\n**ID:** \`${item.id}\` • **Nome:** \`${item.name}\``, flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("admin:saved-emoji:remove:")) {
      const item = await this.emojis.removeSaved(id.split(":")[3]!, i.user.id, true);
      await i.update(this.views.savedEmojisHome(gid) as never);
      await i.followUp({ content: `${this.emojis.fallback("approve")} Emoji **${item.name}** removido da aplicação.`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (id === "admin:payment:mp") {
      const settings = this.db.payments(gid).mercadoPago;
      return i.showModal(modal("modal:payment:mp", "Mercado Pago", [
        input("token", "Access Token (vazio mantém atual)", "", TextInputStyle.Paragraph, false, 500),
        input("pix", "Chave Pix para o botão de copiar", settings.pixKey, TextInputStyle.Short, true, 200),
        input("email", "E-mail padrão do pagador", settings.payerEmail, TextInputStyle.Short, false, 200),
        input("descriptor", "Identificação na fatura", settings.statementDescriptor, TextInputStyle.Short, true, 22)
      ]));
    }
    if (id === "admin:payment:mp-toggle") {
      const settings = this.db.payments(gid).mercadoPago;
      if (!settings.enabled && (!settings.pixKey.trim() || !this.db.getSecret("mp_access_token", gid))) throw new Error("Configure o Access Token e a chave Pix antes de ativar o Mercado Pago.");
      settings.enabled = !settings.enabled;
      this.db.save();
      return i.update(this.views.paymentsHome(gid) as never);
    }
    if (id === "admin:payment:efi") {
      const settings = this.db.payments(gid).efiBank;
      return i.showModal(modal("modal:payment:efi", "Efí Bank", [
        input("client", "Client ID (vazio mantém)", "", TextInputStyle.Paragraph, false, 500),
        input("secret", "Client Secret (vazio mantém)", "", TextInputStyle.Paragraph, false, 500),
        input("pix", "Chave PIX", settings.pixKey, TextInputStyle.Short, true, 200),
        input("merchant", "Nome do recebedor", settings.merchantName, TextInputStyle.Short, true, 80),
        input("city", "Cidade do recebedor", settings.merchantCity, TextInputStyle.Short, true, 40)
      ]));
    }
    if (id === "admin:payment:efi-toggle") {
      const settings = this.db.payments(gid).efiBank;
      if (!settings.enabled && (!settings.pixKey.trim() || !this.db.getSecret("efi_client_id", gid) || !this.db.getSecret("efi_client_secret", gid) || !this.db.getSecret("efi_certificate_base64", gid))) throw new Error("Configure a chave Pix, as credenciais e o certificado antes de ativar a Efí.");
      settings.enabled = !settings.enabled;
      this.db.save();
      return i.update(this.views.paymentsHome(gid) as never);
    }
    if (id === "admin:payment:efi-environment") {
      const settings = this.db.payments(gid).efiBank;
      settings.sandbox = !settings.sandbox;
      this.db.save();
      return i.update(this.views.paymentsHome(gid) as never);
    }
    if (id === "admin:payment:efi-cert") return this.collectCertificate(i);
    if (id === "admin:payment:stripe") {
      const settings = this.db.payments(gid).stripe;
      return i.showModal(modal("modal:payment:stripe", "Stripe PIX", [
        input("key", "Secret Key (vazio mantém a atual)", "", TextInputStyle.Paragraph, false, 500),
        input("descriptor", "Identificação da cobrança", settings.statementDescriptor, TextInputStyle.Short, true, 22),
        input("webhook", "URL pública do webhook (opcional)", settings.webhookUrl, TextInputStyle.Short, false, 500)
      ]));
    }
    if (id === "admin:payment:mistic") {
      const settings = this.db.payments(gid).misticPay;
      return i.showModal(modal("modal:payment:mistic", "MisticPay", [
        input("client", "Client ID (vazio mantém o atual)", "", TextInputStyle.Paragraph, false, 500),
        input("secret", "Client Secret (vazio mantém o atual)", "", TextInputStyle.Paragraph, false, 500),
        input("webhook", "URL pública do webhook (opcional)", settings.webhookUrl, TextInputStyle.Short, false, 500)
      ]));
    }
    if (id === "admin:payment:purin") {
      const settings = this.db.payments(gid).purinCash;
      return i.showModal(modal("modal:payment:purin", "Purin Cash", [
        input("key", "API Key ps_live_ ou ps_test_ (vazio mantém)", "", TextInputStyle.Paragraph, false, 500),
        input("callback", "Callback HTTPS público (opcional)", settings.callbackUrl, TextInputStyle.Short, false, 500)
      ]));
    }
    if (id === "admin:payment:stripe-toggle") {
      const settings = this.db.payments(gid).stripe;
      if (!settings.enabled && !this.db.getSecret("stripe_secret_key", gid)) throw new Error("Configure a Secret Key da Stripe antes de ativar.");
      settings.enabled = !settings.enabled; this.db.save(); return i.update(this.views.paymentsHome(gid) as never);
    }
    if (id === "admin:payment:mistic-toggle") {
      const settings = this.db.payments(gid).misticPay;
      if (!settings.enabled && (!this.db.getSecret("mistic_client_id", gid) || !this.db.getSecret("mistic_client_secret", gid))) throw new Error("Configure Client ID e Client Secret da MisticPay antes de ativar.");
      settings.enabled = !settings.enabled; this.db.save(); return i.update(this.views.paymentsHome(gid) as never);
    }
    if (id === "admin:payment:purin-toggle") {
      const settings = this.db.payments(gid).purinCash;
      if (!settings.enabled && !this.db.getSecret("purin_api_key", gid)) throw new Error("Configure a API Key da Purin Cash antes de ativar.");
      settings.enabled = !settings.enabled; this.db.save(); return i.update(this.views.paymentsHome(gid) as never);
    }
    if (id === "admin:payment:test-api") {
      const methods = this.payments.enabledMethods(gid).filter((provider) => !["IMAP_PIX", "MANUAL_PIX"].includes(provider));
      if (!methods.length) throw new Error("Ative pelo menos um gateway de API para testar.");
      const labels: Record<string, string> = { MERCADO_PAGO: "Mercado Pago", EFI_BANK: "Efí Bank", STRIPE: "Stripe PIX", MISTIC_PAY: "MisticPay", PURIN_CASH: "Purin Cash" };
      const select = new StringSelectMenuBuilder().setCustomId("admin:payment:test-api-select").setPlaceholder("Escolha o gateway que será testado").addOptions(methods.map((provider) => new StringSelectMenuOptionBuilder().setLabel(labels[provider] ?? provider).setValue(provider)));
      return i.update({ embeds: [new EmbedBuilder().setColor(0x3155ff).setTitle("Teste seguro de gateway").setDescription("O teste valida as credenciais e a comunicação sem criar uma cobrança.")], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), this.views.back(gid, "admin:payments")] } as never);
    }
    if (id === "admin:payment:imap") return i.update(this.views.imapSettingsHome(gid) as never);
    if (id === "admin:payment:imap-account") {
      const settings = this.db.payments(gid).imapPix;
      return i.showModal(modal("modal:payment:imap-account", "IMAP e chave PIX por e-mail", [
        input("user", "E-mail da caixa e da chave PIX", settings.username || settings.pixKey, TextInputStyle.Short, true, 200),
        input("password", "Senha de aplicativo (vazio mantém)", "", TextInputStyle.Paragraph, false, 500, "Use uma senha de aplicativo, não a senha principal")
      ]));
    }
    if (id === "admin:payment:imap-pix") {
      const settings = this.db.payments(gid).imapPix;
      return i.showModal(modal("modal:payment:imap-pix", "Dados do PIX", [
        input("key", "Chave PIX", settings.pixKey, TextInputStyle.Short, true, 200),
        input("merchant", "Nome do recebedor", settings.merchantName, TextInputStyle.Short, true, 80),
        input("city", "Cidade do recebedor", settings.merchantCity, TextInputStyle.Short, true, 40)
      ]));
    }
    if (id === "admin:payment:imap-timing") {
      const settings = this.db.payments(gid).imapPix;
      return i.showModal(modal("modal:payment:imap-timing", "Tempo de verificação", [
        input("poll", "Verificar a cada quantos segundos", String(settings.pollIntervalSeconds), TextInputStyle.Short, true, 5),
        input("lookback", "Buscar e-mails dos últimos minutos", String(settings.lookbackMinutes), TextInputStyle.Short, true, 6),
        input("maxwait", "Tempo máximo para pagamento (minutos)", String(settings.maxWaitMinutes), TextInputStyle.Short, true, 6),
        input("mailbox", "Pasta do e-mail", settings.mailbox, TextInputStyle.Short, true, 100)
      ]));
    }
    if (id === "admin:payment:imap-custom-server") {
      const settings = this.db.payments(gid).imapPix;
      return i.showModal(modal("modal:payment:imap-custom-server", "Servidor IMAP personalizado", [
        input("host", "Servidor IMAP", settings.host, TextInputStyle.Short, true, 200),
        input("port", "Porta", String(settings.port), TextInputStyle.Short, true, 5)
      ]));
    }
    if (id === "admin:payment:imap-toggle") {
      const settings = this.db.payments(gid).imapPix;
      if (!settings.enabled && (!settings.username || !settings.pixKey || !this.db.getSecret("imap_password", gid))) throw new Error("Configure a conta de e-mail, a senha de aplicativo e a chave PIX antes de ativar.");
      settings.enabled = !settings.enabled;
      this.db.save();
      this.imap.start();
      return i.update(this.views.imapSettingsHome(gid) as never);
    }
    if (id === "admin:payment:imap-seen-toggle") {
      const settings = this.db.payments(gid).imapPix;
      settings.markSeen = !settings.markSeen;
      this.db.save();
      return i.update(this.views.imapSettingsHome(gid) as never);
    }
    if (id === "admin:payment:imap-test") {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await this.imap.testConnection(gid);
      await i.editReply(`✅ ${result}`);
      return;
    }
    if (id === "admin:payment:manual") {
      const settings = this.db.payments(gid);
      return i.showModal(modal("modal:payment:manual", "PIX manual", [
        input("key", "E-mail usado como chave PIX", settings.manualPixKey, TextInputStyle.Short, true, 200, "pagamentos@exemplo.com")
      ]));
    }
    if (id === "admin:payment:general") return i.showModal(modal("modal:payment:general", "Prazos e consultas", [
      input("expiration", "Expiração do pedido em minutos", String(this.db.payments(gid).orderExpiresMinutes), TextInputStyle.Short, true, 5),
      input("poll", "Consulta API em segundos", String(this.db.payments(gid).pollIntervalSeconds), TextInputStyle.Short, true, 5)
    ]));
    if (id === "admin:payment:efi-certpass") return i.showModal(modal("modal:payment:efi-certpass", "Senha do certificado Efí", [input("password", "Senha do P12/PFX (vazio remove)", "", TextInputStyle.Paragraph, false, 500)]));
    if (id === "admin:payment:provider") {
      const select = new StringSelectMenuBuilder().setCustomId("admin:payment:provider-select").setPlaceholder("Provedor padrão").addOptions([
        ["Mercado Pago", "MERCADO_PAGO", "mercadopago"], ["Efí Bank", "EFI_BANK", "efibank"], ["Stripe PIX", "STRIPE", "payment"], ["MisticPay", "MISTIC_PAY", "pix"], ["Purin Cash", "PURIN_CASH", "payment"], ["IMAP PIX", "IMAP_PIX", "imap"], ["PIX manual", "MANUAL_PIX", "manual"]
      ].map(([label, value, em]) => new StringSelectMenuOptionBuilder().setLabel(label!).setValue(value!).setEmoji(this.emojis.component(em!, gid)).setDefault(this.db.payments(gid).defaultProvider === value)));
      return i.update({ embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle("Provedor padrão").setDescription("Escolha o método usado no checkout.")], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), this.views.back(gid, "admin:payments")] });
    }
    if (id === "admin:payment:test") {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await this.imap.testConnection(gid);
      await i.editReply(`✅ ${result}`);
      return;
    }

    if (/^admin:emoji:mapping:\d+$/.test(id)) return i.update(this.emojiFunctionPicker(gid, Number(id.split(":")[3] ?? 0)) as never);
    if (/^admin:emoji:catalog:\d+$/.test(id)) return i.update(this.emojiAssetPicker(gid, "catalog", Number(id.split(":")[3] ?? 0)) as never);
    if (/^admin:emoji:assets:[^:]+:\d+$/.test(id)) {
      const [, , , functional, pageRaw] = id.split(":");
      return i.update(this.emojiAssetPicker(gid, "mapping", Number(pageRaw ?? 0), { functional }) as never);
    }
    if (id.startsWith("admin:emoji:function:")) return i.update(this.emojiFunctionDetail(gid, id.split(":")[3]!) as never);
    if (id.startsWith("admin:emoji:reset:")) {
      const semantic = id.split(":")[3]!;
      this.db.updateGuild(gid, (guild) => { delete guild.emojiOverrides[semantic]; });
      return i.update(this.emojiFunctionDetail(gid, semantic) as never);
    }
    if (id === "admin:emoji:sync") {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await this.emojis.syncAutomatic(true);
      const refreshed = await this.refreshPublishedMessages();
      await i.editReply(`Sincronização concluída: **${this.emojis.status.installed}/${this.emojis.status.total}** emojis registrados e **${refreshed}** mensagens publicadas atualizadas.`);
      return;
    }
    if (id === "admin:emoji:remove") {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const count = await this.emojis.removeAll();
      await i.editReply(`${count} emojis do pacote 166 Community removidos. O bot continuará funcionando com emojis Unicode até uma nova sincronização.`);
      return;
    }

    if (id === "admin:ticket:create") return i.showModal(modal("modal:ticket:create", "Criar painel de ticket", [
      input("name", "Nome interno", "Atendimento", TextInputStyle.Short, true, 80),
      input("title", "Título público", this.db.brand(gid).ticketTitle, TextInputStyle.Short, true, 256),
      input("description", "Descrição pública", this.db.brand(gid).ticketDescription, TextInputStyle.Paragraph, true, 4000),
      input("color", "Cor hexadecimal", this.db.brand(gid).color, TextInputStyle.Short, true, 7)
    ]));
    if (id.startsWith("admin:ticket:fields:")) return i.update(this.views.ticketPanelFieldsView(gid, this.tickets.getPanel(id.split(":")[3]!)) as never);
    if (id.startsWith("admin:ticket:field-add:")) {
      const panelId = id.split(":")[3]!;
      return i.showModal(modal(`modal:ticket:field-add:${panelId}`, "Adicionar campo ao painel", [
        input("name", "Título do campo", "Informação", TextInputStyle.Short, true, 256),
        input("value", "Conteúdo do campo", "Descreva aqui uma informação importante para o cliente.", TextInputStyle.Paragraph, true, 1024)
      ]));
    }
    if (id.startsWith("admin:ticket:field-edit:")) {
      const [, , , panelId, fieldId] = id.split(":");
      const panel = this.tickets.getPanel(panelId!);
      const field = panel.fields.find((item) => item.id === fieldId);
      if (!field) throw new Error("Campo do painel não encontrado.");
      return i.showModal(modal(`modal:ticket:field-edit:${panelId}:${fieldId}`, "Editar campo do painel", [
        input("name", "Título do campo", field.name, TextInputStyle.Short, true, 256),
        input("value", "Conteúdo do campo", field.value, TextInputStyle.Paragraph, true, 1024)
      ]));
    }
    if (id.startsWith("admin:ticket:field-inline:")) {
      const [, , , panelId, fieldId] = id.split(":");
      const panel = this.tickets.getPanel(panelId!);
      const field = panel.fields.find((item) => item.id === fieldId);
      if (!field) throw new Error("Campo do painel não encontrado.");
      this.tickets.updatePanelField(panelId!, fieldId!, { inline: !field.inline }, i.user.id);
      return i.update(this.views.ticketPanelFieldDetail(gid, this.tickets.getPanel(panelId!), field) as never);
    }
    if (id.startsWith("admin:ticket:field-delete:")) {
      const [, , , panelId, fieldId] = id.split(":");
      this.tickets.deletePanelField(panelId!, fieldId!, i.user.id);
      return i.update(this.views.ticketPanelFieldsView(gid, this.tickets.getPanel(panelId!)) as never);
    }
    if (/^admin:ticket:[^:]+$/.test(id)) return i.update(this.views.ticketPanelDetail(gid, this.tickets.getPanel(id.split(":")[2]!)) as never);
    if (/^admin:ticket:emoji:[^:]+:\d+$/.test(id)) {
      const [, , , panelId, pageRaw] = id.split(":");
      return i.update(this.emojiAssetPicker(gid, "ticket-panel", Number(pageRaw ?? 0), { panelId }) as never);
    }
    if (/^admin:ticket:option-emoji:[^:]+:[^:]+:\d+$/.test(id)) {
      const [, , , panelId, optionId, pageRaw] = id.split(":");
      return i.update(this.emojiAssetPicker(gid, "ticket-option", Number(pageRaw ?? 0), { panelId, optionId }) as never);
    }
    if (id.startsWith("admin:ticket:mode-toggle:")) {
      const panelId = id.split(":")[3]!;
      const panel = this.tickets.getPanel(panelId);
      const updated = this.tickets.updatePanel(panelId, { mode: panel.mode === "SELECT" ? "BUTTONS" : "SELECT" }, i.user.id);
      return i.update(this.views.ticketPanelDetail(gid, updated) as never);
    }
    if (id.startsWith("admin:ticket:option-edit:")) {
      const [, , , panelId, optionId] = id.split(":");
      const option = this.tickets.getPanel(panelId!).options.find((item) => item.id === optionId);
      if (!option) throw new Error("Opção não encontrada.");
      return i.showModal(modal(`modal:ticket:option-edit:${panelId}:${optionId}`, "Textos da opção", [
        input("name", "Nome da opção", option.name, TextInputStyle.Short, true, 100),
        input("description", "Descrição no menu", option.description, TextInputStyle.Short, true, 100),
        input("prefix", "Prefixo do canal", option.channelPrefix, TextInputStyle.Short, true, 40),
        input("opening_title", "Título da mensagem inicial", option.openingTitle, TextInputStyle.Short, true, 256),
        input("opening_description", "Mensagem inicial", option.openingDescription, TextInputStyle.Paragraph, true, 4000)
      ]));
    }
    if (id.startsWith("admin:ticket:option-close-message:")) {
      const [, , , panelId, optionId] = id.split(":");
      const option = this.tickets.getPanel(panelId!).options.find((item) => item.id === optionId);
      if (!option) throw new Error("Opção não encontrada.");
      return i.showModal(modal(`modal:ticket:option-close-message:${panelId}:${optionId}`, "Mensagem de encerramento", [
        input("close", "Mensagem ao fechar", option.closeMessage, TextInputStyle.Paragraph, true, 1800)
      ]));
    }
    if (id.startsWith("admin:ticket:option-limit:")) {
      const [, , , panelId, optionId] = id.split(":");
      const option = this.tickets.getPanel(panelId!).options.find((item) => item.id === optionId);
      if (!option) throw new Error("Opção não encontrada.");
      return i.showModal(modal(`modal:ticket:option-limit:${panelId}:${optionId}`, "Limite por usuário", [
        input("limit", "Tickets simultâneos (1 a 10)", String(option.maxOpenTicketsPerUser), TextInputStyle.Short, true, 2)
      ]));
    }
    if (id.startsWith("admin:ticket:option-emoji-manual:")) {
      const [, , , panelId, optionId] = id.split(":");
      const option = this.tickets.getPanel(panelId!).options.find((item) => item.id === optionId);
      if (!option) throw new Error("Opção não encontrada.");
      return i.showModal(modal(`modal:ticket:option-emoji-manual:${panelId}:${optionId}`, "Emoji da opção", [
        input("emoji", "Emoji, menção ou ID", option.emojiSemantic, TextInputStyle.Short, true, 120, "🛠️ ou <:nome:123456789012345678>")
      ]));
    }
    if (id.startsWith("admin:ticket:option-emoji-clear:")) {
      const [, , , panelId, optionId] = id.split(":");
      this.tickets.updateOption(panelId!, optionId!, { emojiSemantic: "" }, i.user.id);
      return i.update(this.ticketOptionDetail(gid, panelId!, optionId!) as never);
    }
    if (id.startsWith("admin:ticket:option-category-clear:")) {
      const [, , , , panelId, optionId] = id.split(":");
      this.tickets.updateOption(panelId!, optionId!, { categoryId: "" }, i.user.id);
      return i.update(this.ticketOptionDetail(gid, panelId!, optionId!) as never);
    }
    if (id.startsWith("admin:ticket:option-category:")) {
      const [, , , panelId, optionId] = id.split(":");
      const select = new ChannelSelectMenuBuilder()
        .setCustomId(`admin:ticket:option-category-set:${panelId}:${optionId}`)
        .setPlaceholder("Escolha a categoria do ticket")
        .setChannelTypes(ChannelType.GuildCategory)
        .setMinValues(1)
        .setMaxValues(1);
      return i.update({
        embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle("Categoria da opção").setDescription("Selecione onde os tickets desta opção serão criados. Sem categoria própria, a opção utiliza a categoria geral de tickets.")],
        components: [
          new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select),
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            this.views.button(gid, `admin:ticket:option-category-clear:${panelId}:${optionId}`, "Usar categoria geral", "minus", ButtonStyle.Secondary),
            this.views.button(gid, `admin:ticket:options:${panelId}`, "Voltar", "back")
          )
        ]
      });
    }
    if (id.startsWith("admin:ticket:option-roles-clear:")) {
      const [, , , , panelId, optionId] = id.split(":");
      this.tickets.updateOption(panelId!, optionId!, { supportRoleIds: [] }, i.user.id);
      return i.update(this.ticketOptionDetail(gid, panelId!, optionId!) as never);
    }
    if (id.startsWith("admin:ticket:option-roles:")) {
      const [, , , panelId, optionId] = id.split(":");
      const select = new RoleSelectMenuBuilder()
        .setCustomId(`admin:ticket:option-roles-set:${panelId}:${optionId}`)
        .setPlaceholder("Escolha os cargos responsáveis")
        .setMinValues(0)
        .setMaxValues(20);
      return i.update({
        embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle("Equipe responsável").setDescription("Selecione os cargos que terão acesso aos tickets desta opção. Sem cargos próprios, a opção utiliza a equipe geral configurada no servidor.")],
        components: [
          new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select),
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            this.views.button(gid, `admin:ticket:option-roles-clear:${panelId}:${optionId}`, "Usar equipe geral", "minus", ButtonStyle.Secondary),
            this.views.button(gid, `admin:ticket:options:${panelId}`, "Voltar", "back")
          )
        ]
      });
    }
    if (id.startsWith("admin:ticket:option-toggle:")) {
      const [, , , panelId, optionId, field] = id.split(":");
      const option = this.tickets.getPanel(panelId!).options.find((item) => item.id === optionId);
      if (!option) throw new Error("Opção não encontrada.");
      if (field === "active") this.tickets.updateOption(panelId!, optionId!, { active: !option.active }, i.user.id);
      else if (field === "subject") this.tickets.updateOption(panelId!, optionId!, { askSubject: !option.askSubject }, i.user.id);
      else if (field === "mention") this.tickets.updateOption(panelId!, optionId!, { mentionSupport: !option.mentionSupport }, i.user.id);
      else throw new Error("Configuração de opção inválida.");
      return i.update(this.ticketOptionDetail(gid, panelId!, optionId!) as never);
    }
    if (id.startsWith("admin:ticket:option-move:")) {
      const [, , , panelId, optionId, direction] = id.split(":");
      this.tickets.moveOption(panelId!, optionId!, direction === "up" ? "UP" : "DOWN", i.user.id);
      return i.update(this.ticketOptionDetail(gid, panelId!, optionId!) as never);
    }
    if (id.startsWith("admin:ticket:basic:")) {
      const panel = this.tickets.getPanel(id.split(":")[3]!);
      return i.showModal(modal(`modal:ticket:basic:${panel.id}`, "Mensagem do painel", [
        input("title", "Título", panel.title, TextInputStyle.Short, true, 256),
        input("description", "Descrição", panel.description, TextInputStyle.Paragraph, true, 4000),
        input("color", "Cor hexadecimal", panel.color, TextInputStyle.Short, true, 7),
        input("footer", "Rodapé", panel.footer, TextInputStyle.Short, false, 200),
        input("label", panel.mode === "SELECT" ? "Texto do menu" : "Texto padrão dos botões", panel.buttonLabel, TextInputStyle.Short, true, 100)
      ]));
    }
    if (id.startsWith("admin:ticket:option:add:")) {
      const panelId = id.split(":")[4]!;
      return i.showModal(modal(`modal:ticket:option-add:${panelId}`, "Adicionar opção", [
        input("name", "Nome da opção (ex: Suporte)", "Suporte", TextInputStyle.Short, true, 100),
        input("description", "Descrição no menu", "Falar com nossa equipe", TextInputStyle.Short, true, 100),
        input("prefix", "Prefixo do canal (ex: suporte)", "suporte", TextInputStyle.Short, true, 40)
      ]));
    }
    if (id.startsWith("admin:ticket:options:")) return i.update(this.ticketOptionsView(gid, this.tickets.getPanel(id.split(":")[3]!)) as never);
    if (id.startsWith("admin:ticket:publish:")) return i.update(this.views.channelPicker(gid, `admin:ticket:publish-channel:${id.split(":")[3]}`, "Selecione o canal do painel") as never);
    if (id.startsWith("admin:ticket:image-upload:")) {
      const panelId = id.split(":")[3]!;
      return this.collectImage(i, "imagem do painel de ticket", (url) => { this.tickets.updatePanel(panelId, { imageUrl: url }, i.user.id); });
    }
    if (id.startsWith("admin:ticket:thumb-upload:")) {
      const panelId = id.split(":")[3]!;
      return this.collectImage(i, "miniatura do painel de ticket", (url) => { this.tickets.updatePanel(panelId, { thumbnailUrl: url }, i.user.id); });
    }
    if (id.startsWith("admin:ticket:delete-request:")) {
      const panelId = id.split(":")[3]!;
      const panel = this.tickets.getPanel(panelId);
      return i.update({
        embeds: [new EmbedBuilder().setColor(0xef4444).setTitle("Excluir painel de tickets?").setDescription(`O painel **${panel.name}** e suas opções serão removidos da configuração. Mensagens já publicadas não serão apagadas automaticamente.`)],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.views.button(gid, `admin:ticket:delete:${panelId}`, "Confirmar exclusão", "trash", ButtonStyle.Danger),
          this.views.button(gid, `admin:ticket:${panelId}`, "Cancelar", "back", ButtonStyle.Secondary)
        )]
      });
    }
    if (id.startsWith("admin:ticket:option-delete-request:")) {
      const [, , , , panelId, optionId] = id.split(":");
      const option = this.tickets.getPanel(panelId!).options.find((item) => item.id === optionId);
      if (!option) throw new Error("Opção não encontrada.");
      return i.update({
        embeds: [new EmbedBuilder().setColor(0xef4444).setTitle("Excluir opção de atendimento?").setDescription(`A opção **${option.name}** será removida do painel. Tickets já abertos continuarão registrados no histórico.`)],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.views.button(gid, `admin:ticket:option-delete:${panelId}:${optionId}`, "Confirmar exclusão", "trash", ButtonStyle.Danger),
          this.views.button(gid, `admin:ticket:options:${panelId}`, "Cancelar", "back", ButtonStyle.Secondary)
        )]
      });
    }
    if (id.startsWith("admin:ticket:delete:")) { this.tickets.deletePanel(id.split(":")[3]!, i.user.id); return i.update(this.views.ticketPanelsHome(gid) as never); }
    if (id.startsWith("admin:ticket:option-delete:")) { const [, , , panelId, optionId] = id.split(":"); this.tickets.deleteOption(panelId!, optionId!, i.user.id); return i.update(this.ticketOptionsView(gid, this.tickets.getPanel(panelId!)) as never); }

    if (id === "admin:brand:edit") { const b = this.db.brand(gid); return i.showModal(modal("modal:brand:edit", "Identidade visual", [input("name", "Nome do bot/marca", b.name, TextInputStyle.Short, true, 80), input("color", "Cor principal", b.color, TextInputStyle.Short, true, 7), input("footer", "Rodapé", b.footer, TextInputStyle.Short, true, 200), input("logo", "URL do logo", b.logoUrl, TextInputStyle.Short, false, 500), input("banner", "URL do banner", b.bannerUrl, TextInputStyle.Short, false, 500)])); }
    if (id === "admin:store:edit") { const b = this.db.brand(gid); return i.showModal(modal("modal:store:edit", "Mensagem da loja", [input("title", "Título", b.storeTitle, TextInputStyle.Short, true, 256), input("description", "Descrição", b.storeDescription, TextInputStyle.Paragraph, true, 4000)])); }
    if (id === "admin:presence:edit") { const b = this.db.brand(gid); return i.showModal(modal("modal:presence:edit", "Presença do bot", [input("text", "Texto da atividade", b.presenceText, TextInputStyle.Short, true, 128), input("type", "Playing/Watching/Listening/Competing", b.presenceType, TextInputStyle.Short, true, 20), input("status", "online/idle/dnd/invisible", b.status, TextInputStyle.Short, true, 10)])); }
    if (id === "admin:bot:identity") return i.showModal(modal("modal:bot:identity", "Nome do bot", [input("username", "Novo nome do bot", this.client.user?.username ?? "166 Community", TextInputStyle.Short, true, 32)]));
    if (id === "admin:bot:avatar") return this.collectAvatar(i);
    if (id === "admin:brand:logo-upload") return this.collectImage(i, "logo do bot", (url) => { this.db.brand(gid).logoUrl = url; this.db.save(); });
    if (id === "admin:brand:banner-upload") return this.collectImage(i, "banner principal", (url) => { this.db.brand(gid).bannerUrl = url; this.db.save(); });

    if (id === "admin:message:create") return i.showModal(this.botMessageBasicModal());
    if (id.startsWith("admin:message:basic:")) {
      const template = this.botMessageTemplate(gid, id.split(":")[3]!);
      return i.showModal(this.botMessageBasicModal(template));
    }
    if (id.startsWith("admin:message:visual:")) {
      const template = this.botMessageTemplate(gid, id.split(":")[3]!);
      return i.showModal(modal(`modal:message:visual:${template.id}`, "Visual da mensagem", [
        input("banner", "URL do banner", template.bannerUrl, TextInputStyle.Short, false, 1000),
        input("thumbnail", "URL da miniatura", template.thumbnailUrl, TextInputStyle.Short, false, 1000),
        input("footer", "Rodapé", template.footer, TextInputStyle.Short, false, 1900)
      ]));
    }
    if (id.startsWith("admin:message:link-add:")) {
      const template = this.botMessageTemplate(gid, id.split(":")[3]!);
      if (template.links.length >= 5) throw new Error("A mensagem já possui o limite de 5 botões de link.");
      return i.showModal(modal(`modal:message:link-add:${template.id}`, "Adicionar botão de link", [
        input("label", "Texto do botão", "Abrir link", TextInputStyle.Short, true, 80),
        input("url", "URL do botão", "https://", TextInputStyle.Short, true, 1000),
        input("emoji", "Emoji, ID ou nome salvo", "link", TextInputStyle.Short, false, 120)
      ]));
    }
    if (id.startsWith("admin:message:links-clear:")) {
      const template = this.botMessageTemplate(gid, id.split(":")[3]!);
      template.links = [];
      template.updatedAt = nowIso();
      this.db.audit(i.user.id, "BOT_MESSAGE_LINKS_CLEAR", "message_template", template.id, { guildId: gid }, gid);
      this.db.save();
      return i.update(this.botMessageDetail(gid, template.id) as never);
    }
    if (id.startsWith("admin:message:publish:")) {
      const template = this.botMessageTemplate(gid, id.split(":")[3]!);
      return i.update({
        embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle(`Publicar • ${template.name}`).setDescription("Selecione o canal. Se este modelo já estiver publicado no canal escolhido, a mensagem existente será atualizada.")],
        components: [
          new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId(`admin:message:publish-channel:${template.id}`).setPlaceholder("Selecione o canal").setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1)),
          new ActionRowBuilder<ButtonBuilder>().addComponents(this.views.button(gid, `admin:message:${template.id}`, "Cancelar", "back"))
        ]
      } as never);
    }
    if (id.startsWith("admin:message:preview:")) {
      const template = this.botMessageTemplate(gid, id.split(":")[3]!);
      return i.reply({ ...this.views.botMessage(gid, template), flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral } as never);
    }
    if (id.startsWith("admin:message:delete:")) {
      const template = this.botMessageTemplate(gid, id.split(":")[3]!);
      delete this.db.state.messageTemplates[template.id];
      this.db.audit(i.user.id, "BOT_MESSAGE_DELETE", "message_template", template.id, { guildId: gid }, gid);
      this.db.save();
      return i.update(this.botMessagesView(gid) as never);
    }
    if (/^admin:message:[A-Za-z0-9_-]+$/.test(id)) return i.update(this.botMessageDetail(gid, id.split(":")[2]!) as never);

    if (id === "admin:automations:schedules") return i.update(this.channelSchedulesView(gid) as never);
    if (id === "admin:automations:schedule-add") return i.showModal(this.channelScheduleModal());
    if (id.startsWith("admin:automations:schedule-edit:")) {
      const schedule = this.db.automations(gid).channelSchedules.find((item) => item.id === id.split(":")[3]);
      if (!schedule) throw new Error("Horário automático não encontrado.");
      return i.showModal(this.channelScheduleModal(schedule.id, schedule));
    }
    if (id.startsWith("admin:automations:schedule-channels:")) {
      const scheduleId = id.split(":")[3]!;
      return i.update(this.channelScheduleChannelsView(gid, scheduleId) as never);
    }
    if (id.startsWith("admin:automations:schedule-toggle:")) {
      const scheduleId = id.split(":")[3]!;
      const schedule = this.db.automations(gid).channelSchedules.find((item) => item.id === scheduleId);
      if (!schedule) throw new Error("Horário automático não encontrado.");
      schedule.enabled = !schedule.enabled;
      schedule.updatedAt = nowIso();
      this.db.audit(i.user.id, "CHANNEL_SCHEDULE_TOGGLE", "channel_schedule", schedule.id, { guildId: gid, enabled: schedule.enabled }, gid);
      this.db.save();
      return i.update(this.channelScheduleDetail(gid, schedule.id) as never);
    }
    if (id.startsWith("admin:automations:schedule-delete:")) {
      const scheduleId = id.split(":")[3]!;
      const settings = this.db.automations(gid);
      const index = settings.channelSchedules.findIndex((item) => item.id === scheduleId);
      if (index < 0) throw new Error("Horário automático não encontrado.");
      settings.channelSchedules.splice(index, 1);
      this.db.audit(i.user.id, "CHANNEL_SCHEDULE_DELETE", "channel_schedule", scheduleId, { guildId: gid }, gid);
      this.db.save();
      return i.update(this.channelSchedulesView(gid) as never);
    }

    if (id.startsWith("admin:automations:toggle:")) {
      const key = id.split(":")[3]!;
      const settings = this.db.automations(gid);
      const map = { welcome: "welcomeEnabled", goodbye: "goodbyeEnabled", autorole: "autoRoleEnabled", responses: "autoResponsesEnabled" } as const;
      const field = map[key as keyof typeof map];
      if (!field) throw new Error("Automação inválida.");
      settings[field] = !settings[field];
      this.db.audit(i.user.id, "AUTOMATION_TOGGLE", "guild", gid, { field, enabled: settings[field] });
      this.db.save();
      return i.update(this.automationsView(gid) as never);
    }
    if (id === "admin:automations:welcome-message") {
      const settings = this.db.automations(gid);
      return i.showModal(modal("modal:automations:welcome-message", "Mensagem de boas-vindas", [input("message", "Mensagem", settings.welcomeMessage, TextInputStyle.Paragraph, true, 1800)]));
    }
    if (id === "admin:automations:goodbye-message") {
      const settings = this.db.automations(gid);
      return i.showModal(modal("modal:automations:goodbye-message", "Mensagem de saída", [input("message", "Mensagem", settings.goodbyeMessage, TextInputStyle.Paragraph, true, 1800)]));
    }
    if (id === "admin:automations:response-add") return i.showModal(modal("modal:automations:response-add", "Adicionar resposta automática", [
      input("trigger", "Texto que ativa a resposta", "", TextInputStyle.Short, true, 200),
      input("response", "Resposta do bot", "", TextInputStyle.Paragraph, true, 1800)
    ]));
    if (id.startsWith("admin:automations:response-edit:")) {
      const index = Number(id.split(":")[3]);
      const response = this.db.automations(gid).autoResponses[index];
      if (!response) throw new Error("Resposta automática não encontrada.");
      return i.showModal(modal(`modal:automations:response-edit:${index}`, "Editar resposta automática", [
        input("trigger", "Texto que ativa a resposta", response.trigger, TextInputStyle.Short, true, 200),
        input("response", "Resposta do bot", response.response, TextInputStyle.Paragraph, true, 1800)
      ]));
    }
    if (id.startsWith("admin:automations:response-exact:")) {
      const index = Number(id.split(":")[3]);
      const response = this.db.automations(gid).autoResponses[index];
      if (!response) throw new Error("Resposta automática não encontrada.");
      response.exact = !response.exact;
      this.db.audit(i.user.id, "AUTO_RESPONSE_MATCH_MODE", "guild", gid, { index, exact: response.exact });
      this.db.save();
      return i.update(this.automationResponseDetail(gid, index) as never);
    }
    if (id.startsWith("admin:automations:response-delete:")) {
      const index = Number(id.split(":")[3]);
      const settings = this.db.automations(gid);
      if (!settings.autoResponses[index]) throw new Error("Resposta automática não encontrada.");
      settings.autoResponses.splice(index, 1);
      this.db.audit(i.user.id, "AUTO_RESPONSE_DELETE", "guild", gid, { index });
      this.db.save();
      return i.update(this.automationsView(gid) as never);
    }
    if (id.startsWith("admin:protection:toggle:")) {
      const key = id.split(":")[3]!;
      const settings = this.db.protection(gid);
      const map = { links: "antiLink", spam: "antiSpam", invites: "blockInvites", deleted: "logDeletedMessages", edited: "logEditedMessages" } as const;
      const field = map[key as keyof typeof map];
      if (!field) throw new Error("Configuração de proteção inválida.");
      settings[field] = !settings[field];
      this.db.audit(i.user.id, "PROTECTION_TOGGLE", "guild", gid, { field, enabled: settings[field] });
      this.db.save();
      return i.update(this.protectionView(gid) as never);
    }
    if (id === "admin:protection:domains") {
      const settings = this.db.protection(gid);
      return i.showModal(modal("modal:protection:domains", "Domínios permitidos", [
        input("domains", "Um domínio por linha", settings.allowedDomains.join("\n"), TextInputStyle.Paragraph, false, 1800, "exemplo.com")
      ]));
    }
    if (id === "admin:protection:spam-limits") {
      const settings = this.db.protection(gid);
      return i.showModal(modal("modal:protection:spam-limits", "Limites do anti-spam", [
        input("messages", "Mensagens permitidas", String(settings.spamMessages), TextInputStyle.Short, true, 3),
        input("window", "Janela em segundos", String(settings.spamWindowSeconds), TextInputStyle.Short, true, 4),
        input("timeout", "Timeout em segundos", String(settings.spamTimeoutSeconds), TextInputStyle.Short, true, 6)
      ]));
    }

    if (id === "admin:coupon:create") return i.showModal(modal("modal:coupon:create", "Criar cupom", [
      input("code", "Código", "PROMO10", TextInputStyle.Short, true, 30),
      input("discount", "Tipo | desconto: PERCENT|10 ou FIXED|5,00", "PERCENT | 10", TextInputStyle.Short, true, 50),
      input("limits", "Mínimo R$ | usos totais | por usuário", "0 | 100 | 1", TextInputStyle.Short, true, 80),
      input("dates", "Início ISO | expiração ISO (opcionais)", " | ", TextInputStyle.Short, false, 120),
      input("scope", "IDs produtos | grupos (separados por vírgula)", " | ", TextInputStyle.Paragraph, false, 1000)
    ]));
    if (id.startsWith("admin:coupon:toggle:")) { const coupon = this.products.getCoupon(gid, id.split(":")[3]!); this.products.updateCoupon(gid, coupon.id, { active: !coupon.active }, i.user.id); return i.update(this.couponDetail(gid, coupon.id) as never); }
    if (id.startsWith("admin:coupon:edit-basic:")) { const coupon = this.products.getCoupon(gid, id.split(":")[3]!); return i.showModal(modal(`modal:coupon:edit-basic:${coupon.id}`, "Código e desconto", [input("code", "Código", coupon.code, TextInputStyle.Short, true, 30), input("discount", "Tipo | desconto", `${coupon.type} | ${coupon.type === "PERCENT" ? coupon.value : (coupon.value / 100).toFixed(2)}`, TextInputStyle.Short, true, 50), input("minimum", "Pedido mínimo em R$", (coupon.minOrderCents / 100).toFixed(2), TextInputStyle.Short, true, 20)])); }
    if (id.startsWith("admin:coupon:edit-rules:")) { const coupon = this.products.getCoupon(gid, id.split(":")[3]!); return i.showModal(modal(`modal:coupon:edit-rules:${coupon.id}`, "Limites e período", [input("max", "Máximo de usos (vazio = ilimitado)", coupon.maxUses === null ? "" : String(coupon.maxUses), TextInputStyle.Short, false, 10), input("per_user", "Limite por usuário (0 = ilimitado)", String(coupon.perUserLimit), TextInputStyle.Short, true, 10), input("start", "Início ISO (opcional)", coupon.startsAt ?? "", TextInputStyle.Short, false, 40), input("expires", "Expiração ISO (opcional)", coupon.expiresAt ?? "", TextInputStyle.Short, false, 40)])); }
    if (id.startsWith("admin:coupon:edit-scope:")) { const coupon = this.products.getCoupon(gid, id.split(":")[3]!); return i.showModal(modal(`modal:coupon:edit-scope:${coupon.id}`, "Escopo do cupom", [input("products", "IDs de produtos separados por vírgula", coupon.productIds.join(","), TextInputStyle.Paragraph, false, 1500), input("groups", "Grupos de produto separados por vírgula", coupon.productGroups.join(","), TextInputStyle.Paragraph, false, 500)])); }
    if (id.startsWith("admin:coupon:delete:")) { const coupon = this.products.getCoupon(gid, id.split(":")[3]!); return i.update({ embeds: [new EmbedBuilder().setColor(0xef4444).setTitle("Excluir cupom").setDescription(`Excluir permanentemente **${coupon.code}**? Os registros de usos aprovados serão mantidos no histórico.`)], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(this.views.button(gid, `admin:coupon:delete-confirm:${coupon.id}`, "Confirmar exclusão", "trash", ButtonStyle.Danger), this.views.button(gid, `admin:coupon:${coupon.id}`, "Cancelar", "back"))] }); }
    if (id.startsWith("admin:coupon:delete-confirm:")) { this.products.deleteCoupon(gid, id.split(":")[3]!, i.user.id); return i.update(this.couponsView(gid) as never); }
    if (id === "admin:backup:create") return i.showModal(modal("modal:backup:create", "Criar backup do servidor", [input("name", "Nome do backup", `Backup ${new Date().toLocaleString("pt-BR")}`, TextInputStyle.Short, true, 100)]));
    if (id.startsWith("admin:backup:rename:")) { const backup = this.backups.get(gid, id.split(":")[3]!); return i.showModal(modal(`modal:backup:rename:${backup.id}`, "Renomear backup", [input("name", "Novo nome", backup.name, TextInputStyle.Short, true, 100)])); }
    if (id.startsWith("admin:backup:delete:") && !id.startsWith("admin:backup:delete-confirm:")) { const backup = this.backups.get(gid, id.split(":")[3]!); return i.update({ embeds: [new EmbedBuilder().setColor(0xef4444).setTitle("Excluir backup").setDescription(`Excluir **${backup.name}** e seu arquivo? Esta ação não pode ser desfeita.`)], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(this.views.button(gid, `admin:backup:delete-confirm:${backup.id}`, "Excluir", "trash", ButtonStyle.Danger), this.views.button(gid, `admin:backup:${backup.id}`, "Cancelar", "back"))] }); }
    if (id.startsWith("admin:backup:delete-confirm:")) { const backupId = id.split(":")[3]!; this.backups.delete(gid, backupId, i.user.id); return i.update(this.backupsView(gid) as never); }
    if (id.startsWith("admin:backup:restore-plan:")) { const backupId = id.split(":")[3]!; const plan = this.backups.plan(gid, backupId, { settings: true, roles: true, channels: true, expressions: true, webhooks: true, messages: true }); return i.update({ embeds: [new EmbedBuilder().setColor(0xf59e0b).setTitle("Confirmar restauração").setDescription(`Backup: **${plan.backup.name}**

${plan.summary.map((line) => `• ${line}`).join("\n")}

Antes de restaurar, o bot criará automaticamente um backup de segurança do estado atual. Mensagens serão republicadas como cópias do bot, nunca como usuários originais.`)], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(this.views.button(gid, `admin:backup:restore-confirm:${backupId}:full`, "Completa", "restore", ButtonStyle.Danger), this.views.button(gid, `admin:backup:restore-confirm:${backupId}:structure`, "Somente estrutura", "settings", ButtonStyle.Primary), this.views.button(gid, `admin:backup:restore-confirm:${backupId}:messages`, "Somente mensagens", "message", ButtonStyle.Secondary), this.views.button(gid, `admin:backup:${backupId}`, "Cancelar", "back"))] }); }
    if (id.startsWith("admin:backup:restore-confirm:")) { const [, , , backupId, mode] = id.split(":"); if (!i.guild) throw new Error("Servidor indisponível."); await i.deferUpdate(); const options = mode === "full" ? { settings: true, roles: true, channels: true, expressions: true, webhooks: true, messages: true } : mode === "messages" ? { settings: false, roles: false, channels: false, expressions: false, webhooks: false, messages: true } : { settings: true, roles: true, channels: true, expressions: true, webhooks: true, messages: false }; const result = await this.backups.restore(i.guild, backupId!, i.user.id, options); await i.editReply({ embeds: [new EmbedBuilder().setColor(0x22c55e).setTitle("Restauração concluída").setDescription(Object.entries(result.changed).map(([key, value]) => `• ${key}: **${value}**`).join("\n") + `

Avisos: **${result.warnings.length}**`)], components: [] }); return; }
    if (id === "admin:giveaway:create") return i.showModal(modal("modal:giveaway:create", "Criar sorteio", [input("channel", "ID do canal", "", TextInputStyle.Short, true, 24), input("prize", "Prêmio", "", TextInputStyle.Short, true, 200), input("duration", "Duração: 30m, 2h, 1d", "1h", TextInputStyle.Short, true, 20), input("winners", "Quantidade de vencedores", "1", TextInputStyle.Short, true, 2)]));

    if (id.startsWith("admin:order:approve:")) { const oid = id.split(":")[3]!; await i.deferReply({ flags: MessageFlags.Ephemeral }); await this.orders.approveManual(oid, i.user.id); await i.editReply(`Pedido ${oid} aprovado e processado.`); return; }
    if (id.startsWith("admin:order:complete:")) { const oid = id.split(":")[3]!; await i.deferReply({ flags: MessageFlags.Ephemeral }); await this.orders.completeManualDelivery(oid, i.user.id); await i.editReply(`Entrega manual do pedido ${oid} concluída.`); return; }
    if (id.startsWith("admin:order:cancel:")) { const oid = id.split(":")[3]!; this.orders.cancel(oid, i.user.id); return i.update(this.ordersAdminView(gid) as never); }
    if (id.startsWith("admin:order:")) return i.update(this.orderAdminDetail(gid, id.split(":")[2]!) as never);

    if (id === "admin:channel:sales") return i.update(this.views.channelPicker(gid, "admin:channel-set:sales", "Canal de vendas") as never);
    if (id === "admin:channel:logs") return i.update(this.views.channelPicker(gid, "admin:channel-set:logs", "Canal de logs") as never);
    if (id === "admin:channel:welcome") return i.update(this.views.channelPicker(gid, "admin:channel-set:welcome", "Canal de boas-vindas") as never);
    if (id === "admin:channel:goodbye") return i.update(this.views.channelPicker(gid, "admin:channel-set:goodbye", "Canal de saídas") as never);
    if (id === "admin:channel:ticket-logs") return i.update(this.views.channelPicker(gid, "admin:channel-set:ticket-logs", "Canal de logs de tickets") as never);
    if (id === "admin:category:open") return i.update(this.views.channelPicker(gid, "admin:category-set:open", "Categoria de tickets abertos", true) as never);
    if (id === "admin:category:closed") return i.update(this.views.channelPicker(gid, "admin:category-set:closed", "Categoria de tickets fechados", true) as never);
    if (id === "admin:category:archive") return i.update(this.views.channelPicker(gid, "admin:category-set:archive", "Categoria de tickets arquivados", true) as never);
    if (id === "admin:category:purchases") return i.update(this.views.channelPicker(gid, "admin:category-set:purchases", "Categoria das compras privadas", true) as never);
    if (id === "admin:role:staff") return i.update(this.views.rolePicker(gid, "admin:role-set:staff", "Cargos da equipe", 10) as never);
    if (id === "admin:role:admin") return i.update(this.views.rolePicker(gid, "admin:role-set:admin", "Cargos administradores do painel", 10) as never);
    if (id === "admin:role:customer") return i.update(this.views.rolePicker(gid, "admin:role-set:customer", "Cargo de cliente") as never);
    if (id === "admin:role:auto") return i.update(this.views.rolePicker(gid, "admin:role-set:auto", "Cargo automático") as never);
  }

  private async select(i: StringSelectMenuInteraction) {
    const gid = i.guildId; if (!gid) throw new Error("Fora de servidor."); const id = i.customId;
    if (id.startsWith("store:")) return i.reply({ content: "Este painel antigo de loja foi desativado. Use um painel individual de produto publicado pela equipe.", flags: MessageFlags.Ephemeral });
    if (id.startsWith("admin:")) this.requireAdminAction(i, id);
    if (id === "admin:navigate") {
      const target = i.values[0]!;
      const targetScopes: Record<string, import("../types.js").PermissionScope> = {
        products: "PRODUCTS", store: "PRODUCTS", coupons: "PRODUCTS",
        orders: "PAYMENTS", payments: "PAYMENTS", revenue: "PAYMENTS",
        tickets: "TICKETS", stock_requests: "TICKETS", messages: "ADMIN_COMMANDS",
        backups: "BACKUPS", giveaways: "ADMIN_COMMANDS", saved_emojis: "AUTHORIZED"
      };
      this.requireScope(i, targetScopes[target] ?? "ADMIN");
      const views: Record<string, () => Record<string, unknown>> = {
        products: () => this.views.productsHome(gid) as unknown as Record<string, unknown>,
        orders: () => this.ordersAdminView(gid) as unknown as Record<string, unknown>,
        payments: () => this.views.paymentsHome(gid) as unknown as Record<string, unknown>,
        tickets: () => this.views.ticketPanelsHome(gid) as unknown as Record<string, unknown>,
        messages: () => this.botMessagesView(gid) as unknown as Record<string, unknown>,
        stock_requests: () => this.views.stockRequestsHome(gid) as unknown as Record<string, unknown>,
        saved_emojis: () => this.views.savedEmojisHome(gid) as unknown as Record<string, unknown>,
        revenue: () => this.revenueView(gid) as unknown as Record<string, unknown>,
        personalize: () => this.personalizeView(gid) as unknown as Record<string, unknown>,
        emojis: () => this.views.emojisHome(gid) as unknown as Record<string, unknown>,
        automations: () => this.automationsView(gid) as unknown as Record<string, unknown>,
        protection: () => this.protectionView(gid) as unknown as Record<string, unknown>,
        giveaways: () => this.giveawaysView(gid) as unknown as Record<string, unknown>,
        channels: () => this.views.channelSettings(gid) as unknown as Record<string, unknown>,
        coupons: () => this.couponsView(gid) as unknown as Record<string, unknown>,
        permissions: () => this.permissionsView(gid) as unknown as Record<string, unknown>,
        backups: () => this.backupsView(gid) as unknown as Record<string, unknown>,
        store: () => this.views.productsHome(gid) as unknown as Record<string, unknown>
      };
      const render = views[target];
      if (!render) throw new Error("Área do painel inválida.");
      return i.update(render() as never);
    }
    if (id.startsWith("ticket:purchase-select:")) {
      const ticketId = id.split(":")[2]!;
      await this.tickets.resolvePurchaseGate(ticketId, i.user.id, i.values[0]!);
      return i.reply({ content: "✅ Compra vinculada. O atendimento está liberado.", flags: MessageFlags.Ephemeral });
    }
    if (id === "cart:item-manage") {
      this.assertCartOwner(gid, i.user.id, i.channelId ?? undefined);
      const [productId, fieldId] = i.values[0]!.split("|");
      const product = this.products.get(productId!, gid);
      return i.update(this.views.cartItemManage(gid, i.user.id, product, this.products.getField(product.id, fieldId)) as never);
    }
    if (id.startsWith("product:field-select:")) {
      const product = this.products.get(id.split(":")[2]!, gid);
      const field = this.products.getField(product.id, i.values[0]!);
      return this.beginDirectPurchase(i, product, field.id);
    }
    if (id.startsWith("admin:product:delivery-type-select:")) {
      const productId = id.split(":")[3]!;
      const value = i.values[0] as DeliveryType;
      if (!["STOCK", "MANUAL", "ROLE"].includes(value)) throw new Error("Tipo de entrega inválido.");
      const product = this.products.update(productId, { deliveryType: value }, i.user.id);
      return i.update(this.productDeliveryView(gid, product) as never);
    }
    if (id.startsWith("admin:product:select:")) return i.update(this.views.productDetail(gid, this.products.get(i.values[0]!, gid)) as never);
    if (id.startsWith("admin:product:field-select:")) {
      const product = this.products.get(id.split(":")[3]!, gid);
      const field = this.products.getField(product.id, i.values[0]!);
      return i.update(this.views.productFieldDetail(gid, product, field) as never);
    }
    if (id.startsWith("admin:product:field-emoji-select:")) {
      const productId = id.split(":")[3]!;
      const fieldId = id.split(":")[4]!;
      const field = this.products.updateField(productId, fieldId, { emoji: i.values[0]! }, i.user.id);
      return i.update(this.views.productFieldDetail(gid, this.products.get(productId, gid), field) as never);
    }
    if (id.startsWith("admin:product:emoji-select:")) {
      const productId = id.split(":")[3]!;
      const product = this.products.update(productId, { emojiSemantic: i.values[0]! }, i.user.id);
      return i.update(this.views.productDetail(gid, product) as never);
    }
    if (id.startsWith("admin:ticket:emoji-select:")) {
      const panelId = id.split(":")[3]!;
      const panel = this.tickets.updatePanel(panelId, { emojiSemantic: i.values[0]! }, i.user.id);
      return i.update(this.views.ticketPanelDetail(gid, panel) as never);
    }
    if (id.startsWith("admin:ticket:option-emoji-select:")) {
      const panelId = id.split(":")[3]!;
      const optionId = id.split(":")[4]!;
      this.tickets.updateOption(panelId, optionId, { emojiSemantic: i.values[0]! }, i.user.id);
      return i.update(this.ticketOptionDetail(gid, panelId, optionId) as never);
    }
    if (id.startsWith("admin:emoji:function-select:")) return i.update(this.emojiFunctionDetail(gid, i.values[0]!) as never);
    if (id.startsWith("admin:emoji:asset-select:")) {
      const functional = id.split(":")[3]!;
      this.db.updateGuild(gid, (guild) => { guild.emojiOverrides[functional] = `${i.values[0]}:solid`; });
      return i.update(this.emojiFunctionDetail(gid, functional) as never);
    }
    if (id.startsWith("admin:emoji:catalog-select:")) return i.update(this.emojiCatalogDetail(gid, i.values[0]!, Number(id.split(":")[3] ?? 0)) as never);
    if (id === "admin:automations:response-select") {
      const index = Number(i.values[0]);
      return i.update(this.automationResponseDetail(gid, index) as never);
    }
    if (id === "admin:automations:schedule-select") return i.update(this.channelScheduleDetail(gid, i.values[0]!) as never);
    if (id === "admin:message:select") return i.update(this.botMessageDetail(gid, i.values[0]!) as never);
    if (id === "admin:payment:provider-select") { const provider = i.values[0] as PaymentProviderName; if (!this.payments.enabled(gid, provider)) throw new Error("Configure e ative esse provedor antes de torná-lo padrão."); this.db.payments(gid).defaultProvider = provider; this.db.save(); return i.update(this.views.paymentsHome(gid) as never); }
    if (id === "admin:payment:test-api-select") {
      const provider = i.values[0] as PaymentProviderName;
      if (!this.payments.enabled(gid, provider)) throw new Error("Este gateway não está ativo ou está incompleto.");
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await this.payments.test(gid, provider);
      await i.editReply(`✅ **${provider.replaceAll("_", " ")}**: ${result}`);
      return;
    }
    if (id === "admin:payment:imap-bank-select") {
      const bank = i.values[0] as ImapBank;
      if (!["INTER", "PICPAY", "NUBANK"].includes(bank)) throw new Error("Banco inválido.");
      const settings = this.db.payments(gid).imapPix;
      settings.bank = bank;
      this.db.save();
      return i.update(this.views.imapSettingsHome(gid) as never);
    }
    if (id === "admin:payment:imap-email-provider-select") {
      const provider = i.values[0] as ImapEmailProvider;
      if (!["GMAIL", "OUTLOOK", "YAHOO", "CUSTOM"].includes(provider)) throw new Error("Provedor de e-mail inválido.");
      const settings = this.db.payments(gid).imapPix;
      settings.emailProvider = provider;
      const preset = applyEmailPreset(provider);
      if (preset) Object.assign(settings, preset);
      this.db.save();
      return i.update(this.views.imapSettingsHome(gid) as never);
    }
    if (id === "admin:payment:imap-pix-key-type-select") {
      const keyType = i.values[0] as "random" | "cpf" | "cnpj" | "email" | "phone";
      if (!["random", "cpf", "cnpj", "email", "phone"].includes(keyType)) throw new Error("Tipo de chave PIX inválido.");
      this.db.payments(gid).imapPix.pixKeyType = keyType;
      this.db.save();
      return i.update(this.views.imapSettingsHome(gid) as never);
    }
    if (id === "admin:payment:test-select") { await i.deferReply({ flags: MessageFlags.Ephemeral }); const result = await this.imap.testConnection(gid); await i.editReply(`✅ ${result}`); return; }
    if (id === "admin:ticket:select") return i.update(this.views.ticketPanelDetail(gid, this.tickets.getPanel(i.values[0]!)) as never);
    if (id === "admin:stock-request:select") {
      const request = this.db.state.stockRequests[i.values[0]!];
      if (!request || request.guildId !== gid) throw new Error("Solicitação não encontrada.");
      return i.update(this.views.stockRequestDetail(gid, request, true) as never);
    }
    if (id.startsWith("admin:saved-emoji:select:")) {
      const item = this.emojis.findSaved(i.values[0]!);
      if (!item || item.guildId !== gid) throw new Error("Emoji salvo não encontrado.");
      return i.update(this.views.savedEmojiDetail(gid, item) as never);
    }
    if (id.startsWith("admin:ticket:field-select:")) {
      const panel = this.tickets.getPanel(id.split(":")[3]!);
      const field = panel.fields.find((item) => item.id === i.values[0]);
      if (!field) throw new Error("Campo do painel não encontrado.");
      return i.update(this.views.ticketPanelFieldDetail(gid, panel, field) as never);
    }
    if (id.startsWith("admin:ticket:option-select:")) { const panelId = id.split(":")[3]!; const option = this.tickets.getPanel(panelId).options.find((o) => o.id === i.values[0]); if (!option) throw new Error("Opção não encontrada."); return i.update(this.ticketOptionDetail(gid, panelId, option.id) as never); }
    if (id === "admin:coupon:select") return i.update(this.couponDetail(gid, i.values[0]!) as never);
    if (id === "admin:backup:select") return i.update(this.backupDetail(gid, i.values[0]!) as never);
    if (id === "admin:order:select") return i.update(this.orderAdminDetail(gid, i.values[0]!) as never);
    if (id.startsWith("store:select:")) return this.storeRespond(i, this.views.publicProduct(gid, this.products.get(i.values[0]!, gid)) as never);
    if (id === "store:cart-quantity") {
      const [productId, fieldId] = i.values[0]!.split("|");
      const product = this.products.get(productId!, gid);
      const current = this.products.cart(i.user.id).find((item) => item.productId === product.id && item.fieldId === fieldId)?.quantity ?? product.minQuantity;
      return i.showModal(modal(`modal:cart-quantity:${product.id}:${fieldId}`, "Alterar quantidade", [input("quantity", `Quantidade (${product.minQuantity} a ${product.maxQuantity})`, String(current), TextInputStyle.Short, true, 3)]));
    }
    if (id === "store:cart-remove") {
      const [productId, fieldId] = i.values[0]!.split("|");
      this.products.removeFromCart(i.user.id, productId!, fieldId);
      return this.storeRespond(i, this.views.cart(gid, i.user.id) as never);
    }
    if (id.startsWith("ticket:open-select:")) { const panelId = id.split(":")[2]!; return this.showTicketSubject(i, panelId, i.values[0]!); }
  }

  private async channelSelect(i: ChannelSelectMenuInteraction) {
    const gid = i.guildId; if (!gid) throw new Error("Fora de servidor."); const id = i.customId; this.requireAdminAction(i, id); const channelId = i.values[0]!;
    if (id === "admin:restock:channel-set") {
      const channel = await this.client.channels.fetch(channelId);
      if (!(channel instanceof TextChannel)) throw new Error("Selecione um canal de texto válido.");
      this.db.guild(gid).restockAnnouncements.channelId = channelId;
      this.db.audit(i.user.id, "RESTOCK_CHANNEL_SET", "guild", gid, { channelId }, gid);
      this.db.save();
      return i.update(this.views.restockSettings(gid) as never);
    }
    if (id === "admin:setupticket:channel-select") {
      const panels = this.tickets.listPanels(gid);
      const latestPanel = panels[panels.length - 1];
      if (!latestPanel) throw new Error("Nenhum painel encontrado. Crie um painel primeiro.");
      const channel = await this.client.channels.fetch(channelId);
      if (!(channel instanceof TextChannel)) throw new Error("Selecione um canal de texto válido.");
      const publicPayload = this.views.publicTicketPanel(gid, latestPanel);
      const message = await channel.send({ ...publicPayload, flags: MessageFlags.IsComponentsV2 } as never);
      latestPanel.channelId = channelId;
      latestPanel.messageId = message.id;
      this.db.audit(i.user.id, "SETUP_TICKET_PUBLISH", "ticket_panel", latestPanel.id, { channelId, messageId: message.id }, gid);
      this.db.save();
      return i.update({
        embeds: [new EmbedBuilder().setColor(0x22c55e).setTitle("Painel publicado!").setDescription(`Painel **${latestPanel.name}** publicado em <#${channelId}>.\n\nAgora adicione opções de atendimento usando o painel de tickets.`)],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.views.button(gid, `admin:ticket:${latestPanel.id}`, "Gerenciar painel", "ticket", ButtonStyle.Success),
          this.views.button(gid, "admin:tickets", "Ir para tickets", "back", ButtonStyle.Primary)
        )]
      } as never);
    }
    if (id.startsWith("admin:ticket:option-category-set:")) {
      const [, , , , panelId, optionId] = id.split(":");
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.type !== ChannelType.GuildCategory) throw new Error("Selecione uma categoria válida.");
      this.tickets.updateOption(panelId!, optionId!, { categoryId: channelId }, i.user.id);
      return i.update(this.ticketOptionDetail(gid, panelId!, optionId!) as never);
    }
    if (id.startsWith("admin:automations:schedule-channels-set:")) {
      const scheduleId = id.split(":")[3]!;
      const schedule = this.db.automations(gid).channelSchedules.find((item) => item.id === scheduleId);
      if (!schedule) throw new Error("Horário automático não encontrado.");
      schedule.channelIds = [...new Set(i.values)].slice(0, 25);
      schedule.updatedAt = nowIso();
      this.db.audit(i.user.id, "CHANNEL_SCHEDULE_CHANNELS", "channel_schedule", schedule.id, { guildId: gid, channelIds: schedule.channelIds }, gid);
      this.db.save();
      return i.update(this.channelScheduleDetail(gid, schedule.id) as never);
    }
    if (id.startsWith("admin:message:publish-channel:")) {
      const template = this.botMessageTemplate(gid, id.split(":")[3]!);
      const channel = await this.client.channels.fetch(channelId);
      if (!(channel instanceof TextChannel)) throw new Error("Selecione um canal de texto válido.");
      const publication = template.publications.find((item) => item.channelId === channel.id);
      let message = publication ? await channel.messages.fetch(publication.messageId).catch(() => undefined) : undefined;
      if (message) await message.edit(this.views.botMessageEdit(gid, template) as never);
      else {
        message = await channel.send(this.views.botMessage(gid, template));
        template.publications = template.publications.filter((item) => item.channelId !== channel.id);
        template.publications.push({ channelId: channel.id, messageId: message.id, publishedAt: nowIso() });
      }
      template.updatedAt = nowIso();
      this.db.audit(i.user.id, "BOT_MESSAGE_PUBLISH", "message_template", template.id, { guildId: gid, channelId: channel.id, messageId: message.id }, gid);
      this.db.save();
      await i.update(this.botMessageDetail(gid, template.id) as never);
      await i.followUp({ content: `✅ Mensagem publicada ou atualizada em <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (id.startsWith("admin:product:publish-channel:")) { const product = this.products.get(id.split(":")[3]!, gid); const channel = await this.client.channels.fetch(channelId); if (!(channel instanceof TextChannel)) throw new Error("Canal inválido."); const message = await channel.send(this.views.publishedProduct(gid, product)); this.products.addPublication(product.id, gid, channelId, message.id); await i.update(this.views.productDetail(gid, product) as never); await i.followUp({ content: `Painel individual de **${product.name}** publicado em <#${channelId}> e vinculado às atualizações automáticas.`, flags: MessageFlags.Ephemeral }); return; }
    if (id.startsWith("admin:ticket:publish-channel:")) {
      const panel = this.tickets.getPanel(id.split(":")[3]!);
      const activeOptions = panel.options.filter((option) => option.active);
      if (!activeOptions.length) throw new Error("Adicione e ative ao menos uma opção antes de publicar o painel.");
      for (const option of activeOptions) {
        const validated = await this.emojis.validateUserInput(option.emojiSemantic, gid, true);
        if (validated !== option.emojiSemantic) this.tickets.updateOption(panel.id, option.id, { emojiSemantic: validated }, i.user.id);
      }
      const channel = await this.client.channels.fetch(channelId);
      if (!(channel instanceof TextChannel)) throw new Error("Canal inválido.");
      let message;
      if (panel.channelId === channelId && panel.messageId) {
        const current = await channel.messages.fetch(panel.messageId).catch(() => undefined);
        message = current ? await current.edit(this.views.publicTicketPanelEdit(gid, panel)) : await channel.send(this.views.publicTicketPanel(gid, panel));
      } else {
        if (panel.channelId && panel.messageId) {
          const oldChannel = await this.client.channels.fetch(panel.channelId).catch(() => undefined);
          if (oldChannel instanceof TextChannel) {
            const oldMessage = await oldChannel.messages.fetch(panel.messageId).catch(() => undefined);
            await oldMessage?.delete().catch(() => undefined);
          }
        }
        message = await channel.send(this.views.publicTicketPanel(gid, panel));
      }
      const updated = this.tickets.updatePanel(panel.id, { channelId, messageId: message.id }, i.user.id);
      await i.update(this.views.ticketPanelDetail(gid, updated) as never);
      await i.followUp({ content: `Painel publicado ou atualizado em <#${channelId}>.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (id === "admin:stock-request:destination-set") {
      this.db.guild(gid).stockRequest.requestChannelId = channelId;
      this.db.audit(i.user.id, "STOCK_REQUEST_CHANNEL_SET", "guild", gid, { channelId });
      this.db.save();
      return i.update(this.views.stockRequestsHome(gid) as never);
    }
    if (id === "admin:stock-request:publish-channel") {
      const channel = await this.client.channels.fetch(channelId);
      if (!(channel instanceof TextChannel)) throw new Error("Canal inválido.");
      const settings = this.db.guild(gid).stockRequest;
      let message;
      if (settings.panelMessageId && settings.panelChannelId === channelId) {
        const existing = await channel.messages.fetch(settings.panelMessageId).catch(() => undefined);
        message = existing ? await existing.edit(this.views.publicStockRequestPanel(gid)) : await channel.send(this.views.publicStockRequestPanel(gid));
      } else {
        message = await channel.send(this.views.publicStockRequestPanel(gid));
      }
      settings.panelChannelId = channelId;
      settings.panelMessageId = message.id;
      this.db.audit(i.user.id, "STOCK_REQUEST_PANEL_PUBLISH", "message", message.id, { channelId, guildId: gid });
      this.db.save();
      await i.update(this.views.stockRequestsHome(gid) as never);
      await i.followUp({ content: `Painel **Pedir Stock** publicado em <#${channelId}> e vinculado às atualizações automáticas.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (id === "admin:locks-ignored-set") { this.db.updateGuild(gid, (guild) => { guild.locks.ignoredChannelIds = [...i.values]; }); return i.update(this.permissionsView(gid) as never); }
    const map: Record<string, keyof ReturnType<JsonDatabase["guild"]>> = { "admin:channel-set:sales": "salesChannelId", "admin:channel-set:logs": "logChannelId", "admin:channel-set:ticket-logs": "ticketLogChannelId", "admin:channel-set:welcome": "welcomeChannelId", "admin:channel-set:goodbye": "goodbyeChannelId", "admin:category-set:open": "ticketCategoryId", "admin:category-set:closed": "closedTicketCategoryId", "admin:category-set:archive": "archiveTicketCategoryId", "admin:category-set:purchases": "purchaseCategoryId" };
    const key = map[id]; if (key) { this.db.updateGuild(gid, (g) => { (g as unknown as Record<string, unknown>)[key] = channelId; }); return i.update(this.views.channelSettings(gid) as never); }
  }

  private async roleSelect(i: RoleSelectMenuInteraction) {
    const gid = i.guildId; if (!gid) throw new Error("Fora de servidor."); this.requireAdmin(i);
    if (i.customId === "admin:restock:role-set") {
      this.db.guild(gid).restockAnnouncements.mentionRoleId = i.values[0] ?? "";
      this.db.save();
      return i.update(this.views.restockSettings(gid) as never);
    }
    if (i.customId.startsWith("admin:product:delivery-role-set:")) {
      const productId = i.customId.split(":")[3]!;
      const product = this.products.update(productId, { roleId: i.values[0] ?? "" }, i.user.id);
      return i.update(this.productDeliveryView(gid, product) as never);
    }
    if (i.customId.startsWith("admin:ticket:option-roles-set:")) {
      const [, , , , panelId, optionId] = i.customId.split(":");
      this.tickets.updateOption(panelId!, optionId!, { supportRoleIds: [...i.values] }, i.user.id);
      return i.update(this.ticketOptionDetail(gid, panelId!, optionId!) as never);
    }
    if (i.customId === "admin:role-set:staff") { this.db.updateGuild(gid, (g) => { g.staffRoleIds = [...i.values]; }); return i.update(this.views.channelSettings(gid) as never); }
    if (i.customId === "admin:role-set:admin") { this.db.updateGuild(gid, (g) => { g.adminRoleIds = [...i.values]; }); return i.update(this.views.channelSettings(gid) as never); }
    if (i.customId === "admin:role-set:customer") { this.db.updateGuild(gid, (g) => { g.customerRoleId = i.values[0]!; }); return i.update(this.views.channelSettings(gid) as never); }
    if (i.customId === "admin:role-set:auto") { this.db.updateGuild(gid, (g) => { g.autoRoleId = i.values[0]!; }); return i.update(this.views.channelSettings(gid) as never); }
    if (i.customId.startsWith("admin:permissions-role-set:")) {
      const key = i.customId.split(":")[2]!;
      const map: Record<string, keyof import("../types.js").GuildPermissions> = { admins: "adminRoleIds", authorized: "authorizedRoleIds", support: "supportRoleIds", tickets: "ticketRoleIds", payments: "paymentRoleIds", products: "productRoleIds", commands: "adminCommandRoleIds" };
      const field = map[key]; if (!field) throw new Error("Grupo de permissão inválido.");
      this.permissions.updateRoles(gid, field as never, [...i.values]);
      if (field === "adminRoleIds") this.db.updateGuild(gid, (guild) => { guild.adminRoleIds = [...i.values]; });
      if (field === "supportRoleIds") this.db.updateGuild(gid, (guild) => { guild.staffRoleIds = [...new Set([...guild.staffRoleIds, ...i.values])]; });
      return i.update(this.permissionsView(gid) as never);
    }
    if (i.customId === "admin:locks-speaking-set") { this.db.updateGuild(gid, (guild) => { guild.locks.speakingRoleIds = [...i.values]; }); return i.update(this.permissionsView(gid) as never); }
    if (i.customId === "admin:stock-request:roles-set") {
      this.db.guild(gid).stockRequest.notifyRoleIds = [...i.values];
      this.db.audit(i.user.id, "STOCK_REQUEST_ROLES_SET", "guild", gid, { roleIds: [...i.values] });
      this.db.save();
      return i.update(this.views.stockRequestsHome(gid) as never);
    }
  }

  private async userSelect(i: UserSelectMenuInteraction) {
    const gid = i.guildId; if (!gid) throw new Error("Fora de servidor."); this.requireAdmin(i);
    if (i.customId === "admin:permissions-user-set:admins") this.permissions.updateUsers(gid, "adminUserIds", [...i.values]);
    else if (i.customId === "admin:permissions-user-set:authorized") this.permissions.updateUsers(gid, "authorizedUserIds", [...i.values]);
    else throw new Error("Seletor de usuários inválido.");
    return i.update(this.permissionsView(gid) as never);
  }

  private async modal(i: ModalSubmitInteraction) {
    const gid = i.guildId; if (!gid) throw new Error("Fora de servidor."); const id = i.customId;
    if (id.startsWith("modal:") && !id.startsWith("modal:ticket:open") && !id.startsWith("modal:cart-") && !id.startsWith("modal:cart:") && id !== "modal:stock-request:create") this.requireScope(i, this.adminScopeFor(id));
    if (id.startsWith("modal:product:create:")) {
      const priceCents = parseMoney(i.fields.getTextInputValue("price"));
      const deliveryType: DeliveryType = id.split(":")[3] === "STOCK" ? "STOCK" : "MANUAL";
      const automatic = deliveryType === "STOCK";
      const product = this.products.create({
        guildId: gid,
        name: i.fields.getTextInputValue("name"),
        priceCents,
        description: i.fields.getTextInputValue("description"),
        emojiSemantic: automatic ? "delivery" : "products",
        deliveryType,
        buttonEmoji: "cart",
        imageUrl: i.fields.getTextInputValue("image").trim(),
        bannerUrl: i.fields.getTextInputValue("banner").trim(),
        color: normalizeColor(i.fields.getTextInputValue("color")) || this.db.brand(gid).color,
        deliveryMessage: automatic ? "Entrega automática após a confirmação do pagamento." : "A equipe realizará a entrega manualmente neste canal.",
        fields: [{
          name: i.fields.getTextInputValue("field_name").trim() || "Opção principal",
          description: automatic ? "Entrega automática" : "Entrega manual",
          priceCents,
          compareAtCents: 0,
          emoji: "cart",
          active: true,
          stockMode: "UNIQUE"
        }]
      }, i.user.id);
      return i.reply({ ...this.views.productDetail(gid, product), flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("modal:product:basic:")) {
      const productId = id.split(":")[3]!;
      const product = this.products.update(productId, {
        name: i.fields.getTextInputValue("name"),
        description: i.fields.getTextInputValue("description")
      }, i.user.id);
      return i.reply({ ...this.views.productDetail(gid, product), flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("modal:product:visual:")) {
      const productId = id.split(":")[3]!;
      const product = this.products.update(productId, {
        imageUrl: i.fields.getTextInputValue("image").trim(),
        bannerUrl: i.fields.getTextInputValue("banner").trim(),
        color: normalizeColor(i.fields.getTextInputValue("color"))
      }, i.user.id);
      return i.reply({ ...this.views.productDetail(gid, product), flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("modal:product:purchase:")) {
      const productId = id.split(":")[3]!;
      const product = this.products.update(productId, {
        buttonLabel: i.fields.getTextInputValue("label").trim() || "Comprar agora",
        buttonEmoji: "cart",
        buttonStyle: styleName(i.fields.getTextInputValue("style")),
        selectPlaceholder: i.fields.getTextInputValue("placeholder").trim() || "Selecione uma opção para continuar..."
      }, i.user.id);
      return i.reply({ ...this.views.productDetail(gid, product), flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("modal:product:demo:")) {
      const productId = id.split(":")[3]!;
      const url = i.fields.getTextInputValue("url").trim();
      if (url && !/^https?:\/\//i.test(url)) throw new Error("O link da demonstração precisa começar com http:// ou https://.");
      const product = this.products.update(productId, {
        demonstrationEnabled: Boolean(url),
        demonstrationUrl: url,
        demonstrationLabel: i.fields.getTextInputValue("label").trim() || "Demonstração",
        demonstrationEmoji: i.fields.getTextInputValue("emoji").trim() || "information"
      }, i.user.id);
      return i.reply({ ...this.views.productDetail(gid, product), flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("modal:product:delivery-message:")) {
      const productId = id.split(":")[3]!;
      const product = this.products.update(productId, { deliveryMessage: i.fields.getTextInputValue("message") }, i.user.id);
      return i.reply({ ...this.productDeliveryView(gid, product), flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("modal:product:delivery-limits:")) {
      const productId = id.split(":")[3]!;
      const product = this.products.update(productId, {
        minQuantity: Number(i.fields.getTextInputValue("minimum")),
        maxQuantity: Number(i.fields.getTextInputValue("maximum")),
        perUserLimit: Number(i.fields.getTextInputValue("per_user")),
        couponGroup: i.fields.getTextInputValue("coupon_group").trim()
      }, i.user.id);
      return i.reply({ ...this.productDeliveryView(gid, product), flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("modal:product:terms-text:")) {
      const productId = id.split(":")[3]!;
      const product = this.products.update(productId, { termsText: i.fields.getTextInputValue("terms") }, i.user.id);
      return i.reply({ ...this.productDeliveryView(gid, product), flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("modal:product:field-add:")) {
      const productId = id.split(":")[3]!;
      const field = this.products.addField(productId, {
        name: i.fields.getTextInputValue("name"),
        description: i.fields.getTextInputValue("description"),
        priceCents: parseMoney(i.fields.getTextInputValue("price")),
        compareAtCents: i.fields.getTextInputValue("compare").trim() ? parseMoney(i.fields.getTextInputValue("compare")) : 0,
        emoji: i.fields.getTextInputValue("emoji").trim() || "cart",
        active: true,
        stockMode: "UNIQUE"
      }, i.user.id);
      return i.reply({ ...this.views.productFieldDetail(gid, this.products.get(productId, gid), field), flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("modal:product:field-edit:")) {
      const [, , , productId, fieldId] = id.split(":");
      const field = this.products.updateField(productId!, fieldId!, {
        name: i.fields.getTextInputValue("name"),
        description: i.fields.getTextInputValue("description"),
        priceCents: parseMoney(i.fields.getTextInputValue("price")),
        compareAtCents: i.fields.getTextInputValue("compare").trim() ? parseMoney(i.fields.getTextInputValue("compare")) : 0,
        emoji: i.fields.getTextInputValue("emoji").trim() || "cart"
      }, i.user.id);
      return i.reply({ ...this.views.productFieldDetail(gid, this.products.get(productId!, gid), field), flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("modal:stock:add:")) {
      const [, , , productId, fieldId] = id.split(":");
      const rawItems = i.fields.getTextInputValue("items");
      const added = this.products.addStock(productId!, rawItems, i.user.id, fieldId!);
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await this.restocks.announce({ guildId: gid, productId: productId!, fieldId: fieldId!, actorId: i.user.id, addedQuantity: added });
      return i.editReply({ content: `✅ ${added} unidade(s) nova(s) adicionada(s). Conteúdos duplicados foram ignorados.` });
    }
    if (id.startsWith("modal:stock:ghost:")) {
      const [, , , productId, fieldId] = id.split(":");
      const quantity = Number(i.fields.getTextInputValue("quantity").trim());
      if (!Number.isFinite(quantity) || quantity < 1) throw new Error("Informe uma quantidade virtual válida.");
      const previous = this.products.stockCount(productId!, "AVAILABLE", fieldId!);
      const field = this.products.setGhostStock(productId!, fieldId!, i.fields.getTextInputValue("content"), quantity, i.user.id);
      const added = Math.max(0, this.products.stockCount(productId!, "AVAILABLE", fieldId!) - previous);
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await this.restocks.announce({ guildId: gid, productId: productId!, fieldId: fieldId!, actorId: i.user.id, addedQuantity: added });
      return i.editReply(this.views.stockView(gid, this.products.get(productId!, gid), field) as never);
    }

    if (id === "modal:restock:edit") {
      const settings = this.db.guild(gid).restockAnnouncements;
      settings.title = i.fields.getTextInputValue("title").trim() || "Estoque atualizado";
      settings.message = i.fields.getTextInputValue("message").trim() || "Novas unidades disponíveis.";
      this.db.save();
      return i.reply({ ...this.views.restockSettings(gid), flags: MessageFlags.Ephemeral });
    }

    if (id === "modal:stock-request:edit") {
      const settings = this.db.guild(gid).stockRequest;
      Object.assign(settings, {
        title: i.fields.getTextInputValue("title").trim(),
        description: i.fields.getTextInputValue("description").trim(),
        footer: i.fields.getTextInputValue("footer").trim(),
        buttonLabel: i.fields.getTextInputValue("button").trim(),
        confirmationMessage: i.fields.getTextInputValue("confirmation").trim()
      });
      this.db.audit(i.user.id, "STOCK_REQUEST_MESSAGE_UPDATE", "guild", gid);
      this.db.save();
      this.schedulePublishedRefresh();
      return i.reply({ ...this.views.stockRequestsHome(gid), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:stock-request:appearance") {
      const settings = this.db.guild(gid).stockRequest;
      Object.assign(settings, {
        color: normalizeColor(i.fields.getTextInputValue("color")),
        emojiSemantic: i.fields.getTextInputValue("emoji").trim() || "stock_request",
        buttonStyle: styleName(i.fields.getTextInputValue("style")),
        imageUrl: i.fields.getTextInputValue("image").trim(),
        thumbnailUrl: i.fields.getTextInputValue("thumbnail").trim()
      });
      this.db.audit(i.user.id, "STOCK_REQUEST_APPEARANCE_UPDATE", "guild", gid);
      this.db.save();
      this.schedulePublishedRefresh();
      return i.reply({ ...this.views.stockRequestsHome(gid), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:stock-request:create") {
      const settings = this.db.guild(gid).stockRequest;
      if (!settings.enabled) throw new Error("Os pedidos de stock estão desativados.");
      if (!settings.requestChannelId) throw new Error("O administrador ainda não configurou o canal que receberá os pedidos de stock.");
      const channel = await this.client.channels.fetch(settings.requestChannelId);
      if (!(channel instanceof TextChannel)) throw new Error("O canal de pedidos de stock não está disponível.");
      const quantity = Math.max(1, Math.min(9999, Number(i.fields.getTextInputValue("quantity")) || 1));
      const now = nowIso();
      const request: StockRequest = {
        id: makeId("STK"),
        guildId: gid,
        userId: i.user.id,
        username: i.user.username,
        productName: i.fields.getTextInputValue("product").trim(),
        quantity,
        details: i.fields.getTextInputValue("details").trim(),
        status: "PENDING",
        claimedBy: "",
        channelId: channel.id,
        messageId: "",
        createdAt: now,
        updatedAt: now
      };
      this.db.state.stockRequests[request.id] = request;
      this.db.audit(i.user.id, "STOCK_REQUEST_CREATE", "stock_request", request.id, { productName: request.productName, quantity });
      this.db.save();
      const mentions = settings.notifyRoleIds.map((roleId) => `<@&${roleId}>`).join(" ");
      const message = await channel.send({ content: mentions || undefined, ...this.views.stockRequestDetail(gid, request) });
      request.messageId = message.id;
      request.updatedAt = nowIso();
      this.db.save();
      await i.reply({ content: `${this.emojis.text("stock_request_send", gid)} ${settings.confirmationMessage}\n\n**Protocolo:** \`${request.id}\``, flags: MessageFlags.Ephemeral });
      return;
    }

    if (id === "modal:saved-emoji:prepare") {
      const name = i.fields.getTextInputValue("name").trim();
      await this.collectSavedEmoji(i, name, true);
      return;
    }
    if (id === "modal:saved-emoji:limit") {
      const settings = this.db.guild(gid).emojiLibrary;
      settings.maxPerUser = Math.max(1, Math.min(500, Number(i.fields.getTextInputValue("limit")) || 25));
      this.db.audit(i.user.id, "EMOJI_LIBRARY_LIMIT", "guild", gid, { maxPerUser: settings.maxPerUser });
      this.db.save();
      return i.reply({ ...this.views.savedEmojisHome(gid), flags: MessageFlags.Ephemeral });
    }

    if (id === "modal:payment:mp") {
      const token = i.fields.getTextInputValue("token").trim();
      if (token) this.db.setSecret("mp_access_token", token, gid);
      Object.assign(this.db.payments(gid).mercadoPago, {
        pixKey: i.fields.getTextInputValue("pix").trim(),
        payerEmail: i.fields.getTextInputValue("email").trim(),
        statementDescriptor: i.fields.getTextInputValue("descriptor").trim()
      });
      this.db.save();
      return i.reply({ ...this.views.paymentsHome(gid), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:payment:efi") {
      const clientId = i.fields.getTextInputValue("client").trim();
      const secret = i.fields.getTextInputValue("secret").trim();
      if (clientId) this.db.setSecret("efi_client_id", clientId, gid);
      if (secret) this.db.setSecret("efi_client_secret", secret, gid);
      Object.assign(this.db.payments(gid).efiBank, {
        pixKey: i.fields.getTextInputValue("pix").trim(),
        merchantName: i.fields.getTextInputValue("merchant").trim() || "166 Community",
        merchantCity: i.fields.getTextInputValue("city").trim() || "SAO PAULO"
      });
      this.db.save();
      return i.reply({ embeds: [new EmbedBuilder().setColor(0x22c55e).setTitle("Efí salva").setDescription("Credenciais salvas. Ative o método pelo botão do painel e envie o certificado P12/PFX para concluir.")], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(this.views.button(gid, "admin:payment:efi-cert", "Enviar certificado P12/PFX", "upload", ButtonStyle.Primary), this.views.button(gid, "admin:payments", "Voltar", "back"))], flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:payment:stripe") {
      const key = i.fields.getTextInputValue("key").trim();
      if (key) this.db.setSecret("stripe_secret_key", key, gid);
      const settings = this.db.payments(gid).stripe;
      settings.statementDescriptor = i.fields.getTextInputValue("descriptor").trim() || "166COMMUNITY";
      settings.webhookUrl = i.fields.getTextInputValue("webhook").trim();
      this.db.save();
      return i.reply({ ...this.views.paymentsHome(gid), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:payment:mistic") {
      const clientId = i.fields.getTextInputValue("client").trim();
      const clientSecret = i.fields.getTextInputValue("secret").trim();
      if (clientId) this.db.setSecret("mistic_client_id", clientId, gid);
      if (clientSecret) this.db.setSecret("mistic_client_secret", clientSecret, gid);
      this.db.payments(gid).misticPay.webhookUrl = i.fields.getTextInputValue("webhook").trim();
      this.db.save();
      return i.reply({ ...this.views.paymentsHome(gid), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:payment:purin") {
      const apiKey = i.fields.getTextInputValue("key").trim();
      if (apiKey) this.db.setSecret("purin_api_key", apiKey, gid);
      this.db.payments(gid).purinCash.callbackUrl = i.fields.getTextInputValue("callback").trim();
      this.db.save();
      return i.reply({ ...this.views.paymentsHome(gid), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:payment:imap-account") {
      const settings = this.db.payments(gid).imapPix;
      const email = i.fields.getTextInputValue("user").trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Informe um e-mail válido para o IMAP e para a chave PIX.");
      settings.username = email;
      settings.pixKey = email;
      settings.pixKeyType = "email";
      const password = i.fields.getTextInputValue("password").trim();
      if (password) this.db.setSecret("imap_password", password, gid);
      this.db.save();
      this.imap.start();
      return i.reply({ ...this.views.imapSettingsHome(gid), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:payment:imap-pix") {
      const settings = this.db.payments(gid).imapPix;
      Object.assign(settings, {
        pixKey: i.fields.getTextInputValue("key").trim(),
        merchantName: i.fields.getTextInputValue("merchant").trim() || "166 Community",
        merchantCity: i.fields.getTextInputValue("city").trim() || "SAO PAULO"
      });
      this.db.save();
      return i.reply({ ...this.views.imapSettingsHome(gid), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:payment:imap-timing") {
      const settings = this.db.payments(gid).imapPix;
      settings.pollIntervalSeconds = Math.max(20, Math.min(3600, Number(i.fields.getTextInputValue("poll")) || 30));
      settings.lookbackMinutes = Math.max(5, Math.min(10080, Number(i.fields.getTextInputValue("lookback")) || 90));
      settings.maxWaitMinutes = Math.max(5, Math.min(1440, Number(i.fields.getTextInputValue("maxwait")) || 15));
      settings.mailbox = i.fields.getTextInputValue("mailbox").trim() || "INBOX";
      this.db.save();
      this.imap.start();
      return i.reply({ ...this.views.imapSettingsHome(gid), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:payment:imap-custom-server") {
      const settings = this.db.payments(gid).imapPix;
      settings.emailProvider = "CUSTOM";
      settings.host = i.fields.getTextInputValue("host").trim();
      settings.port = Math.max(1, Math.min(65535, Number(i.fields.getTextInputValue("port")) || 993));
      settings.secure = true;
      this.db.save();
      return i.reply({ ...this.views.imapSettingsHome(gid), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:payment:manual") {
      const settings = this.db.payments(gid);
      const email = i.fields.getTextInputValue("key").trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Informe um e-mail válido como chave PIX manual.");
      settings.manualPixKey = email;
      settings.manualPixCode = "";
      this.db.save();
      return i.reply({ ...this.views.paymentsHome(gid), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:payment:general") {
      this.db.payments(gid).orderExpiresMinutes = Math.max(5, Math.min(1440, Number(i.fields.getTextInputValue("expiration")) || 15));
      this.db.payments(gid).pollIntervalSeconds = Math.max(10, Math.min(3600, Number(i.fields.getTextInputValue("poll")) || 15));
      this.db.save(); this.orders.startPolling();
      return i.reply({ ...this.views.paymentsHome(gid), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:payment:efi-certpass") {
      this.db.setSecret("efi_certificate_password", i.fields.getTextInputValue("password").trim(), gid);
      return i.reply({ content: "Senha do certificado salva no arquivo privado de credenciais do projeto.", flags: MessageFlags.Ephemeral });
    }

    if (id.startsWith("modal:ticket:field-add:")) {
      const panelId = id.split(":")[3]!;
      this.tickets.addPanelField(panelId, {
        name: i.fields.getTextInputValue("name"),
        value: i.fields.getTextInputValue("value"),
        inline: false
      }, i.user.id);
      return i.reply({ ...this.views.ticketPanelFieldsView(gid, this.tickets.getPanel(panelId)), flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("modal:ticket:field-edit:")) {
      const [, , , panelId, fieldId] = id.split(":");
      const panel = this.tickets.getPanel(panelId!);
      const current = panel.fields.find((item) => item.id === fieldId);
      if (!current) throw new Error("Campo do painel não encontrado.");
      this.tickets.updatePanelField(panelId!, fieldId!, {
        name: i.fields.getTextInputValue("name"),
        value: i.fields.getTextInputValue("value"),
        inline: current.inline
      }, i.user.id);
      return i.reply({ ...this.views.ticketPanelFieldsView(gid, this.tickets.getPanel(panelId!)), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:ticket:create") {
      const panel = this.tickets.createPanel({
        guildId: gid,
        name: i.fields.getTextInputValue("name"),
        title: i.fields.getTextInputValue("title"),
        description: i.fields.getTextInputValue("description"),
        color: normalizeColor(i.fields.getTextInputValue("color")),
        mode: "SELECT"
      }, i.user.id);
      return i.reply({ ...this.views.ticketPanelDetail(gid, panel), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:setupticket:step1") {
      const panel = this.tickets.createPanel({
        guildId: gid,
        name: i.fields.getTextInputValue("name"),
        title: i.fields.getTextInputValue("title"),
        description: i.fields.getTextInputValue("description"),
        color: normalizeColor(i.fields.getTextInputValue("color")),
        footer: i.fields.getTextInputValue("footer").trim() || "166 Community • Atendimento",
        mode: "SELECT"
      }, i.user.id);
      return i.reply({
        embeds: [new EmbedBuilder()
          .setColor(colorNumber(this.db.brand(gid).color))
          .setTitle(`${this.emojis.text("ticket", gid)} Passo 2: Banner do Painel`)
          .setDescription(`Painel **${panel.name}** criado!\n\nDeseja adicionar um banner (imagem) ao painel?`)],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.views.button(gid, "admin:setupticket:step2-image", "Enviar banner", "image", ButtonStyle.Primary),
          this.views.button(gid, "admin:setupticket:step2-skip", "Pular", "skip", ButtonStyle.Secondary)
        )],
        flags: MessageFlags.Ephemeral
      });
    }
    if (id.startsWith("modal:ticket:basic:")) {
      const panelId = id.split(":")[3]!;
      const panel = this.tickets.updatePanel(panelId, {
        title: i.fields.getTextInputValue("title"),
        description: i.fields.getTextInputValue("description"),
        color: normalizeColor(i.fields.getTextInputValue("color")),
        footer: i.fields.getTextInputValue("footer").trim(),
        buttonLabel: i.fields.getTextInputValue("label").trim() || "Selecione o atendimento"
      }, i.user.id);
      return i.reply({ ...this.views.ticketPanelDetail(gid, panel), flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("modal:ticket:option-add:")) {
      const panelId = id.split(":")[3]!;
      const option = this.tickets.addOption(panelId, {
        name: i.fields.getTextInputValue("name"),
        description: i.fields.getTextInputValue("description"),
        emojiSemantic: "support",
        channelPrefix: i.fields.getTextInputValue("prefix"),
        openingTitle: i.fields.getTextInputValue("name"),
        openingDescription: "Como podemos ajudar? Descreva seu problema ou dúvida.",
        active: true,
        askSubject: false,
        mentionSupport: true,
        maxOpenTicketsPerUser: 3
      }, i.user.id);
      return i.reply({ ...this.ticketOptionDetail(gid, panelId, option.id), flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("modal:ticket:option-edit:")) {
      const [, , , panelId, optionId] = id.split(":");
      this.tickets.updateOption(panelId!, optionId!, {
        name: i.fields.getTextInputValue("name"),
        description: i.fields.getTextInputValue("description"),
        channelPrefix: i.fields.getTextInputValue("prefix"),
        openingTitle: i.fields.getTextInputValue("opening_title"),
        openingDescription: i.fields.getTextInputValue("opening_description")
      }, i.user.id);
      return i.reply({ ...this.ticketOptionDetail(gid, panelId!, optionId!), flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("modal:ticket:option-close-message:")) {
      const [, , , panelId, optionId] = id.split(":");
      this.tickets.updateOption(panelId!, optionId!, { closeMessage: i.fields.getTextInputValue("close") }, i.user.id);
      return i.reply({ ...this.ticketOptionDetail(gid, panelId!, optionId!), flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("modal:ticket:option-limit:")) {
      const [, , , panelId, optionId] = id.split(":");
      this.tickets.updateOption(panelId!, optionId!, { maxOpenTicketsPerUser: Number(i.fields.getTextInputValue("limit")) }, i.user.id);
      return i.reply({ ...this.ticketOptionDetail(gid, panelId!, optionId!), flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("modal:ticket:option-emoji-manual:")) {
      const [, , , panelId, optionId] = id.split(":");
      const emoji = await this.emojis.validateUserInput(i.fields.getTextInputValue("emoji"), gid, false);
      this.tickets.updateOption(panelId!, optionId!, { emojiSemantic: emoji }, i.user.id);
      return i.reply({ ...this.ticketOptionDetail(gid, panelId!, optionId!), flags: MessageFlags.Ephemeral });
    }

    if (id === "modal:brand:edit") { Object.assign(this.db.brand(gid), { name: i.fields.getTextInputValue("name").trim(), color: normalizeColor(i.fields.getTextInputValue("color")), footer: i.fields.getTextInputValue("footer").trim(), logoUrl: i.fields.getTextInputValue("logo").trim(), bannerUrl: i.fields.getTextInputValue("banner").trim() }); this.db.save(); return i.reply({ ...this.personalizeView(gid), flags: MessageFlags.Ephemeral }); }
    if (id === "modal:store:edit") { this.db.brand(gid).storeTitle = i.fields.getTextInputValue("title"); this.db.brand(gid).storeDescription = i.fields.getTextInputValue("description"); this.db.save(); return i.reply({ ...this.personalizeView(gid), flags: MessageFlags.Ephemeral }); }
    if (id === "modal:presence:edit") { const b = this.db.brand(gid); b.presenceText = i.fields.getTextInputValue("text"); const type = i.fields.getTextInputValue("type").trim(); b.presenceType = (["Playing", "Watching", "Listening", "Competing"].includes(type) ? type : "Watching") as never; const status = i.fields.getTextInputValue("status").trim(); b.status = (["online", "idle", "dnd", "invisible"].includes(status) ? status : "online") as never; this.db.save(); this.applyPresence(gid); return i.reply({ ...this.personalizeView(gid), flags: MessageFlags.Ephemeral }); }
    if (id === "modal:bot:identity") { await this.client.user?.setUsername(i.fields.getTextInputValue("username").trim()); return i.reply({ content: "Nome do bot atualizado. O Discord limita mudanças frequentes.", flags: MessageFlags.Ephemeral }); }
    if (id === "modal:automations:welcome-message" || id === "modal:automations:goodbye-message") {
      const settings = this.db.automations(gid);
      if (id.endsWith("welcome-message")) settings.welcomeMessage = i.fields.getTextInputValue("message").trim();
      else settings.goodbyeMessage = i.fields.getTextInputValue("message").trim();
      this.db.audit(i.user.id, "AUTOMATION_MESSAGE_UPDATE", "guild", gid, { type: id.endsWith("welcome-message") ? "welcome" : "goodbye" });
      this.db.save();
      return i.reply({ ...this.automationsView(gid), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:automations:response-add" || id.startsWith("modal:automations:response-edit:")) {
      const settings = this.db.automations(gid);
      const trigger = i.fields.getTextInputValue("trigger").trim();
      const responseText = i.fields.getTextInputValue("response").trim();
      if (!trigger || !responseText) throw new Error("Informe o gatilho e a resposta.");
      const duplicateIndex = settings.autoResponses.findIndex((entry) => entry.trigger.toLowerCase() === trigger.toLowerCase());
      if (id === "modal:automations:response-add") {
        if (duplicateIndex >= 0) throw new Error("Já existe uma resposta automática com esse gatilho.");
        settings.autoResponses.push({ trigger, response: responseText, exact: false });
        settings.autoResponsesEnabled = true;
        this.db.audit(i.user.id, "AUTO_RESPONSE_CREATE", "guild", gid, { trigger });
      } else {
        const index = Number(id.split(":")[3]);
        const current = settings.autoResponses[index];
        if (!current) throw new Error("Resposta automática não encontrada.");
        if (duplicateIndex >= 0 && duplicateIndex !== index) throw new Error("Já existe outra resposta automática com esse gatilho.");
        current.trigger = trigger;
        current.response = responseText;
        this.db.audit(i.user.id, "AUTO_RESPONSE_UPDATE", "guild", gid, { index, trigger });
      }
      this.db.save();
      return i.reply({ ...this.automationsView(gid), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:automations:schedule-add" || id.startsWith("modal:automations:schedule-edit:")) {
      const settings = this.db.automations(gid);
      const name = i.fields.getTextInputValue("name").trim() || "Horário de canais";
      const lockTime = i.fields.getTextInputValue("lock_time").trim();
      const unlockTime = i.fields.getTextInputValue("unlock_time").trim();
      const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
      if (!timePattern.test(lockTime) || !timePattern.test(unlockTime)) throw new Error("Use horários no formato HH:mm, por exemplo 22:00 e 08:00.");
      if (lockTime === unlockTime) throw new Error("Os horários de fechar e abrir precisam ser diferentes.");
      const patch = {
        name: name.slice(0, 80),
        lockTime,
        unlockTime,
        lockMessage: i.fields.getTextInputValue("lock_message").trim().slice(0, 1800),
        unlockMessage: i.fields.getTextInputValue("unlock_message").trim().slice(0, 1800),
        updatedAt: nowIso()
      };
      if (id === "modal:automations:schedule-add") {
        if (settings.channelSchedules.length >= 25) throw new Error("O limite de 25 horários automáticos foi atingido.");
        const schedule = {
          id: makeId("SCH"),
          enabled: true,
          channelIds: [],
          timezone: "America/Sao_Paulo",
          lastLockDate: "",
          lastUnlockDate: "",
          createdAt: nowIso(),
          ...patch
        };
        settings.channelSchedules.push(schedule);
        this.db.audit(i.user.id, "CHANNEL_SCHEDULE_CREATE", "channel_schedule", schedule.id, { guildId: gid, lockTime, unlockTime }, gid);
        this.db.save();
        return i.reply({ ...this.channelScheduleChannelsView(gid, schedule.id), flags: MessageFlags.Ephemeral });
      }
      const scheduleId = id.split(":")[3]!;
      const schedule = settings.channelSchedules.find((item) => item.id === scheduleId);
      if (!schedule) throw new Error("Horário automático não encontrado.");
      Object.assign(schedule, patch);
      this.db.audit(i.user.id, "CHANNEL_SCHEDULE_UPDATE", "channel_schedule", schedule.id, { guildId: gid, lockTime, unlockTime }, gid);
      this.db.save();
      return i.reply({ ...this.channelScheduleDetail(gid, schedule.id), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:message:create" || id.startsWith("modal:message:basic:")) {
      const data = {
        name: i.fields.getTextInputValue("name").trim().slice(0, 80) || "Mensagem",
        content: i.fields.getTextInputValue("content").trim().slice(0, 2000),
        title: i.fields.getTextInputValue("title").trim().slice(0, 300),
        description: i.fields.getTextInputValue("description").trim().slice(0, 4000),
        color: normalizeColor(i.fields.getTextInputValue("color"))
      };
      if (!data.content && !data.title && !data.description) throw new Error("Informe conteúdo, título ou descrição para a mensagem.");
      if (id === "modal:message:create") {
        const template: BotMessageTemplate = {
          id: makeId("MSG"), guildId: gid, ...data, bannerUrl: "", thumbnailUrl: "", footer: this.db.brand(gid).footer,
          links: [], publications: [], createdAt: nowIso(), updatedAt: nowIso()
        };
        this.db.state.messageTemplates[template.id] = template;
        this.db.audit(i.user.id, "BOT_MESSAGE_CREATE", "message_template", template.id, { guildId: gid, name: template.name }, gid);
        this.db.save();
        return i.reply({ ...this.botMessageDetail(gid, template.id), flags: MessageFlags.Ephemeral });
      }
      const template = this.botMessageTemplate(gid, id.split(":")[3]!);
      Object.assign(template, data, { updatedAt: nowIso() });
      this.db.audit(i.user.id, "BOT_MESSAGE_UPDATE", "message_template", template.id, { guildId: gid }, gid);
      this.db.save();
      return i.reply({ ...this.botMessageDetail(gid, template.id), flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("modal:message:visual:")) {
      const template = this.botMessageTemplate(gid, id.split(":")[3]!);
      const bannerUrl = i.fields.getTextInputValue("banner").trim();
      const thumbnailUrl = i.fields.getTextInputValue("thumbnail").trim();
      if (bannerUrl && !/^https?:\/\//i.test(bannerUrl)) throw new Error("A URL do banner precisa começar com http:// ou https://.");
      if (thumbnailUrl && !/^https?:\/\//i.test(thumbnailUrl)) throw new Error("A URL da miniatura precisa começar com http:// ou https://.");
      Object.assign(template, { bannerUrl, thumbnailUrl, footer: i.fields.getTextInputValue("footer").trim().slice(0, 1900), updatedAt: nowIso() });
      this.db.audit(i.user.id, "BOT_MESSAGE_VISUAL", "message_template", template.id, { guildId: gid }, gid);
      this.db.save();
      return i.reply({ ...this.botMessageDetail(gid, template.id), flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("modal:message:link-add:")) {
      const template = this.botMessageTemplate(gid, id.split(":")[3]!);
      if (template.links.length >= 5) throw new Error("A mensagem já possui o limite de 5 botões de link.");
      const url = i.fields.getTextInputValue("url").trim();
      if (!/^https?:\/\//i.test(url)) throw new Error("A URL do botão precisa começar com http:// ou https://.");
      const emojiInput = i.fields.getTextInputValue("emoji").trim();
      const emoji = emojiInput ? await this.emojis.validateUserInput(emojiInput, gid, true) : "";
      template.links.push({ id: makeId("LNK"), label: i.fields.getTextInputValue("label").trim().slice(0, 80) || "Abrir link", url, emoji });
      template.updatedAt = nowIso();
      this.db.audit(i.user.id, "BOT_MESSAGE_LINK_ADD", "message_template", template.id, { guildId: gid, url }, gid);
      this.db.save();
      return i.reply({ ...this.botMessageDetail(gid, template.id), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:protection:domains") {
      const settings = this.db.protection(gid);
      settings.allowedDomains = [...new Set(i.fields.getTextInputValue("domains").split(/[\n,]/).map((value) => value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean))].slice(0, 100);
      this.db.audit(i.user.id, "PROTECTION_DOMAINS_UPDATE", "guild", gid, { count: settings.allowedDomains.length });
      this.db.save();
      return i.reply({ ...this.protectionView(gid), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:protection:spam-limits") {
      const settings = this.db.protection(gid);
      settings.spamMessages = Math.max(3, Math.min(50, Math.trunc(Number(i.fields.getTextInputValue("messages"))) || 6));
      settings.spamWindowSeconds = Math.max(3, Math.min(300, Math.trunc(Number(i.fields.getTextInputValue("window"))) || 8));
      settings.spamTimeoutSeconds = Math.max(10, Math.min(86_400, Math.trunc(Number(i.fields.getTextInputValue("timeout"))) || 60));
      this.db.audit(i.user.id, "PROTECTION_SPAM_LIMITS", "guild", gid, { messages: settings.spamMessages, windowSeconds: settings.spamWindowSeconds, timeoutSeconds: settings.spamTimeoutSeconds });
      this.db.save();
      return i.reply({ ...this.protectionView(gid), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:coupon:create") {
      const [typeRaw, valueRaw] = i.fields.getTextInputValue("discount").split("|").map((value) => value.trim());
      const [minimumRaw, maxRaw, perUserRaw] = i.fields.getTextInputValue("limits").split("|").map((value) => value.trim());
      const [startsRaw, expiresRaw] = i.fields.getTextInputValue("dates").split("|").map((value) => value.trim());
      const [productsRaw, groupsRaw] = i.fields.getTextInputValue("scope").split("|").map((value) => value.trim());
      const type = typeRaw?.toUpperCase() === "FIXED" ? "FIXED" : "PERCENT";
      const value = type === "PERCENT" ? Number(valueRaw) : parseMoney(valueRaw || "0");
      if (!Number.isFinite(value) || value <= 0 || (type === "PERCENT" && value > 100)) throw new Error("Informe um desconto válido. Percentual deve ficar entre 0 e 100.");
      const startsAt = startsRaw ? new Date(startsRaw).toISOString() : null;
      const expiresAt = expiresRaw ? new Date(expiresRaw).toISOString() : null;
      if (startsAt && expiresAt && Date.parse(expiresAt) <= Date.parse(startsAt)) throw new Error("A expiração precisa ser posterior ao início.");
      const productIds = (productsRaw || "").split(",").map((value) => value.trim()).filter(Boolean);
      for (const productId of productIds) this.products.get(productId, gid);
      this.products.createCoupon({
        guildId: gid, code: i.fields.getTextInputValue("code"), type, value,
        minOrderCents: minimumRaw ? parseMoney(minimumRaw) : 0,
        maxUses: maxRaw ? Math.max(1, Math.trunc(Number(maxRaw))) : null,
        perUserLimit: Math.max(0, Math.trunc(Number(perUserRaw || 0))), active: true,
        startsAt, expiresAt, productIds,
        productGroups: (groupsRaw || "").split(",").map((item) => item.trim()).filter(Boolean).slice(0, 100)
      }, i.user.id);
      return i.reply({ ...this.couponsView(gid), flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("modal:coupon:edit-basic:")) {
      const couponId = id.split(":")[3]!;
      const [typeRaw, valueRaw] = i.fields.getTextInputValue("discount").split("|").map((value) => value.trim());
      const type = typeRaw?.toUpperCase() === "FIXED" ? "FIXED" : "PERCENT";
      const value = type === "PERCENT" ? Number(valueRaw) : parseMoney(valueRaw || "0");
      if (!Number.isFinite(value) || value <= 0 || (type === "PERCENT" && value > 100)) throw new Error("Desconto inválido.");
      this.products.updateCoupon(gid, couponId, { code: i.fields.getTextInputValue("code"), type, value, minOrderCents: parseMoney(i.fields.getTextInputValue("minimum") || "0") }, i.user.id);
      return i.reply({ ...this.couponDetail(gid, couponId), flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("modal:coupon:edit-rules:")) {
      const couponId = id.split(":")[3]!;
      const start = i.fields.getTextInputValue("start").trim(); const expires = i.fields.getTextInputValue("expires").trim();
      const startsAt = start ? new Date(start).toISOString() : null; const expiresAt = expires ? new Date(expires).toISOString() : null;
      if (startsAt && expiresAt && Date.parse(expiresAt) <= Date.parse(startsAt)) throw new Error("A expiração precisa ser posterior ao início.");
      const maxRaw = i.fields.getTextInputValue("max").trim();
      this.products.updateCoupon(gid, couponId, { maxUses: maxRaw ? Math.max(1, Math.trunc(Number(maxRaw))) : null, perUserLimit: Math.max(0, Math.trunc(Number(i.fields.getTextInputValue("per_user") || 0))), startsAt, expiresAt }, i.user.id);
      return i.reply({ ...this.couponDetail(gid, couponId), flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("modal:coupon:edit-scope:")) {
      const couponId = id.split(":")[3]!;
      const productIds = i.fields.getTextInputValue("products").split(",").map((value) => value.trim()).filter(Boolean);
      for (const productId of productIds) this.products.get(productId, gid);
      this.products.updateCoupon(gid, couponId, { productIds, productGroups: i.fields.getTextInputValue("groups").split(",").map((value) => value.trim()).filter(Boolean).slice(0, 100) }, i.user.id);
      return i.reply({ ...this.couponDetail(gid, couponId), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:backup:create") {
      if (!i.guild) throw new Error("Servidor indisponível.");
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const backup = await this.backups.create(i.guild, i.user.id, i.fields.getTextInputValue("name"));
      await i.editReply(this.backupDetail(gid, backup.id) as never);
      return;
    }
    if (id.startsWith("modal:backup:rename:")) {
      const backupId = id.split(":")[3]!;
      const backup = this.backups.rename(gid, backupId, i.fields.getTextInputValue("name"), i.user.id);
      return i.reply({ ...this.backupDetail(gid, backup.id), flags: MessageFlags.Ephemeral });
    }
    if (id === "modal:giveaway:create") { await i.deferReply({ flags: MessageFlags.Ephemeral }); const giveaway = await this.giveaways.create({ guildId: gid, channelId: i.fields.getTextInputValue("channel").trim(), prize: i.fields.getTextInputValue("prize"), winnersCount: Number(i.fields.getTextInputValue("winners")), endsAt: new Date(Date.now() + parseDuration(i.fields.getTextInputValue("duration"))).toISOString(), actorId: i.user.id }); await i.editReply(`Sorteio ${giveaway.id} publicado.`); return; }

    if (id === "modal:cart:coupon") {
      const cart = this.assertCartOwner(gid, i.user.id, i.channelId ?? undefined);
      if (cart.status === "PAYMENT_PENDING") throw new Error("Cancele o pagamento pendente antes de alterar o cupom.");
      const code = i.fields.getTextInputValue("code").trim().toUpperCase();
      const subtotal = cart.items.reduce((sum, item) => {
        const product = this.products.get(item.productId, gid); const field = this.products.getField(product.id, item.fieldId);
        return sum + field.priceCents * item.quantity;
      }, 0);
      const validation = this.products.applyCoupon(code, subtotal, { guildId: gid, userId: i.user.id, productIds: cart.items.map((item) => item.productId) });
      cart.couponCode = validation.coupon?.code ?? ""; cart.updatedAt = nowIso(); this.db.save();
      await i.deferReply({ flags: MessageFlags.Ephemeral }); await this.refreshCartMessage(gid, i.user.id);
      await i.editReply(`✅ Cupom **${cart.couponCode}** aplicado. Desconto: **${formatMoney(validation.discountCents)}**.`); return;
    }
    if (id.startsWith("modal:cart-quantity:")) {
      const [, , productId, fieldId] = id.split(":");
      const quantity = Number(i.fields.getTextInputValue("quantity").trim());
      if (!Number.isFinite(quantity)) throw new Error("Informe uma quantidade válida.");
      this.assertCartOwner(gid, i.user.id, i.channelId ?? undefined);
      this.products.setCartQuantity(i.user.id, productId!, fieldId!, quantity, gid);
      await i.deferReply({ flags: MessageFlags.Ephemeral }); await this.refreshCartMessage(gid, i.user.id);
      await i.editReply("✅ Quantidade atualizada no carrinho."); return;
    }
    if (id.startsWith("modal:cart:imap-name:")) {
      const expectedCartId = id.split(":")[3]!;
      const cart = this.assertCartOwner(gid, i.user.id, i.channelId ?? undefined);
      if (cart.id !== expectedCartId) throw new Error("Este carrinho não corresponde mais à compra atual.");
      const payerFullName = i.fields.getTextInputValue("name").trim().replace(/\s+/g, " ");
      if (payerFullName.split(" ").filter(Boolean).length < 2) throw new Error("Informe o nome completo de quem fará o Pix.");
      cart.selectedProvider = "IMAP_PIX";
      cart.status = "CHECKOUT";
      cart.updatedAt = nowIso();
      this.db.save();
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const order = await this.orders.createFromCart({
        guildId: gid,
        userId: i.user.id,
        username: i.user.displayName,
        purchaseChannelId: cart.channelId,
        provider: "IMAP_PIX",
        payerFullName
      });
      await this.refreshOrderMessage(order);
      await i.editReply(`✅ Pagamento criado para **${bankProfile(order.imapBank || this.db.payments(gid).imapPix.bank).label}**. O bot verificará o valor e o nome **${truncate(order.payerFullName, 100)}**.`);
      return;
    }
    if (id.startsWith("modal:cart:gateway-payer:")) {
      const [, , , expectedCartId, providerRaw] = id.split(":");
      const provider = providerRaw as PaymentProviderName;
      if (!["STRIPE", "MISTIC_PAY"].includes(provider)) throw new Error("Gateway inválido para este formulário.");
      const cart = this.assertCartOwner(gid, i.user.id, i.channelId ?? undefined);
      if (cart.id !== expectedCartId) throw new Error("Este carrinho não corresponde mais à compra atual.");
      const payerFullName = i.fields.getTextInputValue("name").trim().replace(/\s+/g, " ");
      const payerDocument = i.fields.getTextInputValue("document").replace(/\D/g, "");
      cart.selectedProvider = provider;
      cart.status = "CHECKOUT";
      cart.updatedAt = nowIso();
      this.db.save();
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const order = await this.orders.createFromCart({ guildId: gid, userId: i.user.id, username: i.user.displayName, purchaseChannelId: cart.channelId, provider, payerFullName, payerDocument });
      await this.refreshOrderMessage(order);
      await i.editReply("✅ Cobrança PIX criada. Use um dos dois botões de cópia; ambos retornam somente o código copia e cola.");
      return;
    }
    if (id === "modal:checkout") throw new Error("Este fluxo antigo foi removido. Use o painel individual do produto.");
    if (id.startsWith("modal:ticket:open:")) { const [, , , panelId, optionId] = id.split(":"); await i.deferReply({ flags: MessageFlags.Ephemeral }); const channel = await this.tickets.open(i.guild!, i.member as GuildMember, panelId!, optionId!, i.fields.getTextInputValue("subject")); await i.editReply(`Ticket criado: ${channel}`); return; }
    if (id.startsWith("modal:ticket:add:")) { const ticketId = id.split(":")[3]!; await this.tickets.addMember(ticketId, i.fields.getTextInputValue("user").replace(/\D/g, ""), i.user.id); return i.reply({ content: "Usuário adicionado.", flags: MessageFlags.Ephemeral }); }
    if (id.startsWith("modal:ticket:remove:")) { const ticketId = id.split(":")[3]!; await this.tickets.removeMember(ticketId, i.fields.getTextInputValue("user").replace(/\D/g, ""), i.user.id); return i.reply({ content: "Usuário removido.", flags: MessageFlags.Ephemeral }); }
    if (id.startsWith("modal:ticket:rename:")) { const ticketId = id.split(":")[3]!; await this.tickets.rename(ticketId, i.fields.getTextInputValue("name"), i.user.id); return i.reply({ content: "Canal renomeado.", flags: MessageFlags.Ephemeral }); }
  }

  private async cartButton(i: ButtonInteraction, id: string, gid: string) {
    const cart = this.assertCartOwner(gid, i.user.id, i.channelId ?? undefined);
    if (cart.status === "PAYMENT_PENDING" && !id.startsWith("cart:cancel")) throw new Error("Existe um pagamento pendente. Verifique ou cancele esse pagamento antes de alterar o carrinho.");
    if (id === "cart:review") return i.update(this.views.cart(gid, i.user.id, i.user.displayName, i.user.displayAvatarURL()) as never);
    if (id === "cart:payment-methods") {
      const methods = this.payments.enabledMethods(gid);
      if (!methods.length) throw new Error("Nenhuma forma de pagamento está ativa. Avise a equipe do servidor.");
      return i.update(this.views.paymentMethods(gid, methods) as never);
    }
    if (id === "cart:coupon-apply") return i.showModal(modal("modal:cart:coupon", "Aplicar cupom", [input("code", "Código do cupom", cart.couponCode, TextInputStyle.Short, true, 30)]));
    if (id === "cart:coupon-remove") {
      cart.couponCode = ""; cart.updatedAt = nowIso(); this.db.save();
      return i.update(this.views.cart(gid, i.user.id, i.user.displayName, i.user.displayAvatarURL()) as never);
    }
    if (id === "cart:return") {
      const url = cart.sourceChannelId && cart.sourceMessageId ? `https://discord.com/channels/${gid}/${cart.sourceChannelId}/${cart.sourceMessageId}` : "";
      return i.reply({ content: url ? `Volte ao painel do produto: ${url}` : "O painel original não está mais acessível. Você pode continuar usando este carrinho.", flags: MessageFlags.Ephemeral });
    }
    if (id === "cart:cancel") {
      if (cart.orderId) {
        const order = this.orders.get(cart.orderId, gid);
        if (order.status === "PENDING") this.orders.cancel(order.id, i.user.id);
      }
      this.products.abandonCart(gid, i.user.id, "CANCELED");
      await i.update({ embeds: [new EmbedBuilder().setColor(0xef4444).setTitle("Compra cancelada").setDescription("O carrinho foi cancelado e as reservas de stock foram liberadas.")], components: [] });
      return;
    }
    if (id.startsWith("cart:qty-")) {
      const parts = id.split(":"); const action = parts[1]!.slice(4); const productId = parts[2]!; const fieldId = parts[3]!;
      const product = this.products.get(productId, gid); const field = this.products.getField(productId, fieldId);
      const item = cart.items.find((entry) => entry.productId === productId && entry.fieldId === fieldId);
      if (!item) throw new Error("Item não encontrado no carrinho.");
      if (action === "edit") return i.showModal(modal(`modal:cart-quantity:${productId}:${fieldId}`, "Alterar quantidade", [input("quantity", "Nova quantidade", String(item.quantity), TextInputStyle.Short, true, 5)]));
      const next = action === "inc" ? item.quantity + 1 : item.quantity - 1;
      this.products.setCartQuantity(i.user.id, productId, fieldId, next, gid);
      return i.update(this.views.cartItemManage(gid, i.user.id, product, field) as never);
    }
    if (id.startsWith("cart:remove:")) {
      const [, , productId, fieldId] = id.split(":");
      this.products.removeFromCart(i.user.id, productId!, fieldId!, gid);
      return i.update(this.views.cart(gid, i.user.id, i.user.displayName, i.user.displayAvatarURL()) as never);
    }
    if (id.startsWith("cart:pay:")) {
      const provider = id.split(":")[2] as PaymentProviderName;
      if (!this.payments.enabled(gid, provider)) throw new Error("Esta forma de pagamento não está disponível.");
      if (provider === "IMAP_PIX") {
        const bank = bankProfile(this.db.payments(gid).imapPix.bank);
        return i.showModal(modal(`modal:cart:imap-name:${cart.id}`, `Verificação PIX • ${bank.label}`.slice(0, 45), [
          input("name", "Nome completo de quem fará o Pix", "", TextInputStyle.Short, true, 120, "Digite exatamente como aparece na conta bancária")
        ]));
      }
      if (["STRIPE", "MISTIC_PAY"].includes(provider)) {
        return i.showModal(modal(`modal:cart:gateway-payer:${cart.id}:${provider}`, `Dados do pagador • ${provider === "STRIPE" ? "Stripe" : "MisticPay"}`.slice(0, 45), [
          input("name", "Nome completo de quem fará o PIX", "", TextInputStyle.Short, true, 120),
          input("document", "CPF ou CNPJ (somente números)", "", TextInputStyle.Short, true, 14)
        ]));
      }
      cart.selectedProvider = provider; cart.status = "CHECKOUT"; cart.updatedAt = nowIso(); this.db.save();
      await i.deferUpdate();
      const order = await this.orders.createFromCart({ guildId: gid, userId: i.user.id, username: i.user.displayName, purchaseChannelId: cart.channelId, provider });
      const attachment = this.orders.qrAttachment(order);
      await i.message.edit({ ...this.views.paymentPending(gid, order), files: attachment ? [attachment] : [], attachments: [] } as never);
      return;
    }
  }

  private async paymentButton(i: ButtonInteraction, id: string, gid: string) {
    const orderId = id.split(":")[2]!;
    const order = this.orders.get(orderId, gid);
    if (order.userId !== i.user.id) throw new Error("Este pagamento pertence a outro usuário.");
    if (id.startsWith("payment:key:")) {
      if (!order.pixCode) throw new Error("O código PIX ainda não está disponível.");
      return i.reply({ content: order.pixCode, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (id.startsWith("payment:code:")) {
      if (!order.pixCode) throw new Error("O código PIX ainda não está disponível.");
      return i.reply({ content: order.pixCode, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (id.startsWith("payment:cancel:")) {
      if (order.status !== "PENDING") throw new Error("Este pagamento não está pendente.");
      this.orders.cancel(order.id, i.user.id); await this.refreshOrderMessage(order); return i.reply({ content: "Pagamento cancelado.", flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("payment:check:")) {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      if (order.status !== "PENDING") { await i.editReply(`Status atual: **${order.status}**.`); return; }
      if (order.provider !== "IMAP_PIX") { await i.editReply("A verificação manual pelo botão existe somente para pagamentos IMAP."); return; }
      const result = await this.imap.checkNow(gid);
      await i.editReply(`Verificação IMAP concluída: ${result.approved} aprovado(s), ${result.review} para revisão, ${result.errors.length} erro(s). Status do pedido: **${this.orders.get(order.id).status}**.`);
      return;
    }
  }

  private async deliveryCopyButton(i: ButtonInteraction, id: string) {
    const [, , orderId, deliveryId] = id.split(":");
    if (!orderId || !deliveryId) throw new Error("Entrega inválida.");
    const order = this.orders.get(orderId);
    if (order.userId !== i.user.id) throw new Error("Este produto pertence a outro cliente.");
    if (!["DELIVERED", "AWAITING_DELIVERY"].includes(order.status)) throw new Error("O pagamento ainda não foi aprovado ou a entrega não foi concluída.");
    const delivery = order.deliveredProducts.find((item) => item.id === deliveryId);
    if (!delivery) throw new Error("A unidade entregue não foi encontrada.");
    if (!delivery.content) throw new Error("O conteúdo desta entrega está vazio.");
    const payload = { content: delivery.content, allowedMentions: { parse: [] as never[] } };
    if (i.guildId) return i.reply({ ...payload, flags: MessageFlags.Ephemeral });
    return i.reply(payload);
  }

  private async lockButton(i: ButtonInteraction, id: string, gid: string) {
    this.requireScope(i, "LOCKS");
    if (id === "lock:all-cancel") return i.update({ content: "Ação cancelada.", embeds: [], components: [] });
    if (!id.startsWith("lock:all-confirm:")) return;
    const [, , , mode, encoded] = id.split(":");
    const reason = decodeURIComponent(encoded || "Bloqueio administrativo");
    if (!i.guild || !(i.member instanceof GuildMember)) throw new Error("Servidor indisponível.");
    await i.deferUpdate();
    const result = mode === "lock" ? await this.locks.lockAll(i.guild, i.member, reason) : await this.locks.unlockAll(i.guild, i.member, reason);
    await i.editReply({ content: `✅ Operação concluída. Alterados: **${result.changed.length}** • Ignorados: **${result.skipped.length}** • Erros: **${result.errors.length}**`, embeds: [], components: [] });
  }

  private async productButton(i: ButtonInteraction, id: string, gid: string) {
    if (id.startsWith("product:buy:")) {
      const [, , productId, fieldId] = id.split(":");
      const product = this.products.get(productId!, gid);
      return this.beginDirectPurchase(i, product, fieldId);
    }
    if (id.startsWith("product:terms:buy:")) {
      const [, , , productId, fieldId] = id.split(":");
      const product = this.products.get(productId!, gid);
      const field = this.products.getField(product.id, fieldId);
      return this.beginDirectPurchase(i, product, field.id, true);
    }
    if (id.startsWith("product:cancel:")) {
      const product = this.products.get(id.split(":")[2]!, gid);
      return this.storeRespond(i, this.views.publicProduct(gid, product) as never);
    }
  }

  private async beginDirectPurchase(
    i: ButtonInteraction | StringSelectMenuInteraction,
    product: ReturnType<ProductService["get"]>,
    fieldId?: string,
    termsAccepted = false
  ) {
    if (!i.guild || !i.guildId) throw new Error("Compra disponível somente dentro do servidor.");
    const field = this.products.getField(product.id, fieldId);
    if (product.guildId !== i.guildId) throw new Error("Este produto pertence a outro servidor.");
    if (!product.active || !field.active) throw new Error("Esta opção está indisponível no momento.");
    if (product.deliveryType === "STOCK" && this.products.stockCount(product.id, "AVAILABLE", field.id) < product.minQuantity) throw new Error("Esta opção está sem stock no momento.");

    const isSelect = i.isStringSelectMenu();
    if (isSelect) {
      // O update substitui a mensagem pelo painel sem valores padrão, resetando visualmente o select.
      // Publicações em Components V2 precisam manter o mesmo formato para preservar a faixa de emojis ampliada.
      const resetPayload = i.message.flags.has(MessageFlags.IsComponentsV2)
        ? this.views.publishedProduct(i.guildId, product)
        : this.views.publicProduct(i.guildId, product);
      await i.update(resetPayload as never);
    }
    if (product.requireTerms && !termsAccepted) {
      const terms = { ...this.views.termsConfirmation(i.guildId, product, field), flags: MessageFlags.Ephemeral };
      if (isSelect || i.replied || i.deferred) await i.followUp(terms as never);
      else await i.reply(terms as never);
      return;
    }

    if (!this.guardPurchase(i.guildId, i.user.id, product.id, field.id)) {
      const content = "Este item já está sendo processado. Use o carrinho aberto para alterar a quantidade.";
      if (isSelect || i.replied || i.deferred) await i.followUp({ content, flags: MessageFlags.Ephemeral }); else await i.reply({ content, flags: MessageFlags.Ephemeral });
      return;
    }
    if (!isSelect && !i.replied && !i.deferred) await i.deferReply({ flags: MessageFlags.Ephemeral });

    const sourceMessageId = isSelect ? i.message.id : i.message.id;
    const cart = this.products.ensureCart(i.guildId, i.user.id, i.channelId, sourceMessageId);
    const alreadyInCart = cart.items.some((item) => item.productId === product.id && item.fieldId === field.id);
    if (!alreadyInCart) this.products.addToCart(i.user.id, product.id, field.id, 1, i.guildId);

    let channel = cart.channelId ? await i.guild.channels.fetch(cart.channelId).catch(() => undefined) : undefined;
    if (!(channel instanceof TextChannel)) {
      const settings = this.db.guild(i.guildId);
      const category = settings.purchaseCategoryId ? await i.guild.channels.fetch(settings.purchaseCategoryId).catch(() => undefined) : undefined;
      const parent = category?.type === ChannelType.GuildCategory ? category.id : undefined;
      const member = i.member instanceof GuildMember ? i.member : await i.guild.members.fetch(i.user.id);
      const botId = i.guild.members.me?.id ?? this.client.user?.id;
      const permittedRoles = [...new Set([
        ...settings.staffRoleIds,
        ...settings.permissions.supportRoleIds,
        ...settings.permissions.paymentRoleIds,
        ...settings.permissions.adminRoleIds,
        ...settings.adminRoleIds
      ])];
      channel = await i.guild.channels.create({
        name: truncate(`carrinho-${channelSafe(member.displayName || i.user.username)}-${cart.id.slice(-4).toLowerCase()}`, 90),
        type: ChannelType.GuildText,
        parent,
        topic: `Carrinho ${cart.id} • Cliente ${i.user.id}`,
        permissionOverwrites: [
          { id: i.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
          ...permittedRoles.map((roleId) => ({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] })),
          ...(botId ? [{ id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] }] : [])
        ],
        reason: `Carrinho iniciado por ${i.user.tag}`
      });
      cart.channelId = channel.id;
      this.db.save();
    }

    const userName = i.member instanceof GuildMember ? i.member.displayName : i.user.displayName;
    const payload = this.views.cart(i.guildId, i.user.id, userName, i.user.displayAvatarURL());
    let message = cart.messageId ? await channel.messages.fetch(cart.messageId).catch(() => undefined) : undefined;
    if (message) await message.edit(payload as never);
    else {
      message = await channel.send({ content: `<@${i.user.id}>`, ...payload, allowedMentions: { users: [i.user.id] } });
      cart.messageId = message.id;
      this.db.save();
    }
    const content = alreadyInCart
      ? `O item já está no carrinho. Altere a quantidade em ${channel}.`
      : `✅ **${product.name} • ${field.name}** foi adicionado. Continue em ${channel}.`;
    if (isSelect || i.replied) await i.followUp({ content, flags: MessageFlags.Ephemeral }); else await i.editReply({ content });
  }

  private async storeButton(i: ButtonInteraction, id: string, gid: string) {
    if (id === "store:catalog") return this.storeRespond(i, this.views.storeCatalog(gid) as never);
    if (/^store:page:\d+$/.test(id)) return this.storeRespond(i, this.views.storeCatalog(gid, Number(id.split(":")[2])) as never);
    if (id.startsWith("store:product:")) return this.storeRespond(i, this.views.publicProduct(gid, this.products.get(id.split(":")[2]!, gid)) as never);
    if (id === "store:cart") return this.storeRespond(i, this.views.cart(gid, i.user.id) as never);
    if (id === "store:orders") return this.storeRespond(i, { embeds: [this.userOrdersEmbed(gid, i.user.id)], components: [this.views.back(gid, "store:catalog")] });
    if (id === "store:cart:clear") { this.products.clearCart(i.user.id); return this.storeRespond(i, this.views.cart(gid, i.user.id) as never); }
    if (id.startsWith("store:terms:add:")) { this.products.addToCart(i.user.id, id.split(":")[3]!); return this.storeRespond(i, this.views.cart(gid, i.user.id) as never); }
    if (id.startsWith("store:terms:buy:")) throw new Error("Este painel antigo foi desativado. Publique o painel individual do produto.");
    if (id.startsWith("store:add:")) {
      const product = this.products.get(id.split(":")[2]!, gid);
      if (product.requireTerms) return this.storeRespond(i, this.views.termsConfirmation(gid, product, this.products.getField(product.id)) as never);
      this.products.addToCart(i.user.id, product.id);
      return this.storeRespond(i, this.views.cart(gid, i.user.id) as never);
    }
    if (id.startsWith("store:buy:")) {
      const product = this.products.get(id.split(":")[2]!, gid);
      if (product.requireTerms) return this.storeRespond(i, this.views.termsConfirmation(gid, product, this.products.getField(product.id)) as never);
      throw new Error("Este painel antigo foi desativado. Publique o painel individual do produto.");
    }
    if (id === "store:checkout") throw new Error("Este painel antigo foi desativado. Publique o painel individual do produto.");
  }

  private async stockRequestButton(i: ButtonInteraction, id: string, gid: string) {
    if (id === "stock-request:open") {
      const settings = this.db.guild(gid).stockRequest;
      if (!settings.enabled) throw new Error("Os pedidos de stock estão desativados neste servidor.");
      return i.showModal(modal("modal:stock-request:create", "Pedir Stock", [
        input("product", "Qual produto você procura?", "", TextInputStyle.Short, true, 150, "Ex.: Discord Nitro 1 mês"),
        input("quantity", "Quantidade desejada", "1", TextInputStyle.Short, true, 4),
        input("details", "Detalhes adicionais", "", TextInputStyle.Paragraph, false, 1500, "Plano, duração, região, prazo ou outra informação")
      ]));
    }
    const [, action, requestId] = id.split(":");
    if (!requestId) throw new Error("Solicitação inválida.");
    const request = this.db.state.stockRequests[requestId];
    if (!request || request.guildId !== gid) throw new Error("Solicitação de stock não encontrada.");
    const member = i.member as GuildMember;
    const guildSettings = this.db.guild(gid);
    const staff = this.isAdmin(i) || guildSettings.staffRoleIds.some((roleId) => member.roles.cache.has(roleId));
    if (!staff) throw new Error("Somente a equipe pode gerenciar solicitações de stock.");

    if (action === "claim") {
      request.status = "CLAIMED";
      request.claimedBy = i.user.id;
    } else if (action === "available") {
      request.status = "AVAILABLE";
      request.claimedBy ||= i.user.id;
    } else if (action === "reject") {
      request.status = "REJECTED";
      request.claimedBy ||= i.user.id;
    } else {
      throw new Error("Ação de stock inválida.");
    }
    request.updatedAt = nowIso();
    this.db.audit(i.user.id, `STOCK_REQUEST_${action.toUpperCase()}`, "stock_request", request.id, { status: request.status });
    this.db.save();
    await i.update(this.views.stockRequestDetail(gid, request, i.message.flags.has(MessageFlags.Ephemeral)) as never);

    if (action === "available" || action === "reject") {
      const user = await this.client.users.fetch(request.userId).catch(() => undefined);
      if (user) {
        const text = action === "available"
          ? `${this.emojis.text("stock_request_available", gid)} O item **${request.productName}** solicitado no protocolo \`${request.id}\` foi marcado como disponível. Fale com a equipe ou acesse o painel publicado do produto para concluir a compra.`
          : `${this.emojis.text("stock_request_reject", gid)} A solicitação \`${request.id}\` para **${request.productName}** não pôde ser atendida neste momento.`;
        await user.send(text).catch(() => undefined);
      }
    }
  }

  private async savedEmojiCommand(interaction: ChatInputCommandInteraction) {
    const gid = interaction.guildId!;
    const action = interaction.options.getSubcommand();
    const isAdmin = this.isAdmin(interaction);
    const settings = this.db.guild(gid).emojiLibrary;

    if (action === "adicionar") {
      if (!isAdmin && !settings.allowMembers) throw new Error("Somente administradores podem salvar emojis neste servidor.");
      const mine = this.emojis.listSaved(interaction.user.id, gid);
      if (!isAdmin && mine.length >= settings.maxPerUser) throw new Error(`Você atingiu o limite de ${settings.maxPerUser} emojis salvos.`);
      const name = interaction.options.getString("nome", true);
      const attachment = interaction.options.getAttachment("arquivo");
      const emojiText = interaction.options.getString("emoji") ?? "";
      if (!attachment && !emojiText) throw new Error("Envie um arquivo ou informe um emoji personalizado.");
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const source = attachment
        ? await this.emojiSourceFromAttachment(attachment)
        : await this.emojiSourceFromText(emojiText);
      const saved = await this.emojis.saveUserEmoji({ name, bytes: source.bytes, mimeType: source.mimeType, ownerId: interaction.user.id, guildId: gid, originalName: source.originalName });
      await interaction.editReply({ embeds: [this.savedEmojiResultEmbed(gid, saved)] });
      return;
    }

    if (action === "listar") {
      const scope = interaction.options.getString("escopo") ?? "meus";
      const ownerId = scope === "todos" ? undefined : interaction.user.id;
      const items = this.emojis.listSaved(ownerId, gid);
      const lines = items.slice(0, 40).map((item, index) => `${index + 1}. ${this.emojis.mentionSaved(item)} **${item.name}** — \`${item.id}\``);
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x3155ff)
          .setTitle(`${this.emojis.text("saved_emoji_list", gid)} ${scope === "todos" ? "Emojis salvos no servidor" : "Meus emojis salvos"}`)
          .setDescription(lines.join("\n") || "Nenhum emoji encontrado.")
          .setFooter({ text: items.length > 40 ? `Mostrando 40 de ${items.length}. Use /painel para navegar pela lista completa.` : `${items.length} emoji(s)` })],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const identifier = interaction.options.getString("emoji", true);
    const item = this.emojis.findSaved(identifier);
    if (!item || item.guildId !== gid) throw new Error("Emoji salvo não encontrado neste servidor.");
    if (action === "copiar") {
      await interaction.reply({ embeds: [this.savedEmojiResultEmbed(gid, item)], flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === "remover") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const removed = await this.emojis.removeSaved(item.id, interaction.user.id, isAdmin);
      await interaction.editReply(`${this.emojis.fallback("approve")} Emoji **${removed.name}** removido da aplicação.`);
    }
  }

  private savedEmojiResultEmbed(gid: string, item: SavedApplicationEmoji) {
    const mention = this.emojis.mentionSaved(item);
    return new EmbedBuilder()
      .setColor(0x3155ff)
      .setTitle(`${mention} Emoji salvo na aplicação`)
      .setDescription(`Use este código em textos, descrições e produtos enviados pelo bot:\n\n\`\`\`\n${mention}\n\`\`\``)
      .addFields(
        { name: "Nome", value: `\`${item.name}\``, inline: true },
        { name: "ID", value: `\`${item.id}\``, inline: true },
        { name: "Tipo", value: item.animated ? "GIF animado" : "Imagem estática", inline: true }
      )
      .setFooter({ text: "166 Community • Application Emoji" })
      .setTimestamp();
  }

  private async emojiSourceFromAttachment(attachment: { url: string; size: number; name: string | null; contentType: string | null }) {
    if (attachment.size > 256 * 1024) throw new Error("O arquivo excede 256 KiB. Comprima a imagem ou o GIF antes de enviar.");
    const extension = (attachment.name ?? "").split(".").pop()?.toLowerCase();
    const extensionMimes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif" };
    const mimeType = attachment.contentType?.split(";")[0] ?? (extension ? extensionMimes[extension] : undefined);
    if (!mimeType || !Object.values(extensionMimes).includes(mimeType)) throw new Error("Formato inválido. Use PNG, JPG, GIF, WEBP ou AVIF.");
    const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Não foi possível baixar o anexo (${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 256 * 1024) throw new Error("O arquivo excede 256 KiB após o download.");
    return { bytes, mimeType, originalName: attachment.name ?? "emoji" };
  }

  private async emojiSourceFromText(value: string) {
    const match = value.trim().match(/^<(a?):([a-zA-Z0-9_]+):(\d{15,25})>$/);
    if (!match) throw new Error("Emoji inválido. Envie no formato <:nome:id> ou <a:nome:id>.");
    const animated = match[1] === "a";
    const name = match[2]!;
    const id = match[3]!;
    const mimeType = animated ? "image/gif" : "image/png";
    const url = `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "png"}?size=128&quality=lossless`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error("Não foi possível acessar esse emoji. Verifique se ele ainda existe.");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 256 * 1024) throw new Error("Esse emoji excede 256 KiB e não pode ser salvo na aplicação.");
    return { bytes, mimeType, originalName: name };
  }

  private async collectSavedEmoji(i: ModalSubmitInteraction, name: string, adminBypass = false) {
    const gid = i.guildId;
    if (!gid || !(i.channel instanceof TextChannel)) throw new Error("Use esta função em um canal de texto do servidor.");
    const settings = this.db.guild(gid).emojiLibrary;
    if (!adminBypass && !settings.allowMembers && !this.isAdmin(i)) throw new Error("O envio de emojis está restrito aos administradores.");
    const mine = this.emojis.listSaved(i.user.id, gid);
    if (!adminBypass && !this.isAdmin(i) && mine.length >= settings.maxPerUser) throw new Error(`Você atingiu o limite de ${settings.maxPerUser} emojis.`);

    await i.reply({
      content: `${this.emojis.text("saved_emoji", gid)} Envie agora uma imagem/GIF de até **256 KiB** ou cole um emoji personalizado neste canal.\nFormatos aceitos: PNG, JPG, GIF, WEBP e AVIF. Tempo: **2 minutos**.`,
      flags: MessageFlags.Ephemeral
    });
    const collected = await i.channel.awaitMessages({
      filter: (message) => message.author.id === i.user.id && (message.attachments.size > 0 || /^<a?:[a-zA-Z0-9_]+:\d{15,25}>$/.test(message.content.trim())),
      max: 1,
      time: 120_000
    });
    const message = collected.first();
    if (!message) throw new Error("Tempo esgotado. Nenhum arquivo ou emoji foi recebido.");
    try {
      const attachment = message.attachments.first();
      const source = attachment
        ? await this.emojiSourceFromAttachment(attachment)
        : await this.emojiSourceFromText(message.content.trim());
      const saved = await this.emojis.saveUserEmoji({ name, bytes: source.bytes, mimeType: source.mimeType, ownerId: i.user.id, guildId: gid, originalName: source.originalName });
      await i.followUp({ embeds: [this.savedEmojiResultEmbed(gid, saved)], flags: MessageFlags.Ephemeral });
    } finally {
      await message.delete().catch(() => undefined);
    }
  }

  private async ticketButton(i: ButtonInteraction, id: string, gid: string) {
    if (id.startsWith("ticket:purchase-none:")) {
      const ticketId = id.split(":")[2]!;
      await this.tickets.resolvePurchaseGate(ticketId, i.user.id);
      return i.reply({ content: "✅ Atendimento liberado para outro assunto.", flags: MessageFlags.Ephemeral });
    }
    if (id.startsWith("ticket:open:")) { const [, , panelId, optionId] = id.split(":"); return this.showTicketSubject(i, panelId!, optionId!); }
    const [, action, ticketId] = id.split(":"); if (!ticketId) return; const ticket = this.tickets.getTicket(ticketId); const member = i.member as GuildMember; const guildSettings = this.db.guild(gid); const ticketRoles = [...guildSettings.staffRoleIds, ...guildSettings.permissions.supportRoleIds, ...guildSettings.permissions.ticketRoleIds]; const staff = member.permissions.has(PermissionFlagsBits.ManageChannels) || ticketRoles.some((rid) => member.roles.cache.has(rid)); const owner = ticket.ownerId === i.user.id;
    if (!staff && !owner) throw new Error("Você não tem acesso a este ticket.");
    if (action === "claim") { await this.tickets.claim(ticketId, member); return i.reply({ content: `Ticket assumido por ${i.user}.` }); }
    if (action === "notify") { if (!staff) throw new Error("Somente a equipe pode notificar o cliente."); const result = await this.tickets.notifyOwner(ticketId, i.user.id); return i.reply({ content: `✅ Cliente notificado. DM: **${result.dmSent ? "enviada" : "indisponível"}**.`, flags: MessageFlags.Ephemeral }); }
    if (action === "close") { await this.tickets.close(ticketId, i.user.id); return i.reply({ content: "Ticket fechado.", flags: MessageFlags.Ephemeral }); }
    if (action === "archive") { if (!staff) throw new Error("Somente a equipe pode arquivar."); await this.tickets.archive(ticketId, i.user.id); return i.reply({ content: "Ticket arquivado.", flags: MessageFlags.Ephemeral }); }
    if (action === "reopen") { if (!staff) throw new Error("Somente a equipe pode reabrir."); await this.tickets.reopen(ticketId, i.user.id); return i.reply({ content: "Ticket reaberto.", flags: MessageFlags.Ephemeral }); }
    if (action === "transcript") { await i.deferReply({ flags: MessageFlags.Ephemeral }); const path = await this.tickets.transcript(ticketId); await i.editReply({ content: "Transcript gerado.", files: [new AttachmentBuilder(path)] }); return; }
    if (action === "delete") { if (!staff) throw new Error("Somente a equipe pode excluir."); await i.reply({ content: "Canal será excluído em 3 segundos.", flags: MessageFlags.Ephemeral }); setTimeout(() => void this.tickets.deleteChannel(ticketId, i.user.id).catch(() => undefined), 3000); return; }
    if (action === "add") { if (!staff) throw new Error("Somente a equipe pode adicionar membros."); return i.showModal(modal(`modal:ticket:add:${ticketId}`, "Adicionar ao ticket", [input("user", "ID ou menção do usuário", "", TextInputStyle.Short, true, 30)])); }
    if (action === "remove") { if (!staff) throw new Error("Somente a equipe pode remover membros."); return i.showModal(modal(`modal:ticket:remove:${ticketId}`, "Remover do ticket", [input("user", "ID ou menção do usuário", "", TextInputStyle.Short, true, 30)])); }
    if (action === "rename") return i.showModal(modal(`modal:ticket:rename:${ticketId}`, "Renomear ticket", [input("name", "Novo nome", "ticket", TextInputStyle.Short, true, 80)]));
  }
  private async showTicketSubject(i: ButtonInteraction | StringSelectMenuInteraction, panelId: string, optionId: string) {
    const option = this.tickets.getPanel(panelId).options.find((item) => item.id === optionId);
    if (!option) throw new Error("Opção de ticket inválida.");
    if (option.askSubject) {
      await i.showModal(modal(`modal:ticket:open:${panelId}:${optionId}`, "Abrir atendimento", [input("subject", "Resumo do assunto", "", TextInputStyle.Paragraph, true, 1000)]));
      await this.resetTicketSelect(i, panelId);
      return;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await this.resetTicketSelect(i, panelId);
    const channel = await this.tickets.open(i.guild!, i.member as GuildMember, panelId, optionId, option.name);
    await i.editReply(`Ticket criado: ${channel}`);
  }

  private async resetTicketSelect(i: ButtonInteraction | StringSelectMenuInteraction, panelId: string): Promise<void> {
    if (!i.isStringSelectMenu() || !i.guildId) return;
    const panel = this.tickets.getPanel(panelId, i.guildId);
    await i.message.edit(this.views.publicTicketPanelEdit(i.guildId, panel) as never).catch((error) => {
      this.logger.warn("Não foi possível reiniciar visualmente o select do painel de ticket.", {
        panelId,
        messageId: i.message.id,
        error: String(error)
      });
    });
  }
  private async giveawayButton(i: ButtonInteraction, id: string) { const count = this.giveaways.join(id.split(":")[2]!, i.user.id); await i.reply({ content: `Participação atualizada. Participantes: ${count}.`, flags: MessageFlags.Ephemeral }); }

  private emojiFunctionPicker(gid: string, page = 0) {
    const all = this.emojis.functionalOptions();
    const maxPage = Math.max(0, Math.ceil(all.length / 25) - 1);
    const safePage = Math.max(0, Math.min(maxPage, Math.trunc(page) || 0));
    const slice = all.slice(safePage * 25, safePage * 25 + 25);
    const select = new StringSelectMenuBuilder()
      .setCustomId(`admin:emoji:function-select:${safePage}`)
      .setPlaceholder("Escolha a função do bot para personalizar")
      .addOptions(slice.map((item) => {
        const override = this.db.guild(gid).emojiOverrides[item.semantic];
        const selected = override?.split(":")[0] ?? item.currentAsset;
        const asset = this.emojis.option(selected);
        return new StringSelectMenuOptionBuilder()
          .setLabel(item.label.slice(0, 100))
          .setDescription(`Atual: ${asset?.label ?? selected}`.slice(0, 100))
          .setValue(item.semantic)
          .setEmoji(this.emojis.component(item.semantic, gid));
      }));
    return checkedDiscordPayload({
      embeds: [new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle(`${this.emojis.text("customize", gid)} Personalizar emojis por função`)
        .setDescription(`Escolha qual função deseja alterar. Depois, selecione qualquer um dos **${this.emojis.manifestCount()} emojis enviados**. Página **${safePage + 1}/${maxPage + 1}**.`)],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.views.button(gid, `admin:emoji:mapping:${Math.max(0, safePage - 1)}`, "Anterior", "back", ButtonStyle.Secondary, safePage === 0),
          this.views.button(gid, `admin:emoji:mapping:${Math.min(maxPage, safePage + 1)}`, "Próxima", "arrow", ButtonStyle.Secondary, safePage === maxPage),
          this.views.button(gid, "admin:emojis", "Voltar", "home")
        )
      ]
    }, `seletor de funções de emoji página ${safePage}`);
  }

  private emojiAssetPicker(
    gid: string,
    mode: "product" | "product-field" | "ticket-panel" | "ticket-option" | "mapping" | "catalog",
    page = 0,
    target: { productId?: string; fieldId?: string; panelId?: string; optionId?: string; functional?: string } = {}
  ) {
    const all = [
      ...this.emojis.semanticOptions(),
      ...this.emojis.listSaved(undefined, gid).map((item) => ({ semantic: `saved:${item.name}`, label: `Salvo • ${item.name}`, fallback: this.emojis.mentionSaved(item) }))
    ];
    const maxPage = Math.max(0, Math.ceil(all.length / 25) - 1);
    const safePage = Math.max(0, Math.min(maxPage, Math.trunc(page) || 0));
    const slice = all.slice(safePage * 25, safePage * 25 + 25);

    let selected = "";
    let customId = `admin:emoji:catalog-select:${safePage}`;
    let prefix = "admin:emoji:catalog";
    let back = "admin:emojis";
    let title = "Catálogo de emojis enviados";
    let description = "Veja todos os arquivos que compõem o pacote do bot.";

    if (mode === "product" && target.productId) {
      const product = this.products.get(target.productId, gid);
      selected = product.emojiSemantic;
      customId = `admin:product:emoji-select:${target.productId}:${safePage}`;
      prefix = `admin:product:emoji:${target.productId}`;
      back = `admin:product:${target.productId}`;
      title = `Emoji do produto • ${product.name}`;
      description = "O emoji será usado no título e na identificação geral do produto.";
    } else if (mode === "product-field" && target.productId && target.fieldId) {
      const product = this.products.get(target.productId, gid);
      const field = this.products.getField(product.id, target.fieldId);
      selected = field.emoji;
      customId = `admin:product:field-emoji-select:${product.id}:${field.id}:${safePage}`;
      prefix = `admin:product:field-emoji:${product.id}:${field.id}`;
      back = `admin:product:field:${product.id}:${field.id}`;
      title = `Emoji do campo • ${field.name}`;
      description = "Escolha um emoji do pacote ou um emoji salvo pelo comando Salvar Emojis. Ele aparecerá no botão ou na opção do select.";
    } else if (mode === "ticket-panel" && target.panelId) {
      const panel = this.tickets.getPanel(target.panelId);
      selected = panel.emojiSemantic;
      customId = `admin:ticket:emoji-select:${target.panelId}:${safePage}`;
      prefix = `admin:ticket:emoji:${target.panelId}`;
      back = `admin:ticket:${target.panelId}`;
      title = `Emoji do painel • ${panel.name}`;
      description = "O emoji será usado no título e na identificação do painel de tickets.";
    } else if (mode === "ticket-option" && target.panelId && target.optionId) {
      const panel = this.tickets.getPanel(target.panelId);
      const option = panel.options.find((item) => item.id === target.optionId);
      if (!option) throw new Error("Opção de ticket não encontrada.");
      selected = option.emojiSemantic;
      customId = `admin:ticket:option-emoji-select:${target.panelId}:${target.optionId}:${safePage}`;
      prefix = `admin:ticket:option-emoji:${target.panelId}:${target.optionId}`;
      back = `admin:ticket:options:${target.panelId}`;
      title = `Emoji da opção • ${option.name}`;
      description = "O emoji aparecerá no botão ou no menu de seleção do ticket.";
    } else if (mode === "mapping" && target.functional) {
      const functional = this.emojis.functionalOptions().find((item) => item.semantic === target.functional);
      if (!functional) throw new Error("Função de emoji não encontrada.");
      selected = this.db.guild(gid).emojiOverrides[target.functional]?.split(":")[0] ?? functional.currentAsset;
      customId = `admin:emoji:asset-select:${target.functional}:${safePage}`;
      prefix = `admin:emoji:assets:${target.functional}`;
      back = `admin:emoji:function:${target.functional}`;
      title = `Escolher emoji • ${functional.label}`;
      description = "A alteração será aplicada a todos os botões, títulos e painéis que usam essa função.";
    }

    const select = new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(mode === "catalog" ? "Selecione um emoji para ver detalhes" : "Selecione o emoji")
      .addOptions(slice.map((item) => new StringSelectMenuOptionBuilder()
        .setLabel(item.label.slice(0, 100))
        .setDescription(`Identificador: ${item.semantic}`.slice(0, 100))
        .setValue(item.semantic)
        .setEmoji(this.emojis.component(item.semantic, gid))
        .setDefault(mode !== "catalog" && selected === item.semantic)));

    return checkedDiscordPayload({
      embeds: [new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle(`${this.emojis.text("emoji", gid)} ${title}`)
        .setDescription(`${description}

**${all.length} emojis disponíveis** • Página **${safePage + 1}/${maxPage + 1}**${selected ? `
Selecionado: ${this.emojis.text(selected, gid)} \`${selected}\`` : ""}`)],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.views.button(gid, `${prefix}:${Math.max(0, safePage - 1)}`, "Anterior", "back", ButtonStyle.Secondary, safePage === 0),
          this.views.button(gid, `${prefix}:${Math.min(maxPage, safePage + 1)}`, "Próxima", "arrow", ButtonStyle.Secondary, safePage === maxPage),
          this.views.button(gid, back, "Voltar", "home")
        )
      ]
    }, `biblioteca de emojis ${mode} página ${safePage}`);
  }

  private emojiFunctionDetail(gid: string, semantic: string) {
    const functional = this.emojis.functionalOptions().find((item) => item.semantic === semantic);
    if (!functional) throw new Error("Função de emoji não encontrada.");
    const override = this.db.guild(gid).emojiOverrides[semantic];
    const selected = override?.split(":")[0] ?? functional.currentAsset;
    const asset = this.emojis.option(selected);
    const installed = this.emojis.variant(selected);
    return {
      embeds: [new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle(`${this.emojis.text(semantic, gid)} ${functional.label}`)
        .setDescription(`Função interna: \`${semantic}\`
Emoji atual: ${this.emojis.text(selected, gid)} **${asset?.label ?? selected}**
Arquivo do pacote: \`${selected}\`
Status: **${installed ? "instalado" : "aguardando sincronização"}**
Personalização: **${override ? "ativa" : "padrão do bot"}**`)],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.views.button(gid, `admin:emoji:assets:${semantic}:0`, "Trocar emoji", "customize", ButtonStyle.Primary),
        this.views.button(gid, `admin:emoji:reset:${semantic}`, "Restaurar padrão", "refresh", ButtonStyle.Danger, !override),
        this.views.button(gid, "admin:emoji:mapping:0", "Voltar", "back")
      )]
    };
  }

  private emojiCatalogDetail(gid: string, semantic: string, page: number) {
    const option = this.emojis.option(semantic);
    if (!option) throw new Error("Emoji não encontrado no pacote.");
    const installed = this.emojis.variant(semantic);
    return {
      embeds: [new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle(`${this.emojis.text(semantic, gid)} ${option.label}`)
        .setDescription(`Identificador: \`${semantic}\`
Nome na aplicação: \`${option.name}\`
Status: **${installed ? "instalado" : "aguardando sincronização"}**
Origem: **pacote enviado pelo usuário**`)],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.views.button(gid, `admin:emoji:catalog:${Math.max(0, page)}`, "Voltar ao catálogo", "back"),
        this.views.button(gid, "admin:emoji:sync", "Sincronizar", "refresh", ButtonStyle.Success)
      )]
    };
  }

  private productDeliveryView(gid: string, product: ReturnType<ProductService["get"]>) {
    const typeLabel = product.deliveryType === "STOCK" ? "Automática" : product.deliveryType === "ROLE" ? "Por cargo" : "Manual";
    return {
      embeds: [new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle(`Entrega e limites • ${product.name}`)
        .setDescription("Cada configuração é editada separadamente. Não é necessário digitar combinações de opções no mesmo campo.")
        .addFields(
          { name: "Tipo de entrega", value: typeLabel, inline: true },
          { name: "Cargo", value: product.roleId ? `<@&${product.roleId}>` : "Não definido", inline: true },
          { name: "Quantidade", value: `Mínima: **${product.minQuantity}**
Máxima: **${product.maxQuantity}**
Limite por usuário: **${product.perUserLimit || "sem limite"}**`, inline: true },
          { name: "Grupo de cupons", value: product.couponGroup || "Nenhum", inline: true },
          { name: "Termos obrigatórios", value: product.requireTerms ? "Ativados" : "Desativados", inline: true },
          { name: "Mensagem de entrega", value: truncate(product.deliveryMessage || "Não configurada", 1024) },
          { name: "Texto dos termos", value: truncate(product.termsText || "Não configurado", 1024) }
        )],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.views.button(gid, `admin:product:delivery-type:${product.id}`, "Tipo de entrega", "delivery", ButtonStyle.Primary),
          this.views.button(gid, `admin:product:delivery-role:${product.id}`, "Cargo entregue", "role", ButtonStyle.Secondary),
          this.views.button(gid, `admin:product:delivery-message:${product.id}`, "Mensagem de entrega", "message", ButtonStyle.Secondary),
          this.views.button(gid, `admin:product:delivery-limits:${product.id}`, "Limites e cupons", "settings", ButtonStyle.Secondary)
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.views.button(gid, `admin:product:terms-toggle:${product.id}`, product.requireTerms ? "Desativar termos" : "Ativar termos", product.requireTerms ? "off" : "on", product.requireTerms ? ButtonStyle.Danger : ButtonStyle.Success),
          this.views.button(gid, `admin:product:terms-text:${product.id}`, "Editar texto dos termos", "edit", ButtonStyle.Secondary),
          this.views.button(gid, `admin:product:${product.id}`, "Voltar ao produto", "back", ButtonStyle.Secondary)
        )
      ]
    };
  }

  private personalizeView(gid: string) { const b = this.db.brand(gid); return { embeds: [new EmbedBuilder().setColor(Number.parseInt(b.color.slice(1), 16)).setTitle(`${this.emojis.text("customize", gid)} Personalização total`).setDescription(`Nome: **${b.name}**\nCor: **${b.color}**\nPresença: **${b.presenceType} ${b.presenceText}**\nStatus: **${b.status}**\nLogo: ${b.logoUrl ? "configurado" : "padrão"}\nBanner: ${b.bannerUrl ? "configurado" : "padrão interno"}`).setFooter({ text: b.footer })], components: [
    new ActionRowBuilder<ButtonBuilder>().addComponents(this.views.button(gid, "admin:brand:edit", "Marca e visual", "color"), this.views.button(gid, "admin:presence:edit", "Presença", "message"), this.views.button(gid, "admin:bot:identity", "Nome do bot", "edit"), this.views.button(gid, "admin:bot:avatar", "Avatar do bot", "image")),
    new ActionRowBuilder<ButtonBuilder>().addComponents(this.views.button(gid, "admin:brand:logo-upload", "Enviar logo", "upload"), this.views.button(gid, "admin:brand:banner-upload", "Enviar banner", "image"), this.views.button(gid, "admin:home", "Voltar", "back"))
  ] }; }
  private automationsView(gid: string) {
    const settings = this.db.automations(gid);
    const components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> = [];
    if (settings.autoResponses.length) {
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("admin:automations:response-select")
          .setPlaceholder("Selecione uma resposta automática")
          .addOptions(settings.autoResponses.slice(0, 25).map((entry, index) => new StringSelectMenuOptionBuilder()
            .setLabel(truncate(entry.trigger, 100))
            .setDescription(truncate(`${entry.exact ? "Correspondência exata" : "Contém o texto"} • ${entry.response}`, 100))
            .setValue(String(index))
            .setEmoji(this.emojis.component("message", gid))))
      ));
    }
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.views.button(gid, "admin:automations:toggle:welcome", settings.welcomeEnabled ? "Desativar boas-vindas" : "Ativar boas-vindas", settings.welcomeEnabled ? "off" : "on", settings.welcomeEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
        this.views.button(gid, "admin:automations:welcome-message", "Mensagem de boas-vindas", "edit", ButtonStyle.Secondary),
        this.views.button(gid, "admin:automations:toggle:goodbye", settings.goodbyeEnabled ? "Desativar saída" : "Ativar saída", settings.goodbyeEnabled ? "off" : "on", settings.goodbyeEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
        this.views.button(gid, "admin:automations:goodbye-message", "Mensagem de saída", "edit", ButtonStyle.Secondary)
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.views.button(gid, "admin:automations:toggle:autorole", settings.autoRoleEnabled ? "Desativar autorole" : "Ativar autorole", settings.autoRoleEnabled ? "off" : "on", settings.autoRoleEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
        this.views.button(gid, "admin:automations:toggle:responses", settings.autoResponsesEnabled ? "Pausar respostas" : "Ativar respostas", settings.autoResponsesEnabled ? "pause" : "approve", settings.autoResponsesEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
        this.views.button(gid, "admin:automations:response-add", "Adicionar resposta", "plus", ButtonStyle.Primary),
        this.views.button(gid, "admin:channels", "Canais e cargos", "settings", ButtonStyle.Secondary)
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.views.button(gid, "admin:automations:schedules", "Horários de canais", "clock", ButtonStyle.Primary),
        this.views.button(gid, "admin:home", "Voltar", "back", ButtonStyle.Secondary)
      )
    );
    return {
      embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle(`${this.emojis.text("refresh", gid)} Automações`).setDescription(`Boas-vindas: **${settings.welcomeEnabled ? "ativa" : "desativada"}**
Mensagem de saída: **${settings.goodbyeEnabled ? "ativa" : "desativada"}**
Autorole: **${settings.autoRoleEnabled ? "ativo" : "desativado"}**
Respostas automáticas: **${settings.autoResponsesEnabled ? "ativas" : "pausadas"}** • ${settings.autoResponses.length} cadastrada(s)
Horários de canais: **${settings.channelSchedules.filter((schedule) => schedule.enabled).length} ativo(s)** • ${settings.channelSchedules.length} cadastrado(s)`)],
      components
    };
  }

  private channelScheduleModal(scheduleId = "", schedule?: import("../types.js").ChannelSchedule) {
    return modal(
      scheduleId ? `modal:automations:schedule-edit:${scheduleId}` : "modal:automations:schedule-add",
      scheduleId ? "Editar horário de canais" : "Criar horário de canais",
      [
        input("name", "Nome do horário", schedule?.name ?? "Horário principal", TextInputStyle.Short, true, 80),
        input("lock_time", "Horário para fechar (HH:mm)", schedule?.lockTime ?? "22:00", TextInputStyle.Short, true, 5),
        input("unlock_time", "Horário para abrir (HH:mm)", schedule?.unlockTime ?? "08:00", TextInputStyle.Short, true, 5),
        input("lock_message", "Mensagem ao fechar", schedule?.lockMessage ?? "Este canal foi fechado automaticamente.", TextInputStyle.Paragraph, false, 1800),
        input("unlock_message", "Mensagem ao abrir", schedule?.unlockMessage ?? "Este canal foi aberto automaticamente.", TextInputStyle.Paragraph, false, 1800)
      ]
    );
  }

  private channelSchedulesView(gid: string) {
    const schedules = this.db.automations(gid).channelSchedules;
    const components: Array<ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>> = [];
    if (schedules.length) {
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("admin:automations:schedule-select")
          .setPlaceholder("Selecione um horário para configurar")
          .addOptions(schedules.slice(0, 25).map((schedule) => new StringSelectMenuOptionBuilder()
            .setLabel(truncate(schedule.name, 100))
            .setDescription(truncate(`${schedule.enabled ? "Ativo" : "Pausado"} • fecha ${schedule.lockTime} • abre ${schedule.unlockTime} • ${schedule.channelIds.length} canal(is)`, 100))
            .setValue(schedule.id)
            .setEmoji(this.emojis.component(schedule.enabled ? "clock" : "pause", gid))))
      ));
    }
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      this.views.button(gid, "admin:automations:schedule-add", "Criar horário", "plus", ButtonStyle.Success, schedules.length >= 25),
      this.views.button(gid, "admin:automations", "Voltar", "back", ButtonStyle.Secondary)
    ));
    return {
      embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle(`${this.emojis.text("clock", gid)} Abertura e fechamento automático`).setDescription(
        schedules.length
          ? schedules.map((schedule) => `${schedule.enabled ? "🟢" : "⚫"} **${schedule.name}** — fecha **${schedule.lockTime}**, abre **${schedule.unlockTime}** • ${schedule.channelIds.length} canal(is)`).join("\n").slice(0, 4000)
          : "Crie um horário, defina quando os canais fecham e abrem e depois selecione os canais. O fuso padrão é America/Sao_Paulo."
      )],
      components
    };
  }

  private channelScheduleDetail(gid: string, scheduleId: string) {
    const schedule = this.db.automations(gid).channelSchedules.find((item) => item.id === scheduleId);
    if (!schedule) throw new Error("Horário automático não encontrado.");
    return {
      embeds: [new EmbedBuilder().setColor(schedule.enabled ? 0x22c55e : 0x64748b).setTitle(`${this.emojis.text("clock", gid)} ${schedule.name}`).addFields(
        { name: "Status", value: schedule.enabled ? "Ativo" : "Pausado", inline: true },
        { name: "Fechar", value: schedule.lockTime, inline: true },
        { name: "Abrir", value: schedule.unlockTime, inline: true },
        { name: "Fuso", value: schedule.timezone, inline: true },
        { name: "Canais", value: schedule.channelIds.map((id) => `<#${id}>`).join(" ") || "Nenhum canal selecionado" },
        { name: "Mensagem ao fechar", value: truncate(schedule.lockMessage || "Sem mensagem", 1024) },
        { name: "Mensagem ao abrir", value: truncate(schedule.unlockMessage || "Sem mensagem", 1024) }
      )],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.views.button(gid, `admin:automations:schedule-toggle:${schedule.id}`, schedule.enabled ? "Pausar" : "Ativar", schedule.enabled ? "pause" : "approve", schedule.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
          this.views.button(gid, `admin:automations:schedule-channels:${schedule.id}`, "Selecionar canais", "message", ButtonStyle.Primary),
          this.views.button(gid, `admin:automations:schedule-edit:${schedule.id}`, "Editar horários e mensagens", "edit", ButtonStyle.Primary),
          this.views.button(gid, `admin:automations:schedule-delete:${schedule.id}`, "Excluir", "trash", ButtonStyle.Danger)
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(this.views.button(gid, "admin:automations:schedules", "Voltar", "back"))
      ]
    };
  }

  private channelScheduleChannelsView(gid: string, scheduleId: string) {
    const schedule = this.db.automations(gid).channelSchedules.find((item) => item.id === scheduleId);
    if (!schedule) throw new Error("Horário automático não encontrado.");
    const picker = new ChannelSelectMenuBuilder()
      .setCustomId(`admin:automations:schedule-channels-set:${schedule.id}`)
      .setPlaceholder("Selecione até 25 canais de texto")
      .setChannelTypes(ChannelType.GuildText)
      .setMinValues(1)
      .setMaxValues(25);
    if (schedule.channelIds.length) picker.setDefaultChannels(schedule.channelIds);
    return {
      embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle(`Canais • ${schedule.name}`).setDescription("Selecione todos os canais que devem ser fechados e abertos automaticamente por este horário.")],
      components: [
        new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(picker),
        new ActionRowBuilder<ButtonBuilder>().addComponents(this.views.button(gid, `admin:automations:schedules`, "Cancelar", "back"))
      ]
    };
  }

  private botMessageTemplate(gid: string, templateId: string): BotMessageTemplate {
    const template = this.db.state.messageTemplates[templateId];
    if (!template || template.guildId !== gid) throw new Error("Modelo de mensagem não encontrado.");
    return template;
  }

  private botMessageBasicModal(template?: BotMessageTemplate) {
    return modal(template ? `modal:message:basic:${template.id}` : "modal:message:create", template ? "Editar mensagem" : "Criar mensagem", [
      input("name", "Nome interno do modelo", template?.name ?? "Nova mensagem", TextInputStyle.Short, true, 80),
      input("content", "Texto superior", template?.content ?? "", TextInputStyle.Paragraph, false, 2000),
      input("title", "Título", template?.title ?? "", TextInputStyle.Short, false, 300),
      input("description", "Descrição", template?.description ?? "", TextInputStyle.Paragraph, false, 4000),
      input("color", "Cor hexadecimal", template?.color ?? this.db.state.brand.color, TextInputStyle.Short, true, 7)
    ]);
  }

  private botMessagesView(gid: string) {
    const templates = Object.values(this.db.state.messageTemplates).filter((item) => item.guildId === gid).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const components: Array<ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>> = [];
    if (templates.length) {
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId("admin:message:select").setPlaceholder("Selecione uma mensagem para editar").addOptions(
          templates.slice(0, 25).map((template) => new StringSelectMenuOptionBuilder()
            .setLabel(truncate(template.name, 100))
            .setDescription(truncate(`${template.title || "Sem título"} • ${template.links.length} botão(ões) • ${template.publications.length} publicação(ões)`, 100))
            .setValue(template.id)
            .setEmoji(this.emojis.component("message", gid)))
        )
      ));
    }
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      this.views.button(gid, "admin:message:create", "Criar mensagem", "plus", ButtonStyle.Success, templates.length >= 25),
      this.views.button(gid, "admin:home", "Voltar", "back")
    ));
    return {
      embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle(`${this.emojis.text("message", gid)} Mensagens do bot`).setDescription(
        `Crie mensagens completas em Components V2 com texto, título, descrição, banner, miniatura, rodapé, emojis e até cinco botões de link.\n\n**Modelos salvos:** ${templates.length}/25`
      )],
      components
    };
  }

  private botMessageDetail(gid: string, templateId: string) {
    const template = this.botMessageTemplate(gid, templateId);
    const publications = template.publications.map((item) => `<#${item.channelId}> • \`${item.messageId}\``).join("\n") || "Ainda não publicada";
    return {
      embeds: [new EmbedBuilder().setColor(colorNumber(template.color)).setTitle(`${this.emojis.text("message", gid)} ${template.name}`).setDescription(truncate(template.description || template.content || "Sem descrição", 4000)).addFields(
        { name: "Título", value: truncate(template.title || "Sem título", 1024), inline: true },
        { name: "Cor", value: template.color, inline: true },
        { name: "Botões", value: `${template.links.length}/5`, inline: true },
        { name: "Banner", value: template.bannerUrl ? "Configurado" : "Não definido", inline: true },
        { name: "Miniatura", value: template.thumbnailUrl ? "Configurada" : "Não definida", inline: true },
        { name: "Publicações", value: truncate(publications, 1024) },
        { name: "Links", value: template.links.map((link, index) => `${index + 1}. **${link.label}** — ${link.url}`).join("\n").slice(0, 1024) || "Nenhum botão de link" }
      )],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.views.button(gid, `admin:message:basic:${template.id}`, "Texto e título", "edit", ButtonStyle.Primary),
          this.views.button(gid, `admin:message:visual:${template.id}`, "Banner e miniatura", "image", ButtonStyle.Primary),
          this.views.button(gid, `admin:message:link-add:${template.id}`, "Adicionar link", "link", ButtonStyle.Secondary, template.links.length >= 5),
          this.views.button(gid, `admin:message:links-clear:${template.id}`, "Limpar links", "trash", ButtonStyle.Secondary, !template.links.length)
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.views.button(gid, `admin:message:preview:${template.id}`, "Pré-visualizar", "search", ButtonStyle.Secondary),
          this.views.button(gid, `admin:message:publish:${template.id}`, "Publicar / atualizar", "announcement", ButtonStyle.Success),
          this.views.button(gid, `admin:message:delete:${template.id}`, "Excluir modelo", "trash", ButtonStyle.Danger),
          this.views.button(gid, "admin:messages", "Voltar", "back")
        )
      ]
    };
  }

  private automationResponseDetail(gid: string, index: number) {
    const response = this.db.automations(gid).autoResponses[index];
    if (!response) throw new Error("Resposta automática não encontrada.");
    return {
      embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle("Resposta automática").addFields(
        { name: "Gatilho", value: truncate(response.trigger, 1024) },
        { name: "Correspondência", value: response.exact ? "A mensagem deve ser exatamente igual" : "A mensagem pode apenas conter o gatilho" },
        { name: "Resposta", value: truncate(response.response, 1024) }
      )],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.views.button(gid, `admin:automations:response-edit:${index}`, "Editar", "edit", ButtonStyle.Primary),
        this.views.button(gid, `admin:automations:response-exact:${index}`, response.exact ? "Usar correspondência parcial" : "Exigir correspondência exata", "settings", ButtonStyle.Secondary),
        this.views.button(gid, `admin:automations:response-delete:${index}`, "Excluir", "trash", ButtonStyle.Danger),
        this.views.button(gid, "admin:automations", "Voltar", "back", ButtonStyle.Secondary)
      )]
    };
  }
  private revenueView(gid: string) {
    const paidStatuses = new Set(["PAID", "DELIVERED", "AWAITING_DELIVERY"]);
    const paid = Object.values(this.db.state.orders).filter((order) => paidStatuses.has(order.status));
    const totalRevenue = paid.reduce((sum, order) => sum + order.totalCents, 0);
    const averageTicket = paid.length ? Math.round(totalRevenue / paid.length) : 0;
    const productTotals = new Map<string, { name: string; quantity: number; revenue: number }>();
    for (const order of paid) {
      for (const item of order.items) {
        const current = productTotals.get(item.productId) ?? { name: item.productName, quantity: 0, revenue: 0 };
        current.quantity += item.quantity;
        current.revenue += item.quantity * item.unitPriceCents;
        productTotals.set(item.productId, current);
      }
    }
    const top = [...productTotals.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 8);
    const stats = this.db.stats();
    return {
      embeds: [new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle(`${this.emojis.text("analytics", gid)} Rendimento de vendas`)
        .setDescription(`Resumo financeiro baseado nos pedidos aprovados e entregues.`)
        .addFields(
          { name: "Hoje", value: formatMoney(stats.revenueToday), inline: true },
          { name: "Últimos 30 dias", value: formatMoney(stats.revenue30d), inline: true },
          { name: "Faturamento total", value: formatMoney(totalRevenue), inline: true },
          { name: "Pedidos pagos", value: String(paid.length), inline: true },
          { name: "Ticket médio", value: formatMoney(averageTicket), inline: true },
          { name: "Clientes", value: String(stats.customers), inline: true },
          { name: "Produtos mais vendidos", value: top.map((item, index) => `${index + 1}. **${truncate(item.name, 55)}** — ${item.quantity} un. • ${formatMoney(item.revenue)}`).join("\n") || "Ainda não há vendas aprovadas." }
        )
        .setTimestamp()],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.views.button(gid, "admin:orders", "Ver pedidos", "invoice", ButtonStyle.Primary),
        this.views.button(gid, "admin:products", "Gerenciar produtos", "store"),
        this.views.button(gid, "admin:home", "Voltar", "back")
      )]
    };
  }

  private protectionView(gid: string) {
    const settings = this.db.protection(gid);
    return {
      embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle(`${this.emojis.text("shield", gid)} Proteção do servidor`).setDescription(`Anti-link: **${settings.antiLink ? "ativo" : "desativado"}**
Domínios permitidos: **${settings.allowedDomains.length}**
Anti-spam: **${settings.antiSpam ? "ativo" : "desativado"}** • ${settings.spamMessages} mensagens em ${settings.spamWindowSeconds}s • timeout ${settings.spamTimeoutSeconds}s
Convites: **${settings.blockInvites ? "bloqueados" : "permitidos"}**
Log de mensagens apagadas: **${settings.logDeletedMessages ? "ativo" : "desativado"}**
Log de mensagens editadas: **${settings.logEditedMessages ? "ativo" : "desativado"}**`)],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.views.button(gid, "admin:protection:toggle:links", settings.antiLink ? "Desativar anti-link" : "Ativar anti-link", settings.antiLink ? "off" : "on", settings.antiLink ? ButtonStyle.Danger : ButtonStyle.Success),
          this.views.button(gid, "admin:protection:domains", "Domínios permitidos", "link", ButtonStyle.Secondary),
          this.views.button(gid, "admin:protection:toggle:spam", settings.antiSpam ? "Desativar anti-spam" : "Ativar anti-spam", settings.antiSpam ? "off" : "on", settings.antiSpam ? ButtonStyle.Danger : ButtonStyle.Success),
          this.views.button(gid, "admin:protection:spam-limits", "Limites do anti-spam", "settings", ButtonStyle.Secondary)
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.views.button(gid, "admin:protection:toggle:invites", settings.blockInvites ? "Permitir convites" : "Bloquear convites", settings.blockInvites ? "off" : "on", settings.blockInvites ? ButtonStyle.Danger : ButtonStyle.Success),
          this.views.button(gid, "admin:protection:toggle:deleted", settings.logDeletedMessages ? "Desativar log apagadas" : "Ativar log apagadas", "transcript", ButtonStyle.Secondary),
          this.views.button(gid, "admin:protection:toggle:edited", settings.logEditedMessages ? "Desativar log editadas" : "Ativar log editadas", "edit", ButtonStyle.Secondary),
          this.views.button(gid, "admin:home", "Voltar", "back", ButtonStyle.Secondary)
        )
      ]
    };
  }
  private ordersAdminView(gid: string) {
    const pending = Object.values(this.db.state.orders)
      .filter((order) => order.guildId === gid && ["PENDING", "AWAITING_DELIVERY"].includes(order.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const actionable = pending.filter((order) => order.provider === "MANUAL_PIX" || order.status === "AWAITING_DELIVERY").slice(0, 3);
    const components: Array<ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>> = [];
    for (const order of actionable) {
      const shortId = order.id.slice(-8);
      components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        order.status === "AWAITING_DELIVERY"
          ? this.views.button(gid, `admin:order:complete:${order.id}`, `Concluir entrega • ${shortId}`, "approve", ButtonStyle.Success)
          : this.views.button(gid, `admin:order:approve:${order.id}`, `Aprovar pagamento • ${shortId}`, "approve", ButtonStyle.Success),
        ...(order.status === "PENDING" ? [this.views.button(gid, `admin:order:cancel:${order.id}`, `Cancelar • ${shortId}`, "reject", ButtonStyle.Danger)] : []),
        this.views.button(gid, `admin:order:${order.id}`, "Ver detalhes", "invoice", ButtonStyle.Secondary)
      ));
    }
    if (pending.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId("admin:order:select").setPlaceholder("Todos os pedidos pendentes").addOptions(
        pending.slice(0, 25).map((order) => new StringSelectMenuOptionBuilder()
          .setLabel(order.id)
          .setDescription(`${formatMoney(order.totalCents)} • ${order.status} • ${order.provider}`.slice(0, 100))
          .setValue(order.id)
          .setEmoji(this.emojis.component("invoice", gid)))
      )
    ));
    components.push(this.views.back(gid));
    return {
      embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle(`${this.emojis.text("invoice", gid)} Pedidos`).setDescription(
        `Pendentes: **${pending.filter((order) => order.status === "PENDING").length}** • aguardando entrega manual: **${pending.filter((order) => order.status === "AWAITING_DELIVERY").length}**\n\nAs ações dos pedidos mais recentes aparecem diretamente abaixo.`
      )],
      components
    };
  }
  private orderAdminDetail(gid: string, orderId: string) {
    const order = this.orders.get(orderId, gid);
    const action = order.status === "AWAITING_DELIVERY"
      ? this.views.button(gid, `admin:order:complete:${order.id}`, "Concluir entrega manual", "approve", ButtonStyle.Success)
      : this.views.button(gid, `admin:order:approve:${order.id}`, "Aprovar pagamento manual", "approve", ButtonStyle.Success, order.status !== "PENDING" || order.provider !== "MANUAL_PIX");
    return { embeds: [this.views.orderView(gid, order)], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      action,
      this.views.button(gid, `admin:order:cancel:${order.id}`, "Cancelar", "reject", ButtonStyle.Danger, order.status !== "PENDING"),
      this.views.button(gid, "admin:orders", "Voltar", "back")
    )] };
  }
  private giveawaysView(gid: string) { const active = Object.values(this.db.state.giveaways).filter((g) => g.status === "ACTIVE"); return { embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle(`${this.emojis.text("announcement", gid)} Sorteios`).setDescription(`Sorteios ativos: **${active.length}**\n${active.map((g) => `• ${g.prize} — <t:${Math.floor(Date.parse(g.endsAt) / 1000)}:R>`).join("\n") || "Nenhum sorteio ativo."}`)], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(this.views.button(gid, "admin:giveaway:create", "Criar sorteio", "announcement", ButtonStyle.Success), this.views.button(gid, "admin:home", "Voltar", "back"))] }; }
  private permissionsView(gid: string) {
    const p = this.db.guild(gid).permissions;
    const locks = this.db.guild(gid).locks;
    const roleList = (ids: string[]) => ids.map((id) => `<@&${id}>`).join(" ") || "Nenhum";
    const userList = (ids: string[]) => ids.map((id) => `<@${id}>`).join(" ") || "Nenhum";
    return {
      embeds: [new EmbedBuilder().setColor(0x3155ff).setTitle(`${this.emojis.text("shield", gid)} Permissões e bloqueios`).setDescription("Configure o acesso sem editar arquivos. O proprietário configurado e o dono do servidor nunca perdem acesso.").addFields(
        { name: "Administradores", value: `Usuários: ${userList(p.adminUserIds)}
Cargos: ${roleList(p.adminRoleIds)}` },
        { name: "Autorizados", value: `Usuários: ${userList(p.authorizedUserIds)}
Cargos: ${roleList(p.authorizedRoleIds)}` },
        { name: "Equipes específicas", value: `Suporte: ${roleList(p.supportRoleIds)}
Tickets: ${roleList(p.ticketRoleIds)}
Pagamentos: ${roleList(p.paymentRoleIds)}
Produtos: ${roleList(p.productRoleIds)}
Comandos administrativos: ${roleList(p.adminCommandRoleIds)}` },
        { name: "Lock", value: `Canais ignorados: **${locks.ignoredChannelIds.length}**
Cargos que continuam falando: **${locks.speakingRoleIds.length}**
Snapshots ativos: **${Object.keys(locks.snapshots).length}**` }
      )],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.views.button(gid, "admin:permissions:user:admins", "Usuários admin", "admin", ButtonStyle.Primary),
          this.views.button(gid, "admin:permissions:role:admins", "Cargos admin", "shield", ButtonStyle.Primary),
          this.views.button(gid, "admin:permissions:user:authorized", "Usuários autorizados", "user"),
          this.views.button(gid, "admin:permissions:role:authorized", "Cargos autorizados", "role")
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.views.button(gid, "admin:permissions:role:support", "Suporte", "support"),
          this.views.button(gid, "admin:permissions:role:tickets", "Tickets", "ticket"),
          this.views.button(gid, "admin:permissions:role:payments", "Pagamentos", "payment"),
          this.views.button(gid, "admin:permissions:role:products", "Produtos", "products"),
          this.views.button(gid, "admin:permissions:role:commands", "Comandos", "settings")
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.views.button(gid, "admin:locks:ignored", "Canais ignorados", "lock"),
          this.views.button(gid, "admin:locks:speaking", "Cargos liberados", "unlock"),
          this.views.button(gid, "admin:home", "Voltar", "back")
        )
      ]
    };
  }

  private backupsView(gid: string) {
    const backups = this.backups.list(gid);
    const rows: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> = [];
    if (backups.length) rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId("admin:backup:select").setPlaceholder("Selecione um backup").addOptions(backups.slice(0, 25).map((backup) => new StringSelectMenuOptionBuilder().setLabel(truncate(backup.name, 100)).setDescription(truncate(`${new Date(backup.createdAt).toLocaleString("pt-BR")} • ${Object.values(backup.counts).reduce((a, b) => a + b, 0)} registros`, 100)).setValue(backup.id).setEmoji(this.emojis.component("backup", gid))))));
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(this.views.button(gid, "admin:backup:create", "Criar backup", "backup", ButtonStyle.Success), this.views.button(gid, "admin:home", "Voltar", "back")));
    return { embeds: [new EmbedBuilder().setColor(0x3155ff).setTitle(`${this.emojis.text("backup", gid)} Backups do servidor`).setDescription(`Backups disponíveis: **${backups.length}**

O sistema salva estrutura, permissões, expressões, webhooks autorizados, dados do bot e mensagens acessíveis. Autoria, IDs e datas originais de mensagens não podem ser recriados exatamente.`)], components: rows };
  }

  private backupDetail(gid: string, backupId: string) {
    const backup = this.backups.get(gid, backupId);
    const counts = Object.entries(backup.counts).map(([key, value]) => `• ${key}: **${value}**`).join("\n") || "Sem contagens.";
    return { embeds: [new EmbedBuilder().setColor(0x3155ff).setTitle(`${this.emojis.text("backup", gid)} ${backup.name}`).setDescription(`ID: \`${backup.id}\`
Criado: <t:${Math.floor(Date.parse(backup.createdAt) / 1000)}:F>
Criado por: <@${backup.createdBy}>

${counts}

${backup.warnings.slice(0, 5).map((warning) => `⚠️ ${warning}`).join("\n")}`)], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      this.views.button(gid, `admin:backup:restore-plan:${backup.id}`, "Restaurar", "restore", ButtonStyle.Success),
      this.views.button(gid, `admin:backup:rename:${backup.id}`, "Renomear", "edit", ButtonStyle.Primary),
      this.views.button(gid, `admin:backup:delete:${backup.id}`, "Excluir", "trash", ButtonStyle.Danger),
      this.views.button(gid, "admin:backups", "Voltar", "back")
    )] };
  }

  private couponsView(gid: string) {
    const coupons = Object.values(this.db.state.coupons).filter((coupon) => coupon.guildId === gid).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const rows: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> = [];
    if (coupons.length) rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId("admin:coupon:select").setPlaceholder("Selecione um cupom").addOptions(coupons.slice(0, 25).map((coupon) => new StringSelectMenuOptionBuilder().setLabel(coupon.code).setDescription(truncate(`${coupon.active ? "Ativo" : "Desativado"} • ${coupon.type === "PERCENT" ? `${coupon.value}%` : formatMoney(coupon.value)} • ${coupon.uses}/${coupon.maxUses ?? "∞"}`, 100)).setValue(coupon.id).setEmoji(this.emojis.component("coupon", gid))))));
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(this.views.button(gid, "admin:coupon:create", "Criar cupom", "coupon", ButtonStyle.Success), this.views.button(gid, "admin:products", "Voltar", "back")));
    return { embeds: [new EmbedBuilder().setColor(0x3155ff).setTitle(`${this.emojis.text("coupon", gid)} Cupons`).setDescription(`Cupons cadastrados: **${coupons.length}**
O uso é registrado somente depois que o pagamento for aprovado.`)], components: rows };
  }

  private couponDetail(gid: string, couponId: string) {
    const coupon = this.products.getCoupon(gid, couponId);
    const usages = this.db.state.couponUsages.filter((usage) => usage.guildId === gid && usage.couponId === coupon.id);
    return { embeds: [new EmbedBuilder().setColor(coupon.active ? 0x22c55e : 0x64748b).setTitle(`${this.emojis.text("coupon", gid)} ${coupon.code}`).addFields(
      { name: "Desconto", value: coupon.type === "PERCENT" ? `${coupon.value}%` : formatMoney(coupon.value), inline: true },
      { name: "Pedido mínimo", value: formatMoney(coupon.minOrderCents), inline: true },
      { name: "Status", value: coupon.active ? "Ativo" : "Desativado", inline: true },
      { name: "Limites", value: `Total: ${coupon.uses}/${coupon.maxUses ?? "∞"}
Por usuário: ${coupon.perUserLimit || "sem limite"}`, inline: true },
      { name: "Período", value: `Início: ${coupon.startsAt ? `<t:${Math.floor(Date.parse(coupon.startsAt) / 1000)}:f>` : "imediato"}
Expiração: ${coupon.expiresAt ? `<t:${Math.floor(Date.parse(coupon.expiresAt) / 1000)}:f>` : "sem expiração"}`, inline: true },
      { name: "Escopo", value: `Produtos: ${coupon.productIds.length ? coupon.productIds.map((id) => this.db.state.products[id]?.name ?? id).join(", ") : "todos"}
Grupos: ${coupon.productGroups.join(", ") || "todos"}`, inline: false },
      { name: "Usuários recentes", value: usages.slice(0, 10).map((usage) => `<@${usage.userId}> • pedido \`${usage.orderId}\` • ${formatMoney(usage.discountCents)}`).join("\n") || "Nenhum uso aprovado." }
    ).setTimestamp()], components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.views.button(gid, `admin:coupon:toggle:${coupon.id}`, coupon.active ? "Desativar" : "Ativar", coupon.active ? "pause" : "approve", coupon.active ? ButtonStyle.Secondary : ButtonStyle.Success),
        this.views.button(gid, `admin:coupon:edit-basic:${coupon.id}`, "Código e desconto", "edit", ButtonStyle.Primary),
        this.views.button(gid, `admin:coupon:edit-rules:${coupon.id}`, "Limites e datas", "settings"),
        this.views.button(gid, `admin:coupon:edit-scope:${coupon.id}`, "Produtos e grupos", "products")
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(this.views.button(gid, `admin:coupon:delete:${coupon.id}`, "Excluir", "trash", ButtonStyle.Danger), this.views.button(gid, "admin:coupons", "Voltar", "back"))
    ] };
  }

  private ticketOptionsView(gid: string, panel: ReturnType<TicketService["getPanel"]>) {
    const options = [...panel.options].sort((a, b) => a.position - b.position);
    const components: Array<ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>> = [];
    if (options.length) {
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`admin:ticket:option-select:${panel.id}`)
          .setPlaceholder("Selecione uma opção para configurar")
          .addOptions(options.slice(0, 25).map((option) => {
            const item = new StringSelectMenuOptionBuilder()
              .setLabel(truncate(option.name, 100))
              .setDescription(truncate(`${option.active ? "Ativa" : "Desativada"} • ${option.description || "Sem descrição"}`, 100))
              .setValue(option.id);
            if (option.emojiSemantic) item.setEmoji(this.emojis.component(option.emojiSemantic, gid));
            return item;
          }))
      ));
    }
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      this.views.button(gid, `admin:ticket:option:add:${panel.id}`, "Adicionar opção", "plus", ButtonStyle.Success, panel.options.length >= 25),
      this.views.button(gid, `admin:ticket:${panel.id}`, "Voltar ao painel", "back")
    ));
    const tutorial = options.length ? "" :
      "\n\n**Como criar uma opção:**\n" +
      "1. Clique em **Adicionar opção**\n" +
      "2. Preencha o nome (ex: Suporte)\n" +
      "3. Defina o prefixo do canal (ex: suporte)\n" +
      "4. Configure a mensagem inicial\n" +
      "5. Clique em **Ativar** para habilitar\n" +
      "6. Publique o painel no canal desejado";
    return {
      embeds: [new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle(`Opções de atendimento • ${panel.name}`)
        .setDescription(options.length
          ? options.map((option, index) => `${index + 1}. ${option.emojiSemantic ? this.emojis.text(option.emojiSemantic, gid) : ""} **${option.name}** — ${option.active ? "ativa" : "desativada"}`).join("\n").slice(0, 4000)
          : `Nenhuma opção configurada.${tutorial}`)],
      components
    };
  }

  private ticketOptionDetail(gid: string, panelId: string, optionId: string) {
    const panel = this.tickets.getPanel(panelId);
    const option = panel.options.find((item) => item.id === optionId);
    if (!option) throw new Error("Opção não encontrada.");
    const emoji = option.emojiSemantic ? this.emojis.text(option.emojiSemantic, gid) : "Sem emoji";
    return {
      embeds: [new EmbedBuilder()
        .setColor(option.active ? 0x7c3aed : 0x64748b)
        .setTitle(`${option.emojiSemantic ? `${emoji} ` : ""}${option.name}`)
        .setDescription(option.description || "Sem descrição")
        .addFields(
          { name: "Status", value: option.active ? "Ativa" : "Desativada", inline: true },
          { name: "Categoria", value: option.categoryId ? `<#${option.categoryId}>` : "Geral", inline: true },
          { name: "Equipe", value: option.supportRoleIds.map((id) => `<@&${id}>`).join(" ") || "Geral", inline: true }
        )],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.views.button(gid, `admin:ticket:option-edit:${panelId}:${optionId}`, "Editar textos", "edit", ButtonStyle.Primary),
          this.views.button(gid, `admin:ticket:option-category:${panelId}:${optionId}`, "Categoria", "folder"),
          this.views.button(gid, `admin:ticket:option-roles:${panelId}:${optionId}`, "Cargos", "role"),
          this.views.button(gid, `admin:ticket:option-toggle:${panelId}:${optionId}:active`, option.active ? "Desativar" : "Ativar", option.active ? "off" : "on", option.active ? ButtonStyle.Danger : ButtonStyle.Success),
          this.views.button(gid, `admin:ticket:options:${panelId}`, "Voltar", "back")
        )
      ]
    };
  }
  private userOrdersEmbed(gid: string, userId: string) { const orders = this.orders.userOrders(userId, gid).slice(0, 10); return new EmbedBuilder().setColor(0x7c3aed).setTitle(`${this.emojis.text("invoice", gid)} Meus pedidos`).setDescription(orders.map((o) => `• **${o.id}** — ${formatMoney(o.totalCents)} — ${o.status}`).join("\n") || "Você ainda não possui pedidos."); }
  private applyPresence(gid?: string) { const b = gid ? this.db.brand(gid) : this.db.state.brand; this.client.user?.setPresence({ status: b.status, activities: [{ name: b.presenceText, type: ({ Playing: 0, Listening: 2, Watching: 3, Competing: 5 } as Record<string, number>)[b.presenceType] as never }] }); }

  private async runQuickSetup(i: ButtonInteraction, gid: string) {
    if (!i.guild) throw new Error("Servidor indisponível.");
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = i.guild;
    const current = this.db.guild(gid);

    const ensureRole = async (roleId: string, name: string) => {
      const existing = roleId ? await guild.roles.fetch(roleId).catch(() => undefined) : undefined;
      return existing ?? guild.roles.create({ name, reason: `Instalação rápida 166 Community por ${i.user.tag}` });
    };
    const ensureCategory = async (channelId: string, name: string) => {
      const existing = channelId ? await guild.channels.fetch(channelId).catch(() => undefined) : undefined;
      if (existing?.type === ChannelType.GuildCategory) return existing;
      return guild.channels.create({ name, type: ChannelType.GuildCategory, reason: `Instalação rápida 166 Community por ${i.user.tag}` });
    };
    const ensureText = async (channelId: string, name: string, privateToStaff = false) => {
      const existing = channelId ? await guild.channels.fetch(channelId).catch(() => undefined) : undefined;
      if (existing instanceof TextChannel) return existing;
      const botId = guild.members.me?.id ?? this.client.user?.id;
      const botOverwrite = botId ? [{ id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] }] : [];
      const overwrites = privateToStaff
        ? [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: staffRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            ...botOverwrite
          ]
        : [
            { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
            ...botOverwrite
          ];
      const channel = await guild.channels.create({ name, type: ChannelType.GuildText, permissionOverwrites: overwrites, reason: `Instalação rápida 166 Community por ${i.user.tag}` });
      if (!(channel instanceof TextChannel)) throw new Error(`Não foi possível criar o canal ${name}.`);
      return channel;
    };

    const staffRole = await ensureRole(current.staffRoleIds[0] ?? "", "166 Community • Equipe");
    const customerRole = await ensureRole(current.customerRoleId, "166 Community • Cliente");
    const openCategory = await ensureCategory(current.ticketCategoryId, "TICKETS ABERTOS");
    const closedCategory = await ensureCategory(current.closedTicketCategoryId, "TICKETS FECHADOS");
    const archiveCategory = await ensureCategory(current.archiveTicketCategoryId, "TICKETS ARQUIVADOS");
    const purchaseCategory = await ensureCategory(current.purchaseCategoryId, "COMPRAS PRIVADAS");
    const salesChannel = await ensureText(current.salesChannelId, "produtos");
    const salesLog = await ensureText(current.logChannelId, "logs-vendas", true);
    const ticketLog = await ensureText(current.ticketLogChannelId, "logs-tickets", true);
    const stockPanelChannel = await ensureText(current.stockRequest.panelChannelId ?? "", "pedir-stock");
    const stockRequestChannel = await ensureText(current.stockRequest.requestChannelId, "pedidos-de-stock", true);

    let panel = this.tickets.listPanels(gid)[0];
    if (!panel) panel = this.tickets.createPanel({ name: "Atendimento principal", title: this.db.brand(gid).ticketTitle, description: this.db.brand(gid).ticketDescription, mode: "SELECT", emojiSemantic: "ticket" }, i.user.id);
    if (!panel.options.length) {
      this.tickets.addOption(panel.id, { name: "Compras", description: "Dúvidas antes ou depois da compra", emojiSemantic: "store", supportRoleIds: [staffRole.id], channelPrefix: "compra" }, i.user.id);
      this.tickets.addOption(panel.id, { name: "Pagamentos", description: "Problemas ou confirmação de pagamento", emojiSemantic: "payment", supportRoleIds: [staffRole.id], channelPrefix: "pagamento" }, i.user.id);
      this.tickets.addOption(panel.id, { name: "Suporte", description: "Ajuda com produtos e entregas", emojiSemantic: "support", supportRoleIds: [staffRole.id], channelPrefix: "suporte" }, i.user.id);
      this.tickets.addOption(panel.id, { name: "Outros assuntos", description: "Falar diretamente com a equipe", emojiSemantic: "message", supportRoleIds: [staffRole.id], channelPrefix: "atendimento" }, i.user.id);
      panel = this.tickets.getPanel(panel.id);
    }
    const ticketChannel = await ensureText(panel.channelId ?? "", "abrir-ticket");

    const updateOrSend = async (channel: TextChannel, messageId: string | undefined, payload: Record<string, unknown>) => {
      if (messageId) {
        const existing = await channel.messages.fetch(messageId).catch(() => undefined);
        if (existing) { await existing.edit(payload as never); return existing; }
      }
      return channel.send(payload as never);
    };
    const ticketPayload = panel.messageId ? this.views.publicTicketPanelEdit(gid, panel) : this.views.publicTicketPanel(gid, panel);
    const ticketMessage = await updateOrSend(ticketChannel, panel.messageId, ticketPayload as never);
    const stockMessage = await updateOrSend(stockPanelChannel, current.stockRequest.panelMessageId, this.views.publicStockRequestPanel(gid) as never);

    this.db.updateGuild(gid, (settings) => {
      settings.staffRoleIds = [...new Set([...settings.staffRoleIds, staffRole.id])];
      settings.customerRoleId = customerRole.id;
      settings.ticketCategoryId = openCategory.id;
      settings.closedTicketCategoryId = closedCategory.id;
      settings.archiveTicketCategoryId = archiveCategory.id;
      settings.purchaseCategoryId = purchaseCategory.id;
      settings.salesChannelId = salesChannel.id;
      settings.logChannelId = salesLog.id;
      settings.ticketLogChannelId = ticketLog.id;
      settings.panelChannelId = undefined;
      settings.panelMessageId = undefined;
      settings.stockRequest.requestChannelId = stockRequestChannel.id;
      settings.stockRequest.panelChannelId = stockPanelChannel.id;
      settings.stockRequest.panelMessageId = stockMessage.id;
      settings.stockRequest.notifyRoleIds = [...new Set([...settings.stockRequest.notifyRoleIds, staffRole.id])];
      settings.stockRequest.enabled = true;
    });
    this.tickets.updatePanel(panel.id, { channelId: ticketChannel.id, messageId: ticketMessage.id }, i.user.id);
    void this.emojis.syncAutomatic(true).then(() => this.refreshPublishedMessages()).catch((error) => this.logger.warn("Falha ao atualizar painéis após sincronizar emojis.", error));

    await i.editReply({ embeds: [new EmbedBuilder().setColor(0x22c55e).setTitle("Estrutura criada com sucesso").setDescription(`Canal para painéis de produtos: ${salesChannel}
Tickets: ${ticketChannel}
Logs de vendas: ${salesLog}
Logs de tickets: ${ticketLog}
Painel Pedir Stock: ${stockPanelChannel}
Pedidos de stock: ${stockRequestChannel}
Equipe: ${staffRole}
Cliente: ${customerRole}

Agora use **/painel** para personalizar produtos, pagamentos, mensagens, imagens, emojis e automações.`).setTimestamp()] });
  }

  private async collectCertificate(i: ButtonInteraction) {
    if (!(i.channel instanceof TextChannel)) throw new Error("Use em um canal de texto.");
    await i.reply({ content: "Envie agora o arquivo **.p12** ou **.pfx** neste canal. A mensagem será apagada após o certificado ser salvo em `config/private-credentials.json`. Tempo: 2 minutos.", flags: MessageFlags.Ephemeral });
    const collected = await i.channel.awaitMessages({ filter: (m) => m.author.id === i.user.id && m.attachments.size > 0, max: 1, time: 120000 }); const message = collected.first(); if (!message) throw new Error("Tempo esgotado."); const attachment = message.attachments.first()!;
    if (!/\.(p12|pfx)$/i.test(attachment.name ?? "")) throw new Error("Envie um arquivo .p12 ou .pfx."); if (attachment.size > 2 * 1024 * 1024) throw new Error("Certificado maior que 2 MB.");
    const buffer = Buffer.from(await (await fetch(attachment.url)).arrayBuffer()); this.db.setSecret("efi_certificate_base64", buffer.toString("base64"), i.guildId ?? ""); if (i.guildId) this.db.payments(i.guildId).efiBank.certificateConfigured = true; this.db.save(); await message.delete().catch(() => undefined); await i.followUp({ content: "✅ Certificado salvo. A configuração continuará disponível depois que o bot for reiniciado.", flags: MessageFlags.Ephemeral });
  }
  private async collectImage(i: ButtonInteraction, label: string, apply: (url: string) => void | Promise<void>) {
    if (!(i.channel instanceof TextChannel)) throw new Error("Use em um canal de texto.");
    await i.reply({ content: `Envie agora a **${label}** em PNG, JPG, WEBP ou GIF. A imagem será salva permanentemente. Tempo: 2 minutos.`, flags: MessageFlags.Ephemeral });
    const collected = await i.channel.awaitMessages({ filter: (m) => m.author.id === i.user.id && m.attachments.size > 0, max: 1, time: 120000 });
    const message = collected.first(); if (!message) throw new Error("Tempo esgotado.");
    const attachment = message.attachments.first()!;
    const imageByName = /\.(png|jpe?g|webp|gif)$/i.test(attachment.name ?? "");
    if (!attachment.contentType?.startsWith("image/") && !imageByName) throw new Error("O arquivo precisa ser uma imagem PNG, JPG, WEBP ou GIF.");
    if (attachment.size > 8 * 1024 * 1024) throw new Error("Imagem maior que 8 MB.");
    const buffer = Buffer.from(await (await fetch(attachment.url)).arrayBuffer());
    const ext = (attachment.name?.split(".").pop() || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
    const localFilename = saveImage(buffer, ext);
    await apply(localFilename);
    await message.delete().catch(() => undefined);
    await i.followUp({ content: `✅ ${label.charAt(0).toUpperCase()}${label.slice(1)} salva com sucesso.`, flags: MessageFlags.Ephemeral });
  }

  private async collectAvatar(i: ButtonInteraction) {
    if (!(i.channel instanceof TextChannel)) throw new Error("Use em um canal de texto.");
    await i.reply({ content: "Envie agora uma imagem PNG/JPG para usar como avatar. A mensagem será apagada após a aplicação.", flags: MessageFlags.Ephemeral });
    const collected = await i.channel.awaitMessages({ filter: (m) => m.author.id === i.user.id && m.attachments.size > 0, max: 1, time: 120000 }); const message = collected.first(); if (!message) throw new Error("Tempo esgotado."); const attachment = message.attachments.first()!;
    if (!attachment.contentType?.startsWith("image/")) throw new Error("O arquivo precisa ser uma imagem."); if (attachment.size > 8 * 1024 * 1024) throw new Error("Imagem maior que 8 MB."); const buffer = Buffer.from(await (await fetch(attachment.url)).arrayBuffer()); await this.client.user?.setAvatar(buffer); await message.delete().catch(() => undefined); await i.followUp({ content: "✅ Avatar atualizado.", flags: MessageFlags.Ephemeral });
  }
}
