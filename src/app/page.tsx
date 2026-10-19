'use client';

import { useState, type FormEvent } from 'react';

interface DeployStep {
  step: string;
  ok: boolean;
  critical?: boolean;
  detail?: string;
}

interface DeployResult {
  ok: boolean;
  site: string;
  steps: DeployStep[];
  log: string[];
  conversion?: { slug: string; title: string; sections: number };
}

export default function Home() {
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'html' | 'theme'>('html');
  const [result, setResult] = useState<DeployResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);

    setBusy(true);
    setError(null);
    setResult(null);

    const themeSlug = String(data.get('themeSlug') ?? '');
    const adminLogin = String(data.get('adminLogin') ?? '').trim();

    const config = {
      name: String(data.get('name') ?? ''),
      protocol: String(data.get('protocol') ?? 'ftps'),
      host: String(data.get('host') ?? ''),
      port: Number(data.get('port') || 21),
      user: String(data.get('user') ?? ''),
      password: String(data.get('password') ?? ''),
      secure: String(data.get('protocol')) === 'ftps',
      rejectUnauthorized: data.get('allowSelfSigned') === 'on',
      remoteWebRoot: String(data.get('remoteWebRoot') ?? '/public_html'),
      siteUrl: String(data.get('siteUrl') ?? ''),
      theme: {
        slug: themeSlug,
        localDir: '',
        exclude: ['README.txt', 'README.md', '.DS_Store', '.git', 'node_modules'],
      },
      settings: {
        blogname: String(data.get('blogname') ?? ''),
        permalink_structure: String(data.get('permalink') ?? '/%postname%/'),
        blog_public: 1,
      },
      admin: adminLogin
        ? {
            login: adminLogin,
            password: String(data.get('adminPassword') ?? ''),
            email: String(data.get('adminEmail') ?? ''),
          }
        : undefined,
      htaccess: data.get('htaccess') === 'on',
      verify: {
        expectStatus: Number(data.get('expectStatus') || 200),
        contains: String(data.get('contains') ?? '') || undefined,
      },
    };

    const body = new FormData();
    body.set('accessToken', String(data.get('accessToken') ?? ''));
    body.set('config', JSON.stringify(config));
    if (mode === 'html') {
      const html = data.get('htmlZip');
      if (html instanceof File && html.size > 0) body.set('html', html);
    } else {
      const zip = data.get('themeZip');
      if (zip instanceof File && zip.size > 0) body.set('theme', zip);
    }

    try {
      const response = await fetch('/api/deploy', { method: 'POST', body });
      const payload = await response.json();
      if (!response.ok) setError(payload.error ?? `HTTP ${response.status}`);
      else setResult(payload as DeployResult);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wrap">
      <h1>WP Deploy Agent</h1>
      <p className="sub">
        Upload an HTML site ZIP to convert it into a WordPress + ACF Flexible Content theme, or
        upload a ready-made theme. The theme is activated, site settings applied and the live page
        verified - over FTPS/FTP.
      </p>

      <form onSubmit={handleSubmit}>
        <fieldset>
          <legend>Access</legend>
          <div className="grid">
            <label>
              Access token
              <input name="accessToken" type="password" required placeholder="DEPLOY_ACCESS_TOKEN" />
            </label>
            <label>
              Site label
              <input name="name" placeholder="ladies-mile" />
            </label>
            <label>
              Protocol
              <select name="protocol" defaultValue="ftps">
                <option value="ftps">FTPS (explicit TLS)</option>
                <option value="ftp">FTP (plain)</option>
              </select>
            </label>
            <label>
              Allow self-signed certificate
              <select name="allowSelfSigned" defaultValue="on">
                <option value="on">Yes</option>
                <option value="off">No</option>
              </select>
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Server</legend>
          <div className="grid">
            <label>
              FTP host
              <input name="host" required placeholder="103.96.117.73" />
            </label>
            <label>
              Port
              <input name="port" type="number" defaultValue={21} />
            </label>
            <label>
              FTP username
              <input name="user" required placeholder="user@example.com" />
            </label>
            <label>
              FTP password
              <input name="password" type="password" required />
            </label>
            <label>
              Remote web root
              <input name="remoteWebRoot" defaultValue="/public_html" required />
            </label>
            <label>
              Site URL
              <input name="siteUrl" required placeholder="https://example.com" />
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Source</legend>
          <div className="grid">
            <label>
              Input type
              <select
                name="mode"
                value={mode}
                onChange={(event) => setMode(event.target.value as 'html' | 'theme')}
              >
                <option value="html">HTML site ZIP (convert to WordPress + ACF)</option>
                <option value="theme">WordPress theme ZIP (deploy as-is)</option>
              </select>
            </label>
            <label>
              Theme slug (remote folder){mode === 'html' ? ' - optional, derived from the title' : ''}
              <input name="themeSlug" required={mode === 'theme'} placeholder="my-site" />
            </label>
            {mode === 'html' ? (
              <label>
                HTML site ZIP
                <input name="htmlZip" type="file" accept=".zip" required />
              </label>
            ) : (
              <label>
                Theme ZIP (optional)
                <input name="themeZip" type="file" accept=".zip" />
              </label>
            )}
          </div>
          <p className="detail" style={{ marginTop: 10 }}>
            {mode === 'html'
              ? 'The ZIP is split into ACF Flexible Content sections, packaged as a theme, uploaded, activated and seeded with your real text and images. Advanced Custom Fields (Free or Pro) must already be installed on the site.'
              : 'Upload a ready-made WordPress theme. Leave the file empty to only activate a theme that is already on the server.'}
          </p>
        </fieldset>

        <fieldset>
          <legend>WordPress settings</legend>
          <div className="grid">
            <label>
              Site title
              <input name="blogname" placeholder="Ladies Mile" />
            </label>
            <label>
              Permalink structure
              <input name="permalink" defaultValue="/%postname%/" />
            </label>
            <label>
              New admin login (optional)
              <input name="adminLogin" placeholder="ladiesmileco" />
            </label>
            <label>
              New admin password
              <input name="adminPassword" type="password" />
            </label>
            <label>
              New admin email
              <input name="adminEmail" type="email" placeholder="admin@example.com" />
            </label>
          </div>
          <div className="row">
            <input id="htaccess" name="htaccess" type="checkbox" defaultChecked />
            <label htmlFor="htaccess" style={{ color: 'inherit' }}>
              Create .htaccess if missing
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Verification</legend>
          <div className="grid">
            <label>
              Expected HTTP status
              <input name="expectStatus" type="number" defaultValue={200} />
            </label>
            <label>
              Page must contain
              <input name="contains" placeholder="miles ahead" />
            </label>
          </div>
        </fieldset>

        <button type="submit" disabled={busy}>
          {busy ? 'Deploying...' : 'Deploy'}
        </button>
      </form>

      {error && (
        <div className="banner fail">
          <strong>Error:</strong> {error}
        </div>
      )}

      {result && (
        <div className={`banner ${result.ok ? 'ok' : 'fail'}`}>
          <strong>
            {result.ok ? 'Deployment succeeded' : 'Deployment failed'} - {result.site}
          </strong>
          {result.conversion ? (
            <p className="detail" style={{ marginTop: 4 }}>
              Converted &quot;{result.conversion.title}&quot; ({result.conversion.slug}) into{' '}
              {result.conversion.sections} section{result.conversion.sections === 1 ? '' : 's'}.
            </p>
          ) : null}
          <ul className="steps">
            {result.steps.map((step, index) => (
              <li key={index}>
                <span className={`badge ${step.ok ? 'ok' : 'fail'}`}>
                  {step.ok ? 'PASS' : 'FAIL'}
                </span>
                <strong>{step.step}</strong>
                {step.detail ? <span className="detail"> - {step.detail}</span> : null}
              </li>
            ))}
          </ul>
          {result.log?.length ? (
            <>
              <p className="detail" style={{ marginBottom: 6 }}>
                Log
              </p>
              <pre className="log">{result.log.join('\n')}</pre>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
