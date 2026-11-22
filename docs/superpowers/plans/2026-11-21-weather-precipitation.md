# Погода: осадки, грозы, выбор при старте. План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дождь, снег и грозы из Open-Meteo с влиянием на видимость и турбулентность, плюс ряд «Погода» на стартовом экране.

**Architecture:** Чистые модули (`weather.ts`, `weather-preset.ts`, `precipitation.ts`, `lightning.ts`) считают всё, что можно проверить тестами: вид и интенсивность осадков, пресеты, видимость, число частиц, расписание разрядов. Рендер частиц живёт в `Renderer.drawPrecip`, чтобы пользоваться той же логарифмической глубиной. `main.ts` только связывает: погода в силе → облака, воздух, туман, частицы, молнии, HUD.

**Tech Stack:** TypeScript, WebGL2, Vite, Vitest, Web Audio.

**Spec:** `docs/superpowers/specs/2026-11-21-weather-precipitation-design.md`

## Global Constraints

- Без смешивания с прозрачностью: частицы и разряд непрозрачные.
- Присланная видимость 24 км и больше даёт прежний туман 15–55 км.
- URL-подмены `?clouds=`, `?wind=`, `?temp=` сильнее пресета.
- Пресет `real` пишется в hash пустым девятым полем; старые ссылки из восьми полей работают.
- Строки меню на en/ru/ua, HUD на ru/en в верхнем регистре.
- Проверки: `npx vitest run <файл>`, `npm run typecheck`, `git diff --check`.

## Review Focus

- Ответ Open-Meteo без новых полей (старый кэш, сбой): осадков нет, игра не падает. Тест в задаче 1.
- Код осадков при нулевой сумме (`weather_code: 63`, `precipitation: 0`): осадки есть, минимум по коду. Тест в задаче 1.
- Пресет без живой погоды (нет сети): облака и осадки пресета всё равно есть. Тест в задаче 2.
- Неизвестное значение девятого поля hash: считается `real`. Тест в задаче 2 (`parsePreset`).
- Камера выше облаков и смена начала координат: осадков и сокращения тумана нет, частицы не прыгают. Тесты в задаче 3 (`precipAltitudeFactor`, `CameraMotion`).

---

### Task 1: Осадки и гроза в данных погоды

**Files:** Modify `src/world/weather.ts`; Test `tests/weather.test.ts`.

**Interfaces — Produces:**
- `export type PrecipKind = 'none' | 'rain' | 'snow'`
- В `Weather`: `precipKind?: PrecipKind; precipMmH?: number; thunder?: boolean; visibilityM?: number`
- `export function precipitationOf(code: number | undefined, precipMm: number, rainMm: number, snowfallCm: number, intervalS: number): { kind: PrecipKind; mmH: number; thunder: boolean }`
- `weatherUrl`: после полей облачности в `current` идут `precipitation,rain,showers,snowfall,weather_code,visibility` (всего 16 + 5×4 полей).

- [ ] Тесты: URL содержит шесть новых полей на местах 10–15 и всего 36; `precipitationOf(61, 0.6, 0.6, 0, 900)` → `{ kind: 'rain', mmH: 2.4, thunder: false }`; `(73, 0.3, 0, 0.21, 900)` → снег 1,2; `(63, 0, 0, 0, 900)` → дождь 2; `(95, 3, 3, 0, 900)` → `thunder: true`, 12; `(undefined, 0, 0, 0, 900)` → `none`, 0; `(3, 0.2, 0, 0.14, 900)` → снег (сумма снега без дождя); `parseWeather(SAMPLE)` без новых полей → `precipKind: 'none'`, `precipMmH: 0`, `thunder: false`.
- [ ] Реализация. Минимумы по коду: слабые (51, 56, 61, 66, 71, 77, 80, 85) 0,5; умеренные (53, 63, 73, 81, 95) 2; сильные (55, 57, 65, 67, 75, 82, 86, 96, 99) 8 мм/ч. Снежные коды: 71, 73, 75, 77, 85, 86. `rainMm` = `rain + showers`. Интервал по умолчанию 900 с.
- [ ] `npx vitest run tests/weather.test.ts` зелёный.

### Task 2: Пресеты погоды

**Files:** Create `src/world/weather-preset.ts`; Test `tests/weather-preset.test.ts`.

**Interfaces — Produces:**
- `export const WEATHER_PRESETS = ['real', 'clear', 'cloudy', 'rain', 'snow', 'storm'] as const; export type WeatherPreset = (typeof WEATHER_PRESETS)[number]`
- `export function parsePreset(raw: string | undefined): WeatherPreset` (неизвестное → `'real'`)
- `export function applyPreset(w: Weather | undefined, preset: WeatherPreset, at: LatLon, nowMs: number): Weather | undefined` — `real` возвращает `w` как есть; остальные всегда возвращают погоду (без `w` от +15 °C, штиль, без уровней).

