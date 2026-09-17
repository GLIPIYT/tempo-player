import { useEffect } from 'react'
import { api } from '../api/client'
import { useSettings } from '../state/settings'

/**
 * Fetches and refreshes the app's own yt-dlp, without being asked.
 *
 * Nobody downloads a music player in order to then go and install a Python
 * tool and keep it current, so this runs once at startup: it fetches the
 * standalone build if there is none, and replaces it when GitHub has a newer
 * one. A path set by hand is left alone.
 *
 * Failure is silent on purpose. YouTube is one source among several, and an
 * unreachable GitHub should not put an error in front of someone who never
 * asked for YouTube in the first place - the settings page reports the state
 * when it is actually relevant.
 */
export default function YtdlpBootstrapper() {
  const { settings } = useSettings()
  const configured = settings.ytdlp.path

  useEffect(() => {
    void api.ytdlpEnsure(configured).catch(() => undefined)
  }, [configured])

  return null
}
