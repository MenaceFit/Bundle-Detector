import { useEffect, useMemo, useState } from 'react';
import { VideoPreview } from './VideoPreview';
import { CaptionTimeline } from './CaptionTimeline';
import { TranscriptEditor } from './TranscriptEditor';
import { CaptionProperties } from './CaptionProperties';
import { VideoExportDialog } from './VideoExportDialog';
import { Section } from '../ui/Section';
import { Field } from '../ui/Field';
import { SelectControl } from '../ui/Controls';
import { useVideoStore } from '@/videoproject/store';
import { useStore } from '@/state/store';
import {
  extractAudio,
  ffmpegStatus,
  generateThumbnail,
  isDesktopVideoAvailable,
  loadAudioSamples,
  loadWaveform,
  pickVideo,
  probeVideo,
} from '@/videoproject/pipeline';
import { WhisperEngine, manualTranscript } from '@/transcription/whisper';
import {
  estimateProcessingSec,
  SUPPORTED_LANGUAGES,
  TranscriptionError,
  WHISPER_MODELS,
  type ModelTier,
} from '@/transcription/types';
import { aspectRatioLabel } from '@/ffmpeg';
import { formatBytes, formatTimecode } from '@/utils/format';
import type { FfmpegStatus } from '@/types/desktop';
import { createLogger } from '@/utils/logger';
import { humanizeError } from '@/videoproject/errors';

const log = createLogger('video-captions');

/** The Video Captions workspace: import → transcribe → style → export. */
export function VideoCaptionsWorkspace() {
  const metadata = useVideoStore((state) => state.metadata);
  const [exportOpen, setExportOpen] = useState(false);
  const [status, setStatus] = useState<FfmpegStatus | null>(null);

  useEffect(() => {
    if (!isDesktopVideoAvailable()) return;
    void ffmpegStatus()
      .then(setStatus)
      .catch((error) => log.warn('Statut FFmpeg indisponible', error));
  }, []);

  if (!isDesktopVideoAvailable()) {
    return (
      <div className="vc-empty">
        <h2>Video Captions</h2>
        <p className="hint" style={{ maxWidth: 520, textAlign: 'center' }}>
          Cet atelier pilote FFmpeg pour lire, décoder et réencoder la vidéo : il fonctionne
          uniquement dans l’application de bureau, pas dans un navigateur. Lancez
          <code> npm run dev</code> pour ouvrir la fenêtre Electron.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="vc-body">
        <aside className="vc-left">
          <ImportPanel status={status} onStatusChange={setStatus} />
          {metadata && <TranscriptionPanel />}
          {metadata && <TranscriptEditor />}
        </aside>

        <main className="vc-center">
          {metadata ? <VideoPreview /> : <DropZone />}
          {metadata && <CaptionTimeline />}
        </main>

        <aside className="properties">
          <div className="panel-title">
            Sous-titres
            <button
              type="button"
              className="btn btn-primary btn-sm"
              style={{ float: 'right' }}
              onClick={() => setExportOpen(true)}
              disabled={!metadata}
            >
              Export
            </button>
          </div>
          {metadata ? (
            <CaptionProperties />
          ) : (
            <p className="hint" style={{ padding: 14 }}>Importez une vidéo pour commencer.</p>
          )}
        </aside>
      </div>

      {exportOpen && <VideoExportDialog onClose={() => setExportOpen(false)} />}
    </>
  );
}

function DropZone() {
  return (
    <div className="vc-empty">
      <div className="vc-drop">
        <strong>Déposez votre vidéo ici</strong>
        <span className="hint">MP4, MOV, WebM, MKV</span>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void importVideo()}
        >
          IMPORTER UNE VIDÉO
        </button>
      </div>
    </div>
  );
}

/** Shared import routine, used by the button and by drag & drop. */
async function importVideo(filePath?: string, fileName?: string): Promise<void> {
  const store = useVideoStore.getState();
  const notify = useStore.getState().notify;
  try {
    const chosen = filePath
      ? { path: filePath, name: fileName ?? filePath.split(/[\\/]/).pop() ?? 'video' }
      : await pickVideo();
    if (!chosen) return;

    const metadata = await probeVideo(chosen.path, chosen.name);
    let thumbnail: string | null = null;
    try {
      thumbnail = await generateThumbnail(metadata);
    } catch (error) {
      log.warn('Miniature indisponible', error);
    }
    store.setVideo(metadata, thumbnail);
    notify('success', `Vidéo importée : ${metadata.fileName}`);

    if (metadata.audio) {
      try {
        const wav = await extractAudio(metadata);
        const peaks = await loadWaveform(wav, 900);
        useVideoStore.getState().setAudio(wav, peaks);
      } catch (error) {
        log.warn('Extraction audio impossible', error);
        notify('error', `Audio non extrait : ${humanizeError(error)}`);
      }
    } else {
      notify('info', 'Cette vidéo ne contient pas de piste audio : utilisez le mode manuel.');
    }
  } catch (error) {
    notify('error', `Import impossible : ${humanizeError(error)}`);
  }
}

