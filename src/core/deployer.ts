import { FtpClient, joinRemote } from './ftpClient';
import { buildSetupScript, randomToken, WORDPRESS_HTACCESS } from './php';
import { httpGet, truncate } from './http';
import type { DeployResult, DeployStep, SiteConfig } from './types';

export interface DeployOptions {
  onLog?: (message: string) => void;
}

/**
 * Deploys a WordPress theme + site settings to a live host and verifies the result.
 * The flow is designed to be crash-safe: the temporary PHP script is removed in a
 * `finally` block even if a later step throws.
 */
export async function deploySite(
  config: SiteConfig,
  options: DeployOptions = {},
): Promise<DeployResult> {
  const steps: DeployStep[] = [];
  const log: string[] = [];
  const say = (message: string) => {
    log.push(message);
    options.onLog?.(message);
  };
  const record = (step: string, ok: boolean, detail?: string, critical = false) => {
    steps.push({ step, ok, detail, critical });
  };

  const password = resolvePassword(config);
  const port = config.port ?? 21;
  const secure = config.secure ?? true;
  const rejectUnauthorized = config.rejectUnauthorized ?? false;

  const ftp = new FtpClient({
    host: config.host,
    port,
    user: config.user,
    password,
    secure,
    rejectUnauthorized,
  });

  let setupRemotePath: string | null = null;

  try {
    /* 1. Connect ---------------------------------------------------------- */
    const scheme = config.protocol ?? (secure ? 'ftps' : 'ftp');
    say(`Connecting to ${scheme}://${config.host}:${port} as ${config.user} ...`);
    await ftp.connect();
    record('connect', true, `${scheme}://${config.host}:${port}`, true);
    say('Connected.');

    /* 2. Back up wp-config.php ------------------------------------------- */
    try {
      const backup = await ftp.downloadText(joinRemote(config.remoteWebRoot, 'wp-config.php'));
      record('backup wp-config.php', true, `${backup.length} bytes cached in memory`);
      say(`Backed up wp-config.php (${backup.length} bytes) into memory.`);
    } catch (error) {
      record('backup wp-config.php', false, `not downloaded: ${describe(error)}`);
      say('Could not back up wp-config.php (continuing).');
    }

    /* 3. Upload the theme ------------------------------------------------- */
    if (!config.skipThemeUpload && config.theme?.localDir) {
      const remoteThemeDir = joinRemote(
        config.remoteWebRoot,
        `wp-content/themes/${config.theme.slug}`,
      );
      say(`Uploading theme "${config.theme.slug}" -> ${remoteThemeDir}`);
      const uploaded = await ftp.uploadDir(
        config.theme.localDir,
        remoteThemeDir,
        config.theme.exclude ?? [],
      );
      record('upload theme', true, `${uploaded} files`, true);
      say(`Uploaded ${uploaded} theme files.`);
    } else {
      record('upload theme', true, 'skipped (settings-only mode)');
      say('Theme upload skipped - running in settings-only mode.');
    }

    /* 4. Drop + run the one-time setup script ----------------------------- */
    const token = randomToken(16);
    const scriptName = `wpdeploy-${token}.php`;
    setupRemotePath = joinRemote(config.remoteWebRoot, scriptName);

    const script = buildSetupScript({
      token,
      themeSlug: config.theme?.slug,
      settings: config.settings,
      admin: config.admin,
      seed: config.seed,
    });
    await ftp.uploadText(script, setupRemotePath);
    say(`Uploaded one-time setup script ${scriptName}.`);

    const setupUrl = `${trimTrailingSlash(config.siteUrl)}/${scriptName}?k=${encodeURIComponent(token)}`;
    const setupResponse = await httpGet(setupUrl, { rejectUnauthorized });
    const activated = setupResponse.status === 200 && /"ok"\s*:\s*true/.test(setupResponse.body);
    record(
      'activate theme & apply settings',
      activated,
      `HTTP ${setupResponse.status}; ${truncate(setupResponse.body, 400)}`,
      true,
    );
    say(`Setup script responded HTTP ${setupResponse.status}: ${truncate(setupResponse.body)}`);

    /* 5. Delete the setup script ------------------------------------------ */
    const deleted = await ftp.removeQuietly(setupRemotePath);
    let scriptGone = false;
    try {
      const after = await httpGet(setupUrl, { rejectUnauthorized });
      scriptGone = after.status === 404;
    } catch {
      scriptGone = false;
    }
    if (scriptGone) setupRemotePath = null;
    record(
      'delete setup script',
      scriptGone,
      `ftp-delete=${deleted ? 'ok' : 'failed'}; http-after=${scriptGone ? 404 : 'still reachable'}`,
      true,
    );
    say(scriptGone ? 'Setup script removed (now HTTP 404).' : 'WARNING: setup script may still be reachable.');

    /* 6. .htaccess -------------------------------------------------------- */
    if (config.htaccess) {
      const htaccessPath = joinRemote(config.remoteWebRoot, '.htaccess');
      const existing = await ftp.exists(htaccessPath);
      if (existing) {
        record('create .htaccess', true, 'already present - left untouched');
      } else {
        await ftp.uploadText(WORDPRESS_HTACCESS, htaccessPath);
        record('create .htaccess', true, 'WordPress rewrite rules written');
        say('Created .htaccess with WordPress rewrite rules.');
      }
    }

    /* 7. Verify ------------------------------------------------------------ */
    if (config.verify) {
      const expectStatus = config.verify.expectStatus ?? 200;
      const response = await httpGet(config.siteUrl, { rejectUnauthorized });
      const contains = config.verify.contains
        ? response.body.includes(config.verify.contains)
        : true;
      const passed = response.status === expectStatus && contains;
      record(
        'verify',
        passed,
        `HTTP ${response.status} (expected ${expectStatus}); contains "${config.verify.contains ?? ''}" = ${contains}`,
        true,
      );
      say(`Verify: HTTP ${response.status}; expected marker present = ${contains}`);
    }
  } catch (error) {
    record('deploy', false, describe(error), true);
    say(`ERROR: ${describe(error)}`);
  } finally {
    if (setupRemotePath) {
      const cleaned = await ftp.removeQuietly(setupRemotePath);
      say(cleaned ? 'Cleanup: removed leftover setup script.' : 'Cleanup: setup script could not be removed.');
    }
    ftp.close();
  }

  const ok = steps.filter((step) => step.critical).every((step) => step.ok);
  return { ok, site: config.name ?? config.siteUrl, steps, log };
}

