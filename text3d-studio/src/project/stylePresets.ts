import type { LayerStyle, StylePreset } from '@/types';
import { cloneStyle, YELLOW_3D_STYLE } from './defaults';

interface ColorRecipe {
  id: string;
  name: string;
  face: string;
  faceDark: string;
  outline: string;
  sideNear: string;
  sideFar: string;
  shadow: string;
  glow: string;
}

/**
 * The coloured 3D family shares the reference geometry and only swaps its
 * palette — that is the whole point of a parametric style engine.
 */
function colorPreset(recipe: ColorRecipe): StylePreset {
  const style = cloneStyle(YELLOW_3D_STYLE);
  style.fill.color = recipe.face;
  style.fill.color2 = recipe.faceDark;
  style.stroke.color = recipe.outline;
  style.stroke.color2 = recipe.outline;
  style.extrusion.color = recipe.sideNear;
  style.extrusion.color2 = recipe.sideFar;
  style.shadow.color = recipe.shadow;
  style.glow.color = recipe.glow;
  return {
    id: recipe.id,
    name: recipe.name,
    builtin: true,
    favorite: recipe.id === '3d-yellow',
    typography: {},
    style,
  };
}

function withStyle(
  id: string,
  name: string,
  mutate: (style: LayerStyle) => void,
  typography: StylePreset['typography'] = {},
): StylePreset {
  const style = cloneStyle(YELLOW_3D_STYLE);
  mutate(style);
  return { id, name, builtin: true, favorite: false, typography, style };
}

export const BUILTIN_STYLE_PRESETS: StylePreset[] = [
  colorPreset({
    id: '3d-yellow',
    name: '3D Yellow',
    face: '#FFE500',
    faceDark: '#FFC000',
    outline: '#FFF9B5',
    sideNear: '#E5B800',
    sideFar: '#7A5B00',
    shadow: '#4A3A00',
    glow: '#FFF07A',
  }),
  colorPreset({
    id: '3d-red',
    name: '3D Red',
    face: '#FF3B30',
    faceDark: '#D01A10',
    outline: '#FFD9D5',
    sideNear: '#B31009',
    sideFar: '#4C0603',
    shadow: '#3A0705',
    glow: '#FF7A70',
  }),
  colorPreset({
    id: '3d-blue',
    name: '3D Blue',
    face: '#3FA9FF',
    faceDark: '#1265D8',
    outline: '#D6ECFF',
    sideNear: '#0E4FAE',
    sideFar: '#05204A',
    shadow: '#04162E',
    glow: '#7EC8FF',
  }),
  colorPreset({
    id: '3d-purple',
    name: '3D Purple',
    face: '#B45CFF',
    faceDark: '#7A1FD6',
    outline: '#EEDBFF',
    sideNear: '#5F14A8',
    sideFar: '#2A0650',
    shadow: '#1E0438',
    glow: '#D19BFF',
  }),
  colorPreset({
    id: '3d-green',
    name: '3D Green',
    face: '#4CE86A',
    faceDark: '#17B03C',
    outline: '#D8FFE0',
    sideNear: '#0F8A2C',
    sideFar: '#053B13',
    shadow: '#042C0F',
    glow: '#8CFFA3',
  }),
  colorPreset({
    id: '3d-white',
    name: 'White 3D',
    face: '#FFFFFF',
    faceDark: '#DCE2EC',
    outline: '#FFFFFF',
    sideNear: '#AAB4C4',
    sideFar: '#48505E',
    shadow: '#141821',
    glow: '#FFFFFF',
  }),

  withStyle('gold', 'Gold', (style) => {
    style.fill.kind = 'metallic';
    style.fill.color = '#FFD24A';
    style.fill.color2 = '#8A5E00';
    style.fill.color3 = '#FFF6C9';
    style.fill.angle = 100;
    style.stroke.color = '#6B4600';
    style.stroke.width = 5;
    style.extrusion.color = '#A97A00';
    style.extrusion.color2 = '#3E2A00';
    style.extrusion.depth = 22;
    style.gloss.intensity = 0.9;
    style.gloss.position = 0.24;
    style.glow.color = '#FFD98A';
    style.glow.opacity = 0.28;
    style.shadow.color = '#2A1D00';
  }),

  withStyle('silver', 'Silver', (style) => {
    style.fill.kind = 'metallic';
    style.fill.color = '#E6EAF0';
    style.fill.color2 = '#697382';
    style.fill.color3 = '#FFFFFF';
    style.fill.angle = 100;
    style.stroke.color = '#4B5563';
    style.stroke.width = 5;
    style.extrusion.color = '#8B95A3';
    style.extrusion.color2 = '#2B313A';
    style.gloss.intensity = 0.85;
    style.glow.enabled = false;
    style.shadow.color = '#10141B';
  }),

  withStyle('chrome', 'Chrome', (style) => {
    style.fill.kind = 'metallic';
    style.fill.color = '#FFFFFF';
    style.fill.color2 = '#26303D';
    style.fill.color3 = '#9FD4FF';
    style.fill.angle = 95;
    style.stroke.color = '#0F1720';
    style.stroke.width = 6;
    style.extrusion.color = '#5A6673';
    style.extrusion.color2 = '#0B0F14';
    style.extrusion.depth = 26;
    style.gloss.intensity = 1.2;
    style.gloss.width = 0.2;
    style.gloss.position = 0.22;
    style.glow.color = '#BFE4FF';
    style.glow.opacity = 0.25;
    style.shadow.color = '#05070A';
  }),

  withStyle('glossy', 'Glossy', (style) => {
    style.fill.kind = 'glossy';
    style.fill.color = '#FF6BB5';
    style.fill.color2 = '#C21E7B';
    style.stroke.color = '#FFFFFF';
    style.stroke.width = 10;
    style.extrusion.depth = 10;
    style.extrusion.steps = 14;
    style.extrusion.color = '#9E1560';
    style.extrusion.color2 = '#450828';
    style.gloss.intensity = 1;
    style.gloss.position = 0.26;
    style.gloss.width = 0.3;
    style.glow.color = '#FF9BD0';
    style.glow.opacity = 0.4;
    style.shadow.opacity = 0.4;
  }),

  withStyle('neon', 'Neon', (style) => {
    style.fill.kind = 'solid';
    style.fill.color = '#0B0F14';
    style.stroke.enabled = true;
    style.stroke.width = 7;
    style.stroke.color = '#39FFEA';
    style.stroke.color2 = '#B14BFF';
    style.stroke.gradient = true;
    style.extrusion.enabled = false;
    style.gloss.enabled = false;
    style.glow.enabled = true;
    style.glow.color = '#39FFEA';
    style.glow.intensity = 2.4;
    style.glow.blur = 42;
    style.glow.opacity = 0.85;
    style.shadow.enabled = false;
  }),

  withStyle('minimal', 'Minimal', (style) => {
    style.fill.kind = 'solid';
    style.fill.color = '#F5F7FA';
    style.stroke.enabled = false;
    style.extrusion.enabled = false;
    style.gloss.enabled = false;
    style.glow.enabled = false;
    style.shadow.enabled = false;
  }),
];