- [ ] Тесты по таблице спецификации: значения облачности, осадков, грозы; дождь при живых −8 °C даёт +3 °C и точку росы −1 °C; снег при +12 °C даёт −3 °C; гроза при ветре 4 м/с и порывах 6 даёт порывы 16; ветер и давление живые; `visibilityM` у пресетов снят; сдвиг температуры уровней затухает (`l.tempC + Δ × max(0, 1 − i/n)`); `applyPreset(undefined, 'rain', AT, 0)` даёт облачность 100 и дождь 4; `parsePreset('hail')` → `'real'`.
- [ ] Реализация.
- [ ] Тест зелёный.

### Task 3: Модель осадков, видимость, движение камеры, турбулентность

**Files:** Create `src/world/precipitation.ts`; Modify `src/flight/air.ts`, `src/world/weather.ts` (`airConditions`); Test `tests/precipitation.test.ts`, `tests/weather.test.ts`.

**Interfaces — Produces:**
- `export const FOG_CLEAR = { start: 15000, end: 55000 }`
- `export function precipVisibilityM(kind: PrecipKind, mmH: number): number` — дождь `16000 × R^−0.6`, снег `4000 × R^−0.7`, `none` или `R ≤ 0` → `Infinity`.
- `export function fogRange(visibilityM: number | undefined): { start: number; end: number }` — конец `clamp(v × 2.3, 1200, 55000)`, начало `end × 15/55`; `undefined` → `FOG_CLEAR`.
- `export function precipAltitudeFactor(camAlt: number, lowestBase: number | undefined, groundElevation: number): number` — 1 ниже потолка, линейно до 0 за 300 м выше; потолок = `lowestBase ?? groundElevation + 3000`.
- `export function precipParticles(kind: PrecipKind, mmH: number): { count: number; box: number; fall: number; exposure: number }` — дождь: куб 36, падение 9, выдержка 1/40, число `clamp(1400 × R^0.5, 600, 4000)`; снег: куб 24, падение 1.5, выдержка 1/120, число `clamp(1400 × R^0.5, 500, 4000)`; `none` → число 0.
- `export function stormTurbulence(w: { precipKind?: PrecipKind; precipMmH?: number; thunder?: boolean }): number` — 3 в грозу, иначе `min(0.6, R / 20)` для дождя, иначе 0.
- `export function gloom(w): number` — 1 в грозу, иначе `min(0.6, R / 10)`; свет палитры множится на `1 − 0.3 × gloom`.
- `export class CameraMotion { readonly vel: vec3; update(pos: ArrayLike<number>, dt: number): void }` — скорость из разницы положений; шаг больше 600 м/с × dt + 50 м считается сменой начала координат и скорость остаётся прежней; `dt ≤ 0` ничего не меняет.
- `AirConditions.turbulence?: number` (м/с, прибавляется к `sigma`); `airConditions` заполняет его из `stormTurbulence`.

- [ ] Тесты: `fogRange(24000)` → 15000/55000; `fogRange(2000)` → конец 4600; `fogRange(100)` → конец 1200; `precipVisibilityM('rain', 4)` ≈ 6964; снег 1,5 ≈ 3011; высотный фактор 1 / 0,5 / 0 при базе 1000 и высотах 900 / 1150 / 1400, без базы потолок `ground + 3000`; `CameraMotion`: шаг 10 м за 0,1 с → 100 м/с, затем скачок на 5000 м не меняет скорость; число частиц монотонно растёт и ограничено; `airConditions` грозы даёт `turbulence: 3`, и `Air` с ним при штиле не `calm` по турбулентности (`sample` даёт ненулевой ветер после шагов).
- [ ] Реализация.
- [ ] Тесты зелёные, `tests/physics.test.ts` и `tests/autopilot.test.ts` не сломаны.

### Task 4: Планировщик молний

**Files:** Create `src/world/lightning.ts`; Test `tests/lightning.test.ts`.

**Interfaces — Produces:**
- `export interface Strike { t0: number; bearingDeg: number; distanceM: number; pulses: number[]; seed: number }` (`pulses` — смещения вспышек от `t0`, с)
- `export class Lightning { constructor(seed?: number); update(tSec: number, active: boolean): Strike | undefined; flash(tSec: number): number; readonly last: Strike | undefined }` — `update` возвращает новый разряд в тот кадр, когда он случился; интервалы экспоненциальные со средним 12 с, не короче 2 с; расстояние 2000–15000 м; 2–4 вспышки в пределах 0,4 с; `flash` 0..1, каждая вспышка гаснет за 0,09 с, яркость падает с расстоянием (`1` на 2 км, `0.35` на 15 км); при `active = false` новых разрядов нет.
- `export function boltPath(seed: number, segments?: number): [number, number][]` — ломаная от (0, 1) до (x, 0) в долях высоты, детерминированная.

