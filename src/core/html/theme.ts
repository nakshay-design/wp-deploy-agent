import * as fs from 'node:fs';
import * as path from 'node:path';
import { phpString } from '../php';
import { buildAcfJson, uniqueLayouts } from './acfJson';
import type { ConvertedSite } from './types';

/** Writes a complete WordPress theme for a converted site. Returns the theme dir. */
export function writeTheme(site: ConvertedSite, outDir: string): string {
  fs.mkdirSync(path.join(outDir, 'template-parts'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'acf-json'), { recursive: true });

  write(outDir, 'style.css', buildStyleCss(site));
  write(outDir, 'functions.php', buildFunctionsPhp(site));
  write(outDir, 'header.php', buildHeaderPhp(site));
  write(outDir, 'footer.php', buildFooterPhp(site));
  write(outDir, 'front-page.php', FRONT_PAGE_PHP);
  write(outDir, 'index.php', INDEX_PHP);

  for (const group of uniqueLayouts(site.sections)) {
    const part = `${PART_PREAMBLE}\n${group.representative.phpTemplate}`;
    write(outDir, path.join('template-parts', `section-${group.layout}.php`), part);
  }

  write(
    outDir,
    path.join('acf-json', 'group_html2wp_page_sections.json'),
    buildAcfJson(site.sections, site.slug),
  );

  return outDir;
}

/* ------------------------------------------------------------------ *
 * style.css
 * ------------------------------------------------------------------ */

function buildStyleCss(site: ConvertedSite): string {
  const header = `/*
Theme Name: ${site.title}
Author: Converted by wp-deploy-agent
Description: ${site.description.replace(/\s+/g, ' ').slice(0, 200) || `WordPress theme generated from static HTML.`}
Version: 1.0.0
Requires at least: 5.5
Tested up to: 6.7
Requires PHP: 7.4
License: GNU General Public License v2 or later
License URI: http://www.gnu.org/licenses/gpl-2.0.html
Text Domain: ${site.slug}
*/
`;

  const parts = [header];
  if (site.inlineCss.trim()) parts.push(site.inlineCss.trim(), '');
  return parts.join('\n');
}

/* ------------------------------------------------------------------ *
 * functions.php
 * ------------------------------------------------------------------ */

function buildFunctionsPhp(site: ConvertedSite): string {
  const css = phpArray('html2wp_css_list', site.stylesheets);
  const js = phpArray('html2wp_js_list', site.scripts);

  return `<?php
/**
 * Theme functions for ${site.title}.
 *
 * @package html2wp
 */

defined( 'ABSPATH' ) || exit;

define( 'HTML2WP_VERSION', '1.0.0' );

/** Resolve a theme-relative asset path to a full URL. */
function html2wp_asset( $rel ) {
	return trailingslashit( get_template_directory_uri() ) . ltrim( (string) $rel, '/' );
}

/**
 * Resolve an ACF image value to a URL.
 * Accepts an attachment ID (after seeding), an array, or a theme-relative path.
 */
function html2wp_image( $value ) {
	if ( is_array( $value ) ) {
		if ( isset( $value['url'] ) ) {
			return $value['url'];
		}
		if ( isset( $value['ID'] ) ) {
			$value = $value['ID'];
		} elseif ( isset( $value['id'] ) ) {
			$value = $value['id'];
		}
	}
	if ( is_numeric( $value ) ) {
		$url = wp_get_attachment_image_url( (int) $value, 'full' );
		return $url ? $url : '';
	}
	if ( is_string( $value ) && '' !== $value ) {
		return html2wp_asset( $value );
	}
	return '';
}

${css}

${js}

function html2wp_setup() {
	add_theme_support( 'title-tag' );
	add_theme_support( 'post-thumbnails' );
	add_theme_support( 'html5', array( 'style', 'script', 'search-form', 'gallery', 'caption' ) );
	register_nav_menus( array( 'primary' => __( 'Primary Menu', '${site.slug}' ) ) );
}
add_action( 'after_setup_theme', 'html2wp_setup' );

function html2wp_assets() {
	wp_enqueue_style( 'html2wp-style', get_stylesheet_uri(), array(), HTML2WP_VERSION );
	foreach ( html2wp_css_list() as $i => $rel ) {
		wp_enqueue_style( 'html2wp-css-' . $i, html2wp_asset( $rel ), array(), HTML2WP_VERSION );
	}
	foreach ( html2wp_js_list() as $i => $rel ) {
		wp_enqueue_script( 'html2wp-js-' . $i, html2wp_asset( $rel ), array(), HTML2WP_VERSION, true );
	}
}
add_action( 'wp_enqueue_scripts', 'html2wp_assets' );

/* Keep ACF field groups in sync with the bundled acf-json folder. */
add_filter(
	'acf/settings/load_json',
	function ( $paths ) {
		$paths[] = get_stylesheet_directory() . '/acf-json';
		return $paths;
	}
);
add_filter(
	'acf/settings/save_json',
	function ( $path ) {
		return get_stylesheet_directory() . '/acf-json';
	}
);

/** Body classes so styles can target converted pages. */
add_filter(
	'body_class',
	function ( $classes ) {
		$classes[] = 'html2wp';
		return $classes;
	}
);
`;
}

