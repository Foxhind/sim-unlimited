# Многоуровневые развязки и мосты: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Мосты и эстакады подняты над тем, что они пересекают, с въездами, плитой, опорами и насыпями; высота одинакова по обе стороны границы тайла.

**Architecture:** Чистый модуль `road-levels.ts` считает подъём (метры над рельефом) в любой точке любого пути по геометрии и тегам в пределах 150 м. `osm-mesher.ts` добавляет этот подъём к высоте вершин существующей ленты. Новый `bridge-mesher.ts` строит тело моста и насыпи; воркер кладёт их в меш зданий (как мачты), поэтому они рисуются рядом и отбрасывают тень.

**Tech Stack:** TypeScript, Vitest, Vite; Java-профиль Planetiler (`tiles/SimProfile.java`).

**Spec:** `docs/superpowers/specs/2026-11-21-elevated-roads-design.md`

## Global Constraints

- Высота полотна = нарисованный рельеф в точке вершины (грань TIN, как сейчас) + подъём. Где подъём 0, меш дороги побайтно прежний.
- Числа из спецификации: уровень 6 м, вода 4 м, ручей 1,5 м, уклон 8 %, дальность 150 м.
- Подъём не зависит от рельефа и от того, какой тайл спрашивает.
- Только `detail: 'full'` и только при наличии `tin`; дальние тайлы и путь без TIN не меняются.
- Туннели (`isTunnel`) не участвуют ни как верхние, ни как нижние.
- Комментарии в коде на английском, в стиле файла.
- В рабочем дереве есть чужие незакоммиченные правки в `src/workers/osm.worker.ts`, `src/world/osm-source.ts`, `tiles/SimProfile.java`: их не откатывать. Коммиты — только по просьбе пользователя, только свои файлы.
- Проверка: `npx vitest run <файл>` и `npm run typecheck`. В превью звук выключен (`settings.sound = false` до загрузки).

## Review Focus

1. Путь, разрезанный на куски (PMTiles режет линии по буферу): подъём в точке не должен зависеть от того, целый путь или его куски. Тест в задаче 1.
2. Пересечение в общей вершине (перекрёсток на мосту, съезд с моста): требования нет. Тест в задаче 1.
3. Нижний путь — туннель, тропа, канава или вода в трубе: требования нет. Тест в задаче 1.
4. Вырожденная геометрия: повторяющиеся точки, сегмент нулевой длины, замкнутый путь (кольцо на эстакаде): без NaN и без исключений. Тест в задаче 1.
5. Мост у границы тайла, пересечение по другую сторону: высоты вершин на шве совпадают в обоих тайлах. Тест в задаче 2.

---

### Task 1: Поле подъёма (`road-levels.ts`)

**Files:**
- Create: `src/world/road-levels.ts`
- Test: `tests/road-levels.test.ts`

**Interfaces:**
- Consumes: `OsmLine`, `OsmArea`, `LonLat` (`osm-types.ts`); `classifyLine`, `isTunnel`, `roadLayer` (`osm-mesher.ts`). Если импорт из `osm-mesher.ts` даёт цикл, перенести `roadLayer` и `isTunnel` в `road-levels.ts` и реэкспортировать из `osm-mesher.ts`.
- Produces:

```ts
export const LEVEL_M = 6;
export const WATER_CLEAR_M = 4;
export const STREAM_CLEAR_M = 1.5;
export const LIFT_GRADE = 0.08;
export const LIFT_REACH_M = 150;
/** подъём меньше этого считается нулём */
export const LIFT_EPS_M = 0.02;

export interface RoadLevels {
  /** подъём в `d` метрах от начала пути (вдоль исходных точек пути), м; 0 для неизвестного пути */
  liftAt(line: OsmLine, d: number): number;
  /** наибольший подъём на пути: 0 — путь рисуется как раньше */
  maxLift(line: OsmLine): number;
}
/** `toXZ`: lon/lat → метры в общей плоскости (mesher `enu`) */
export function buildRoadLevels(lines: OsmLine[], areas: OsmArea[], toXZ: (p: LonLat) => [number, number]): RoadLevels;
```

