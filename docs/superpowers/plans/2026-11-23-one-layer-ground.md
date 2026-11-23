# Земля в один слой — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Всё, что лежит на земле (дороги, обочины, тропинки, вода, балласт, ВПП, парковки, площадки, площади), становится гранями самой сетки рельефа z14 — по одному покрытию на грань, без подъёма по вертикали.

**Architecture:** Новый модуль `ground-cover.ts` строит из OSM тайла фигуры покрытий (треугольники для «кто здесь», кромки для сетки) в порядке старшинства. `buildSurfaceTin` вставляет кромки фигур фиксированными рёбрами вместе с ложами дорог и назначает каждой грани покрытие по её центру. Меш рельефа красит грани по покрытию (и ночной подсветкой), а грани дорог, рельсов, ВПП и воды кладёт в конец: вблизи их рисует меш OSM с атрибутами разметки на тех же вершинах, вдали — сам рельеф простым цветом.

**Tech Stack:** TypeScript, Vite, Vitest, WebGL2.

**Spec:** `docs/superpowers/specs/2026-11-23-one-layer-ground-design.md` — читать вместе с планом; при расхождении прав дизайн.

## Global Constraints

- Ветка `feat/roads-first`. Перед задачей 1 незакоммиченная правка воды и старшинства дороги над рекой (SCHEMA_VERSION 57, OSM_MESH_SCHEMA 68) должна быть закоммичена — только с разрешения пользователя.
- **Не коммитить без просьбы пользователя.** Шаги «Commit» выполняются только после его разрешения; иначе итог задачи пишется в журнал.
- Старшинство покрытий (сверху вниз): `runway` 1 (линии `aeroway=runway|taxiway`), `ballast` 2, `carriageway` 3 (между собой по `roadPriority`, равные — по `tieBreak` первой точки), `shoulder` 4, `path` 5 (`PATH_KINDS`), `water` 6, `railZone` 7, `aeroArea` 8 (`aeroway=runway|taxiway|apron|helipad` площади и точки-вертолётные площадки), `carPark` 9, `pitchPaint` 9.5, `pitch` 10, `area` 11 (пашня, парк, сад, гольф, кустарник, пляж, скалы, болото, `building`-площади). Земля — без покрытия.
- Кромка асфальта — лента, как рисуется сейчас: `forkShift`, сужения `continuationWidth`, круглые торцы тупиков, прямые торцы у перекрёстков, митры на стыках (`roadEnds`). Ложе из `road-pull` не меняется.
- Мосты (`bridge≠no`) и тоннели — не покрытия. Поднятые участки путей (`liftAt ≥ LIFT_EPS_M` по `road-levels`) — не покрытия: они остаются лентами с подъёмом и насыпями, но с нулевым смещением (bias 0), покрытие кончается там, где начинается подъём.
- Бюджет вершин поверхности z14: `MAX_SURFACE_VERTS = 30000`. При нехватке выпадают кромки целыми фигурами в обратном старшинству порядке; ложа дорог и рек выпадают вместе со своей дорогой или рекой. Выпавшая площадь или вода красит грани по центру; выпавшая дорога, тропинка, балласт или ВПП рисуются лентой поверх, как сейчас (`SurfaceTin.loose`).
- Ночная подсветка — уровень свечения в цвете грани рельефа; `buildGlowGround` и `glowVertices/glowRamps` уходят.
- Вблизи (`slant < HOUSE_RADIUS_M`, 3,5 км) рельеф рисует только грани без дорог, рельсов, ВПП и воды; дальше — и грани дорог, рельсов, ВПП (простым цветом). Грани воды рельеф не рисует никогда (меш воды рисуется на любом расстоянии).
- Без `cover` (тайлы грубее z14, `detail: 'large'`, тесты без OSM) всё работает как сейчас.
- Бюджет: поверхность плотного городского тайла (14/8710/5744, 14/9517/6398) ≤ 250 мс в браузере, обычного ≤ 120 мс; `tests/perf.test.ts` зелёный.
- Версии кэша: `SCHEMA_VERSION` 58, `OSM_MESH_SCHEMA` 69.
- Комментарии в коде — по-английски, в стиле файла; `git diff --check` чистый.
- Проверки после каждой задачи: `npx vitest run tests/`, `npx tsc --noEmit -p .`. Падения `tests/perf.test.ts` и `tests/landsat-process.test.ts` под параллельной нагрузкой перепроверять отдельным запуском; тесты под `.claude/worktrees/` — чужие.

