import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  EmbedBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  RoleSelectMenuBuilder,
  SectionBuilder,
  SeparatorBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  escapeMarkdown
} from "discord.js";
import type { JsonDatabase } from "../core/json-db.js";
import type { EmojiManager } from "../emojis/manager.js";
import type { BotMessageTemplate, ImapEmailProvider, Order, PaymentProviderName, Product, ProductField, SavedApplicationEmoji, StockRequest, TicketPanel, TicketPanelField } from "../types.js";
import { colorNumber, formatMoney, truncate } from "../core/utils.js";
import type { ProductService } from "../services/products.js";
import type { TicketService } from "../services/tickets.js";
import { bankProfile, IMAP_EMAIL_PRESETS } from "../services/imap-profiles.js";
import { checkedDiscordPayload } from "./payload-validator.js";
import { isLocalImage, localImagePath, localToAttachmentUrl } from "../core/image-store.js";

const bstyle = (name: Product["buttonStyle"]) => ({ PRIMARY: ButtonStyle.Primary, SECONDARY: ButtonStyle.Secondary, SUCCESS: ButtonStyle.Success, DANGER: ButtonStyle.Danger }[name]);

export class Views {
  private disabledButtonSequence = 0;
  constructor(private readonly db: JsonDatabase, private readonly emojis: EmojiManager, private readonly products: ProductService, private readonly tickets: TicketService) {}

  private automaticDeliveryEmojiSequence(guildId: string): { sequence: string; missing: string[] } {
    // Os sete recortes originais do public.zip formam uma única faixa quando
    // publicados lado a lado no Text Display do Components V2.
    const semantics = Array.from({ length: 7 }, (_, index) => `entrega${index}`);
    const missing = this.emojis.missing(semantics, guildId);
    return {
      sequence: missing.length ? "" : semantics.map((semantic) => this.emojis.text(semantic, guildId)).join(""),
      missing
    };
  }
  private base(title: string, description = "", guildId?: string) {
    const brand = guildId ? this.db.brand(guildId) : this.db.state.brand;
    const embed = new EmbedBuilder()
      .setColor(colorNumber(brand.color))
      .setTitle(truncate(title || "166 Community", 256))
      .setDescription(truncate(description || " ", 4096))
      .setFooter({ text: truncate(brand.footer || "166 Community", 2048) })
      .setTimestamp();
    if (brand.bannerUrl) embed.setImage(brand.bannerUrl);
    if (brand.logoUrl) embed.setThumbnail(brand.logoUrl);
    return embed;
  }