- [ ] Тесты: за 600 с активной грозы 30–80 разрядов; все расстояния и числа вспышек в границах; одинаковый seed даёт одинаковую последовательность; `flash` равен 0 до первого разряда и через 1 с после него, больше 0 в момент вспышки; неактивная гроза за 600 с даёт 0 разрядов; `boltPath` начинается в y = 1, кончается в y = 0, y не возрастает.
- [ ] Реализация.
- [ ] Тест зелёный.

### Task 5: Отрисовка частиц и гром

**Files:** Modify `src/engine/shaders.ts`, `src/engine/renderer.ts`, `src/flight/audio.ts`.

**Interfaces — Produces:**
- `Renderer.drawPrecip(view: mat4, proj: mat4, p: { count: number; box: number; offset: ArrayLike<number>; streak: ArrayLike<number>; widthPx: number; rgb: ArrayLike<number> }): void` — инстансный прямоугольник на частицу; положение относительно камеры `mod(seed × box + offset, box) − box/2`; хвост `− streak`; на экране ширина `widthPx`, длина не меньше ширины; тест глубины включён, запись выключена; частицы ближе 0,3 м к камере отбрасываются. Вызывается после самолёта, до `drawVeil`.
- `FlightAudio.thunder(distanceM: number): void` — раскат через `distanceM / 340` с: низкочастотный шум 2–4 с, громкость `clamp(1.2 − distanceM / 15000, 0.15, 1)`; без разблокированного звука ничего не делает.

- [ ] Реализация по образцу `POINTS_VS`/`POINTS_FS` (та же `depthed`, `ORTHO_VS`, логарифмическая глубина) и `burst` в `audio.ts`.
- [ ] `npm run typecheck` чистый. Вид проверяется в задаче 7.

### Task 6: HUD, строки, меню, hash

**Files:** Modify `src/flight/hud.ts`, `src/ui/i18n.ts`, `src/ui/menu.ts`; Test `tests/weather.test.ts`.

**Interfaces — Produces:**
- `weatherLines` добавляет четвёртую строку при осадках или грозе: `ДОЖДЬ 2.4 ММ/Ч`, `СНЕГ 1.5 ММ/Ч`, `ГРОЗА 12 ММ/Ч`; en `RAIN 2.4 MM/H`, `SNOW`, `TSTM`; имперские `IN/H` с двумя знаками. Интенсивность от 10 без дробной части.
- `FlightConfig.weather: WeatherPreset` (по умолчанию `'real'`); ключи i18n `weather`, `wxReal`, `wxClear`, `wxCloudy`, `wxRain`, `wxSnow`, `wxStorm` на трёх языках; ряд «Погода» на стартовом экране.

- [ ] Тесты строк HUD: дождь 2,4 метрика ru; гроза 12 en; снег 1,5 имперские (`SNOW 0.06 IN/H`); без осадков три строки.
- [ ] Реализация.
- [ ] Тест и `npm run typecheck` зелёные.

### Task 7: Связка в `main.ts`, ТЗ, проверка в приложении

**Files:** Modify `src/main.ts`, `docs/TZ.md`.

**Interfaces — Consumes:** всё из задач 1–6.

- [ ] `Start.weather: WeatherPreset` из `parts[8]` через `parsePreset`; `onFly` пишет девятое поле (`real` → пусто).
- [ ] Погода в силе: `applyPreset(weather.current, preset, …)`, затем URL-подмены. В меню пресет берётся из `menu.config.weather`, иначе из `start.weather`. `cloudInput`, `weatherInForce`, солнечность, температура на HUD идут через неё.
- [ ] Туман: `FOG_START_M`/`FOG_END_M` заменяются на сглаженные значения (постоянная времени 2 с) из `fogRange(min(visibilityM, precipVisibilityM))`, взвешенные высотным фактором к `FOG_CLEAR`.
- [ ] Частицы: `CameraMotion` по `camPos`, смещение копится как `(падение + ветер − скорость камеры) × dt`, цвет через `shadeColour`.
- [ ] Гроза: `Lightning.update` по реальному времени кадра; вспышка осветляет палитру кадра; разряд ломаной в оверлее, пока камера ниже облаков; `audio.thunder`.
- [ ] `gloom` уменьшает `lightMul` палитры.
- [ ] `docs/TZ.md`: решение Q48 в разделе погоды и строка в таблице решений.
- [ ] `npx vitest run`, `npm run typecheck`, `git diff --check`.
- [ ] В браузере: пресеты Дождь, Снег, Гроза и Ясно с ряда меню; снимки экрана; в консоли нет ошибок.
