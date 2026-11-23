# Сначала дороги, потом земля — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дороги получают высоты из сырого DEM окном вдоль сети, а земля строится под них одной триангуляцией с плавной подтяжкой — без врезки, стенок и особых правил шва.

**Architecture:** Сеть дорог тайла (с запасом 150 м) → высота `H` в каждой точке сети (ядро по расстоянию пути, 90 м) → подъёмы мостов → поле подтяжки `F(p) = B + w·(R − B)`. Базовая поясная сетка получает кромки лож дорог как фиксированные рёбра и узлы решётки в полосах; затем высота каждой вершины заменяется на `F`. Ленты дорог по-прежнему ложатся на грани сетки: на ложе сетка и есть поверхность дороги.

**Tech Stack:** TypeScript, Vite, Vitest; новые зависимости `delaunator` и `@kninnug/constrainautor` (триангуляция).

**Spec:** `docs/superpowers/specs/2026-11-22-roads-first-design.md` — читать вместе с планом; при расхождении прав дизайн.

## Global Constraints

- Ветка `feat/roads-first` от `main` (`eb6a6b4`). На `main` не работать.
- **Не коммитить без просьбы пользователя.** Шаги «Commit» выполняются только после его разрешения; иначе итог задачи пишется в журнал.
- Всё, от чего зависит высота земли у границы тайла, считается только из сырого DEM и дорог в пределах 150 м (`ROAD_REACH_M`): `полуширина ложа + T + L ≤ 150 м`.
- Числа из дизайна: `L = 90 м`; `T` = 45 / 40 / 25 м; `LIFT_REACH_M = 90`; кромка ложа — не дальше 0,2 м по высоте от истинной; до 12 000 вершин на тайл; шов — не больше 5 см.
- Базовый рельеф: решётка 64, шаг пояса 150 м, eps 1, 300 вершин на изолинии.
- Подтяжка только на z14 (`DETAIL_Z`) при загруженном OSM тайла.
- Код коридоров и врезки из веток (`roadbeds.ts`, `tin-carve.ts`, `road-profile.ts`) не переносить.
- Комментарии в коде — по-английски, в стиле файла; `git diff --check` чистый.
- Бюджет: поверхность плотного тайла ≤ 150 мс в браузере; `tests/perf.test.ts` зелёный.
- Проверки после каждой задачи: `npx vitest run tests/`, `npx tsc --noEmit -p .`. Падения `tests/perf.test.ts` и `tests/landsat-process.test.ts` под параллельной нагрузкой перепроверять отдельным запуском; тесты под `.claude/worktrees/` — чужие.

## Review Focus

Случаи, которые дизайн подразумевает, а тесты задач могли бы пропустить (каждому назначен тест в задаче-владельце):

1. Два пути с одной и той же геометрией или общий отрезок двух путей — кромки накладываются; сетка должна остаться без трещин (Задача 7).
2. Дорога идёт точно по границе тайла или касается её под острым углом — оба тайла сходятся на шве (Задача 7).
3. Кольцо и петля (замкнутый путь, круговое движение): расстояние по сети считается в обе стороны, высота непрерывна (Задача 4).
4. Нет сырых высот (DEM-тайл отсутствует, `NaN`): дорога остаётся как на `main`, сборка не падает (Задачи 4 и 7).
5. Дорога у берега и дамба через воду: море остаётся морем, суша не появляется (Задача 7).

---

### Task 1: Быстрая триангуляция

**Files:**
- Modify: `package.json`, `src/world/contours.ts`
- Test: `tests/contours.test.ts`

**Interfaces:**
- Produces: `constrainedDelaunay(points: Pt[], constraints: ReadonlyArray<readonly [number, number]>, prefer?) : { tris: Tri[]; missing: number }` — подпись прежняя; `delaunay(points)` — прежняя.

- [ ] **Step 1: Failing tests** в `tests/contours.test.ts`:

```ts
describe('constrainedDelaunay at scale', () => {
  const rnd = (seed: number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  it('triangulates 8000 points with 2000 fixed edges within 150 ms', () => {
    const r = rnd(7), pts = Array.from({ length: 8000 }, () => ({ x: r() * 64, y: r() * 64 }));
    // fixed edges: short non-crossing segments between consecutive points of 2000 disjoint pairs
    const sorted = pts.map((p, i) => ({ p, i })).sort((a, b) => a.p.x - b.p.x || a.p.y - b.p.y);
    const cons: [number, number][] = [];
    for (let k = 0; k + 1 < sorted.length && cons.length < 2000; k += 4) cons.push([sorted[k].i, sorted[k + 1].i]);
    constrainedDelaunay(pts, cons); // warm-up
    const t = performance.now();
    const { tris, missing } = constrainedDelaunay(pts, cons);
    expect(performance.now() - t).toBeLessThan(150);
    expect(missing).toBe(0);
    const has = new Set(tris.flatMap((f) => [[f.a, f.b], [f.b, f.c], [f.c, f.a]].map(([u, v]) => (u < v ? `${u},${v}` : `${v},${u}`))));
    for (const [u, v] of cons) expect(has.has(u < v ? `${u},${v}` : `${v},${u}`)).toBe(true);
  });

  it('leaves no vertex on another face’s edge among points on one line', () => {
    const on = (x: number) => ({ x, y: 3 + ((x - 3) * 41) / 42 });
    const pts = [on(24.54), on(26.54), on(27.041), on(27.613), on(28.04), on(29.27), { x: 27.995, y: 29.434 }, { x: 33, y: 24.35 }, { x: 20, y: 30 }, { x: 30, y: 18 }];
    const { tris } = constrainedDelaunay(pts, [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]], () => true);
    for (const f of tris) for (const [p, q] of [[f.a, f.b], [f.b, f.c], [f.c, f.a]]) {
      const a = pts[p], b = pts[q], len = Math.hypot(b.x - a.x, b.y - a.y);
      pts.forEach((m, k) => {
        if (k === p || k === q) return;
        const s = ((m.x - a.x) * (b.x - a.x) + (m.y - a.y) * (b.y - a.y)) / (len * len);
        const d = Math.abs((m.x - a.x) * (b.y - a.y) - (m.y - a.y) * (b.x - a.x)) / len;
        expect(s > 1e-6 && s < 1 - 1e-6 && d < 1e-7).toBe(false);
      });
    }
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/contours.test.ts` — первый падает по времени (секунды), второй — по трещине.
- [ ] **Step 3:** `npm install delaunator @kninnug/constrainautor` (и `@types/delaunator`, если `tsc` попросит). В `constrainedDelaunay`: триангуляция — `Delaunator`, рёбра — `Constrainautor.constrainAll`, затем `delaunify()`; из результата собрать прежние `tri`/`he` и выполнить прежний проход `prefer`. Проверка выпуклости при перевороте — с допуском `1e-10 · span²` на обе ориентации (переворот в треугольник почти нулевой площади запрещён). `delaunay(points)` — через `Delaunator`. Ребро, которое библиотека вставить не может (пересечение, точка на ребре), считается в `missing`, без исключения наружу.
- [ ] **Step 4:** `npx vitest run tests/` — зелёный; `npx tsc --noEmit -p .` — чисто. Тест, который проверял конкретную раскладку треугольников, а не свойство, правится с записью решения в журнал.
- [ ] **Step 5: Commit** `perf(tin): Delaunay and fixed edges by delaunator and constrainautor`

