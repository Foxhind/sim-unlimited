import { blend, type BlendMode, type RGB } from '../engine/palette';

/**
 * Area styles: the OSM areas drawn as a colour filter over the terrain imagery (osm-mesher
 * classifyArea). Each piece of such an area takes the imagery colour of the terrain face under it
 * blended with the kind's colour in the kind's mode, `strength` 0..1 of the way from the imagery.
 * Area style editor (areas.html) tunes them; the game uses DEFAULT_AREA_STYLES.
 */
export type AreaKind = 'scrub' | 'beach' | 'rock' | 'cliff' | 'farmland' | 'orchard' | 'vineyard' | 'pitch' | 'park' | 'garden' | 'golf' | 'wetland';

export interface AreaFilter {
  colour: RGB;
  mode: BlendMode;
  strength: number;
}

export type AreaStyles = Record<AreaKind, AreaFilter>;

/** the kinds in the editor's order, with the tags that select them */
export const AREA_KINDS: ReadonlyArray<{ kind: AreaKind; name: string; tags: string }> = [
  { kind: 'park', name: 'Парк', tags: 'leisure=park' },
  { kind: 'garden', name: 'Сад', tags: 'leisure=garden' },
  { kind: 'golf', name: 'Гольф-поле', tags: 'leisure=golf_course' },
  { kind: 'pitch', name: 'Спортплощадка, трава', tags: 'leisure=pitch без surface' },
  { kind: 'farmland', name: 'Пашня', tags: 'landuse=farmland' },
  { kind: 'orchard', name: 'Фруктовый сад', tags: 'landuse=orchard' },
  { kind: 'vineyard', name: 'Виноградник', tags: 'landuse=vineyard' },
  { kind: 'scrub', name: 'Кустарник', tags: 'natural=scrub' },
  { kind: 'wetland', name: 'Болото', tags: 'natural=wetland' },
  { kind: 'beach', name: 'Пляж', tags: 'natural=beach' },
  { kind: 'rock', name: 'Скалы и осыпи', tags: 'natural=bare_rock, scree' },
  { kind: 'cliff', name: 'Обрыв (полоса под линией)', tags: 'natural=cliff' },
];

/** the game's filters (tuned in areas.html) */
export const DEFAULT_AREA_STYLES: AreaStyles = {
  park: { colour: [104, 192, 80], mode: 'color-burn', strength: 0.18 },
  garden: { colour: [104, 192, 80], mode: 'soft-light', strength: 1 },
  golf: { colour: [104, 192, 80], mode: 'soft-light', strength: 1 },
  pitch: { colour: [50, 80, 42], mode: 'screen', strength: 0.44 },
  farmland: { colour: [16, 16, 9], mode: 'screen', strength: 1 },
  // first guesses, not yet tuned in areas.html: the trees carry an orchard, the filter only tints the soil
  orchard: { colour: [150, 130, 90], mode: 'soft-light', strength: 0.6 },
  vineyard: { colour: [170, 150, 100], mode: 'soft-light', strength: 0.8 },
  scrub: { colour: [104, 192, 80], mode: 'color-burn', strength: 0.2 },
  wetland: { colour: [88, 144, 112], mode: 'soft-light', strength: 1 },
  beach: { colour: [179, 164, 122], mode: 'normal', strength: 0.74 },
  rock: { colour: [150, 138, 122], mode: 'soft-light', strength: 1 },
  // a cliff's face must stand out of the wooded slope round it: pale limestone over the imagery (first guess)
  cliff: { colour: [176, 170, 158], mode: 'normal', strength: 0.75 },
};

const sameFilter = (a: AreaFilter, b: AreaFilter): boolean =>
  a.mode === b.mode && a.strength === b.strength && a.colour[0] === b.colour[0] && a.colour[1] === b.colour[1] && a.colour[2] === b.colour[2];

/** the styles the game meshes and caches with */
export function isDefaultAreaStyles(s: AreaStyles): boolean {
  return AREA_KINDS.every(({ kind }) => sameFilter(s[kind], DEFAULT_AREA_STYLES[kind]));
}

/** an area piece's colour: the imagery colour under it through the kind's filter */
export function filterColour(base: RGB, f: AreaFilter): RGB {
  return blend(base, f.colour, f.mode, f.strength);
}