## Review Focus

1. Кромка покрытия пересекает границу тайла под острым углом или идёт вдоль неё — оба тайла дают одинаковые назначения и высоты на шве (тест в Задаче 3).
2. Площадь с внутренним кольцом (парк с прудом, мультиполигон) — грань в дыре не получает покрытие площади (тест в Задаче 2).
3. Железная дорога, поднятая над дорогой: дорога под ней — покрытие, путь — лента с насыпью, покрытие балласта кончается в начале подъёма (тест в Задаче 2).
4. Плотный город сверх бюджета: выпадают площади, дороги остаются, трещин нет (тест в Задаче 3).
5. Смена фильтров в редакторе стилей площадей: рельеф z14 перестраивается с фильтром, в кэш не пишется (тест в Задаче 5).

---

### Task 1: Геометрия лент отдельным модулем

Чистый перенос: вывод `buildOsmMesh` не меняется.

**Files:**
- Create: `src/world/way-styles.ts`, `src/world/ribbon-shapes.ts`
- Modify: `src/world/osm-mesher.ts` (строки 48–60, 220–466, 962–1389)
- Test: `tests/ribbon-shapes.test.ts`

**Interfaces:**
- Produces (`way-styles.ts`, перенос из `osm-mesher.ts` без изменений, `osm-mesher.ts` реэкспортирует всё, что экспортировал): `classifyLine`, `classifyArea(tags, styles): AreaStyle | undefined` (теперь экспортируется вместе с `AreaStyle`), `roadRank`, `roadPriority`, `roadLayer`, `tieBreak(p: LonLat): number` (теперь экспортируется), `isOnewayRoad`, `roadMarks`, `isTunnel`, `isOpenCarPark`, `isLitRoad`, `osmWidthM`, `waterwayWidth`, `roadClassWidth`, `PATH_KINDS`, `RAIL_KINDS`, ramps и ширины (`BALLAST_WIDTH_M`, `RAIL_ZONE_M`, `SHOULDER_RAMP`, …), `LINK_RANK`, `LIT_ROAD_GLOW`, `UNLIT_ROAD_GLOW`, `PITCH_GLOW`, `PITCH_BIAS`, `CAR_PARK_BIAS`, `AEROWAY_*_BIAS`.
- Produces (`ribbon-shapes.ts`):
  - типы `P2`, `VertexAttr`, `RibbonEnds`, константа `ROUND_ENDS` (перенос);
  - `interface RibbonGeom { tris: P2[]; triSeg: number[]; outline: P2[][]; cuts: P2[][] }` — треугольники ленты тройками (решётка); сегмент каждого треугольника (у торца — первый или последний сегмент, у диска стыка — сегмент этой вершины, как сейчас в `ribbon`); кромка (левая сторона, правая сторона, дуги торцов и дисков стыков, прямой торец там, где нет круглого; без внутренних рёбер); поперечные отрезки на каждой внутренней вершине осевой (`inL[i]–inR[i]` и `outL[i]–outR[i]`, где они различны);
  - `ribbonGeom(c: P2[], half: number | number[], ends: RibbonEnds, latticePerMetre: number): RibbonGeom` — тело нынешнего `ribbon` без `onFaces`;
  - `interface LineNetwork { forkShift; roadEnds; junctionGap; continuationWidth }` с прежними сигнатурами, `lineNetwork(lines: ReadonlyArray<OsmLine>, enu: (lon, lat) => P2, toLattice: (p: LonLat) => P2, latticePerMetre: number): LineNetwork`;
  - `painted(line, src: { c: P2; e: P2 }[], half: number, marks: number, net: LineNetwork): { c: P2[]; half: number[]; segs: VertexAttr[] }` — расчёт ширин и атрибутов из нынешнего `paintedRibbon` (вершины в местах изгиба ширины и в середине);
  - `trackSegs(pts: { e: P2 }[]): VertexAttr[]` — атрибуты пути, как сейчас.

