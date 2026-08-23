import { useMemo, useState } from 'react';
import { useVideoStore } from '@/videoproject/store';
import { lowConfidenceWords } from '@/transcription/normalize';
import { Section } from '../ui/Section';
import { NumberControl } from '../ui/Controls';

/**
 * Transcript review and correction.
 *
 * Automatic transcription is never assumed to be right: words flagged as low
 * confidence are surfaced first, every word is editable in place, and timings
 * can be nudged without disturbing the rest of the track.
 */
export function TranscriptEditor() {
  const transcript = useVideoStore((state) => state.transcript);
  const track = useVideoStore((state) => state.track);
  const selectedWordId = useVideoStore((state) => state.selectedWordId);
  const selectWord = useVideoStore((state) => state.selectWord);
  const setTime = useVideoStore((state) => state.setTime);
  const setPlaying = useVideoStore((state) => state.setPlaying);
  const editWordText = useVideoStore((state) => state.editWordText);
  const editWordTiming = useVideoStore((state) => state.editWordTiming);
  const toggleWordEmphasis = useVideoStore((state) => state.toggleWordEmphasis);
  const removeWord = useVideoStore((state) => state.removeWord);
  const splitCueAt = useVideoStore((state) => state.splitCueAt);
  const mergeCueWithNext = useVideoStore((state) => state.mergeCueWithNext);
  const autoHighlight = useVideoStore((state) => state.autoHighlight);
  const clearEmphasis = useVideoStore((state) => state.clearEmphasis);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const flagged = useMemo(
    () => (transcript ? lowConfidenceWords(transcript, 0.5) : []),
    [transcript],
  );

  const selected = useMemo(
    () => transcript?.words.find((word) => word.id === selectedWordId) ?? null,
    [transcript, selectedWordId],
  );

  if (!transcript) {
    return <p className="hint" style={{ padding: 14 }}>Aucune transcription pour l’instant.</p>;
  }

  const commit = (wordId: string): void => {
    const text = draft.trim();
    if (text.length > 0) editWordText(wordId, text);
    setEditingId(null);
  };

  return (
    <>
      {flagged.length > 0 && (
        <Section title={`À vérifier (${flagged.length})`}>
          <p className="hint">
            Ces mots ont une confiance faible. Cliquez pour aller à leur position et corriger.
          </p>
          <div className="vc-flagged">
            {flagged.map((word) => (
              <button
                key={word.id}
                type="button"
                className="vc-flag"
                onClick={() => {
                  selectWord(word.id);
                  setPlaying(false);
                  setTime(word.start);
                }}
              >
                ⚠ {word.text}
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section title="Transcription">
        <div className="field-row">
          <button type="button" className="btn btn-sm" onClick={autoHighlight}>
            Mots-clés automatiques
          </button>
          <button type="button" className="btn btn-sm" onClick={clearEmphasis}>
            Tout retirer
          </button>
        </div>
        <p className="hint">
          Double-cliquez un mot pour le corriger. La sélection d’un mot déplace le lecteur sur son
          timestamp exact.
        </p>

        <div className="vc-transcript">
          {track.cues.map((cue, cueIndex) => (
            <div key={cue.id} className="vc-cue-block">
              <div className="vc-cue-head">
                <span className="timecode">{cue.start.toFixed(2)}s</span>
                {cueIndex < track.cues.length - 1 && (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    title="Fusionner avec le sous-titre suivant"
                    onClick={() => mergeCueWithNext(cue.id)}
                  >
                    ⇊
                  </button>
                )}
              </div>
              <div className="vc-cue-words">
                {cue.words.map((word) => {
                  const isEditing = editingId === word.id;
                  return isEditing ? (
                    <input
                      key={word.id}
                      className="input vc-word-input"
                      autoFocus
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={() => commit(word.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') commit(word.id);
                        if (event.key === 'Escape') setEditingId(null);
                      }}
                    />
                  ) : (
                    <button
                      key={word.id}
                      type="button"
                      className={`vc-token${selectedWordId === word.id ? ' selected' : ''}${
                        word.emphasis ? ' emphasis' : ''
                      }${word.confidence !== undefined && word.confidence < 0.5 ? ' low' : ''}`}
                      onClick={() => {
                        selectWord(word.id);
                        setPlaying(false);
                        setTime(word.start);
                      }}
                      onDoubleClick={() => {
                        setDraft(word.text);
                        setEditingId(word.id);
                      }}
                      title={`${word.start.toFixed(2)}s → ${word.end.toFixed(2)}s`}
                    >
                      {word.text}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {selected && (
        <Section title={`Mot « ${selected.text} »`}>
          <div className="field">
            <div className="field-head">
              <span className="field-label">Début / fin (s)</span>
            </div>
            <div className="field-row">
              <NumberControl
                value={selected.start}
                onChange={(value) => editWordTiming(selected.id, value, selected.end)}
                min={0}
                step={0.01}
                decimals={2}
              />
              <NumberControl
                value={selected.end}
                onChange={(value) => editWordTiming(selected.id, selected.start, value)}
                min={0}
                step={0.01}
                decimals={2}
              />
            </div>
          </div>
          <div className="field-row">
            <button
              type="button"
              className={`btn btn-sm${selected.emphasis ? ' active' : ''}`}
              onClick={() => toggleWordEmphasis(selected.id)}
            >
              Mot important
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => splitCueAt(selected.id)}
              title="Commencer un nouveau sous-titre à ce mot"
            >
              Couper ici
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => removeWord(selected.id)}
            >
              Supprimer
            </button>
          </div>
          {selected.confidence !== undefined && (
            <p className="hint">Confiance du moteur : {Math.round(selected.confidence * 100)} %</p>
          )}
        </Section>
      )}
    </>
  );
}
