import { ChannelType, Guild, GuildMember, PermissionFlagsBits, TextChannel } from "discord.js";
import type { JsonDatabase } from "../core/json-db.js";
import type { Logger } from "../core/logger.js";

export interface LockResult { changed: string[]; skipped: string[]; errors: Array<{ channelId: string; error: string }>; }

export class LockService {
  constructor(private readonly db: JsonDatabase, private readonly logger: Logger) {}

  private snapshot(channel: TextChannel): Array<{ id: string; type: number; allow: string; deny: string }> {
    return channel.permissionOverwrites.cache.map((overwrite) => ({ id: overwrite.id, type: overwrite.type, allow: overwrite.allow.bitfield.toString(), deny: overwrite.deny.bitfield.toString() }));
  }

  async lock(channel: TextChannel, actor: Pick<GuildMember, "id">, reason = "Canal bloqueado pela administração"): Promise<void> {
    const settings = this.db.guild(channel.guild.id);
    if (!settings.locks.snapshots[channel.id]) settings.locks.snapshots[channel.id] = this.snapshot(channel);
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone.id, { SendMessages: false }, { reason });
    for (const roleId of settings.locks.speakingRoleIds) await channel.permissionOverwrites.edit(roleId, { SendMessages: true }, { reason }).catch(() => undefined);
    this.db.audit(actor.id, "CHANNEL_LOCK", "channel", channel.id, { guildId: channel.guild.id, reason }, channel.guild.id);
    this.db.save();
  }

  async unlock(channel: TextChannel, actor: Pick<GuildMember, "id">, reason = "Canal desbloqueado pela administração"): Promise<void> {
    const settings = this.db.guild(channel.guild.id); const snapshot = settings.locks.snapshots[channel.id];
    if (!snapshot) throw new Error("Não existe snapshot anterior para este canal. O bot não alterará permissões personalizadas sem referência.");
    await channel.permissionOverwrites.set(snapshot.map((entry) => ({ id: entry.id, type: entry.type, allow: BigInt(entry.allow), deny: BigInt(entry.deny) })), reason);
    delete settings.locks.snapshots[channel.id];
    this.db.audit(actor.id, "CHANNEL_UNLOCK", "channel", channel.id, { guildId: channel.guild.id, reason }, channel.guild.id); this.db.save();
  }

  eligible(guild: Guild): TextChannel[] {
    const ignored = new Set(this.db.guild(guild.id).locks.ignoredChannelIds);
    return guild.channels.cache.filter((channel): channel is TextChannel => channel.type === ChannelType.GuildText && !ignored.has(channel.id) && channel.viewable && channel.permissionsFor(guild.members.me!)?.has(PermissionFlagsBits.ManageChannels) === true).map((channel) => channel);
  }

  async lockAll(guild: Guild, actor: GuildMember, reason: string): Promise<LockResult> {
    const result: LockResult = { changed: [], skipped: [], errors: [] }; const channels = this.eligible(guild);
    for (const channel of channels) {
      try { await this.lock(channel, actor, reason); result.changed.push(channel.id); }
      catch (error) { result.errors.push({ channelId: channel.id, error: String(error) }); this.logger.warn("Falha ao bloquear canal.", { guildId: guild.id, channelId: channel.id, error: String(error) }); }
    }
    return result;
  }

  async unlockAll(guild: Guild, actor: GuildMember, reason: string): Promise<LockResult> {
    const result: LockResult = { changed: [], skipped: [], errors: [] }; const settings = this.db.guild(guild.id);
    for (const channelId of Object.keys(settings.locks.snapshots)) {
      const channel = guild.channels.cache.get(channelId);
      if (!(channel instanceof TextChannel)) { result.skipped.push(channelId); continue; }
      try { await this.unlock(channel, actor, reason); result.changed.push(channel.id); }
      catch (error) { result.errors.push({ channelId, error: String(error) }); }
    }
    return result;
  }
}
