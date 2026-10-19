import { parse, HTMLElement } from 'node-html-parser';
import type { ConvertedSection, ConvertedSite, FieldDef, LayoutType } from './types';

/** Elements that are never treated as content sections. */
const NON_CONTENT = new Set(['script', 'style', 'link', 'meta', 'noscript', 'template', 'helmet']);

/** Page chrome that never counts as a content section or a repeater item. */
const CHROME = new Set(['main', 'header', 'footer', 'nav']);

const IMAGE_FIELD = 'image';

interface Slot {
  start: number;
  end: number;
  php: string;
}

interface Context {
  source: string;
  htmlDir: string;
  assetMap: Map<string, string>;
}

export interface AnalyzeInput {
  html: string;
  /** Folder of the entry HTML inside the archive (forward slashes, '' for root). */
  htmlDir: string;
  /** theme-relative asset path (e.g. "assets/img/a.png") keyed by archive path. */
  assetMap: Map<string, string>;
}

/** Converts a static HTML document into a WordPress/ACF section model. */
export function analyzeHtml(input: AnalyzeInput): ConvertedSite {
  const { html, htmlDir, assetMap } = input;
  const source = unwrapBundledTemplate(html);
  const root = parse(source, { comment: false });
  const ctx: Context = { source, htmlDir, assetMap };

  const title = text(root.querySelector('title')) || text(root.querySelector('h1')) || 'Converted Site';
  const description =
    root.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ?? '';

  const headerEl = root.querySelector('header');
  const footerEl = root.querySelector('footer');
  const sectionEls = collectSectionElements(root, headerEl, footerEl);

  const sections: ConvertedSection[] = [];
  sectionEls.forEach((el, index) => {
    const section = analyzeSection(el, index, ctx);
    if (section) sections.push(section);
  });

  const stylesheets = collectLinkedAssets(root, 'link', assetMap, htmlDir);
  const scripts = collectLinkedAssets(root, 'script', assetMap, htmlDir);
  const inlineCss = root
    .querySelectorAll('style')
    .map((el) => el.innerHTML.trim())
    .filter(Boolean)
    .join('\n\n');

  const headerMarkup = headerEl
    ? rewriteAssetUrls(stripAssetTags(sourceSlice(source, headerEl)), assetMap, htmlDir)
    : '';
  const footerMarkup = footerEl
    ? rewriteAssetUrls(stripAssetTags(sourceSlice(source, footerEl)), assetMap, htmlDir)
    : '';

  return {
    slug: slugify(title),
    title: cleanTitle(title),
    description,
    sections,
    headerMarkup,
    footerMarkup,
    stylesheets,
    scripts,
    inlineCss,
    assets: [...assetMap.values()],
  };
}

/** Some exports wrap the actual page HTML in a JSON string inside a bundler script tag. */
function unwrapBundledTemplate(html: string): string {
  const root = parse(html, { comment: false });
  const template = root.querySelector('script[type="__bundler/template"]');
  if (!template) return html;

  const raw = template.innerHTML.trim();
  if (!raw) return html;

  try {
    const decoded = JSON.parse(raw);
    if (typeof decoded === 'string' && /<html[\s>]/i.test(decoded)) {
      return decoded;
    }
  } catch {
    // Fall back to the original source when the payload is not valid JSON.
  }

  return html;
}

/* ------------------------------------------------------------------ *
 * Section discovery
 * ------------------------------------------------------------------ */

function collectSectionElements(
  root: HTMLElement,
  headerEl: HTMLElement | null,
  footerEl: HTMLElement | null,
): HTMLElement[] {
  const body = root.querySelector('body') ?? root;

  const isContent = (el: HTMLElement) =>
    !NON_CONTENT.has(el.rawTagName.toLowerCase()) &&
    el !== headerEl &&
    el !== footerEl &&
    !isInside(el, headerEl) &&
    !isInside(el, footerEl);

  const topLevel = children(body).filter(isContent);
  if (topLevel.length >= 2) return topLevel;

  if (topLevel.length === 1) {
    const inner = children(topLevel[0]).filter(isContent);
    if (inner.length >= 2) return inner;
  }

  const meaningful = root.querySelectorAll('section,article').filter(isContent);
  return meaningful.length > 0 ? meaningful : topLevel;
}

