import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Message,
  MessageFlags
} from "discord.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Logger } from "../core/logger.js";

interface ModerationData {
  channels: Record<string, string>;
  logs: Record<string, string>;
  bans: number;
}

const EMPTY: ModerationData = { channels: {}, logs: {}, bans: 0 };

export class ModerationService {
  private readonly filePath: string;
  private data: ModerationData;

  constructor(
    databasePath: string,
    private readonly logger: Logger
  ) {
    this.filePath = resolve(databasePath, "rave-moderation.json");
    this.data = this.load();
  }

  private load(): ModerationData {
    try {
      if (!existsSync(this.filePath)) return { ...EMPTY };
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<ModerationData>;
      return {
        channels: parsed.channels && typeof parsed.channels === "object" ? parsed.channels : {},
        logs: parsed.logs && typeof parsed.logs === "object" ? parsed.logs : {},
        bans: typeof parsed.bans === "number" ? parsed.bans : 0
      };
    } catch (error) {
      this.logger.warn("[MODERACAO] Falha ao ler rave-moderation.json, usando padrao.", { error: String(error) });
      return { ...EMPTY };
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
    } catch (error) {
      this.logger.error("[MODERACAO] Falha ao salvar rave-moderation.json.", error);
    }
  }

  setHoneypotChannel(guildId: string, channelId: string): void {
    this.data.channels[guildId] = channelId;
    this.save();
  }

  setLogChannel(guildId: string, channelId: string): void {
    this.data.logs[guildId] = channelId;
    this.save();
  }

  getHoneypotChannel(guildId: string): string | undefined {
    return this.data.channels[guildId];
  }

  getLogChannel(guildId: string): string | undefined {
    return this.data.logs[guildId];
  }

  get banCount(): number {
    return this.data.bans;
  }

  async handleMessage(message: Message): Promise<void> {
    if (!message.guild || message.author.bot) return;
    const honeypotChannelId = this.data.channels[message.guild.id];
    if (!honeypotChannelId || message.channel.id !== honeypotChannelId) return;
    if (message.author.id === message.guild.ownerId) return;

    const guild = message.guild;
    const userId = message.author.id;
    let banned = false;
    try {
      await guild.members.ban(userId, {
        deleteMessageSeconds: 604800,
        reason: "Canal de armadilha (honeypot) — mensagem enviada"
      });
      banned = true;
      this.data.bans++;
      this.save();
    } catch (error) {
      this.logger.warn("[MODERACAO] Falha ao banir no honeypot.", { guildId: guild.id, userId, error: String(error) });
    }

    const logChannelId = this.data.logs[guild.id];
    if (!logChannelId) return;
    try {
      const logChannel = await guild.channels.fetch(logChannelId);
      if (!logChannel || !logChannel.isTextBased()) return;

      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle("🚨 Usuário banido automaticamente")
        .setThumbnail(message.author.displayAvatarURL())
        .setDescription(
          `**Usuário:** <@${userId}> (\`${userId}\`)\n` +
          `**Tag:** \`${message.author.tag}\`\n` +
          `**Motivo:** Enviou mensagem no canal de armadilha\n` +
          `**Mensagens apagadas:** últimos 7 dias`
        )
        .setTimestamp();
      if (message.content) embed.addFields({ name: "Mensagem", value: message.content.slice(0, 1000) });

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`rave:unban:${userId}`)
          .setLabel("Desbanir")
          .setEmoji("🔓")
          .setStyle(ButtonStyle.Success)
      );

      await logChannel.send({ embeds: [embed], components: [row] });
    } catch (error) {
      this.logger.warn("[MODERACAO] Falha ao enviar log de banimento.", { guildId: guild.id, error: String(error) });
    }
  }
}