- [ ] **Step 1: Write the failing test** (`tests/ribbon-shapes.test.ts`)

```ts
it('a straight ribbon is a rectangle with two round caps', () => {
  const g = ribbonGeom([[10, 32], [50, 32]], 4, ROUND_ENDS, M);   // 4 m each side; caps are 12-gons
  expect(triArea(g.tris)).toBeCloseTo(40 * 8 * M + 2 * 12 * 0.5 * (4 * M) ** 2 * Math.sin(Math.PI / 6), 6);
  expect(g.outline.flat().every((p) => onRibbonBoundary(g, p))).toBe(true);
});
it('cuts the ribbon across at each inner vertex of its centre line', () => {
  const g = ribbonGeom([[10, 32], [30, 32], [50, 40]], 0.1, { capStart: false, capEnd: false }, 1);
  expect(g.cuts.length).toBe(1);
});
it('gives every segment triangle its segment', () => {
  const g = ribbonGeom([[10, 32], [30, 32], [50, 40]], 0.1, { capStart: false, capEnd: false }, 1);
  expect(g.triSeg).toEqual([0, 0, 1, 1]);
});
```
(`triArea`, `onRibbonBoundary` — помощники в файле теста: сумма площадей треугольников и «точка лежит на стороне ровно одного треугольника».)

- [ ] **Step 2: Run** `npx vitest run tests/ribbon-shapes.test.ts` — Expected: FAIL (модуля нет).
- [ ] **Step 3: Implement** — перенести код; `ribbon` в `osm-mesher.ts` становится `ribbonGeom` + `onFaces` по `tris` с `segs?.[triSeg[k]]` (у торцов — первый/последний сегмент, у диска стыка — его сегмент, как сейчас).
- [ ] **Step 4: Run** `npx vitest run tests/` — Expected: PASS, в т.ч. `osm-mesher`, `roads-rails`, `pitches`, `road-levels-mesh` без изменений в тестах.
- [ ] **Step 5: Commit** `refactor(osm): ribbon geometry and way styles in their own modules`

---

### Task 2: Фигуры покрытий

**Files:**
- Create: `src/world/ground-cover.ts`
- Modify: `src/world/road-levels.ts` (экспорт `coverLifted`)
- Test: `tests/ground-cover.test.ts`

**Interfaces:**
- Consumes: Task 1 (`ribbonGeom`, `lineNetwork`, `painted`, `trackSegs`, `classifyLine`, `classifyArea`, `roadPriority`, `tieBreak`); `RoadSurface` (road-pull); `buildRoadLevels`, `LIFT_EPS_M`.
- Produces:
  - `type CoverKind = 'runway' | 'ballast' | 'carriageway' | 'shoulder' | 'path' | 'water' | 'railZone' | 'aeroArea' | 'carPark' | 'pitchPaint' | 'pitch' | 'area'`
  - `const COVER_RANK: Record<CoverKind, number>` — числа из Global Constraints.
  - `interface CoverShape { kind: CoverKind; source: OsmLine | OsmArea | OsmPoint; prio: number; tris: Float64Array; outline: P2[][]; attr?: { segs: VertexAttr[]; segAt(x: number, y: number): number } }` — `tris` по шесть чисел (решётка); `outline` для `carriageway`, `ballast`, `runway` включает `cuts`.
  - `interface GroundCover { shapes: CoverShape[]; locate(x: number, y: number): number }` — фигуры от старшей к младшей; `locate` — индекс старшей фигуры, чей треугольник содержит точку, или −1; ячейки решётки как в `facesNear`.
  - `buildGroundCover(tile: Tile, grid: number, data: { lines: OsmLine[]; areas: OsmArea[]; points: OsmPoint[] }, roads?: RoadSurface): GroundCover` — из целых путей и площадей (не доли тайла): что лежит за тайлом, не мешает.
  - `coverLifted(roads: RoadSurface | undefined, plain: RoadLevels): (line: OsmLine, d: number) => boolean` в `road-levels.ts`: путь сети с высотами — поднят, только если `bridge`; прочие — `plain.liftAt(line, d) ≥ LIFT_EPS_M`. Без TIN, детерминированно.