function isInside(el: HTMLElement, ancestor: HTMLElement | null): boolean {
  if (!ancestor) return false;
  return el.range[0] >= ancestor.range[0] && el.range[1] <= ancestor.range[1];
}

/* ------------------------------------------------------------------ *
 * Section analysis
 * ------------------------------------------------------------------ */

function analyzeSection(el: HTMLElement, index: number, ctx: Context): ConvertedSection | null {
  const src = sourceSlice(ctx.source, el);
  if (!src.trim()) return null;

  const layout = classify(el, index);
  const slots: Slot[] = [];
  const fields: FieldDef[] = [];
  const values: Record<string, unknown> = {};

  BUILDERS[layout](el, ctx, slots, fields, values);

  const withSlots = applySlots(src, slots, el.range[0]);
  const template = rewriteAssetUrls(withSlots, ctx.assetMap, ctx.htmlDir);

  return {
    layout,
    label: LAYOUT_LABELS[layout],
    phpTemplate: renderPhp(fields, template),
    fields,
    values,
  };
}

function classify(el: HTMLElement, index: number): LayoutType {
  const signature = `${el.getAttribute('class') ?? ''} ${el.getAttribute('id') ?? ''}`.toLowerCase();

  if (el.querySelector('form')) return 'contact_form';
  if (el.querySelector('details') || /faq|accordion|questions/.test(signature)) return 'faq_accordion';
  if (/hero|banner|masthead|jumbotron/.test(signature)) return 'hero';
  if (index === 0 && (el.querySelector('h1') || el.querySelector('img'))) return 'hero';
  if (/call-to-action|\bcta\b|\bpromo\b/.test(signature)) return 'cta';

  const repeat = findRepeats(el, 'card');
  if (repeat) {
    const { items } = repeat;
    const allImages = items.every((i) => i.querySelector('img'));
    const allHeadings = items.every((i) => i.querySelector('h1,h2,h3,h4,h5,h6'));
    const numeric =
      items.filter((i) => /^\s*[^\d]{0,4}\d/.test(text(i))).length >= Math.ceil(items.length / 2);
    const teamish = /team|staff|people|member|person|advisor/.test(
      `${signature} ${classOf(items[0])}`,
    );

    if (numeric && !allImages) return 'stats_strip';
    if (allImages && teamish) return 'team';
    if (allImages && !allHeadings) return 'gallery';
    return 'cards';
  }

  if (findRepeats(el, 'digit')) return 'stats_strip';
  if (el.querySelectorAll('img').length >= 3) return 'gallery';
  return 'content_section';
}

/* ------------------------------------------------------------------ *
 * Per-layout builders
 * ------------------------------------------------------------------ */

type Builder = (
  el: HTMLElement,
  ctx: Context,
  slots: Slot[],
  fields: FieldDef[],
  values: Record<string, unknown>,
) => void;