  /**
   * Converte qualquer tela administrativa antiga (embed + linhas de controles)
   * para um único Container V2. O painel inteiro passa a ter uma só moldura:
   * banner, textos, campos e componentes não se separam durante a navegação.
   */
  adminPage(guildId: string, payload: { content?: unknown; embeds?: unknown[]; components?: unknown[] }, includeDefaultBanner = true) {
    const brand = this.db.brand(guildId);
    const container = new ContainerBuilder().setAccentColor(colorNumber(brand.color));
    const bannerUrl = /^https?:\/\//i.test(brand.bannerUrl) ? brand.bannerUrl : includeDefaultBanner ? "attachment://panel-banner.png" : "";
    if (bannerUrl) {
      container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(bannerUrl).setDescription(truncate(`${brand.name} • painel administrativo`, 1000))
      ));
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    }

    const textBlocks: string[] = [];
    const directContent = String(payload.content ?? "").trim();
    if (directContent) textBlocks.push(directContent);
    const extraMedia: string[] = [];
    for (const source of payload.embeds ?? []) {
      const embed = source instanceof EmbedBuilder
        ? source.toJSON()
        : source && typeof source === "object" && "toJSON" in source && typeof (source as { toJSON?: unknown }).toJSON === "function"
          ? ((source as { toJSON(): Record<string, unknown> }).toJSON())
          : source as Record<string, unknown>;
      if (!embed || typeof embed !== "object") continue;
      const title = String(embed.title ?? "").trim();
      const description = String(embed.description ?? "").trim();
      if (title || description) textBlocks.push([title ? `## ${title}` : "", description].filter(Boolean).join("\n"));
      const fields = Array.isArray(embed.fields) ? embed.fields as Array<Record<string, unknown>> : [];
      for (const field of fields) {
        const name = String(field.name ?? "Informação").trim();
        const value = String(field.value ?? "-").trim();
        textBlocks.push(`### ${name}\n${value}`);
      }
      const footer = embed.footer && typeof embed.footer === "object" ? String((embed.footer as Record<string, unknown>).text ?? "").trim() : "";
      if (footer) textBlocks.push(`-# ${footer}`);
      const imageUrl = embed.image && typeof embed.image === "object" ? String((embed.image as Record<string, unknown>).url ?? "") : "";
      if (/^https?:\/\//i.test(imageUrl) && imageUrl !== brand.bannerUrl) extraMedia.push(imageUrl);
    }
    if (!textBlocks.length) textBlocks.push(`## ${brand.name}\nPainel administrativo`);
    for (const block of textBlocks) {
      for (let offset = 0; offset < block.length; offset += 3900) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(block.slice(offset, offset + 3900)));
      }
    }
    for (const url of [...new Set(extraMedia)].slice(0, 3)) {
      container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(url)));
    }
    const rows = payload.components ?? [];
    if (rows.length) container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    for (const row of rows) container.addActionRowComponents(row as never);
    return checkedDiscordPayload({
      flags: MessageFlags.IsComponentsV2 as const,
      components: [container]
    }, "painel administrativo Components V2");
  }

  adminPageEdit(guildId: string, payload: { content?: unknown; embeds?: unknown[]; components?: unknown[] }, includeDefaultBanner = true) {
    return { ...this.adminPage(guildId, payload, includeDefaultBanner), content: null, embeds: [] };
  }
  button(guildId: string, id: string, label: string, semantic: string, style = ButtonStyle.Secondary, disabled = false) {
    if (!id.trim()) throw new Error("Um botão foi criado sem custom_id.");
    if (id.length > 100) throw new Error(`custom_id de botão excede 100 caracteres: ${id}`);
    // O Discord exige custom_id exclusivo até para botões desativados. Paginações
    // com uma única página costumavam gerar o mesmo ID para "Anterior" e
    // "Próxima". IDs de no-op tornam cada controle desativado inequivocamente
    // único sem alterar nenhuma rota clicável.
    const customId = disabled
      ? `noop:${(++this.disabledButtonSequence).toString(36)}:${id}`.slice(0, 100)
      : id;
    const button = new ButtonBuilder().setCustomId(customId).setLabel(truncate(label || "Ação", 80)).setStyle(style).setDisabled(disabled);
    if (semantic.trim()) button.setEmoji(this.emojis.component(semantic, guildId));
    return button;
  }
  back(guildId: string, to = "admin:home") { return new ActionRowBuilder<ButtonBuilder>().addComponents(this.button(guildId, to, "Voltar", "back")); }

  adminHome(guildId: string, username: string) {
    const stats = this.db.stats(guildId);
    const guild = this.db.guild(guildId);
    const emoji = (semantic: string) => this.emojis.text(semantic, guildId);
    const emojiStatus = this.emojis.status;
    const paymentLabels: Record<string, string> = {
      MERCADO_PAGO: "Mercado Pago",
      EFI_BANK: "Efí Bank",
      STRIPE: "Stripe PIX",
      MISTIC_PAY: "MisticPay",
      PURIN_CASH: "Purin Cash",
      IMAP_PIX: "IMAP PIX",
      MANUAL_PIX: "PIX manual"
    };
    const configuredChannels = [
      guild.salesChannelId,
      guild.logChannelId,
      guild.ticketLogChannelId,
      guild.ticketCategoryId
    ].filter(Boolean).length;

    const embed = this.base(
      `${emoji("home")} Central de Controle • ${this.db.brand(guildId).name}`,
      `Bem-vindo, **${username}**.

Use os atalhos para as tarefas principais ou abra qualquer módulo pelo menu **Todas as áreas**.`,
      guildId
    )
      .addFields(
        {
          name: `${emoji("products")} Produtos e vendas`,
          value: [
            `Produtos ativos: **${stats.activeProducts}**`,
            `Itens disponíveis: **${stats.availableStock}**`,
            `Painéis de ticket: **${Object.values(this.db.state.ticketPanels).filter((panel) => panel.guildId === guildId).length}**`
          ].join("\n"),
          inline: true
        },
        {
          name: `${emoji("revenue")} Financeiro`,
          value: [
            `Hoje: **${formatMoney(stats.revenueToday)}**`,
            `Últimos 30 dias: **${formatMoney(stats.revenue30d)}**`,
            `Pedidos pendentes: **${stats.pendingOrders}**`
          ].join("\n"),
          inline: true
        },
        {
          name: `${emoji("ticket")} Atendimento`,
          value: [
            `Tickets abertos: **${stats.openTickets}**`,
            `Equipe configurada: **${guild.staffRoleIds.length ? "sim" : "não"}**`,
            `Canais essenciais: **${configuredChannels}/4**`
          ].join("\n"),
          inline: true
        },
        {
          name: `${emoji("settings")} Sistema`,
          value: [
            `Emojis do bot: **${emojiStatus.installed}/${emojiStatus.total}**${emojiStatus.syncing ? ` • instalando ${emojiStatus.completed}/${emojiStatus.total}` : ""}`,
            `Emojis salvos: **${Object.keys(this.db.state.savedEmojis).length}**`,
            `Pedidos de stock: **${Object.values(this.db.state.stockRequests).filter((request) => request.guildId === guildId && request.status === "PENDING").length} pendentes**`,
            `Pagamentos: **${paymentLabels[this.db.payments(guildId).defaultProvider] ?? this.db.payments(guildId).defaultProvider}**`
          ].join("\n"),
          inline: false
        }
      );

    if (!this.db.brand(guildId).bannerUrl) embed.setImage("attachment://panel-banner.png");

    const navigation = new StringSelectMenuBuilder()
      .setCustomId("admin:navigate")
      .setPlaceholder("Todas as áreas • escolha onde deseja entrar")
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel("Produtos e vendas").setDescription("Crie painéis individuais de venda, estoque e publicação").setValue("products").setEmoji(this.emojis.component("products", guildId)),
        new StringSelectMenuOptionBuilder().setLabel("Pedidos").setDescription("Acompanhar, aprovar e gerenciar pedidos").setValue("orders").setEmoji(this.emojis.component("invoice", guildId)),
        new StringSelectMenuOptionBuilder().setLabel("Pagamentos").setDescription("7 integrações PIX, credenciais e testes de API").setValue("payments").setEmoji(this.emojis.component("payment", guildId)),
        new StringSelectMenuOptionBuilder().setLabel("Tickets").setDescription("Painéis, opções e atendimento").setValue("tickets").setEmoji(this.emojis.component("ticket", guildId)),
        new StringSelectMenuOptionBuilder().setLabel("Mensagens do bot").setDescription("Monte mensagens com título, banner, miniatura e links").setValue("messages").setEmoji(this.emojis.component("message", guildId)),
        new StringSelectMenuOptionBuilder().setLabel("Pedir Stock").setDescription("Painel público e solicitações dos clientes").setValue("stock_requests").setEmoji(this.emojis.component("stock_request", guildId)),
        new StringSelectMenuOptionBuilder().setLabel("Salvar Emojis").setDescription("Adicionar, listar, copiar e remover emojis da aplicação").setValue("saved_emojis").setEmoji(this.emojis.component("saved_emoji", guildId)),
        new StringSelectMenuOptionBuilder().setLabel("Rendimento").setDescription("Faturamento, pedidos e desempenho").setValue("revenue").setEmoji(this.emojis.component("analytics", guildId)),
        new StringSelectMenuOptionBuilder().setLabel("Personalização").setDescription("Marca, banner, avatar, presença e mensagens").setValue("personalize").setEmoji(this.emojis.component("customize", guildId)),
        new StringSelectMenuOptionBuilder().setLabel("Emojis").setDescription("Instalação, catálogo e mapeamento").setValue("emojis").setEmoji(this.emojis.component("emoji", guildId)),
        new StringSelectMenuOptionBuilder().setLabel("Automações").setDescription("Boas-vindas, autorole e respostas").setValue("automations").setEmoji(this.emojis.component("automation", guildId)),
        new StringSelectMenuOptionBuilder().setLabel("Proteção").setDescription("Anti-link, anti-spam e registros").setValue("protection").setEmoji(this.emojis.component("protection", guildId)),
        new StringSelectMenuOptionBuilder().setLabel("Sorteios").setDescription("Criar e gerenciar sorteios").setValue("giveaways").setEmoji(this.emojis.component("giveaway", guildId)),
        new StringSelectMenuOptionBuilder().setLabel("Canais e cargos").setDescription("Permissões, categorias e canais do bot").setValue("channels").setEmoji(this.emojis.component("settings", guildId)),
        new StringSelectMenuOptionBuilder().setLabel("Cupons").setDescription("Criar e controlar descontos").setValue("coupons").setEmoji(this.emojis.component("coupon", guildId)),
        new StringSelectMenuOptionBuilder().setLabel("Permissões").setDescription("Usuários, cargos e níveis de acesso").setValue("permissions").setEmoji(this.emojis.component("shield", guildId)),
        new StringSelectMenuOptionBuilder().setLabel("Backups do servidor").setDescription("Criar, listar e restaurar backups").setValue("backups").setEmoji(this.emojis.component("backup", guildId))
      );

    return {
      embeds: [embed],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.button(guildId, "admin:products", "Produtos", "products", ButtonStyle.Primary),
          this.button(guildId, "admin:orders", "Pedidos", "invoice", ButtonStyle.Primary),
          this.button(guildId, "admin:payments", "Pagamentos", "payment", ButtonStyle.Primary),
          this.button(guildId, "admin:revenue", "Rendimento", "analytics", ButtonStyle.Primary),
          this.button(guildId, "admin:coupons", "Cupons", "coupon", ButtonStyle.Primary)
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.button(guildId, "admin:tickets", "Tickets", "ticket", ButtonStyle.Success),
          this.button(guildId, "admin:stock-requests", "Pedir Stock", "stock_request", ButtonStyle.Success),
          this.button(guildId, "admin:saved-emojis", "Salvar Emojis", "saved_emoji", ButtonStyle.Success),
          this.button(guildId, "admin:giveaways", "Sorteios", "giveaway", ButtonStyle.Success)
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.button(guildId, "admin:personalize", "Personalização", "customize"),
          this.button(guildId, "admin:channels", "Canais e Cargos", "settings"),
          this.button(guildId, "admin:automations", "Automações", "automation"),
          this.button(guildId, "admin:protection", "Proteção", "protection"),
          this.button(guildId, "admin:permissions", "Permissões", "shield")
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.button(guildId, "admin:emojis", "Emojis", "emoji"),
          this.button(guildId, "admin:backups", "Backups", "backup"),
          this.button(guildId, "admin:quick-setup", "Instalação Rápida", "config", ButtonStyle.Success)
        ),
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(navigation)
      ]
    };
  }

  productsHome(guildId: string, page = 0) {
    const all = this.products.list(false, guildId);
    const slice = all.slice(page * 25, page * 25 + 25);
    const embed = this.base(
      `${this.emojis.text("products", guildId)} Produtos e painéis de venda`,
      `Cada produto possui campos próprios. Com **1 campo**, o painel mostra um botão de compra. Com **2 ou mais campos**, o bot cria automaticamente um menu select com preço, descrição e emoji de cada opção.

**Produtos cadastrados:** ${all.length}`,
      guildId
    );
    const components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, "admin:product:create", "Criar produto", "product_add", ButtonStyle.Success),
        this.button(guildId, "admin:restock", "Avisos de restock", "announcement", ButtonStyle.Primary),
        this.button(guildId, "admin:coupons", "Cupons", "coupon")
      )
    ];
    if (slice.length) {
      const select = new StringSelectMenuBuilder()
        .setCustomId(`admin:product:select:${page}`)
        .setPlaceholder("Selecione um produto para editar")
        .addOptions(slice.map((product) => {
          const activeFields = this.products.activeFields(product);
          return new StringSelectMenuOptionBuilder()
            .setLabel(truncate(product.name, 100))
            .setDescription(truncate(`${activeFields.length} campo(s) • estoque ${this.products.stockCount(product.id)} • ${product.publications.length} publicação(ões)`, 100))
            .setValue(product.id)
            .setEmoji(this.emojis.component(product.emojiSemantic, guildId));
        }));
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
    }
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      this.button(guildId, `admin:products:${Math.max(0, page - 1)}`, "Anterior", "back", ButtonStyle.Secondary, page === 0),
      this.button(guildId, `admin:products:${page + 1}`, "Próxima", "catalog", ButtonStyle.Secondary, (page + 1) * 25 >= all.length),
      this.button(guildId, "admin:home", "Início", "home")
    ));
    return { embeds: [embed], components };
  }

  restockSettings(guildId: string) {
    const settings = this.db.guild(guildId).restockAnnouncements;
    const history = Object.values(this.db.state.restockAnnouncements).filter((entry) => entry.guildId === guildId);
    const sent = history.filter((entry) => entry.status === "SENT").length;
    const failed = history.filter((entry) => entry.status === "FAILED").length;
    return {
      embeds: [this.base(
        `${this.emojis.text("announcement", guildId)} Avisos automáticos de restock`,
        "Escolha um canal e o bot anunciará cada reposição feita pelo painel, informando produto, opção, quantidade adicionada e estoque total.",
        guildId
      ).addFields(
        { name: "Status", value: settings.enabled ? "🟢 Ativado" : "⚫ Desativado", inline: true },
        { name: "Canal", value: settings.channelId ? `<#${settings.channelId}>` : "Não configurado", inline: true },
        { name: "Cargo mencionado", value: settings.mentionRoleId ? `<@&${settings.mentionRoleId}>` : "Nenhum", inline: true },
        { name: "Título", value: settings.title, inline: true },
        { name: "Histórico", value: `${sent} enviado(s) • ${failed} falha(s)`, inline: true },
        { name: "Banner do produto", value: settings.includeProductBanner ? "Incluído quando existir" : "Desativado", inline: true },
        { name: "Mensagem", value: truncate(settings.message, 1000), inline: false }
      )],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.button(guildId, "admin:restock:channel", "Escolher canal", "message", ButtonStyle.Primary),
          this.button(guildId, "admin:restock:role", "Cargo para mencionar", "role"),
          this.button(guildId, "admin:restock:edit", "Editar mensagem", "edit"),
          this.button(guildId, "admin:restock:toggle", settings.enabled ? "Desativar" : "Ativar", settings.enabled ? "off" : "on", settings.enabled ? ButtonStyle.Danger : ButtonStyle.Success)
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.button(guildId, "admin:restock:banner", settings.includeProductBanner ? "Ocultar banner" : "Mostrar banner", "image"),
          this.button(guildId, "admin:products", "Voltar aos produtos", "back")
        )
      ]
    };
  }

  productDetail(guildId: string, product: Product) {
    const activeFields = this.products.activeFields(product);
    const mode = activeFields.length > 1 ? "Menu select automático" : "Botão de compra automático";
    const demoStatus = product.demonstrationEnabled && product.demonstrationUrl ? `Ativa • ${product.demonstrationLabel}` : "Desativada";
    const deliveryMissing = product.deliveryType === "STOCK" ? this.emojis.missing(Array.from({ length: 7 }, (_, index) => `entrega${index}`), guildId) : [];
    const embed = this.base(`${this.emojis.text(product.emojiSemantic, guildId)} ${product.name}`, product.description, guildId)
      .setColor(colorNumber(product.color))
      .addFields(
        { name: "ID", value: `\`${product.id}\``, inline: true },
        { name: "Campos", value: `${activeFields.length} ativo(s) • ${product.fields.length} total`, inline: true },
        { name: "Estoque total", value: String(this.products.stockCount(product.id)), inline: true },
        { name: "Publicações", value: `${product.publications.length} mensagem(ns)`, inline: true },
        { name: "Modo público", value: mode, inline: true },
        { name: "Demonstração", value: demoStatus, inline: true },
        { name: "Entrega", value: product.deliveryType === "STOCK" ? `${this.emojis.text("truck", guildId)} Automática` : product.deliveryType === "ROLE" ? `${this.emojis.text("role", guildId)} Cargo automático` : `${this.emojis.text("support", guildId)} Manual`, inline: true },
        { name: "Limites", value: `Mínimo: ${product.minQuantity} • Máximo: ${product.maxQuantity} • Por usuário: ${product.perUserLimit || "sem limite"}`, inline: false },
        { name: "Categoria/grupo de cupom", value: product.couponGroup || "Nenhum", inline: true },
        { name: "Status", value: product.active ? "Ativo" : "Inativo", inline: true },
        ...(product.deliveryType === "STOCK" ? [{ name: "Emojis ENTREGA AUTOMÁTICA", value: deliveryMissing.length ? `Ausentes: ${deliveryMissing.map((name) => `\`${name}\``).join(", ")}. Use **Emojis → Instalar/corrigir**.` : "Os 7 emojis originais do public.zip estão instalados na aplicação.", inline: false }] : [])
      );
    if (product.imageUrl) embed.setThumbnail(product.imageUrl);
    if (product.bannerUrl) embed.setImage(product.bannerUrl);
    if (product.deliveryType === "STOCK") {
      const deliveryVisual = this.automaticDeliveryEmojiSequence(guildId);
      if (deliveryVisual.sequence) {
        embed.addFields({ name: "\u200B", value: `## ${deliveryVisual.sequence}`, inline: false });
      }
    }
    return { embeds: [embed], attachments: [], components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, `admin:product:basic:${product.id}`, "Descrição", "product_edit"),
        this.button(guildId, `admin:product:visual:${product.id}`, "Banner e visual", "image"),
        this.button(guildId, `admin:product:fields:${product.id}`, "Campos / Estoque", "stock", ButtonStyle.Primary),
        this.button(guildId, `admin:product:purchase:${product.id}`, "Texto da compra", "cart", ButtonStyle.Primary),
        this.button(guildId, `admin:product:demo:${product.id}`, "Demonstração", "information", ButtonStyle.Primary)
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, `admin:product:emoji:${product.id}:0`, "Emoji do produto", "emoji"),
        this.button(guildId, `admin:product:delivery:${product.id}`, "Entrega / Termos", "delivery"),
        this.button(guildId, `admin:product:publish:${product.id}`, "Publicar mensagem", "catalog", ButtonStyle.Success),
        this.button(guildId, `admin:product:update-message:${product.id}`, "Atualizar mensagem", "refresh", ButtonStyle.Success, product.publications.length === 0),
        this.button(guildId, `admin:product:toggle:${product.id}`, product.active ? "Desativar" : "Ativar", product.active ? "reject" : "approve", product.active ? ButtonStyle.Danger : ButtonStyle.Success)
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, `admin:product:image-upload:${product.id}`, "Enviar miniatura", "upload"),
        this.button(guildId, `admin:product:banner-upload:${product.id}`, "Enviar banner", "image"),
        this.button(guildId, `admin:product:duplicate:${product.id}`, "Duplicar", "product_duplicate"),
        this.button(guildId, `admin:product:delete:${product.id}`, "Excluir", "product_delete", ButtonStyle.Danger),
        this.button(guildId, "admin:products", "Voltar", "back")
      )
    ] };
  }

  productFieldsView(guildId: string, product: Product) {
    const fields = product.fields;
    const lines = fields.map((field, index) => {
      const stock = this.products.stockCount(product.id, "AVAILABLE", field.id);
      const mode = field.stockMode === "GHOST" ? "fantasma" : "individual";
      return `${index + 1}. ${this.emojis.text(field.emoji || "cart", guildId)} **${field.name}** — ${formatMoney(field.priceCents)} • stock ${stock} (${mode})${field.active ? "" : " • inativo"}`;
    });
    const embed = this.base(
      `${this.emojis.text("stock", guildId)} Campos • ${product.name}`,
      `${lines.join("\n") || "Nenhum campo configurado."}

Com **1 campo ativo**, o cliente compra por botão. Com **2 ou mais**, o painel vira select automaticamente.`,
      guildId
    );
    const components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> = [];
    if (fields.length) {
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`admin:product:field-select:${product.id}`)
          .setPlaceholder("Abrir um campo para editar preço, emoji e stock")
          .addOptions(fields.slice(0, 25).map((field) => new StringSelectMenuOptionBuilder()
            .setLabel(truncate(field.name, 100))
            .setDescription(truncate(`${formatMoney(field.priceCents)} • stock ${this.products.stockCount(product.id, "AVAILABLE", field.id)} • ${field.stockMode === "GHOST" ? "fantasma" : "individual"}`, 100))
            .setValue(field.id)
            .setEmoji(this.emojis.component(field.emoji || "cart", guildId))))
      ));
    }
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      this.button(guildId, `admin:product:field-add:${product.id}`, "Adicionar campo", "plus", ButtonStyle.Success, fields.length >= 25),
      this.button(guildId, `admin:product:${product.id}`, "Voltar ao produto", "back")
    ));
    return { embeds: [embed], components };
  }

  productFieldDetail(guildId: string, product: Product, field: ProductField) {
    const available = this.products.stockCount(product.id, "AVAILABLE", field.id);
    const reserved = this.products.stockCount(product.id, "RESERVED", field.id);
    const sold = this.products.stockCount(product.id, "SOLD", field.id);
    const embed = this.base(`${this.emojis.text(field.emoji || "cart", guildId)} ${field.name}`, field.description || "Sem descrição curta.", guildId)
      .addFields(
        { name: "Preço", value: formatMoney(field.priceCents), inline: true },
        { name: "Preço anterior", value: field.compareAtCents ? formatMoney(field.compareAtCents) : "Não definido", inline: true },
        { name: "Status", value: field.active ? "Ativo" : "Inativo", inline: true },
        { name: "Tipo de stock", value: field.stockMode === "GHOST" ? "Stock fantasma" : "Itens individuais", inline: true },
        { name: "Disponível", value: String(available), inline: true },
        { name: "Reservado / vendido", value: `${reserved} / ${sold}`, inline: true },
        { name: "Emoji", value: `\`${field.emoji || "cart"}\``, inline: false }
      );
    return { embeds: [embed], components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, `admin:product:field-edit:${product.id}:${field.id}`, "Editar campo", "product_edit", ButtonStyle.Primary),
        this.button(guildId, `admin:product:field-emoji:${product.id}:${field.id}:0`, "Escolher emoji", "emoji", ButtonStyle.Primary),
        this.button(guildId, `admin:product:field-stock:${product.id}:${field.id}`, "Gerenciar stock", "stock", ButtonStyle.Success),
        this.button(guildId, `admin:product:field-toggle:${product.id}:${field.id}`, field.active ? "Desativar" : "Ativar", field.active ? "reject" : "approve", field.active ? ButtonStyle.Danger : ButtonStyle.Success)
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, `admin:product:field-delete:${product.id}:${field.id}`, "Excluir campo", "trash", ButtonStyle.Danger, product.fields.length <= 1),
        this.button(guildId, `admin:product:fields:${product.id}`, "Voltar aos campos", "back")
      )
    ] };
  }

  stockView(guildId: string, product: Product, field?: ProductField) {
    const selected = field ?? this.products.getField(product.id);
    const available = this.products.stockCount(product.id, "AVAILABLE", selected.id);
    const reserved = this.products.stockCount(product.id, "RESERVED", selected.id);
    const sold = this.products.stockCount(product.id, "SOLD", selected.id);
    const description = selected.stockMode === "GHOST"
      ? `**Stock fantasma ativo**
Você salva um único conteúdo e define uma quantidade virtual. Todas as unidades entregam exatamente o mesmo conteúdo.

Disponível: **${available}**
Reservado: **${reserved}**
Vendido: **${sold}**`
      : `**Stock individual**
Cada linha adicionada é entregue uma única vez.

Disponível: **${available}**
Reservado: **${reserved}**
Vendido: **${sold}**`;
    return { embeds: [this.base(`${this.emojis.text("stock", guildId)} Stock • ${product.name} • ${selected.name}`, description, guildId)], components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, `admin:stock:add:${product.id}:${selected.id}`, "Adicionar itens", "stock_add", ButtonStyle.Success, selected.stockMode === "GHOST"),
        this.button(guildId, `admin:stock:ghost:${product.id}:${selected.id}`, "Configurar stock fantasma", "automation", ButtonStyle.Primary),
        this.button(guildId, `admin:stock:unique:${product.id}:${selected.id}`, "Usar stock individual", "stock", ButtonStyle.Secondary, selected.stockMode === "UNIQUE"),
        this.button(guildId, `admin:stock:clear:${product.id}:${selected.id}`, "Limpar disponíveis", "stock_clear", ButtonStyle.Danger),
        this.button(guildId, `admin:product:field:${product.id}:${selected.id}`, "Voltar", "back")
      )
    ] };
  }

  storeCatalog(guildId: string, page = 0) {
    const all = this.products.list(true, guildId); const slice = all.slice(page * 25, page * 25 + 25);
    const embed = this.base(`${this.emojis.text("store", guildId)} ${this.db.brand(guildId).storeTitle}`, this.db.brand(guildId).storeDescription, guildId)
      .addFields({ name: "Produtos disponíveis", value: slice.length ? slice.map((p) => `**${p.name}** — ${formatMoney(p.priceCents)}${p.deliveryType === "STOCK" ? ` • ${this.products.stockCount(p.id)} em estoque` : ""}`).join("\n").slice(0, 1024) : "Nenhum produto disponível." });
    const components: Array<ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>> = [];
    if (slice.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`store:select:${page}`).setPlaceholder("Escolha um produto").addOptions(slice.map((p) => new StringSelectMenuOptionBuilder().setLabel(truncate(p.name, 100)).setDescription(truncate(`${formatMoney(this.products.getField(p.id).priceCents)} • ${this.products.activeFields(p).length} opção(ões)`, 100)).setValue(p.id).setEmoji(this.emojis.component(p.emojiSemantic, guildId))))));
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      this.button(guildId, "store:cart", "Meu carrinho", "cart", ButtonStyle.Primary),
      this.button(guildId, "store:orders", "Meus pedidos", "invoice"),
      this.button(guildId, `store:page:${Math.max(0, page - 1)}`, "Anterior", "back", ButtonStyle.Secondary, page === 0),
      this.button(guildId, `store:page:${page + 1}`, "Próxima", "catalog", ButtonStyle.Secondary, (page + 1) * 25 >= all.length)
    ));
    return { embeds: [embed], components };
  }

  publicProduct(guildId: string, product: Product) {
    const fields = this.products.activeFields(product);
    const single = fields.length === 1 ? fields[0] : undefined;
    const totalStock = fields.reduce((sum, field) => sum + this.products.stockCount(product.id, "AVAILABLE", field.id), 0);
    const unavailable = !product.active || fields.length === 0 || (product.deliveryType === "STOCK" && totalStock === 0);
    const embed = new EmbedBuilder()
      .setColor(colorNumber(product.color))
      .setTitle(truncate(product.name, 256))
      .setDescription(product.description || " ");

    if (single) {
      const price = single.compareAtCents > single.priceCents
        ? `~~${formatMoney(single.compareAtCents)}~~  **${formatMoney(single.priceCents)}**`
        : `**${formatMoney(single.priceCents)}**`;
      embed.addFields({ name: `${this.emojis.text("payment", guildId)} Valor`, value: price, inline: true });
      if (single.name && single.name !== "Opção principal") embed.addFields({ name: "Produto", value: `${this.emojis.text(single.emoji || "cart", guildId)} ${single.name}`, inline: true });
      if (single.description) embed.addFields({ name: "Informações", value: truncate(single.description, 1024), inline: false });
      if (product.deliveryType === "STOCK") embed.addFields({ name: `${this.emojis.text("stock", guildId)} Stock`, value: this.products.stockCount(product.id, "AVAILABLE", single.id) > 0 ? `${this.products.stockCount(product.id, "AVAILABLE", single.id)} unidade(s)` : "Indisponível", inline: true });
    } else if (fields.length > 1) {
      embed.addFields({ name: "Escolha uma opção", value: "Selecione abaixo o campo desejado. O preço e os detalhes aparecem diretamente no menu.", inline: false });
    }
    if (product.deliveryType === "STOCK") {
      const deliveryVisual = this.automaticDeliveryEmojiSequence(guildId);
      if (deliveryVisual.sequence) {
        embed.addFields({ name: "\u200B", value: `# ${deliveryVisual.sequence}`, inline: false });
      }
    } else {
      embed.addFields({
        name: `${this.emojis.text("support", guildId)} ENTREGA MANUAL`,
        value: product.deliveryType === "ROLE" ? "Cargo automático." : "Entrega realizada pela equipe.",
        inline: false
      });
    }
    if (product.imageUrl) embed.setThumbnail(product.imageUrl);
    if (product.bannerUrl) embed.setImage(product.bannerUrl);
    embed.setFooter({ text: truncate(this.db.brand(guildId).footer || "166 Community", 2048) });

    const components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> = [];
    if (fields.length > 1) {
      const select = new StringSelectMenuBuilder()
        .setCustomId(truncate(`product:field-select:${product.id}`, 100))
        .setPlaceholder(truncate(product.selectPlaceholder || "Selecione uma opção para continuar...", 150))
        .setDisabled(unavailable)
        .addOptions(fields.slice(0, 25).map((field) => {
          const fieldStock = product.deliveryType === "STOCK" ? this.products.stockCount(product.id, "AVAILABLE", field.id) : 1;
          const descriptionParts = [formatMoney(field.priceCents)];
          if (field.description) descriptionParts.push(field.description);
          if (product.deliveryType === "STOCK") descriptionParts.push(fieldStock > 0 ? `stock ${fieldStock}` : "sem stock");
          return new StringSelectMenuOptionBuilder()
            .setLabel(truncate(field.name || "Opção", 100))
            .setDescription(truncate(descriptionParts.join(" • "), 100))
            .setValue(field.id)
            .setEmoji(this.emojis.component(field.emoji || product.emojiSemantic, guildId));
        }));
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
    } else if (single) {
      const fieldUnavailable = unavailable || (product.deliveryType === "STOCK" && this.products.stockCount(product.id, "AVAILABLE", single.id) === 0);
      components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, `product:buy:${product.id}:${single.id}`, product.buttonLabel || "Comprar agora", "cart", bstyle(product.buttonStyle), fieldUnavailable)
      ));
    } else {
      components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, `product:none:${product.id}`, "Produto indisponível", "reject", ButtonStyle.Secondary, true)
      ));
    }

    if (product.demonstrationEnabled && /^https?:\/\//i.test(product.demonstrationUrl)) {
      const link = new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(product.demonstrationUrl)
        .setLabel(truncate(product.demonstrationLabel || "Demonstração", 80));
      const emoji = this.emojis.component(product.demonstrationEmoji || "information", guildId);
      if (emoji) link.setEmoji(emoji);
      components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(link));
    }
    return { embeds: [embed], components, attachments: [] };
  }

  publishedProduct(guildId: string, product: Product) {
    const fields = this.products.activeFields(product);
    const single = fields.length === 1 ? fields[0] : undefined;
    const totalStock = fields.reduce((sum, field) => sum + this.products.stockCount(product.id, "AVAILABLE", field.id), 0);
    const unavailable = !product.active || fields.length === 0 || (product.deliveryType === "STOCK" && totalStock === 0);
    const publicPayload = this.publicProduct(guildId, product);
    const container = new ContainerBuilder().setAccentColor(colorNumber(product.color));

    const attachments: AttachmentBuilder[] = [];
    if (isLocalImage(product.imageUrl)) {
      attachments.push(new AttachmentBuilder(localImagePath(product.imageUrl), { name: product.imageUrl }));
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder().setURL(localToAttachmentUrl(product.imageUrl)).setDescription(truncate(product.name, 1000))
        )
      );
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    } else if (product.imageUrl && /^https?:\/\//i.test(product.imageUrl)) {
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder().setURL(product.imageUrl).setDescription(truncate(product.name, 1000))
        )
      );
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    }

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${escapeMarkdown(truncate(product.name, 180))}`)
    );

    if (product.description.trim()) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(truncate(product.description, 3000))
      );
    }

    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));

    const information: string[] = [];
    if (single) {
      const price = single.compareAtCents > single.priceCents
        ? `~~${formatMoney(single.compareAtCents)}~~  **${formatMoney(single.priceCents)}**`
        : `**${formatMoney(single.priceCents)}**`;
      information.push(`${this.emojis.text("payment", guildId)} **Valor:** ${price}`);
      if (single.name && single.name !== "Opção principal") information.push(`**Opção:** ${this.emojis.text(single.emoji || "cart", guildId)} ${escapeMarkdown(single.name)}`);
      if (single.description) information.push(`**Informações:** ${truncate(single.description, 700)}`);
      if (product.deliveryType === "STOCK") {
        const stock = this.products.stockCount(product.id, "AVAILABLE", single.id);
        information.push(`${this.emojis.text("stock", guildId)} **Stock:** ${stock > 0 ? `${stock} unidade(s)` : "Indisponível"}`);
      }
    } else if (fields.length > 1) {
      information.push("**Selecione uma opção abaixo.** O menu mostra o preço, os detalhes e o stock de cada campo.");
    } else {
      information.push("Produto indisponível no momento.");
    }
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(truncate(information.join("\n"), 3800)));

    if (product.deliveryType === "STOCK") {
      const deliveryVisual = this.automaticDeliveryEmojiSequence(guildId);
      if (deliveryVisual.sequence) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${deliveryVisual.sequence}`));
      }
    } else {
      const manualLabel = product.deliveryType === "ROLE" ? "Cargo automático" : "Entrega manual";
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### ${this.emojis.text("support", guildId)} ${manualLabel}`)
      );
    }

    if (isLocalImage(product.bannerUrl)) {
      if (!attachments.find((a) => a.name === product.bannerUrl)) {
        attachments.push(new AttachmentBuilder(localImagePath(product.bannerUrl), { name: product.bannerUrl }));
      }
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder().setURL(localToAttachmentUrl(product.bannerUrl)).setDescription(truncate(product.name, 1000))
        )
      );
    } else if (/^https?:\/\//i.test(product.bannerUrl)) {
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder().setURL(product.bannerUrl).setDescription(truncate(product.name, 1000))
        )
      );
    }

    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    for (const row of publicPayload.components) container.addActionRowComponents(row);

    return checkedDiscordPayload({ flags: MessageFlags.IsComponentsV2 as const, components: [container], ...(attachments.length ? { files: attachments, attachments: [] } : {}) }, `produto publicado ${product.id}`);
  }

  publishedProductEdit(guildId: string, product: Product) {
    return {
      ...this.publishedProduct(guildId, product),
      content: null,
      embeds: [],
      attachments: []
    };
  }

  cart(guildId: string, userId: string, userName = "Cliente", avatarUrl = "") {
    const session = this.products.getCartSession(guildId, userId);
    const items = session?.items ?? [];
    const validItems = items.flatMap((item) => {
      const product = this.db.state.products[item.productId];
      const field = product?.fields.find((entry) => entry.id === item.fieldId);
      return product && field && product.guildId === guildId ? [{ item, product, field }] : [];
    });
    const fallbackSubtotal = validItems.reduce((sum, entry) => sum + entry.field.priceCents * entry.item.quantity, 0);
    let totals = { subtotalCents: fallbackSubtotal, discountCents: 0, totalCents: fallbackSubtotal };
    let couponWarning = "";
    try { totals = this.products.cartTotals(guildId, userId); }
    catch (error) { couponWarning = error instanceof Error ? error.message : "O cupom aplicado não pôde ser validado."; }
    const embed = this.base(`${this.emojis.text("cart", guildId)} Revisão do pedido`, `Confira os itens antes de seguir para o pagamento.`, guildId)
      .addFields(
        { name: "Comprador", value: `<@${userId}> • ${truncate(userName, 80)}`, inline: true },
        { name: "Quantidade de itens", value: String(validItems.reduce((sum, entry) => sum + entry.item.quantity, 0)), inline: true },
        { name: "Entrega", value: validItems.every((entry) => entry.product.deliveryType === "STOCK") ? "Automática" : "Automática e/ou manual", inline: true },
        { name: "Itens", value: validItems.length ? validItems.map(({ item, product, field }) => `${this.emojis.text(field.emoji || product.emojiSemantic, guildId)} **${product.name} • ${field.name}**
Quantidade: **${item.quantity}** • Unitário: **${formatMoney(field.priceCents)}** • Subtotal: **${formatMoney(field.priceCents * item.quantity)}**
Stock: **${product.deliveryType === "STOCK" ? this.products.stockCount(product.id, "AVAILABLE", field.id) : "sob demanda"}**`).join("\n\n").slice(0, 1024) : "Carrinho vazio." },
        { name: "Resumo", value: `Subtotal: **${formatMoney(totals.subtotalCents)}**
Desconto: **-${formatMoney(totals.discountCents)}**
Valor final: **${formatMoney(totals.totalCents)}**${session?.couponCode ? `
Cupom: **${session.couponCode}**` : ""}` },
        ...(couponWarning ? [{ name: "Cupom não aplicado", value: truncate(couponWarning, 1024), inline: false }] : [])
      );
    if (avatarUrl) embed.setThumbnail(avatarUrl);
    const productVisual = validItems[0]?.product.bannerUrl || validItems[0]?.product.imageUrl;
    if (productVisual && /^https?:\/\//i.test(productVisual)) embed.setImage(productVisual);
    const components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> = [];
    if (validItems.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId("cart:item-manage").setPlaceholder("Alterar quantidade ou remover um item").addOptions(validItems.slice(0, 25).map(({ item, product, field }) => new StringSelectMenuOptionBuilder().setLabel(truncate(`${product.name} • ${field.name}`, 100)).setDescription(truncate(`Quantidade ${item.quantity} • ${formatMoney(field.priceCents * item.quantity)}`, 100)).setValue(`${product.id}|${field.id}`).setEmoji(this.emojis.component(field.emoji || "cart", guildId))))
    ));
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      this.button(guildId, "cart:payment-methods", "Ir para pagamento", "payment", ButtonStyle.Success, !validItems.length),
      this.button(guildId, "cart:coupon-apply", "Aplicar cupom", "coupon", ButtonStyle.Primary, !validItems.length),
      this.button(guildId, "cart:coupon-remove", "Remover cupom", "minus", ButtonStyle.Secondary, !session?.couponCode),
      this.button(guildId, "cart:return", "Voltar ao produto", "back", ButtonStyle.Secondary),
      this.button(guildId, "cart:cancel", "Cancelar compra", "trash", ButtonStyle.Danger)
    ));
    return { embeds: [embed], components };
  }

  cartItemManage(guildId: string, userId: string, product: Product, field: ProductField) {
    const item = this.products.cart(userId, guildId).find((entry) => entry.productId === product.id && entry.fieldId === field.id);
    return { embeds: [this.base(`${this.emojis.text(field.emoji || "cart", guildId)} ${product.name} • ${field.name}`, `Quantidade atual: **${item?.quantity ?? 1}**
Disponível: **${this.products.quantityLimit(product, field)}**`, guildId)], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      this.button(guildId, `cart:qty-dec:${product.id}:${field.id}`, "-1", "minus", ButtonStyle.Secondary, (item?.quantity ?? 1) <= 1),
      this.button(guildId, `cart:qty-edit:${product.id}:${field.id}`, "Definir quantidade", "edit", ButtonStyle.Primary),
      this.button(guildId, `cart:qty-inc:${product.id}:${field.id}`, "+1", "plus", ButtonStyle.Success, (item?.quantity ?? 1) >= this.products.quantityLimit(product, field)),
      this.button(guildId, `cart:remove:${product.id}:${field.id}`, "Remover", "trash", ButtonStyle.Danger),
      this.button(guildId, "cart:review", "Voltar", "back")
    )] };
  }

  paymentMethods(guildId: string, methods: PaymentProviderName[]) {
    const imapBank = bankProfile(this.db.payments(guildId).imapPix.bank);
    const labels: Record<PaymentProviderName, [string, string]> = {
      MERCADO_PAGO: ["Pix • Mercado Pago", "mercado_pago"],
      EFI_BANK: ["Pix • Efí Bank", "efi_bank"],
      STRIPE: ["Pix • Stripe", "payment"],
      MISTIC_PAY: ["Pix • MisticPay", "pix"],
      PURIN_CASH: ["Pix • Purin Cash", "payment"],
      IMAP_PIX: [`Pix • ${imapBank.label}`, imapBank.emojiSemantic],
      MANUAL_PIX: ["Pix manual", "pix"],
      VEXO_PAY: ["Pix • VexoPay", "payment"]
    };
    const buttons = methods.map((method) => this.button(guildId, `cart:pay:${method}`, labels[method][0], labels[method][1], ButtonStyle.Primary));
    const rows = [] as Array<ActionRowBuilder<ButtonBuilder>>;
    for (let index = 0; index < buttons.length; index += 5) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(index, index + 5)));
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(this.button(guildId, "cart:review", "Voltar", "back"), this.button(guildId, "cart:cancel", "Cancelar", "trash", ButtonStyle.Danger)));
    return { embeds: [this.base(`${this.emojis.text("payment", guildId)} Forma de pagamento`, "Somente métodos ativos e configurados são exibidos. Selecione como deseja pagar.", guildId)], components: rows };
  }

  paymentPending(guildId: string, order: Order) {
    const description = order.provider === "IMAP_PIX"
      ? `Faça o Pix usando o código abaixo. Depois, o bot procurará um aviso recente de **${bankProfile(order.imapBank || this.db.payments(guildId).imapPix.bank).label}** com o mesmo valor e o nome **${truncate(order.payerFullName, 100)}**.`
      : order.provider === "MANUAL_PIX"
        ? "Faça o Pix usando o código gerado pelo bot. Depois, aguarde a aprovação de um responsável no painel de pedidos."
        : "Aguardando confirmação automática do provedor. O carrinho será atualizado após aprovação, expiração ou cancelamento.";
    const embed = this.orderView(guildId, order).setTitle(`${this.emojis.text("pix", guildId)} Pagamento Pix`).setDescription(description);
    const buttons = [
      this.button(guildId, `payment:key:${order.id}`, "Copiar PIX copia e cola", "copy", ButtonStyle.Primary, !order.pixCode),
      this.button(guildId, `payment:code:${order.id}`, "Copiar código PIX", "pix", ButtonStyle.Secondary, !order.pixCode),
      ...(order.provider === "IMAP_PIX" ? [this.button(guildId, `payment:check:${order.id}`, "Verificar pagamento", "refresh", ButtonStyle.Success)] : []),
      this.button(guildId, `payment:cancel:${order.id}`, "Cancelar", "trash", ButtonStyle.Danger)
    ];
    return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)] };
  }

  termsConfirmation(guildId: string, product: Product, field: ProductField) {
    const embed = this.base(`${this.emojis.text("terms", guildId)} Termos • ${product.name}`, product.termsText || "Ao continuar, você confirma que leu e aceita as condições deste produto.", guildId)
      .setColor(colorNumber(product.color))
      .addFields(
        { name: "Produto", value: `${product.name} • ${field.name}`, inline: true },
        { name: "Valor", value: formatMoney(field.priceCents), inline: true },
        { name: "Ação", value: "Comprar agora", inline: true }
      );
    return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      this.button(guildId, `product:terms:buy:${product.id}:${field.id}`, "Li e aceito", "approve", ButtonStyle.Success),
      this.button(guildId, `product:cancel:${product.id}`, "Cancelar", "reject", ButtonStyle.Danger)
    )] };
  }

  orderView(guildId: string, order: Order) {
    const expiresUnix = Math.floor(Date.parse(order.expiresAt) / 1000);
    const paymentLabel = order.provider === "IMAP_PIX" && order.imapBank ? `IMAP • ${bankProfile(order.imapBank).label}` : order.provider.replaceAll("_", " ");
    const embed = this.base(`${this.emojis.text("invoice", guildId)} Pedido ${order.id}`, `Status: **${order.status}**`, guildId).addFields(
      { name: "Valor", value: formatMoney(order.totalCents), inline: true },
      { name: "Pagamento", value: paymentLabel, inline: true },
      { name: "Tempo restante", value: order.provider === "MANUAL_PIX" ? "Sem limite • aguarda a equipe" : `<t:${expiresUnix}:R>`, inline: true },
      { name: "Identificador da compra", value: `\`${order.id}\``, inline: true },
      { name: "Referência PIX", value: `\`${order.paymentReference || order.id}\``, inline: true },
      { name: "Criação", value: `<t:${Math.floor(Date.parse(order.createdAt) / 1000)}:f>`, inline: true },
      { name: "Itens", value: order.items.map((item) => `${item.quantity}× ${item.productName} • ${item.fieldName}`).join("\n").slice(0, 1024) }
    );
    if (order.provider === "IMAP_PIX" && order.payerFullName) embed.addFields({ name: "Nome informado para verificação", value: truncate(order.payerFullName, 120), inline: false });
    if (order.status === "PENDING" && order.pixCode) embed.addFields({ name: "PIX copia e cola", value: `\`\`\`\n${truncate(order.pixCode, 900)}\n\`\`\`` });
    if (order.qrCodeDataUrl) embed.setImage("attachment://pix.png");
    return embed;
  }

  paymentsHome(guildId: string) {
    const settings = this.db.payments(guildId);
    const status = (enabled: boolean) => enabled ? "🟢 Ativo" : "⚫ Desativado";
    const imapBank = bankProfile(settings.imapPix.bank);
    return {
      embeds: [this.base(
        `${this.emojis.text("payment", guildId)} Pagamentos`,
        `Escolha um método abaixo. Cada opção abre controles separados e fáceis de editar.

Provedor padrão: **${settings.defaultProvider.replaceAll("_", " ")}**
Expiração: **${settings.orderExpiresMinutes} min** • consulta: **${settings.pollIntervalSeconds}s**`,
        guildId
      ).addFields(
        { name: `${this.emojis.text("mercadopago", guildId)} Mercado Pago`, value: status(settings.mercadoPago.enabled), inline: true },
        { name: `${this.emojis.text("efibank", guildId)} Efí Bank`, value: status(settings.efiBank.enabled), inline: true },
        { name: "Stripe PIX", value: status(settings.stripe.enabled), inline: true },
        { name: "MisticPay", value: status(settings.misticPay.enabled), inline: true },
        { name: "Purin Cash", value: status(settings.purinCash.enabled), inline: true },
        { name: `${this.emojis.text(imapBank.emojiSemantic, guildId)} IMAP PIX`, value: `${status(settings.imapPix.enabled)}
Banco: **${imapBank.label}**`, inline: true },
        { name: `${this.emojis.text("manual", guildId)} PIX manual`, value: /^\S+@\S+\.\S+$/.test(settings.manualPixKey) ? "🟢 E-mail configurado • código gerado automaticamente" : "⚫ Não configurado", inline: true }
      )],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.button(guildId, "admin:payment:mp", "Mercado Pago", "mercadopago"),
          this.button(guildId, "admin:payment:efi", "Efí Bank", "efibank"),
          this.button(guildId, "admin:payment:stripe", "Stripe PIX", "payment"),
          this.button(guildId, "admin:payment:mistic", "MisticPay", "pix"),
          this.button(guildId, "admin:payment:purin", "Purin Cash", "payment")
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.button(guildId, "admin:payment:imap", "IMAP PIX", imapBank.emojiSemantic, ButtonStyle.Primary),
          this.button(guildId, "admin:payment:manual", "PIX manual", "manual")
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.button(guildId, "admin:payment:mp-toggle", settings.mercadoPago.enabled ? "Desativar MP" : "Ativar MP", settings.mercadoPago.enabled ? "off" : "on", settings.mercadoPago.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
          this.button(guildId, "admin:payment:efi-toggle", settings.efiBank.enabled ? "Desativar Efí" : "Ativar Efí", settings.efiBank.enabled ? "off" : "on", settings.efiBank.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
          this.button(guildId, "admin:payment:efi-environment", settings.efiBank.sandbox ? "Efí: homologação" : "Efí: produção", "settings"),
          this.button(guildId, "admin:payment:efi-cert", "Certificado Efí", "upload", ButtonStyle.Primary)
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.button(guildId, "admin:payment:stripe-toggle", settings.stripe.enabled ? "Desativar Stripe" : "Ativar Stripe", settings.stripe.enabled ? "off" : "on", settings.stripe.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
          this.button(guildId, "admin:payment:mistic-toggle", settings.misticPay.enabled ? "Desativar Mistic" : "Ativar Mistic", settings.misticPay.enabled ? "off" : "on", settings.misticPay.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
          this.button(guildId, "admin:payment:purin-toggle", settings.purinCash.enabled ? "Desativar Purin" : "Ativar Purin", settings.purinCash.enabled ? "off" : "on", settings.purinCash.enabled ? ButtonStyle.Danger : ButtonStyle.Success)
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.button(guildId, "admin:payment:provider", "Método padrão", "payment", ButtonStyle.Primary),
          this.button(guildId, "admin:payment:general", "Prazos", "settings"),
          this.button(guildId, "admin:payment:test-api", "Testar gateways", "refresh", ButtonStyle.Success),
          this.button(guildId, "admin:payment:imap-test", "Testar IMAP", "refresh", ButtonStyle.Success),
          this.button(guildId, "admin:home", "Voltar", "back")
        )
      ]
    };
  }

  imapSettingsHome(guildId: string) {
    const settings = this.db.payments(guildId).imapPix;
    const bank = bankProfile(settings.bank);
    const providerLabel = settings.emailProvider === "CUSTOM"
      ? "Servidor personalizado"
      : IMAP_EMAIL_PRESETS[settings.emailProvider as Exclude<ImapEmailProvider, "CUSTOM">]?.label ?? settings.emailProvider;
    const passwordConfigured = Boolean(this.db.getSecret("imap_password", guildId));
    const complete = Boolean(settings.username && settings.host && settings.pixKey && passwordConfigured);
    const bankSelect = new StringSelectMenuBuilder()
      .setCustomId("admin:payment:imap-bank-select")
      .setPlaceholder("Escolha o banco que envia os avisos de Pix")
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel("Banco Inter").setDescription("Buscar avisos recentes do Banco Inter").setValue("INTER").setEmoji(this.emojis.component("inter", guildId)).setDefault(settings.bank === "INTER"),
        new StringSelectMenuOptionBuilder().setLabel("PicPay").setDescription("Buscar avisos recentes do PicPay").setValue("PICPAY").setEmoji(this.emojis.component("picpay", guildId)).setDefault(settings.bank === "PICPAY"),
        new StringSelectMenuOptionBuilder().setLabel("Nubank").setDescription("Buscar avisos recentes do Nubank").setValue("NUBANK").setEmoji(this.emojis.component("nubank", guildId)).setDefault(settings.bank === "NUBANK")
      );
    const emailProviderSelect = new StringSelectMenuBuilder()
      .setCustomId("admin:payment:imap-email-provider-select")
      .setPlaceholder("Escolha onde sua caixa de e-mail está hospedada")
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel("Gmail").setDescription("imap.gmail.com • porta 993").setValue("GMAIL").setDefault(settings.emailProvider === "GMAIL"),
        new StringSelectMenuOptionBuilder().setLabel("Outlook / Hotmail").setDescription("outlook.office365.com • porta 993").setValue("OUTLOOK").setDefault(settings.emailProvider === "OUTLOOK"),
        new StringSelectMenuOptionBuilder().setLabel("Yahoo Mail").setDescription("imap.mail.yahoo.com • porta 993").setValue("YAHOO").setDefault(settings.emailProvider === "YAHOO"),
        new StringSelectMenuOptionBuilder().setLabel("Outro servidor").setDescription("Definir host e porta manualmente").setValue("CUSTOM").setDefault(settings.emailProvider === "CUSTOM")
      );
    return {
      embeds: [this.base(
        `${this.emojis.text(bank.emojiSemantic, guildId)} IMAP PIX • configuração simples`,
        `O bot procura um e-mail recente de **${bank.label}** e só aprova quando encontrar o **mesmo valor** e o **nome completo do pagador** informado durante a compra.

O e-mail informado na conta IMAP também será usado como chave PIX. O bot gera sozinho o código copia e cola de cada pedido, com valor e referência corretos.`,
        guildId
      ).addFields(
        { name: "Status", value: settings.enabled ? "🟢 Ativo" : "⚫ Desativado", inline: true },
        { name: "Banco monitorado", value: bank.label, inline: true },
        { name: "Caixa de e-mail", value: settings.username ? `${settings.username}
${providerLabel}` : "Ainda não configurada", inline: true },
        { name: "Chave PIX", value: settings.pixKey ? `Configurada • tipo ${settings.pixKeyType}` : "Ainda não configurada", inline: true },
        { name: "Senha de aplicativo", value: passwordConfigured ? "Carregada" : "Não carregada", inline: true },
        { name: "Configuração", value: complete ? "✅ Completa" : "⚠️ Incompleta", inline: true }
      )],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(bankSelect),
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(emailProviderSelect),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.button(guildId, "admin:payment:imap-account", "E-mail, senha e chave PIX", "mail2", ButtonStyle.Primary),
          this.button(guildId, "admin:payment:imap-timing", "Tempo de busca", "clock"),
          this.button(guildId, "admin:payment:imap-custom-server", "Servidor personalizado", "settings", ButtonStyle.Secondary, settings.emailProvider !== "CUSTOM")
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          this.button(guildId, "admin:payment:imap-toggle", settings.enabled ? "Desativar IMAP" : "Ativar IMAP", settings.enabled ? "off" : "on", settings.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
          this.button(guildId, "admin:payment:imap-seen-toggle", settings.markSeen ? "Não marcar como lido" : "Marcar como lido", "mail2"),
          this.button(guildId, "admin:payment:imap-test", "Testar conexão", "refresh", ButtonStyle.Success),
          this.button(guildId, "admin:payments", "Voltar", "back")
        )
      ]
    };
  }

  emojisHome(guildId: string) {
    const status = this.emojis.status; const guild = this.db.guild(guildId);
    const description = [
      `Pacote ativo: **${this.emojis.packName()}**`,
      `Arquivos do usuário: **${this.emojis.manifestCount()} emojis**`,
      `Instalados na aplicação: **${status.installed}/${status.total}**`,
      `Funções remapeadas: **${Object.keys(guild.emojiOverrides).length}**`,
      `Instalação automática: **${status.syncing ? `em andamento (${status.completed}/${status.total})` : "pronta"}**`,
      status.lastError ? `\nÚltimo erro: ${truncate(status.lastError, 500)}` : ""
    ].filter(Boolean).join("\n");
    return { embeds: [this.base(`${this.emojis.text("emoji", guildId)} Pacote de emojis do bot`, description, guildId)], components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, "admin:emoji:sync", "Instalar / corrigir", "refresh", ButtonStyle.Success),
        this.button(guildId, "admin:emoji:mapping:0", "Personalizar funções", "customize", ButtonStyle.Primary),
        this.button(guildId, "admin:emoji:catalog:0", "Ver catálogo", "reaction", ButtonStyle.Primary),
        this.button(guildId, "admin:emoji:remove", "Remover pacote", "trash", ButtonStyle.Danger),
        this.button(guildId, "admin:home", "Voltar", "back")
      )
    ] };
  }

  stockRequestsHome(guildId: string) {
    const settings = this.db.guild(guildId).stockRequest;
    const requests = Object.values(this.db.state.stockRequests).filter((request) => request.guildId === guildId);
    const pending = requests.filter((request) => request.status === "PENDING").length;
    const claimed = requests.filter((request) => request.status === "CLAIMED").length;
    const published = settings.panelChannelId && settings.panelMessageId ? `<#${settings.panelChannelId}>` : "Não publicado";
    const destination = settings.requestChannelId ? `<#${settings.requestChannelId}>` : "Não configurado";
    const embed = this.base(
      `${this.emojis.text("stock_request", guildId)} Pedir Stock`,
      "Configure uma mensagem pública para clientes solicitarem produtos que ainda não possuem stock disponível.",
      guildId
    ).addFields(
      { name: "Status", value: settings.enabled ? "Ativo" : "Desativado", inline: true },
      { name: "Publicado em", value: published, inline: true },
      { name: "Pedidos enviados para", value: destination, inline: true },
      { name: "Pendentes", value: String(pending), inline: true },
      { name: "Em atendimento", value: String(claimed), inline: true },
      { name: "Total registrado", value: String(requests.length), inline: true },
      { name: "Botão", value: `${this.emojis.text(settings.emojiSemantic, guildId)} ${settings.buttonLabel} • ${settings.buttonStyle}`, inline: false }
    );
    return { embeds: [embed], components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, "admin:stock-request:edit", "Editar mensagem", "edit", ButtonStyle.Primary),
        this.button(guildId, "admin:stock-request:appearance", "Aparência", "customize"),
        this.button(guildId, "admin:stock-request:image-upload", "Enviar imagem", "image"),
        this.button(guildId, "admin:stock-request:toggle", settings.enabled ? "Desativar" : "Ativar", settings.enabled ? "off" : "on", settings.enabled ? ButtonStyle.Danger : ButtonStyle.Success)
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, "admin:stock-request:destination", "Canal dos pedidos", "message"),
        this.button(guildId, "admin:stock-request:roles", "Cargos notificados", "role"),
        this.button(guildId, "admin:stock-request:publish", "Publicar painel", "announcement", ButtonStyle.Success),
        this.button(guildId, "admin:stock-request:preview", "Prévia", "search", ButtonStyle.Primary)
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, "admin:stock-request:list", "Ver solicitações", "stock_request_pending"),
        this.button(guildId, "admin:home", "Voltar", "back")
      )
    ] };
  }

  publicStockRequestPanel(guildId: string) {
    const settings = this.db.guild(guildId).stockRequest;
    const embed = new EmbedBuilder()
      .setColor(colorNumber(settings.color))
      .setTitle(`${this.emojis.text(settings.emojiSemantic, guildId)} ${settings.title}`)
      .setDescription(settings.description)
      .setFooter({ text: settings.footer || this.db.brand(guildId).footer });
    if (settings.imageUrl) embed.setImage(settings.imageUrl);
    if (settings.thumbnailUrl) embed.setThumbnail(settings.thumbnailUrl);
    return {
      embeds: [embed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, "stock-request:open", settings.buttonLabel || "Pedir Stock", settings.emojiSemantic, bstyle(settings.buttonStyle))
      )]
    };
  }

  stockRequestQueue(guildId: string) {
    const requests = Object.values(this.db.state.stockRequests)
      .filter((request) => request.guildId === guildId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const embed = this.base(`${this.emojis.text("stock_request_pending", guildId)} Solicitações de stock`, requests.length ? "Selecione uma solicitação para visualizar e gerenciar." : "Nenhuma solicitação registrada.", guildId);
    const components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> = [];
    if (requests.length) {
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId("admin:stock-request:select").setPlaceholder("Selecionar solicitação").addOptions(
          requests.slice(0, 25).map((request) => new StringSelectMenuOptionBuilder()
            .setLabel(`${request.productName} • ${request.username}`.slice(0, 100))
            .setDescription(`${request.status} • quantidade ${request.quantity}`.slice(0, 100))
            .setValue(request.id)
            .setEmoji(this.emojis.component(request.status === "AVAILABLE" ? "stock_request_available" : request.status === "REJECTED" ? "stock_request_reject" : "stock_request_pending", guildId)))
        )
      ));
    }
    components.push(this.back(guildId, "admin:stock-requests"));
    return { embeds: [embed], components };
  }

  stockRequestDetail(guildId: string, request: StockRequest, staff = false) {
    const statusLabels: Record<StockRequest["status"], string> = { PENDING: "Pendente", CLAIMED: "Em atendimento", AVAILABLE: "Disponível", REJECTED: "Recusado" };
    const statusEmoji = request.status === "AVAILABLE" ? "stock_request_available" : request.status === "REJECTED" ? "stock_request_reject" : request.status === "CLAIMED" ? "stock_request_claim" : "stock_request_pending";
    const embed = new EmbedBuilder()
      .setColor(request.status === "AVAILABLE" ? 0x22c55e : request.status === "REJECTED" ? 0xef4444 : request.status === "CLAIMED" ? 0x3b82f6 : 0xf59e0b)
      .setTitle(`${this.emojis.text(statusEmoji, guildId)} Pedido de Stock • ${request.id}`)
      .setDescription(request.details || "Nenhum detalhe adicional informado.")
      .addFields(
        { name: "Cliente", value: `<@${request.userId}> • ${request.username}`, inline: true },
        { name: "Produto", value: request.productName, inline: true },
        { name: "Quantidade", value: String(request.quantity), inline: true },
        { name: "Status", value: statusLabels[request.status], inline: true },
        { name: "Responsável", value: request.claimedBy ? `<@${request.claimedBy}>` : "Não assumido", inline: true },
        { name: "Criado", value: `<t:${Math.floor(Date.parse(request.createdAt) / 1000)}:R>`, inline: true }
      )
      .setFooter({ text: "166 Community • Controle de stock" })
      .setTimestamp(new Date(request.updatedAt));
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      this.button(guildId, `stock-request:claim:${request.id}`, "Assumir", "stock_request_claim", ButtonStyle.Primary, request.status === "AVAILABLE" || request.status === "REJECTED"),
      this.button(guildId, `stock-request:available:${request.id}`, "Marcar disponível", "stock_request_available", ButtonStyle.Success, request.status === "AVAILABLE"),
      this.button(guildId, `stock-request:reject:${request.id}`, "Recusar", "stock_request_reject", ButtonStyle.Danger, request.status === "REJECTED")
    );
    if (staff) buttons.addComponents(this.button(guildId, "admin:stock-request:list", "Voltar", "back"));
    return { embeds: [embed], components: [buttons] };
  }

  savedEmojisHome(guildId: string, page = 0) {
    const settings = this.db.guild(guildId).emojiLibrary;
    const all = this.emojis.listSaved(undefined, guildId);
    const pageSize = 10;
    const maxPage = Math.max(0, Math.ceil(all.length / pageSize) - 1);
    const safePage = Math.max(0, Math.min(maxPage, Math.trunc(page) || 0));
    const slice = all.slice(safePage * pageSize, safePage * pageSize + pageSize);
    const lines = slice.map((item, index) => `${safePage * pageSize + index + 1}. ${this.emojis.mentionSaved(item)} **${item.name}** — \`${item.id}\` — <@${item.ownerId}>`);
    const embed = this.base(
      `${this.emojis.text("saved_emoji", guildId)} Salvar Emojis`,
      [
        "Envie uma imagem ou GIF e o bot salvará o arquivo diretamente nos emojis da aplicação.",
        "Depois, use o código retornado em descrições, produtos, embeds e mensagens do próprio bot.",
        "",
        `Emojis salvos neste servidor: **${all.length}**`,
        `Membros podem salvar: **${settings.allowMembers ? "sim" : "não"}**`,
        `Limite por membro: **${settings.maxPerUser}**`,
        `Página: **${safePage + 1}/${maxPage + 1}**`,
        "",
        lines.join("\n") || "Nenhum emoji salvo ainda."
      ].join("\n"),
      guildId
    );
    const components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, "admin:saved-emoji:add", "Adicionar Emoji/GIF", "saved_emoji", ButtonStyle.Success),
        this.button(guildId, "admin:saved-emoji:settings", "Permissões e limite", "settings"),
        this.button(guildId, "admin:saved-emoji:refresh", "Atualizar lista", "refresh"),
        this.button(guildId, "admin:home", "Voltar", "back")
      )
    ];
    if (slice.length) {
      components.unshift(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(`admin:saved-emoji:select:${safePage}`).setPlaceholder("Ver ID, código ou remover emoji").addOptions(
          slice.map((item) => new StringSelectMenuOptionBuilder().setLabel(item.name).setDescription(`${item.animated ? "GIF animado" : "Imagem"} • ID ${item.id}`).setValue(item.id).setEmoji({ id: item.id, name: item.name, animated: item.animated }))
        )
      ));
    }
    if (maxPage > 0) components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      this.button(guildId, `admin:saved-emojis:${Math.max(0, safePage - 1)}`, "Anterior", "back", ButtonStyle.Secondary, safePage === 0),
      this.button(guildId, `admin:saved-emojis:${Math.min(maxPage, safePage + 1)}`, "Próxima", "arrow", ButtonStyle.Secondary, safePage === maxPage)
    ));
    return { embeds: [embed], components };
  }

  savedEmojiDetail(guildId: string, item: SavedApplicationEmoji) {
    const mention = this.emojis.mentionSaved(item);
    return {
      embeds: [this.base(`${mention} ${item.name}`, `**Código pronto para copiar:**\n\`\`\`\n${mention}\n\`\`\`\n**ID:** \`${item.id}\`\n**Nome:** \`${item.name}\`\n**Tipo:** ${item.animated ? "GIF animado" : "Imagem estática"}\n**Salvo por:** <@${item.ownerId}>`, guildId)],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, `admin:saved-emoji:copy:${item.id}`, "Mostrar código", "saved_emoji_copy", ButtonStyle.Primary),
        this.button(guildId, `admin:saved-emoji:remove:${item.id}`, "Remover", "saved_emoji_remove", ButtonStyle.Danger),
        this.button(guildId, "admin:saved-emojis", "Voltar", "back")
      )]
    };
  }

  ticketPanelsHome(guildId: string) {
    const panels = this.tickets.listPanels(guildId);
    const components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, "admin:ticket:create", "Criar painel", "ticket_add", ButtonStyle.Success),
        this.button(guildId, "admin:channels", "Categorias e equipe", "settings"),
        this.button(guildId, "admin:home", "Voltar", "back")
      )
    ];
    if (panels.length) components.unshift(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("admin:ticket:select")
        .setPlaceholder("Selecione um painel para configurar")
        .addOptions(panels.slice(0, 25).map((panel) => new StringSelectMenuOptionBuilder()
          .setLabel(truncate(panel.name, 100))
          .setDescription(truncate(`${panel.options.length} opções • ${panel.mode === "SELECT" ? "menu" : "botões"}`, 100))
          .setValue(panel.id)
          .setEmoji(this.emojis.component(panel.emojiSemantic, guildId))))
    ));
    return {
      embeds: [this.base(
        `${this.emojis.text("ticket", guildId)} Central de tickets`,
        `Configure painéis de atendimento com opções, categorias e mensagens de abertura.\n\n**Painéis configurados:** ${panels.length}\n\n` +
        `**Como usar:**\n` +
        `1. Clique em **Criar painel** para começar\n` +
        `2. Adicione opções de atendimento (ex: Suporte, Financeiro)\n` +
        `3. Configure cargos e categorias em **Categorias e equipe**\n` +
        `4. Clique em **Publicar** para enviar ao canal desejado\n\n` +
        `**Dica:** Cada opção pode ter sua própria categoria e cargo de suporte.`,
        guildId
      )],
      components
    };
  }

  ticketPanelDetail(guildId: string, panel: TicketPanel) {
    const status = panel.channelId ? `Publicado em <#${panel.channelId}>` : "Não publicado";
    const embed = this.base(`${this.emojis.text(panel.emojiSemantic, guildId)} ${panel.title}`, panel.description, guildId)
      .setColor(colorNumber(panel.color))
      .addFields(
        { name: "Opções", value: `${panel.options.length}/25`, inline: true },
        { name: "Formato", value: panel.mode === "SELECT" ? "Menu" : "Botões", inline: true },
        { name: "Status", value: status, inline: true }
      );
    return { embeds: [embed], components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, `admin:ticket:options:${panel.id}`, "Opções", "support", ButtonStyle.Primary),
        this.button(guildId, `admin:ticket:publish:${panel.id}`, "Publicar", "announcement", ButtonStyle.Success),
        this.button(guildId, `admin:ticket:image-upload:${panel.id}`, "Banner", "image"),
        this.button(guildId, `admin:ticket:mode-toggle:${panel.id}`, panel.mode === "SELECT" ? "Botões" : "Menu", panel.mode === "SELECT" ? "commands" : "listening_music"),
        this.button(guildId, "admin:tickets", "Voltar", "back")
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, `admin:ticket:basic:${panel.id}`, "Editar visual", "edit", ButtonStyle.Secondary),
        this.button(guildId, `admin:ticket:delete-request:${panel.id}`, "Excluir", "trash", ButtonStyle.Danger)
      )
    ] };
  }

  ticketPanelFieldsView(guildId: string, panel: TicketPanel) {
    const lines = panel.fields.map((field, index) => `${index + 1}. **${field.name}** — ${field.inline ? "linha compacta" : "linha completa"}`);
    const components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> = [];
    if (panel.fields.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`admin:ticket:field-select:${panel.id}`)
        .setPlaceholder("Selecione um campo para editar")
        .addOptions(panel.fields.slice(0, 25).map((field) => new StringSelectMenuOptionBuilder()
          .setLabel(truncate(field.name, 100))
          .setDescription(truncate(`${field.inline ? "Compacto" : "Completo"} • ${field.value}`, 100))
          .setValue(field.id)
          .setEmoji(this.emojis.component("embed", guildId))))
    ));
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      this.button(guildId, `admin:ticket:field-add:${panel.id}`, "Adicionar campo", "plus", ButtonStyle.Success, panel.fields.length >= 25),
      this.button(guildId, `admin:ticket:${panel.id}`, "Voltar ao painel", "back")
    ));
    return {
      embeds: [this.base(`${this.emojis.text("embed", guildId)} Campos • ${panel.name}`, `${lines.join("\n") || "Nenhum campo configurado."}

Os campos aparecem na mensagem pública do painel e também podem usar **{user}** e **{subject}** na abertura do ticket.`, guildId)],
      components
    };
  }

  ticketPanelFieldDetail(guildId: string, panel: TicketPanel, field: TicketPanelField) {
    return {
      embeds: [this.base(`${this.emojis.text("embed", guildId)} ${field.name}`, field.value, guildId).addFields(
        { name: "Exibição", value: field.inline ? "Compacta / inline" : "Linha completa", inline: true },
        { name: "ID", value: `\`${field.id}\``, inline: true }
      )],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, `admin:ticket:field-edit:${panel.id}:${field.id}`, "Editar", "edit", ButtonStyle.Primary),
        this.button(guildId, `admin:ticket:field-inline:${panel.id}:${field.id}`, field.inline ? "Usar linha completa" : "Usar modo compacto", "embed", ButtonStyle.Secondary),
        this.button(guildId, `admin:ticket:field-delete:${panel.id}:${field.id}`, "Remover", "trash", ButtonStyle.Danger),
        this.button(guildId, `admin:ticket:fields:${panel.id}`, "Voltar", "back")
      )]
    };
  }

  publicTicketPanel(guildId: string, panel: TicketPanel) {
    const titlePrefix = panel.emojiSemantic.trim() ? `${this.emojis.text(panel.emojiSemantic, guildId)} ` : "";
    const container = new ContainerBuilder().setAccentColor(colorNumber(panel.color));
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${titlePrefix}${truncate(panel.title || "Central de atendimento", 300)}`)
    );
    if (panel.description.trim()) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(truncate(panel.description, 4000)));
    }
    if (panel.fields.length) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      for (const field of panel.fields.slice(0, 25)) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`### ${truncate(field.name || "Informação", 300)}\n${truncate(field.value || "-", 3600)}`)
        );
      }
    }
    // A galeria pertence ao Container V2. Assim o banner deixa de ser um anexo
    // visual solto e passa a integrar o mesmo bloco que título, campos e select.
    if (isLocalImage(panel.imageUrl)) {
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder().setURL(localToAttachmentUrl(panel.imageUrl)).setDescription(truncate(panel.title, 1000))
        )
      );
    } else if (/^https?:\/\//i.test(panel.imageUrl)) {
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder().setURL(panel.imageUrl).setDescription(truncate(panel.title, 1000))
        )
      );
    }
    if (panel.footer.trim()) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${truncate(panel.footer, 1900)}`));
    }
    const attachments: AttachmentBuilder[] = [];
    if (isLocalImage(panel.imageUrl)) {
      attachments.push(new AttachmentBuilder(localImagePath(panel.imageUrl), { name: panel.imageUrl }));
    }
    const options = panel.options.filter((option) => option.active).sort((a, b) => a.position - b.position).slice(0, 25);
    if (!options.length) {
      return checkedDiscordPayload({ flags: MessageFlags.IsComponentsV2 as const, components: [container], ...(attachments.length ? { files: attachments, attachments: [] } : {}) }, `painel de ticket ${panel.id}`);
    }

    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));

    if (panel.mode === "BUTTONS") {
      for (let index = 0; index < options.length; index += 5) {
        container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
          options.slice(index, index + 5).map((option) => this.button(guildId, `ticket:open:${panel.id}:${option.id}`, option.name, option.emojiSemantic, bstyle(panel.buttonStyle)))
        ));
      }
      return checkedDiscordPayload({ flags: MessageFlags.IsComponentsV2 as const, components: [container], ...(attachments.length ? { files: attachments, attachments: [] } : {}) }, `painel de ticket ${panel.id}`);
    }

    const select = new StringSelectMenuBuilder()
      .setCustomId(`ticket:open-select:${panel.id}`)
      .setPlaceholder(truncate(panel.buttonLabel || "Selecione o tipo de atendimento", 150));
    for (const option of options) {
      const menuOption = new StringSelectMenuOptionBuilder()
        .setLabel(truncate(option.name, 100))
        .setDescription(truncate(option.description || "Abrir atendimento", 100))
        .setValue(option.id);
      if (option.emojiSemantic.trim()) menuOption.setEmoji(this.emojis.component(option.emojiSemantic, guildId));
      select.addOptions(menuOption);
    }
    container.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
    return checkedDiscordPayload({ flags: MessageFlags.IsComponentsV2 as const, components: [container], ...(attachments.length ? { files: attachments, attachments: [] } : {}) }, `painel de ticket ${panel.id}`);
  }

  publicTicketPanelEdit(guildId: string, panel: TicketPanel) {
    return {
      ...this.publicTicketPanel(guildId, panel),
      content: null,
      embeds: [],
      attachments: []
    };
  }

  botMessage(guildId: string, template: BotMessageTemplate) {
    const container = new ContainerBuilder().setAccentColor(colorNumber(template.color));
    if (template.content.trim()) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(truncate(template.content, 4000)));
    const heading = [template.title.trim() ? `## ${truncate(template.title, 300)}` : "", truncate(template.description, 3600)].filter(Boolean).join("\n");
    if (heading) {
      if (/^https?:\/\//i.test(template.thumbnailUrl)) {
        container.addSectionComponents(new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(heading))
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(template.thumbnailUrl).setDescription(truncate(template.title || template.name, 1000))));
      } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(heading));
      }
    }
    if (/^https?:\/\//i.test(template.bannerUrl)) {
      container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(template.bannerUrl).setDescription(truncate(template.title || template.name, 1000))
      ));
    }
    if (template.footer.trim()) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${truncate(template.footer, 1900)}`));
    if (template.links.length) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(template.links.slice(0, 5).map((link) => {
        const button = new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(link.url).setLabel(truncate(link.label || "Abrir link", 80));
        if (link.emoji.trim()) button.setEmoji(this.emojis.component(link.emoji, guildId));
        return button;
      })));
    }
    if (!template.content.trim() && !heading && !template.bannerUrl && !template.footer.trim()) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent("Mensagem sem conteúdo. Edite o modelo antes de publicar."));
    }
    return checkedDiscordPayload({ flags: MessageFlags.IsComponentsV2 as const, components: [container] }, `mensagem personalizada ${template.id}`);
  }

  botMessageEdit(guildId: string, template: BotMessageTemplate) {
    return { ...this.botMessage(guildId, template), content: null, embeds: [], attachments: [] };
  }

  channelSettings(guildId: string) {
    const g = this.db.guild(guildId);
    return { embeds: [this.base(`${this.emojis.text("settings", guildId)} Canais, categorias e cargos`, `Vendas: ${g.salesChannelId ? `<#${g.salesChannelId}>` : "não definido"}
