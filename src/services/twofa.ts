import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, ModalSubmitInteraction, TextInputBuilder, TextInputStyle, MessageFlags } from "discord.js";
import * as OTPAuth from "otpauth";

const COLORS = { success: 0x2ECC71, warning: 0xF39C12, error: 0xE74C3C, primary: 0x3498DB };

export class TwoFactorService {
  generateCode(secret: string): { code: string; remaining: number; color: number; bar: string } {
    const cleaned = secret.trim().toUpperCase().replace(/\s/g, "");
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(cleaned), algorithm: "SHA1", digits: 6, period: 30 });
    const code = totp.generate();
    const now = Math.floor(Date.now() / 1000);
    const remaining = 30 - (now % 30);
    const color = remaining > 15 ? COLORS.success : remaining > 7 ? COLORS.warning : COLORS.error;
    const filled = Math.round((remaining / 30) * 15);
    const bar = "`" + "█".repeat(filled) + "░".repeat(15 - filled) + "`";
    return { code: `${code.slice(0, 3)} ${code.slice(3)}`, remaining, color, bar };
  }

  buildCodeEmbed(code: string, remaining: number, color: number, bar: string) {
    return new EmbedBuilder()
      .setColor(color)
      .setTitle("🔐  Código 2FA")
      .setDescription(`\`\`\`${code}\`\`\``)
      .addFields(
        { name: "Tempo restante", value: `${bar} **${remaining}s**`, inline: true }
      )
      .setFooter({ text: "RAVE • Gerador de 2FA" })
      .setTimestamp();
  }

  openModal(interaction: { showModal(m: ModalBuilder): Promise<unknown> }) {
    const modal = new ModalBuilder().setCustomId("rave:modal-2fa").setTitle("Gerar Código 2FA");
    const input = new TextInputBuilder()
      .setCustomId("rave:2fa-secret")
      .setLabel("Chave Secreta (Base32)")
      .setPlaceholder("Ex: JBSWY3DPEHPK3PXP")
      .setStyle(TextInputStyle.Short)
      .setMinLength(6)
      .setMaxLength(64)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    return interaction.showModal(modal);
  }

  async handleModal(interaction: ModalSubmitInteraction) {
    const secret = interaction.fields.getTextInputValue("rave:2fa-secret").trim().toUpperCase().replace(/\s/g, "");
    try {
      const result = this.generateCode(secret);
      await interaction.reply({
        embeds: [this.buildCodeEmbed(result.code, result.remaining, result.color, result.bar)],
        flags: MessageFlags.Ephemeral
      });
    } catch {
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor(COLORS.error).setTitle("❌ Chave Inválida").setDescription("Verifique sua chave secreta Base32 e tente novamente.")],
        flags: MessageFlags.Ephemeral
      });
    }
  }
}
