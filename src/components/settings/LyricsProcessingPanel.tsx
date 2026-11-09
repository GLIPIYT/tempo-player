import {
  AlertTriangle,
  AudioLines,
  CheckCircle2,
  Circle,
  Download,
  LoaderCircle,
  RefreshCw,
  SlidersHorizontal,
  TextCursorInput,
} from 'lucide-react'
import { useT } from '../../i18n'
import type { ModelState } from '../../features/lyrics/analysis/contract'
import type { VocalSnapshot } from '../../features/lyrics/analysis/vocalRunner'
import './lyricsProcessing.css'

interface Props {
  vocalEnabled: boolean
  wordEnabled: boolean
  wordMode: boolean
  modelState: ModelState
  vocalState: Pick<VocalSnapshot, 'phase' | 'error'>
  onVocalChange: (enabled: boolean) => void
  onWordChange: (enabled: boolean) => void
  onRetryModel: () => void
  onRetryVocal: () => void
}

export default function LyricsProcessingPanel({
  vocalEnabled,
  wordEnabled,
  wordMode,
  modelState,
  vocalState,
  onVocalChange,
  onWordChange,
  onRetryModel,
  onRetryVocal,
}: Props) {
  const t = useT()
  const vocalTitle = t('Refine timing from vocals')
  const wordTitle = t('Refine word timing')
  const vocalWorking =
    vocalEnabled &&
    ['loading', 'analyzing', 'waiting'].includes(vocalState.phase)
  const vocalError = vocalEnabled && vocalState.phase === 'error'
  const vocalUnavailable = vocalEnabled && vocalState.phase === 'unavailable'
  const vocalLabel = !vocalEnabled
    ? t('Off')
    : vocalError
      ? t('Vocal timing analysis failed')
      : vocalUnavailable
        ? t('Audio file required')
        : vocalState.phase === 'loading'
          ? t('Preparing audio')
          : vocalState.phase === 'analyzing'
            ? t('Analyzing vocals')
            : vocalState.phase === 'waiting'
              ? t('Analysis queued')
              : vocalState.phase === 'complete'
                ? t('Track analyzed')
                : t('Ready for analysis')
  const progress =
    modelState.totalBytes > 0
      ? Math.min(
          100,
          Math.max(0, (modelState.loadedBytes / modelState.totalBytes) * 100),
        )
      : 0
  const wordWorking = modelState.phase === 'downloading'
  const wordReady = modelState.phase === 'ready'
  const wordError = modelState.phase === 'error'
  const wordLabel = wordWorking
    ? t('Downloading model')
    : wordReady
      ? t('Ready')
      : wordError
        ? t('Model download failed')
        : wordEnabled && wordMode
          ? t('Preparing model download')
          : t('Not downloaded')
  const wordNote =
    wordEnabled && !wordMode
      ? t('Only used in word-by-word mode')
      : wordReady
        ? t('Model is stored on this computer.')
        : t(
            'The model downloads when this option is enabled in word-by-word mode.',
          )
  const size = (bytes: number) => (bytes / 1048576).toFixed(1)
  return (
    <section
      className="set-card processing-card"
      aria-labelledby="lyrics-processing-title"
    >
      <h3
        className="set-card-title processing-title"
        id="lyrics-processing-title"
      >
        <SlidersHorizontal size={16} />
        {t('Additional processing')}
      </h3>
      <div className="processing-warning" role="note">
        <AlertTriangle size={18} />
        <p>
          {t(
            'These features use external models on your computer. Active analysis can increase CPU and memory usage.',
          )}
        </p>
      </div>
      <div className="processing-features">
        <article className="processing-feature">
          <div className="processing-feature-heading">
            <AudioLines size={19} />
            <h4>{vocalTitle}</h4>
            <button
              type="button"
              className={vocalEnabled ? 'switch is-on' : 'switch'}
              role="switch"
              aria-checked={vocalEnabled}
              aria-label={vocalTitle}
              onClick={() => onVocalChange(!vocalEnabled)}
            />
          </div>
          <p className="processing-description">
            {t(
              'Finds vocal passages to refine line endings. Uses local and cached tracks.',
            )}
          </p>
          <div
            className={`processing-state ${vocalError ? 'is-error' : vocalWorking ? 'is-working' : vocalEnabled && !vocalUnavailable ? 'is-ready' : 'is-idle'}`}
            role="status"
          >
            <span className="processing-state-label">{t('Readiness')}</span>
            <div className="processing-state-main">
              {vocalError ? (
                <AlertTriangle size={15} />
              ) : vocalWorking ? (
                <LoaderCircle size={15} className="spin" />
              ) : vocalEnabled && !vocalUnavailable ? (
                <CheckCircle2 size={15} />
              ) : (
                <Circle size={14} />
              )}
              <strong>{vocalLabel}</strong>
            </div>
            <p className="processing-state-note">
              {t('The vocal model is included with Tempo.')}
            </p>
            {vocalError && vocalState.error ? (
              <details className="processing-error">
                <summary>{t('Details')}</summary>
                <p>{vocalState.error}</p>
              </details>
            ) : null}
            {vocalError ? (
              <button
                type="button"
                className="processing-retry"
                onClick={onRetryVocal}
              >
                <RefreshCw size={12} />
                {t('Retry')}
              </button>
            ) : null}
          </div>
        </article>
        <article className="processing-feature">
          <div className="processing-feature-heading">
            <TextCursorInput size={19} />
            <h4>{wordTitle}</h4>
            <button
              type="button"
              className={wordEnabled ? 'switch is-on' : 'switch'}
              role="switch"
              aria-checked={wordEnabled}
              aria-label={wordTitle}
              onClick={() => onWordChange(!wordEnabled)}
            />
          </div>
          <p className="processing-description">
            {t(
              'Aligns known lyrics with local or cached audio for more accurate word highlighting. Used in word-by-word mode.',
            )}
          </p>
          <div
            className={`processing-state ${wordError ? 'is-error' : wordWorking ? 'is-working' : wordReady ? 'is-ready' : 'is-idle'}`}
            role="status"
          >
            <span className="processing-state-label">{t('Readiness')}</span>
            <div className="processing-state-main">
              {wordError ? (
                <AlertTriangle size={15} />
              ) : wordWorking ? (
                <LoaderCircle size={15} className="spin" />
              ) : wordReady ? (
                <CheckCircle2 size={15} />
              ) : (
                <Download size={15} />
              )}
              <strong>{wordLabel}</strong>
              {wordWorking && (
                <span className="processing-percent">
                  {Math.floor(progress)}%
                </span>
              )}
            </div>
            {wordWorking ? (
              <>
                <div
                  className="processing-progress"
                  role="progressbar"
                  aria-label={t('Downloading model')}
                  aria-valuenow={Math.floor(progress)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span style={{ width: `${progress}%` }} />
                </div>
                <p className="processing-state-note processing-bytes">
                  {size(modelState.loadedBytes)} / {size(modelState.totalBytes)}{' '}
                  MB
                </p>
              </>
            ) : (
              <p className="processing-state-note">{wordNote}</p>
            )}
            {wordError && modelState.error ? (
              <details className="processing-error">
                <summary>{t('Details')}</summary>
                <p>{modelState.error}</p>
              </details>
            ) : null}
            {wordError && wordEnabled && wordMode ? (
              <button
                type="button"
                className="processing-retry"
                onClick={onRetryModel}
              >
                <RefreshCw size={12} />
                {t('Retry download')}
              </button>
            ) : null}
          </div>
        </article>
      </div>
    </section>
  )
}
