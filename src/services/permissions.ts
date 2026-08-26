import { GuildMember, PermissionFlagsBits } from "discord.js";
import type { AppConfig, PermissionScope } from "../types.js";
import type { JsonDatabase } from "../core/json-db.js";

export class PermissionService {
  constructor(private readonly config: AppConfig, private readonly db: JsonDatabase) {}

  isOwner(userId: string): boolean { return this.config.ownerIds.includes(userId); }

  has(member: GuildMember, scope: PermissionScope): boolean {
    if (this.isOwner(member.id) || member.guild.ownerId === member.id) return true;
    const settings = this.db.guild(member.guild.id);
    const p = settings.permissions;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    if (p.adminUserIds.includes(member.id) || p.adminRoleIds.some((id) => member.roles.cache.has(id)) || settings.adminRoleIds.some((id) => member.roles.cache.has(id))) return true;
    if (scope === "AUTHORIZED") return p.authorizedUserIds.includes(member.id) || p.authorizedRoleIds.some((id) => member.roles.cache.has(id));
    const roleMap: Partial<Record<PermissionScope, string[]>> = {
      SUPPORT: p.supportRoleIds,
      TICKETS: p.ticketRoleIds,
      PAYMENTS: p.paymentRoleIds,
      PRODUCTS: p.productRoleIds,
      ADMIN_COMMANDS: p.adminCommandRoleIds,
      BACKUPS: p.adminCommandRoleIds,
      LOCKS: p.adminCommandRoleIds
    };
    return (roleMap[scope] ?? []).some((id) => member.roles.cache.has(id));
  }

  require(member: GuildMember, scope: PermissionScope): void {
    if (!this.has(member, scope)) throw new Error("Você não possui permissão para usar esta função.");
  }

  hasAnyManagement(member: GuildMember): boolean {
    return (["ADMIN", "AUTHORIZED", "SUPPORT", "TICKETS", "PAYMENTS", "PRODUCTS", "ADMIN_COMMANDS", "BACKUPS", "LOCKS"] as PermissionScope[]).some((scope) => this.has(member, scope));
  }

  updateUsers(guildId: string, key: "adminUserIds" | "authorizedUserIds", values: string[]): void {
    this.db.updateGuild(guildId, (guild) => { guild.permissions[key] = [...new Set(values)]; });
  }
  updateRoles(guildId: string, key: keyof Omit<ReturnType<JsonDatabase["guild"]>["permissions"], "adminUserIds" | "authorizedUserIds">, values: string[]): void {
    this.db.updateGuild(guildId, (guild) => { guild.permissions[key] = [...new Set(values)]; });
  }
}
