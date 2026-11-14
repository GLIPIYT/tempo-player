import { lazy, Suspense } from 'react'
import { useNav } from '../state/nav'
import { useT } from '../i18n'
import { DevProfile } from '../dev-performance/DevProfile'
import HomePage from '../pages/HomePage'

const LibraryPage = lazy(() => import('../pages/LibraryPage'))
const AlbumsPage = lazy(() => import('../pages/AlbumsPage'))
const ArtistsPage = lazy(() => import('../pages/ArtistsPage'))
const PlaylistsPage = lazy(() => import('../pages/PlaylistsPage'))
const ProfilePage = lazy(() => import('../pages/ProfilePage'))
const SettingsPage = lazy(() => import('../pages/SettingsPage'))
const SearchPage = lazy(() => import('../pages/SearchPage'))
const AlbumDetailPage = lazy(() => import('../pages/AlbumDetailPage'))
const ArtistDetailPage = lazy(() => import('../pages/ArtistDetailPage'))
const PlaylistDetailPage = lazy(() => import('../pages/PlaylistDetailPage'))
const HourMixPage = lazy(() => import('../pages/HourMixPage'))
const TrackDetailPage = lazy(() => import('../pages/TrackDetailPage'))
const LocalArtistPage = lazy(() => import('../pages/LocalArtistPage'))
const ScPlaylistPage = lazy(() => import('../pages/ScPlaylistPage'))
const ScArtistPage = lazy(() => import('../pages/ScArtistPage'))
const YtCollectionPage = lazy(() => import('../pages/YtCollectionPage'))

function CurrentPage() {
  const { view, navigate } = useNav()
  switch (view.name) {
    case 'home':
      return <HomePage />
    case 'library':
      return <LibraryPage />
    case 'albums':
      return <AlbumsPage />
    case 'artists':
      return <ArtistsPage />
    case 'playlists':
      return <PlaylistsPage />
    case 'profile':
      return <ProfilePage />
    case 'settings':
      return <SettingsPage />
    case 'search':
      return <SearchPage />
    case 'album':
      return <AlbumDetailPage key={view.id} albumId={view.id} />
    case 'artist':
      return <ArtistDetailPage key={view.id} artistId={view.id} />
    case 'local-artist':
      return <LocalArtistPage key={view.artistName} name={view.artistName} imagePath={view.imagePath} />
    case 'playlist':
      return <PlaylistDetailPage key={view.id} playlistId={view.id} />
    case 'hour-mix':
      return <HourMixPage key={view.mix.key} mix={view.mix} />
    case 'sc-playlist':
      return <ScPlaylistPage key={view.id} playlistId={view.id} />
    case 'sc-artist':
      return <ScArtistPage key={view.id} artistId={view.id} fallback={view.fallback} />
    case 'yt-collection':
      return <YtCollectionPage key={`${view.kind}:${view.id}`} kind={view.kind} id={view.id} />
    case 'track-details':
      return <TrackDetailPage key={`${view.track.source}:${view.track.sourceId}`} track={view.track} onBack={() => navigate(view.previous)} />
  }
}

function PageLoading() {
  const t = useT()
  return <div className="page muted" role="status">{t('Loading…')}</div>
}

export default function PageOutlet() {
  const { view } = useNav()
  return <DevProfile id={`page:${view.name}`}>
    <Suspense fallback={<PageLoading />}><CurrentPage /></Suspense>
  </DevProfile>
}