const BUILDERS: Record<LayoutType, Builder> = {
  hero(el, ctx, slots, fields, values) {
    const headingEl = first(el, 'h1') ?? first(el, 'h2,h3');
    const textEl = firstParagraph(el);
    const ctaEl = findCta(el);
    const imageEl = first(el, 'img');
    const eyebrowEl = findEyebrow(el, headingEl);

    addText(slots, fields, values, ctx, eyebrowEl, 'eyebrow', 'Eyebrow', 'text');
    addText(slots, fields, values, ctx, headingEl, 'heading', 'Heading', 'heading');
    addText(slots, fields, values, ctx, textEl, 'text', 'Text', 'textarea');

    if (imageEl) {
      const asset = resolveAssetRef(imageEl.getAttribute('src'), ctx);
      if (asset) {
        fields.push({ name: 'bg_image', label: 'Background Image', type: 'image' });
        values.bg_image = asset;
        push(slots, attrSlot(ctx.source, imageEl, 'src', `<?php echo esc_url( $bg_image ); ?>`));
      }
    }
    addLink(slots, fields, values, ctx, ctaEl, 'cta', 'CTA Button');
  },

  content_section(el, ctx, slots, fields, values) {
    const headingEl = first(el, 'h1,h2,h3');
    const paragraphs = el.querySelectorAll('p').filter((p) => text(p).length > 0);
    const eyebrowEl = findEyebrow(el, headingEl);

    addText(slots, fields, values, ctx, eyebrowEl, 'eyebrow', 'Eyebrow', 'text');
    addText(slots, fields, values, ctx, headingEl, 'heading', 'Heading', 'heading');

    if (paragraphs.length > 0) {
      fields.push({ name: 'body', label: 'Body', type: 'wysiwyg' });
      values.body = paragraphs.map((p) => text(p)).join('\n\n');
      const target = paragraphs[0];
      const container = target.parentNode instanceof HTMLElement ? target.parentNode : el;
      push(slots, innerSlot(ctx.source, container, `<?php echo wp_kses_post( $body ); ?>`));
    }
  },

  cards(el, ctx, slots, fields, values) {
    addHeadingBlock(el, ctx, slots, fields, values);
    const repeat = findRepeats(el, 'card');
    if (!repeat) return;

    fields.push({
      name: 'items',
      label: 'Cards',
      type: 'repeater',
      subFields: [
        { name: 'image', label: 'Image', type: 'image' },
        { name: 'title', label: 'Title', type: 'text' },
        { name: 'text', label: 'Text', type: 'textarea' },
        { name: 'link', label: 'Link', type: 'link' },
      ],
    });

    const { slots: repeatSlots, items } = buildRepeater(repeat, ctx, 'items', 'item', {
      image: (item, c) => {
        const img = first(item, 'img');
        return img ? attrSlot(c.source, img, 'src', `<?php echo esc_url( html2wp_image( $item['image'] ) ); ?>`) : null;
      },
      title: (item, c) => {
        const h = first(item, 'h1,h2,h3,h4,h5,h6');
        return h ? innerSlot(c.source, h, `<?php echo esc_html( $item['title'] ); ?>`) : null;
      },
      text: (item, c) => {
        const p = first(item, 'p');
        return p ? innerSlot(c.source, p, `<?php echo esc_html( $item['text'] ); ?>`) : null;
      },
      link: (item, c) => {
        const a = first(item, 'a');
        return a ? attrSlot(c.source, a, 'href', `<?php echo esc_url( $item['link']['url'] ); ?>`) : null;
      },
    });

    values.items = items;
    slots.push(...repeatSlots);
  },

  gallery(el, ctx, slots, fields, values) {
    addHeadingBlock(el, ctx, slots, fields, values);
    const repeat = findRepeats(el, 'card');
    // Repeat items may be whole cards around an image, or bare <img> elements.
    const items = repeat?.items ?? el.querySelectorAll('img');

    fields.push({ name: 'images', label: 'Images', type: 'gallery' });
    values.images = items
      .map((item) => resolveAssetRef(imageOf(item)?.getAttribute('src'), ctx))
      .filter((v): v is string => Boolean(v));

    if (items.length === 0) return;

    const firstItem = items[0];
    const lastItem = items[items.length - 1];
    const img = imageOf(firstItem);
    if (!img) return;

    const itemSlots: Slot[] = [];
    push(
      itemSlots,
      offsetSlot(
        attrSlot(ctx.source, img, 'src', `<?php echo esc_url( html2wp_image( $image ) ); ?>`),
        -firstItem.range[0],
      ),
    );
    const itemTemplate = applySlots(sourceSlice(ctx.source, firstItem), itemSlots, 0);
    slots.push({
      start: firstItem.range[0],
      end: lastItem.range[1],
      php: `<?php foreach ( $images as $image ) : ?>\n${itemTemplate}\n<?php endforeach; ?>`,
    });
  },

  faq_accordion(el, ctx, slots, fields, values) {
    addHeadingBlock(el, ctx, slots, fields, values);
    const details = el.querySelectorAll('details');

    fields.push({
      name: 'items',
      label: 'Questions',
      type: 'repeater',
      subFields: [
        { name: 'question', label: 'Question', type: 'text' },
        { name: 'answer', label: 'Answer', type: 'textarea' },
      ],
    });

    values.items = details.map((d) => {
      const summary = first(d, 'summary');
      const answerEl = children(d).find((c) => c !== summary) ?? null;
      return {
        question: summary ? text(summary) : text(d),
        answer: answerEl ? text(answerEl) : '',
      };
    });

    if (details.length > 0) {
      const firstItem = details[0];
      const lastItem = details[details.length - 1];
      const summary = first(firstItem, 'summary');
      const answerEl = children(firstItem).find((c) => c !== summary) ?? null;
      const itemSlots: Slot[] = [];
      if (summary) {
        push(
          itemSlots,
          offsetSlot(
            innerSlot(ctx.source, summary, `<?php echo esc_html( $item['question'] ); ?>`),
            -firstItem.range[0],
          ),
        );
      }
      if (answerEl) {
        push(
          itemSlots,
          offsetSlot(
            innerSlot(ctx.source, answerEl, `<?php echo esc_html( $item['answer'] ); ?>`),
            -firstItem.range[0],
          ),
        );
      }
      const itemTemplate = applySlots(sourceSlice(ctx.source, firstItem), itemSlots, 0);
      slots.push({
        start: firstItem.range[0],
        end: lastItem.range[1],
        php: `<?php foreach ( $items as $item ) : ?>\n${itemTemplate}\n<?php endforeach; ?>`,
      });
    }
  },

  cta(el, ctx, slots, fields, values) {
    const headingEl = first(el, 'h1,h2,h3');
    const textEl = firstParagraph(el);
    const ctaEl = findCta(el);

    addText(slots, fields, values, ctx, headingEl, 'heading', 'Heading', 'heading');
    addText(slots, fields, values, ctx, textEl, 'text', 'Text', 'textarea');
    addLink(slots, fields, values, ctx, ctaEl, 'cta', 'Button');
  },

  stats_strip(el, ctx, slots, fields, values) {
    addHeadingBlock(el, ctx, slots, fields, values);
    const repeat = findRepeats(el, 'digit') ?? findRepeats(el, 'card');

    fields.push({
      name: 'stats',
      label: 'Stats',
      type: 'repeater',
      subFields: [
        { name: 'number', label: 'Number', type: 'text' },
        { name: 'label', label: 'Label', type: 'text' },
      ],
    });

    if (!repeat || repeat.items.length === 0) return;

    const meta: Array<{ number: HTMLElement | null; label: HTMLElement | null }> = [];
    values.stats = repeat.items.map((item) => {
      const numberEl = findNumericElement(item);
      const labelEl = findLabelElement(item, numberEl);
      meta.push({ number: numberEl, label: labelEl });
      return { number: numberEl ? text(numberEl) : '', label: labelEl ? text(labelEl) : '' };
    });

    const firstItem = repeat.items[0];
    const lastItem = repeat.items[repeat.items.length - 1];
    const itemSlots: Slot[] = [];
    if (meta[0].number) {
      push(
        itemSlots,
        offsetSlot(
          innerSlot(ctx.source, meta[0].number, `<?php echo esc_html( $item['number'] ); ?>`),
          -firstItem.range[0],
        ),
      );
    }
    if (meta[0].label) {
      push(
        itemSlots,
        offsetSlot(
          innerSlot(ctx.source, meta[0].label, `<?php echo esc_html( $item['label'] ); ?>`),
          -firstItem.range[0],
        ),
      );
    }
    const itemTemplate = applySlots(sourceSlice(ctx.source, firstItem), itemSlots, 0);
    slots.push({
      start: firstItem.range[0],
      end: lastItem.range[1],
      php: `<?php foreach ( $stats as $item ) : ?>\n${itemTemplate}\n<?php endforeach; ?>`,
    });
  },

  team(el, ctx, slots, fields, values) {
    addHeadingBlock(el, ctx, slots, fields, values);
    const repeat = findRepeats(el, 'card');
    if (!repeat) return;

    fields.push({
      name: 'members',
      label: 'Team Members',
      type: 'repeater',
      subFields: [
        { name: 'image', label: 'Photo', type: 'image' },
        { name: 'name', label: 'Name', type: 'text' },
        { name: 'role', label: 'Role', type: 'text' },
      ],
    });

    const { slots: repeatSlots, items } = buildRepeater(repeat, ctx, 'members', 'member', {
      image: (item, c) => {
        const img = first(item, 'img');
        return img ? attrSlot(c.source, img, 'src', `<?php echo esc_url( html2wp_image( $member['image'] ) ); ?>`) : null;
      },
      name: (item, c) => {
        const h = first(item, 'h1,h2,h3,h4,h5,h6');
        return h ? innerSlot(c.source, h, `<?php echo esc_html( $member['name'] ); ?>`) : null;
      },
      role: (item, c) => {
        const p = first(item, 'p');
        return p ? innerSlot(c.source, p, `<?php echo esc_html( $member['role'] ); ?>`) : null;
      },
    });

    values.members = items;
    slots.push(...repeatSlots);
  },

  contact_form(el, ctx, slots, fields, values) {
    addHeadingBlock(el, ctx, slots, fields, values);
    fields.push({ name: 'note', label: 'Note', type: 'textarea' });
    values.note = '';
  },
};