/** Lightweight reachability check without a full deployment. */
export async function verifySite(config: SiteConfig): Promise<DeployResult> {
  const log: string[] = [];
  const steps: DeployStep[] = [];
  const rejectUnauthorized = config.rejectUnauthorized ?? false;
  const expectStatus = config.verify?.expectStatus ?? 200;

  try {
    const response = await httpGet(config.siteUrl, { rejectUnauthorized });
    const contains = config.verify?.contains
      ? response.body.includes(config.verify.contains)
      : true;
    const passed = response.status === expectStatus && contains;
    steps.push({
      step: 'verify',
      ok: passed,
      critical: true,
      detail: `HTTP ${response.status} (expected ${expectStatus}); contains marker = ${contains}`,
    });
    log.push(`GET ${config.siteUrl} -> HTTP ${response.status}`);
  } catch (error) {
    steps.push({ step: 'verify', ok: false, critical: true, detail: describe(error) });
    log.push(`ERROR: ${describe(error)}`);
  }

  return {
    ok: steps.every((step) => step.ok),
    site: config.name ?? config.siteUrl,
    steps,
    log,
  };
}

function resolvePassword(config: SiteConfig): string {
  const value = config.password ?? (config.passwordEnv ? process.env[config.passwordEnv] : undefined);
  if (!value) {
    throw new Error(
      `No FTP password. Set it inline or export the environment variable "${config.passwordEnv ?? 'FTP_PASS'}".`,
    );
  }
  return value;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