Правила фигур: дорога даёт `carriageway` (ширина — `painted`, если есть разметка, иначе `half`) и `shoulder` (полуширина + обочина, концы — как у асфальта); железная дорога — `ballast` (`BALLAST_WIDTH_M`) и `railZone` (+`RAIL_ZONE_M`, не на мосту); водоток — `water`; площади — по `classifyArea` (вода → `water`, аэродромные → `aeroArea`, `parking` → `carPark`, `pitch` → `pitch`, прочие → `area`); разметка площадок — полосы 0,12 м (`pitchPaint`) по `pitchMarkings`/`baseballMarkings`, как `buildPitch`; точка `aeroway=helipad` — квадрат 16 м (`aeroArea`). Путь режется на участки, где `coverLifted` ложно; мосты и тоннели не дают фигур. Площадь — `earcut` по кольцам с дырами.

- [ ] **Step 1: Write the failing tests**

```ts
it('orders the shapes senior first', () => {
  const c = buildGroundCover(TILE, GRID, data([rail([[4, 32], [60, 32]]), road({ highway: 'primary' }, [[32, 4], [32, 60]])], [park(square(20, 20, 10))]));
  expect(c.shapes.map((s) => s.kind)).toEqual(['ballast', 'carriageway', 'shoulder', 'railZone', 'area']);
});
it('runs the rails over the road at a level crossing', () => {
  const c = buildGroundCover(TILE, GRID, data([rail([[4, 32], [60, 32]]), road({ highway: 'primary' }, [[32, 4], [32, 60]])]));
  expect(c.shapes[c.locate(32, 32)].kind).toBe('ballast');
});
it('lays the senior of two roads over the junior where they cross', () => {
  const c = buildGroundCover(TILE, GRID, data([road({ highway: 'residential' }, [[4, 32], [60, 32]]), road({ highway: 'primary' }, [[32, 4], [32, 60]])]));
  expect((c.shapes[c.locate(32, 32)].source as OsmLine).tags.highway).toBe('primary');
});
it('puts the asphalt edge of a fork branch on the trunk’s edge', () => {
  const c = buildGroundCover(TILE, GRID, data(forkFixture()));   // two-way trunk ending where two one-way branches begin
  expect(edgeOffsetAtFork(c, 'branch-right')).toBeCloseTo(trunkHalfWidth, 1);
});
it('leaves no cover on a bridge, and none past the start of a rail approach', () => {
  const c = buildGroundCover(TILE, GRID, data([road({ highway: 'primary', bridge: 'yes' }, [[10, 32], [54, 32]]), railOverRoad()]));
  expect(c.shapes.some((s) => (s.source as OsmLine).tags?.bridge === 'yes')).toBe(false);
  expect(c.locate(...pointOnLiftedApproach)).toBe(-1);   // Review Focus 3
  expect(c.shapes[c.locate(...roadUnderRailBridge)].kind).toBe('carriageway');
});
it('leaves the hole of a park with a pond to the pond', () => {   // Review Focus 2
  const c = buildGroundCover(TILE, GRID, data([], [parkWithHole(), pond()]));
  expect(c.shapes[c.locate(32, 32)].kind).toBe('water');
  expect(c.locate(32.01, 37.5)).not.toBe(-1);
});
it('gives a painted road’s faces the segment under them', () => {
  const c = buildGroundCover(TILE, GRID, data([road({ highway: 'primary' }, [[4, 32], [30, 32], [60, 40]])]));
  const p: [number, number] = [40, 32 + 8 / 3];   // on the second segment's centre line
  const s = c.shapes[c.locate(...p)];
  expect(s.kind).toBe('carriageway');
  expect(s.attr!.segAt(...p)).toBe(1);
});
```
(`data(lines, areas = [], points = [])`, `rail`, `park`, `square`, `forkFixture`, `railOverRoad`, `parkWithHole`, `pond` — помощники в `tests/roads-helpers.ts`; координаты в клетках решётки.)

