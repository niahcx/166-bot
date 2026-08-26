import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { APIMessageComponentEmoji, Client } from "discord.js";
import type { AppConfig, EmojiTheme, InstalledEmoji, SavedApplicationEmoji } from "../types.js";
import type { JsonDatabase } from "../core/json-db.js";
import type { Logger } from "../core/logger.js";
import { nowIso, sleep } from "../core/utils.js";

interface ManifestEmoji {
  semantic: string;
  theme: EmojiTheme;
  name: string;
  file: string;
  label: string;
  fallback: string;
  sha256: string;
  source?: string;
}

interface PackInfo {
  id: string;
  name: string;
  count: number;
}

interface DiscordEmojiResponse {
  id: string;
  name: string;
  animated?: boolean;
}

const manifest = JSON.parse(
  readFileSync(resolve("assets/emojis/manifest.json"), "utf8")
) as ManifestEmoji[];
const packInfo = JSON.parse(
  readFileSync(resolve("assets/emojis/pack-info.json"), "utf8")
) as PackInfo;

const bySemantic = new Map(manifest.map((item) => [item.semantic, item]));
const byName = new Map(manifest.map((item) => [item.name, item]));

/**
 * Funções internas do bot -> emoji real do pacote enviado pelo usuário.
 * A função continua estável mesmo quando o administrador troca o desenho no painel.
 */
const aliases: Record<string, string> = {
  home: "home",
  settings: "settings",
  config: "config",
  customize: "wand",
  theme: "colors",
  color: "colors",
  emoji: "reaction",
  refresh: "reload",
  save: "save",
  download: "cloud",
  upload: "cloud",
  edit: "edit",
  image: "image",
  plus: "plus",
  minus: "minus",
  back: "back",
  trash: "delete",
  approve: "correct",
  reject: "wrong",
  warning: "warn",
  alert: "alert",
  information: "information",
  search: "search",

  products: "store",
  product_add: "plus",
  product_edit: "edit",
  product_delete: "delete",
  product_duplicate: "cardbox",
  store: "store",
  catalog: "basket",
  category: "folder",
  coupon: "coupon",
  cart: "cart",
  checkout: "wallet",
  terms: "information",
  delivery: "truck",
  stock: "cardbox",
  stock_add: "plus",
  stock_view: "search",
  stock_clear: "delete",
  vip: "diamond",
  customer: "member",
  users: "members",

  payment: "pix",
  mercadopago: "mercado_pago",
  efibank: "efi_bank",
  imap: "mail2",
  manual: "wallet",
  invoice: "receipt",
  pending: "clock",
  bank: "bank",

  ticket: "ticket",
  ticket_add: "plus",
  ticket_claim: "member",
  ticket_close: "lock",
  ticket_reopen: "unlock",
  ticket_archive: "folder",
  transcript: "textc",
  support: "headset",
  message: "message",

  automation: "reload",
  protection: "shield",
  giveaway: "giveaway",
  announcement: "announcement",
  analytics: "chart",
  revenue: "chart",
  backup: "save",

  stock_request: "bag",
  stock_request_send: "announcement",
  stock_request_pending: "clock",
  stock_request_claim: "member",
  stock_request_available: "correct",
  stock_request_reject: "wrong",
  saved_emoji: "reaction_add",
  saved_emoji_list: "reaction",
  saved_emoji_copy: "save",
  saved_emoji_remove: "delete",
  entrega0: "entrega0",
  entrega1: "entrega1",
  entrega2: "entrega2",
  entrega3: "entrega3",
  entrega4: "entrega4",
  entrega5: "entrega5",
  entrega6: "entrega6"
};