### Task 2: Более гладкий базовый рельеф

**Files:**
- Modify: `src/world/chunks.ts`, `src/world/terrain-tin.ts`, `src/world/tile-cache.ts`
- Test: `tests/chunks.test.ts`, `tests/tin-quality.test.ts`, `tests/terrain-tin.test.ts`

**Interfaces:**
- Produces: `TERRAIN_GRID = 64`, `BELT_STEP = 150`, `MAX_VERTS = 300`, `EPS_START = 1`; `TinOptions.maxVerts?: number`.

- [ ] **Step 1:** Перенести из `f6f4460` правки тестов этих трёх файлов (`git show f6f4460 -- tests/chunks.test.ts tests/tin-quality.test.ts`) — они ждут новые числа.
- [ ] **Step 2:** Запустить — падают на старых числах.
- [ ] **Step 3:** Перенести из `f6f4460` только: константы, `TinOptions.maxVerts`, и в предпочтении переворота — сначала убирать треугольники, перекрывающие целый пояс (`over`). Поле `TerrainTin.base` и экспорт локаторов для врезки не переносить. `SCHEMA_VERSION` 49 → 50.
- [ ] **Step 4:** Полный набор и типы зелёные.
- [ ] **Step 5: Commit** `feat(terrain): a smoother base relief (grid 64, 150 m belts)`

### Task 3: Сеть дорог

**Files:**
- Create: `src/world/road-net.ts`, `tests/roads-helpers.ts`
- Modify: `src/world/osm-mesher.ts` (экспорт ширин)
- Test: `tests/road-net.test.ts`

**Interfaces:**
- Consumes: `classifyLine`, `roadPriority`, `isTunnel` (`osm-mesher.ts`).
- Produces:

```ts
export const NET_STEP_M = 10;
export interface NetWay {
  line: OsmLine;
  /** roadPriority of the way: the senior where beds overlap */
  prio: number;
  /** bed half width, m: half the carriageway and the shoulder */
  half: number;
  /** pull band beyond the bed, m: 45 / 40 / 25 by class */
  band: number;
  /** weight of its DEM samples: carriageway width squared */
  weight: number;
  bridge: boolean;
  tunnel: boolean;
  /** its samples: first .. first + count − 1, in the way's order */
  first: number;
  count: number;
}
export interface NetSample { lon: number; lat: number; way: number; /** metres along the way */ d: number }
export interface RoadNet {
  ways: NetWay[];
  samples: NetSample[];
  /** per sample: its neighbours along the network and the metres to each */
  next: Array<Array<[number, number]>>;
}
export function isCarriageway(tags: Record<string, string>): boolean;
export function buildRoadNet(lines: ReadonlyArray<OsmLine>): RoadNet;
```

`tests/roads-helpers.ts`: `TILE = { z: 14, x: 9000, y: 6000 }`, `GRID = 64`, `SIZE`, `M` (клеток на метр), `lattice(fn)`, `road(tags, pts)` (точки в клетках решётки), `at(tin, xm, ym)`, `padAround(x, y, half)` (плоская площадка аэродрома на 500 м), `demOf(net, fn): Float64Array` (рельеф в метрах от северо-западного угла → высота в каждой точке сети), `seeded(seed)` (генератор случайных чисел), `area(tin)` (сумма площадей граней), `cracks(tin)` (число вершин, лежащих на ребре чужой грани), `bordersOf(fn, tile)` (общие профили границ тайла) — по образцу `tests/roadbeds-helpers.ts` из `f6f4460`.

- [ ] **Step 1: Failing tests** `tests/road-net.test.ts`:

