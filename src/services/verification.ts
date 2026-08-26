import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags
} from "discord.js";
import type { AppConfig } from "../types.js";
import { isLocalImage, localImagePath } from "../core/image-store.js";
import type { Logger } from "../core/logger.js";

interface VerifiedUser {
  id?: string;
  username?: string;
  access_token?: string;
  refresh_token?: string;
  verifiedAt?: string;
}

interface PullProgress {
  pulled: number;
  alreadyIn: number;
  failed: number;
  processed: number;
  total: number;
}

export interface PullResponder {
  deferReply(options: { flags: number }): Promise<unknown>;
  editReply(content: string): Promise<unknown>;
}

export interface VerificationSettings {
  title: string;
  description: string;
  color: number;
  imageUrl: string;
  thumbnailUrl: string;
  buttonLabel: string;
  buttonEmoji: string;
}

const DEFAULT_SETTINGS: VerificationSettings = {
  title: "RAVE • Verificação",
  description: "Clique no botão abaixo para verificar sua conta do Discord e liberar seu acesso ao servidor.\n\nA verificação é rápida e segura.",
  color: 0x2ecc71,
  imageUrl: "",
  thumbnailUrl: "",
  buttonLabel: "Clique aqui para se verificar",
  buttonEmoji: "✅"
};

export class VerificationService {
  private settings: VerificationSettings = { ...DEFAULT_SETTINGS };

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {}

  getSettings(): VerificationSettings {
    return { ...this.settings };
  }

  updateSettings(partial: Partial<VerificationSettings>): void {
    if (partial.title !== undefined) this.settings.title = partial.title;
    if (partial.description !== undefined) this.settings.description = partial.description;
    if (partial.color !== undefined) this.settings.color = partial.color;
    if (partial.imageUrl !== undefined) this.settings.imageUrl = partial.imageUrl;
    if (partial.thumbnailUrl !== undefined) this.settings.thumbnailUrl = partial.thumbnailUrl;
    if (partial.buttonLabel !== undefined) this.settings.buttonLabel = partial.buttonLabel;
    if (partial.buttonEmoji !== undefined) this.settings.buttonEmoji = partial.buttonEmoji;
  }

  resetSettings(): void {
    this.settings = { ...DEFAULT_SETTINGS };
  }

  private get firebaseBase(): string | null {
    const url = this.config.firebaseDbUrl?.trim().replace(/\/+$/, "");
    return url ? url : null;
  }

  async allUsers(): Promise<Record<string, VerifiedUser>> {
    const base = this.firebaseBase;
    if (!base) return {};
    try {
      const response = await fetch(`${base}/users.json`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return data && typeof data === "object" ? data as Record<string, VerifiedUser> : {};
    } catch (error) {
      this.logger.warn("[VERIFICACAO] Falha ao ler usuarios no Firebase.", { error: String(error) });
      return {};
    }
  }

  async countUsers(): Promise<number> {
    return Object.keys(await this.allUsers()).length;
  }

  async saveConfigToFirebase(guildId: string): Promise<void> {
    const dbUrl = this.config.firebaseDbUrl?.trim();
    if (!dbUrl) return;
    try {
      const settings = this.getSettings();
      const roleId = (this.config as unknown as Record<string, string>).verifiedRoleId || "";
      const payload = { ...settings, roleId };
      await fetch(`${dbUrl}/verification-config/${guildId}.json`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });
      this.logger.debug(`Config de verificacao salva no Firebase para guild ${guildId}.`);
    } catch (error) {
      this.logger.warn("Falha ao salvar config de verificacao no Firebase.", error);
    }
  }

  async fetchConfigFromFirebase(guildId: string): Promise<VerificationSettings | null> {
    const dbUrl = this.config.firebaseDbUrl?.trim();
    if (!dbUrl) return null;
    try {
      const res = await fetch(`${dbUrl}/verification-config/${guildId}.json`);
      if (!res.ok) return null;
      const data = await res.json();
      if (data) this.updateSettings(data);
      return data as VerificationSettings | null;
    } catch {
      return null;
    }
  }