function ImportPanel({
  status,
  onStatusChange,
}: {
  status: FfmpegStatus | null;
  onStatusChange: (status: FfmpegStatus) => void;
}) {
  const metadata = useVideoStore((state) => state.metadata);
  const thumbnail = useVideoStore((state) => state.thumbnailUrl);
  const clearVideo = useVideoStore((state) => state.clearVideo);

  return (
    <Section title="Vidéo">
      {status && !status.available && (
        <div className="vc-warning">
          <strong>FFmpeg introuvable</strong>
          <p className="hint">{status.error}</p>
          <p className="hint">
            Le plus simple : fermez l’application, relancez <code>npm install</code> dans le
            dossier du projet (FFmpeg y est téléchargé automatiquement), puis <code>npm run dev</code>.
          </p>
          <div className="field-row">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                void window.desktop?.ffmpeg?.status().then(onStatusChange);
              }}
            >
              Revérifier
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                void window.desktop?.ffmpeg?.pickBinary().then((next) => {
                  if (next) onStatusChange(next);
                });
              }}
            >
              Indiquer le binaire…
            </button>
          </div>
        </div>
      )}

      {metadata ? (
        <>
          {thumbnail && <img className="reference-image" src={thumbnail} alt="" />}
          <div className="vc-meta">
            <span>{metadata.fileName}</span>
            <span>
              {metadata.width} × {metadata.height} · {aspectRatioLabel(metadata.width, metadata.height)}
            </span>
            <span>
              {metadata.fps ? `${metadata.fps} fps` : 'fps inconnu'} ·{' '}
              {formatTimecode(metadata.durationSec)}
            </span>
            <span>
              {metadata.videoCodec.toUpperCase()}
              {metadata.audio
                ? ` · ${metadata.audio.codec.toUpperCase()} ${metadata.audio.sampleRate / 1000} kHz ${metadata.audio.channelLayout}`
                : ' · sans audio'}
            </span>
            <span>{formatBytes(metadata.fileSize)}</span>
          </div>
          <div className="field-row">
            <button type="button" className="btn btn-sm" onClick={() => void importVideo()}>
              Remplacer
            </button>
            <button type="button" className="btn btn-sm btn-danger" onClick={clearVideo}>
              Retirer
            </button>
          </div>
        </>
      ) : (
        <button type="button" className="btn btn-primary" onClick={() => void importVideo()}>
          IMPORTER UNE VIDÉO
        </button>
      )}

      {status?.available && (
        <p className="hint">FFmpeg : {status.version ?? 'ok'} ({status.source})</p>
      )}
    </Section>
  );
}