```ts
it('takes roads with a carriageway, not paths', () => {
  expect(isCarriageway({ highway: 'residential' })).toBe(true);
  expect(isCarriageway({ highway: 'trunk_link' })).toBe(true);
  expect(isCarriageway({ highway: 'track' })).toBe(true);
  for (const hw of ['footway', 'path', 'cycleway', 'steps', 'bridleway']) expect(isCarriageway({ highway: hw })).toBe(false);
  expect(isCarriageway({ railway: 'rail' })).toBe(false);
});
it('gives each class its bed, band and weight', () => {
  const net = buildRoadNet([road({ highway: 'motorway' }, [[4, 4], [20, 4]]), road({ highway: 'tertiary' }, [[4, 8], [20, 8]]), road({ highway: 'residential' }, [[4, 12], [20, 12]])]);
  expect(net.ways.map((w) => [w.half, w.band, w.weight])).toEqual([[13, 45, 400], [6, 40, 81], [4, 25, 49]]);
});
it('samples a way at its vertices and no further apart than 10 m', () => {
  const net = buildRoadNet([road({ highway: 'primary' }, [[4, 4], [20, 4], [20, 9]])]);
  const s = net.samples;
  for (let i = 1; i < s.length; i++) expect(s[i].d - s[i - 1].d).toBeLessThanOrEqual(NET_STEP_M + 1e-6);
  expect(s[s.length - 1].d).toBeCloseTo((16 + 5) / M, 0);
});
it('joins ways at a shared node and nowhere else', () => {
  const a = road({ highway: 'primary' }, [[4, 8], [12, 8], [20, 8]]), b = road({ highway: 'residential' }, [[12, 8], [12, 16]]);
  const over = road({ highway: 'secondary', bridge: 'yes' }, [[8, 4], [8, 12]]); // crosses a, shares no node
  const net = buildRoadNet([a, b, over]);
  const reach = (from: number) => { const seen = new Set([from]); const q = [from]; while (q.length) for (const [k] of net.next[q.pop()!]) if (!seen.has(k)) { seen.add(k); q.push(k); } return seen; };
  const fromA = reach(net.ways[0].first);
  expect(fromA.has(net.ways[1].first)).toBe(true);
  expect(fromA.has(net.ways[2].first)).toBe(false);
  expect(net.ways[2].bridge).toBe(true);
});
it('survives degenerate ways', () => {
  expect(() => buildRoadNet([road({ highway: 'primary' }, [[4, 4]]), road({ highway: 'primary' }, [[4, 4], [4, 4]]), road({ highway: 'primary' }, [[4, 4], [8, 4], [4, 4]])])).not.toThrow();
});
```

- [ ] **Step 2:** Запустить — «module not found».
- [ ] **Step 3:** Реализовать. Точки ставятся в вершинах пути и делят каждый отрезок поровну на куски не длиннее `NET_STEP_M` — так положение точки не зависит от того, как тайл обрезал путь по вершинам. Точки с одинаковыми `lon,lat` разных путей соединяются ребром нулевой длины.
- [ ] **Step 4:** Тесты и типы зелёные.
- [ ] **Step 5: Commit** `feat(roads): the road network of a tile`

### Task 4: Высота дороги

**Files:**
- Create: `src/world/road-heights.ts`
- Modify: `src/world/aerodrome.ts` (точечная версия приведения к площадке)
- Test: `tests/road-heights.test.ts`

**Interfaces:**
- Consumes: `RoadNet` (Task 3), `demHeights(points, 14)`, `Pad`, логика сопряжения из `applyPads`.
- Produces:

```ts
export const ROAD_WINDOW_M = 90;
/** ROAD_WINDOW_M, or less where both tiles of a seam see less of a road (a function of latitude) */
export function roadWindow(lat: number): number;
/** H per sample: the kernel average of `dem` over the network within `window` m of path; NaN where no sample with a height is in reach */
export function solveRoadHeights(net: RoadNet, dem: ArrayLike<number>, window?: number): Float64Array;
/** raw z14 heights at the network's samples, brought to the pads on and round an aerodrome */
export async function fetchRoadDem(net: RoadNet, pads: ReadonlyArray<Pad>): Promise<Float64Array>;
// aerodrome.ts
/** a raw height at lon/lat as applyPads leaves the lattice there: on the pad's plane, blended over PAD_BLEND_M */
export function padAdjust(pads: ReadonlyArray<Pad>, lon: number, lat: number, h: number): number;
```

- [ ] **Step 1: Failing tests:**