/* ------------------------------------------------------------------ *
 * Shared field helpers
 * ------------------------------------------------------------------ */

function addText(
  slots: Slot[],
  fields: FieldDef[],
  values: Record<string, unknown>,
  ctx: Context,
  el: HTMLElement | null,
  name: string,
  label: string,
  kind: 'text' | 'textarea' | 'heading',
): void {
  if (!el) return;
  fields.push({ name, label, type: kind === 'textarea' ? 'textarea' : 'text' });
  values[name] = text(el);
  const php =
    kind === 'heading'
      ? `<?php echo nl2br( esc_html( $${name} ) ); ?>`
      : `<?php echo esc_html( $${name} ); ?>`;
  push(slots, innerSlot(ctx.source, el, php));
}

function addLink(
  slots: Slot[],
  fields: FieldDef[],
  values: Record<string, unknown>,
  ctx: Context,
  el: HTMLElement | null,
  name: string,
  label: string,
): void {
  if (!el) return;
  fields.push({ name, label, type: 'link' });
  values[name] = { url: el.getAttribute('href') ?? '', title: text(el) };
  push(slots, attrSlot(ctx.source, el, 'href', `<?php echo esc_url( $${name}_url ); ?>`));
  push(slots, innerSlot(ctx.source, el, `<?php echo esc_html( $${name}_title ); ?>`));
}