Правила (из спецификации):
- Участники графа: линии с `highway` или `railway`, у которых есть `classifyLine` и нет `isTunnel`. Вершина графа — точка пути по ключу `` `${lon},${lat}` ``; ребро — сегмент пути.
- Верхний: участник с `bridge` ≠ `no`, уровень `n = roadLayer(tags)`.
- Требование в собственном пересечении сегментов (без общего конца): нижний мост уровня `m < n`, не тропа → `LEVEL_M * m + LEVEL_M`; нижний не мост, уровень `< n`, не тропа → `LEVEL_M`; `waterway` `river`/`canal` → `WATER_CLEAR_M`; `stream`/`brook` → `STREAM_CLEAR_M`; тропы (`footway`, `path`, `cycleway`, `bridleway`, `steps`), `ditch`, `drain`, вода с `tunnel` или `location=underground` → нет.
- Водные площади (`natural=water`, `waterway=riverbank`): требование `WATER_CLEAR_M` на всём отрезке моста внутри площади, точками не реже чем через 10 м.
- Над линейным нижним объектом требование держится на его полуширине в обе стороны от точки пересечения (ещё две точки).
- Точки требований становятся вершинами графа (ребро делится).
- Поле: `lift(v) = max(0, max_c(req_c − g_c · dist(c, v)))`, `g_c = max(LIFT_GRADE, req_c / LIFT_REACH_M)`. По одному проходу Дейкстры на каждое различное `g_c`; итог — максимум. Внутри ребра длины `L` между вершинами `u`, `v`: `max(0, lift_u − g·t, lift_v − g·(L − t))` по каждому проходу.

- [ ] **Step 1: Написать падающие тесты** в `tests/road-levels.test.ts`. Помощник `xz = ([lon, lat]) => [lon * 70000, -lat * 111320]`, пути задаются в градусах около (0, 0) так, чтобы длины были в метрах. Тесты и утверждения:
  - `'no bridge, no lift'`: две пересекающиеся дороги без `bridge` → `maxLift` обеих 0.
  - `'a bridge over a road is LEVEL_M up at the crossing'`: мост `primary` 400 м, под серединой `secondary` → `liftAt(bridge, 200)` ≈ 6 (±0.01); `liftAt(bridge, 200 + 50)` ≈ 6 − 0.08 × (50 − полуширина нижнего) (±0.05); `liftAt(bridge, 0)` = 0; `maxLift(lower)` = 0.
  - `'the approach carries the lift onto the next way'`: мост 40 м над дорогой, по обе стороны обычные пути по 200 м с общей вершиной → на подходе в 10 м от конца моста подъём > 3 и < 6; в 100 м — 0; значения на конце моста и в начале подхода равны.
  - `'water: 4 m over a river, 1.5 m over a stream, none over a ditch'`.
  - `'water area: held across the whole span'`: площадь шириной 200 м → подъём в середине ≥ 3.5.
  - `'stacked: a level-2 bridge over a level-1 bridge is 12 m up'`: `layer=2` над мостом без `layer` → 12 (±0.01); нижний при этом ≤ 6.
  - `'steeper past 12 m so the reach stays LIFT_REACH_M'`: `layer=3` над мостом `layer=2` → 18 в пересечении, 0 в 150 м.
  - Review Focus 1: тот же мост, разрезанный на три линии с общими концами → `liftAt` в соответствующих точках совпадает с целым (±1e-6).
  - Review Focus 2: мост и дорога с общей вершиной → `maxLift` 0.
  - Review Focus 3: нижний — `tunnel=yes`, `footway`, `ditch`, `stream` с `tunnel=culvert` → `maxLift` 0 в каждом случае.
  - Review Focus 4: путь с повторяющейся точкой и замкнутый путь над дорогой → все `liftAt` конечны, `maxLift` ≈ 6.
  - `'paths bridge too'`: `footway` с `bridge=yes` над `primary` → 6.
  - `'rails'`: `railway=rail` с `bridge=yes` над дорогой → 6; дорожный мост над рельсами → 6.