```ts
const flatThenStep = (x: number) => 500 + (x > SIZE / 2 ? 10 : 0);
it('smooths a step in the DEM over the window', () => {
  const net = buildRoadNet([road({ highway: 'primary' }, [[4, 32], [60, 32]])]);
  const h = solveRoadHeights(net, demOf(net, flatThenStep));
  for (let i = 1; i < h.length; i++) expect(Math.abs(h[i] - h[i - 1])).toBeLessThan(1.5); // 10 m over ~180 m
  expect(h[0]).toBeCloseTo(500, 1);
  expect(h[h.length - 1]).toBeCloseTo(510, 1);
});
it('gives every way through a node one height there', () => {
  const a = road({ highway: 'primary' }, [[4, 32], [32, 32], [60, 32]]), b = road({ highway: 'residential' }, [[32, 32], [32, 60]]);
  const net = buildRoadNet([a, b]);
  const h = solveRoadHeights(net, demOf(net, (x, y) => 500 + 0.1 * y + 8 * Math.sin(x / 40)));
  const at = (w: number, lon: number, lat: number) => h[net.samples.findIndex((s) => s.way === w && s.lon === lon && s.lat === lat)];
  const [lon, lat] = a.points[1];
  expect(at(0, lon, lat)).toBeCloseTo(at(1, lon, lat), 9);
});
it('bends a motorway less than 0.2 m where a street joins it', () => {
  const dem = (x: number, y: number) => 500 + 0.15 * (y - SIZE / 2); // the street climbs away at 15 %
  const mw = road({ highway: 'motorway' }, [[4, 32], [32, 32], [60, 32]]);
  const alone = buildRoadNet([mw]), joined = buildRoadNet([mw, road({ highway: 'residential' }, [[32, 32], [32, 60]])]);
  const h0 = solveRoadHeights(alone, demOf(alone, dem)), h1 = solveRoadHeights(joined, demOf(joined, dem));
  for (let i = 0; i < alone.samples.length; i++) expect(Math.abs(h1[i] - h0[i])).toBeLessThan(0.2);
});
it('is the same whichever part of the network a tile sees beyond the window', () => {
  const dem = (x: number, y: number) => 500 + 12 * Math.sin(x / 55) + 0.05 * y;
  const whole = road({ highway: 'secondary' }, [[2, 30], [20, 31], [40, 29], [62, 32]]);
  const cut = road({ highway: 'secondary' }, [[20, 31], [40, 29], [62, 32]]);
  const a = buildRoadNet([whole]), b = buildRoadNet([cut]);
  const ha = solveRoadHeights(a, demOf(a, dem)), hb = solveRoadHeights(b, demOf(b, dem));
  // a point further than the window from the cut: 5 cm
  const far = (s: NetSample) => (s.lon - whole.points[1][0]) * 111320 * Math.cos((s.lat * Math.PI) / 180) > ROAD_WINDOW_M + 5;
  b.samples.forEach((s, i) => { if (!far(s)) return; const k = a.samples.findIndex((t) => t.lon === s.lon && t.lat === s.lat); expect(Math.abs(ha[k] - hb[i])).toBeLessThan(0.05); });
});
it('takes no height from a tunnel, and a bridge’s from under it', () => {
  const dem = (x: number) => 500 + (Math.abs(x - SIZE / 2) < 60 ? 40 : 0); // a 40 m ridge
  const t = buildRoadNet([road({ highway: 'primary' }, [[4, 32], [28, 32]]), road({ highway: 'primary', tunnel: 'yes' }, [[28, 32], [36, 32]]), road({ highway: 'primary' }, [[36, 32], [60, 32]])]);
  const ht = solveRoadHeights(t, demOf(t, dem));
  expect(Math.max(...Array.from(ht).filter(Number.isFinite))).toBeLessThan(530);
});
it('runs round a ring both ways', () => {
  const ring = Array.from({ length: 25 }, (_, k): [number, number] => [32 + 4 * Math.cos((k / 24) * 2 * Math.PI), 32 + 4 * Math.sin((k / 24) * 2 * Math.PI)]);
  const net = buildRoadNet([road({ highway: 'tertiary', junction: 'roundabout' }, ring)]);
  const h = solveRoadHeights(net, demOf(net, (x) => 500 + 0.1 * x));
  expect(h[0]).toBeCloseTo(h[h.length - 1], 6);
  for (let i = 1; i < h.length; i++) expect(Math.abs(h[i] - h[i - 1])).toBeLessThan(1);
});
it('is NaN where the DEM is missing all round, without throwing', () => {
  const net = buildRoadNet([road({ highway: 'primary' }, [[4, 32], [60, 32]])]);
  expect(Array.from(solveRoadHeights(net, new Float64Array(net.samples.length).fill(NaN))).every(Number.isNaN)).toBe(true);
});
it('lays a road on an aerodrome pad on its plane', () => {
  const pad = padAround(32, 32, 300); // from roads-helpers: a flat pad at 500 m
  const [lon, lat] = road({ highway: 'service' }, [[32, 32], [33, 32]]).points[0];
  expect(padAdjust([pad], lon, lat, 512)).toBeCloseTo(500, 6);
});
```

- [ ] **Step 2:** Запустить — падают.
- [ ] **Step 3:** Реализовать. Ядро `K(d) = (1 − (d/L)²)²`; вес точки — `K · weight` пути; расстояние — Дейкстра от каждой точки с обрывом на `L`. Точки тоннеля в сумму не входят; точки моста входят. `fetchRoadDem`: `demHeights` одним вызовом по всем точкам, затем `padAdjust`. `roadWindow(lat)`: `min(90, видимое(lat) · 90/150)`, где видимое — формула буфера PMTiles (`32/256` тайла z14 минус 5 м), не больше 150.
- [ ] **Step 4:** Тесты и типы зелёные.
- [ ] **Step 5: Commit** `feat(roads): road heights by a window along the network`

### Task 5: Подъёмы и просвет между поверхностями

**Files:**
- Modify: `src/world/road-levels.ts`
- Test: `tests/road-levels.test.ts`

**Interfaces:**
- Produces: `LIFT_REACH_M = 90`; `buildRoadLevels(lines, areas, toXZ, opts?: { height?: (line: OsmLine, d: number) => number }): RoadLevels` — `height` даёт `H` пути в `d` метрах от его начала.

- [ ] **Step 1: Failing tests** (в стиле существующих в файле):

```ts
it('reaches 90 m along the roads', () => { expect(LIFT_REACH_M).toBe(90); });
it('lifts a bridge by what is left to the clearance over the road under it', () => {
  // the bridge's own height 3 m over the lower road's at the crossing: 3 m more makes LEVEL_M
  const levels = buildRoadLevels([bridge, under], [], toXZ, { height: (l) => (l === bridge ? 503 : 500) });
  expect(levels.maxLift(bridge)).toBeCloseTo(LEVEL_M - 3, 2);
});
it('lifts nothing where the bridge already clears the road under it', () => {
  const levels = buildRoadLevels([bridge, under], [], toXZ, { height: (l) => (l === bridge ? 510 : 500) });
  expect(levels.maxLift(bridge)).toBeLessThan(LIFT_EPS_M);
});
it('lifts as before without heights', () => {
  expect(buildRoadLevels([bridge, under], [], toXZ).maxLift(bridge)).toBeCloseTo(LEVEL_M, 2);
});
```

(`bridge`, `under`, `toXZ` — как в соседних тестах файла: мост `highway=secondary, bridge=yes` над `highway=residential`.)