function addHeadingBlock(
  el: HTMLElement,
  ctx: Context,
  slots: Slot[],
  fields: FieldDef[],
  values: Record<string, unknown>,
): void {
  const headingEl = first(el, 'h1,h2,h3');
  const introEl = firstParagraph(el);
  const eyebrowEl = findEyebrow(el, headingEl);

  addText(slots, fields, values, ctx, eyebrowEl, 'eyebrow', 'Eyebrow', 'text');
  addText(slots, fields, values, ctx, headingEl, 'heading', 'Heading', 'heading');
  addText(slots, fields, values, ctx, introEl, 'intro', 'Intro', 'textarea');
}

/* ------------------------------------------------------------------ *
 * Repeaters
 * ------------------------------------------------------------------ */

type SlotFinder = (item: HTMLElement, ctx: Context) => Slot | null;

function buildRepeater(
  repeat: { container: HTMLElement; items: HTMLElement[] },
  ctx: Context,
  arrayName: string,
  loopVar: string,
  finders: Record<string, SlotFinder>,
): { slots: Slot[]; items: Array<Record<string, unknown>> } {
  const firstItem = repeat.items[0];
  const lastItem = repeat.items[repeat.items.length - 1];
  const itemSlots: Slot[] = [];
  const rows: Array<Record<string, unknown>> = [];

  for (const item of repeat.items) {
    const row: Record<string, unknown> = {};
    for (const [name, finder] of Object.entries(finders)) {
      const slot = offsetSlot(finder(item, ctx), -firstItem.range[0]);
      if (!slot) continue;
      push(itemSlots, slot);
      row[name] = valueFor(item, name, ctx);
    }
    rows.push(row);
  }

  const itemTemplate = applySlots(sourceSlice(ctx.source, firstItem), itemSlots, 0);
  const php = `<?php foreach ( $${arrayName} as $${loopVar} ) : ?>\n${itemTemplate}\n<?php endforeach; ?>`;

  return { slots: [{ start: firstItem.range[0], end: lastItem.range[1], php }], items: rows };
}

