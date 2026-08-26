import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, TextChannel } from "discord.js";
import type { JsonDatabase } from "../core/json-db.js";
import type { EmojiManager } from "../emojis/manager.js";
import type { Giveaway } from "../types.js";
import { colorNumber, makeId, nowIso } from "../core/utils.js";

export class GiveawayService {
  private timer?: NodeJS.Timeout;
  constructor(private readonly client: Client, private readonly db: JsonDatabase, private readonly emojis: EmojiManager) {}
  async create(input: { guildId: string; channelId: string; prize: string; winnersCount: number; endsAt: string; actorId: string }): Promise<Giveaway> {
    const channel = await this.client.channels.fetch(input.channelId); if (!(channel instanceof TextChannel)) throw new Error("Canal inválido.");
    const draft: Giveaway = { id: makeId("GVW"), guildId: input.guildId, channelId: input.channelId, messageId: "", prize: input.prize.slice(0, 200), winnersCount: Math.max(1, Math.min(20, input.winnersCount)), endsAt: input.endsAt, entries: [], status: "ACTIVE", createdBy: input.actorId, createdAt: nowIso() };
    const embed = new EmbedBuilder().setColor(colorNumber(this.db.brand(input.guildId).color)).setTitle(`${this.emojis.text("giveaway", input.guildId)} Sorteio`).setDescription(`**Prêmio:** ${draft.prize}\n**Vencedores:** ${draft.winnersCount}\n**Termina:** <t:${Math.floor(Date.parse(draft.endsAt) / 1000)}:R>\n**Participantes:** 0`).setFooter({ text: this.db.brand(input.guildId).footer }).setTimestamp(new Date(draft.endsAt));
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`giveaway:join:${draft.id}`).setLabel("Participar").setStyle(ButtonStyle.Success).setEmoji(this.emojis.component("giveaway", input.guildId)));
    const message = await channel.send({ embeds: [embed], components: [row] }); draft.messageId = message.id;
    this.db.state.giveaways[draft.id] = draft; this.db.audit(input.actorId, "GIVEAWAY_CREATE", "giveaway", draft.id); this.db.save(); return draft;
  }
  join(id: string, userId: string): number {
    const giveaway = this.db.state.giveaways[id]; if (!giveaway || giveaway.status !== "ACTIVE") throw new Error("Sorteio encerrado.");
    if (giveaway.entries.includes(userId)) giveaway.entries = giveaway.entries.filter((entry) => entry !== userId); else giveaway.entries.push(userId);
    this.db.save(); return giveaway.entries.length;
  }
  start() { this.stop(); this.timer = setInterval(() => void this.check(), 15000); this.timer.unref?.(); setTimeout(() => void this.check(), 5000).unref?.(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async check() { for (const giveaway of Object.values(this.db.state.giveaways)) if (giveaway.status === "ACTIVE" && Date.parse(giveaway.endsAt) <= Date.now()) await this.end(giveaway.id).catch(() => undefined); }
  async end(id: string): Promise<string[]> {
    const giveaway = this.db.state.giveaways[id]; if (!giveaway || giveaway.status !== "ACTIVE") return [];
    const pool = [...giveaway.entries]; const winners: string[] = [];
    while (pool.length && winners.length < giveaway.winnersCount) winners.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]!);
    giveaway.status = "ENDED"; this.db.save();
    const channel = await this.client.channels.fetch(giveaway.channelId).catch(() => undefined);
    if (channel instanceof TextChannel) {
      const message = await channel.messages.fetch(giveaway.messageId).catch(() => undefined);
      const description = winners.length ? `**Prêmio:** ${giveaway.prize}\n**Vencedor(es):** ${winners.map((u) => `<@${u}>`).join(", ")}\n**Participantes:** ${giveaway.entries.length}` : `**Prêmio:** ${giveaway.prize}\nNenhum participante válido.`;
      await message?.edit({ embeds: [new EmbedBuilder().setColor(winners.length ? 0x22c55e : 0xef4444).setTitle("Sorteio encerrado").setDescription(description).setTimestamp()], components: [] });
      if (winners.length) await channel.send(`Parabéns, ${winners.map((u) => `<@${u}>`).join(", ")}! Você venceu **${giveaway.prize}**.`);
    }
    return winners;
  }
}