- [ ] **Step 2:** Запустить — падают.
- [ ] **Step 3:** Реализовать: при пересечении с дорогой или рельсами нужный подъём — `max(0, height(нижний, dНижн) + просвет − height(верхний, dВерхн))`; без `height` или при `NaN` — как сейчас. Над водой — как сейчас. Существующие тесты, завязанные на 150 м, поправить под 90 м.
- [ ] **Step 4:** Тесты и типы зелёные.
- [ ] **Step 5: Commit** `feat(roads): bridge clearance between the roads' own heights; lifts reach 90 m`

### Task 6: Поле подтяжки

**Files:**
- Create: `src/world/road-pull.ts`
- Test: `tests/road-pull.test.ts`

**Interfaces:**
- Consumes: `RoadNet`, высоты (Task 4), подъёмы (Task 5).
- Produces:

```ts
/** the roads of a tile with the height of each network sample: H and the lift */
export interface RoadSurface { net: RoadNet; z: Float64Array }
export interface RoadPull {
  /** how far the ground at lattice point (x, y) is pulled to the roads: 1 on a bed, 0 beyond every band */
  weight(x: number, y: number): number;
  /** the ground there, given the base relief's height */
  height(x: number, y: number, base: number): number;
  /** the bed outline of each road inside the tile (lattice), the senior first; cut out of more senior beds */
  beds: Array<{ way: number; edges: Pt[][] }>;
}
export function buildRoadPull(tile: Tile, grid: number, roads: RoadSurface): RoadPull;
```

- [ ] **Step 1: Failing tests:**

```ts
const flatAt = (h: number) => (net: RoadNet) => ({ net, z: new Float64Array(net.samples.length).fill(h) });
it('is the road’s height on its bed and the base beyond its band', () => {
  const net = buildRoadNet([road({ highway: 'primary' }, [[4, 32], [60, 32]])]); // bed 9.5 m, band 45 m
  const pull = buildRoadPull(TILE, GRID, flatAt(520)(net));
  for (const off of [0, 5, 9]) expect(pull.height(32, 32 + off * M, 500)).toBeCloseTo(520, 6);
  expect(pull.height(32, 32 + 60 * M, 500)).toBeCloseTo(500, 6);
  expect(pull.weight(32, 32 + 60 * M)).toBe(0);
});
it('falls off smoothly and monotonically across the band', () => {
  const net = buildRoadNet([road({ highway: 'primary' }, [[4, 32], [60, 32]])]);
  const pull = buildRoadPull(TILE, GRID, flatAt(520)(net));
  let prev = 520;
  for (let off = 9.5; off <= 54.5; off += 1) { const h = pull.height(32, 32 + off * M, 500); expect(h).toBeLessThanOrEqual(prev + 1e-9); expect(prev - h).toBeLessThan(1.2); prev = h; }
});
it('keeps each bed at its own road where another runs in its band at another height', () => {
  const lo = road({ highway: 'residential' }, [[4, 32], [60, 32]]), hi = road({ highway: 'primary' }, [[4, 32 + 25 * M], [60, 32 + 25 * M]]);
  const net = buildRoadNet([lo, hi]);
  const z = Float64Array.from(net.samples, (s) => (s.way === 0 ? 500 : 508));
  const pull = buildRoadPull(TILE, GRID, { net, z });
  expect(pull.height(32, 32, 504)).toBeCloseTo(500, 6);
  expect(pull.height(32, 32 + 25 * M, 504)).toBeCloseTo(508, 6);
});
it('gives the senior road’s height where beds overlap', () => {
  const main = road({ highway: 'primary' }, [[4, 32], [60, 32]]), side = road({ highway: 'residential' }, [[32, 32], [32, 60]]);
  const net = buildRoadNet([side, main]);
  const z = Float64Array.from(net.samples, (s) => (s.way === 0 ? 503 : 500)); // the side road 3 m up
  const pull = buildRoadPull(TILE, GRID, { net, z });
  expect(pull.height(32, 32 + 5 * M, 500)).toBeCloseTo(500, 6); // on the primary's bed, on the side road's axis
});
it('does not pull to a bridge or a tunnel, nor to a road without a height', () => {
  const net = buildRoadNet([road({ highway: 'primary', bridge: 'yes' }, [[4, 32], [60, 32]]), road({ highway: 'primary' }, [[4, 50], [60, 50]])]);
  const z = Float64Array.from(net.samples, (s) => (s.way === 0 ? 520 : NaN));
  const pull = buildRoadPull(TILE, GRID, { net, z });
  expect(pull.weight(32, 32)).toBe(0);
  expect(pull.weight(32, 50)).toBe(0);
  expect(pull.beds.length).toBe(0);
});
it('outlines each bed within 0.2 m of the road’s height along it', () => {
  const net = buildRoadNet([road({ highway: 'secondary' }, [[4, 30], [20, 34], [44, 28], [60, 33]])]);
  const z = Float64Array.from(net.samples, (s) => 500 + 6 * Math.sin(s.d / 50));
  const pull = buildRoadPull(TILE, GRID, { net, z });
  for (const line of pull.beds[0].edges) for (let k = 1; k < line.length; k++) for (let t = 0; t <= 1; t += 0.1) {
    const x = line[k - 1].x + (line[k].x - line[k - 1].x) * t, y = line[k - 1].y + (line[k].y - line[k - 1].y) * t;
    const chord = pull.height(line[k - 1].x, line[k - 1].y, 0) * (1 - t) + pull.height(line[k].x, line[k].y, 0) * t;
    expect(Math.abs(pull.height(x, y, 0) - chord)).toBeLessThanOrEqual(0.2);
  }
});
```