- [ ] **Step 2: Запустить** `npx vitest run tests/road-levels.test.ts` → FAIL (модуль не найден).
- [ ] **Step 3: Реализовать** `buildRoadLevels` по правилам выше. Поиск пересечений — по сетке ячеек 64 м, а не полным перебором (в тайле тысячи сегментов).
- [ ] **Step 4: Запустить** `npx vitest run tests/road-levels.test.ts` → PASS; `npm run typecheck` → без ошибок.

### Task 2: Поднятое полотно в `osm-mesher.ts`

**Files:**
- Modify: `src/world/osm-mesher.ts` (`onFaces`, `lineOnFaces`, `ribbon`, `paintedRibbon`, `buildRibbon`, `buildLine`, `placeLamps`)
- Test: `tests/road-levels-mesh.test.ts`

**Interfaces:**
- Consumes: `buildRoadLevels`, `RoadLevels`, `LIFT_EPS_M` из задачи 1.
- Produces (внутри `buildOsmMesh`, для задачи 3):

```ts
/** подъём вершины ленты по её x, z; undefined — лента на земле */
type Lift = (p: { x: number; z: number }) => number;
/** осевая линия пути с шагом ≤ 10 м на поднятых участках: расстояние, позиция, подъём */
interface Station { d: number; x: number; z: number; lon: number; lat: number; lift: number }
const stationsOf: (line: OsmLine) => Station[] | undefined; // undefined при maxLift < LIFT_EPS_M
```

Решения:
- `levels = buildRoadLevels(opts.data.lines, opts.data.areas, ([lon, lat]) => enu(lon, lat))` строится один раз, только при `tin` и `opts.detail === 'full'`.
- `onFaces` и `lineOnFaces` получают необязательный `lift`; он прибавляется к `y` каждой вершины куска после `onFace`.
- В `buildRibbon` для дорог и рельсов с `maxLift ≥ LIFT_EPS_M`: в `pts` вставляются вершины так, чтобы на поднятых участках шаг был ≤ 10 м (тем же приёмом, что `cuts` в `paintedRibbon`); `Lift` сегмента — `liftAt(line, d)`, где `d` — проекция вершины на сегмент, как в `segs` разметки. Колпаки и диски на острых изломах берут подъём своей вершины.
- Отступление от спецификации, чтобы не резать ленту обочин: обочины на въездах поднимаются вместе с полотном (на мостах их и так нет). Полоса отвода рельсов остаётся на земле.
- `placeLamps`: к `y0` столба и лампы прибавляется `liftAt` в точке пути. `roadLines` (дальние линии) поднимаются тем же `lift`.
- Путь без подъёма идёт по прежней ветке кода без изменений.

- [ ] **Step 1: Написать падающие тесты** в `tests/road-levels-mesh.test.ts` (плоский TIN на 100 м и помощники как в `tests/roads-rails.test.ts`):
  - `'a road without crossings is unchanged'`: меш одной дороги равен мешу до правки — сравнить `roads.vertices` с эталоном из того же вызова без моста (два вызова: `{ highway: 'primary' }` и он же плюс не пересекающийся с ним мост далеко) поэлементно.
  - `'the bridge deck is 6 m over the road under it'`: мост запад–восток и дорога север–юг под ним в центре тайла → максимум `y − GROUND` вершин `roads` с x в ±3 м от пересечения и z в пределах моста ≥ 6 + 1.4; минимум `y − GROUND` вершин нижней дороги < 2.
  - `'deck height falls along the approach at 8 %'`: средняя высота вершин полотна в 50 м от пересечения на 4 ± 0.4 м ниже, чем в пересечении.
  - `'lamps stand on the deck'`: мост с `lit=yes` → наибольший `y` в `lampPosts` ≥ GROUND + 5.
  - Review Focus 5: два соседних тайла (`x` и `x + 1`), мост пересекает их общую границу, нижняя дорога в 30 м от границы в восточном тайле; обоим тайлам подаётся один и тот же набор линий. Вершины `roads` на границе (|x_мир − x_границы| < 1 см) в обоих мешах имеют один и тот же набор высот (±1 см) и высота там > GROUND + 3.
- [ ] **Step 2: Запустить** `npx vitest run tests/road-levels-mesh.test.ts` → FAIL.
- [ ] **Step 3: Реализовать** изменения по списку решений.
- [ ] **Step 4: Запустить** `npx vitest run tests/road-levels-mesh.test.ts tests/roads-rails.test.ts tests/osm-mesher.test.ts` → PASS; `npm run typecheck`.

