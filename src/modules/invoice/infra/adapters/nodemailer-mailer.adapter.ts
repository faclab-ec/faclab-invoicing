import nodemailer from 'nodemailer';

import { InvoiceMailer, MailRejectedError, OutgoingMail, SentMail } from '../../domain/ports';

export interface SmtpConfig {
  host: string | null;
  port: number;
  secure: boolean;
  requireTls: boolean;
  user: string | null;
  password: string | null;
  timeoutMs: number;
}

// nodemailer's codes for a refused envelope (sender, recipients) or message
const REFUSED = new Set(['EENVELOPE', 'EMESSAGE']);

/** Any SMTP server (D-3): the provider is chosen where it is deployed */
export class NodemailerInvoiceMailer implements InvoiceMailer {
  private readonly transporter: ReturnType<typeof nodemailer.createTransport>;

  constructor(smtp: SmtpConfig) {
    this.transporter = nodemailer.createTransport({
      host: smtp.host ?? undefined,
      port: smtp.port,
      secure: smtp.secure,
      requireTLS: smtp.requireTls,
      auth: smtp.user ? { user: smtp.user, pass: smtp.password ?? '' } : undefined,
      connectionTimeout: smtp.timeoutMs,
      greetingTimeout: smtp.timeoutMs,
      socketTimeout: smtp.timeoutMs,
      // The attachments are buffers: never a path or a URL read on someone's behalf
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  async send(mail: OutgoingMail): Promise<SentMail> {
    try {
      const info = await this.transporter.sendMail({
        from: mail.from,
        replyTo: mail.replyTo ?? undefined,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        attachments: mail.attachments,
      });
      return { messageId: info.messageId, response: info.response };
    } catch (error) {
      const failure = error as { code?: string; responseCode?: number; response?: string };
      // 5xx to the envelope or the message: retrying gets the same answer. A refused login
      // (EAUTH 535) is the service's configuration, not the buyer's address: retried
      if (failure.code && REFUSED.has(failure.code) && (failure.responseCode ?? 0) >= 500) {
        throw new MailRejectedError(failure.response ?? String(failure.responseCode));
      }
      throw error;
    }
  }

  close(): void {
    this.transporter.close();
  }
}