- [ ] **Step 2:** Запустить — падают.
- [ ] **Step 3:** Реализовать по формуле дизайна. `u = S(1 − max(0, dist − half)/band)`, `S` — гладкая ступень; вес в `R` — `u/(1 − u)`; на ложе — высота самой старшей дороги, чьё ложе содержит точку (`prio`, затем порядок в сети). Высота точки оси — линейно между соседними точками сети. Поиск близких отрезков — по сетке ячеек. Контур ложа: смещения оси на `±half`, упрощённые по высоте до 0,2 м и по плану до 0,5 м, обрезанные квадратом тайла и вырезанные из лож старших дорог. Ширина полосы каждой дороги умножается на `roadWindow(lat) / ROAD_WINDOW_M` (севернее тайл видит меньше); при `roadWindow(lat) < 30` подтяжки нет вовсе (`beds` пуст, `weight` — 0).
- [ ] **Step 4:** Тесты и типы зелёные.
- [ ] **Step 5: Commit** `feat(roads): the ground pulled to the roads`

### Task 7: Поверхность тайла

**Files:**
- Create: `src/world/surface-tin.ts`
- Modify: `src/world/terrain-tin.ts`
- Test: `tests/surface-tin.test.ts`, `tests/surface-seam.test.ts`

**Interfaces:**
- Consumes: `RoadPull` (Task 6), `buildTerrainTin`, `constrainedDelaunay` (Task 1).
- Produces:

```ts
// terrain-tin.ts
export interface TinOptions {
  // …
  /** lines forced in as fixed edges on the relief's surface (lattice): they subdivide it, their vertices take its height */
  fixedLines?: ReadonlyArray<ReadonlyArray<Pt>>;
  /** points added on the relief's surface the same way */
  extraPoints?: ReadonlyArray<Pt>;
}
// surface-tin.ts
export const MAX_SURFACE_VERTS = 12000;
export interface SurfaceOptions extends TinOptions { roads?: RoadSurface }
export interface SurfaceTin extends TerrainTin {
  /** roads whose bed edges the vertex budget left out: their ribbons lie on the ground as ever */
  loose?: Set<OsmLine>;
}
export function buildSurfaceTin(tile: Tile, grid: number, heights: Float32Array, opts?: SurfaceOptions): SurfaceTin;
/** the roads of a z14 tile with their heights (network, raw DEM, lifts); undefined below DETAIL_Z or without roads */
export async function fetchRoadSurface(tile: Tile, data: { lines: OsmLine[]; areas: OsmArea[] }, pads: ReadonlyArray<Pad>): Promise<RoadSurface | undefined>;
```

- [ ] **Step 1: Failing tests** `tests/surface-tin.test.ts`:

```ts
const slope = lattice((x, y) => 500 + 0.2 * x + 0.05 * y);
const surfaceOf = (roads: OsmLine[], h: Float32Array = slope, opts: SurfaceOptions = {}) => {
  const net = buildRoadNet(roads), z = solveRoadHeights(net, demOf(net, (x, y) => 500 + 0.2 * x + 0.05 * y));
  return { tin: buildSurfaceTin(TILE, GRID, h, { ...opts, roads: { net, z } }), net, z };
};
it('is the base TIN without roads', () => {
  expect(buildSurfaceTin(TILE, GRID, slope)).toEqual(buildTerrainTin(TILE, GRID, slope));
});
it('lays the ground level across a road on a hillside, at the road’s height', () => {
  const r = road({ highway: 'primary' }, [[32, 6], [32, 58]]); // runs south across a 20 % cross slope
  const { tin } = surfaceOf([r]);
  for (const y of [400, 800, 1200]) { const h = at(tin, SIZE / 2, y); for (const off of [-9, -4, 4, 9]) expect(at(tin, SIZE / 2 + off, y)).toBeCloseTo(h, 1); }
});
it('leaves the ground beyond the bands as the base relief', () => {
  const base = buildTerrainTin(TILE, GRID, slope), { tin } = surfaceOf([road({ highway: 'primary' }, [[32, 6], [32, 58]])]);
  for (const y of [300, 900]) for (const off of [-120, 120]) expect(at(tin, SIZE / 2 + off, y)).toBeCloseTo(at(base, SIZE / 2 + off, y), 3);
});
it('has no steeper ground beside the road than the pull makes', () => {
  const { tin } = surfaceOf([road({ highway: 'primary' }, [[32, 6], [32, 58]])]);
  // 20 % cross slope: 9.5 m bed + 45 m band; no face steeper than 60 % across (no wall)
  for (let off = -60; off < 60; off += 2) expect(Math.abs(at(tin, SIZE / 2 + off + 2, 900) - at(tin, SIZE / 2 + off, 900)) / 2).toBeLessThan(0.6);
});
it('covers the tile once, with no vertex on another face’s edge', () => {
  const rnd = seeded(11); // from roads-helpers
  const roads = Array.from({ length: 60 }, () => road({ highway: rnd() < 0.3 ? 'primary' : 'residential' }, [[rnd() * 64, rnd() * 64], [rnd() * 64, rnd() * 64]]));
  const { tin } = surfaceOf(roads);
  expect(area(tin)).toBeCloseTo(GRID * GRID, 6);
  expect(cracks(tin)).toBe(0); // helpers: area, cracks (the Task 1 check on a TIN)
});
it('survives two ways along the same line', () => {
  const pts: [number, number][] = [[6, 30], [58, 34]];
  const { tin } = surfaceOf([road({ highway: 'primary' }, pts), road({ highway: 'primary' }, pts), road({ highway: 'residential' }, [pts[0], [32, 32]])]);
  expect(area(tin)).toBeCloseTo(GRID * GRID, 6);
  expect(cracks(tin)).toBe(0);
});
it('keeps the sea the sea beside a coast road and under a causeway', () => {
  const coast = lattice((x) => (x < SIZE / 2 ? 0 : 3 + 0.02 * (x - SIZE / 2)));
  const net = buildRoadNet([road({ highway: 'primary' }, [[33, 4], [33, 60]]), road({ highway: 'primary' }, [[4, 32], [60, 32]])]);
  const tin = buildSurfaceTin(TILE, GRID, coast, { roads: { net, z: new Float64Array(net.samples.length).fill(4) } });
  for (const y of [300, 1200]) expect(at(tin, SIZE / 4, y)).toBe(0);
});
it('keeps an aerodrome pad flat under a road across it', () => {
  const pad = padAround(32, 32, 300), flat = lattice(() => 500);
  const net = buildRoadNet([road({ highway: 'service' }, [[20, 32], [44, 32]])]);
  const tin = buildSurfaceTin(TILE, GRID, flat, { pads: [pad], roads: { net, z: new Float64Array(net.samples.length).fill(506) } });
  expect(at(tin, SIZE / 2, SIZE / 2)).toBeCloseTo(500, 6);
});
it('lets the youngest roads’ edges go over the budget, and still steps nowhere', () => {
  const rnd = seeded(5);
  const roads = Array.from({ length: 2500 }, () => { const x = rnd() * 62 + 1, y = rnd() * 62 + 1; return road({ highway: 'residential' }, [[x, y], [x + rnd() - 0.5, y + rnd() - 0.5]]); });
  const { tin } = surfaceOf(roads);
  expect(tin.vx.length).toBeLessThanOrEqual(MAX_SURFACE_VERTS);
  expect(tin.loose!.size).toBeGreaterThan(0);
  expect(cracks(tin)).toBe(0);
});
it('leaves a road without a height on the ground as ever', () => {
  const r = road({ highway: 'primary' }, [[32, 6], [32, 58]]), net = buildRoadNet([r]);
  const tin = buildSurfaceTin(TILE, GRID, slope, { roads: { net, z: new Float64Array(net.samples.length).fill(NaN) } });
  expect(tin.vh).toEqual(buildTerrainTin(TILE, GRID, slope).vh);
});
```