- [ ] **Step 2: Run** `npx vitest run tests/ground-cover.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `buildGroundCover` и `coverLifted`.
- [ ] **Step 4: Run** `npx vitest run tests/ground-cover.test.ts tests/road-levels.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cover): the ground covers of a tile, senior first`

---

### Task 3: Кромки покрытий в сетке

**Files:**
- Modify: `src/world/surface-tin.ts`, `src/world/road-pull.ts` (экспорт `beds[i].way` уже есть — использовать)
- Test: `tests/surface-tin.test.ts`, `tests/surface-seam.test.ts`

**Interfaces:**
- Consumes: Task 2 (`GroundCover`, `CoverShape`, `COVER_RANK`).
- Produces:
  - `SurfaceOptions.cover?: GroundCover`
  - `SurfaceTin.cover?: Int32Array` — на грань индекс фигуры в `cover.shapes` или −1;
  - `SurfaceTin.loose?: Set<OsmLine>` — прежний смысл: пути, чьи кромки выпали (дороги, тропинки, рельсы, ВПП); грани таких фигур получают −1;
  - `MAX_SURFACE_VERTS = 30000`.

Бюджет: единица выпадения — фигуры одного источника вместе с ложами его пути сети (`pull.beds[i].way` → `net.ways[k].line`); ложа без фигур — единица по рангу своего пути (`carriageway` или `water`). Единицы — в порядке старшей фигуры; `pick` берёт префикс, как сейчас. Где кромка фигуры пересекает границу тайла, точка пересечения идёт в общие точки границы (как `pull.borderPoints`). Назначение: `cover.locate` по центру грани; выпавшая площадь или вода — тоже по центру.

- [ ] **Step 1: Write the failing tests**

```ts
it('puts every edge of every cover into the surface', () => {
  const { tin, cover } = coverSurface(townFixture());
  for (const s of cover.shapes) for (const line of s.outline) expect(edgeInTin(tin, line)).toBe(true);
});
it('gives each face one cover, the senior shape under its centre, and no face straddles a cover edge', () => {
  const { tin, cover } = coverSurface(townFixture());
  for (let f = 0; f < tin.tris.length; f++) expect(tin.cover![f]).toBe(cover.locate(...centre(tin, f)));
  expect(straddling(tin, cover)).toBe(0);
});
it('covers each shape’s area less its seniors’, to the outline’s simplification', () => {
  const { tin, cover } = coverSurface(townFixture());
  for (let s = 0; s < cover.shapes.length; s++) expect(coverArea(tin, s)).toBeCloseTo(ownArea(cover, s), 2);
});
it('drops the parks before the roads when over the budget, and cracks nowhere', () => {   // Review Focus 4
  const { tin, cover } = coverSurface(denseTown(2500));
  expect(tin.vx.length).toBeLessThanOrEqual(MAX_SURFACE_VERTS);
  expect(tin.loose?.size ?? 0).toBe(0);
  expect(droppedKinds(tin, cover)).toEqual(['area']);
  expect(cracks(tin)).toBe(0);
});
```
В `tests/surface-seam.test.ts`:
```ts
it('agrees on the covers and heights where a cover edge crosses the seam at a sharp angle', () => {   // Review Focus 1
  const [a, b] = neighbours(sharpCrossing());
  expect(seamMismatch(a, b)).toBeLessThan(0.05);
  expect(seamCoverMismatch(a, b)).toBe(0);
});
```

- [ ] **Step 2: Run** `npx vitest run tests/surface-tin.test.ts tests/surface-seam.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** в `buildSurfaceTin`.
- [ ] **Step 4: Run** `npx vitest run tests/surface-tin.test.ts tests/surface-seam.test.ts tests/perf.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(terrain): every ground cover's edges in the surface`

---

### Task 4: Меш рельефа по покрытиям

**Files:**
- Modify: `src/world/terrain-mesher.ts`, `src/world/ground-cover.ts` (`coverRamp`)
- Test: `tests/terrain-mesher.test.ts`, `tests/night-lights.test.ts`

