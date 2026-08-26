import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, GatewayIntentBits } from "discord.js";
import { JsonDatabase } from "../src/core/json-db.ts";
import { CredentialStore } from "../src/core/credential-store.ts";
import { Logger } from "../src/core/logger.ts";
import { EmojiManager } from "../src/emojis/manager.ts";
import { Views } from "../src/discord/views.ts";
import { ProductService } from "../src/services/products.ts";
import { PaymentManager } from "../src/services/payments.ts";
import { OrderService } from "../src/services/orders.ts";
import { TicketService } from "../src/services/tickets.ts";
import { matchPendingImapOrder, matchesSelectedBankNotification, parseImapAmounts } from "../src/services/imap.ts";
import type { AppConfig } from "../src/types.ts";
import { assertDiscordPayload } from "../src/discord/payload-validator.ts";

const GUILD = "123456789012345678";
const USER = "223456789012345678";

function validatePayload(payload: unknown, options: { allowDefaultOptions?: boolean } = {}): void {
  assertDiscordPayload(payload, "smoke payload legado");
  const json = JSON.parse(JSON.stringify(payload)) as { embeds?: Array<Record<string, unknown>>; components?: Array<{ components?: Array<Record<string, unknown>> }> };
  assert.ok(Array.isArray(json.embeds)); assert.ok(Array.isArray(json.components)); assert.ok(json.components.length <= 5);
  for (const embed of json.embeds) {
    if (typeof embed.title === "string") assert.ok(embed.title.length <= 256);
    if (typeof embed.description === "string") assert.ok(embed.description.length <= 4096);
    if (Array.isArray(embed.fields)) {
      assert.ok(embed.fields.length <= 25);
      for (const field of embed.fields as Array<Record<string, unknown>>) {
        assert.ok(typeof field.name === "string" && field.name.length <= 256, `nome de campo inválido: ${String(field.name).length}`);
        assert.ok(typeof field.value === "string" && field.value.length <= 1024, `valor de campo inválido: ${String(field.value).length}`);
      }
    }
  }
  for (const row of json.components) {
    assert.ok((row.components?.length ?? 0) >= 1, "linhas de componentes não podem ficar vazias");
    assert.ok((row.components?.length ?? 0) <= 5, "cada linha aceita no máximo 5 componentes");
    for (const component of row.components ?? []) {
      if (typeof component.custom_id === "string") assert.ok(component.custom_id.length <= 100);
      if (typeof component.label === "string") assert.ok(component.label.length <= (component.type === 2 ? 80 : 100));
      if (typeof component.placeholder === "string") assert.ok(component.placeholder.length <= 150);
      if (Array.isArray(component.options)) {
        assert.ok(component.options.length <= 25);
        for (const option of component.options as Array<Record<string, unknown>>) {
          assert.ok(typeof option.label === "string" && option.label.length <= 100);
          assert.ok(typeof option.value === "string" && option.value.length <= 100);
          if (typeof option.description === "string") assert.ok(option.description.length <= 100);
          if (!options.allowDefaultOptions) assert.equal(option.default, undefined, "opções públicas não podem ficar visualmente selecionadas");
        }
      }
    }
  }
}
function validateComponentsV2Payload(payload: unknown): void {
  assertDiscordPayload(payload, "smoke Components V2");
  const json = JSON.parse(JSON.stringify(payload)) as { flags?: number; components?: Array<Record<string, unknown>> };
  assert.equal(json.flags, 32768, "a publicação precisa usar a flag IsComponentsV2");
  assert.ok(Array.isArray(json.components) && json.components.length >= 1 && json.components.length <= 5);

  const visit = (component: Record<string, unknown>): void => {
    if (component.type === 1) {
      const children = component.components as Array<Record<string, unknown>> | undefined;
      assert.ok(Array.isArray(children) && children.length >= 1 && children.length <= 5, "ActionRow precisa ter entre 1 e 5 componentes");
    }
    if (component.type === 10) {
      assert.ok(typeof component.content === "string" && component.content.length >= 1 && component.content.length <= 4000);
    }
    const nested = component.components as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(nested)) nested.forEach(visit);
  };
  json.components.forEach(visit);
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "166community-v13-smoke-"));
  const legacyFile = join(dir, "storage", "database.json");
  const root = join(dir, "database");
  let client: Client | undefined;
  try {
    const logger = new Logger("error");
    const credentials = new CredentialStore(join(dir, "config", "private-credentials.json"), logger);
    const db = new JsonDatabase(legacyFile, logger, credentials);
    db.guild(GUILD);
    client = new Client({ intents: [GatewayIntentBits.Guilds] });
    const config: AppConfig = { botToken: "x".repeat(30), clientId: GUILD, guildId: GUILD, ownerIds: [], databasePath: root, autoInstallEmojis: false, emojiInstallLimit: 0, logLevel: "error" };
    const products = new ProductService(db);
    const payments = new PaymentManager(db, logger);
    const orders = new OrderService(client, db, products, payments, logger);
    const emojis = new EmojiManager(client, db, config, logger);
    const tickets = new TicketService(client, db, emojis, logger);
    const views = new Views(db, emojis, products, tickets);

    assert.equal(db.state.version, 13);
    assert.equal(emojis.manifestCount(), 197);
    validatePayload(views.paymentsHome(GUILD), { allowDefaultOptions: true });
    validateComponentsV2Payload(views.adminPage(GUILD, views.adminHome(GUILD, "Administrador")));
    validatePayload(views.restockSettings(GUILD), { allowDefaultOptions: true });
    validatePayload(views.imapSettingsHome(GUILD), { allowDefaultOptions: true });

    const single = products.create({
      guildId: GUILD, name: "Conta Premium", description: "Entrega automática após a confirmação.", priceCents: 1000,
      deliveryType: "STOCK", minQuantity: 1, maxQuantity: 3, perUserLimit: 3, couponGroup: "contas",
      bannerUrl: "https://example.com/banner.png", fields: [{ name: "Level 15", description: "Pronta para uso", priceCents: 1000, emoji: "cart" }]
    }, "tester");
    const singleField = products.getField(single.id);
    products.addStock(single.id, "login1\nlogin2\nlogin3", "tester", singleField.id);

    const multi = products.create({
      guildId: GUILD, name: "Assinatura", description: "Escolha o plano.", priceCents: 1500, deliveryType: "STOCK", couponGroup: "assinaturas",
      fields: [
        { name: "Mensal", description: "30 dias", priceCents: 1500, emoji: "cart" },
        { name: "Anual", description: "365 dias", priceCents: 9900, emoji: "vip", stockMode: "GHOST", ghostStock: { content: "link-unico", quantity: 20, reserved: 0, sold: 0, reservations: {}, updatedAt: new Date().toISOString() } }
      ]
    }, "tester");
    const [monthly, yearly] = multi.fields;
    assert.ok(monthly && yearly);
    products.addStock(multi.id, "mensal-1\nmensal-2", "tester", monthly.id);
    products.setGhostStock(multi.id, yearly.id, "link-unico", 20, "tester");

    db.state.emojis["cart:solid"] = {
      id: "999999999999999998",
      name: "prime_cart",
      semantic: "cart",
      theme: "solid",
      sha256: "test",
      installedAt: new Date().toISOString()
    };
    for (let index = 0; index < 7; index++) {
      db.state.emojis[`entrega${index}:solid`] = {
        id: `99999999999999999${index}`,
        name: `prime_entrega${index}`,
        semantic: `entrega${index}`,
        theme: "solid",
        sha256: `test-${index}`,
        installedAt: new Date().toISOString()
      };
    }
    const singlePayload = views.publicProduct(GUILD, single);
    const multiPayload = views.publicProduct(GUILD, multi);
    const publishedPayload = views.publishedProduct(GUILD, single);
    const publishedEditPayload = views.publishedProductEdit(GUILD, single);
    validatePayload(singlePayload); validatePayload(multiPayload); validateComponentsV2Payload(publishedPayload);
    assert.equal(singlePayload.embeds.length, 1, "o produto não deve anexar banner artificial de entrega");
    assert.equal((singlePayload as { files?: unknown[] }).files, undefined, "não deve existir arquivo de banner artificial");
    assert.deepEqual(publishedEditPayload.embeds, []);
    assert.deepEqual(publishedEditPayload.attachments, []);
    const publishedJson = JSON.parse(JSON.stringify(publishedPayload)) as { components: Array<{ components: Array<Record<string, unknown>> }> };
    const textDisplays = publishedJson.components[0]!.components.filter((component) => component.type === 10);
    const deliveryHeading = textDisplays.find((component) => typeof component.content === "string" && component.content.startsWith("## <:prime_entrega0:"));
    assert.ok(deliveryHeading, "a publicação automática precisa mostrar os sete emojis originais em cabeçalho grande");
    assert.equal((String(deliveryHeading.content).match(/<:prime_entrega[0-6]:/g) ?? []).length, 7);
    const singleJson = JSON.parse(JSON.stringify(singlePayload));
    const purchaseButton = singleJson.components[0].components[0];
    assert.equal(purchaseButton.type, 2);
    assert.equal(purchaseButton.emoji?.name, "prime_cart", "o botão de compra deve usar o emoji cart da aplicação");
    const multiJson = JSON.parse(JSON.stringify(multiPayload));
    assert.equal(multiJson.components[0].components[0].type, 3);
    assert.equal(multiJson.components[0].components[0].placeholder, "Selecione um produto");
    assert.ok(multiJson.components[0].components[0].options.every((option: Record<string, unknown>) => option.default === undefined));
    assert.match(JSON.stringify(singlePayload), /prime_entrega0|entrega/i);

    const cart = products.ensureCart(GUILD, USER, "323456789012345678", "423456789012345678");
    products.addToCart(USER, single.id, singleField.id, 1, GUILD);
    products.addToCart(USER, single.id, singleField.id, 1, GUILD);
    assert.equal(cart.items.length, 1, "o serviço deve consolidar o mesmo item");
    products.setCartQuantity(USER, single.id, singleField.id, 2, GUILD);
    assert.equal(cart.items[0]?.quantity, 2);

    const coupon = products.createCoupon({
      guildId: GUILD, code: "PRIME10", type: "PERCENT", value: 10, minOrderCents: 500, maxUses: 5, perUserLimit: 1,
      active: true, startsAt: null, expiresAt: new Date(Date.now() + 86400000).toISOString(), productIds: [single.id], productGroups: []
    }, "tester");
    cart.couponCode = coupon.code; db.save();
    const totals = products.cartTotals(GUILD, USER);
    assert.equal(totals.subtotalCents, 2000); assert.equal(totals.discountCents, 200); assert.equal(totals.totalCents, 1800);

    db.payments(GUILD).manualPixKey = "pagamentos@example.com";
    db.payments(GUILD).manualPixCode = "";
    db.payments(GUILD).defaultProvider = "MANUAL_PIX"; db.save();
    const order = await orders.createFromCart({ guildId: GUILD, userId: USER, username: "Comprador", purchaseChannelId: "523456789012345678", provider: "MANUAL_PIX" });
    assert.equal(order.status, "PENDING"); assert.ok(order.pixCode); assert.ok(order.qrCodeDataUrl.startsWith("data:image/"));
    assert.match(order.expiresAt, /^9999-12-31/, "pagamentos manuais não podem expirar automaticamente");
    assert.equal(order.paymentKey, "pagamentos@example.com");
    const manualPaymentJson = JSON.stringify(views.paymentPending(GUILD, order));
    assert.doesNotMatch(manualPaymentJson, /payment:check:/, "PIX manual não deve exibir verificação automática");
    assert.equal(coupon.uses, 0, "cupom não pode ser consumido antes da aprovação");
    await orders.approveManual(order.id, "tester");
    assert.equal(products.getCoupon(GUILD, coupon.id).uses, 1);
    assert.equal(db.state.couponUsages.length, 1);
    assert.equal(db.state.carts[cart.id], undefined);
    assert.equal(db.state.abandonedCarts[cart.id]?.status, "PAID");
    assert.equal(order.status, "DELIVERED");
    assert.equal(order.deliveredProducts.length, 2);
    assert.deepEqual(order.deliveredProducts.map((item) => item.content), ["login1", "login2"]);

    const imapCart = products.ensureCart(GUILD, USER, "323456789012345679", "423456789012345679");
    products.addToCart(USER, single.id, singleField.id, 1, GUILD);
    const imapSettings = db.payments(GUILD).imapPix;
    Object.assign(imapSettings, {
      enabled: true,
      bank: "INTER",
      emailProvider: "GMAIL",
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      username: "teste@example.com",
      pixKey: "123e4567-e89b-12d3-a456-426614174000",
      pixKeyType: "random",
      merchantName: "166COMMUNITY",
      merchantCity: "SAO PAULO"
    });
    db.setSecret("imap_password", "senha-de-aplicativo", GUILD);
    db.save();
    const imapOrder = await orders.createFromCart({ guildId: GUILD, userId: USER, username: "Comprador", purchaseChannelId: imapCart.channelId, provider: "IMAP_PIX", payerFullName: "Maria da Silva" });
    assert.equal(imapOrder.imapBank, "INTER");
    assert.equal(imapOrder.payerFullName, "Maria da Silva");
    assert.ok(imapOrder.pixCode);
    validatePayload(views.paymentPending(GUILD, imapOrder));
    assert.match(JSON.stringify(views.paymentPending(GUILD, imapOrder)), /payment:check:/, "somente IMAP deve exibir verificação");

    const interEmail = "Banco Inter informa: você recebeu um Pix de Maria da Silva no valor de R$ 10,00.";
    assert.equal(matchesSelectedBankNotification(imapSettings, ["avisos@inter.co"], "Banco Inter", "Você recebeu um Pix", interEmail), true);
    assert.equal(matchesSelectedBankNotification(imapSettings, ["avisos@inter.co"], "Banco Inter", "Você recebeu um Pix", interEmail, "spf=pass smtp.mailfrom=inter.co; dmarc=pass header.from=inter.co"), true);
    assert.equal(matchesSelectedBankNotification(imapSettings, ["avisos@inter.co"], "Banco Inter", "Você recebeu um Pix", interEmail, "spf=fail smtp.mailfrom=inter.co; dmarc=fail header.from=inter.co"), false);
    assert.equal(matchesSelectedBankNotification({ ...imapSettings, bank: "NUBANK" }, ["avisos@inter.co"], "Banco Inter", "Você recebeu um Pix", interEmail), false);
    assert.deepEqual(parseImapAmounts(interEmail), [1000]);
    const matched = matchPendingImapOrder(GUILD, imapSettings, [imapOrder], [1000], interEmail, new Date());
    assert.equal(matched.safe, true);
    assert.equal(matched.order?.id, imapOrder.id);
    const wrongName = matchPendingImapOrder(GUILD, imapSettings, [imapOrder], [1000], "Banco Inter: Pix recebido de João Souza no valor de R$ 10,00", new Date());
    assert.equal(wrongName.safe, false);
    orders.cancel(imapOrder.id, "tester");

    const panel = tickets.createPanel({ guildId: GUILD, name: "Atendimento", title: "Central de atendimento", description: "Selecione uma opção.", imageUrl: "https://example.com/ticket-banner.png", mode: "SELECT" }, "tester");
    tickets.addPanelField(panel.id, { name: "Horário", value: "Todos os dias", inline: true }, "tester");
    const ticketOption = tickets.addOption(panel.id, { name: "Compras", description: "Ajuda com pedidos", emojiSemantic: "🛒", askSubject: true }, "tester");
    assert.equal(ticketOption.active, true);
    assert.equal(ticketOption.maxOpenTicketsPerUser, 1);
    validatePayload(views.ticketPanelDetail(GUILD, panel));
    const ticketPayload = views.publicTicketPanel(GUILD, panel);
    validateComponentsV2Payload(ticketPayload);
    const ticketJson = JSON.parse(JSON.stringify(ticketPayload)) as { components: Array<{ type: number; components: Array<Record<string, unknown>> }> };
    assert.equal(ticketJson.components[0]?.type, 17, "o painel público de ticket precisa ser um único Container V2");
    const ticketChildren = ticketJson.components[0]?.components ?? [];
    const gallery = ticketChildren.find((component) => component.type === 12) as { items?: Array<{ media?: { url?: string } }> } | undefined;
    assert.equal(gallery?.items?.[0]?.media?.url, "https://example.com/ticket-banner.png", "o banner precisa ficar dentro do container");
    const ticketRow = ticketChildren.find((component) => component.type === 1) as { components?: Array<Record<string, unknown>> } | undefined;
    assert.equal(ticketRow?.components?.[0]?.custom_id, `ticket:open-select:${panel.id}`);
    assert.ok((ticketRow?.components?.[0]?.options as Array<Record<string, unknown>>).every((option) => option.default === undefined), "o select público não pode manter opção marcada");
    assert.deepEqual(views.publicTicketPanelEdit(GUILD, panel).embeds, []);

    const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      views.button(GUILD, "admin:page:0", "Anterior", "back", ButtonStyle.Secondary, true),
      views.button(GUILD, "admin:page:0", "Próxima", "arrow", ButtonStyle.Secondary, true)
    );
    assert.doesNotThrow(() => assertDiscordPayload({ components: [disabledRow] }, "botões desativados"));
    assert.throws(() => assertDiscordPayload({ components: [{ type: 1, components: [
      { type: 2, style: 2, label: "A", custom_id: "duplicado" },
      { type: 2, style: 2, label: "B", custom_id: "duplicado" }
    ] }] }, "duplicação simulada"), /custom_id duplicado/);

    const template = {
      id: "MSG_TESTE", guildId: GUILD, name: "Aviso", content: "@everyone não será mencionado automaticamente.",
      title: "Atualização importante", description: "Descrição completa da mensagem.", color: "#3155ff",
      bannerUrl: "https://example.com/message-banner.png", thumbnailUrl: "https://example.com/thumb.png", footer: "166 Community",
      links: [{ id: "LNK_TESTE", label: "Abrir site", url: "https://example.com", emoji: "link" }], publications: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    db.state.messageTemplates[template.id] = template;
    db.automations(GUILD).channelSchedules.push({
      id: "SCH_TESTE", name: "Expediente", enabled: true, channelIds: [], lockTime: "22:00", unlockTime: "08:00",
      timezone: "America/Sao_Paulo", lockMessage: "Fechado.", unlockMessage: "Aberto.", lastLockDate: "", lastUnlockDate: "",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    db.save();
    const messagePayload = views.botMessage(GUILD, template);
    validateComponentsV2Payload(messagePayload);
    const messageJson = JSON.parse(JSON.stringify(messagePayload)) as { components: Array<{ components: Array<Record<string, unknown>> }> };
    assert.ok(messageJson.components[0]?.components.some((component) => component.type === 9), "a miniatura precisa ficar em uma Section V2");
    assert.ok(messageJson.components[0]?.components.some((component) => component.type === 12), "o banner precisa ficar na galeria do container");
    tickets.updateOption(panel.id, ticketOption.id, { emojiSemantic: "🤝", mentionSupport: false, maxOpenTicketsPerUser: 2 }, "tester");
    assert.equal(tickets.getPanel(panel.id).options[0]?.emojiSemantic, "🤝");

    db.updateGuild(GUILD, (guild) => {
      guild.permissions.adminUserIds = [USER]; guild.permissions.paymentRoleIds = ["623456789012345678"];
      guild.locks.ignoredChannelIds = ["723456789012345678"]; guild.locks.speakingRoleIds = ["823456789012345678"];
    });
    db.save();

    const expectedFiles = [
      "loja/configuracoes.json", "produtos/produtos.json", "produtos/estoque.json", "carrinhos/ativos.json", "carrinhos/abandonados.json",
      "produtos/avisos-restock.json", "pagamentos/configuracoes.json", "pagamentos/aprovados.json", "pagamentos/transacoes-gateway.json", "cupons/cupons.json", "cupons/usos.json", "tickets/configuracoes.json",
      "usuarios/permissoes.json", "loja/mensagens.json", "loja/automacoes.json", "logs/administracao.json", "logs/pagamentos.json", "logs/erros.json", "backups/indice.json"
    ];
    for (const relative of expectedFiles) assert.ok(existsSync(join(root, GUILD, relative)), `arquivo ausente: ${relative}`);
    const stockRaw = readFileSync(join(root, GUILD, "produtos", "estoque.json"), "utf8");
    assert.ok(stockRaw.includes("login3"), "stock precisa permanecer legível");
    const paymentConfig = readFileSync(join(root, GUILD, "pagamentos", "configuracoes.json"), "utf8");
    assert.ok(!/access_token|client_secret|password/i.test(paymentConfig), "credenciais privadas não devem ser gravadas no banco operacional");
    const credentialsRaw = readFileSync(join(dir, "config", "private-credentials.json"), "utf8");
    assert.ok(credentialsRaw.includes("imap_password"));

    const reloadedCredentials = new CredentialStore(join(dir, "config", "private-credentials.json"), logger);
    const reloaded = new JsonDatabase(root, logger, reloadedCredentials);
    assert.equal(reloaded.state.version, 13);
    assert.equal(reloaded.state.orders[order.id]?.deliveredProducts[0]?.content, "login1");
    assert.equal(reloaded.state.ticketPanels[panel.id]?.options[0]?.emojiSemantic, "🤝");
    assert.equal(reloaded.state.messageTemplates.MSG_TESTE?.title, "Atualização importante");
    assert.equal(reloaded.automations(GUILD).channelSchedules[0]?.lockTime, "22:00");
    assert.equal(reloaded.getSecret("imap_password", GUILD), "senha-de-aplicativo");

    console.log("SMOKE_OK v13.0: painel administrativo V2, IDs exclusivos, tickets, sete pagamentos, restock e banco v13 persistente");
  } finally {
    client?.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
