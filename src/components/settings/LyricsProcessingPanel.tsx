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
import type { AnalysisSnapshot } from '../../features/lyrics/analysis/runner'
import type { VocalSnapshot } from '../../features/lyrics/analysis/vocalRunner'
import './lyricsProcessing.css'

interface Props {
  vocalEnabled: boolean
  wordEnabled: boolean
  wordMode: boolean
  modelState: ModelState
  wordAnalysisState: Pick<AnalysisSnapshot, 'phase' | 'error' | 'unavailableReason'>
  vocalState: Pick<VocalSnapshot, 'phase' | 'error'>
  onVocalChange: (enabled: boolean) => void
  onWordChange: (enabled: boolean) => void
  onRetryModel: () => void
  onRetryAnalysis: () => void
  onRetryVocal: () => void
}

export default function LyricsProcessingPanel({
  vocalEnabled,
  wordEnabled,
  wordMode,
  modelState,
  wordAnalysisState,
  vocalState,
  onVocalChange,
  onWordChange,
  onRetryModel,
  onRetryAnalysis,
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
        ? t('Audio unavailable for analysis')
        : vocalState.phase === 'loading'
          ? t('Preparing audio')
          : vocalState.phase === 'analyzing'
            ? t('Analyzing vocals')
            : vocalState.phase === 'waiting'
              ? t('Analysis queued')
              : vocalState.phase === 'complete'
                ? t('Track analyzed')
                : t('Ready')
  const progress =
    modelState.totalBytes > 0
      ? Math.min(
          100,
          Math.max(0, (modelState.loadedBytes / modelState.totalBytes) * 100),
        )
      : 0
  const wordEnabledInMode = wordEnabled && wordMode
  const wordModelChecking = wordEnabledInMode && modelState.phase === 'checking'
  const wordModelDownloading = wordEnabledInMode && modelState.phase === 'downloading'
  const wordAnalysisWorking = wordEnabledInMode &&
    ['loading', 'analyzing', 'waiting'].includes(wordAnalysisState.phase)
  const wordWorking = wordModelChecking || wordModelDownloading || wordAnalysisWorking
  const wordPaused = wordEnabledInMode && wordAnalysisState.phase === 'paused'
  const wordAnalysisUnavailable = wordEnabledInMode && wordAnalysisState.phase === 'unavailable'
  const wordError = wordEnabledInMode && (modelState.phase === 'error' || wordAnalysisState.phase === 'error')
  const wordErrorMessage = modelState.phase === 'error' ? modelState.error : wordAnalysisState.error
  const wordModelReady = wordEnabledInMode && modelState.phase === 'ready'
  const wordLabel = !wordEnabled
    ? t('Off')
    : !wordMode
      ? t('Use word-by-word mode to run analysis')
      : wordModelChecking
        ? t('Checking model files')
      : wordModelDownloading
        ? t('Downloading model')
        : modelState.phase === 'error'
          ? t('Model download failed')
          : wordAnalysisState.phase === 'loading'
            ? t('Preparing audio')
            : wordAnalysisState.phase === 'analyzing'
              ? t('Analyzing word timings')
              : wordAnalysisState.phase === 'waiting'
                ? t('Analysis queued')
                : wordPaused
                  ? t('Paused — play to analyze')
                  : wordAnalysisState.phase === 'complete'
                    ? t('Track analyzed')
                    : wordAnalysisUnavailable
                      ? wordAnalysisState.unavailableReason === 'unreadable-file'
                        ? t('Audio file could not be read for analysis')
                        : t('No local or cached audio file found')
                      : wordAnalysisState.phase === 'error'
                        ? t('Word timing analysis failed')
                        : modelState.phase === 'ready'
                          ? t('Model ready')
                          : t('Preparing model download')
  const wordNote = modelState.phase === 'ready'
    ? t('Model is available on this computer.')
    : modelState.phase === 'checking'
      ? t('Checking local model files.')
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
              {t('Model is available on this computer.')}
            </p>
            {vocalError && vocalState.error ? (
              <details className="processing-error">
                <summary>{t('Details')}</summary>
                <p>{vocalState.error}</p>
              </details>
            ) : null}
            {vocalError || vocalUnavailable ? (
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
            className={`processing-state ${wordError ? 'is-error' : wordWorking ? 'is-working' : wordModelReady ? 'is-ready' : 'is-idle'}`}
            role="status"
          >
            <span className="processing-state-label">{t('Readiness')}</span>
            <div className="processing-state-main">
              {wordError ? (
                <AlertTriangle size={15} />
              ) : wordWorking ? (
                <LoaderCircle size={15} className="spin" />
              ) : wordPaused ? (
                <Circle size={14} />
              ) : wordAnalysisUnavailable ? (
                <AlertTriangle size={15} />
              ) : wordAnalysisState.phase === 'complete' || wordModelReady ? (
                <CheckCircle2 size={15} />
              ) : (
                <Download size={15} />
              )}
              <strong>{wordLabel}</strong>
              {wordModelDownloading && (
                <span className="processing-percent">
                  {Math.floor(progress)}%
                </span>
              )}
            </div>
            {wordModelDownloading ? (
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
              <p className="processing-state-note">
                {wordNote}
              </p>
            )}
            {wordError && wordErrorMessage ? (
              <details className="processing-error">
                <summary>{t('Details')}</summary>
                <p>{wordErrorMessage}</p>
              </details>
            ) : null}
            {(wordError || wordAnalysisUnavailable) && wordEnabled && wordMode ? (
              <button
                type="button"
                className="processing-retry"
                onClick={modelState.phase === 'error' ? onRetryModel : onRetryAnalysis}
              >
                <RefreshCw size={12} />
                {modelState.phase === 'error' ? t('Retry download') : t('Retry analysis')}
              </button>
            ) : null}
          </div>
        </article>
      </div>
    </section>
  )
}