**Interfaces:**
- Consumes: Task 3 (`SurfaceTin.cover`).
- Produces:
  - `coverRamp(shape: CoverShape, styles: AreaStyles, imagery: RGB | undefined): number` в `ground-cover.ts` — цвет, который сейчас дают ленты и площади: `shoulder` `SHOULDER_RAMP` (с `LIT_ROAD_GLOW`, если дорога освещена), `path` и `carriageway` — `classifyLine(tags).ramp` со свечением `LIT_ROAD_GLOW` (освещённая, `isLitRoad`) или `UNLIT_ROAD_GLOW`, как в нынешнем `lineLook`, `ballast` `BALLAST_RAMP`, `railZone` `RAIL_ZONE_RAMP`, `runway` и `aeroArea` `RAMP.ASPHALT`, `carPark` `withGlow(ASPHALT, UNLIT_ROAD_GLOW)`, `pitch` по `classifyArea` (+`PITCH_GLOW`, если освещена), `pitchPaint` белая (`RAMP.SNOW`, +`PITCH_GLOW` на освещённой), `water` `RAMP.WATER`, `area` — ramp или фильтр по imagery.
  - `TerrainMeshOptions.cover?: GroundCover`, `.areaStyles?: AreaStyles`, `.glow?: (tin: SurfaceTin) => Uint8Array` (уровень на грань).
  - `TerrainMeshData.nearCount: number` — вершины граней без покрытий `carriageway | ballast | runway | water` и юбок; `.farCount: number` — то же плюс грани `carriageway | ballast | runway`. Порядок вершин: земля и прочие покрытия, юбки, дороги/рельсы/ВПП, вода.
  - Свечение грани: `withGlow(ramp, max(rampGlowLevel(ramp), level))`.
  - `buildGlowGround` и `GLOW_GROUND_LIFT_M` удаляются.

- [ ] **Step 1: Write the failing tests**

```ts
it('colours a park face by its filter and a shoulder face by the shoulder', () => {
  const m = buildTerrainMesh({ ...townOpts, cover, areaStyles: DEFAULT_AREA_STYLES });
  expect(m.ramps[vertexOfFaceAt(m, parkPoint)]).toBe(coverRamp(parkShape, DEFAULT_AREA_STYLES, imageryAt(parkPoint)));
  expect(m.ramps[vertexOfFaceAt(m, shoulderPoint)]).toBe(SHOULDER_RAMP);
});
it('puts the road, rail and runway faces after the ground and skirts, the water last', () => {
  const m = buildTerrainMesh({ ...townOpts, cover });
  expect(kindsInRange(m, 0, m.nearCount)).not.toContain('carriageway');
  expect(kindsInRange(m, m.nearCount, m.farCount)).toEqual(new Set(['carriageway', 'ballast']));
  expect(kindsInRange(m, m.farCount, m.vertexCount)).toEqual(new Set(['water']));
});
it('lights a built-up face by its glow level, not by a lifted copy', () => {   // night-lights.test.ts, replaces the buildGlowGround test
  const m = buildTerrainMesh({ ...townOpts, cover, glow: () => levels });
  expect(rampGlowLevel(m.ramps[litFaceVertex])).toBe(levels[litFace]);
});
it('is drawn whole without a cover', () => {
  const m = buildTerrainMesh(plainOpts);
  expect(m.nearCount).toBe(m.vertexCount);
  expect(m.farCount).toBe(m.vertexCount);
});
```

- [ ] **Step 2: Run** `npx vitest run tests/terrain-mesher.test.ts tests/night-lights.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(terrain): faces coloured by their cover, the street glow in them`

---

### Task 5: Воркер рельефа, столкновения и рисование рельефа

**Files:**
- Modify: `src/workers/terrain.worker.ts`, `src/world/chunks.ts`, `src/world/ground-tile.ts`, `src/world/tile-cache.ts` (`SCHEMA_VERSION = 58`, `nearCount`/`farCount` в записи), `src/tools/area-styles-editor.ts`, вызов `ChunkManager.draw` в `src/main.ts` и `src/tools/*` (кто его вызывает)
- Test: `tests/roads-wiring.test.ts`, `tests/chunks.test.ts`, `tests/ground-tile.test.ts`