`tests/surface-seam.test.ts` (шов двух соседних тайлов `TILE` и `B = { ...TILE, x: TILE.x + 1 }`):

```ts
const relief = (x: number, y: number) => 500 + 25 * Math.sin(x / 300) + 0.06 * y;
const both = (roads: OsmLine[]) => [TILE, B].map((t) => {
  const net = buildRoadNet(roads), z = solveRoadHeights(net, demOf(net, relief));
  const heights = lattice(relief, t), borders = bordersOf(relief, t); // helpers: the shared border profiles
  return buildSurfaceTin(t, GRID, heights, { borders, roads: { net, z } });
});
const gap = ([a, b]: TerrainTin[]) => { const sa = tinLatticeSampler(a), sb = tinLatticeSampler(b); let w = 0; for (let y = 0; y <= GRID; y += 0.02) w = Math.max(w, Math.abs(sa(GRID, y) - sb(0, y))); return w; };
for (const seed of [1, 7, 42, 99]) it(`meets its neighbour on the seam under scattered roads (seed ${seed})`, () => {
  const rnd = seeded(seed);
  const roads = Array.from({ length: 30 }, () => road({ highway: rnd() < 0.3 ? 'primary' : 'residential' }, [[40 + rnd() * 20, rnd() * 64], [66 + rnd() * 20, rnd() * 64]]));
  expect(gap(both(roads))).toBeLessThan(0.05);
});
it('meets its neighbour where a road runs along the border and where one grazes it', () => {
  expect(gap(both([road({ highway: 'primary' }, [[64, 4], [64, 60]])]))).toBeLessThan(0.05);
  expect(gap(both([road({ highway: 'secondary' }, [[40, 20], [64, 30], [88, 34]]), road({ highway: 'residential' }, [[50, 40], [64.2, 44], [50, 48]])]))).toBeLessThan(0.05);
});
```

- [ ] **Step 2:** Запустить — падают.
- [ ] **Step 3:** Реализовать.
  - `terrain-tin.ts`: `fixedLines` и `extraPoints` вставляются в триангуляцию тем же механизмом, что контуры площадок (`insertColourLines`), с высотой поверхности рельефа в точке; концы на границе становятся вершинами границы.
  - `buildSurfaceTin`: без дорог — базовая сетка. Иначе `buildRoadPull`; `fixedLines` — кромки лож (старшие первыми, пока вместе с узлами полос хватает `MAX_SURFACE_VERTS`; остальные пути — в `loose`); `extraPoints` — узлы решётки с `weight > 0`. После триангуляции `vh[k] = pull.height(vx[k], vy[k], vh[k])`, кроме: вершин с базовой высотой ≤ 0 и вершин береговой линии (остаются 0), вершин на площадке аэродрома.
  - Граница: общие вершины — узлы решётки на границе с `weight > 0` и пересечения кромок с границей (координата вдоль границы округляется до 1e-6 клетки); они вне бюджета. Вершина границы, не входящая в общие, получает высоту на отрезке между соседними общими вершинами (после `F`), а где общих рядом нет — прежнюю.
  - Стык с более грубым соседом (`coarse.dh`) считается от итоговых высот, после `F`.
  - `fetchRoadSurface`: `buildRoadNet` → `fetchRoadDem` → `solveRoadHeights(…, roadWindow(lat))` → `buildRoadLevels(…, { height })` → `z = H + подъём`.
- [ ] **Step 4:** Тесты, полный набор и типы зелёные.
- [ ] **Step 5: Commit** `feat(terrain): the tile's surface built under its roads`

### Task 8: Подключение

**Files:**
- Modify: `src/world/terrain-mesher.ts`, `src/world/osm-mesher.ts`, `src/workers/terrain.worker.ts`, `src/workers/osm.worker.ts`, `src/world/ground.ts`, `src/world/tile-cache.ts`, `src/tools/relief.ts` (и другие места, где зовётся `buildTerrainTin` для отрисовки)
- Test: `tests/terrain-mesher.test.ts`, `tests/road-levels-mesh.test.ts`, `tests/osm-mesher.test.ts`

