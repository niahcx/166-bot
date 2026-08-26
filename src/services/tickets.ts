import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Guild,
  GuildMember,
  Message,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextChannel
} from "discord.js";
import type { JsonDatabase } from "../core/json-db.js";
import type { Logger } from "../core/logger.js";
import { channelSafe, colorNumber, formatMoney, makeId, nowIso, truncate } from "../core/utils.js";
import type { ButtonStyleName, Order, TicketOption, TicketPanel, TicketPanelField, TicketRecord } from "../types.js";
import type { EmojiManager } from "../emojis/manager.js";

const style = (name: ButtonStyleName) => ({ PRIMARY: ButtonStyle.Primary, SECONDARY: ButtonStyle.Secondary, SUCCESS: ButtonStyle.Success, DANGER: ButtonStyle.Danger }[name]);
const html = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const purchaseStatuses = new Set(["PAID", "DELIVERED", "AWAITING_DELIVERY"]);

export class TicketService {
  constructor(private readonly client: Client, private readonly db: JsonDatabase, private readonly emojis: EmojiManager, private readonly logger: Logger) {}

  async handleMessage(message: Message): Promise<void> {
    if (message.author.bot || !message.guildId) return;
    const ticket = this.byChannel(message.channelId);
    if (!ticket || ticket.status !== "OPEN" || ticket.ownerId !== message.author.id || ticket.purchaseGateStatus !== "PENDING") return;
    await message.delete().catch(() => undefined);
    if (!(message.channel instanceof TextChannel)) return;
    const warning = await message.channel.send({
      content: `<@${message.author.id}> selecione uma compra ou clique em **Não, é sobre outro assunto** para liberar o atendimento.`
    }).catch(() => undefined);
    if (warning) setTimeout(() => void warning.delete().catch(() => undefined), 6000).unref?.();
  }