const functionalLabels: Record<string, string> = {
  home: "Início",
  settings: "Configurações",
  config: "Configuração",
  customize: "Personalização",
  theme: "Tema visual",
  color: "Cores",
  emoji: "Emojis",
  refresh: "Atualizar / sincronizar",
  save: "Salvar",
  download: "Baixar / backup",
  upload: "Enviar arquivo",
  edit: "Editar",
  image: "Imagem",
  plus: "Adicionar",
  minus: "Remover",
  back: "Voltar",
  trash: "Excluir",
  approve: "Aprovar",
  reject: "Recusar",
  warning: "Aviso",
  alert: "Alerta",
  information: "Informações",
  search: "Pesquisar",
  products: "Produtos",
  product_add: "Criar produto",
  product_edit: "Editar produto",
  product_delete: "Excluir produto",
  product_duplicate: "Duplicar produto",
  store: "Produtos",
  catalog: "Catálogo",
  category: "Categorias",
  coupon: "Cupons",
  cart: "Carrinho",
  checkout: "Finalizar compra",
  terms: "Termos",
  delivery: "Entrega",
  stock: "Estoque",
  stock_add: "Adicionar estoque",
  stock_view: "Consultar estoque",
  stock_clear: "Limpar estoque",
  vip: "Destaque / VIP",
  customer: "Cliente",
  users: "Membros",
  payment: "Pagamentos",
  mercadopago: "Mercado Pago",
  efibank: "Efí Bank",
  imap: "IMAP PIX",
  manual: "PIX manual",
  invoice: "Pedidos / comprovantes",
  pending: "Pendente",
  bank: "Banco",
  ticket: "Tickets",
  ticket_add: "Criar ticket",
  ticket_claim: "Assumir ticket",
  ticket_close: "Fechar ticket",
  ticket_reopen: "Reabrir ticket",
  ticket_archive: "Arquivar ticket",
  transcript: "Transcript",
  support: "Atendimento",
  message: "Mensagem",
  automation: "Automações",
  protection: "Proteção",
  giveaway: "Sorteios",
  announcement: "Anúncios",
  analytics: "Rendimento",
  revenue: "Faturamento",
  backup: "Backup",
  stock_request: "Pedir Stock",
  stock_request_send: "Enviar pedido de stock",
  stock_request_pending: "Stock pendente",
  stock_request_claim: "Assumir pedido de stock",
  stock_request_available: "Stock disponível",
  stock_request_reject: "Recusar pedido de stock",
  saved_emoji: "Salvar emoji",
  saved_emoji_list: "Biblioteca de emojis",
  saved_emoji_copy: "Copiar ID do emoji",
  saved_emoji_remove: "Remover emoji salvo",
  entrega0: "Entrega automática 1/7 • início",
  entrega1: "Entrega automática 2/7",
  entrega2: "Entrega automática 3/7",
  entrega3: "Entrega automática 4/7",
  entrega4: "Entrega automática 5/7",
  entrega5: "Entrega automática 6/7",
  entrega6: "Entrega automática 7/7 • fim"
};

export class EmojiManager {
  private syncing = false;
  private completed = 0;
  private total = manifest.length;
  private lastError = "";

