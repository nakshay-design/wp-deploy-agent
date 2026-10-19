import type { ConvertedSection, FieldDef } from './types';

export const GROUP_KEY = 'group_html2wp_page_sections';
export const FIELD_KEY = 'field_html2wp_page_sections';

export interface LayoutGroup {
  layout: string;
  label: string;
  /** Union of fields across every section that uses this layout. */
  fields: FieldDef[];
  /** The richest section instance - its markup becomes the shared template part. */
  representative: ConvertedSection;
}

/**
 * Groups converted sections by layout type. ACF flexible content needs one layout
 * definition per type (rows reuse it), so fields are unioned and the most complete
 * section is kept as the markup representative.
 */
export function uniqueLayouts(sections: ConvertedSection[]): LayoutGroup[] {
  const byLayout = new Map<
    string,
    { label: string; fields: Map<string, FieldDef>; representative: ConvertedSection }
  >();

  for (const section of sections) {
    const entry = byLayout.get(section.layout) ?? {
      label: section.label,
      fields: new Map<string, FieldDef>(),
      representative: section,
    };
    for (const field of section.fields) {
      if (!entry.fields.has(field.name)) entry.fields.set(field.name, field);
    }
    if (score(section) > score(entry.representative)) entry.representative = section;
    byLayout.set(section.layout, entry);
  }

  return [...byLayout.entries()].map(([layout, entry]) => ({
    layout,
    label: entry.label,
    fields: [...entry.fields.values()],
    representative: entry.representative,
  }));
}

/** Builds the ACF local-JSON field group synced from the theme's acf-json folder. */
export function buildAcfJson(sections: ConvertedSection[], slug: string): string {
  const layouts: Record<string, unknown> = {};

  for (const { layout, label, fields } of uniqueLayouts(sections)) {
    const layoutKey = `layout_html2wp_${layout}`;
    layouts[layoutKey] = {
      key: layoutKey,
      name: layout,
      label,
      display: 'block',
      sub_fields: fields.map((field) => toAcfField(field, `${slug}_${layout}`)),
      min: '',
      max: '',
    };
  }

  const group = {
    key: GROUP_KEY,
    title: 'Page Sections',
    fields: [
      {
        key: FIELD_KEY,
        label: 'Page Sections',
        name: 'page_sections',
        type: 'flexible_content',
        instructions: 'Sections imported from the source HTML.',
        required: 0,
        conditional_logic: 0,
        layouts,
        button_label: 'Add Section',
        min: '',
        max: '',
      },
    ],
    location: [[{ param: 'post_type', operator: '==', value: 'page' }]],
    menu_order: 0,
    position: 'normal',
    style: 'default',
    label_placement: 'top',
    instruction_placement: 'label',
    hide_on_screen: '',
    active: true,
    description: '',
    show_in_rest: 0,
    modified: Math.floor(Date.now() / 1000),
  };

  return `${JSON.stringify(group, null, 2)}\n`;
}

function toAcfField(field: FieldDef, prefix: string): Record<string, unknown> {
  const key = `field_html2wp_${prefix}_${field.name}`.toLowerCase();
  const base = { key, label: field.label, name: field.name, type: field.type };

  switch (field.type) {
    case 'textarea':
      return { ...base, default_value: '', rows: 4, new_lines: '' };
    case 'wysiwyg':
      return { ...base, tabs: 'all', toolbar: 'full', media_upload: 1 };
    case 'image':
      return { ...base, return_format: 'id', preview_size: 'medium', library: 'all', mime_types: '' };
    case 'link':
      return { ...base, return_format: 'array' };
    case 'gallery':
      return { ...base, return_format: 'id', preview_size: 'medium', library: 'all' };
    case 'repeater':
      return {
        ...base,
        layout: 'block',
        button_label: 'Add Row',
        min: 0,
        max: 0,
        sub_fields: (field.subFields ?? []).map((sub) =>
          toAcfField(sub, `${prefix}_${field.name}`),
        ),
      };
    default:
      return { ...base, default_value: '' };
  }
}

function score(section: ConvertedSection): number {
  return section.fields.length * 1000 + section.phpTemplate.length;
}