  private async log(ticket: TicketRecord, title: string, description: string, color = 0x7c3aed): Promise<void> {
    const channelId = this.db.guild(ticket.guildId).ticketLogChannelId;
    if (!channelId) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!(channel instanceof TextChannel)) return;
      await channel.send({ embeds: [new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(description)
        .addFields(
          { name: "Ticket", value: `\`${ticket.id}\``, inline: true },
          { name: "Cliente", value: `<@${ticket.ownerId}>`, inline: true },
          { name: "Canal", value: `<#${ticket.channelId}>`, inline: true },
          { name: "Status", value: ticket.status, inline: true },
          { name: "Atendente", value: ticket.claimedBy ? `<@${ticket.claimedBy}>` : "Não assumido", inline: true },
          { name: "Compra vinculada", value: ticket.selectedOrderId ? `\`${ticket.selectedOrderId}\`` : "Nenhuma", inline: true },
          { name: "Assunto", value: truncate(ticket.subject || "Não informado", 1024) }
        )
        .setTimestamp()] });
    } catch (error) {
      this.logger.warn("Não foi possível enviar o log de ticket.", { ticketId: ticket.id, error: String(error) });
    }
  }

  listPanels(guildId?: string): TicketPanel[] { return Object.values(this.db.state.ticketPanels).filter((panel) => !guildId || panel.guildId === guildId).sort((a, b) => a.name.localeCompare(b.name)); }
  getPanel(id: string, guildId?: string): TicketPanel { const panel = this.db.state.ticketPanels[id]; if (!panel || (guildId && panel.guildId !== guildId)) throw new Error("Painel de ticket não encontrado."); return panel; }

  createPanel(input: Partial<TicketPanel> & Pick<TicketPanel, "name" | "title" | "description">, actorId: string): TicketPanel {
    const now = nowIso();
    const panel: TicketPanel = {
      id: makeId("TPN"),
      guildId: input.guildId || Object.keys(this.db.state.guilds)[0] || "legacy",
      name: input.name.trim().slice(0, 80),
      title: input.title.trim().slice(0, 256),
      description: input.description.trim().slice(0, 4000),
      color: input.color || this.db.brand(input.guildId || Object.keys(this.db.state.guilds)[0] || "legacy").color,
      imageUrl: input.imageUrl || "",
      thumbnailUrl: input.thumbnailUrl || "",
      footer: input.footer || this.db.brand(input.guildId || Object.keys(this.db.state.guilds)[0] || "legacy").footer,
      mode: input.mode || "SELECT",
      buttonLabel: input.buttonLabel || "Selecione o tipo de atendimento",
      buttonStyle: input.buttonStyle || "SECONDARY",
      emojiSemantic: input.emojiSemantic || "ticket",
      fields: input.fields || [],
      options: input.options || [],
      createdAt: now,
      updatedAt: now
    };
    this.db.state.ticketPanels[panel.id] = panel;
    this.db.audit(actorId, "TICKET_PANEL_CREATE", "ticket_panel", panel.id);
    this.db.save();
    return panel;
  }

  updatePanel(id: string, patch: Partial<TicketPanel>, actorId: string): TicketPanel {
    const panel = this.getPanel(id);
    Object.assign(panel, patch, { id: panel.id, createdAt: panel.createdAt, updatedAt: nowIso() });
    panel.title = panel.title.slice(0, 256);
    panel.description = panel.description.slice(0, 4000);
    panel.buttonLabel = panel.buttonLabel.slice(0, 150);
    panel.fields = (panel.fields || []).slice(0, 25);
    this.db.audit(actorId, "TICKET_PANEL_UPDATE", "ticket_panel", id);
    this.db.save();
    return panel;
  }

  deletePanel(id: string, actorId: string) {
    this.getPanel(id);
    delete this.db.state.ticketPanels[id];
    this.db.audit(actorId, "TICKET_PANEL_DELETE", "ticket_panel", id);
    this.db.save();
  }

  addPanelField(panelId: string, input: Pick<TicketPanelField, "name" | "value" | "inline">, actorId: string): TicketPanelField {
    const panel = this.getPanel(panelId);
    if (panel.fields.length >= 25) throw new Error("O painel já possui o limite de 25 campos.");
    const field: TicketPanelField = {
      id: makeId("TFD"),
      name: input.name.trim().slice(0, 256) || "Informação",
      value: input.value.trim().slice(0, 1024) || "-",
      inline: Boolean(input.inline)
    };
    panel.fields.push(field);
    panel.updatedAt = nowIso();
    this.db.audit(actorId, "TICKET_FIELD_CREATE", "ticket_panel", panelId, { fieldId: field.id });
    this.db.save();
    return field;
  }

  updatePanelField(panelId: string, fieldId: string, patch: Partial<TicketPanelField>, actorId: string): TicketPanelField {
    const panel = this.getPanel(panelId);
    const field = panel.fields.find((item) => item.id === fieldId);
    if (!field) throw new Error("Campo do painel não encontrado.");
    if (patch.name !== undefined) field.name = patch.name.trim().slice(0, 256) || "Informação";
    if (patch.value !== undefined) field.value = patch.value.trim().slice(0, 1024) || "-";
    if (patch.inline !== undefined) field.inline = Boolean(patch.inline);
    panel.updatedAt = nowIso();
    this.db.audit(actorId, "TICKET_FIELD_UPDATE", "ticket_panel", panelId, { fieldId });
    this.db.save();
    return field;
  }

  deletePanelField(panelId: string, fieldId: string, actorId: string): void {
    const panel = this.getPanel(panelId);
    if (!panel.fields.some((item) => item.id === fieldId)) throw new Error("Campo do painel não encontrado.");
    panel.fields = panel.fields.filter((item) => item.id !== fieldId);
    panel.updatedAt = nowIso();
    this.db.audit(actorId, "TICKET_FIELD_DELETE", "ticket_panel", panelId, { fieldId });
    this.db.save();
  }

  addOption(panelId: string, input: Partial<TicketOption> & Pick<TicketOption, "name" | "description">, actorId: string): TicketOption {
    const panel = this.getPanel(panelId);
    if (panel.options.length >= 25) throw new Error("O painel já possui o limite de 25 opções.");
    const option: TicketOption = {
      id: makeId("OPT"), name: input.name.trim().slice(0, 100), description: input.description.trim().slice(0, 100), emojiSemantic: input.emojiSemantic || "support",
      categoryId: input.categoryId || "", supportRoleIds: input.supportRoleIds || [], channelPrefix: input.channelPrefix || "ticket",
      openingTitle: input.openingTitle || "Atendimento aberto", openingDescription: input.openingDescription || "Explique com detalhes como podemos ajudar. Um atendente responderá em breve.",
      closeMessage: input.closeMessage || "Ticket encerrado. Obrigado por entrar em contato.",
      askSubject: input.askSubject ?? true,
      maxOpenTicketsPerUser: Math.max(1, Math.min(10, Number(input.maxOpenTicketsPerUser ?? 1))),
      mentionSupport: input.mentionSupport ?? true,
      active: input.active ?? true,
      position: Number.isFinite(Number(input.position)) ? Number(input.position) : panel.options.length
    };
    panel.options.push(option);
    panel.updatedAt = nowIso();
    this.db.audit(actorId, "TICKET_OPTION_CREATE", "ticket_panel", panelId, { optionId: option.id });
    this.db.save();
    return option;
  }

  updateOption(panelId: string, optionId: string, patch: Partial<TicketOption>, actorId: string): TicketOption {
    const panel = this.getPanel(panelId);
    const option = panel.options.find((item) => item.id === optionId);
    if (!option) throw new Error("Opção não encontrada.");

    if (patch.name !== undefined) option.name = patch.name.trim().slice(0, 100) || "Atendimento";
    if (patch.description !== undefined) option.description = patch.description.trim().slice(0, 100) || "Abrir atendimento";
    if (patch.emojiSemantic !== undefined) option.emojiSemantic = patch.emojiSemantic.trim().slice(0, 120);
    if (patch.categoryId !== undefined) option.categoryId = patch.categoryId.trim();
    if (patch.supportRoleIds !== undefined) option.supportRoleIds = [...new Set(patch.supportRoleIds.filter(Boolean))].slice(0, 20);
    if (patch.channelPrefix !== undefined) option.channelPrefix = channelSafe(patch.channelPrefix || "ticket").slice(0, 40) || "ticket";
    if (patch.openingTitle !== undefined) option.openingTitle = patch.openingTitle.trim().slice(0, 256) || "Atendimento aberto";
    if (patch.openingDescription !== undefined) option.openingDescription = patch.openingDescription.trim().slice(0, 4000) || "Explique com detalhes como podemos ajudar.";
    if (patch.closeMessage !== undefined) option.closeMessage = patch.closeMessage.trim().slice(0, 1800) || "Ticket encerrado. Obrigado por entrar em contato.";
    if (patch.askSubject !== undefined) option.askSubject = Boolean(patch.askSubject);
    if (patch.maxOpenTicketsPerUser !== undefined) option.maxOpenTicketsPerUser = Math.max(1, Math.min(10, Math.trunc(Number(patch.maxOpenTicketsPerUser) || 1)));
    if (patch.mentionSupport !== undefined) option.mentionSupport = Boolean(patch.mentionSupport);
    if (patch.active !== undefined) option.active = Boolean(patch.active);
    if (patch.position !== undefined && Number.isFinite(Number(patch.position))) option.position = Math.max(0, Math.trunc(Number(patch.position)));

    panel.options.sort((a, b) => a.position - b.position).forEach((item, index) => { item.position = index; });
    panel.updatedAt = nowIso();
    this.db.audit(actorId, "TICKET_OPTION_UPDATE", "ticket_option", optionId, { fields: Object.keys(patch) });
    this.db.save();
    return option;
  }

  moveOption(panelId: string, optionId: string, direction: "UP" | "DOWN", actorId: string): TicketOption {
    const panel = this.getPanel(panelId);
    panel.options.sort((a, b) => a.position - b.position);
    const index = panel.options.findIndex((item) => item.id === optionId);
    if (index < 0) throw new Error("Opção não encontrada.");
    const targetIndex = direction === "UP" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= panel.options.length) return panel.options[index]!;
    [panel.options[index], panel.options[targetIndex]] = [panel.options[targetIndex]!, panel.options[index]!];
    panel.options.forEach((item, position) => { item.position = position; });
    panel.updatedAt = nowIso();
    this.db.audit(actorId, "TICKET_OPTION_REORDER", "ticket_option", optionId, { direction, position: targetIndex });
    this.db.save();
    return panel.options[targetIndex]!;
  }

  deleteOption(panelId: string, optionId: string, actorId: string) {
    const panel = this.getPanel(panelId);
    if (!panel.options.some((item) => item.id === optionId)) throw new Error("Opção não encontrada.");
    panel.options = panel.options.filter((item) => item.id !== optionId);
    panel.options.sort((a, b) => a.position - b.position).forEach((item, index) => { item.position = index; });
    panel.updatedAt = nowIso();
    this.db.audit(actorId, "TICKET_OPTION_DELETE", "ticket_option", optionId);
    this.db.save();
  }

  controls(ticket: TicketRecord): ActionRowBuilder<ButtonBuilder>[] {
    const gid = ticket.guildId;
    if (ticket.status === "OPEN") return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`ticket:claim:${ticket.id}`).setLabel("Assumir").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`ticket:add:${ticket.id}`).setLabel("Adicionar membro").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`ticket:remove:${ticket.id}`).setLabel("Remover membro").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`ticket:rename:${ticket.id}`).setLabel("Renomear").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`ticket:close:${ticket.id}`).setLabel("Fechar").setStyle(ButtonStyle.Danger)
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`ticket:transcript:${ticket.id}`).setLabel("Transcript").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`ticket:archive:${ticket.id}`).setLabel("Arquivar").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`ticket:notify:${ticket.id}`).setLabel("Notificar cliente").setStyle(ButtonStyle.Primary)
      )
    ];
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`ticket:reopen:${ticket.id}`).setLabel("Reabrir").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`ticket:transcript:${ticket.id}`).setLabel("Transcript").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`ticket:delete:${ticket.id}`).setLabel("Excluir canal").setStyle(ButtonStyle.Danger)
    )];
  }

  private userPurchases(guildId: string, userId: string): Order[] {
    return Object.values(this.db.state.orders)
      .filter((order) => order.guildId === guildId && order.userId === userId && purchaseStatuses.has(order.status))
      .sort((a, b) => (b.paidAt || b.createdAt).localeCompare(a.paidAt || a.createdAt));
  }

  private purchaseGateComponents(ticket: TicketRecord, purchases: Order[], disabled = false) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`ticket:purchase-select:${ticket.id}`)
      .setPlaceholder("Selecionar uma compra")
      .setDisabled(disabled)
      .addOptions(purchases.slice(0, 25).map((order) => {
        const items = order.items.map((item) => `${item.productName} • ${item.fieldName}`).join(", ");
        return new StringSelectMenuOptionBuilder()
          .setLabel(truncate(`${order.id} • ${formatMoney(order.totalCents)}`, 100))
          .setDescription(truncate(items || "Compra registrada", 100))
          .setValue(order.id);
      }));
    const none = new ButtonBuilder()
      .setCustomId(`ticket:purchase-none:${ticket.id}`)
      .setLabel("Não, é sobre outro assunto")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled);
    return [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(none)
    ];
  }

  async open(guild: Guild, member: GuildMember, panelId: string, optionId: string, subject: string): Promise<TextChannel> {
    const panel = this.getPanel(panelId, guild.id);
    const option = panel.options.find((item) => item.id === optionId && item.active);
    if (!option) throw new Error("Esta opção de atendimento está indisponível.");
    const openForOption = Object.values(this.db.state.tickets)
      .filter((ticket) => ticket.guildId === guild.id && ticket.ownerId === member.id && ticket.optionId === option.id && ticket.status === "OPEN");
    if (openForOption.length >= option.maxOpenTicketsPerUser) {
      const current = openForOption[0];
      const channel = current ? await guild.channels.fetch(current.channelId).catch(() => undefined) : undefined;
      const location = channel?.isTextBased() ? `: <#${current!.channelId}>` : ".";
      throw new Error(`Você atingiu o limite de ${option.maxOpenTicketsPerUser} ticket(s) aberto(s) para esta opção${location}`);
    }

    const purchases = this.userPurchases(guild.id, member.id);
    const needsPurchaseChoice = purchases.length > 0;
    const settings = this.db.guild(guild.id);
    const requestedCategoryId = option.categoryId || settings.ticketCategoryId || undefined;
    const requestedCategory = requestedCategoryId ? await guild.channels.fetch(requestedCategoryId).catch(() => undefined) : undefined;
    const categoryId = requestedCategory?.type === ChannelType.GuildCategory ? requestedCategory.id : undefined;
    await guild.roles.fetch().catch(() => undefined);
    const roles = [...new Set([...settings.staffRoleIds, ...settings.permissions.supportRoleIds, ...settings.permissions.ticketRoleIds, ...option.supportRoleIds])].filter((id) => guild.roles.cache.has(id));

    const botId = guild.members.me?.id ?? this.client.user?.id;
    const channel = await guild.channels.create({
      name: `${channelSafe(option.channelPrefix)}-${channelSafe(member.user.username)}`.slice(0, 95),
      type: ChannelType.GuildText,
      parent: categoryId,
      topic: `166 Community Ticket | owner=${member.id} | panel=${panel.id} | option=${option.id}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: member.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.SendMessages],
        },
        ...roles.map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] })),
        ...(botId ? [{ id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] }] : [])
      ]
    });
    if (!(channel instanceof TextChannel)) throw new Error("Falha ao criar canal de ticket.");

    const ticket: TicketRecord = {
      id: makeId("TKT"), guildId: guild.id, channelId: channel.id, ownerId: member.id, panelId, optionId,
      subject: subject || option.name, claimedBy: "", status: "OPEN",
      purchaseGateStatus: needsPurchaseChoice ? "PENDING" : "NOT_REQUIRED", selectedOrderId: "", gateMessageId: "", createdAt: nowIso()
    };
    this.db.state.tickets[ticket.id] = ticket;
    this.db.audit(member.id, "TICKET_OPEN", "ticket", ticket.id, { guildId: guild.id, purchaseGate: ticket.purchaseGateStatus }, guild.id);
    this.db.save();

    const replace = (value: string) => value.replaceAll("{user}", `<@${member.id}>`).replaceAll("{subject}", subject || option.name);
    const staffMention = roles.length > 0 ? roles.map((id) => `<@&${id}>`).join(" ") : "";
    const panelColor = Number.isFinite(colorNumber(panel.color)) ? colorNumber(panel.color) : 0x5865F2;
    const embed = new EmbedBuilder()
      .setColor(panelColor)
      .setTitle(truncate(`Atendimento - ${option.openingTitle}`, 256))
      .setDescription(truncate(replace(option.openingDescription), 4000) || "Ticket aberto.")
      .addFields(
        { name: "Cliente", value: `<@${member.id}>`, inline: true },
        { name: "Assunto", value: truncate(subject || option.name, 1024) || "Geral", inline: true },
        { name: "Status", value: "Aberto", inline: true }
      )
      .setTimestamp();
    const staffFields = panel.fields.filter((f) => f.name.trim()).slice(0, 22);
    for (const field of staffFields) {
      const fname = replace(field.name).trim();
      const fval = truncate(replace(field.value), 1024) || "-";
      if (fname) embed.addFields({ name: fname.slice(0, 256), value: fval, inline: field.inline });
    }
    if (panel.footer) embed.setFooter({ text: truncate(panel.footer, 2048) });

    try {
      await channel.send({
        content: [staffMention, `<@${member.id}>`].filter(Boolean).join(" ") || undefined,
        embeds: [embed],
        components: this.controls(ticket)
      });
    } catch (err) {
      this.logger.error("Falha ao enviar painel staff no ticket.", { ticketId: ticket.id, error: String(err) });
      try {
        await channel.send({ content: `Ticket aberto para <@${member.id}>. Assunto: ${subject || option.name}` });
      } catch { /* ignore */ }
    }

    try {
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle("Suporte 166 Community")
            .setDescription(`Ticket aberto para **${truncate(subject || option.name, 200)}**.\nUse os botões abaixo para gerenciar seu atendimento.`)
            .addFields(
              { name: "Status", value: "Aberto", inline: true },
              { name: "Assunto", value: truncate(subject || option.name, 1024) || "Geral", inline: true }
            )
            .setFooter({ text: "166 Community • Atendimento" })
            .setTimestamp()
        ],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`ticket:member-close:${ticket.id}`).setLabel("Fechar ticket").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`ticket:member-status:${ticket.id}`).setLabel("Ver status").setStyle(ButtonStyle.Secondary)
          )
        ]
      });
    } catch (err) {
      this.logger.error("Falha ao enviar painel membro no ticket.", { ticketId: ticket.id, error: String(err) });
    }

    if (needsPurchaseChoice) {
      try {
        const gate = await channel.send({
          embeds: [new EmbedBuilder()
            .setColor(panelColor)
            .setTitle("Este atendimento e sobre alguma das suas compras?")
            .setDescription("Selecione uma compra registrada abaixo ou informe que o atendimento e sobre outro assunto.\n\nEnquanto esta etapa nao for respondida, o envio de mensagens ficara bloqueado.")
            .setFooter({ text: "166 Community • Identificacao automatica do atendimento" })],
          components: this.purchaseGateComponents(ticket, purchases)
        });
        ticket.gateMessageId = gate.id;
        this.db.save();
      } catch (err) {
        this.logger.error("Falha ao enviar purchase gate no ticket.", { ticketId: ticket.id, error: String(err) });
      }
    }

    await this.log(ticket, "Ticket aberto", `Aberto por <@${member.id}> usando **${panel.name} → ${option.name}**.`, 0x22c55e);
    return channel;
  }

  getTicket(id: string): TicketRecord { const ticket = this.db.state.tickets[id]; if (!ticket) throw new Error("Ticket não encontrado."); return ticket; }
  byChannel(channelId: string) { return Object.values(this.db.state.tickets).find((ticket) => ticket.channelId === channelId); }

  async resolvePurchaseGate(ticketId: string, actorId: string, orderId?: string): Promise<TicketRecord> {
    const ticket = this.getTicket(ticketId);
    if (ticket.ownerId !== actorId) throw new Error("Somente o cliente deste ticket pode responder esta pergunta.");
    if (ticket.purchaseGateStatus !== "PENDING") throw new Error("Esta etapa já foi respondida.");
    let selected: Order | undefined;
    if (orderId) {
      selected = this.db.state.orders[orderId];
      if (!selected || selected.userId !== actorId || selected.guildId !== ticket.guildId || !purchaseStatuses.has(selected.status)) throw new Error("Compra inválida ou não pertence à sua conta.");
    }
    ticket.purchaseGateStatus = "RESOLVED";
    ticket.selectedOrderId = selected?.id || "";
    this.db.audit(actorId, "TICKET_PURCHASE_CONTEXT", "ticket", ticket.id, { orderId: ticket.selectedOrderId || null });
    this.db.save();

    const channel = await this.client.channels.fetch(ticket.channelId);
    if (!(channel instanceof TextChannel)) throw new Error("Canal do ticket não encontrado.");
    await channel.permissionOverwrites.edit(ticket.ownerId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
      EmbedLinks: true
    });

    if (ticket.gateMessageId) {
      const gateMessage = await channel.messages.fetch(ticket.gateMessageId).catch(() => undefined);
      if (gateMessage) {
        const purchases = this.userPurchases(ticket.guildId, ticket.ownerId);
        const description = selected
          ? `Atendimento vinculado ao pedido **${selected.id}**.\n\n**Itens:**\n${selected.items.map((item) => `• ${item.quantity}× ${item.productName} • ${item.fieldName}`).join("\n")}`
          : "O cliente informou que o atendimento é sobre outro assunto.";
        await gateMessage.edit({
          embeds: [new EmbedBuilder().setColor(0x22c55e).setTitle("Atendimento liberado").setDescription(description).setTimestamp()],
          components: purchases.length ? this.purchaseGateComponents(ticket, purchases, true) : []
        }).catch(() => undefined);
      }
    }

    await channel.send({
      embeds: [new EmbedBuilder().setColor(0x22c55e).setDescription(selected ? `${this.emojis.text("approve", ticket.guildId)} Mensagens liberadas. Este ticket está vinculado ao pedido **${selected.id}**.` : `${this.emojis.text("approve", ticket.guildId)} Mensagens liberadas. Explique como podemos ajudar.`)]
    });
    await this.log(ticket, "Contexto do atendimento definido", selected ? `Compra vinculada: **${selected.id}**.` : "Atendimento marcado como outro assunto.", 0x22c55e);
    return ticket;
  }

  async claim(ticketId: string, actor: GuildMember): Promise<TicketRecord> {
    const ticket = this.getTicket(ticketId); if (ticket.status !== "OPEN") throw new Error("Ticket fechado.");
    const settings = this.db.guild(ticket.guildId);
    const ticketRoles = [...settings.staffRoleIds, ...settings.permissions.supportRoleIds, ...settings.permissions.ticketRoleIds];
    const allowed = actor.permissions.has(PermissionFlagsBits.ManageChannels) || ticketRoles.some((id) => actor.roles.cache.has(id));
    if (!allowed) throw new Error("Somente a equipe pode assumir tickets.");
    ticket.claimedBy = actor.id; this.db.audit(actor.id, "TICKET_CLAIM", "ticket", ticket.id); this.db.save();

    const user = await this.client.users.fetch(ticket.ownerId).catch(() => undefined);
    if (user) {
      const dmEmbed = new EmbedBuilder()
        .setColor(0x3b82f6)
        .setTitle("Sua demanda foi atendida")
        .setDescription(`<@${actor.id}> assumiu seu atendimento no ticket **${ticket.subject || "Atendimento"}**.\n\nEnvie sua mensagem no canal do ticket.`)
        .setFooter({ text: "166 Community" })
        .setTimestamp();
      await user.send({ embeds: [dmEmbed] }).catch(() => undefined);
    }

    await this.log(ticket, "Ticket assumido", `Atendimento assumido por <@${actor.id}>.`, 0x3b82f6); return ticket;
  }

  async notifyOwner(ticketId: string, actorId: string): Promise<{ dmSent: boolean; count: number }> {
    const ticket = this.getTicket(ticketId);
    if (ticket.status !== "OPEN") throw new Error("Somente tickets abertos podem notificar o cliente.");
    const previous = ticket.lastNotifiedAt ? Date.parse(ticket.lastNotifiedAt) : 0;
    if (previous && Date.now() - previous < 60_000) throw new Error("Aguarde 1 minuto antes de notificar este cliente novamente.");

    const channel = await this.client.channels.fetch(ticket.channelId).catch(() => undefined);
    if (!(channel instanceof TextChannel)) throw new Error("Canal do ticket indisponível.");
    const user = await this.client.users.fetch(ticket.ownerId).catch(() => undefined);
    const url = `https://discord.com/channels/${ticket.guildId}/${ticket.channelId}`;
    const dmSent = user ? await user.send({ embeds: [new EmbedBuilder()
      .setColor(0x3155ff)
      .setTitle("Sua presença foi solicitada no atendimento")
      .setDescription(`A equipe está aguardando sua resposta no ticket <#${ticket.channelId}>.\n\n[Ir para o atendimento](${url})`)
      .setTimestamp()] }).then(() => true).catch(() => false) : false;

    await channel.send({
      content: `<@${ticket.ownerId}> a equipe está aguardando sua resposta.${dmSent ? " Também enviamos uma mensagem privada." : " Não foi possível enviar mensagem privada."}`,
      allowedMentions: { users: [ticket.ownerId] }
    });
    ticket.lastNotifiedAt = nowIso();
    ticket.notificationCount = (ticket.notificationCount ?? 0) + 1;
    this.db.audit(actorId, "TICKET_OWNER_NOTIFY", "ticket", ticket.id, { dmSent, notificationCount: ticket.notificationCount }, ticket.guildId);
    this.db.save();
    await this.log(ticket, "Cliente notificado", `<@${actorId}> notificou <@${ticket.ownerId}>. DM: **${dmSent ? "enviada" : "indisponível"}**.`);
    return { dmSent, count: ticket.notificationCount };
  }

  async close(ticketId: string, actorId: string): Promise<TicketRecord> {
    const ticket = this.getTicket(ticketId); const guild = await this.client.guilds.fetch(ticket.guildId); const channel = await guild.channels.fetch(ticket.channelId);
    if (!(channel instanceof TextChannel)) throw new Error("Canal não encontrado.");
    await channel.permissionOverwrites.edit(ticket.ownerId, { SendMessages: false });
    const parent = this.db.guild(ticket.guildId).closedTicketCategoryId; if (parent) await channel.setParent(parent, { lockPermissions: false }).catch(() => undefined);
    ticket.status = "CLOSED"; ticket.closedAt = nowIso(); this.db.audit(actorId, "TICKET_CLOSE", "ticket", ticket.id); this.db.save();
    const panel = this.db.state.ticketPanels[ticket.panelId];
    const option = panel?.options.find((item) => item.id === ticket.optionId);
    const closeText = (option?.closeMessage || "Ticket encerrado. Obrigado por entrar em contato.").replaceAll("{user}", `<@${ticket.ownerId}>`).replaceAll("{staff}", `<@${actorId}>`);
    await channel.send({ embeds: [new EmbedBuilder().setColor(0xef4444).setDescription(`${closeText}\n\nFechado por <@${actorId}>.`).setTimestamp()], components: this.controls(ticket) });

    const user = await this.client.users.fetch(ticket.ownerId).catch(() => undefined);
    if (user) {
      const dmEmbed = new EmbedBuilder()
        .setColor(0xef4444)
        .setTitle("Seu atendimento foi encerrado")
        .setDescription(`Seu ticket **${ticket.subject || option?.name || "Atendimento"}** no servidor **${guild.name}** foi fechado por <@${actorId}>.\n\nSe precisar de ajuda novamente, abra um novo ticket.`)
        .setFooter({ text: "166 Community" })
        .setTimestamp();
      await user.send({ embeds: [dmEmbed] }).catch(() => undefined);
    }

    await this.log(ticket, "Ticket fechado", `Fechado por <@${actorId}>.`, 0xef4444);
    return ticket;
  }

  async archive(ticketId: string, actorId: string): Promise<TicketRecord> {
    const ticket = this.getTicket(ticketId); const guild = await this.client.guilds.fetch(ticket.guildId); const channel = await guild.channels.fetch(ticket.channelId);
    if (!(channel instanceof TextChannel)) throw new Error("Canal não encontrado.");
    const parent = this.db.guild(ticket.guildId).archiveTicketCategoryId; if (parent) await channel.setParent(parent, { lockPermissions: false }).catch(() => undefined);
    await channel.permissionOverwrites.edit(ticket.ownerId, { ViewChannel: false, SendMessages: false });
    ticket.status = "ARCHIVED"; ticket.archivedAt = nowIso(); this.db.audit(actorId, "TICKET_ARCHIVE", "ticket", ticket.id); this.db.save();
    await channel.send({ embeds: [new EmbedBuilder().setColor(0x64748b).setDescription(`Ticket arquivado por <@${actorId}>.`)], components: this.controls(ticket) });
    await this.log(ticket, "Ticket arquivado", `Arquivado por <@${actorId}>.`, 0x64748b);
    return ticket;
  }

  async reopen(ticketId: string, actorId: string): Promise<TicketRecord> {
    const ticket = this.getTicket(ticketId); const guild = await this.client.guilds.fetch(ticket.guildId); const channel = await guild.channels.fetch(ticket.channelId);
    if (!(channel instanceof TextChannel)) throw new Error("Canal não encontrado.");
    const parent = this.db.guild(ticket.guildId).ticketCategoryId; if (parent) await channel.setParent(parent, { lockPermissions: false }).catch(() => undefined);
    await channel.permissionOverwrites.edit(ticket.ownerId, { ViewChannel: true, SendMessages: ticket.purchaseGateStatus !== "PENDING", ReadMessageHistory: true });
    ticket.status = "OPEN"; delete ticket.closedAt; delete ticket.archivedAt; this.db.audit(actorId, "TICKET_REOPEN", "ticket", ticket.id); this.db.save();
    await channel.send({ embeds: [new EmbedBuilder().setColor(0x22c55e).setDescription(`Ticket reaberto por <@${actorId}>.`)], components: this.controls(ticket) });
    await this.log(ticket, "Ticket reaberto", `Reaberto por <@${actorId}>.`, 0x22c55e);
    return ticket;
  }

  async addMember(ticketId: string, userId: string, actorId: string) {
    const ticket = this.getTicket(ticketId); const channel = await this.client.channels.fetch(ticket.channelId); if (!(channel instanceof TextChannel)) throw new Error("Canal não encontrado.");
    await channel.permissionOverwrites.edit(userId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
    this.db.audit(actorId, "TICKET_MEMBER_ADD", "ticket", ticketId, { userId }); this.db.save(); await this.log(ticket, "Membro adicionado", `<@${userId}> foi adicionado por <@${actorId}>.`, 0x3b82f6);
  }

  async removeMember(ticketId: string, userId: string, actorId: string) {
    const ticket = this.getTicket(ticketId); if (userId === ticket.ownerId) throw new Error("O dono do ticket não pode ser removido.");
    const channel = await this.client.channels.fetch(ticket.channelId); if (!(channel instanceof TextChannel)) throw new Error("Canal não encontrado.");
    await channel.permissionOverwrites.delete(userId); this.db.audit(actorId, "TICKET_MEMBER_REMOVE", "ticket", ticketId, { userId }); this.db.save(); await this.log(ticket, "Membro removido", `<@${userId}> foi removido por <@${actorId}>.`, 0xf59e0b);
  }

  async rename(ticketId: string, name: string, actorId: string) {
    const ticket = this.getTicket(ticketId); const channel = await this.client.channels.fetch(ticket.channelId); if (!(channel instanceof TextChannel)) throw new Error("Canal não encontrado.");
    await channel.setName(channelSafe(name).slice(0, 95)); this.db.audit(actorId, "TICKET_RENAME", "ticket", ticketId, { name }); this.db.save(); await this.log(ticket, "Ticket renomeado", `Novo nome: **${channelSafe(name).slice(0, 95)}** por <@${actorId}>.`, 0x8b5cf6);
  }

  async transcript(ticketId: string): Promise<string> {
    const ticket = this.getTicket(ticketId); const channel = await this.client.channels.fetch(ticket.channelId); if (!(channel instanceof TextChannel)) throw new Error("Canal não encontrado.");
    const rows: Array<{ id: string; time: string; author: string; avatar: string; content: string; attachments: string[] }> = [];
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const messages = await channel.messages.fetch({ limit: 100, before }); if (!messages.size) break;
      for (const message of messages.values()) rows.push({ id: message.id, time: message.createdAt.toISOString(), author: `${message.author.username} (${message.author.id})`, avatar: message.author.displayAvatarURL(), content: message.content, attachments: [...message.attachments.values()].map((item) => item.url) });
      before = messages.last()?.id; if (messages.size < 100) break;
    }
    rows.sort((a, b) => a.time.localeCompare(b.time));
    const document = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${html(channel.name)}</title><style>body{background:#101217;color:#e8eaf0;font-family:Arial;margin:0}.head{padding:24px;background:#171a22;position:sticky;top:0}.msg{display:flex;gap:12px;padding:14px 24px;border-bottom:1px solid #242834}.msg img{width:42px;height:42px;border-radius:50%}.meta{color:#9aa2b2;font-size:12px}.content{white-space:pre-wrap;margin-top:5px}.att a{color:#a78bfa}</style></head><body><div class="head"><h1>${html(channel.name)}</h1><div>Ticket ${html(ticket.id)} • ${rows.length} mensagens</div></div>${rows.map((row) => `<div class="msg"><img src="${html(row.avatar)}"><div><b>${html(row.author)}</b> <span class="meta">${html(row.time)}</span><div class="content">${html(row.content || "[sem texto]")}</div>${row.attachments.length ? `<div class="att">${row.attachments.map((url) => `<a href="${html(url)}">Anexo</a>`).join(" • ")}</div>` : ""}</div></div>`).join("")}</body></html>`;
    const dir = resolve("storage/transcripts"); mkdirSync(dir, { recursive: true }); const path = resolve(dir, `${ticket.id}.html`); writeFileSync(path, document, "utf8"); return path;
  }

  async deleteChannel(ticketId: string, actorId: string) {
    const ticket = this.getTicket(ticketId); const channel = await this.client.channels.fetch(ticket.channelId).catch(() => undefined);
    await this.log(ticket, "Ticket excluído", `Canal excluído por <@${actorId}>.`, 0xdc2626);
    this.db.audit(actorId, "TICKET_DELETE_CHANNEL", "ticket", ticketId, { guildId: ticket.guildId }, ticket.guildId);
    this.db.state.ticketHistory.unshift({ ...ticket, status: ticket.status === "OPEN" ? "ARCHIVED" : ticket.status, archivedAt: ticket.archivedAt || nowIso() });
    if (this.db.state.ticketHistory.length > 10000) this.db.state.ticketHistory.length = 10000;
    delete this.db.state.tickets[ticketId]; this.db.save();
    if (channel?.isDMBased() === false && "delete" in channel) await channel.delete(`Ticket removido por ${actorId}`);
  }
}