function TranscriptionPanel() {
  const metadata = useVideoStore((state) => state.metadata);
  const audioPath = useVideoStore((state) => state.audioPath);
  const language = useVideoStore((state) => state.language);
  const tier = useVideoStore((state) => state.tier);
  const job = useVideoStore((state) => state.transcription);
  const setLanguage = useVideoStore((state) => state.setLanguage);
  const setTier = useVideoStore((state) => state.setTier);
  const notify = useStore((state) => state.notify);
  const [manualText, setManualText] = useState('');
  const [controller, setController] = useState<AbortController | null>(null);

  const estimate = useMemo(
    () => (metadata ? estimateProcessingSec(metadata.durationSec, tier) : 0),
    [metadata, tier],
  );

  const analyze = async (): Promise<void> => {
    const store = useVideoStore.getState();
    if (!store.metadata || !audioPath) {
      notify('error', "Aucune piste audio exploitable : utilisez le mode manuel.");
      return;
    }

    const abort = new AbortController();
    setController(abort);
    store.setTranscription({ running: true, label: 'Préparation', ratio: 0, error: null });

    try {
      const samples = await loadAudioSamples(audioPath);
      const engine = new WhisperEngine();
      const availability = await engine.isAvailable();
      if (!availability.ok) throw new TranscriptionError(availability.reason ?? 'Moteur indisponible', 'loadingModel');

      const transcript = await engine.transcribe({
        audio: samples,
        sampleRate: 16000,
        language,
        tier,
        signal: abort.signal,
        onProgress: (progress) => useVideoStore.getState().reportTranscription(progress),
      });

      useVideoStore.getState().setTranscript(transcript);
      notify('success', `Transcription terminée : ${transcript.words.length} mots`);
    } catch (error) {
      const message = humanizeError(error);
      useVideoStore.getState().setTranscription({ running: false, ratio: null, error: message });
      notify('error', message);
    } finally {
      setController(null);
    }
  };

  const useManual = (): void => {
    const store = useVideoStore.getState();
    if (!store.metadata || manualText.trim().length === 0) return;
    store.setTranscript(manualTranscript(manualText, 0, store.metadata.durationSec, language === 'auto' ? 'fr' : language));
    notify('success', 'Sous-titres manuels créés — ajustez les timings dans la timeline.');
  };

  return (
    <Section title="Transcription">
      <Field label="Langue">
        <SelectControl
          value={language}
          onChange={setLanguage}
          options={SUPPORTED_LANGUAGES.map((entry) => ({ value: entry.code, label: entry.label }))}
        />
      </Field>

      <Field label="Modèle">
        <SelectControl<ModelTier>
          value={tier}
          onChange={setTier}
          options={(['fast', 'balanced', 'accurate'] as const).map((value) => ({
            value,
            label: `${WHISPER_MODELS[value].label} (~${WHISPER_MODELS[value].downloadMb} Mo)`,
          }))}
        />
        <p className="hint">
          Traitement estimé : ~{Math.round(estimate)} s. Le modèle est téléchargé une seule fois,
          puis fonctionne hors ligne. Tout se calcule sur cette machine.
        </p>
      </Field>

      {job.running ? (
        <>
          <div className="hint">{job.label}</div>
          <div className="progress">
            <div
              className="progress-bar"
              style={{ width: `${(job.ratio ?? 0.15) * 100}%` }}
            />
          </div>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={() => controller?.abort()}
          >
            Annuler
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void analyze()}
          disabled={!audioPath}
        >
          ANALYSER
        </button>
      )}

      {job.error && <p className="hint vc-error">{job.error}</p>}

      <ModelCacheInfo />

      <details>
        <summary className="hint" style={{ cursor: 'pointer' }}>Mode manuel</summary>
        <textarea
          className="input"
          style={{ marginTop: 8 }}
          placeholder="Tapez le texte ; il sera réparti sur la durée puis ajustable mot par mot."
          value={manualText}
          onChange={(event) => setManualText(event.target.value)}
        />
        <button type="button" className="btn btn-sm" onClick={useManual} style={{ marginTop: 6 }}>
          Créer les sous-titres
        </button>
      </details>
    </Section>
  );
}

/**
 * Where the weights live, and a way to throw them away.
 *
 * A download interrupted halfway leaves a truncated file that fails on every
 * later run, and no amount of retrying fixes it — deleting it does.
 */
function ModelCacheInfo() {
  const [status, setStatus] = useState<{ available: boolean; error?: string; cacheDir?: string } | null>(
    null,
  );
  const [clearing, setClearing] = useState(false);
  const notify = useStore((state) => state.notify);
  const asr = window.desktop?.asr;

  useEffect(() => {
    if (!asr) return;
    void asr.status().then(setStatus).catch(() => setStatus(null));
  }, [asr]);

  if (!asr || !status) return null;

  if (!status.available) {
    return (
      <p className="hint vc-error">
        Moteur de reconnaissance vocale indisponible : {status.error ?? 'raison inconnue'}
      </p>
    );
  }

  return (
    <p className="hint">
      Modèles installés dans <code>{status.cacheDir ?? '—'}</code>.{' '}
      <button
        type="button"
        className="btn btn-sm"
        disabled={clearing}
        onClick={() => {
          setClearing(true);
          void asr
            .clearModels()
            .then(() => notify('success', 'Modèles supprimés : le prochain essai les retéléchargera.'))
            .catch((error: unknown) => notify('error', humanizeError(error)))
            .finally(() => setClearing(false));
        }}
      >
        {clearing ? 'Suppression…' : 'Vider'}
      </button>
    </p>
  );
}

export { importVideo };
