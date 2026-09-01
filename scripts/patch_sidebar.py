import io

p = 'src/components/layout/Sidebar.tsx'
s = io.open(p, encoding='utf-8').read()

start_marker = '        <div className="sidebar-favs">'
end_marker = '          <button className="fav-new"'
start = s.index(start_marker)
end = s.index(end_marker)

replacement = '''        <div className="sidebar-favs">
          {!collapsed ? (
            <div className="fav-head">
              <span>{t('Favorites')}</span>
              <span className="fav-count">
                {grouped ? favorites.length : favorites.length + artists.length + albums.length}
              </span>
            </div>
          ) : null}
          {!collapsed &&
          (grouped
            ? favorites.length === 0
            : favorites.length + artists.length + albums.length === 0) ? (
            <div className="fav-empty">{t('Pin playlists to see them here')}</div>
          ) : null}
          <div className="fav-list">{favorites.map((f, i) => playlistRow(f, i))}</div>
          {grouped && !collapsed ? (
            artists.length > 0 ? (
              <>
                <div className="fav-head" style={{ marginTop: 10 }}>
                  <span>{t('Favorite artists')}</span>
                  <span className="fav-count">{artists.length}</span>
                </div>
                <div className="fav-list" style={{ marginTop: 2 }}>
                  {artists.map(artistRow)}
                </div>
              </>
            ) : null
          ) : artists.length > 0 ? (
            <div className="fav-list">{artists.map(artistRow)}</div>
          ) : null}
          {grouped && !collapsed ? (
            albums.length > 0 ? (
              <>
                <div className="fav-head" style={{ marginTop: 10 }}>
                  <span>{t('Favorite albums')}</span>
                  <span className="fav-count">{albums.length}</span>
                </div>
                <div className="fav-list" style={{ marginTop: 2 }}>
                  {albums.map(albumRow)}
                </div>
              </>
            ) : null
          ) : albums.length > 0 ? (
            <div className="fav-list">{albums.map(albumRow)}</div>
          ) : null}
'''

s = s[:start] + replacement + s[end:]
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('sidebar-favs block replaced')
