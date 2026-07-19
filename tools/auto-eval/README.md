# Auto Live Evaluator

Пуска въпроси към `/api/chat` и оценява отговорите автоматично:
- маршрути: има ли реална дестинация близо до очакваната
- POI: strict проверка за реални обекти в Google Places (изисква `place_id`, филтрира шумен текст и проверява радиус около `areaHint`)

## 1) Подготви env
- `EVAL_API_BASE_URL` (пример: `http://localhost:3000`)
- `DASHBOARD_API_KEY` (ако API guard изисква ключ)
- `EVAL_AUTH_CODE` (код за резервация или host код; препоръчително за реални route/POI тестове)
- `EVAL_CHAT_TOKEN` (опционално, ако имаш валиден login token)
- `GOOGLE_PLACES_API_KEY` (или `GOOGLE_DIRECTIONS_API_KEY`)
- `EVAL_FETCH_RETRIES` (опц.; default `2`) брой retries при временни HTTP/мрежови грешки
- `EVAL_CASE_ATTEMPTS` (опц.; default `2`) брой опити за всеки case (намалява флейки откази)

## 2) Пусни
```bash
npm run eval:live
```

Пример (PowerShell, production):
```powershell
$env:EVAL_API_BASE_URL="https://smart-stay.onrender.com"
$env:EVAL_AUTH_CODE="YOUR_ACTIVE_CODE"
$env:GOOGLE_PLACES_API_KEY="YOUR_GOOGLE_KEY"
npm run eval:live
```

## 3) Резултат
- Конзолен PASS/FAIL по тест
- JSON отчет: `tools/auto-eval/result.json`
- Ако няма `EVAL_AUTH_CODE`/`EVAL_CHAT_TOKEN`, protected case-овете се маркират като `SKIP (auth_required)` вместо `FAIL`.

## 4) Тестове
Редактирай `tools/auto-eval/cases.json` и добавяй колкото искаш случаи (30+).

За POI strict контрол:
- `strict`: `true` (по подразбиране)
- `maxRadiusKm`: максимален радиус от `areaHint`
- `minCandidates`: минимум чисти извлечени имена
- `minVerified`: минимум Google-потвърдени обекти
