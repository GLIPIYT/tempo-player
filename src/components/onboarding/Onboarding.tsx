import { useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { Disc3, FolderPlus, Search, User } from 'lucide-react'
import { useNav } from '../../state/nav'
import { useSettings } from '../../state/settings'
import { useFolders } from '../../hooks/useFolders'
import { api } from '../../api/client'
import { useT } from '../../i18n'
import appIcon from '../../assets/app-icon.png'

export default function Onboarding() {
  const { settings, update } = useSettings()
  const t = useT()
  const navigate = useNav().navigate
  const foldersApi = useFolders()
  const [step, setStep] = useState(0)
  const [name, setName] = useState(settings.profile.nickname ?? '')
  const [avatarBusy, setAvatarBusy] = useState(false)

  if (settings.profile.onboarded) return null

  const initials = (name.trim() || '?').slice(0, 2).toUpperCase()
  const finish = () => update({ profile: { onboarded: true } })
  const saveName = () => update({ profile: { nickname: name.trim() || null } })

  const nextFromName = () => {
    saveName()
    setStep(1)
  }

  const changeAvatar = async () => {
    setAvatarBusy(true)
    try {
      const sel = await open({
        multiple: false,
        filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      })
      if (typeof sel === 'string') {
        const stored = await api.importAvatar(sel)
        update({ profile: { avatarPath: stored } })
      }
    } catch {} finally {
      setAvatarBusy(false)
    }
  }

  const importFolders = async () => {
    await foldersApi.addFolder()
    finish()
  }

  return (
    <div className="onb-backdrop">
      <div className="onb-card" key={step}>
        <div className="onb-dots">
          {[0, 1, 2].map((i) => (
            <span key={i} className={i === step ? 'onb-dot is-active' : 'onb-dot'} />
          ))}
        </div>

        {step === 0 ? (
          <>
            <img className="onb-icon" src={appIcon} alt="" draggable={false} />
            <h1 className="onb-title">{t('Welcome to Tempo')}</h1>
            <p className="onb-sub">{t('A local-first player. No accounts, no cloud — just your music.')}</p>
            <label className="onb-label">{t('What should we call you?')}</label>
            <input
              className="text-input onb-input"
              autoFocus
              value={name}
              maxLength={32}
              placeholder={t('Your name')}
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) nextFromName()
              }}
            />
            <div className="onb-actions">
              <button className="btn" onClick={finish}>
                {t('Skip')}
              </button>
              <button className="btn btn-primary" disabled={!name.trim()} onClick={nextFromName}>
                {t('Next')}
              </button>
            </div>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <h1 className="onb-title">{t('Pick an avatar')}</h1>
            <p className="onb-sub">
              {t('It will show up in your profile. You can change it any time.')}
            </p>
            <div className="onb-avatar-row">
              {settings.profile.avatarPath ? (
                <img
                  className="onb-avatar"
                  src={convertFileSrc(settings.profile.avatarPath)}
                  alt=""
                  draggable={false}
                />
              ) : (
                <div className="onb-avatar onb-avatar-fallback">
                  <User size={40} />
                  <span>{initials}</span>
                </div>
              )}
              <div className="onb-avatar-actions">
                <button className="btn btn-primary" disabled={avatarBusy} onClick={() => void changeAvatar()}>
                  {t('Choose image')}
                </button>
                {settings.profile.avatarPath ? (
                  <button className="btn" onClick={() => update({ profile: { avatarPath: null } })}>
                    {t('Remove avatar')}
                  </button>
                ) : null}
              </div>
            </div>
            <div className="onb-actions">
              <button className="btn" onClick={() => setStep(0)}>
                {t('Back')}
              </button>
              <button className="btn btn-primary" onClick={() => setStep(2)}>
                {t('Next')}
              </button>
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <h1 className="onb-title">{t('Add your music')}</h1>
            <p className="onb-sub">{t('Import local folders or find something on SoundCloud. You can do both later in Settings.')}</p>
            <div className="onb-choices">
              <button className="onb-choice" disabled={foldersApi.busy} onClick={() => void importFolders()}>
                <FolderPlus size={26} />
                <span className="onb-choice-title">{t('Import music folders')}</span>
                <span className="onb-choice-sub">{t('MP3, FLAC, OGG and more — scanned locally')}</span>
              </button>
              <button
                className="onb-choice"
                onClick={() => {
                  finish()
                  navigate({ name: 'search' })
                }}
              >
                <Search size={26} />
                <span className="onb-choice-title">{t('Find music on SoundCloud')}</span>
                <span className="onb-choice-sub">{t('Search and stream right away')}</span>
              </button>
            </div>
            <div className="onb-actions">
              <button className="btn" onClick={() => setStep(1)}>
                {t('Back')}
              </button>
              <button className="btn btn-primary" onClick={finish}>
                <Disc3 size={14} />
                {t('Get started')}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
