import { useScanProgress } from '../../hooks/useScanProgress'
import { useT } from '../../i18n'

export default function ScanLine() {
  const t = useT()
  const { progress, active } = useScanProgress()
  if (!active || !progress) return null
  const file = progress.currentFile ? ` (${progress.currentFile})` : ''
  const errs = progress.errors > 0 ? ` · ${progress.errors} ${t('errors')}` : ''
  return (
    <div className="scanline">
      {t('Scanned')} {progress.scannedFiles} · +{progress.added} ~{progress.updated} -{progress.removed}
      {errs}
      {file}
    </div>
  )
}
