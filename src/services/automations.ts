import { Client, EmbedBuilder, GuildMember, Message, PermissionFlagsBits, TextChannel, type PartialGuildMember } from "discord.js";
import type { JsonDatabase } from "../core/json-db.js";
import type { Logger } from "../core/logger.js";
import { colorNumber, truncate } from "../core/utils.js";
import type { LockService } from "./locks.js";

export class AutomationService {
  private spam = new Map<string, number[]>();
  private scheduleTimer?: NodeJS.Timeout;
  private scheduleRunning = false;
  constructor(private readonly client: Client, private readonly db: JsonDatabase, private readonly logger: Logger, private readonly locks: LockService) {}
  start() {
    this.client.on("guildMemberAdd", (member) => void this.memberAdd(member));
    this.client.on("guildMemberRemove", (member) => void this.memberRemove(member));
    this.client.on("messageDelete", (message) => void this.deleted(message as Message));
    this.client.on("messageUpdate", (oldMessage, newMessage) => void this.edited(oldMessage as Message, newMessage as Message));
    this.scheduleTimer = setInterval(() => void this.runChannelSchedules(), 30_000);
    this.scheduleTimer.unref?.();
    setTimeout(() => void this.runChannelSchedules(), 5000).unref?.();
  }
  stop() { if (this.scheduleTimer) clearInterval(this.scheduleTimer); this.scheduleTimer = undefined; }

