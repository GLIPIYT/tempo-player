import { ArrowUpDown, Search, Star, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useT } from '../../i18n'
import './collectionDesign.css'

export function CollectionCatalogHeading({ title, count, actions }: { title: string; count?: number; actions?: ReactNode }) {
  const t = useT()
  return <header className="collection-catalog-heading">
    <div><span className="collection-kicker">{t('Your library')}</span><h1>{title}{count != null && <span className="collection-count">{count}</span>}</h1></div>
    {actions && <div className="collection-catalog-actions">{actions}</div>}
  </header>
}

export function CollectionCatalogToolbar({ query, onQuery, placeholder, favoritesOnly, onFavoritesOnly, allLabel, children }: {
  query: string; onQuery: (value: string) => void; placeholder: string
  favoritesOnly: boolean; onFavoritesOnly: (value: boolean) => void; allLabel: string; children: ReactNode
}) {
  const t = useT()
  return <div className="collection-catalog-toolbar">
    <div className="collection-catalog-filter"><button type="button" aria-pressed={!favoritesOnly} onClick={() => onFavoritesOnly(false)}>{allLabel}</button><button type="button" aria-pressed={favoritesOnly} onClick={() => onFavoritesOnly(true)}><Star size={13} />{t('Favorites')}</button></div>
    <label className="collection-catalog-search"><Search size={15} /><input type="search" aria-label={placeholder} placeholder={placeholder} value={query} onChange={event => onQuery(event.target.value)} />{query && <button type="button" onClick={() => onQuery('')} aria-label={t('Clear search')}><X size={13} /></button>}</label>
    <span className="collection-catalog-sort"><ArrowUpDown size={14} />{children}</span>
  </div>
}

export function CollectionTrackHeading({ count, query, onQuery }: { count: number; query: string; onQuery: (query: string) => void }) {
  const t = useT()
  return <div className="collection-section-heading"><h2>{t('Tracks')}<span>{count}</span></h2><label className="collection-catalog-search"><Search size={14} /><input type="search" aria-label={t('Search tracks')} placeholder={t('Search tracks')} value={query} onChange={event => onQuery(event.target.value)} />{query && <button type="button" aria-label={t('Clear search')} onClick={() => onQuery('')}><X size={12} /></button>}</label></div>
}
