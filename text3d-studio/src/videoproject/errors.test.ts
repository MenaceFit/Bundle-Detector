import { describe, expect, it } from 'vitest';
import { humanizeError } from './errors';

describe('humanizeError', () => {
  it('strips the Electron IPC wrapper so only the real message remains', () => {
    const raw = new Error(
      "Error invoking remote method 'video:probe': Error: FFmpeg est introuvable.",
    );
    expect(humanizeError(raw)).toBe('FFmpeg est introuvable.');
  });

  it('strips a doubled Error prefix', () => {
    expect(humanizeError(new Error('Error: Error: quelque chose a cassé'))).toBe(
      'quelque chose a cassé',
    );
  });

  it('leaves a clean message untouched', () => {
    expect(humanizeError(new Error('Fichier illisible.'))).toBe('Fichier illisible.');
  });

  it('accepts a plain string', () => {
    expect(humanizeError('juste du texte')).toBe('juste du texte');
  });

  it('never returns an empty message', () => {
    expect(humanizeError(new Error('   '))).toMatch(/erreur inattendue/i);
    expect(humanizeError(undefined)).toBeTruthy();
  });

  it('keeps a message that merely contains the word Error', () => {
    expect(humanizeError(new Error('Le codec Error-3 est inconnu'))).toBe(
      'Le codec Error-3 est inconnu',
    );
  });
});
