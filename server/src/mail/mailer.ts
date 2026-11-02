import nodemailer from "nodemailer";
import type { Db } from "../db/client.js";
import { resolveSettings } from "../settings.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** SMTP settings of one email, read from the settings when it is sent. */
export interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

/** Sends one message; replaced by a fake in tests. */
export type MailTransport = (smtp: SmtpSettings, message: MailMessage) => Promise<void>;

/** No SMTP host or sender is set, in the admin panel or the environment. */
export class MailNotConfiguredError extends Error {
  override name = "MailNotConfiguredError";
}

/**
 * SMTP through nodemailer with TLS required: port 465 uses TLS from the start,
 * any other port must upgrade with STARTTLS.
 */
export const smtpTransport: MailTransport = async (smtp, message) => {
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    requireTLS: smtp.port !== 465,
    ...(smtp.user === "" ? {} : { auth: { user: smtp.user, pass: smtp.password } }),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    await transporter.sendMail({ from: smtp.from, ...message });
  } finally {
    transporter.close();
  }
};

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Sends email with the SMTP settings current at the time of sending. */
export function createMailer(
  db: Db,
  secret: string,
  transport: MailTransport = smtpTransport,
): Mailer {
  return {
    async send(message) {
      const { values } = await resolveSettings(db, { secret });
      if (values.smtpHost === "" || values.smtpFrom === "") {
        throw new MailNotConfiguredError("SMTP is not configured");
      }
      await transport(
        {
          host: values.smtpHost,
          port: values.smtpPort,
          user: values.smtpUser,
          password: values.smtpPassword,
          from: values.smtpFrom,
        },
        message,
      );
    },
  };
}
