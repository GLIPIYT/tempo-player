import { useEffect } from 'react'
import { useSettings } from '../../state/settings'
import { discordSettingsChanged, startDiscordDriver } from '../../integration/discordDriver'

/**
 * Discord Rich Presence bridge. LyricsAnalysisBridge owns background lyrics.
 * All presence logic lives in the event-driven driver (discordDriver.ts);
 * this component only mounts it once and feeds it settings changes.
 */
export default function PresenceBridge() {
  const { settings } = useSettings()
  // start the presence driver once
  useEffect(() => startDiscordDriver(), [])

  // push enable/disable and language changes into the driver
  useEffect(() => {
    discordSettingsChanged()
  }, [settings.discord.enabled, settings.discord.clientId, settings.discord.lyricStitchGapSec, settings.lang])

  return null
}
