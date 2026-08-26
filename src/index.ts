import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes
} from "discord.js";
import { loadConfig } from "./config.js";
import { JsonDatabase } from "./core/json-db.js";
import { CredentialStore } from "./core/credential-store.js";
import { Logger } from "./core/logger.js";
import { commands } from "./discord/commands.js";
import { InteractionRouter } from "./discord/router.js";
import { EmojiManager } from "./emojis/manager.js";
import { AutomationService } from "./services/automations.js";
import { GiveawayService } from "./services/giveaways.js";
import { ImapMonitor } from "./services/imap.js";
import { OrderService } from "./services/orders.js";
import { PaymentManager } from "./services/payments.js";
import { ProductService } from "./services/products.js";
import { TicketService } from "./services/tickets.js";
import { PermissionService } from "./services/permissions.js";
import { LockService } from "./services/locks.js";
import { ServerBackupService } from "./services/server-backups.js";
import { RestockAnnouncementService } from "./services/restock-announcements.js";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  console.error(`[CONFIGURAÇÃO] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const logger = new Logger(config.logLevel);

logger.section("166 COMMUNITY • INICIALIZAÇÃO");
logger.info(`Node.js ${process.version} • PID ${process.pid}`);
logger.info(`Banco JSON: ${config.databasePath}`);
logger.info(`Emojis automáticos: ${config.autoInstallEmojis ? "ativados" : "desativados"}`);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember]
});

const credentials = new CredentialStore("config/private-credentials.json", logger);
const db = new JsonDatabase(config.databasePath, logger, credentials);
const products = new ProductService(db);
const payments = new PaymentManager(db, logger);
const orders = new OrderService(client, db, products, payments, logger);
const emojis = new EmojiManager(client, db, config, logger);
const tickets = new TicketService(client, db, emojis, logger);
const giveaways = new GiveawayService(client, db, emojis);
const imap = new ImapMonitor(db, logger, () => orders.pendingImap(), (orderId, proof) => orders.markPaid(orderId, proof));
const permissions = new PermissionService(config, db);
const locks = new LockService(db, logger);
const automations = new AutomationService(client, db, logger, locks);
const backups = new ServerBackupService(client, db, logger);
const restocks = new RestockAnnouncementService(client, db, products, logger);
const router = new InteractionRouter(client, config, db, emojis, products, payments, orders, imap, tickets, giveaways, permissions, locks, backups, restocks, logger);
orders.onUpdate((order) => router.refreshOrderMessage(order));

function applyPresence(): void {
  if (!client.user) return;
  const brand = db.state.brand;
  const activityTypes: Record<typeof brand.presenceType, ActivityType> = {
    Playing: ActivityType.Playing,
    Watching: ActivityType.Watching,
    Listening: ActivityType.Listening,
    Competing: ActivityType.Competing
  };
  client.user.setPresence({
    status: brand.status,
    activities: brand.presenceText
      ? [{ name: brand.presenceText, type: activityTypes[brand.presenceType] }]
      : []
  });
}

async function registerCommands(): Promise<void> {
  const applicationId = client.application?.id ?? config.clientId;
  if (!applicationId) throw new Error("Não foi possível identificar o Application ID do bot.");
  const rest = new REST({ version: "10" }).setToken(config.botToken);
  if (config.guildId) {
    await rest.put(Routes.applicationGuildCommands(applicationId, config.guildId), { body: commands });
    logger.info(`Comandos registrados no servidor ${config.guildId}.`);
    return;
  }
  await rest.put(Routes.applicationCommands(applicationId), { body: commands });
  logger.info("Comandos globais registrados. A propagação global pode levar alguns minutos.");
}

router.start();
automations.start();
client.on(Events.MessageCreate, (message) => {
  void tickets.handleMessage(message);
  void automations.handleMessage(message);
});

client.once(Events.ClientReady, async () => {
  logger.success(`Discord conectado como ${client.user?.tag ?? "bot"}.`);
  logger.info(`Application ID: ${client.application?.id ?? config.clientId ?? "indisponível"}.`);
  logger.info(`Servidores conectados: ${client.guilds.cache.size}.`);
  applyPresence();

  try {
    logger.info("Registrando comandos de aplicação...");
    await registerCommands();
    logger.success("Comandos de aplicação prontos.");
  } catch (error) {
    logger.error("Falha ao registrar comandos de aplicação.", error);
  }

  orders.startPolling();
  imap.start();
  giveaways.start();
  logger.success("Serviços de pedidos, pagamentos, tickets e automações iniciados.");

  if (config.autoInstallEmojis) {
    logger.info("Instalação automática de emojis detectada. A sincronização começará agora.");
    await emojis.syncAutomatic();
    try {
      const count = await router.refreshPublishedMessages();
      logger.success(`Painéis publicados atualizados após os emojis: ${count}.`);
    } catch (error) {
      logger.warn("Os emojis foram processados, mas alguns painéis publicados não puderam ser atualizados.", error);
    }
  } else {
    logger.warn("Instalação automática de emojis desativada. Use /emojis instalar para sincronizar manualmente.");
  }

  try {
    const removed = await emojis.reconcileSavedEmojis();
    const savedCount = emojis.listSaved().length;
    logger.success(`[SALVAR EMOJI] Biblioteca verificada: ${savedCount} emoji(s) disponível(is)${removed ? `; ${removed} registro(s) inválido(s) removido(s)` : ""}.`);
  } catch (error) {
    logger.warn("[SALVAR EMOJI] Não foi possível conferir a biblioteca de emojis salvos. O bot continuará normalmente.", error);
  }

  logger.section("166 COMMUNITY ONLINE");
  logger.success("Bot totalmente iniciado. Use /painel para abrir a central de controle.");
});

client.on("error", (error) => logger.error("Erro do cliente Discord.", error));
client.on("warn", (warning) => logger.warn("Aviso do cliente Discord.", warning));

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info(`Encerrando 166 Community (${signal})...`);
  orders.stopPolling();
  imap.stop();
  giveaways.stop();
  automations.stop();
  client.destroy();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => logger.error("Promise rejeitada sem tratamento.", reason));
process.on("uncaughtException", (error) => logger.error("Exceção não tratada.", error));

client.login(config.botToken).catch((error) => {
  logger.error("Não foi possível conectar ao Discord. Verifique o token em Token.json e os intents habilitados.", error);
  process.exitCode = 1;
});