### Task 3: Тело моста и насыпи (`bridge-mesher.ts`)

**Files:**
- Create: `src/world/bridge-mesher.ts`
- Modify: `src/world/osm-mesher.ts` (вызов, поле `bridges` в `OsmMeshData`), `src/workers/osm.worker.ts` (добавить в меш зданий после мачт, как `masts`, с нулевыми `windows`)
- Test: `tests/bridge-mesher.test.ts`

**Interfaces:**
- Consumes: `Station` и `stationsOf` из задачи 2.
- Produces:

```ts
export const SLAB_THICK_M = 1;
export const PARAPET_M = 0.9;
export const PIER_SPACING_M = 30;
export const PIER_MIN_CLEAR_M = 2.5;

export interface DeckStation {
  x: number; z: number;
  /** верх полотна на оси и рельеф под осью, под левым и под правым краем, м */
  y: number; ground: number; groundL: number; groundR: number;
  /** единичный вектор влево от направления пути */
  nx: number; nz: number;
  half: number;
}
export interface DeckRun {
  stations: DeckStation[];
  /** мост: плита и опоры; иначе насыпь */
  bridge: boolean;
  /** цвет откоса насыпи */
  earth: number;
}
/** pos+normal по 6 float на вершину и цвет грани на вершину, как у остальных мешей */
export function buildDecks(runs: DeckRun[], blocked: (x: number, z: number) => boolean): { vertices: Float32Array; ramps: Uint32Array };
```

Решения:
- Участок (`DeckRun`) — непрерывный отрезок пути с подъёмом ≥ 0,3 м, обрезанный по границе тайла (станция на границе интерполируется), отдельно для мостовых и не мостовых путей.
- Мост: боковые грани плиты от `y` до `y − SLAB_THICK_M`, низ плиты, парапет высотой `PARAPET_M` толщиной 0,3 м по обоим краям; цвет `RAMP.CONCRETE`. Опора — прямоугольная стойка шириной `0.6 × half` поперёк и 1 м вдоль, от низа плиты до `ground − 1`, каждые `PIER_SPACING_M` от начала пути (по `d`, чтобы тайлы совпадали), только где `y − SLAB_THICK_M − ground > PIER_MIN_CLEAR_M` и `blocked(x, z)` ложно.
- `blocked` (строит mesher): точка в пределах полуширины + 1 м от оси любой другой рисуемой дороги или рельсов, не туннеля.
- Насыпь: с каждой стороны четырёхугольник от края полотна вниз до рельефа с заложением 1:1,5 (подошва на `1.5 × (y − groundSide)` дальше от оси, на высоте `groundSide`); цвет `earth = groundColourAt` в середине участка.
- Нормали граней наружу; вершины дублируются по граням (плоское освещение, как везде).

- [ ] **Step 1: Написать падающие тесты** в `tests/bridge-mesher.test.ts`:
  - `'a bridge run has slab sides, a parapet and piers'`: прямой участок 90 м, `y = 106`, рельеф 100, `half = 5`, `bridge: true` → есть вершины на `y = 105` (низ плиты) и на `y = 106.9` (верх парапета); есть вершины ниже 100 (основания опор); число различных по x оснований опор = 3 или 4.
  - `'no pier where blocked'`: `blocked` истинно при |x − 45| < 10 → ни одной вершины ниже 104 в этой полосе.
  - `'no piers under a low deck'`: `y = 102` → нет вершин ниже 100.
  - `'an approach run has embankment slopes down to the ground'`: `bridge: false`, `y = 104` → самые дальние от оси вершины на расстоянии `5 + 1.5 × 4` (±0.01) и высоте 100; нет вершин на 104.9 (парапета нет).
  - `'empty input'`: `buildDecks([], () => false)` → нулевые массивы.
