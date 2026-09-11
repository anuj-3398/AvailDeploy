import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { config } from '@avail/shared/config';
import { createLogger } from '@avail/shared/logger';

const log = createLogger('mail');

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Minimal SMTP client: enough to deliver transactional login mails over
 * implicit TLS (465) or STARTTLS (587/25) with AUTH LOGIN/PLAIN.
 */
class SmtpClient {
  private socket: Socket | TLSSocket | null = null;
  private buffer = '';
  private pending: {
    resolve: (reply: { code: number; lines: string[] }) => void;
    reject: (err: Error) => void;
  } | null = null;

  constructor(
    private readonly opts: {
      host: string;
      port: number;
      secure: boolean;
      user?: string;
      pass?: string;
      timeoutMs: number;
    }
  ) {}

  private attach(socket: Socket | TLSSocket): void {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setTimeout(this.opts.timeoutMs);
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('timeout', () => this.fail(new Error('SMTP timeout')));
    socket.on('error', (err) => this.fail(err));
  }

  private fail(err: Error): void {
    this.pending?.reject(err);
    this.pending = null;
    this.socket?.destroy();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // A reply ends with `NNN <space>` on the final line.
    const match = /^(\d{3}) [^\n]*\r?\n$/m.exec(
      this.buffer.slice(this.buffer.lastIndexOf('\n', this.buffer.length - 2) + 1)
    );
    if (!match) return;
    const lines = this.buffer.trim().split(/\r?\n/);
    this.buffer = '';
    const reply = { code: Number(match[1]), lines };
    const pending = this.pending;
    this.pending = null;
    pending?.resolve(reply);
  }

  private read(): Promise<{ code: number; lines: string[] }> {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  private async send(
    command: string,
    expect = [250]
  ): Promise<{ code: number; lines: string[] }> {
    const reader = this.read();
    this.socket!.write(command + '\r\n');
    const reply = await reader;
    if (expect.length && !expect.includes(reply.code)) {
      throw new Error(`SMTP ${command.split(' ')[0]} failed: ${reply.lines.join(' ')}`);
    }
    return reply;
  }

  async deliver(from: string, to: string, message: string): Promise<void> {
    const { host, port, secure, user, pass } = this.opts;

    const socket = secure
      ? tlsConnect({ host, port, servername: host })
      : netConnect({ host, port });
    const connected = new Promise<void>((resolve, reject) => {
      socket.once(secure ? 'secureConnect' : 'connect', () => resolve());
      socket.once('error', reject);
    });
    this.attach(socket);
    await connected;

    const greeting = this.read();
    this.socket!.write('');
    await greeting.catch(() => undefined);

    const hostname = 'avail-deploy.local';
    let ehlo = await this.send(`EHLO ${hostname}`, [250]);

    if (!secure && ehlo.lines.some((l) => /STARTTLS/i.test(l))) {
      await this.send('STARTTLS', [220]);
      const upgraded = tlsConnect({ socket: socket as Socket, servername: host });
      await new Promise<void>((resolve, reject) => {
        upgraded.once('secureConnect', () => resolve());
        upgraded.once('error', reject);
      });
      this.buffer = '';
      this.attach(upgraded);
      ehlo = await this.send(`EHLO ${hostname}`, [250]);
    }

    if (user && pass) {
      const payload = Buffer.from(`\0${user}\0${pass}`).toString('base64');
      await this.send(`AUTH PLAIN ${payload}`, [235]);
    }

    await this.send(`MAIL FROM:<${from}>`, [250]);
    await this.send(`RCPT TO:<${to}>`, [250, 251]);
    await this.send('DATA', [354]);
    const body = message.replace(/\n\./g, '\n..');
    await this.send(`${body}\r\n.`, [250]);
    await this.send('QUIT', [221, 250]).catch(() => undefined);
    this.socket?.end();
  }
}

function parseAddress(value: string): { name: string | null; email: string } {
  const match = /^(.*)<([^>]+)>\s*$/.exec(value.trim());
  if (match) return { name: match[1].trim().replace(/^"|"$/g, ''), email: match[2] };
  return { name: null, email: value.trim() };
}

function buildMessage(mail: Mail): string {
  const from = config.mailFrom;
  const boundary = `avail_${Date.now().toString(36)}`;
  const headers = [
    `From: ${from}`,
    `To: ${mail.to}`,
    `Subject: ${mail.subject}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
  ];

  if (!mail.html) {
    headers.push('Content-Type: text/plain; charset=utf-8');
    return `${headers.join('\r\n')}\r\n\r\n${mail.text.replace(/\n/g, '\r\n')}`;
  }

  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    mail.text,
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    mail.html,
    `--${boundary}--`,
    '',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
}

/**
 * Sends `mail`. Without `SMTP_URL` configured the message is logged instead,
 * which is the expected mode for local and air-gapped installs.
 */
export async function sendMail(mail: Mail): Promise<{ delivered: boolean }> {
  if (!config.smtpUrl) {
    log.info(`[mail:console] to=${mail.to} subject=${mail.subject}`);
    log.info(mail.text.split('\n').map((l) => `  ${l}`).join('\n'));
    return { delivered: false };
  }

  const url = new URL(config.smtpUrl);
  const secure = url.protocol === 'smtps:' || url.port === '465';
  const client = new SmtpClient({
    host: url.hostname,
    port: Number(url.port) || (secure ? 465 : 587),
    secure,
    user: url.username ? decodeURIComponent(url.username) : undefined,
    pass: url.password ? decodeURIComponent(url.password) : undefined,
    timeoutMs: 20_000,
  });

  await client.deliver(
    parseAddress(config.mailFrom).email,
    mail.to,
    buildMessage(mail)
  );
  log.info(`Sent "${mail.subject}" to ${mail.to}`);
  return { delivered: true };
}

export function loginCodeMail(email: string, code: string): Mail {
  const minutes = Math.round(config.loginCodeTtlMs / 60000);
  return {
    to: email,
    subject: `${code} is your Avail Deploy sign-in code`,
    text: [
      `Your Avail Deploy sign-in code is: ${code}`,
      '',
      `It expires in ${minutes} minutes.`,
      'If you did not request this, you can ignore this email.',
    ].join('\n'),
    html: `<div style="font-family:system-ui,sans-serif;max-width:480px">
  <h2 style="margin:0 0 16px">Sign in to Avail Deploy</h2>
  <p style="color:#555">Use this code to finish signing in:</p>
  <p style="font-size:34px;letter-spacing:8px;font-weight:700;margin:24px 0">${code}</p>
  <p style="color:#888;font-size:13px">Expires in ${minutes} minutes.</p>
</div>`,
  };
}
