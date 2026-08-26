import type { ImapBank, ImapEmailProvider } from "../types.js";

export interface ImapBankProfile {
  id: ImapBank;
  label: string;
  emojiSemantic: string;
  senderDomains: string[];
  subjectKeywords: string[];
  bodyKeywords: string[];
}

export const IMAP_BANK_PROFILES: Record<ImapBank, ImapBankProfile> = {
  INTER: {
    id: "INTER",
    label: "Banco Inter",
    emojiSemantic: "inter",
    senderDomains: ["inter.co"],
    subjectKeywords: ["pix", "transferência recebida", "transferencia recebida", "você recebeu", "voce recebeu"],
    bodyKeywords: ["pix", "recebeu", "recebimento", "transferência", "transferencia"]
  },
  PICPAY: {
    id: "PICPAY",
    label: "PicPay",
    emojiSemantic: "picpay",
    senderDomains: ["picpay.com"],
    subjectKeywords: ["pix", "você recebeu", "voce recebeu", "pagamento recebido"],
    bodyKeywords: ["pix", "recebeu", "pagamento", "saldo"]
  },
  NUBANK: {
    id: "NUBANK",
    label: "Nubank",
    emojiSemantic: "nubank",
    senderDomains: ["nubank.com.br"],
    subjectKeywords: ["pix", "transferência recebida", "transferencia recebida", "você recebeu", "voce recebeu"],
    bodyKeywords: ["pix", "recebeu", "transferência", "transferencia", "conta do nubank"]
  }
};

export interface ImapEmailPreset {
  id: ImapEmailProvider;
  label: string;
  host: string;
  port: number;
  secure: boolean;
}

export const IMAP_EMAIL_PRESETS: Record<Exclude<ImapEmailProvider, "CUSTOM">, ImapEmailPreset> = {
  GMAIL: { id: "GMAIL", label: "Gmail", host: "imap.gmail.com", port: 993, secure: true },
  OUTLOOK: { id: "OUTLOOK", label: "Outlook / Hotmail", host: "outlook.office365.com", port: 993, secure: true },
  YAHOO: { id: "YAHOO", label: "Yahoo Mail", host: "imap.mail.yahoo.com", port: 993, secure: true }
};

export function bankProfile(bank: ImapBank): ImapBankProfile {
  return IMAP_BANK_PROFILES[bank] ?? IMAP_BANK_PROFILES.INTER;
}

export function applyEmailPreset(provider: ImapEmailProvider): Pick<ImapEmailPreset, "host" | "port" | "secure"> | undefined {
  if (provider === "CUSTOM") return undefined;
  return IMAP_EMAIL_PRESETS[provider];
}
