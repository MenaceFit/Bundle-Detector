import { describe, expect, it } from 'vitest';
import { describeFailure } from './whisper';

/**
 * The download is the only step that needs the network, and it is where this
 * feature fails in the real world. These are messages actually produced by the
 * runtime and by Node, so the classification is tested against them rather than
 * against invented strings.
 */
describe('describeFailure', () => {
  const model = 'onnx-community/whisper-tiny';

  const downloadFailures = [
    // Observed verbatim from @huggingface/transformers behind a blocking proxy.
    'Forbidden access to file: "https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json".',
    'TypeError: fetch failed',
    'getaddrinfo ENOTFOUND huggingface.co',
    'connect ECONNREFUSED 127.0.0.1:443',
    'request to https://huggingface.co/... failed, reason: self-signed certificate in certificate chain',
    'Unauthorized access to file',
    'Error: 503 Service Unavailable',
  ];

  for (const message of downloadFailures) {
    it(`explains the one-off download for: ${message.slice(0, 42)}…`, () => {
      const described = describeFailure(message, model);
      expect(described).toContain('téléchargé');
      expect(described).toContain('hors ligne');
      // The raw message stays available, so a user can report it.
      expect(described).toContain(message);
    });
  }

  it('names a missing repository rather than blaming the connection', () => {
    const described = describeFailure(
      'Error: 404 Not Found for https://huggingface.co/onnx-community/nope/resolve/main/config.json',
      model,
    );
    expect(described).toContain('introuvable');
    expect(described).not.toContain('pare-feu');
  });

  it('names a full disk, which no retry would fix', () => {
    const described = describeFailure('ENOSPC: no space left on device', model);
    expect(described).toContain('Espace disque');
  });

  it('falls back to a plain report for anything unrecognised', () => {
    const described = describeFailure('Unsupported dtype q8 for this model', model);
    expect(described).toContain(model);
    expect(described).toContain('Unsupported dtype');
    expect(described).not.toContain('pare-feu');
  });
});