/** Plain value for a repeater sub-field, used when seeding the live site. */
function valueFor(item: HTMLElement, name: string, ctx: Context): unknown {
  switch (name) {
    case IMAGE_FIELD:
      return resolveAssetRef(first(item, 'img')?.getAttribute('src'), ctx) ?? '';
    case 'title':
    case 'name':
      return text(first(item, 'h1,h2,h3,h4,h5,h6'));
    case 'text':
    case 'role':
      return text(first(item, 'p'));
    case 'link':
      return { url: first(item, 'a')?.getAttribute('href') ?? '', title: '' };
    default:
      return '';
  }
}

/* ------------------------------------------------------------------ *
 * Element queries
 * ------------------------------------------------------------------ */

type RepeatMode = 'card' | 'digit';

function findRepeats(root: HTMLElement, mode: RepeatMode): { container: HTMLElement; items: HTMLElement[] } | null {
  const accept = mode === 'digit'
    ? (el: HTMLElement) => /\d/.test(text(el))
    : (el: HTMLElement) => isCardLike(el);

  let best: { container: HTMLElement; items: HTMLElement[] } | null = null;

  for (const node of [root, ...root.querySelectorAll('*')]) {
    if (CHROME.has(node.rawTagName.toLowerCase())) continue;
    const kids = children(node);
    if (kids.length < 2) continue;

    const groups = new Map<string, HTMLElement[]>();
    for (const child of kids) {
      if (CHROME.has(child.rawTagName.toLowerCase())) continue;
      if (!accept(child)) continue;
      const sig = `${child.rawTagName}|${classOf(child)}`;
      const bucket = groups.get(sig) ?? [];
      bucket.push(child);
      groups.set(sig, bucket);
    }

    for (const items of groups.values()) {
      if (items.length < 2) continue;
      if (items.length < kids.length - 1) continue;
      if (!best || items.length > best.items.length) best = { container: node, items };
    }
  }

  return best;
}

function isCardLike(el: HTMLElement): boolean {
  return Boolean(
    el.querySelector('img') ||
      el.querySelector('h1,h2,h3,h4,h5,h6') ||
      el.querySelector('a') ||
      el.querySelector('details'),
  );
}

function findEyebrow(el: HTMLElement, heading: HTMLElement | null): HTMLElement | null {
  const byClass = el.querySelector(
    '[class*="eyebrow"],[class*="kicker"],[class*="pretitle"],[class*="overline"],[class*="subtitle"],[class*="tag"]',
  );
  if (byClass && byClass !== heading) return byClass;

  if (!heading || !(heading.parentNode instanceof HTMLElement)) return null;
  const siblings = children(heading.parentNode);
  const index = siblings.indexOf(heading);
  const candidate = index > 0 ? siblings[index - 1] : null;
  if (!candidate) return null;

  const value = text(candidate);
  const tag = candidate.rawTagName.toLowerCase();
  if (value.length > 0 && value.length <= 60 && ['span', 'p', 'small', 'strong', 'em'].includes(tag)) {
    return candidate;
  }
  return null;
}

function firstParagraph(el: HTMLElement): HTMLElement | null {
  return (
    el
      .querySelectorAll('p')
      .find((p) => text(p).length > 0 && !insideTag(p, 'details') && !insideTag(p, 'summary')) ?? null
  );
}

/** True when `el` has an ancestor with the given tag name. */
function insideTag(el: HTMLElement, tag: string): boolean {
  let node: HTMLElement | null = el.parentNode instanceof HTMLElement ? el.parentNode : null;
  while (node) {
    if (node.rawTagName && node.rawTagName.toLowerCase() === tag) return true;
    node = node.parentNode instanceof HTMLElement ? node.parentNode : null;
  }
  return false;
}

