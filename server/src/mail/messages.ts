import type { MailMessage } from "./mailer.js";
import { HE } from "./strings.he.js";

/** The password reset email, in Hebrew and English. */
export function resetPasswordMessage(to: string, url: string): MailMessage {
  return {
    to,
    subject: `${HE.resetSubject} / Mashkif: reset your password`,
    text: [
      HE.resetBody,
      url,
      "",
      "Someone asked to reset the password of the Mashkif admin. To choose a new password, open this link within an hour. If it was not you, ignore this email.",
      url,
    ].join("\n"),
  };
}

/** The confirmation of a new admin email address, in Hebrew and English. */
export function verifyEmailMessage(to: string, url: string): MailMessage {
  return {
    to,
    subject: `${HE.verifySubject} / Mashkif: confirm your email address`,
    text: [
      HE.verifyBody,
      url,
      "",
      "To use this address for the Mashkif admin, open this link. If you did not ask for it, ignore this email.",
      url,
    ].join("\n"),
  };
}