  constructor(
    private readonly client: Client,
    private readonly db: JsonDatabase,
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {}

  get status() {
    const installed = manifest.reduce((count, item) => count + (this.db.state.emojis[`${item.semantic}:solid`] ? 1 : 0), 0);
    return {
      syncing: this.syncing,
      completed: this.completed,
      total: this.total,
      installed,
      lastError: this.lastError,
      packId: packInfo.id,
      packName: packInfo.name
    };
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!this.config.botToken) throw new Error("O token do bot não foi carregado do Token.json.");
    const url = `https://discord.com/api/v10${path}`;
    for (let attempt = 0; attempt < 7; attempt++) {
      const response = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bot ${this.config.botToken}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {})
        },
        signal: AbortSignal.timeout(30_000)
      });
      const text = await response.text();
      let data: Record<string, unknown> = {};
      try { data = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { data = { message: text }; }
      if (response.status === 429) {
        const retry = Number(data.retry_after ?? 1.5) * 1000;
        this.logger.warn(`Limite temporário da API do Discord. Nova tentativa em ${Math.ceil(retry / 1000)}s.`);
        await sleep(Math.max(1000, retry));
        continue;
      }
      if (!response.ok) throw new Error(String(data.message ?? `Discord HTTP ${response.status}`));
      return data;
    }
    throw new Error("A API do Discord manteve o limite de requisições por muito tempo.");
  }

  private applicationId(): string {
    const id = this.client.application?.id ?? this.config.clientId;
    if (!id) throw new Error("Application ID indisponível.");
    return id;
  }

  private async listRemote(): Promise<DiscordEmojiResponse[]> {
    const data = await this.request(`/applications/${this.applicationId()}/emojis`) as Record<string, unknown> | DiscordEmojiResponse[];
    if (Array.isArray(data)) return data;
    return Array.isArray(data.items) ? data.items as DiscordEmojiResponse[] : [];
  }

  private async create(item: ManifestEmoji): Promise<DiscordEmojiResponse> {
    const bytes = readFileSync(resolve("assets/emojis", item.file));
    const image = `data:image/png;base64,${bytes.toString("base64")}`;
    return await this.request(`/applications/${this.applicationId()}/emojis`, {
      method: "POST",
      body: JSON.stringify({ name: item.name, image })
    }) as DiscordEmojiResponse;
  }

  private async remove(id: string): Promise<void> {
    await this.request(`/applications/${this.applicationId()}/emojis/${id}`, { method: "DELETE" });
  }

  private resetForNewPack(): boolean {
    if (this.db.state.meta.emojiPackId === packInfo.id) return false;
    for (const guild of Object.values(this.db.state.guilds)) {
      guild.emojiTheme = "solid";
      for (const [key, value] of Object.entries(guild.emojiOverrides)) {
        const semantic = value.split(":")[0] ?? "";
        if (!bySemantic.has(semantic)) delete guild.emojiOverrides[key];
        else guild.emojiOverrides[key] = `${semantic}:solid`;
      }
    }
    this.db.state.meta.emojiPackId = packInfo.id;
    this.db.save();
    return true;
  }

  private async cleanupRemote(remote: DiscordEmojiResponse[]): Promise<DiscordEmojiResponse[]> {
    const validNames = new Set(manifest.map((item) => item.name));
    const keep: DiscordEmojiResponse[] = [];
    let removed = 0;

    for (const emoji of remote) {
      const legacyPackEmoji = emoji.name.startsWith("ps_");
      const staleCurrentPack = emoji.name.startsWith("prime_") && !validNames.has(emoji.name);
      if (!legacyPackEmoji && !staleCurrentPack) {
        keep.push(emoji);
        continue;
      }

      this.logger.info(`[EMOJI] Removendo emoji obsoleto: ${emoji.name} (${emoji.id})...`);
      try {
        await this.remove(emoji.id);
        removed++;
        this.logger.success(`[EMOJI] Removido: ${emoji.name}.`);
      } catch (error) {
        this.logger.warn(`[EMOJI] Não foi possível remover ${emoji.name}; a sincronização continuará.`, error);
        keep.push(emoji);
      }
      await sleep(350);
    }

    if (removed) this.logger.success(`${removed} emojis antigos/obsoletos removidos automaticamente.`);
    return keep;
  }

  async syncAutomatic(force = false): Promise<void> {
    if (!force && !this.config.autoInstallEmojis) {
      this.logger.warn("Instalação automática de emojis desativada em config/runtime.json.");
      return;
    }
    if (this.syncing) {
      this.logger.info("Sincronização de emojis já está em andamento; aguardando conclusão.");
      while (this.syncing) await sleep(500);
      return;
    }

    const startedAt = Date.now();
    this.syncing = true;
    this.completed = 0;
    this.lastError = "";

    let createdCount = 0;
    let adoptedCount = 0;
    let existingCount = 0;
    let updatedCount = 0;
    let failedCount = 0;
    let skippedByLimit = 0;

    try {
      this.logger.section(`EMOJIS DA APLICAÇÃO • ${packInfo.name}`);
      this.logger.info(`Pacote carregado: ${manifest.length} arquivos PNG.`);
      this.logger.info(`Application ID: ${this.applicationId()}.`);
      this.logger.info("Consultando emojis já existentes na aplicação...");

      const packChanged = this.resetForNewPack();
      let listedRemote = await this.listRemote();
      this.logger.info(`Emojis encontrados atualmente na aplicação: ${listedRemote.length}.`);

      if (packChanged) {
        const retained: DiscordEmojiResponse[] = [];
        let refreshedDelivery = 0;
        for (const remoteEmoji of listedRemote) {
          if (!/^prime_entrega\d+$/.test(remoteEmoji.name)) {
            retained.push(remoteEmoji);
            continue;
          }
          this.logger.info(`[EMOJI] Atualizando asset de entrega automática: ${remoteEmoji.name} (${remoteEmoji.id})...`);
          try {
            await this.remove(remoteEmoji.id);
            refreshedDelivery++;
          } catch (error) {
            this.logger.warn(`[EMOJI] Não foi possível remover ${remoteEmoji.name}; ele será verificado novamente.`, error);
            retained.push(remoteEmoji);
          }
          await sleep(350);
        }
        listedRemote = retained;
        if (refreshedDelivery) this.logger.success(`${refreshedDelivery} emojis antigos de entrega automática removidos para atualização visual.`);
      }

      const remote = await this.cleanupRemote(listedRemote);
      const remoteByName = new Map(remote.map((emoji) => [emoji.name, emoji]));
      const missingRemote = manifest.filter((item) => !remoteByName.has(item.name)).length;
      if (remote.length + missingRemote > 2000) {
        this.logger.warn(`A aplicação possui ${remote.length} emojis e precisa criar ${missingRemote}. O limite da API é 2000; remova emojis antes de concluir a sincronização.`);
      }
      const limit = this.config.emojiInstallLimit > 0 ? this.config.emojiInstallLimit : Number.POSITIVE_INFINITY;
      const width = String(manifest.length).length;

      this.logger.info("Iniciando instalação/verificação automática dos emojis...");

      for (let index = 0; index < manifest.length; index++) {
        const item = manifest[index]!;
        const current = index + 1;
        const prefix = `[EMOJI] [${String(current).padStart(width, "0")}/${manifest.length}]`;
        const localKey = `${item.semantic}:solid`;
        const stored = this.db.state.emojis[localKey];
        const existing = remoteByName.get(item.name);

        try {
          if (existing && stored?.sha256 === item.sha256 && stored.id === existing.id) {
            existingCount++;
            this.completed++;
            this.logger.info(`${prefix} Já instalado: ${item.name} (${existing.id}).`);
            continue;
          }

          // O registro remoto é adotado quando o arquivo local continua idêntico,
          // preservando os IDs sem reenviar todo o pacote em cada reinicialização.
          if (existing && (!stored || stored.sha256 === item.sha256)) {
            const installed: InstalledEmoji = {
              id: existing.id,
              name: existing.name,
              semantic: item.semantic,
              theme: "solid",
              sha256: item.sha256,
              installedAt: stored?.installedAt ?? nowIso()
            };
            this.db.state.emojis[localKey] = installed;
            this.db.save();
            adoptedCount++;
            this.completed++;
            this.logger.success(`${prefix} Encontrado e vinculado ao JSON: ${item.name} (${existing.id}).`);
            continue;
          }

          if (existing) {
            this.logger.info(`${prefix} Arquivo alterado; removendo versão anterior de ${item.name}...`);
            await this.remove(existing.id);
            remoteByName.delete(item.name);
            delete this.db.state.emojis[localKey];
            updatedCount++;
            await sleep(350);
          }

          if (createdCount >= limit) {
            skippedByLimit++;
            this.completed++;
            this.logger.warn(`${prefix} Ignorado pelo limite definido em config/runtime.json.`);
            continue;
          }

          this.logger.info(`${prefix} Adicionando ${item.name} à aplicação...`);
          const created = await this.create(item);
          const installed: InstalledEmoji = {
            id: created.id,
            name: created.name,
            semantic: item.semantic,
            theme: "solid",
            sha256: item.sha256,
            installedAt: nowIso()
          };
          this.db.state.emojis[localKey] = installed;
          this.db.save();
          remoteByName.set(item.name, created);
          this.completed++;
          createdCount++;
          this.logger.success(`${prefix} Adicionado: ${created.name} (${created.id}).`);
          await sleep(450);
        } catch (error) {
          failedCount++;
          this.completed++;
          const message = error instanceof Error ? error.message : String(error);
          this.lastError = message;
          this.logger.error(`${prefix} Falha em ${item.name}: ${message}`);
          // Não interrompe os demais arquivos por causa de um emoji com problema.
          await sleep(1000);
        }
      }

      for (const key of Object.keys(this.db.state.emojis)) {
        const [semantic] = key.split(":");
        if (!semantic || !bySemantic.has(semantic)) delete this.db.state.emojis[key];
      }
      this.db.state.meta.emojiPackId = packInfo.id;
      this.db.save();

      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      this.logger.section("SINCRONIZAÇÃO DE EMOJIS CONCLUÍDA");
      this.logger.success(`Instalados e registrados: ${this.status.installed}/${manifest.length}.`);
      this.logger.info(`Novos: ${createdCount} • já existentes: ${existingCount} • recuperados: ${adoptedCount} • atualizados: ${updatedCount}.`);
      this.logger.info(`Falhas: ${failedCount} • ignorados por limite: ${skippedByLimit} • tempo: ${seconds}s.`);
      if (failedCount > 0) this.logger.warn("Alguns emojis falharam. Use /emojis instalar para tentar novamente.");
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.error("Falha geral ao sincronizar emojis da aplicação. O bot continuará usando fallback Unicode.", this.lastError);
    } finally {
      this.syncing = false;
    }
  }

  async reinstallAll(): Promise<void> {
    const remote = await this.listRemote();
    for (const emoji of remote) {
      if (!emoji.name.startsWith("prime_") && !emoji.name.startsWith("ps_")) continue;
      await this.remove(emoji.id);
      await sleep(350);
    }
    this.db.state.emojis = {};
    this.db.state.meta.emojiPackId = packInfo.id;
    this.db.save();
    await this.syncAutomatic(true);
  }

  async removeAll(): Promise<number> {
    const remote = await this.listRemote();
    let removed = 0;
    for (const emoji of remote) {
      if (!emoji.name.startsWith("prime_") && !emoji.name.startsWith("ps_")) continue;
      await this.remove(emoji.id);
      removed++;
      await sleep(350);
    }
    this.db.state.emojis = {};
    this.db.save();
    return removed;
  }

  private normalizeUserEmojiName(value: string): string {
    const normalized = value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_")
      .slice(0, 32);
    let safe = normalized.length >= 2 ? normalized : `em_${normalized || "emoji"}`.slice(0, 32);
    if (safe.startsWith("prime_") || safe.startsWith("ps_")) safe = `saved_${safe}`.slice(0, 32);
    return safe;
  }

  private mimeFrom(value: string): string {
    const mime = value.toLowerCase().split(";")[0]!.trim();
    const allowed = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
    if (!allowed.has(mime)) throw new Error("Formato inválido. Use PNG, JPG, GIF, WEBP ou AVIF.");
    return mime;
  }

  private uniqueName(base: string, remote: DiscordEmojiResponse[]): string {
    const used = new Set(remote.map((item) => item.name.toLowerCase()));
    if (!used.has(base.toLowerCase())) return base;
    for (let index = 2; index < 10_000; index++) {
      const suffix = `_${index}`;
      const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
      if (!used.has(candidate.toLowerCase())) return candidate;
    }
    throw new Error("Não foi possível gerar um nome único para o emoji.");
  }

  async saveUserEmoji(input: {
    name: string;
    bytes: Buffer;
    mimeType: string;
    ownerId: string;
    guildId: string;
    originalName?: string;
  }): Promise<SavedApplicationEmoji> {
    if (input.bytes.length === 0) throw new Error("O arquivo do emoji está vazio.");
    if (input.bytes.length > 256 * 1024) throw new Error("O emoji excede o limite de 256 KiB do Discord.");
    const mime = this.mimeFrom(input.mimeType);
    const remote = await this.listRemote();
    if (remote.length >= 2000) throw new Error("A aplicação atingiu o limite de 2000 emojis. Remova algum emoji antes de adicionar outro.");
    const name = this.uniqueName(this.normalizeUserEmojiName(input.name), remote);
    this.logger.info(`[SALVAR EMOJI] Enviando ${name} (${input.bytes.length} bytes) para a aplicação...`);
    const created = await this.request(`/applications/${this.applicationId()}/emojis`, {
      method: "POST",
      body: JSON.stringify({ name, image: `data:${mime};base64,${input.bytes.toString("base64")}` })
    }) as DiscordEmojiResponse;
    const saved: SavedApplicationEmoji = {
      id: created.id,
      name: created.name,
      animated: Boolean(created.animated),
      ownerId: input.ownerId,
      guildId: input.guildId,
      originalName: input.originalName || input.name,
      createdAt: nowIso()
    };
    this.db.state.savedEmojis[saved.id] = saved;
    this.db.audit(input.ownerId, "SAVED_EMOJI_CREATE", "emoji", saved.id, { name: saved.name, animated: saved.animated, guildId: input.guildId });
    this.db.save();
    this.logger.success(`[SALVAR EMOJI] Criado: ${saved.name} (${saved.id}).`);
    return saved;
  }

  listSaved(ownerId?: string, guildId?: string): SavedApplicationEmoji[] {
    return Object.values(this.db.state.savedEmojis)
      .filter((item) => (!ownerId || item.ownerId === ownerId) && (!guildId || item.guildId === guildId))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  findSaved(identifier: string): SavedApplicationEmoji | undefined {
    const cleaned = identifier.trim().replace(/[<:a>]/g, "");
    const direct = this.db.state.savedEmojis[identifier.trim()] ?? this.db.state.savedEmojis[cleaned];
    if (direct) return direct;
    const idMatch = identifier.match(/(\d{15,25})/);
    if (idMatch && this.db.state.savedEmojis[idMatch[1]!]) return this.db.state.savedEmojis[idMatch[1]!]!;
    const lowered = identifier.trim().toLowerCase();
    return Object.values(this.db.state.savedEmojis).find((item) => item.name.toLowerCase() === lowered);
  }

  mentionSaved(item: SavedApplicationEmoji): string {
    return `<${item.animated ? "a" : ""}:${item.name}:${item.id}>`;
  }

  async removeSaved(identifier: string, requesterId: string, allowAny = false): Promise<SavedApplicationEmoji> {
    const item = this.findSaved(identifier);
    if (!item) throw new Error("Emoji salvo não encontrado.");
    if (!allowAny && item.ownerId !== requesterId) throw new Error("Você só pode remover emojis que salvou.");
    await this.remove(item.id);
    delete this.db.state.savedEmojis[item.id];
    this.db.audit(requesterId, "SAVED_EMOJI_DELETE", "emoji", item.id, { name: item.name, ownerId: item.ownerId });
    this.db.save();
    this.logger.success(`[SALVAR EMOJI] Removido: ${item.name} (${item.id}).`);
    return item;
  }

  async reconcileSavedEmojis(): Promise<number> {
    const remote = await this.listRemote();
    const ids = new Set(remote.map((item) => item.id));
    let removed = 0;
    for (const [id] of Object.entries(this.db.state.savedEmojis)) {
      if (ids.has(id)) continue;
      delete this.db.state.savedEmojis[id];
      removed++;
    }
    if (removed) {
      this.db.save();
      this.logger.warn(`[SALVAR EMOJI] ${removed} registros locais removidos porque não existem mais na aplicação.`);
    }
    return removed;
  }

  private canonicalSemantic(semantic: string): string {
    if (bySemantic.has(semantic)) return semantic;
    return aliases[semantic] ?? "sparkles";
  }

  variant(semantic: string, _theme: EmojiTheme = "solid"): InstalledEmoji | undefined {
    const canonical = this.canonicalSemantic(semantic);
    return this.db.state.emojis[`${canonical}:solid`];
  }

  resolve(semantic: string, guildId?: string): InstalledEmoji | undefined {
    const guild = guildId ? this.db.guild(guildId) : undefined;
    const override = guild?.emojiOverrides[semantic];
    if (override && this.db.state.emojis[override]) return this.db.state.emojis[override];
    return this.variant(semantic, "solid");
  }

  fallback(semantic: string): string {
    const canonical = this.canonicalSemantic(semantic);
    return bySemantic.get(canonical)?.fallback ?? "✨";
  }

  private knownCustomEmoji(identifier: string, guildId?: string): { id: string; name: string; animated: boolean } | undefined {
    const value = identifier.trim();
    const mention = value.match(/^<(a?):([a-zA-Z0-9_]{2,32}):(\d{15,25})>$/);
    const rawId = /^\d{15,25}$/.test(value) ? value : mention?.[3];
    if (!rawId) return undefined;

    const saved = this.db.state.savedEmojis[rawId];
    if (saved) return { id: saved.id, name: saved.name, animated: saved.animated };
    const installed = Object.values(this.db.state.emojis).find((item) => item.id === rawId);
    if (installed) return { id: installed.id, name: installed.name, animated: false };
    const cached = this.client.emojis.cache.get(rawId) ?? (guildId ? this.client.guilds.cache.get(guildId)?.emojis.cache.get(rawId) : undefined);
    if (cached) return { id: cached.id, name: cached.name ?? mention?.[2] ?? "emoji", animated: Boolean(cached.animated) };
    return undefined;
  }

  async validateUserInput(value: string, guildId: string, allowEmpty = true): Promise<string> {
    const clean = value.trim();
    if (!clean) {
      if (allowEmpty) return "";
      throw new Error("Escolha um emoji antes de salvar.");
    }
    if (clean.startsWith("saved:")) {
      const saved = this.findSaved(clean.slice(6));
      if (!saved || saved.guildId !== guildId) throw new Error("O emoji salvo não existe neste servidor.");
      return `saved:${saved.name}`;
    }
    if (bySemantic.has(clean) || aliases[clean]) return clean;
    const unicode = this.explicitUnicode(clean);
    if (unicode) return unicode;

    const id = clean.match(/(\d{15,25})/)?.[1];
    if (id) {
      const guild = this.client.guilds.cache.get(guildId);
      if (guild && !this.knownCustomEmoji(clean, guildId)) await guild.emojis.fetch(id).catch(() => undefined);
      const custom = this.knownCustomEmoji(clean, guildId);
      if (!custom) throw new Error("O emoji personalizado não existe, não pertence à aplicação ou não está acessível neste servidor.");
      return `<${custom.animated ? "a" : ""}:${custom.name}:${custom.id}>`;
    }
    throw new Error("Emoji inválido. Envie um emoji comum, uma menção personalizada, um ID válido ou use a biblioteca Salvar Emojis.");
  }

  private explicitSaved(semantic: string): SavedApplicationEmoji | undefined {
    const value = semantic.trim();
    if (/^\d{15,25}$/.test(value) || /^<a?:[a-zA-Z0-9_]+:\d{15,25}>$/.test(value)) return this.findSaved(value);
    if (value.startsWith("saved:")) return this.findSaved(value.slice(6));
    return undefined;
  }

  private explicitUnicode(semantic: string): string | undefined {
    const value = semantic.trim();
    if (!value || value.length > 32 || bySemantic.has(value) || aliases[value]) return undefined;
    return /[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u.test(value) ? value : undefined;
  }

  text(semantic: string, guildId?: string): string {
    const saved = this.explicitSaved(semantic);
    if (saved) return this.mentionSaved(saved);
    const custom = this.knownCustomEmoji(semantic, guildId);
    if (custom) return `<${custom.animated ? "a" : ""}:${custom.name}:${custom.id}>`;
    const unicode = this.explicitUnicode(semantic);
    if (unicode) return unicode;
    const emoji = this.resolve(semantic, guildId);
    return emoji ? `<:${emoji.name}:${emoji.id}>` : this.fallback(semantic);
  }

  component(semantic: string, guildId?: string): APIMessageComponentEmoji | string {
    const saved = this.explicitSaved(semantic);
    if (saved) return { id: saved.id, name: saved.name, animated: saved.animated };
    const custom = this.knownCustomEmoji(semantic, guildId);
    if (custom) return custom;
    const unicode = this.explicitUnicode(semantic);
    if (unicode) return unicode;
    const emoji = this.resolve(semantic, guildId);
    return emoji ? { id: emoji.id, name: emoji.name, animated: false } : this.fallback(semantic);
  }

  textVariant(semantic: string, _theme: EmojiTheme = "solid"): string {
    const emoji = this.variant(semantic, "solid");
    return emoji ? `<:${emoji.name}:${emoji.id}>` : this.fallback(semantic);
  }

  componentVariant(semantic: string, _theme: EmojiTheme = "solid"): APIMessageComponentEmoji | string {
    const emoji = this.variant(semantic, "solid");
    return emoji ? { id: emoji.id, name: emoji.name, animated: false } : this.fallback(semantic);
  }

  semanticOptions(): Array<{ semantic: string; label: string; fallback: string }> {
    return manifest.map((item) => ({ semantic: item.semantic, label: item.label, fallback: item.fallback }));
  }

  functionalOptions(): Array<{ semantic: string; label: string; currentAsset: string }> {
    return Object.keys(functionalLabels).map((semantic) => ({
      semantic,
      label: functionalLabels[semantic]!,
      currentAsset: aliases[semantic] ?? semantic
    }));
  }

  option(semantic: string): ManifestEmoji | undefined {
    return bySemantic.get(semantic);
  }

  isInstalled(semantic: string, guildId?: string): boolean { return Boolean(this.resolve(semantic, guildId)); }
  missing(semantics: string[], guildId?: string): string[] { return semantics.filter((semantic) => !this.isInstalled(semantic, guildId)); }
  packName(): string { return packInfo.name; }
  packId(): string { return packInfo.id; }
  manifestCount(): number { return manifest.length; }
}
