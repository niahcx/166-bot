import {
  Client,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextChannel,
  TextDisplayBuilder,
  escapeMarkdown
} from "discord.js";
import type { JsonDatabase } from "../core/json-db.js";
import type { Logger } from "../core/logger.js";
import { colorNumber, makeId, nowIso, truncate } from "../core/utils.js";
import type { ProductService } from "./products.js";

export interface RestockInput {
  guildId: string;
  productId: string;
  fieldId: string;
  actorId: string;
  addedQuantity: number;
}

export class RestockAnnouncementService {
  constructor(
    private readonly client: Client,
    private readonly db: JsonDatabase,
    private readonly products: ProductService,
    private readonly logger: Logger
  ) {}

  async announce(input: RestockInput): Promise<void> {
    if (input.addedQuantity <= 0) return;
    const settings = this.db.guild(input.guildId).restockAnnouncements;
    if (!settings.enabled || !settings.channelId) return;
    const product = this.products.get(input.productId, input.guildId);
    const field = this.products.getField(product.id, input.fieldId);
    const totalQuantity = this.products.stockCount(product.id, "AVAILABLE", field.id);
    const record = {
      id: makeId("RST"), guildId: input.guildId, productId: product.id, fieldId: field.id,
      actorId: input.actorId, channelId: settings.channelId, messageId: "",
      addedQuantity: input.addedQuantity, totalQuantity, status: "FAILED" as const, error: "", createdAt: nowIso()
    };

    try {
      const channel = await this.client.channels.fetch(settings.channelId);
      if (!(channel instanceof TextChannel)) throw new Error("O canal configurado para restock não é um canal de texto acessível.");
      const container = new ContainerBuilder().setAccentColor(colorNumber(product.color));
      if (settings.mentionRoleId) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`<@&${settings.mentionRoleId}>`));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `## 📦 ${escapeMarkdown(truncate(settings.title || "Estoque atualizado", 250))}\n${truncate(settings.message || "Novas unidades disponíveis.", 1800)}`
      ));
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `**Produto:** ${escapeMarkdown(product.name)}`,
        `**Opção:** ${escapeMarkdown(field.name)}`,
        `**Quantidade nova:** +${input.addedQuantity}`,
        `**Total disponível:** ${totalQuantity}`
      ].join("\n")));
      if (settings.includeProductBanner && /^https?:\/\//i.test(product.bannerUrl)) {
        container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder().setURL(product.bannerUrl).setDescription(truncate(product.name, 1000))
        ));
      }
      const message = await channel.send({
        flags: MessageFlags.IsComponentsV2,
        components: [container],
        allowedMentions: { parse: [], roles: settings.mentionRoleId ? [settings.mentionRoleId] : [] }
      });
      Object.assign(record, { messageId: message.id, status: "SENT" as const });
      this.db.state.restockAnnouncements[record.id] = record;
      this.db.audit(input.actorId, "RESTOCK_ANNOUNCEMENT_SENT", "product", product.id, { guildId: input.guildId, fieldId: field.id, addedQuantity: input.addedQuantity, totalQuantity, channelId: channel.id }, input.guildId);
      this.db.save();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record.error = truncate(message, 500);
      this.db.state.restockAnnouncements[record.id] = record;
      this.db.errorAudit(input.guildId, "RESTOCK_ANNOUNCEMENT_FAILED", { productId: product.id, fieldId: field.id, error: record.error });
      this.db.save();
      this.logger.warn("Falha ao publicar aviso de restock.", { guildId: input.guildId, productId: product.id, error: record.error });
    }
  }
}

