import { blend, type BlendMode, type RGB } from '../engine/palette';

/**
 * Area styles: the OSM areas drawn as a colour filter over the terrain imagery (osm-mesher
 * classifyArea). Each piece of such an area takes the imagery colour of the terrain face under it
 * blended with the kind's colour in the kind's mode, `strength` 0..1 of the way from the imagery.
 * Area style editor (areas.html) tunes them; the game uses DEFAULT_AREA_STYLES.
 */
export type AreaKind = 'scrub' | 'beach' | 'rock' | 'farmland' | 'pitch' | 'park' | 'garden' | 'golf' | 'wetland';

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
  { kind: 'scrub', name: 'Кустарник', tags: 'natural=scrub' },
  { kind: 'wetland', name: 'Болото', tags: 'natural=wetland' },
  { kind: 'beach', name: 'Пляж', tags: 'natural=beach' },
  { kind: 'rock', name: 'Скалы и осыпи', tags: 'natural=bare_rock, scree' },
];

const soft = (r: number, g: number, b: number): AreaFilter => ({ colour: [r, g, b], mode: 'soft-light', strength: 1 });
const GRASS = soft(104, 192, 80);

/** soft-light filters of open ground: channels above mid grey lighten the imagery, below darken */
export const DEFAULT_AREA_STYLES: AreaStyles = {
  scrub: soft(72, 120, 56),
  beach: soft(224, 204, 150),
  rock: soft(150, 138, 122),
  farmland: soft(128, 200, 72),
  pitch: GRASS,
  park: GRASS,
  garden: GRASS,
  golf: GRASS,
  wetland: soft(88, 144, 112),
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
