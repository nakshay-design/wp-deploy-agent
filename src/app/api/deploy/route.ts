import { createHash, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NextResponse } from 'next/server';
import AdmZip from 'adm-zip';
import { deploySite } from '@/core/deployer';
import type { SiteConfig } from '@/core/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request): Promise<NextResponse> {
  const expectedToken = process.env.DEPLOY_ACCESS_TOKEN;
  if (!expectedToken) {
    return NextResponse.json(
      { ok: false, error: 'Server is missing DEPLOY_ACCESS_TOKEN - refusing to deploy.' },
      { status: 500 },
    );
  }

  let tempDir: string | null = null;

  try {
    const form = await request.formData();

    const suppliedToken = String(form.get('accessToken') ?? '');
    if (!safeEqual(suppliedToken, expectedToken)) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    const rawConfig = form.get('config');
    if (typeof rawConfig !== 'string' || !rawConfig.trim()) {
      return NextResponse.json({ ok: false, error: 'missing config' }, { status: 400 });
    }

    const config = JSON.parse(rawConfig) as SiteConfig;

    const zip = form.get('theme');
    if (zip && typeof zip !== 'string') {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpdeploy-'));
      const buffer = Buffer.from(await zip.arrayBuffer());
      new AdmZip(buffer).extractAllTo(tempDir, true);
      config.theme = config.theme ?? { slug: 'theme', localDir: '' };
      config.theme.localDir = findThemeRoot(tempDir);
      config.skipThemeUpload = false;
    } else {
      // No archive supplied - only activate the theme already on the server.
      config.skipThemeUpload = true;
    }

    const result = await deploySite(config);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  } finally {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

/** Most theme zips wrap everything in a single top-level folder. Drill into it. */
function findThemeRoot(dir: string): string {
  let current = dir;
  for (let depth = 0; depth < 3; depth += 1) {
    if (fs.existsSync(path.join(current, 'style.css'))) return current;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory());
    if (dirs.length !== 1 || entries.length !== 1) return current;
    current = path.join(current, dirs[0].name);
  }
  return current;
}

function safeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}