function phpArray(fnName: string, values: string[]): string {
  const lines = [`function ${fnName}() {`, '\treturn array('];
  for (const value of values) lines.push(`\t\t${phpString(value)},`);
  lines.push('\t);', '}');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * header.php / footer.php / fallbacks
 * ------------------------------------------------------------------ */

function buildHeaderPhp(site: ConvertedSite): string {
  const markup = site.headerMarkup.trim();
  return `<?php defined( 'ABSPATH' ) || exit; ?>
<!DOCTYPE html>
<html <?php language_attributes(); ?>>
<head>
<meta charset="<?php bloginfo( 'charset' ); ?>">
<meta name="viewport" content="width=device-width, initial-scale=1">
<?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
<?php wp_body_open(); ?>
${markup || '<header class="html2wp-header"></header>'}
`;
}

function buildFooterPhp(site: ConvertedSite): string {
  const markup = site.footerMarkup.trim();
  return `${markup}
<?php wp_footer(); ?>
</body>
</html>
`;
}

const FRONT_PAGE_PHP = `<?php
/**
 * Front page rendered from the "page_sections" ACF Flexible Content field.
 *
 * @package html2wp
 */

defined( 'ABSPATH' ) || exit;

get_header();

$html2wp_sections = function_exists( 'get_field' ) ? get_field( 'page_sections', get_the_ID() ) : array();

if ( is_array( $html2wp_sections ) && $html2wp_sections ) {
	foreach ( $html2wp_sections as $html2wp_section ) {
		$html2wp_layout = isset( $html2wp_section['acf_fc_layout'] ) ? $html2wp_section['acf_fc_layout'] : '';
		if ( '' === $html2wp_layout ) {
			continue;
		}
		if ( locate_template( 'template-parts/section-' . $html2wp_layout . '.php' ) ) {
			get_template_part( 'template-parts/section', $html2wp_layout, array( 's' => $html2wp_section ) );
		}
	}
}

get_footer();
`;

const INDEX_PHP = `<?php
/**
 * Fallback template.
 *
 * @package html2wp
 */

defined( 'ABSPATH' ) || exit;

get_header();
?>
<main id="main" class="html2wp-main">
<?php
while ( have_posts() ) {
	the_post();
	the_content();
}
?>
</main>
<?php
get_footer();
`;

const PART_PREAMBLE = `<?php $s = isset( $args['s'] ) && is_array( $args['s'] ) ? $args['s'] : array(); ?>`;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function write(dir: string, rel: string, content: string): void {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}
