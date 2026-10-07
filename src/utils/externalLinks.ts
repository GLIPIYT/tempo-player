import { openUrl } from '@tauri-apps/plugin-opener'

/** Open an absolute web URL in the system browser. */
export async function openExternalUrl(url: string): Promise<void> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported external URL protocol: ${parsed.protocol}`)
  }
  await openUrl(parsed.href)
}
