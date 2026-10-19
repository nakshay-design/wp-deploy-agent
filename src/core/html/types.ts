/** Layout types the rule-based converter can recognise. */
export type LayoutType =
  | 'hero'
  | 'content_section'
  | 'cards'
  | 'gallery'
  | 'faq_accordion'
  | 'cta'
  | 'stats_strip'
  | 'team'
  | 'contact_form';

/** ACF field types we emit. */
export type AcfFieldType = 'text' | 'textarea' | 'wysiwyg' | 'image' | 'link' | 'repeater' | 'gallery';

export interface FieldDef {
  name: string;
  label: string;
  type: AcfFieldType;
  /** Required for repeater fields. */
  subFields?: FieldDef[];
}

export interface ConvertedSection {
  layout: LayoutType;
  label: string;
  /** Markup ready to drop into a PHP file: contains <?php ?> echoes and loops. */
  phpTemplate: string;
  fields: FieldDef[];
  /** Extracted values keyed by field name - used to seed the live site. */
  values: Record<string, unknown>;
}

export interface ConvertedSite {
  /** Derived theme slug. */
  slug: string;
  title: string;
  /** Sections in document order (header/footer excluded). */
  sections: ConvertedSection[];
  /** Raw site header markup with asset URLs already rewritten to PHP. */
  headerMarkup: string;
  /** Raw site footer markup with asset URLs already rewritten to PHP. */
  footerMarkup: string;
  /** Relative CSS files found in the archive (in document order). */
  stylesheets: string[];
  /** Relative JS files found in the archive (in document order). */
  scripts: string[];
  /** Inline <style> content collected from the source document. */
  inlineCss: string;
  /** All asset files copied into the theme, relative to the theme root. */
  assets: string[];
  /** Original document title / description, used for site settings. */
  description: string;
}

export interface ConvertOptions {
  /** Theme slug to generate. Derived from the site title when omitted. */
  slug?: string;
  /** Directory the generated theme is written to. */
  outDir: string;
}
