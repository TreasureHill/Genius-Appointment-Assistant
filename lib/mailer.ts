import nodemailer, { type Transporter } from "nodemailer";
import { smtpEnv } from "./env";

let cachedTransport: { key: string; t: Transporter } | null = null;

export function getMailer(): { transport: Transporter; from: string } | null {
  const cfg = smtpEnv();
  if (!cfg) return null;
  const key = JSON.stringify(cfg);
  if (!cachedTransport || cachedTransport.key !== key) {
    cachedTransport = {
      key,
      t: nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
      }),
    };
  }
  return { transport: cachedTransport.t, from: cfg.from };
}

export async function sendEmail(args: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<{ id?: string }> {
  const mailer = getMailer();
  if (!mailer) throw new Error("SMTP not configured (set SMTP_* in .env)");
  const info = await mailer.transport.sendMail({
    from: mailer.from,
    to: args.to,
    subject: args.subject,
    html: args.html,
    text: args.text,
  });
  return { id: info.messageId };
}
