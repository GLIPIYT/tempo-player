import { useEffect } from 'react'
import { usePlayer } from '../../player'
import { useSettings } from '../../state/settings'
import { lyricsService } from '../../features/lyrics/lyricsService'
import { discordSettingsChanged, startDiscordDriver } from '../../integration/discordDriver'

/**
 * Background lyrics prefetch + Discord Rich Presence bridge.
 * All presence logic lives in the event-driven driver (discordDriver.ts);
 * this component only mounts it once and feeds it settings changes.
 */
export default function PresenceBridge() {
  const { settings } = useSettings()
  const { currentTrack } = usePlayer()
  const track = currentTrack

  // prefetch lyrics for the current track (the driver + overlay both read them)
  useEffect(() => {
    if (track) lyricsService.ensure(track, settings.lyrics.cacheOnline)
    // track identity is the trigger; position is intentionally excluded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.sourceId, settings.lyrics.cacheOnline])

  // start the presence driver once
  useEffect(() => startDiscordDriver(), [])

  // push enable/disable and language changes into the driver
  useEffect(() => {
    discordSettingsChanged()
  }, [settings.discord.enabled, settings.discord.clientId, settings.lang])

  return null
}
