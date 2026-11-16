import {
  AudioLines, Captions, ChevronDown, Cloud, EyeOff, FolderOpen, HardDrive,
  Image, Info, LibraryBig, Music2, Palette, Plug, Power, RefreshCw,
  SlidersHorizontal, Volume2,
} from 'lucide-react'
import { useT } from '../../i18n'

export const SETTINGS_NAV = [
  {
    id: 'general', label: 'General', Icon: SlidersHorizontal, sections: [
      { id: 'startup', label: 'Startup and system', Icon: Power },
      { id: 'audio', label: 'Sound', Icon: Volume2 },
      { id: 'processing', label: 'Additional processing', Icon: AudioLines },
      { id: 'integrations', label: 'Integrations', Icon: Plug },
      { id: 'soundcloud', label: 'SoundCloud', Icon: Cloud },
    ],
  },
  {
    id: 'appearance', label: 'Appearance', Icon: Palette, sections: [
      { id: 'themes', label: 'Themes and fonts', Icon: Palette },
      { id: 'wallpaper', label: 'Background image', Icon: Image },
      { id: 'player', label: 'Player', Icon: Music2 },
      { id: 'lyrics', label: 'Lyrics', Icon: Captions },
      { id: 'visualizers', label: 'Visualizers', Icon: AudioLines },
    ],
  },
  {
    id: 'library', label: 'Library', Icon: LibraryBig, sections: [
      { id: 'folders', label: 'Music folders', Icon: FolderOpen },
      { id: 'hidden', label: 'Hidden tracks', Icon: EyeOff },
    ],
  },
  {
    id: 'storage', label: 'Storage', Icon: HardDrive, sections: [
      { id: 'music-cache', label: 'SoundCloud cache', Icon: HardDrive },
      { id: 'covers-cache', label: 'Cover cache', Icon: Image },
    ],
  },
  {
    id: 'about', label: 'About', Icon: Info, sections: [
      { id: 'updates', label: 'Updates', Icon: RefreshCw },
      { id: 'application', label: 'About Tempo', Icon: Info },
    ],
  },
] as const

export type SettingsArea = (typeof SETTINGS_NAV)[number]['id']
export type SettingsSectionId = (typeof SETTINGS_NAV)[number]['sections'][number]['id']

export function SettingsNavigation({ area, expanded, section, onArea, onSection }: {
  area: SettingsArea
  expanded: boolean
  section: SettingsSectionId | null
  onArea: (area: SettingsArea) => void
  onSection: (section: SettingsSectionId, focusHeading: boolean) => void
}) {
  const t = useT()
  return (
    <nav className="set-nav" aria-label={t('Settings')}>
      {SETTINGS_NAV.map(({ id, label, Icon, sections }) => {
        const open = area === id && expanded
        return (
          <div key={id} className="set-nav-group">
            <button type="button" className={area === id ? 'set-nav-item is-active' : 'set-nav-item'}
              onClick={() => onArea(id)} aria-expanded={open}
              aria-controls={`settings-nav-${id}`}>
              <Icon size={16} aria-hidden="true" />
              <span>{t(label)}</span>
              <ChevronDown className="set-nav-arrow" size={14} aria-hidden="true" />
            </button>
            <div className="set-nav-children" id={`settings-nav-${id}`} data-expanded={open} aria-hidden={!open}
              ref={element => { if (element) element.inert = !open }}>
              <div className="set-nav-children-clip">
                <div className="set-nav-links">
                  {sections.map((item) => (
                    <button key={item.id} type="button" className="set-nav-child"
                      aria-current={section === item.id ? 'location' : undefined}
                      aria-controls={`settings-section-${item.id}`}
                      onClick={event => onSection(item.id, event.detail === 0)}>
                      {t(item.label)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </nav>
  )
}
