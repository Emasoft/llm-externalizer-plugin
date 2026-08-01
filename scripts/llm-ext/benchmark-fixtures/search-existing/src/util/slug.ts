// Benchmark fixture — real code with a KNOWN feature location (TRDD-828238b5 A6).
// Feature: URL-safe slug generation from arbitrary strings.

/**
 * Convert an arbitrary string into a URL-safe slug: lowercase, accents
 * stripped, non-alphanumerics collapsed into single hyphens, trimmed.
 */
export function slugify(input: string, maxLength = 80): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > maxLength
    ? slug.slice(0, maxLength).replace(/-+$/g, "")
    : slug;
}
