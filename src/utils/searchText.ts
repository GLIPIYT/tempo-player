/** Normalize text only for matching; keep the original text for display and identity. */
export function normalizeSearchText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/ё/g, 'е')
}

/** Provider queries are not candidate keys: preserve URL IDs and query syntax. */
export function normalizeProviderSearchQuery(text: string): string {
  const query = text.trim()
  if (/^https?:\/\/\S+$/i.test(query)) return query
  return query.normalize('NFKC').replace(/ё/g, 'е').replace(/Ё/g, 'Е')
}
