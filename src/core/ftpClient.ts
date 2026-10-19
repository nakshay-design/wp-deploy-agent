import { Client } from 'basic-ftp';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';

export interface FtpOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean;
  rejectUnauthorized: boolean;
}

/** Fail fast instead of hanging on an unreachable host. */
const SOCKET_TIMEOUT_MS = 60_000;

export class FtpClient {
  private readonly client = new Client(SOCKET_TIMEOUT_MS);

  constructor(private readonly opts: FtpOptions) {}

  async connect(): Promise<void> {
    const accessOptions = {
      host: this.opts.host,
      port: this.opts.port,
      user: this.opts.user,
      password: this.opts.password,
      secure: this.opts.secure,
      secureOptions: {
        rejectUnauthorized: this.opts.rejectUnauthorized,
        checkServerIdentity: this.opts.rejectUnauthorized ? undefined : () => undefined,
      },
    } as const;

    try {
      await this.client.access(accessOptions);
    } catch (error) {
      if (!this.opts.secure || this.opts.rejectUnauthorized || !isTlsCertificateError(error)) {
        throw error;
      }

      // Some hosts still fail the FTPS handshake with a self-signed certificate even when
      // rejectUnauthorized is false. Retry once with Node's global TLS check disabled.
      const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      try {
        await this.client.access(accessOptions);
      } finally {
        if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
      }
    }
    // Many shared hosts drop the connection mid-transfer without this.
    this.client.ftp.socket.setKeepAlive(true);
  }

  close(): void {
    this.client.close();
  }

  /** Upload a whole folder tree, creating remote directories as needed. Returns file count. */
  async uploadDir(localDir: string, remoteDir: string, exclude: string[] = []): Promise<number> {
    return this.uploadRecursive(localDir, remoteDir, exclude);
  }

  private async uploadRecursive(
    localDir: string,
    remoteDir: string,
    exclude: string[],
  ): Promise<number> {
    await this.client.ensureDir(remoteDir);
    const base = remoteDir.replace(/\/+$/, '');
    let count = 0;

    for (const entry of fs.readdirSync(localDir, { withFileTypes: true })) {
      if (exclude.includes(entry.name)) continue;
      const localPath = path.join(localDir, entry.name);
      const remotePath = `${base}/${entry.name}`;

      if (entry.isDirectory()) {
        count += await this.uploadRecursive(localPath, remotePath, exclude);
      } else if (entry.isFile()) {
        await this.client.uploadFrom(localPath, remotePath);
        count += 1;
      }
    }
    return count;
  }

  /** Upload a string as a remote file (used for PHP + .htaccess). */
  async uploadText(content: string, remotePath: string): Promise<void> {
    await this.client.uploadFrom(Readable.from([content]), remotePath);
  }

  async downloadText(remotePath: string): Promise<string> {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    await this.client.downloadTo(sink, remotePath);
    return Buffer.concat(chunks).toString('utf8');
  }

  async exists(remotePath: string): Promise<boolean> {
    try {
      await this.client.size(remotePath);
      return true;
    } catch {
      return false;
    }
  }

  /** Best-effort delete; never throws. */
  async removeQuietly(remotePath: string): Promise<boolean> {
    try {
      await this.client.remove(remotePath);
      return true;
    } catch {
      return false;
    }
  }
}

export function joinRemote(...parts: string[]): string {
  const joined = parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, '')))
    .filter(Boolean)
    .join('/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

function isTlsCertificateError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /self[- ]signed|unable to verify|certificate/i.test(message);
}