**Interfaces:**
- Consumes: Task 2 (`buildGroundCover`), Task 4 (`nearCount`, `farCount`, `glow`, `areaStyles`).
- Produces:
  - `TileRequest.areaStyles?: AreaStyles`; не по умолчанию — кэш не читается и не пишется (как в `osm.worker.ts`).
  - `MeshResponse.nearCount`, `.farCount`; `Chunk.nearCount`, `.farCount`.
  - `ChunkManager.areaStyles: AreaStyles | undefined`; редактор ставит его вместе с `osm.areaStyles` и перестраивает тайлы z14 рельефа (`invalidate` для z14).
  - `ChunkManager.draw(..., nearRadius: number)` — тайл рисует `slant < nearRadius ? nearCount : farCount` вершин (`slant` как в `osm-manager.draw`); вызывающие передают `HOUSE_RADIUS_M`.
  - Воркер рельефа на z14 с OSM: `cover = buildGroundCover(tile, grid, data, roads)`, `glow = (tin) => glowLevels(buildingCoverage(tin, tile, clipTileData(data, tile).buildings, tinLocator(tin, tile)))`.
  - `buildGroundTile`: тот же `cover` в `buildSurfaceTin`.

- [ ] **Step 1: Write the failing tests**

```ts
it('builds the terrain, the drape and the collision ground on one surface with the covers', async () => { /* roads-wiring: same vx/vy/vh/tris from the three builders with cover */ });
it('draws a near detailed tile without its road faces and a far one with them', () => { /* chunks: count passed to drawWorld */ });
it('neither reads nor writes the cache with area styles not the defaults', async () => {   // Review Focus 5
  /* terrain.worker handler with a non-default style: getCachedMesh/putCachedMesh not called, filter colour on a park face */
});
```

- [ ] **Step 2: Run** `npx vitest run tests/roads-wiring.test.ts tests/chunks.test.ts tests/ground-tile.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/` и `npx tsc --noEmit -p .` — Expected: PASS, без ошибок типов.
- [ ] **Step 5: Commit** `feat(terrain): the terrain worker draws the covers, near without the road faces`

---

### Task 6: Дороги, рельсы, ВПП и вода — грани сетки

**Files:**
- Modify: `src/world/osm-mesher.ts`
- Test: `tests/osm-mesher.test.ts`, `tests/road-levels-mesh.test.ts`, `tests/pitches.test.ts`, `tests/roads-rails.test.ts`

**Interfaces:**
- Consumes: Task 2 (`GroundCover`, `CoverShape.attr`), Task 3 (`SurfaceTin.cover`, `loose`), Task 4 (`coverRamp`).
- Produces: `OsmMeshOptions.cover?: GroundCover` (с `tin.cover`). С ним:
  - каждая грань `tin` с покрытием `carriageway | ballast | runway` → в `roads` теми же вершинами (`Math.max(0, vh)`), без подъёма, цвет `coverRamp`, атрибуты `shape.attr.segs[shape.attr.segAt(центр)]` (у `ballast` — `trackSegs`, у `runway` — нули); `water` → в `water`;
  - площади, чья фигура есть в `cover`, не рисуются в `main`; линии разметки площадок не строятся (`pitchLines` пуст) — их рисует рельеф (`pitchPaint`); квадрат вертолётной площадки не строится;
  - ленты путей из `tin.loose` — как сейчас (со смещением);
  - поднятые участки путей (`coverLifted(roads, plainLevels)(line, d)` истинно) — ленты с подъёмом и `bias = 0`; настилы мостов (`buildDecks`) тоже с `bias = 0`; непокрытые участки лентой не рисуются.
- Без `cover` всё как сейчас.

- [ ] **Step 1: Write the failing tests**

