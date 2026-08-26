import type { PaymentCharge, PaymentProviderName } from "../types.js";

export interface ChargeCustomer {
  discordId: string;
  name: string;
  email: string;
  document: string;
}

export interface ChargeInput {
  guildId: string;
  orderId: string;
  amountCents: number;
  description: string;
  customer: ChargeCustomer;
  expiresAt: string;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  createCharge(input: ChargeInput): Promise<PaymentCharge>;
  getCharge(externalId: string): Promise<PaymentCharge>;
  cancelCharge?(externalId: string): Promise<PaymentCharge>;
  test?(): Promise<string>;
}

export const cleanDocument = (value: string): string => value.replace(/\D/g, "").slice(0, 14);

export function requireDocument(value: string, provider: string): string {
  const document = cleanDocument(value);
  if (![11, 14].includes(document.length)) throw new Error(`${provider} exige CPF (11 dígitos) ou CNPJ (14 dígitos) do pagador.`);
  return document;
}