**Interfaces:**
- Consumes: `buildSurfaceTin`, `fetchRoadSurface` (Task 7).
- Produces: `TerrainMeshOptions.roads?: RoadSurface`; `OsmMeshOptions.roads?: RoadSurface`.

- [ ] **Step 1: Failing tests:**

```ts
// terrain-mesher.test.ts
it('builds the mesh on the surface under the roads', () => {
  const r = road({ highway: 'primary' }, [[32, 6], [32, 58]]), net = buildRoadNet([r]);
  const roads = { net, z: solveRoadHeights(net, demOf(net, (x, y) => 500 + 0.2 * x + 0.05 * y)) };
  const plain = buildTerrainMesh({ tile: TILE, grid: GRID, heights: slope }), withRoads = buildTerrainMesh({ tile: TILE, grid: GRID, heights: slope, roads });
  expect(withRoads.vertexCount).toBeGreaterThan(plain.vertexCount);
});
// osm-mesher.test.ts
it('lays a road’s ribbon level across on a hillside', () => {
  // the ribbon of a primary across a 20 % cross slope: its two edges within 0.3 m (2.8 m on the bare relief)
  expect(ribbonSpread(true)).toBeLessThan(0.3);
  expect(ribbonSpread(false)).toBeGreaterThan(2);
});
// road-levels-mesh.test.ts
it('builds a bridge at the road’s own height plus its lift, over ground left as it was', () => {
  // deck vertices at mid-span: H + LEVEL-clearance lift, whatever the base relief dips to under it
  expect(deckY).toBeCloseTo(roadZ + lift, 1);
});
```

(`ribbonSpread`, `deckY` — по образцу существующих тестов этих файлов: разброс высот вершин ленты в средней трети дороги; высота вершин палубы в середине пролёта.)

- [ ] **Step 2:** Запустить — падают.
- [ ] **Step 3:** Реализовать.
  - `buildTerrainMesh` и `osm.worker` строят сетку через `buildSurfaceTin`; `terrain.worker` и `osm.worker` перед этим зовут `fetchRoadSurface` (только z14, OSM тайла загружен); ошибка загрузки высот, кроме отсутствующего тайла, — `RetryableError`, как у площадок.
  - `osm-mesher`: с `roads` подъём ленты (`Lift`) для моста и поднятого пути — `z(точка оси) − высота земли под вершиной`; остальные ленты ложатся на грани как сейчас. Пути из `tin.loose` — как сейчас.
  - `ground.ts` — та же поверхность (пока в главном потоке; перенос — Task 9).
  - `SCHEMA_VERSION` → 51, `OSM_MESH_SCHEMA` 60 → 61. Ключ кэша рельефа уже различает «с OSM / без».
- [ ] **Step 4:** Полный набор и типы зелёные; `npm run build` проходит.
- [ ] **Step 5: Commit** `feat(roads): terrain, OSM drape and collisions on the surface under the roads`

### Task 9: Столкновения в воркере

**Files:**
- Create: `src/world/ground-tile.ts`, `src/workers/ground.worker.ts`
- Modify: `src/world/ground.ts`, `src/main.ts`
- Test: `tests/ground-tile.test.ts`

**Interfaces:**
- Produces: `buildGroundTile(tile: Tile): Promise<GroundTile>`, `groundSampler(g: GroundTile, tile: Tile): HeightSampler`, `packGround(tin, prisms)` — как в `f6f4460:src/world/ground-tile.ts`, с `buildSurfaceTin` и `fetchRoadSurface` вместо прежних вызовов.

- [ ] **Step 1:** Перенести `tests/ground-tile.test.ts` из `f6f4460` (упакованная сетка даёт те же высоты, что исходная).
- [ ] **Step 2:** Запустить — «module not found».
- [ ] **Step 3:** Перенести из `f6f4460` `ground-tile.ts`, `ground.worker.ts` и правки `ground.ts`/`main.ts`, заменив построение поверхности на Task 7.
- [ ] **Step 4:** Полный набор, типы, сборка зелёные.
- [ ] **Step 5: Commit** `perf(ground): the collision ground built in a worker`

### Task 10: Проверка в превью и настройка

**Files:**
- Modify: константы в `road-net.ts`, `road-heights.ts`, `road-pull.ts`, `surface-tin.ts` — только если замеры этого требуют (с записью решения)

- [ ] **Step 1:** Запустить превью (`sim`, инструмент `relief`), дождаться пересборки тайлов.
- [ ] **Step 2:** Замерить в странице (динамический импорт модулей) время `buildSurfaceTin` и число вершин — медиана из пяти:

| Тайл | Цель |
|---|---|
| 14/8710/5744 (центр Инсбрука) | ≤ 150 мс |
| 14/8710/5743 | ≤ 80 мс |
| 14/9516/6398, 14/9517/6398, 14/9516/6394 (Фетхие) | ≤ 60 мс |

- [ ] **Step 3:** На тех же тайлах вдоль осей всех дорог сети, шаг 1 м: число перепадов земли > 0,5 м на метр (ожидается 0 вне мостов и границ с морем) и наибольшее расхождение земли на ложе с высотой дороги (ожидается ≤ 0,2 м).
- [ ] **Step 4:** Снимки четырёх мест из дизайна (город Фетхие; перекрёсток 36.62100, 29.11522; развязка 36.68719, 29.10391; Инсбрук) — отправить пользователю.
- [ ] **Step 5:** Консоль без ошибок; `npx vitest run tests/`, `npx tsc --noEmit -p .`, `npm run build`, `git diff --check` — чисто.
