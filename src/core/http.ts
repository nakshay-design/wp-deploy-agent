import https from 'node:https';
import http from 'node:http';

export interface HttpGetOptions {
  /** Allow self-signed / mismatched certificates. */
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Minimal GET helper. Uses the low-level https module so we can opt out of
 * certificate verification for hosts that only have a self-signed cert.
 */
export function httpGet(url: string, options: HttpGetOptions = {}): Promise<HttpResponse> {
  const { rejectUnauthorized = false, timeoutMs = 30_000, headers = {} } = options;
  const target = new URL(url);
  const transport = target.protocol === 'http:' ? http : https;

  return new Promise((resolve, reject) => {
    const req = transport.get(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: `${target.pathname}${target.search}`,
        rejectUnauthorized,
        timeout: timeoutMs,
        headers: { 'User-Agent': 'wp-deploy-agent/1.0', ...headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
        );
      },
    );

    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
  });
}

export function truncate(text: string, max = 600): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}
