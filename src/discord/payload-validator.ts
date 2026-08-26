type JsonObject = Record<string, unknown>;

export class DiscordPayloadError extends Error {
  constructor(message: string, readonly context: string, readonly path: string) {
    super(`${context}: ${message} (${path})`);
    this.name = "DiscordPayloadError";
  }
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function fail(context: string, path: string, message: string): never {
  throw new DiscordPayloadError(message, context, path);
}

/**
 * Valida o formato serializado que será enviado à API do Discord.
 *
 * O Discord rejeita a mensagem inteira quando encontra dois custom_id iguais,
 * inclusive se um dos botões estiver desativado ou estiver aninhado em um
 * Container do Components V2. A validação é global por payload e intencionalmente
 * acontece depois da serialização dos builders, exatamente como a API os verá.
 */
export function assertDiscordPayload(payload: unknown, context = "payload"): void {
  let json: JsonObject;
  try {
    json = object(JSON.parse(JSON.stringify(payload))) ?? fail(context, "data", "o payload não é um objeto serializável");
  } catch (error) {
    if (error instanceof DiscordPayloadError) throw error;
    fail(context, "data", `falha ao serializar: ${String(error)}`);
  }

  const top = array(json.components);
  if (top.length > 5) fail(context, "data.components", `existem ${top.length} componentes no topo; o limite é 5`);

  const flags = typeof json.flags === "number" ? json.flags : 0;
  const componentsV2 = (flags & 32768) === 32768;
  if (componentsV2 && array(json.embeds).length) fail(context, "data.embeds", "Components V2 não pode ser combinado com embeds");

  const customIds = new Map<string, string>();
  const visit = (value: unknown, path: string): void => {
    const component = object(value);
    if (!component) fail(context, path, "componente inválido");
    const type = Number(component.type ?? 0);
    const customId = typeof component.custom_id === "string" ? component.custom_id : "";
    if (customId) {
      if (customId.length > 100) fail(context, `${path}.custom_id`, `custom_id possui ${customId.length} caracteres; o limite é 100`);
      const previous = customIds.get(customId);
      if (previous) fail(context, `${path}.custom_id`, `custom_id duplicado ${JSON.stringify(customId)}; primeira ocorrência em ${previous}`);
      customIds.set(customId, `${path}.custom_id`);
    }

    if (typeof component.label === "string") {
      const limit = type === 2 ? 80 : 100;
      if (component.label.length > limit) fail(context, `${path}.label`, `rótulo possui ${component.label.length} caracteres; o limite é ${limit}`);
    }
    if (typeof component.placeholder === "string" && component.placeholder.length > 150) {
      fail(context, `${path}.placeholder`, "placeholder excede 150 caracteres");
    }
    if (type === 10) {
      const content = typeof component.content === "string" ? component.content : "";
      if (!content || content.length > 4000) fail(context, `${path}.content`, `Text Display precisa ter entre 1 e 4000 caracteres; recebeu ${content.length}`);
    }

    const options = array(component.options);
    if (options.length > 25) fail(context, `${path}.options`, `select possui ${options.length} opções; o limite é 25`);
    const optionValues = new Set<string>();
    for (let index = 0; index < options.length; index++) {
      const option = object(options[index]) ?? fail(context, `${path}.options[${index}]`, "opção inválida");
      const value = typeof option.value === "string" ? option.value : "";
      if (!value || value.length > 100) fail(context, `${path}.options[${index}].value`, "valor precisa ter entre 1 e 100 caracteres");
      if (optionValues.has(value)) fail(context, `${path}.options[${index}].value`, `valor duplicado ${JSON.stringify(value)}`);
      optionValues.add(value);
      if (typeof option.label !== "string" || !option.label.length || option.label.length > 100) fail(context, `${path}.options[${index}].label`, "rótulo precisa ter entre 1 e 100 caracteres");
      if (typeof option.description === "string" && option.description.length > 100) fail(context, `${path}.options[${index}].description`, "descrição excede 100 caracteres");
    }

    const children = array(component.components);
    if (type === 1 && (children.length < 1 || children.length > 5)) fail(context, `${path}.components`, `Action Row precisa ter entre 1 e 5 componentes; recebeu ${children.length}`);
    if (type === 17 && children.length > 40) fail(context, `${path}.components`, `Container possui ${children.length} filhos; o limite é 40`);
    children.forEach((child, index) => visit(child, `${path}.components[${index}]`));
  };

  top.forEach((component, index) => visit(component, `data.components[${index}]`));
}

export function checkedDiscordPayload<T>(payload: T, context: string): T {
  assertDiscordPayload(payload, context);
  return payload;
}
