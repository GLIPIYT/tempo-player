import { useT } from '../../i18n'

export default function CollectionTrackTableHeader({ showIndex = true, showAlbum = true }: {
  showIndex?: boolean
  showAlbum?: boolean
}) {
  const t = useT()
  return (
    <div className="tl-head" aria-hidden="true">
      {showIndex && <span>#</span>}
      <span>{t('Title')}</span>
      {showAlbum && <span className="tl-head-album">{t('Album')}</span>}
      <span>{t('Duration')}</span>
      <span />
    </div>
  )
}
