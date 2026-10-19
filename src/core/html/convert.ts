import * as fs from 'node:fs';
import * as path from 'node:path';
import { copyAssets, extractArchive } from './archive';
import { analyzeHtml } from './analyze';
import { writeTheme } from './theme';
import type { ConvertedSite } from './types';

export interface SeedPayload {
  page: { title: string; slug: string };
  /** One entry per section row: `acf_fc_layout` plus extracted field values. */
  sections: Array<Record<string, unknown>>;
}

export interface ConvertResult {
  slug: string;
  title: string;
  site: ConvertedSite;
  /** Directory containing the generated theme. */
  themeDir: string;
  /** Payload the setup script uses to seed the front page. */
  seed: SeedPayload;
}

export interface HtmlConvertOptions {
  /** Path to the uploaded HTML site zip. */
  zipPath: string;
  /** Theme slug to generate. Defaults to a slug derived from the document title. */
  slug?: string;
  /** Directory the generated theme is written to. */
  outDir: string;
  /** Scratch directory for the extracted archive. */
  workDir: string;
}

/**
 * Full pipeline: unzip an HTML site, split it into ACF layouts, write a WordPress
 * theme, copy its assets, and return a seed payload for the deployer.
 */
export function convertHtmlZip(options: HtmlConvertOptions): ConvertResult {
  const archive = extractArchive(options.zipPath, path.join(options.workDir, 'html'));

  const assetMap = new Map<string, string>();
  for (const rel of archive.assets) {
    assetMap.set(rel, `assets/${rel.replace(/^assets\//i, '')}`.replace(/\\/g, '/'));
  }

  const entryPath = path.join(archive.rootDir, archive.entryHtml);
  const html = fs.readFileSync(entryPath, 'utf8');
  const dir = path.posix.dirname(archive.entryHtml);

  const site = analyzeHtml({
    html,
    htmlDir: dir === '.' ? '' : dir,
    assetMap,
  });

  if (options.slug) site.slug = options.slug;

  fs.mkdirSync(options.outDir, { recursive: true });
  writeTheme(site, options.outDir);
  copyAssets(archive, options.outDir);

  const seed: SeedPayload = {
    page: { title: site.title, slug: site.slug },
    sections: site.sections.map((section) => ({
      acf_fc_layout: section.layout,
      ...section.values,
    })),
  };

  return { slug: site.slug, title: site.title, site, themeDir: options.outDir, seed };
}
