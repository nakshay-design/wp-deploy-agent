export type Protocol = 'ftps' | 'ftp';

export interface ThemeConfig {
  /** Remote folder name under wp-content/themes, e.g. "ladies-mile". */
  slug: string;
  /** Absolute path to the local theme folder. Empty when settings-only mode. */
  localDir: string;
  /** File/folder names to skip during upload. */
  exclude?: string[];
}

export interface SettingsConfig {
  blogname?: string;
  blogdescription?: string;
  permalink_structure?: string;
  blog_public?: number;
  users_can_register?: number;
  WPLANG?: string;
}

export interface AdminConfig {
  login: string;
  password: string;
  email?: string;
}

/** Content imported from a source HTML page, seeded into the front page. */
export interface SeedConfig {
  page: { title: string; slug: string };
  /** One entry per flexible-content row: `acf_fc_layout` plus field values. */
  sections: Array<Record<string, unknown>>;
}

export interface VerifyConfig {
  /** Expected HTTP status of siteUrl. Defaults to 200. */
  expectStatus?: number;
  /** Substring that must appear in the rendered page. */
  contains?: string;
}

export interface SiteConfig {
  name: string;
  protocol?: Protocol;
  host: string;
  port?: number;
  user: string;
  /** Inline password - prefer passwordEnv so secrets stay out of config files. */
  password?: string;
  /** Name of the environment variable holding the password. */
  passwordEnv?: string;
  /** Explicit FTPS (AUTH TLS). Defaults to true. */
  secure?: boolean;
  /** Allow self-signed / mismatched TLS certificates. Defaults to false. */
  rejectUnauthorized?: boolean;
  /** Remote web root, e.g. "/public_html". */
  remoteWebRoot: string;
  /** Public site URL used to trigger the setup script and verify. */
  siteUrl: string;
  theme: ThemeConfig;
  settings?: SettingsConfig;
  admin?: AdminConfig;
  /** Populates the front page from converted HTML content. */
  seed?: SeedConfig;
  /** Write the standard WordPress rewrite block if .htaccess is missing. */
  htaccess?: boolean;
  verify?: VerifyConfig;
  /** Set automatically by the web API when no zip/theme folder is supplied. */
  skipThemeUpload?: boolean;
}

export interface DeployStep {
  step: string;
  ok: boolean;
  /** A failed critical step means the deployment did not complete. */
  critical?: boolean;
  detail?: string;
}

export interface DeployResult {
  ok: boolean;
  site: string;
  steps: DeployStep[];
  log: string[];
  /** Present when the deploy ran in HTML-conversion mode. */
  conversion?: { slug: string; title: string; sections: number };
}