function findCta(el: HTMLElement): HTMLElement | null {
  const anchors = el
    .querySelectorAll('a')
    .filter((a) => text(a).length > 0 && !/^#/.test(a.getAttribute('href') ?? ''));
  if (anchors.length === 0) return null;
  return (
    anchors.find((a) => /button|btn|cta|action/i.test(a.getAttribute('class') ?? '')) ??
    anchors[anchors.length - 1]
  );
}

function findNumericElement(item: HTMLElement): HTMLElement | null {
  const candidates = [item, ...item.querySelectorAll('*')].filter((c) =>
    /^[^\d]{0,4}\d[\d.,+%]*\s*$/.test(text(c)),
  );
  return candidates[0] ?? null;
}

function findLabelElement(item: HTMLElement, numeric: HTMLElement | null): HTMLElement | null {
  const candidates = [item, ...item.querySelectorAll('*')].filter(
    (c) => c !== numeric && text(c).length > 0 && !/^\d/.test(text(c)),
  );
  return candidates[candidates.length - 1] ?? null;
}

/* ------------------------------------------------------------------ *
 * Slots + source utilities
 * ------------------------------------------------------------------ */

function innerSlot(source: string, el: HTMLElement, php: string): Slot | null {
  const [start, end] = el.range;
  const openEnd = source.indexOf('>', start);
  if (openEnd < 0) return null;
  // Scan from end-1 so a sibling/parent closing tag starting exactly at `end`
  // is not mistaken for this element's own closing tag.
  const closeStart = source.lastIndexOf('</', end - 1);
  if (closeStart < 0 || closeStart < openEnd) return null;
  return { start: openEnd + 1, end: closeStart, php };
}

function attrSlot(source: string, el: HTMLElement, attr: string, php: string): Slot | null {
  const [start, end] = el.range;
  const frag = source.slice(start, end);
  const match = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(frag);
  if (!match) return null;

  const eq = match[0].indexOf('=');
  let i = eq + 1;
  while (i < match[0].length && /\s/.test(match[0][i])) i += 1;
  const valueStart = start + match.index + i + 1;
  const value = match[2] ?? match[3] ?? '';
  return { start: valueStart, end: valueStart + value.length, php };
}

function offsetSlot(slot: Slot | null, delta: number): Slot | null {
  if (!slot) return null;
  return { start: slot.start + delta, end: slot.end + delta, php: slot.php };
}

function push(slots: Slot[], slot: Slot | null): void {
  if (slot && slot.end > slot.start) slots.push(slot);
}

function applySlots(fragment: string, slots: Slot[], origin: number): string {
  const usable = slots
    .map((s) => ({ ...s, start: s.start - origin, end: s.end - origin }))
    .filter((s) => s.end > s.start && s.start >= 0 && s.end <= fragment.length)
    .sort((a, b) => b.start - a.start);

  let out = fragment;
  for (const slot of usable) out = out.slice(0, slot.start) + slot.php + out.slice(slot.end);
  return out;
}

function sourceSlice(source: string, el: HTMLElement): string {
  return source.slice(el.range[0], el.range[1]);
}

/* ------------------------------------------------------------------ *
 * Assets
 * ------------------------------------------------------------------ */

function stripAssetTags(html: string): string {
  return html
    .replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, '')
    .replace(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>\s*<\/script>/gi, '')
    .replace(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*\/>/gi, '');
}

function collectLinkedAssets(
  root: HTMLElement,
  tag: 'link' | 'script',
  assetMap: Map<string, string>,
  htmlDir: string,
): string[] {
  const found: string[] = [];
  for (const el of root.querySelectorAll(tag)) {
    if (tag === 'link' && !/stylesheet/i.test(el.getAttribute('rel') ?? '')) continue;
    const url = el.getAttribute(tag === 'link' ? 'href' : 'src');
    const themeRel = resolveUrl(url, htmlDir, assetMap);
    if (themeRel && !found.includes(themeRel)) found.push(themeRel);
  }
  return found;
}

function rewriteAssetUrls(html: string, assetMap: Map<string, string>, htmlDir: string): string {
  return html.replace(
    /\b(src|href|poster)\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (full, attr: string, _quoted: string, dq: string | undefined, sq: string | undefined) => {
      const themeRel = resolveUrl(dq ?? sq ?? '', htmlDir, assetMap);
      if (!themeRel) return full;
      return `${attr}="<?php echo esc_url( html2wp_asset( '${themeRel}' ) ); ?>"`;
    },
  );
}

