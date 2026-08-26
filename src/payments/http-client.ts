export interface HttpResult {
  status: number;
  headers: Headers;
  data: Record<string, unknown>;
}

export interface HttpRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  json?: Record<string, unknown>;
  form?: URLSearchParams;
  timeoutMs?: number;
  retries?: number;
  retryStatuses?: number[];
  idempotencyKey?: string;
}

const secretPatterns = [
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /(?:sk|ps)_(?:live|test)_[A-Za-z0-9_-]+/gi,
  /(?:client[_ -]?secret|access[_ -]?token)["' :=]+[^\s,"']+/gi
];

export function safeErrorText(value: unknown, limit = 500): string {
  let output = String(value ?? "Erro desconhecido");
  for (const pattern of secretPatterns) output = output.replace(pattern, "[CREDENCIAL_OCULTA]");
  return output.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, limit);
}

export class GatewayHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly provider: string,
    readonly response: Record<string, unknown>
  ) { super(message); }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class GatewayHttpClient {
  constructor(private readonly provider: string, private readonly baseUrl: string, private readonly defaultHeaders: Record<string, string> = {}) {}

  async request(path: string, options: HttpRequestOptions = {}): Promise<HttpResult> {
    const retries = Math.max(0, Math.min(4, options.retries ?? 0));
    const retryStatuses = new Set(options.retryStatuses ?? [429, 500, 502, 503, 504]);
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const headers: Record<string, string> = { Accept: "application/json", ...this.defaultHeaders, ...(options.headers ?? {}) };
        let body: string | undefined;
        if (options.form) {
          body = options.form.toString();
          headers["Content-Type"] = "application/x-www-form-urlencoded";
        } else if (options.json) {
          body = JSON.stringify(options.json);
          headers["Content-Type"] = "application/json";
        }
        if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
        const response = await fetch(`${this.baseUrl}${path}`, {
          method: options.method ?? "GET",
          headers,
          body,
          signal: AbortSignal.timeout(options.timeoutMs ?? 25_000)
        });
        const raw = await response.text();
        let data: Record<string, unknown> = {};
        try { data = raw ? JSON.parse(raw) as Record<string, unknown> : {}; }
        catch { data = { error: `${this.provider} retornou conteúdo que não é JSON.` }; }
        if (response.ok) return { status: response.status, headers: response.headers, data };

        const message = safeErrorText(data.error ?? (data.error as Record<string, unknown> | undefined)?.message ?? data.message ?? `${this.provider} respondeu HTTP ${response.status}`);
        const error = new GatewayHttpError(message, response.status, this.provider, data);
        if (attempt >= retries || !retryStatuses.has(response.status)) throw error;
        const retryAfter = Number(response.headers.get("retry-after") ?? 0);
        await wait(retryAfter > 0 ? Math.min(10_000, retryAfter * 1000) : 250 * (2 ** attempt) + Math.floor(Math.random() * 100));
      } catch (error) {
        lastError = error;
        if (error instanceof GatewayHttpError || attempt >= retries) throw error;
        await wait(250 * (2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`${this.provider} não respondeu.`);
  }
}

export function objectAt(value: unknown, ...path: string[]): Record<string, unknown> {
  let current: unknown = value;
  for (const key of path) current = current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
  return current && typeof current === "object" ? current as Record<string, unknown> : {};
}

export const textAt = (value: unknown): string => String(value ?? "").trim();

