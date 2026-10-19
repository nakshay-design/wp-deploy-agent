import AdmZip from 'adm-zip';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Extensions treated as copyable site assets. */
const ASSET_EXT = new Set([
  '.css',
  '.js',
  '.mjs',
  '.map',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.svg',
  '.ico',
  '.bmp',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp4',
  '.webm',
  '.pdf',
  '.json',
  '.txt',
]);

export interface Archive {
  /** Root folder the archive was extracted into. */
  rootDir: string;
  /** Every file, as a path relative to rootDir (forward slashes). */
  files: string[];
  /** The HTML document to convert. */
  entryHtml: string;
  /** Files copied into the theme's assets folder. */
  assets: string[];
}

/**
 * Extracts an uploaded HTML site archive and locates its entry document.
 * Zip-slip safe: every entry must resolve inside `outDir`.
 */
export function extractArchive(zipPath: string, outDir: string): Archive {
  const zip = new AdmZip(zipPath);
  fs.mkdirSync(outDir, { recursive: true });
  const rootReal = fs.realpathSync(outDir);

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (isJunk(entry.entryName)) continue;
    const target = path.resolve(rootReal, entry.entryName.replace(/\\/g, '/'));
    if (target !== rootReal && !target.startsWith(rootReal + path.sep)) {
      throw new Error(`Refusing to extract outside the target folder: ${entry.entryName}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
  }

  const extracted = listFiles(rootReal);
  // Most zips wrap everything in a single folder; drop it so paths stay tidy.
  const wrapper = commonRoot(extracted);
  const rootDir = wrapper ? path.join(rootReal, wrapper) : rootReal;
  const files = wrapper ? extracted.map((f) => f.slice(wrapper.length + 1)) : extracted;

  const entryHtml = pickEntryHtml(files);
  if (!entryHtml) {
    throw new Error('No .html file found in the archive.');
  }

  return {
    rootDir,
    files,
    entryHtml,
    assets: files.filter((f) => ASSET_EXT.has(path.extname(f).toLowerCase()) && f !== entryHtml),
  };
}

/** Archiver metadata that should never be treated as site content. */
function isJunk(entryName: string): boolean {
  const parts = entryName.replace(/\\/g, '/').split('/');
  const base = parts[parts.length - 1];
  return parts[0] === '__MACOSX' || base === '.DS_Store' || base === 'Thumbs.db';
}

/** Returns the single shared top-level folder, or null when there isn't one. */
function commonRoot(files: string[]): string | null {
  if (files.length === 0) return null;
  const [first] = files[0].split('/');
  if (!files[0].includes('/') || !first) return null;
  for (const file of files) {
    if (!file.startsWith(`${first}/`)) return null;
  }
  return first;
}

/** Recursively lists files relative to `dir`, using forward slashes. */
export function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Chooses the entry document. Preference order: a top-level index.html / index.htm,
 * then any html closest to the archive root, then the largest html file.
 */
function pickEntryHtml(files: string[]): string | null {
  const htmlFiles = files.filter((f) => /\.html?$/i.test(f));
  if (htmlFiles.length === 0) return null;

  const depth = (f: string) => f.split('/').length;
  const indexLike = htmlFiles.filter((f) => /(^|\/)index\.html?$/i.test(f));

  return indexLike.sort((a, b) => depth(a) - depth(b))[0] ?? htmlFiles.sort((a, b) => depth(a) - depth(b))[0];
}

/** Copies the archive's assets into `<themeDir>/assets`, preserving structure. */
export function copyAssets(archive: Archive, themeDir: string): string[] {
  const copied: string[] = [];
  const assetsRoot = path.join(themeDir, 'assets');

  for (const rel of archive.assets) {
    if (rel === archive.entryHtml) continue;
    const from = path.join(archive.rootDir, rel);
    // Keep the archive's own folder shape, minus a leading "assets/" if present.
    const target = path.join(assetsRoot, rel.replace(/^assets\//i, ''));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(from, target);
    copied.push(`assets/${rel.replace(/^assets\//i, '')}`.replace(/\\/g, '/'));
  }

  return copied;
}
