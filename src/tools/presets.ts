import type { MapPoint } from '../ui/map-links';

/** Places worth a look in the terrain tools: name, latitude, longitude, zoom. */
export const PRESETS: Array<[string, number, number, number]> = [
  ['Инсбрук, долина Инна', 47.26, 11.39, 12],
  ['Маттерхорн', 45.976, 7.658, 13],
  ['Гранд-Каньон', 36.1, -112.1, 12],
  ['Монако, берег', 43.735, 7.42, 13],
  ['Долина По (равнина)', 45.43, 9.5, 12],
  ['Эльбрус', 43.35, 42.44, 11],
  ['Килиманджаро', -3.07, 37.35, 10],
];

/** names of the map services a pasted link may come from */
export const SOURCE: Record<MapPoint['source'], string> = {
  google: 'Google Maps', apple: 'Apple Maps', yandex: 'Яндекс Карты', osm: 'OpenStreetMap', geo: 'geo:', coords: 'координаты',
};
