/**
 * Convert text to a URL/filesystem-safe slug.
 * Lowercase, replace non-alphanumeric with hyphens, collapse multiples,
 * trim leading/trailing hyphens, max 40 characters.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, ''); // trim trailing hyphen left by slice
}
