(() => {
  'use strict';
  const P = () => window.Polish;
  const ico = (name, size = 18) => P().icon(name, size);
  const art = (i, cls = '') => `<img class="px-art ${cls}" src="${P().art(i)}" alt="" draggable="false">`;
  const safe = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const button = (icon, label, action, cls = '') => `<button type="button" class="icon-button ${cls}" aria-label="${label}" title="${label}" data-px="${action}">${ico(icon)}</button>`;
  const states = new Map();
  function state(screen, variant) {
    const key = `${screen}:${variant}`;
    if (!states.has(key)) states.set(key, {selected: 0, tab: 'all', sort: false, query: '', detail: false, activity: 'graph', period: '30', playing: true, liked: false, position: 92, expanded: true, volume: false, phase: 'offer', progress: 0, combo: '', artist: 'Serein', album: 'Nightline', cover: 0, coverOpen: false, editing: false, nickname: 'zxcloli666', dialog: 'playlist', saved: false});
    return states.get(key);
  }
  const scope = (screen, variant, content) => `<div class="px-scope px-${screen} px-variant-${variant}" data-px-screen="${screen}" data-px-variant="${variant}">${content}</div>`;
  const albums = [
    ['Nightline', 'Serein', '2024', 11, 0, true],
    ['Glass Tides', 'Auren', '2023', 9, 1, true],
    ['Red Corridor', 'Soma', '2025', 12, 2, false],
    ['Static Bloom', 'Near Field', '2024', 8, 1, true],
    ['Still Water', 'Miro', '2022', 10, 0, true],
    ['Afterimage', 'Serein', '2025', 7, 2, false],
    ['Signal / Noise', 'Near Field', '2023', 13, 2, true],
    ['Sea Glass', 'Auren', '2021', 6, 1, true],
    ['Last Train', 'Miro', '2024', 9, 0, true],
    ['Low Light', 'Soma', '2020', 10, 2, true],
    ['The Quiet', 'Serein', '2022', 12, 1, false],
    ['Blue Hour', 'Auren', '2025', 8, 0, true],
  ].map((album, index) => { album[4] = index % 8; return album; });
  function albumCard(a, i, row = false, s) {
    const hidden = !`${a[0]} ${a[1]}`.toLowerCase().includes(s.query.toLowerCase()) || s.tab === 'cached' && !a[5];
    return `<article class="px-album-card ${row ? 'px-album-row' : ''}" ${hidden ? 'hidden' : ''} data-px-search="${safe(`${a[0]} ${a[1]}`.toLowerCase())}" data-px-cache="${a[5]}"><button class="px-album-open" data-px="album-select" data-px-value="${i}">${art(a[4])}<span><strong>${a[0]}</strong><small>${a[1]}</small>${row ? `<small>${a[2]} · ${a[3]} треков</small>` : ''}</span></button>${row ? `<span class="px-row-year">${a[2]}</span>` : ''}<span class="px-cache-dot ${a[5] ? 'px-cached' : ''}" title="${a[5] ? 'Сохранён на компьютере' : 'Часть треков не сохранена'}">${ico(a[5] ? 'check' : 'download', 12)}</span><button class="px-album-play" data-px="album-play" aria-label="Слушать ${a[0]}">${ico('play', 17)}</button>${!row ? `<span class="px-album-year">${a[2]}</span>` : ''}</article>`;
  }
  function albumDetail(s, variant) {
    const a = albums[s.selected];
    return `<div class="px-album-detail"><div class="px-detail-cover">${art(a[4])}${variant === 'b' ? '<span class="px-vinyl"></span>' : ''}</div><div class="px-detail-title"><small>Альбом · ${a[2]}</small><h2>${a[0]}</h2><p>${a[1]} · ${a[3]} треков</p><div class="px-actions"><button class="btn primary" data-px="album-play">${ico('play', 16)} Слушать</button>${button('heart', 'В избранное', 'like', s.liked ? 'px-active' : '')}${button('more', 'Меню альбома', 'album-menu')}</div></div><div class="px-detail-tracks">${P().trackRows(5)}</div>${s.menu ? '<div class="px-inline-menu"><button data-px="album-download">Сохранить альбом</button><button data-px="album-menu">Закрыть меню</button></div>' : ''}</div>`;
  }
  function albumScreen(variant) {
    const s = state('albums', variant);
    let entries = albums.map((a, i) => [a, i]);
    if (s.sort) entries = entries.sort((a, b) => b[0][2].localeCompare(a[0][2]));
    const head = `<div class="px-page-head"><div><h1>Альбомы</h1><span class="px-muted">12 альбомов</span></div><div class="px-actions"><button class="btn" data-px="album-sort">${s.sort ? 'По году' : 'По названию'} ${ico('chevron', 14)}</button></div></div>`;
    const toolbar = `<div class="px-toolbar"><label class="px-search">${ico('search', 16)}<input type="search" placeholder="Альбом или исполнитель" aria-label="Найти альбом" value="${safe(s.query)}" data-px-filter="albums"></label><div class="px-segment"><button aria-pressed="${s.tab === 'all'}" data-px="album-tab" data-px-value="all">Все</button><button aria-pressed="${s.tab === 'cached'}" data-px="album-tab" data-px-value="cached">${ico('check', 13)} На компьютере</button></div></div>`;
    if (variant === 'a') {
      return scope('albums', variant, `${head}${toolbar}${s.detail ? `<div class="px-album-expanded"><button class="px-text-button" data-px="album-close">${ico('back', 15)} Все альбомы</button>${albumDetail(s, variant)}</div>` : `<div class="px-album-wall">${entries.map(([a, i]) => albumCard(a, i, false, s)).join('')}</div><p class="px-empty" hidden>Альбомы не найдены</p>`}`);
    }
    return scope('albums', variant, `${head}${toolbar}<div class="px-album-browser"><div class="px-album-directory">${entries.map(([a, i]) => albumCard(a, i, true, s)).join('')}<p class="px-empty" hidden>Альбомы не найдены</p></div>${albumDetail(s, variant)}</div>`);
  }
  function stats() { return `<div class="px-profile-stats"><div><strong>128,4 <em>ч</em></strong><span>Слушали музыку</span></div><div><strong>2 416</strong><span>Воспроизведений</span></div><div><strong>84 <em>%</em></strong><span>Дослушали</span></div></div>`; }
  function activity(s) {
    const bars = [35, 58, 38, 78, 66, 28, 45, 50, 88, 73, 42, 64, 90, 63, 37, 77, 55, 32, 68, 93, 64, 50, 48, 73, 82, 43, 91, 68, 60, 75];
    const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    return `<section class="px-activity"><div class="px-section-head"><h2>Активность</h2><div class="px-actions"><div class="px-segment"><button data-px="period" data-px-value="30" aria-pressed="${s.period === '30'}">Месяц</button><button data-px="period" data-px-value="365" aria-pressed="${s.period === '365'}">Год</button></div><div class="px-segment px-icon-segment"><button data-px="activity" data-px-value="graph" aria-label="График" aria-pressed="${s.activity === 'graph'}">${ico('list', 16)}</button><button data-px="activity" data-px-value="grid" aria-label="Сетка" aria-pressed="${s.activity === 'grid'}">${ico('grid', 16)}</button></div></div></div>${s.activity === 'graph' ? `<div class="px-chart"><div class="px-chart-scale"><span>3 ч</span><span>2 ч</span><span>1 ч</span><span>0</span></div><div class="px-chart-bars">${(s.period === '30' ? bars : bars.slice(0, 12)).map((h, i) => `<div class="px-chart-column" title="${i + 1}${s.period === '30' ? ' сентября' : ' месяц'}: ${Math.round(h * 2)} мин"><i style="height:${h}%"></i></div>`).join('')}</div></div><div class="px-chart-dates"><span>${s.period === '30' ? '1 сентября' : 'Октябрь'}</span><span>${s.period === '30' ? '15 сентября' : 'Март'}</span><span>${s.period === '30' ? '30 сентября' : 'Сентябрь'}</span></div>` : `<div class="px-heatmap-layout"><div class="px-heatmap-days">${days.map(d => `<span>${d}</span>`).join('')}</div><div class="px-heatmap" style="--px-grid-cols:${s.period === '30' ? '15' : '40'}">${Array.from({length: s.period === '30' ? 105 : 280}, (_, i) => `<i title="${1 + i % 30} сентября: ${((i * 37) % 160)} мин" style="--px-intensity:${i % 7 === 0 ? '.03' : (0.12 + ((i * 17) % 85) / 100).toFixed(2)}"></i>`).join('')}</div></div><div class="px-chart-dates"><span>${s.period === '30' ? 'Сентябрь' : 'Последние 12 месяцев'}</span><span>Меньше <i class="px-legend"></i> Больше</span></div>`}<div class="px-activity-foot"><span>26 дней с музыкой</span><strong>${s.period === '30' ? '42 ч 18 мин' : '128 ч 24 мин'}</strong></div></section>`;
  }
  function profileIdentity(s) {
    return `<div class="px-profile-identity"><button class="px-avatar" data-px="avatar" aria-label="Изменить аватар">${s.avatar != null ? art(s.avatar) : ico('user', 35)}<span>${ico('plus', 14)}</span></button><div>${s.editing ? `<div class="px-name-edit"><input class="input" aria-label="Имя профиля" value="${safe(s.nickname)}" data-px-field="nickname"><button class="icon-button px-active" data-px="name-save" aria-label="Сохранить имя">${ico('check', 17)}</button></div>` : `<h1>${safe(s.nickname)}<button class="icon-button" data-px="name-edit" aria-label="Изменить имя">${ico('settings', 15)}</button></h1>`}<span class="px-muted">Ваша медиатека</span></div></div>${s.avatarOpen ? `<div class="px-avatar-choices">${[0, 1, 2].map(i => `<button data-px="avatar-pick" data-px-value="${i}" aria-label="Аватар ${i + 1}">${art(i)}</button>`).join('')}</div>` : ''}`;
  }
  function topArtists() {
    return `<section class="px-profile-artists"><div class="px-section-head"><h2>Исполнители месяца</h2><span class="px-muted">Сентябрь</span></div>${[['Serein', '8 ч 42 мин', 0], ['Auren', '6 ч 18 мин', 1], ['Soma', '4 ч 51 мин', 2], ['Miro', '3 ч 12 мин', 0]].map((a, i) => `<div class="px-artist-rank"><span class="px-rank">${i + 1}</span>${art(a[2])}<span><strong>${a[0]}</strong><small>${a[1]}</small></span><div class="px-rank-line"><i style="width:${100 - i * 21}%"></i></div></div>`).join('')}</section>`;
  }
  function profileScreen(variant) {
    const s = state('profile', variant);
    if (variant === 'a') return scope('profile', variant, `<div class="px-profile-header">${profileIdentity(s)}${stats()}</div>${activity(s)}<div class="px-profile-bottom">${topArtists()}<section class="px-profile-history"><div class="px-section-head"><h2>Последние треки</h2><button class="px-text-button" data-px="history">История ${ico('arrow', 14)}</button></div>${P().trackRows(4)}</section></div>${s.history ? `<section class="px-history-expanded"><div class="px-section-head"><h2>История</h2>${button('close', 'Закрыть историю', 'history')}</div>${P().trackRows(7)}</section>` : ''}`);
    return scope('profile', variant, `<div class="px-profile-columns"><aside class="px-profile-passport">${profileIdentity(s)}${stats()}<div class="px-profile-library"><h3>Медиатека</h3><div><span>Треки</span><strong>482</strong></div><div><span>Альбомы</span><strong>12</strong></div><div><span>Плейлисты</span><strong>8</strong></div></div></aside><div class="px-profile-main">${activity(s)}${topArtists()}<section class="px-profile-history"><div class="px-section-head"><h2>Недавно слушали</h2></div>${P().trackRows(3)}</section></div></div>`);
  }
  function miniScreen(variant) {
    const s = state('mini', variant);
    const controls = `${button('skip', 'Предыдущий трек', 'prev', 'px-prev')}<button class="px-mini-play" data-px="mini-play" aria-label="${s.playing ? 'Пауза' : 'Продолжить'}">${ico(s.playing ? 'pause' : 'play', 19)}</button>${button('skip', 'Следующий трек', 'next')}`;
    const progress = `<div class="px-mini-progress"><span data-px-time>${Math.floor(s.position / 60)}:${String(s.position % 60).padStart(2, '0')}</span><input type="range" min="0" max="272" value="${s.position}" data-px-range="seek" aria-label="Позиция трека" style="--px-fill:${s.position / 272 * 100}%"><span>4:32</span></div>`;
    const player = variant === 'a' ? `<div class="px-mini-window px-mini-strip"><div class="px-mini-top">${art(0)}<div class="px-mini-song"><strong>Nightline</strong><small>Serein</small></div>${button('heart', 'Нравится', 'mini-like', s.liked ? 'px-active' : '')}${button('close', 'Свернуть', 'mini-expand')}</div><div class="px-mini-controls">${button('shuffle', 'Перемешать', 'mini-shuffle', s.shuffle ? 'px-active' : '')}${controls}${button('volume', 'Громкость', 'mini-volume')}</div>${progress}${s.volume ? `<div class="px-mini-volume">${ico('volume', 14)}<input type="range" min="0" max="100" value="65" aria-label="Громкость"></div>` : ''}</div>` : `<div class="px-mini-window px-mini-side">${art(0)}<div class="px-mini-body"><div class="px-mini-top"><div class="px-mini-song"><strong>Nightline</strong><small>Serein</small></div>${button('close', 'Свернуть', 'mini-expand')}</div><div class="px-mini-controls">${controls}${button('heart', 'Нравится', 'mini-like', s.liked ? 'px-active' : '')}</div>${progress}</div></div>`;
    return scope('mini', variant, `<div class="px-page-head"><h1>Мини-плеер</h1><button class="btn" data-px="mini-expand">${s.expanded ? 'Свернуть' : 'Развернуть'}</button></div><div class="px-desktop-stage"><div class="px-desktop-lines"></div><div class="px-mini-demonstrator">${s.expanded ? player : `<button class="px-mini-pill" data-px="mini-expand"><i></i> Nightline ${ico('chevron', 13)}</button>`}</div><span class="px-mini-size">${variant === 'a' ? '288 × 154' : '350 × 118'}</span></div><div class="px-mini-options"><label><input type="checkbox" checked> Поверх окон</label><label><input type="checkbox" checked> Показывать при смене трека</label><label><input type="checkbox"> Скрывать во время игры</label></div>`);
  }
  function releaseNotes() { return `<div class="px-release-notes"><section><h3>Лирика</h3><ul><li>Независимая скорость и точные тайминги</li><li>Редактор строк и локальный анализ</li></ul></section><section><h3>Оформление</h3><ul><li>Градиентные темы и поиск обоев</li><li>Новые страницы медиатеки</li></ul></section><section><h3>Воспроизведение</h3><ul><li>Эквалайзер и изменение скорости</li><li>Редактор данных трека</li></ul></section></div>`; }
  function modalHead(title, action = 'dismiss') { return `<header class="px-modal-head"><h2>${title}</h2>${button('close', 'Закрыть', action)}</header>`; }
  function updateScreen(variant) {
    const s = state('update', variant);
    const progress = s.phase !== 'offer' ? `<div class="px-download-state"><div class="px-section-head"><strong>${s.phase === 'ready' ? 'Готово к установке' : 'Загрузка обновления'}</strong><span>${s.progress}%</span></div><div class="px-download-bar"><i style="width:${s.progress}%"></i></div><small>${s.phase === 'ready' ? 'Плеер перезапустится после установки' : `${(s.progress * .86).toFixed(1)} из 86 МБ`}</small></div>` : '';
    const footer = `<footer class="px-modal-foot"><button class="px-text-button" data-px="update-skip">Пропустить версию</button><button class="btn primary" data-px="update-start" ${s.phase === 'downloading' ? 'disabled' : ''}>${ico(s.phase === 'ready' ? 'refresh' : 'download', 16)} ${s.phase === 'ready' ? 'Перезапустить' : s.phase === 'downloading' ? 'Загрузка…' : 'Скачать и установить'}</button></footer>`;
    const body = variant === 'a' ? `<div class="px-update-heading"><div class="px-update-mark">${ico('download', 29)}</div><div><h3>Tempo 1.0.0</h3><span>Обновление доступно · 86 МБ</span></div></div>${releaseNotes()}${progress}` : `<div class="px-update-columns"><aside><div class="px-update-mark">${ico('download', 38)}</div><h3>Tempo<br><span>1.0.0</span></h3><p>86 МБ · Windows</p><span class="px-muted">Сейчас 0.9.0</span></aside><div>${releaseNotes()}${progress}</div></div>`;
    return scope('update', variant, `<div class="px-page-head"><h1>Обновление</h1><button class="btn" data-px="update-reset">Показать заново</button></div><div class="px-modal-stage">${backdrop()}${s.dismissed ? `<button class="btn primary px-reopen" data-px="update-reset">Открыть обновление</button>` : `<div class="px-modal px-update-modal">${modalHead('Обновление Tempo')}${body}${footer}</div>`}</div>`);
  }
  function backdrop() { return `<div class="px-dialog-backdrop" aria-hidden="true"><div class="px-backdrop-title"></div><div class="px-backdrop-covers">${[0, 1, 2, 0].map(i => art(i)).join('')}</div><div class="px-backdrop-row"></div><div class="px-backdrop-row"></div></div>`; }
  function combo(field, s) {
    const items = field === 'artist' ? ['Serein', 'Auren', 'Soma', 'Miro', 'Near Field'] : ['Nightline', 'Afterimage', 'The Quiet', 'Glass Tides'];
    return `<div class="px-combo" data-px-combo="${field}"><label>${field === 'artist' ? 'Исполнитель' : 'Альбом'}</label><button class="px-combo-trigger" data-px="combo" data-px-value="${field}" aria-haspopup="listbox" aria-expanded="${s.combo === field}"><span>${ico(field === 'artist' ? 'user' : 'disc', 16)}<b data-px-selected-label>${safe(s[field])}</b></span>${ico('chevron', 14)}</button>${s.combo === field ? `<div class="px-combo-popup"><label class="px-search">${ico('search', 15)}<input type="search" placeholder="${field === 'artist' ? 'Имя исполнителя' : 'Название альбома'}" aria-label="Поиск ${field === 'artist' ? 'исполнителя' : 'альбома'}" data-px-combo-search="${field}"></label><div class="px-combo-results" role="listbox">${[...new Set([...items, s[field]])].map((value, i) => `<button role="option" aria-selected="${s[field] === value}" data-px="combo-select" data-px-field="${field}" data-px-value="${safe(value)}" data-px-search="${safe(value.toLowerCase())}">${art(i % 3)}<span>${safe(value)}</span>${s[field] === value ? ico('check', 14) : ''}</button>`).join('')}</div><button class="px-create-option" data-px="combo-create" data-px-field="${field}">${ico('plus', 15)}<span data-px-create-label>Создать ${field === 'artist' ? 'исполнителя' : 'альбом'}</span></button></div>` : ''}</div>`;
  }
  function coverPicker(s) {
    return `<div class="px-cover-control"><button data-px="cover-open" aria-label="Изменить обложку">${art(s.cover)}<span>${ico('plus', 15)}</span></button>${s.coverOpen ? `<div class="px-cover-popup"><button class="px-text-button" data-px="cover-local">${ico('folder', 15)} Файл с компьютера</button><small>Из медиатеки</small><div>${[0, 1, 2].map(i => `<button data-px="cover-pick" data-px-value="${i}" aria-label="Обложка ${i + 1}">${art(i)}</button>`).join('')}</div></div>` : ''}</div>`;
  }
  function metadataFields(s) {
    return `<div class="px-meta-fields"><label class="px-field">Название<input class="input" value="${safe(s.title ?? 'Nightline')}" data-px-field="title"></label>${combo('artist', s)}${combo('album', s)}<div class="px-meta-small-fields"><label class="px-field">Год<input class="input" type="number" value="${safe(s.year ?? '2024')}" min="1900" max="2100" data-px-field="year"></label><label class="px-field">Трек<input class="input" type="number" value="${safe(s.trackNumber ?? '1')}" min="1" data-px-field="trackNumber"></label><label class="px-field">Диск<input class="input" type="number" value="${safe(s.discNumber ?? '1')}" min="1" data-px-field="discNumber"></label></div><label class="px-field">Жанр<input class="input" value="${safe(s.genre ?? 'Electronic')}" data-px-field="genre"></label></div>`;
  }
  function metadataScreen(variant) {
    const s = state('metadata', variant);
    const body = variant === 'a' ? `<div class="px-metadata-title">${coverPicker(s)}<div><strong>Nightline</strong><span>Serein · FLAC</span><small>44,1 кГц · 24 бит</small></div></div>${metadataFields(s)}` : `<div class="px-metadata-columns"><aside>${coverPicker(s)}<strong>Nightline</strong><span>Serein</span><div class="px-file-info"><span>FLAC</span><span>44,1 кГц · 24 бит</span><span>4:32 · 31,2 МБ</span></div><button class="px-text-button" data-px="restore">${ico('refresh', 14)} Восстановить</button></aside>${metadataFields(s)}</div>`;
    return scope('metadata', variant, `<div class="px-page-head"><h1>Данные трека</h1><button class="btn" data-px="metadata-reopen">Открыть редактор</button></div><div class="px-modal-stage px-meta-stage">${backdrop()}${s.dismissed ? `<button class="btn primary px-reopen" data-px="metadata-reopen">Изменить данные</button>` : `<div class="px-modal px-metadata-modal">${modalHead('Изменить данные трека')}${body}<footer class="px-modal-foot">${variant === 'a' ? '<button class="px-text-button" data-px="restore">Восстановить исходные</button>' : '<span></span>'}<div class="px-actions"><button class="btn" data-px="dismiss">Отмена</button><button class="btn primary" data-px="metadata-save">${ico('check', 15)} ${s.saved ? 'Сохранено' : 'Сохранить'}</button></div></footer>${s.notice ? `<div class="px-local-notice" role="status">${safe(s.notice)}</div>` : ''}</div>`}</div>`);
  }
  function playlistDialog(s, variant) {
    return `<div class="px-modal px-small-modal">${modalHead('Новый плейлист')}<div class="${variant === 'a' ? 'px-playlist-inline' : 'px-playlist-stack'}"><button class="px-playlist-cover" data-px="playlist-cover" aria-label="Выбрать обложку">${s.playlistArt ? art(1) : ico('plus', 30)}</button><div><label class="px-field">Название<input class="input" placeholder="Название плейлиста" value="${safe(s.playlistName || '')}" data-px-field="playlistName"></label><label class="px-field px-playlist-description">Описание<textarea class="input" rows="2" placeholder="Необязательно"></textarea></label></div></div><footer class="px-modal-foot"><button class="btn" data-px="dismiss">Отмена</button><button class="btn primary" data-px="playlist-save">${ico('plus', 15)} ${s.saved ? 'Создано' : 'Создать'}</button></footer>${s.notice ? `<div class="px-local-notice" role="status">${safe(s.notice)}</div>` : ''}</div>`;
  }
  function cacheDialog(s, variant) {
    const downloads = [['Nightline', 'Сохранён', 100, 0], ['Glass Tides', '7,4 из 12,6 МБ', 59, 1], ['Red Corridor', 'В очереди', 0, 2], ['Still Water', 'В очереди', 0, 0]];
    return `<div class="px-modal px-cache-modal">${modalHead('Загрузки')}<div class="px-cache-summary"><span>${ico('download', 19)} 2 из 4 треков</span><button class="btn" data-px="cache-pause">${s.paused ? ico('play', 14) + ' Продолжить' : ico('pause', 14) + ' Пауза'}</button></div><div class="px-download-items ${variant === 'b' ? 'px-download-card-grid' : ''}">${downloads.map((d, i) => `<div class="px-download-item">${art(d[3])}<div><strong>${d[0]}</strong><small>${s.paused && i === 1 ? 'Приостановлено' : d[1]}</small>${d[2] > 0 && d[2] < 100 ? `<div class="px-download-bar"><i style="width:${d[2]}%"></i></div>` : ''}</div><span>${ico(i === 0 ? 'check' : i === 1 ? 'download' : 'clock', 16)}</span></div>`).join('')}</div><footer class="px-modal-foot"><span class="px-muted">Ночной маршрут</span><button class="btn" data-px="dismiss">Закрыть</button></footer></div>`;
  }
  function equalizerDialog(s, variant) {
    const gains = [4, 7, 2, 0, -3, -2, 1, 4, 6, 2];
    return `<div class="px-modal px-eq-modal">${modalHead('Звук')}<div class="px-eq-speed"><span>Скорость трека</span><output>${Number(s.speed || 1).toFixed(2).replace('.', ',')}×</output><input type="range" min=".5" max="2" step=".05" value="${s.speed || 1}" data-px-range="speed" aria-label="Скорость трека"></div><div class="px-section-head"><h3>Эквалайзер</h3><label class="px-switch"><input type="checkbox" checked aria-label="Включить эквалайзер"><i></i></label></div><div class="px-eq-preset"><button class="btn" data-px="eq-presets">${s.preset || 'Электроника'} ${ico('chevron', 14)}</button><button class="px-text-button" data-px="eq-reset">Сбросить</button>${s.presetsOpen ? `<div class="px-inline-menu">${['Электроника', 'Вокал', 'Больше баса', 'Ровный'].map(p => `<button data-px="eq-preset" data-px-value="${p}">${p}</button>`).join('')}</div>` : ''}</div><div class="px-eq-bands ${variant === 'b' ? 'px-eq-dense' : ''}">${gains.map((g, i) => `<label><output>${s.preset === 'Ровный' ? '0' : g > 0 ? '+' + g : g}</output><input type="range" min="-18" max="18" value="${s.preset === 'Ровный' ? 0 : g}" aria-label="${[32, 64, 125, 250, 500, '1k', '2k', '4k', '8k', '16k'][i]} Гц" data-px-range="gain"><span>${[32, 64, 125, 250, 500, '1k', '2k', '4k', '8k', '16k'][i]}</span></label>`).join('')}</div><footer class="px-modal-foot"><button class="px-text-button" data-px="eq-save">${ico('plus', 14)} Сохранить пресет</button><button class="btn" data-px="dismiss">Готово</button></footer>${s.notice ? `<div class="px-local-notice" role="status">${safe(s.notice)}</div>` : ''}</div>`;
  }
  function dialogsScreen(variant) {
    const s = state('dialogs', variant);
    return scope('dialogs', variant, `<div class="px-page-head"><h1>Окна и меню</h1></div><div class="px-toolbar"><div class="px-segment">${[['playlist', 'Плейлист'], ['cache', 'Загрузки'], ['equalizer', 'Звук']].map(([key, label]) => `<button data-px="dialog-tab" data-px-value="${key}" aria-pressed="${s.dialog === key}">${label}</button>`).join('')}</div><button class="btn" data-px="dialog-reopen">Открыть</button></div><div class="px-modal-stage">${backdrop()}${s.dismissed ? '<button class="btn primary px-reopen" data-px="dialog-reopen">Открыть окно</button>' : s.dialog === 'cache' ? cacheDialog(s, variant) : s.dialog === 'equalizer' ? equalizerDialog(s, variant) : playlistDialog(s, variant)}</div>`);
  }
  const screens = {albums: albumScreen, profile: profileScreen, mini: miniScreen, update: updateScreen, metadata: metadataScreen, dialogs: dialogsScreen};
  window.polishExtraScreens = screens;
  function redraw(el) {
    const root = el.closest('.px-scope');
    if (root) root.outerHTML = screens[root.dataset.pxScreen](root.dataset.pxVariant);
  }
  function filter(root, query, cachedOnly) {
    let visible = 0;
    root.querySelectorAll('.px-album-card').forEach(card => { const show = card.dataset.pxSearch.includes(query.toLowerCase()) && (!cachedOnly || card.dataset.pxCache === 'true'); card.hidden = !show; if (show) visible++; });
    const empty = root.querySelector('.px-empty');
    if (empty) empty.hidden = visible > 0;
  }
  document.addEventListener('input', event => {
    const el = event.target;
    const root = el.closest?.('.px-scope');
    if (!root) return;
    const s = state(root.dataset.pxScreen, root.dataset.pxVariant);
    if (el.dataset.pxField) s[el.dataset.pxField] = el.value;
    if (el.dataset.pxFilter === 'albums') { s.query = el.value; filter(root, s.query, s.tab === 'cached'); }
    if (el.dataset.pxComboSearch) {
      const comboRoot = el.closest('.px-combo');
      comboRoot.querySelectorAll('.px-combo-results button').forEach(item => { item.hidden = !item.dataset.pxSearch.includes(el.value.toLowerCase()); });
      comboRoot.querySelector('[data-px-create-label]').textContent = el.value.trim() ? `Создать «${el.value.trim()}»` : `Создать ${el.dataset.pxComboSearch === 'artist' ? 'исполнителя' : 'альбом'}`;
    }
    if (el.dataset.pxRange === 'seek') { s.position = Number(el.value); root.querySelector('[data-px-time]').textContent = `${Math.floor(s.position / 60)}:${String(s.position % 60).padStart(2, '0')}`; el.style.setProperty('--px-fill', `${s.position / 272 * 100}%`); }
    if (el.dataset.pxRange === 'speed') { s.speed = el.value; el.closest('.px-eq-speed').querySelector('output').textContent = `${Number(el.value).toFixed(2).replace('.', ',')}×`; }
    if (el.dataset.pxRange === 'gain') el.closest('label').querySelector('output').textContent = Number(el.value) > 0 ? `+${el.value}` : el.value;
  });
  document.addEventListener('click', event => {
    const el = event.target.closest?.('[data-px]');
    const root = el?.closest('.px-scope');
    if (!root) return;
    const screen = root.dataset.pxScreen, variant = root.dataset.pxVariant, s = state(screen, variant);
    const action = el.dataset.px, value = el.dataset.pxValue;
    switch (action) {
      case 'album-select': s.selected = Number(value); s.detail = true; break;
      case 'album-close': s.detail = false; break;
      case 'album-sort': s.sort = !s.sort; break;
      case 'album-tab': s.tab = value; break;
      case 'album-menu': s.menu = !s.menu; break;
      case 'album-download': s.menu = false; break;
      case 'album-play': el.innerHTML = `${ico('pause', 15)} ${el.classList.contains('btn') ? 'Играет' : ''}`; return;
      case 'like': case 'mini-like': s.liked = !s.liked; break;
      case 'activity': s.activity = value; break;
      case 'period': s.period = value; break;
      case 'name-edit': s.editing = true; break;
      case 'name-save': s.editing = false; s.nickname = s.nickname.trim() || 'Слушатель'; break;
      case 'avatar': s.avatarOpen = !s.avatarOpen; break;
      case 'avatar-pick': s.avatar = Number(value); s.avatarOpen = false; break;
      case 'history': s.history = !s.history; break;
      case 'mini-play': s.playing = !s.playing; break;
      case 'mini-shuffle': s.shuffle = !s.shuffle; break;
      case 'mini-expand': s.expanded = !s.expanded; break;
      case 'mini-volume': s.volume = !s.volume; break;
      case 'next': case 'prev': s.position = 0; break;
      case 'dismiss': s.dismissed = true; break;
      case 'update-skip': s.dismissed = true; break;
      case 'update-reset': s.dismissed = false; s.phase = 'offer'; s.progress = 0; break;
      case 'update-start': {
        if (s.phase === 'ready') { s.phase = 'offer'; s.progress = 0; break; }
        s.phase = 'downloading'; s.progress = 0;
        const tick = () => {
          if (s.phase !== 'downloading') return;
          s.progress = Math.min(100, s.progress + 10);
          if (s.progress === 100) s.phase = 'ready';
          const current = document.querySelector(`.px-scope[data-px-screen="update"][data-px-variant="${variant}"]`);
          if (current) redraw(current);
          if (s.phase === 'downloading') window.setTimeout(tick, 300);
        };
        window.setTimeout(tick, 300); break;
      }
      case 'combo': s.combo = s.combo === value ? '' : value; break;
      case 'combo-select': s[el.dataset.pxField] = value; s.combo = ''; break;
      case 'combo-create': {
        const input = root.querySelector(`[data-px-combo-search="${el.dataset.pxField}"]`);
        const name = input?.value.trim();
        if (!name) { input?.focus(); return; }
        s[el.dataset.pxField] = name; s.combo = ''; s.notice = el.dataset.pxField === 'artist' ? 'Новый исполнитель' : 'Новый альбом'; break;
      }
      case 'cover-open': s.coverOpen = !s.coverOpen; break;
      case 'cover-pick': s.cover = Number(value); s.coverOpen = false; break;
      case 'cover-local': s.notice = 'В приложении откроется выбор файла'; s.coverOpen = false; break;
      case 'metadata-save': s.saved = true; s.notice = 'Данные сохранены'; break;
      case 'metadata-reopen': s.dismissed = false; s.saved = false; s.notice = ''; break;
      case 'restore': s.artist = 'Serein'; s.album = 'Nightline'; s.cover = 0; s.title = 'Nightline'; s.year = '2024'; s.trackNumber = '1'; s.discNumber = '1'; s.genre = 'Electronic'; s.notice = 'Исходные данные восстановлены'; break;
      case 'dialog-tab': s.dialog = value; s.dismissed = false; s.saved = false; s.notice = ''; break;
      case 'dialog-reopen': s.dismissed = false; break;
      case 'playlist-cover': s.playlistArt = !s.playlistArt; break;
      case 'playlist-save': s.saved = Boolean(s.playlistName?.trim()); s.notice = s.saved ? `Плейлист «${s.playlistName.trim()}» создан` : 'Введите название'; break;
      case 'cache-pause': s.paused = !s.paused; break;
      case 'eq-presets': s.presetsOpen = !s.presetsOpen; break;
      case 'eq-preset': s.preset = value; s.presetsOpen = false; break;
      case 'eq-reset': s.preset = 'Ровный'; break;
      case 'eq-save': s.notice = 'Пресет сохранён'; break;
      default: return;
    }
    redraw(root);
    const updated = document.querySelector(`.px-scope[data-px-screen="${screen}"][data-px-variant="${variant}"]`);
    if (screen === 'albums' && updated) filter(updated, s.query, s.tab === 'cached');
    if (action === 'combo' && s.combo) updated?.querySelector('[data-px-combo-search]')?.focus();
    if (action === 'combo-select' || action === 'combo-create') updated?.querySelector(`[data-px-combo="${el.dataset.pxField}"] .px-combo-trigger`)?.focus();
  });
  document.addEventListener('keydown', event => {
    const root = event.target.closest?.('.px-scope');
    if (!root) return;
    const s = state(root.dataset.pxScreen, root.dataset.pxVariant);
    const comboRoot = event.target.closest('.px-combo');
    if (comboRoot && s.combo) {
      const options = Array.from(comboRoot.querySelectorAll('.px-combo-results button:not([hidden])'));
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const index = options.indexOf(event.target);
        const next = event.key === 'ArrowDown' ? (index + 1) % options.length : (index <= 0 ? options.length - 1 : index - 1);
        options[next]?.focus();
        return;
      }
      if (event.key === 'Enter' && event.target.matches('[data-px-combo-search]')) {
        event.preventDefault();
        (options[0] || comboRoot.querySelector('.px-create-option'))?.click();
        return;
      }
    }
    if (event.key === 'Escape') {
      if (s.combo || s.coverOpen) { const field = s.combo, screen = root.dataset.pxScreen, variant = root.dataset.pxVariant; s.combo = ''; s.coverOpen = false; redraw(root); document.querySelector(`.px-scope[data-px-screen="${screen}"][data-px-variant="${variant}"] [data-px-combo="${field}"] .px-combo-trigger`)?.focus(); }
      else if (['metadata', 'update', 'dialogs'].includes(root.dataset.pxScreen)) { s.dismissed = true; redraw(root); }
    }
    if (event.key === 'Enter' && event.target.matches('[data-px-field="nickname"]')) { s.nickname = event.target.value.trim() || 'Слушатель'; s.editing = false; redraw(root); }
  });
})();