- [ ] **Step 2: Запустить** `npx vitest run tests/bridge-mesher.test.ts` → FAIL.
- [ ] **Step 3: Реализовать** `buildDecks`; в `buildOsmMesh` собрать `DeckRun` из `stationsOf`, вернуть `bridges: { vertices, ramps, vertexCount }`; в воркере добавить их к `bmesh` после мачт.
- [ ] **Step 4: Добавить тест меша** в `tests/road-levels-mesh.test.ts`: `'the bridge has a body, the approach an embankment'` — у меша из задачи 2 `bridges.vertexCount > 0`, есть вершины `RAMP.CONCRETE` под мостом и нет ни одной вершины `bridges` в полосе нижней дороги ниже GROUND + 4.
- [ ] **Step 5: Запустить** `npx vitest run tests/bridge-mesher.test.ts tests/road-levels-mesh.test.ts` → PASS; `npm run typecheck`.

### Task 4: Запас данных и версии кэша

**Files:**
- Modify: `src/world/overpass.ts` (`ROAD_REACH_M`, `overpassQuery`), `src/world/osm-api.ts` (`withRoadReach`), `tiles/SimProfile.java`, `src/world/osm-source.ts` (`OSM_SCHEMA_VERSION`), `src/workers/osm.worker.ts` (`OSM_MESH_SCHEMA`)
- Test: `tests/overpass.test.ts`, `tests/osm-api.test.ts`

**Interfaces:**
- Produces: `ROAD_REACH_M = 150`; `export const REACH_SELECTORS: string[]` в `overpass.ts` — что берётся из запаса вокруг тайла: `ROAD_SELECTOR`, `way["railway"~"^(rail|narrow_gauge|light_rail)$"]`, `way["waterway"~"^(river|riverbank|canal|stream|brook|ditch|drain)$"]`, `way["natural"="water"]`, `relation["natural"="water"]`.

Решения:
- `overpassQuery`: каждое выражение из `REACH_SELECTORS` добавляется с bbox запаса.
- `withRoadReach`: из полос берутся пути, подходящие под `REACH_SELECTORS` (отношения из полос не достраиваются).
- `SimProfile.java`: `static final int REACH_BUFFER_PX = 32;` — `setBufferPixels` для слоя `lines` и для площадей с `natural=water` или `waterway`. Комментарий: 150 м до 60° широты, `road-levels.ts LIFT_REACH_M`.
- `OSM_SCHEMA_VERSION` 13 → 14 (дописать в комментарий «14: rails and water within ROAD_REACH_M»), `OSM_MESH_SCHEMA` 56 → 57. В обоих файлах есть чужие незакоммиченные правки: менять только эти строки.
- Архивы PMTiles не пересобирать без просьбы пользователя.

- [ ] **Step 1: Написать падающие тесты**: в `tests/overpass.test.ts` — `overpassQuery(tile, 'full')` содержит каждое выражение `REACH_SELECTORS` с bbox `roadReachBounds`, а `roadReachBounds` шире тайла на 150 м (±1 м) по широте; в `tests/osm-api.test.ts` — путь `railway=rail` и путь `waterway=river`, лежащие только в полосе запаса, попадают в результат `fetchOsmApiTile` (по образцу существующего теста дорог в запасе).
- [ ] **Step 2: Запустить** `npx vitest run tests/overpass.test.ts tests/osm-api.test.ts` → FAIL.
- [ ] **Step 3: Реализовать** правки.
- [ ] **Step 4: Запустить** `npx vitest run` (весь набор) → PASS, кроме того, что падало до начала работы (зафиксировать список до задачи 1); `npm run typecheck`.

### Task 5: Проверка в превью

- [ ] **Step 1:** Запустить dev-сервер через `preview_start` (конфигурация в `.claude/launch.json`; создать, если нет: `npm run dev`). До загрузки игры выключить звук (`settings.sound = false` в сохранённых настройках или клавиша `mute`), убедиться, что `audio.setMuted(true)` применён.
- [ ] **Step 2:** Открыть точку с развязкой в области, покрытой текущим источником OSM, и точку с мостом через реку. Снять скриншоты: эстакада над дорогой с пустотой и опорами, въезды, мост над водой.
- [ ] **Step 3:** Проверить шов: развязка на границе тайлов без ступеньки. Проверить консоль на ошибки воркера.
- [ ] **Step 4:** Сообщить пользователю, что проверено, что нет, и что архивы PMTiles старые (буфер 4 px), пока он их не пересоберёт.
