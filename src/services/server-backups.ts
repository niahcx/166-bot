import {
  ChannelType,
  Client,
  EmbedBuilder,
  Guild,
  PermissionFlagsBits,
  TextChannel
} from "discord.js";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { JsonDatabase } from "../core/json-db.js";
import type { Logger } from "../core/logger.js";
import { makeId, nowIso } from "../core/utils.js";
import type { BackupSummary } from "../types.js";

interface ServerSnapshot {
  version: 1;
  id: string;
  guildId: string;
  name: string;
  createdAt: string;
  createdBy: string;
  guild: { name: string; description: string | null; verificationLevel: number; explicitContentFilter: number; defaultMessageNotifications: number; preferredLocale: string; afkTimeout: number; afkChannelId: string | null; systemChannelId: string | null; rulesChannelId: string | null; publicUpdatesChannelId: string | null; iconUrl: string | null; bannerUrl: string | null };
  roles: Array<{ id: string; name: string; color: number; hoist: boolean; position: number; permissions: string; mentionable: boolean; managed: boolean }>;
  channels: Array<{ id: string; type: number; name: string; parentId: string | null; position: number; topic?: string | null; nsfw?: boolean; rateLimitPerUser?: number; bitrate?: number; userLimit?: number; permissionOverwrites: Array<{ id: string; type: number; allow: string; deny: string }> }>;
  emojis: Array<{ id: string; name: string | null; animated: boolean; url: string }>;
  stickers: Array<{ id: string; name: string; description: string | null; tags: string; format: number; url: string }>;
  webhooks: Array<{ id: string; name: string | null; channelId: string | null; avatarUrl: string | null; ownerId: string | null; botOwned: boolean }>;
  messages: Array<{ channelId: string; channelName: string; messageId: string; authorId: string; authorName: string; isBot: boolean; content: string; createdAt: string; attachments: Array<{ name: string; url: string; contentType: string | null }>; embeds: unknown[]; components: unknown[] }>;
  botDataBackupId: string;
  warnings: string[];
}

export interface RestoreOptions { settings: boolean; roles: boolean; channels: boolean; expressions: boolean; webhooks: boolean; messages: boolean; }
export interface RestorePlan { backup: BackupSummary; snapshot: ServerSnapshot; summary: string[]; warnings: string[]; }

export class ServerBackupService {
  constructor(private readonly client: Client, private readonly db: JsonDatabase, private readonly logger: Logger) {}

  private dir(guildId: string) { return resolve(this.db.root, guildId, "backups", "servidor"); }
  private file(guildId: string, id: string) { return join(this.dir(guildId), `${id}.json`); }