  private clock(timezone: string): { date: string; time: string } {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date());
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
    return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
  }

  async runChannelSchedules(): Promise<void> {
    if (this.scheduleRunning || !this.client.isReady()) return;
    this.scheduleRunning = true;
    try {
      for (const [guildId, settings] of Object.entries(this.db.state.guildAutomations)) {
        for (const schedule of settings.channelSchedules ?? []) {
          if (!schedule.enabled || !schedule.channelIds.length) continue;
          let current: { date: string; time: string };
          try { current = this.clock(schedule.timezone || "America/Sao_Paulo"); }
          catch { current = this.clock("America/Sao_Paulo"); }
          const action = current.time === schedule.lockTime && schedule.lastLockDate !== current.date
            ? "LOCK"
            : current.time === schedule.unlockTime && schedule.lastUnlockDate !== current.date
              ? "UNLOCK"
              : "";
          if (!action) continue;

          const actor = { id: this.client.user?.id ?? "system" };
          let changed = 0;
          const failures: Array<{ channelId: string; error: string }> = [];
          for (const channelId of schedule.channelIds) {
            const channel = await this.client.channels.fetch(channelId).catch(() => undefined);
            if (!(channel instanceof TextChannel) || channel.guild.id !== guildId) {
              failures.push({ channelId, error: "Canal não encontrado ou pertence a outro servidor." });
              continue;
            }
            try {
              if (action === "LOCK") await this.locks.lock(channel, actor, `Automação ${schedule.name}`);
              else await this.locks.unlock(channel, actor, `Automação ${schedule.name}`);
              const message = action === "LOCK" ? schedule.lockMessage : schedule.unlockMessage;
              if (message.trim()) await channel.send({ content: truncate(message, 1800), allowedMentions: { parse: [] } }).catch(() => undefined);
              changed++;
            } catch (error) {
              failures.push({ channelId, error: String(error) });
            }
          }
          if (action === "LOCK") schedule.lastLockDate = current.date;
          else schedule.lastUnlockDate = current.date;
          schedule.updatedAt = new Date().toISOString();
          this.db.audit("system", `CHANNEL_SCHEDULE_${action}`, "channel_schedule", schedule.id, { guildId, changed, failures }, guildId);
          this.db.save();
          this.logger.info(`Automação de canais executada: ${schedule.name}.`, { guildId, action, changed, failures: failures.length });
        }
      }
    } finally {
      this.scheduleRunning = false;
    }
  }
  private template(value: string, member: GuildMember | PartialGuildMember) { return value.replaceAll("{user}", `<@${member.id}>`).replaceAll("{username}", member.user.username).replaceAll("{server}", member.guild.name).replaceAll("{count}", String(member.guild.memberCount)); }
  private async memberAdd(member: GuildMember) {
    const auto = this.db.automations(member.guild.id); const guild = this.db.guild(member.guild.id);
    if (auto.autoRoleEnabled && guild.autoRoleId) await member.roles.add(guild.autoRoleId, "Autorole 166 Community").catch((error) => this.logger.warn("Falha no autorole.", error));
    if (auto.welcomeEnabled && guild.welcomeChannelId) {
      const channel = await member.guild.channels.fetch(guild.welcomeChannelId).catch(() => undefined);
      if (channel instanceof TextChannel) await channel.send({ embeds: [new EmbedBuilder().setColor(colorNumber(this.db.brand(member.guild.id).color)).setDescription(this.template(auto.welcomeMessage, member)).setThumbnail(member.user.displayAvatarURL()).setTimestamp()] }).catch(() => undefined);
    }
  }
  private async memberRemove(member: GuildMember | PartialGuildMember) {
    const auto = this.db.automations(member.guild.id); const guild = this.db.guild(member.guild.id); if (!auto.goodbyeEnabled || !guild.goodbyeChannelId) return;
    const channel = await member.guild.channels.fetch(guild.goodbyeChannelId).catch(() => undefined);
    if (channel instanceof TextChannel) await channel.send({ embeds: [new EmbedBuilder().setColor(0x64748b).setDescription(this.template(auto.goodbyeMessage, member)).setTimestamp()] }).catch(() => undefined);
  }
  async handleMessage(message: Message) {
    if (!message.guild || message.author.bot || !message.member) return;
    const protection = this.db.protection(message.guild.id);
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      const lower = message.content.toLowerCase();
      const urls = lower.match(/https?:\/\/[^\s]+|discord(?:\.gg|\.com\/invite)\/[^\s]+/g) ?? [];
      if (protection.antiLink && urls.length) {
        const allowed = protection.allowedDomains.some((domain) => urls.some((url) => url.includes(domain.toLowerCase())));
        const inviteBlocked = protection.blockInvites && urls.some((url) => /discord(?:\.gg|\.com\/invite)/.test(url));
        if (!allowed || inviteBlocked) { await message.delete().catch(() => undefined); const warn = message.channel.isSendable() ? await message.channel.send(`${message.author}, links não são permitidos aqui.`).catch(() => undefined) : undefined; if (warn) setTimeout(() => void warn.delete().catch(() => undefined), 5000); return; }
      }
      if (protection.antiSpam) {
        const key = `${message.guild.id}:${message.author.id}`; const now = Date.now(); const windowMs = protection.spamWindowSeconds * 1000;
        const rows = (this.spam.get(key) ?? []).filter((time) => now - time <= windowMs); rows.push(now); this.spam.set(key, rows);
        if (rows.length >= protection.spamMessages) { await message.member.timeout(protection.spamTimeoutSeconds * 1000, "Anti-spam 166 Community").catch(() => undefined); if (message.channel.isSendable()) await message.channel.send(`${message.author}, você foi silenciado temporariamente por spam.`).catch(() => undefined); this.spam.delete(key); return; }
      }
    }
    const auto = this.db.automations(message.guild.id);
    if (auto.autoResponsesEnabled) {
      for (const rule of auto.autoResponses) {
        const match = rule.exact ? message.content.trim().toLowerCase() === rule.trigger.toLowerCase() : message.content.toLowerCase().includes(rule.trigger.toLowerCase());
        if (match) { await message.reply(rule.response.replaceAll("{user}", `<@${message.author.id}>`)).catch(() => undefined); break; }
      }
    }
  }
  private async logChannel(guildId: string): Promise<TextChannel | undefined> { const id = this.db.guild(guildId).logChannelId; if (!id) return; const channel = await this.client.channels.fetch(id).catch(() => undefined); return channel instanceof TextChannel ? channel : undefined; }
  private async deleted(message: Message) { if (!message.guild || message.author?.bot || !this.db.protection(message.guild.id).logDeletedMessages) return; const channel = await this.logChannel(message.guild.id); await channel?.send({ embeds: [new EmbedBuilder().setColor(0xef4444).setTitle("Mensagem apagada").addFields({ name: "Autor", value: message.author ? `<@${message.author.id}>` : "Desconhecido", inline: true }, { name: "Canal", value: `<#${message.channel.id}>`, inline: true }, { name: "Conteúdo", value: truncate(message.content || "[sem conteúdo]", 1024) }).setTimestamp()] }).catch(() => undefined); }
  private async edited(oldMessage: Message, newMessage: Message) { if (!newMessage.guild || newMessage.author?.bot || !this.db.protection(newMessage.guild.id).logEditedMessages || oldMessage.content === newMessage.content) return; const channel = await this.logChannel(newMessage.guild.id); await channel?.send({ embeds: [new EmbedBuilder().setColor(0xf59e0b).setTitle("Mensagem editada").addFields({ name: "Autor", value: `<@${newMessage.author.id}>`, inline: true }, { name: "Canal", value: `<#${newMessage.channel.id}>`, inline: true }, { name: "Antes", value: truncate(oldMessage.content || "[vazio]", 1024) }, { name: "Depois", value: truncate(newMessage.content || "[vazio]", 1024) }).setTimestamp()] }).catch(() => undefined); }
}
