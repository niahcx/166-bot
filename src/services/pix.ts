import QRCode from "qrcode";

function field(id: string, value: string): string {
  const length = Buffer.byteLength(value, "utf8");
  if (length > 99) throw new Error(`Campo PIX ${id} excede 99 bytes.`);
  return `${id}${String(length).padStart(2, "0")}${value}`;
}
function sanitize(value: string, max: number): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9 .-]/g, "").trim().slice(0, max);
}
function normalizePixKey(value: string, type: "cpf" | "cnpj" | "email" | "phone" | "random" | "unknown"): string {
  const key = value.trim();
  if (type === "cpf" || type === "cnpj") return key.replace(/\D/g, "");
  if (type === "email") return key.replace(/\s/g, "").toLowerCase();
  if (type === "phone") { const digits = key.replace(/\D/g, ""); return key.startsWith("+") ? `+${digits}` : digits; }
  return key.replace(/\s/g, "");
}
export function crc16Ccitt(payload: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(payload, "utf8")) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) { crc = (crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1; crc &= 0xffff; }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}
export function createStaticPixPayload(input: {
  pixKey: string; pixKeyType?: "cpf" | "cnpj" | "email" | "phone" | "random" | "unknown";
  merchantName: string; merchantCity: string; amountCents: number; txid: string; description?: string;
}): string {
  const pixKey = normalizePixKey(input.pixKey, input.pixKeyType ?? "unknown");
  if (!pixKey) throw new Error("Configure uma chave PIX.");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new Error("O valor PIX precisa ser maior que zero.");
  const merchantName = sanitize(input.merchantName || "166 COMMUNITY", 25) || "166 COMMUNITY";
  const merchantCity = sanitize(input.merchantCity || "SAO PAULO", 15) || "SAO PAULO";
  const txid = input.txid.replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "***";
  const description = sanitize(input.description ?? "", 40);
  const account = field("00", "br.gov.bcb.pix") + field("01", pixKey) + (description ? field("02", description) : "");
  let payload = field("00", "01") + field("01", "12") + field("26", account) + field("52", "0000") + field("53", "986");
  payload += field("54", (input.amountCents / 100).toFixed(2)) + field("58", "BR") + field("59", merchantName) + field("60", merchantCity);
  payload += field("62", field("05", txid)) + "6304";
  return `${payload}${crc16Ccitt(payload)}`;
}
export async function pixQrDataUrl(payload: string): Promise<string> {
  return QRCode.toDataURL(payload, { errorCorrectionLevel: "M", margin: 2, width: 640 });
}