```ts
it('draws the road faces on the terrain’s own vertices, lifted by nothing', () => {
  const m = buildOsmMesh({ ...townMeshOpts, cover });
  expect(maxLiftOverTin(m.roads, tin)).toBeLessThan(1e-4);
});
it('paints a road face as the ribbon painted it', () => {
  const withCover = buildOsmMesh({ ...straightRoadOpts, cover }), ribbon = buildOsmMesh(straightRoadOpts);
  expect(markAt(withCover, probe)).toEqual(markAt(ribbon, probe));   // u, v, edge codes interpolated at probe points along and across, and through a junction
});
it('meets a bridge’s deck with its approach without a step', () => {   // road-levels-mesh.test.ts
  expect(deckEndStep(buildOsmMesh({ ...bridgeOpts, cover }))).toBeLessThan(0.02);
});
it('draws no area fill and no pitch line over the cover', () => {
  const m = buildOsmMesh({ ...pitchParkOpts, cover });
  expect(m.vertexCount).toBe(0);
  expect(m.pitchLines.length).toBe(0);
});
it('still draws a road the budget dropped as a ribbon over the ground', () => { /* tin.loose road → roads mesh above the tin by LINE_BIAS */ });
```

- [ ] **Step 2: Run** `npx vitest run tests/osm-mesher.test.ts tests/road-levels-mesh.test.ts tests/pitches.test.ts tests/roads-rails.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(osm): roads, rails, runways and water drawn as the terrain's own faces`

---

### Task 7: Воркер OSM и менеджер

**Files:**
- Modify: `src/workers/osm.worker.ts` (`OSM_MESH_SCHEMA = 69`), `src/world/osm-manager.ts`, `src/world/tile-cache.ts`
- Test: `tests/roads-wiring.test.ts`, `tests/tile-cache.test.ts`

**Interfaces:**
- Consumes: Task 2, Task 6.
- Produces:
  - `osm.worker`: `cover = buildGroundCover(tile, grid, data, roads)` при `detail === 'full'`; тот же `cover` в `buildSurfaceTin` и `buildOsmMesh`.
  - `glowVertices`, `glowRamps` удаляются из `OsmMeshResponse`, `MeshPayload`, кэша (`MeshBuffers`, подсчёт размера) и `OsmChunk.glow`.
  - `osm-manager.draw`: вода рисуется с записью глубины (`depthWrite = true`): с ней ничего не перекрывается.

- [ ] **Step 1: Write the failing test**

```ts
it('builds the drape on the same surface and covers as the terrain worker', async () => {
  const { terrainTin, osmTin } = await bothWorkers(townTile);   // the two handlers on one cached raw OSM
  expect(osmTin.tris).toEqual(terrainTin.tris);
  expect(osmTin.cover).toEqual(terrainTin.cover);
});
it('sends no glow ground', async () => {
  expect('glowVertices' in (await osmWorkerResponse(townTile))).toBe(false);
});
```

- [ ] **Step 2: Run** `npx vitest run tests/roads-wiring.test.ts tests/tile-cache.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/` и `npx tsc --noEmit -p .` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(osm): one surface with the covers for the drape; no glow ground`

---

### Task 8: Проверка в превью и время

**Files:**
- Modify: `tests/perf.test.ts` (бюджеты), при необходимости настройки из задач 3 и 6

- [ ] **Step 1:** В `tests/perf.test.ts` — поверхность с покрытиями на плотном фикстурном городе ≤ 250 мс, на обычном тайле ≤ 120 мс (с запасом на CI, как соседние бюджеты). Run `npx vitest run tests/perf.test.ts` — Expected: PASS.
- [ ] **Step 2:** Превью `sim` (порт 5174), страница `relief`, сброшенный кэш (новые версии схем). Снимки до/после и замер сборки тайла (тёплый, вкладка видима) в местах: перекрёсток Фетхие `#36.64774,29.12803,0.20,482`; 14/9516/6398; развязка 14/9516/6394; Инсбрук 14/8710/5744; аэродром Даламан. Expected: нет щелей и перекрытий у кромок; разметка на асфальте у развилок и сужений; рельсы через дорогу на переезде; мост сходится с подходом без ступеньки; ночью подсветка земли и дорог без двойного слоя; вдали (3,5–7 км) нет дыр на месте дорог; плотные тайлы ≤ 250 мс.
- [ ] **Step 3:** `npx vitest run tests/`, `npx tsc --noEmit -p .`, `git diff --check` — Expected: всё чисто.
- [ ] **Step 4: Commit** (если менялись настройки) `perf(terrain): one-layer ground budgets`