  panelPayload() {
    const url = this.config.verifyUrl?.trim();
    if (!url) throw new Error("URL de verificacao nao configurada (config/runtime.json -> verifyUrl).");
    const embed = new EmbedBuilder()
      .setColor(this.settings.color)
      .setTitle(this.settings.title)
      .setDescription(this.settings.description)
      .setFooter({ text: "Powered by RAVE" })
      .setTimestamp();
    const attachments: AttachmentBuilder[] = [];
    if (this.settings.imageUrl) {
      if (isLocalImage(this.settings.imageUrl)) {
        embed.setImage(`attachment://${this.settings.imageUrl}`);
        attachments.push(new AttachmentBuilder(localImagePath(this.settings.imageUrl), { name: this.settings.imageUrl }));
      } else {
        embed.setImage(this.settings.imageUrl);
      }
    }
    if (this.settings.thumbnailUrl) {
      if (isLocalImage(this.settings.thumbnailUrl)) {
        embed.setThumbnail(`attachment://${this.settings.thumbnailUrl}`);
        attachments.push(new AttachmentBuilder(localImagePath(this.settings.thumbnailUrl), { name: this.settings.thumbnailUrl }));
      } else {
        embed.setThumbnail(this.settings.thumbnailUrl);
      }
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel(this.settings.buttonLabel)
        .setEmoji(this.settings.buttonEmoji)
        .setStyle(ButtonStyle.Link)
        .setURL(url)
    );
    return { embeds: [embed], components: [row], ...(attachments.length ? { files: attachments } : {}) };
  }

  async pull(responder: PullResponder, targetGuildId: string, rawAmount: number): Promise<void> {
    const amount = Math.max(1, Math.min(500, Math.trunc(rawAmount) || 10));

    if (!/^\d{15,22}$/.test(targetGuildId)) throw new Error("ID de servidor invalido.");

    const users = await this.allUsers();
    const list = Object.entries(users)
      .map(([id, data]) => ({ id, accessToken: data.access_token ?? "", username: data.username ?? id }))
      .filter((entry) => entry.accessToken.length > 0)
      .slice(0, amount);

    await responder.deferReply({ flags: MessageFlags.Ephemeral });

    if (list.length === 0) {
      await responder.editReply("Nenhum usuario verificado encontrado no Firebase.");
      return;
    }

    const progress: PullProgress = { pulled: 0, alreadyIn: 0, failed: 0, processed: 0, total: list.length };
    await responder.editReply(this.progressText(progress, "Puxando membros..."));

    for (const entry of list) {
      try {
        const response = await fetch(
          `https://discord.com/api/v10/guilds/${targetGuildId}/members/${entry.id}`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bot ${this.config.botToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ access_token: entry.accessToken })
          }
        );
        if (response.status === 201) progress.pulled++;
        else if (response.status === 204) progress.alreadyIn++;
        else {
          progress.failed++;
          const body = await response.text().catch(() => "");
          this.logger.warn("[VERIFICACAO] Falha ao puxar membro.", {
            userId: entry.id,
            status: response.status,
            body: body.slice(0, 300)
          });
        }
      } catch (error) {
        progress.failed++;
        this.logger.warn("[VERIFICACAO] Erro ao puxar membro.", { userId: entry.id, error: String(error) });
      }
      progress.processed++;

      if (progress.processed % 5 === 0 || progress.processed === progress.total) {
        await responder.editReply(this.progressText(progress, "Puxando membros...")).catch(() => undefined);
      }
    }

    await responder.editReply(
      `# Puxada concluida!\n` +
        `**Puxados:** ${progress.pulled}\n` +
        `**Ja estavam no servidor:** ${progress.alreadyIn}\n` +
        `**Falhas:** ${progress.failed}`
    ).catch(() => undefined);
  }

  private progressText(progress: PullProgress, title: string): string {
    return (
      `**${title}**\n` +
      `Progresso: ${progress.processed}/${progress.total}\n` +
      `Puxados: ${progress.pulled}\n` +
      `Ja estavam: ${progress.alreadyIn}\n` +
      `Falhas: ${progress.failed}`
    );
  }
}
