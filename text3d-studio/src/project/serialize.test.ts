import { describe, expect, it } from 'vitest';
import { deserializeProject, ProjectFormatError, serializeProject } from './serialize';
import { createProject, createTextLayer } from './defaults';
import { createKeyframe } from '@/animation/keyframes';
import { PROJECT_VERSION } from '@/types';

describe('project round-trip', () => {
  it('restores a project identically', () => {
    const project = createProject('Mon projet');
    const layer = project.layers[0]!;
    layer.text = 'VINTED';
    layer.style.fill.color = '#123456';
    layer.style.extrusion.depth = 42;
    layer.animation.tracks = [
      {
        property: 'transform.x',
        keyframes: [createKeyframe(0, 0, 'linear'), createKeyframe(1, 120, 'bounce')],
      },
    ];

    const restored = deserializeProject(serializeProject(project));

    expect(restored.name).toBe('Mon projet');
    expect(restored.layers[0]?.text).toBe('VINTED');
    expect(restored.layers[0]?.style.fill.color).toBe('#123456');
    expect(restored.layers[0]?.style.extrusion.depth).toBe(42);
    expect(restored.layers[0]?.animation.tracks[0]?.keyframes).toHaveLength(2);
    expect(restored.layers[0]?.animation.tracks[0]?.keyframes[1]?.easing).toBe('bounce');
    expect(restored.timeline).toEqual(project.timeline);
    expect(restored.canvas.width).toBe(project.canvas.width);
  });

  it('keeps several layers and the active selection', () => {
    const project = createProject();
    const second = createTextLayer({ name: 'Sous-titre', text: 'NICHES' });
    project.layers.push(second);
    project.activeLayerId = second.id;

    const restored = deserializeProject(serializeProject(project));
    expect(restored.layers).toHaveLength(2);
    expect(restored.activeLayerId).toBe(second.id);
  });

  it('preserves multi-line text', () => {
    const project = createProject();
    project.layers[0]!.text = 'TROUVE\nLES\nNICHES';
    const restored = deserializeProject(serializeProject(project));
    expect(restored.layers[0]?.text.split('\n')).toHaveLength(3);
  });
});

describe('project validation', () => {
  it('rejects non-JSON content', () => {
    expect(() => deserializeProject('<html>')).toThrow(ProjectFormatError);
  });

  it('rejects a payload without a version', () => {
    expect(() => deserializeProject('{"name":"x"}')).toThrow(ProjectFormatError);
  });

  it('rejects a project from a newer version', () => {
    expect(() => deserializeProject(JSON.stringify({ version: PROJECT_VERSION + 5 }))).toThrow(
      /plus récente/,
    );
  });

  it('fills in missing sections with defaults instead of failing', () => {
    const restored = deserializeProject(JSON.stringify({ version: 1, name: 'Partiel' }));
    expect(restored.layers).toHaveLength(1);
    expect(restored.layers[0]?.style.fill.kind).toBe('glossy');
    expect(restored.timeline.fps).toBeGreaterThan(0);
  });

  it('drops unknown keys and keeps well-typed ones', () => {
    const restored = deserializeProject(
      JSON.stringify({
        version: 1,
        layers: [{ id: 'l1', text: 'OK', typography: { fontSize: 90, bogus: 'x' } }],
      }),
    );
    expect(restored.layers[0]?.typography.fontSize).toBe(90);
    expect((restored.layers[0]?.typography as unknown as Record<string, unknown>)['bogus']).toBeUndefined();
  });

  it('ignores a wrongly typed value and falls back to the default', () => {
    const restored = deserializeProject(
      JSON.stringify({ version: 1, layers: [{ typography: { fontSize: 'huge' } }] }),
    );
    expect(typeof restored.layers[0]?.typography.fontSize).toBe('number');
  });

  it('clamps an out-of-range canvas size', () => {
    const restored = deserializeProject(
      JSON.stringify({ version: 1, canvas: { width: 999999, height: -4 } }),
    );
    expect(restored.canvas.width).toBe(16384);
    expect(restored.canvas.height).toBe(16);
  });

  it('discards malformed keyframes but keeps valid ones', () => {
    const restored = deserializeProject(
      JSON.stringify({
        version: 1,
        layers: [
          {
            animation: {
              tracks: [
                {
                  property: 'opacity',
                  keyframes: [{ time: 0, value: 1 }, { time: 1 }, { time: 2, value: 0 }],
                },
              ],
            },
          },
        ],
      }),
    );
    expect(restored.layers[0]?.animation.tracks[0]?.keyframes).toHaveLength(2);
  });

  it('resets an activeLayerId that points at nothing', () => {
    const restored = deserializeProject(
      JSON.stringify({ version: 1, layers: [{ id: 'a' }], activeLayerId: 'ghost' }),
    );
    expect(restored.activeLayerId).toBe('a');
  });

  it('rejects an unknown blend mode', () => {
    const restored = deserializeProject(
      JSON.stringify({ version: 1, layers: [{ blendMode: 'evil-script' }] }),
    );
    expect(restored.layers[0]?.blendMode).toBe('source-over');
  });
});
