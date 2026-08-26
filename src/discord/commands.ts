import { ApplicationCommandType, ContextMenuCommandBuilder, SlashCommandBuilder } from "discord.js";

export const commands = [
  new SlashCommandBuilder().setName("painel").setDescription("Abre o painel administrativo completo do 166 Community."),
  new SlashCommandBuilder().setName("meus-pedidos").setDescription("Mostra seus pedidos recentes."),
  new SlashCommandBuilder().setName("ticket").setDescription("Abre a central de atendimento."),
  new SlashCommandBuilder().setName("pedir-stock").setDescription("Abre o formulário para pedir stock de um produto."),
  new SlashCommandBuilder().setName("status").setDescription("Mostra o status dos sistemas do bot."),
  new SlashCommandBuilder().setName("setupticket").setDescription("Configura um painel de ticket com personalização completa (foto, título, canal)."),
  new SlashCommandBuilder()
    .setName("lock")
    .setDescription("Tranca o canal atual ou todos os canais permitidos.")
    .addBooleanOption((option) => option.setName("all").setDescription("Trancar todos os canais de texto permitidos"))
    .addStringOption((option) => option.setName("motivo").setDescription("Motivo do bloqueio").setMaxLength(200)),
  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Destranca o canal atual ou todos os canais bloqueados pelo bot.")
    .addBooleanOption((option) => option.setName("all").setDescription("Destrancar todos os canais bloqueados pelo bot"))
    .addStringOption((option) => option.setName("motivo").setDescription("Motivo do desbloqueio").setMaxLength(200)),
  new SlashCommandBuilder()
    .setName("emojis")
    .setDescription("Gerencia o pacote de emojis da aplicação.")
    .addSubcommand((sub) => sub.setName("status").setDescription("Mostra o progresso da instalação automática."))
    .addSubcommand((sub) => sub.setName("instalar").setDescription("Instala ou corrige todos os emojis do pacote enviado."))
    .addSubcommand((sub) => sub.setName("remover").setDescription("Remove os emojis do pacote 166 Community da aplicação.")),
  new SlashCommandBuilder()
    .setName("salvar-emojis")
    .setDescription("Salva imagens e GIFs como emojis da própria aplicação.")
    .addSubcommand((sub) => sub
      .setName("adicionar")
      .setDescription("Adiciona um PNG, JPG, GIF, WEBP, AVIF ou emoji personalizado.")
      .addStringOption((option) => option.setName("nome").setDescription("Nome do emoji na aplicação").setRequired(true).setMinLength(2).setMaxLength(32))
      .addAttachmentOption((option) => option.setName("arquivo").setDescription("Imagem ou GIF de até 256 KiB"))
      .addStringOption((option) => option.setName("emoji").setDescription("Emoji personalizado, exemplo: <:nome:id>")))
    .addSubcommand((sub) => sub
      .setName("listar")
      .setDescription("Mostra os emojis salvos na aplicação.")
      .addStringOption((option) => option.setName("escopo").setDescription("Quais emojis mostrar").addChoices(
        { name: "Meus emojis", value: "meus" },
        { name: "Todos deste servidor", value: "todos" }
      )))
    .addSubcommand((sub) => sub
      .setName("copiar")
      .setDescription("Mostra o ID e o código pronto para copiar.")
      .addStringOption((option) => option.setName("emoji").setDescription("ID, nome ou menção do emoji").setRequired(true)))
    .addSubcommand((sub) => sub
      .setName("remover")
      .setDescription("Remove um emoji salvo da aplicação.")
      .addStringOption((option) => option.setName("emoji").setDescription("ID, nome ou menção do emoji").setRequired(true))),
  new ContextMenuCommandBuilder().setName("Editar Produto").setType(ApplicationCommandType.Message),
  new ContextMenuCommandBuilder().setName("Gerenciar Estoque").setType(ApplicationCommandType.Message),
  new ContextMenuCommandBuilder().setName("Editar Painel de Ticket").setType(ApplicationCommandType.Message)
].map((command) => command.toJSON());