function resolveUrl(url: string | null | undefined, htmlDir: string, assetMap: Map<string, string>): string | null {
  if (!url) return null;
  const clean = url.split('#')[0].split('?')[0].trim();
  if (!clean) return null;
  if (/^(https?:)?\/\//i.test(clean)) return null;
  if (/^(data:|mailto:|tel:|javascript:)/i.test(clean)) return null;

  const candidates = clean.startsWith('/')
    ? [clean.replace(/^\/+/, '')]
    : [normalizePosix(htmlDir ? `${htmlDir}/${clean}` : clean), normalizePosix(clean)];

  for (const candidate of candidates) {
    const hit = assetMap.get(candidate);
    if (hit) return hit;
  }
  return null;
}

function resolveAssetRef(url: string | null | undefined, ctx: Context): string | null {
  const mapped = resolveUrl(url, ctx.htmlDir, ctx.assetMap);
  if (mapped) return mapped;
  if (!url || /^(https?:)?\/\//i.test(url) || url.startsWith('data:')) return null;
  const clean = url.split('#')[0].split('?')[0].replace(/^\.?\/*/, '');
  return clean ? `assets/${clean}` : null;
}

function normalizePosix(value: string): string {
  const parts: string[] = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

/* ------------------------------------------------------------------ *
 * PHP rendering
 * ------------------------------------------------------------------ */

/** Declares the local variables each template relies on, then emits the markup. */
function renderPhp(fields: FieldDef[], markup: string): string {
  const lines: string[] = ['<?php', "defined( 'ABSPATH' ) || exit;"];

  for (const field of fields) {
    const { name, type } = field;
    switch (type) {
      case 'link':
        lines.push(
          `$${name} = isset( $s['${name}'] ) && is_array( $s['${name}'] ) ? $s['${name}'] : array();`,
          `$${name}_url = isset( $${name}['url'] ) ? $${name}['url'] : '';`,
          `$${name}_title = isset( $${name}['title'] ) ? $${name}['title'] : '';`,
        );
        break;
      case 'image':
        lines.push(`$${name} = html2wp_image( isset( $s['${name}'] ) ? $s['${name}'] : '' );`);
        break;
      case 'repeater':
      case 'gallery':
        lines.push(`$${name} = isset( $s['${name}'] ) && is_array( $s['${name}'] ) ? $s['${name}'] : array();`);
        break;
      default:
        lines.push(`$${name} = isset( $s['${name}'] ) ? $s['${name}'] : '';`);
    }
  }

  lines.push('?>');
  return `${lines.join('\n')}\n${markup}\n`;
}

const LAYOUT_LABELS: Record<LayoutType, string> = {
  hero: 'Hero',
  content_section: 'Content Section',
  cards: 'Cards',
  gallery: 'Gallery',
  faq_accordion: 'FAQ Accordion',
  cta: 'Call To Action',
  stats_strip: 'Stats Strip',
  team: 'Team',
  contact_form: 'Contact Form',
};

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

function children(node: HTMLElement | null): HTMLElement[] {
  if (!node || !node.childNodes) return [];
  return node.childNodes.filter((n): n is HTMLElement => n instanceof HTMLElement);
}

function first(el: HTMLElement, selector: string): HTMLElement | null {
  return el.querySelector(selector);
}

/** The element's own <img> markup, or the first nested one. */
function imageOf(el: HTMLElement): HTMLElement | null {
  if (el.rawTagName.toLowerCase() === 'img') return el;
  return el.querySelector('img');
}

function text(el: HTMLElement | null | undefined): string {
  if (!el) return '';
  return el.text.replace(/[\s\u00a0]+/g, ' ').trim();
}

function classOf(el: HTMLElement): string {
  return (el.getAttribute('class') ?? '').trim();
}

function cleanTitle(value: string): string {
  return value.split(/[|\u2013\u2014]/)[0].trim() || 'Converted Site';
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || 'converted-site';
}
