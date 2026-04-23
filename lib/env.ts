function str(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() !== "" ? v : undefined;
}

export type SmtpEnv = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
};

export type TwilioEnv = {
  accountSid: string;
  authToken: string;
  fromNumber: string;
};

export type CalendlyEnv = {
  token: string;
  orgUri: string;
};

export function smtpEnv(): SmtpEnv | null {
  const host = str("SMTP_HOST");
  if (!host) return null;
  return {
    host,
    port: Number(str("SMTP_PORT") ?? 587),
    secure: (str("SMTP_SECURE") ?? "false").toLowerCase() === "true",
    user: str("SMTP_USER") ?? "",
    pass: str("SMTP_PASS") ?? "",
    from: str("SMTP_FROM") ?? str("SMTP_USER") ?? "",
  };
}

export function twilioEnv(): TwilioEnv | null {
  const accountSid = str("TWILIO_ACCOUNT_SID");
  const authToken = str("TWILIO_AUTH_TOKEN");
  const fromNumber = str("TWILIO_FROM_NUMBER");
  if (!accountSid || !authToken || !fromNumber) return null;
  return { accountSid, authToken, fromNumber };
}

export function calendlyEnv(): CalendlyEnv | null {
  const token = str("CALENDLY_TOKEN");
  const orgUri = str("CALENDLY_ORG_URI");
  if (!token || !orgUri) return null;
  return { token, orgUri };
}

export function providerStatus() {
  return {
    smtp: smtpEnv() !== null,
    twilio: twilioEnv() !== null,
    calendly: calendlyEnv() !== null,
  };
}
