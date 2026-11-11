import { expect, it } from 'vitest';
import { Menu } from '../src/ui/menu';
import type { Settings } from '../src/ui/settings';

it('a pasted map link sets the custom start point on the start screen only', () => {
  const menu = new Menu({} as never, {} as never, { lang: 'ru' } as Settings, {} as never);
  menu.screen = 'start';
  expect(menu.pasteLink('https://www.google.com/maps/@36.6211,29.1164,14z')).toBe(true);
  expect(menu.config.location).toBe('custom');
  expect(menu.config.customPoint).toEqual({ lat: 36.6211, lon: 29.1164 });
  // not a link: handled (an error note), the point stays
  expect(menu.pasteLink('hello')).toBe(true);
  expect(menu.config.customPoint).toEqual({ lat: 36.6211, lon: 29.1164 });
  menu.screen = 'pause';
  expect(menu.pasteLink('47.26, 11.39')).toBe(false);
  expect(menu.config.customPoint).toEqual({ lat: 36.6211, lon: 29.1164 });
});