Logs gerais: ${g.logChannelId ? `<#${g.logChannelId}>` : "não definido"}
Logs de tickets: ${g.ticketLogChannelId ? `<#${g.ticketLogChannelId}>` : "não definido"}
Boas-vindas: ${g.welcomeChannelId ? `<#${g.welcomeChannelId}>` : "não definido"}
Saídas: ${g.goodbyeChannelId ? `<#${g.goodbyeChannelId}>` : "não definido"}
Tickets abertos: ${g.ticketCategoryId ? `<#${g.ticketCategoryId}>` : "não definido"}
Fechados: ${g.closedTicketCategoryId ? `<#${g.closedTicketCategoryId}>` : "não definido"}
Arquivados: ${g.archiveTicketCategoryId ? `<#${g.archiveTicketCategoryId}>` : "não definido"}
Compras privadas: ${g.purchaseCategoryId ? `<#${g.purchaseCategoryId}>` : "não definido"}
Equipe: ${g.staffRoleIds.length ? g.staffRoleIds.map((id) => `<@&${id}>`).join(" ") : "não definido"}
Administradores: ${g.adminRoleIds.length ? g.adminRoleIds.map((id) => `<@&${id}>`).join(" ") : "não definido"}
Cliente: ${g.customerRoleId ? `<@&${g.customerRoleId}>` : "não definido"}
Autorole: ${g.autoRoleId ? `<@&${g.autoRoleId}>` : "não definido"}`, guildId)], components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, "admin:channel:sales", "Vendas", "store"),
        this.button(guildId, "admin:channel:logs", "Logs gerais", "invoice"),
        this.button(guildId, "admin:channel:ticket-logs", "Logs tickets", "transcript"),
        this.button(guildId, "admin:channel:welcome", "Boas-vindas", "message"),
        this.button(guildId, "admin:channel:goodbye", "Saídas", "minus")
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, "admin:category:open", "Tickets abertos", "ticket"),
        this.button(guildId, "admin:category:closed", "Tickets fechados", "ticket_close"),
        this.button(guildId, "admin:category:archive", "Tickets arquivados", "ticket_archive"),
        this.button(guildId, "admin:category:purchases", "Compras privadas", "cart")
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.button(guildId, "admin:role:staff", "Equipe", "support"),
        this.button(guildId, "admin:role:admin", "Administradores", "settings"),
        this.button(guildId, "admin:role:customer", "Cliente", "customer"),
        this.button(guildId, "admin:role:auto", "Autorole", "users"),
        this.button(guildId, "admin:home", "Voltar", "back")
      )
    ] };
  }

  channelPicker(guildId: string, id: string, title: string, category = false) {
    const select = new ChannelSelectMenuBuilder().setCustomId(id).setPlaceholder(title).setChannelTypes(category ? ChannelType.GuildCategory : ChannelType.GuildText).setMinValues(1).setMaxValues(1);
    return { embeds: [this.base(title, "Selecione abaixo. A alteração será salva imediatamente.", guildId)], components: [new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select), this.back(guildId, "admin:channels")] };
  }
  rolePicker(guildId: string, id: string, title: string, maxValues = 1) { return { embeds: [this.base(title, "Selecione o cargo. A alteração será salva imediatamente.", guildId)], components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId(id).setPlaceholder(title).setMinValues(1).setMaxValues(Math.max(1, Math.min(10, maxValues)))), this.back(guildId, "admin:channels")] }; }
}