  list(guildId: string): BackupSummary[] { return Object.values(this.db.state.backups).filter((item) => item.guildId === guildId && item.id.startsWith("BKP_") && item.path.endsWith(".json")).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(guildId: string, id: string): BackupSummary { const backup = this.db.state.backups[id]; if (!backup || backup.guildId !== guildId || !backup.id.startsWith("BKP_") || !backup.path.endsWith(".json")) throw new Error("Backup de servidor não encontrado."); return backup; }

  async create(guild: Guild, actorId: string, name = ""): Promise<BackupSummary> {
    const me = guild.members.me; if (!me) throw new Error("Não foi possível verificar o membro do bot.");
    const id = makeId("BKP"); const warnings: string[] = [];
    const botData = this.db.backupData(guild.id, `Segurança antes do backup ${id}`, actorId);
    await guild.roles.fetch(); await guild.channels.fetch(); await guild.emojis.fetch().catch(() => undefined); await guild.stickers.fetch().catch(() => undefined);
    const roles = guild.roles.cache.filter((role) => role.id !== guild.id).map((role) => ({ id: role.id, name: role.name, color: role.color, hoist: role.hoist, position: role.position, permissions: role.permissions.bitfield.toString(), mentionable: role.mentionable, managed: role.managed }));
    const channels: ServerSnapshot["channels"] = guild.channels.cache
      .filter((channel) => !channel.isThread())
      .map((channel) => {
        const c = channel as any;
        const base = { id: channel.id, type: Number(channel.type), name: channel.name, parentId: channel.parentId, position: Number(c.rawPosition ?? c.position ?? 0), permissionOverwrites: c.permissionOverwrites?.cache?.map((overwrite: any) => ({ id: overwrite.id, type: Number(overwrite.type), allow: overwrite.allow.bitfield.toString(), deny: overwrite.deny.bitfield.toString() })) ?? [] };
        if (channel.isTextBased() && !channel.isDMBased()) return { ...base, topic: c.topic ?? null, nsfw: Boolean(c.nsfw), rateLimitPerUser: Number(c.rateLimitPerUser ?? 0) };
        if (channel.isVoiceBased()) return { ...base, bitrate: Number(c.bitrate ?? 64000), userLimit: Number(c.userLimit ?? 0) };
        return base;
      });
    const emojis = guild.emojis.cache.map((emoji) => ({ id: emoji.id, name: emoji.name, animated: emoji.animated ?? false, url: emoji.imageURL({ extension: emoji.animated ? "gif" : "png", size: 128 }) }));
    const stickers = guild.stickers.cache.map((sticker) => ({ id: sticker.id, name: sticker.name, description: sticker.description, tags: sticker.tags ?? "restaurado", format: sticker.format, url: sticker.url }));
    const webhookCollection = me.permissions.has(PermissionFlagsBits.ManageWebhooks) ? await guild.fetchWebhooks().catch(() => undefined) : undefined;
    if (!webhookCollection) warnings.push("Webhooks não foram lidos por falta de permissão ou erro da API.");
    const webhooks = webhookCollection?.map((hook) => ({ id: hook.id, name: hook.name, channelId: hook.channelId, avatarUrl: hook.avatarURL(), ownerId: hook.owner?.id ?? null, botOwned: hook.owner?.id === this.client.user?.id })) ?? [];

    const messages: ServerSnapshot["messages"] = [];
    for (const channel of guild.channels.cache.values()) {
      if (!(channel instanceof TextChannel)) continue;
      const perms = channel.permissionsFor(me); if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) continue;
      try {
        let before: string | undefined;
        for (let page = 0; page < 10; page++) {
          const fetched = await channel.messages.fetch({ limit: 100, before });
          if (!fetched.size) break;
          for (const message of fetched.values()) messages.push({ channelId: channel.id, channelName: channel.name, messageId: message.id, authorId: message.author.id, authorName: message.author.username, isBot: message.author.bot, content: message.content, createdAt: message.createdAt.toISOString(), attachments: message.attachments.map((attachment) => ({ name: attachment.name, url: attachment.url, contentType: attachment.contentType })), embeds: message.embeds.map((embed) => embed.toJSON()), components: message.components.map((row) => row.toJSON()) });
          before = fetched.last()?.id;
          if (fetched.size < 100) break;
        }
      } catch (error) { warnings.push(`Mensagens de #${channel.name} não puderam ser lidas: ${String(error).slice(0, 120)}`); }
    }
    warnings.push("A API não permite restaurar autoria, IDs, datas originais, tokens de webhook, integrações gerenciadas ou mensagens exatamente como foram enviadas.");
    warnings.push("Na restauração, mensagens são republicadas pelo bot e identificadas como cópias arquivadas.");

    const snapshot: ServerSnapshot = {
      version: 1, id, guildId: guild.id, name: name || `Backup ${new Date().toLocaleString("pt-BR")}`, createdAt: nowIso(), createdBy: actorId,
      guild: { name: guild.name, description: guild.description, verificationLevel: guild.verificationLevel, explicitContentFilter: guild.explicitContentFilter, defaultMessageNotifications: guild.defaultMessageNotifications, preferredLocale: guild.preferredLocale, afkTimeout: guild.afkTimeout, afkChannelId: guild.afkChannelId, systemChannelId: guild.systemChannelId, rulesChannelId: guild.rulesChannelId, publicUpdatesChannelId: guild.publicUpdatesChannelId, iconUrl: guild.iconURL({ size: 1024 }), bannerUrl: guild.bannerURL({ size: 2048 }) },
      roles, channels, emojis, stickers, webhooks, messages, botDataBackupId: botData.id, warnings
    };
    mkdirSync(this.dir(guild.id), { recursive: true }); writeFileSync(this.file(guild.id, id), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    const summary: BackupSummary = { id, guildId: guild.id, name: snapshot.name, path: this.file(guild.id, id), createdBy: actorId, createdAt: snapshot.createdAt, counts: { roles: roles.length, channels: channels.length, emojis: emojis.length, stickers: stickers.length, webhooks: webhooks.length, messages: messages.length }, warnings };
    this.db.state.backups[id] = summary; this.db.audit(actorId, "SERVER_BACKUP_CREATE", "backup", id, { guildId: guild.id, counts: summary.counts }, guild.id); this.db.save(); return summary;
  }

  read(guildId: string, id: string): ServerSnapshot { const backup = this.get(guildId, id); if (!existsSync(backup.path)) throw new Error("Arquivo do backup não encontrado."); return JSON.parse(readFileSync(backup.path, "utf8")) as ServerSnapshot; }

  plan(guildId: string, id: string, options: RestoreOptions): RestorePlan {
    const backup = this.get(guildId, id); const snapshot = this.read(guildId, id); const summary: string[] = [];
    if (options.settings) summary.push("Configurações gerais do servidor"); if (options.roles) summary.push(`${snapshot.roles.filter((role) => !role.managed).length} cargos recriáveis`);
    if (options.channels) summary.push(`${snapshot.channels.length} categorias/canais`); if (options.expressions) summary.push(`${snapshot.emojis.length} emojis e ${snapshot.stickers.length} figurinhas`);
    if (options.webhooks) summary.push(`${snapshot.webhooks.filter((hook) => hook.botOwned).length} webhooks pertencentes ao bot`); if (options.messages) summary.push(`${snapshot.messages.length} mensagens arquivadas`);
    return { backup, snapshot, summary, warnings: snapshot.warnings };
  }

  async restore(guild: Guild, id: string, actorId: string, options: RestoreOptions): Promise<{ changed: Record<string, number>; warnings: string[] }> {
    const plan = this.plan(guild.id, id, options); await this.create(guild, actorId, `Backup automático antes da restauração ${id}`);
    const changed: { settings: number; roles: number; channels: number; emojis: number; stickers: number; webhooks: number; messages: number } = { settings: 0, roles: 0, channels: 0, emojis: 0, stickers: 0, webhooks: 0, messages: 0 }; const warnings = [...plan.warnings];
    const roleMap = new Map<string, string>([[guild.id, guild.id]]); const channelMap = new Map<string, string>();
    if (options.settings && guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await guild.edit({ name: plan.snapshot.guild.name, description: plan.snapshot.guild.description, verificationLevel: plan.snapshot.guild.verificationLevel, explicitContentFilter: plan.snapshot.guild.explicitContentFilter, defaultMessageNotifications: plan.snapshot.guild.defaultMessageNotifications, preferredLocale: plan.snapshot.guild.preferredLocale as any, afkTimeout: plan.snapshot.guild.afkTimeout, reason: `Restauração ${id} por ${actorId}` }).catch((error) => warnings.push(`Configurações gerais: ${String(error)}`));
      if (plan.snapshot.guild.iconUrl) await guild.setIcon(plan.snapshot.guild.iconUrl, `Restauração ${id}`).catch((error) => warnings.push(`Ícone: ${String(error).slice(0, 120)}`));
      if (plan.snapshot.guild.bannerUrl) await guild.setBanner(plan.snapshot.guild.bannerUrl, `Restauração ${id}`).catch((error) => warnings.push(`Banner: ${String(error).slice(0, 120)}`));
      changed.settings++;
    }
    if (options.roles && guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      for (const role of [...plan.snapshot.roles].filter((entry) => !entry.managed).sort((a, b) => a.position - b.position)) {
        const existing = guild.roles.cache.find((candidate) => candidate.name === role.name && !candidate.managed);
        if (existing) { roleMap.set(role.id, existing.id); continue; }
        try { const created = await guild.roles.create({ name: role.name, color: role.color, hoist: role.hoist, mentionable: role.mentionable, permissions: BigInt(role.permissions), reason: `Restauração ${id}` }); roleMap.set(role.id, created.id); changed.roles++; }
        catch (error) { warnings.push(`Cargo ${role.name}: ${String(error).slice(0, 180)}`); }
      }
      const positions = plan.snapshot.roles.filter((entry) => !entry.managed && roleMap.has(entry.id)).map((entry) => ({ role: roleMap.get(entry.id)!, position: entry.position }));
      if (positions.length) await guild.roles.setPositions(positions).catch((error) => warnings.push(`Ordem dos cargos: ${String(error).slice(0, 160)}`));
    }
    if (options.channels && guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      const ordered = [...plan.snapshot.channels].sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0) || a.position - b.position);
      for (const channel of ordered) {
        const existing = guild.channels.cache.find((candidate) => candidate.name === channel.name && candidate.type === channel.type);
        if (existing) { channelMap.set(channel.id, existing.id); continue; }
        try {
          const created = await guild.channels.create({ name: channel.name, type: channel.type as ChannelType, parent: channel.parentId ? channelMap.get(channel.parentId) : undefined, position: channel.position, topic: channel.topic ?? undefined, nsfw: channel.nsfw, rateLimitPerUser: channel.rateLimitPerUser, bitrate: channel.bitrate, userLimit: channel.userLimit, permissionOverwrites: channel.permissionOverwrites.map((overwrite) => ({ id: roleMap.get(overwrite.id) ?? overwrite.id, type: overwrite.type, allow: BigInt(overwrite.allow), deny: BigInt(overwrite.deny) })), reason: `Restauração ${id}` } as never);
          channelMap.set(channel.id, created.id); changed.channels++;
        } catch (error) { warnings.push(`Canal ${channel.name}: ${String(error).slice(0, 180)}`); }
      }
      const channelPositions = plan.snapshot.channels.filter((entry) => channelMap.has(entry.id)).map((entry) => ({ channel: channelMap.get(entry.id)!, position: entry.position }));
      if (channelPositions.length) await guild.channels.setPositions(channelPositions).catch((error) => warnings.push(`Ordem dos canais: ${String(error).slice(0, 160)}`));
    }
    if (options.expressions && guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuildExpressions)) {
      for (const emoji of plan.snapshot.emojis) if (!guild.emojis.cache.some((entry) => entry.name === emoji.name)) try { await guild.emojis.create({ attachment: emoji.url, name: emoji.name || `emoji_${emoji.id}`, reason: `Restauração ${id}` }); changed.emojis++; } catch (error) { warnings.push(`Emoji ${emoji.name}: ${String(error).slice(0, 120)}`); }
      for (const sticker of plan.snapshot.stickers) if (!guild.stickers.cache.some((entry) => entry.name === sticker.name)) try { await guild.stickers.create({ file: sticker.url, name: sticker.name, tags: sticker.tags || "restaurado", description: sticker.description ?? undefined, reason: `Restauração ${id}` }); changed.stickers++; } catch (error) { warnings.push(`Figurinha ${sticker.name}: ${String(error).slice(0, 120)}`); }
    }
    if (options.webhooks && guild.members.me?.permissions.has(PermissionFlagsBits.ManageWebhooks)) {
      for (const hook of plan.snapshot.webhooks.filter((entry) => entry.botOwned && entry.channelId)) {
        const targetId = channelMap.get(hook.channelId!) ?? hook.channelId!; const channel = guild.channels.cache.get(targetId);
        if (!(channel instanceof TextChannel)) continue;
        try { await channel.createWebhook({ name: hook.name || "166 Community restaurado", avatar: hook.avatarUrl ?? undefined, reason: `Restauração ${id}` }); changed.webhooks++; } catch (error) { warnings.push(`Webhook ${hook.name}: ${String(error).slice(0, 120)}`); }
      }
    }
    if (options.messages) {
      for (const archived of [...plan.snapshot.messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        const targetId = channelMap.get(archived.channelId) ?? archived.channelId; const channel = guild.channels.cache.get(targetId); if (!(channel instanceof TextChannel)) continue;
        try {
          const attachmentLines = archived.attachments.map((attachment) => `Anexo: ${attachment.url}`).join("\n");
          const content = [`**Mensagem arquivada** • ${archived.authorName} (${archived.authorId}) • <t:${Math.floor(Date.parse(archived.createdAt) / 1000)}:f>`, archived.content, attachmentLines].filter(Boolean).join("\n").slice(0, 2000);
          const embeds = archived.embeds.slice(0, 10).map((data) => EmbedBuilder.from(data as never));
          const components = archived.isBot ? archived.components.slice(0, 5) : [];
          await channel.send({ content, embeds, components: components as never, allowedMentions: { parse: [] } }); changed.messages++;
        } catch (error) { warnings.push(`Mensagem ${archived.messageId}: ${String(error).slice(0, 120)}`); }
      }
    }
    this.db.audit(actorId, "SERVER_BACKUP_RESTORE", "backup", id, { guildId: guild.id, options, changed, warningCount: warnings.length }, guild.id); this.db.save(); return { changed, warnings };
  }

  rename(guildId: string, id: string, name: string, actorId: string): BackupSummary { const backup = this.get(guildId, id); const snapshot = this.read(guildId, id); backup.name = name.trim().slice(0, 100) || backup.name; snapshot.name = backup.name; writeFileSync(backup.path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8"); this.db.audit(actorId, "SERVER_BACKUP_RENAME", "backup", id, { guildId, name: backup.name }, guildId); this.db.save(); return backup; }
  delete(guildId: string, id: string, actorId: string): void { const backup = this.get(guildId, id); if (existsSync(backup.path)) rmSync(backup.path, { force: true }); delete this.db.state.backups[id]; this.db.audit(actorId, "SERVER_BACKUP_DELETE", "backup", id, { guildId }, guildId); this.db.save(); }
}
