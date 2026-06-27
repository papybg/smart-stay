# Smart Stay

Цялостна платформа за управление на краткосрочни наеми с:
- AI чат асистент за гост/домакин
- управление на електромер (SmartThings + Tasker feedback)
- booking lifecycle (inquiry -> approve -> paid -> cancel)
- PIN логика и админ инструменти
- нотификации (Telegram/Email)

Този README е синхронизиран с текущия код в проекта.

---

## 1) Обща архитектура

### Backend
- Стек: Node.js + Express
- Входна точка: `server.js`
- DB: PostgreSQL (Neon) чрез `@neondatabase/serverless`
- Основен AI модул: `services/ai_service.js`

### Frontend
- Статични страници в `public/`
- Основен чат интерфейс: `public/agent.html`
- Резервационна страница: `public/reservation.html`
- Админ dashboard: `public/dashboard.html`
- Demo dashboard: `public/dashboard-demo.html`

### Интеграции
- SmartThings OAuth + commands + fallback логика: `services/autoremote.js`
- Tasker status feedback: `POST /api/power-status`
- Gmail sync за резервации: `services/detective.js` + route hooks
- Notifications: `services/notifications/*`

---

## 2) Домейни и routing

### Vercel host rewrites (`vercel.json`)
- `demo.bgm-design.com` -> `/dashboard-demo.html`
- `admin.bgm-design.com` -> `/dashboard.html`
- `reservation.bgm-design.com` -> `/reservation.html`
- `www.reservation.bgm-design.com` -> `/reservation.html`
- `stay.bgm-design.com` -> `/agent.html`

### Express host mapping (`server.js`)
- Host-based root routing с runtime injection (`__SMART_STAY_API_URL`, `__SMART_STAY_PUBLIC_HOST`)
- `/agent.html` се сервира директно от `public/agent.html`
- `/` fallback също връща `agent.html`

### Health
- `GET /health` -> operational JSON

---

## 3) Проектна структура (основни елементи)

```text
smart-stay/
  server.js
  vercel.json
  package.json
  routes/
    authRoutes.js
    powerRoutes.js
    bookingsRoutes.js
    adminRoutes.js
    systemRoutes.js
  services/
    ai_service.js
    autoremote.js
    detective.js
    sessionManager.js
    ai/
      auth.js
      intents.js
      instructions.js
      gemini.js
      groq.js
      brave.js
      config.js
    notifications/
      index.js
      formatters.js
      channels/
        email.js
        telegram.js
  middlewares/
    security.js
  public/
    agent.html
    reservation.html
    dashboard.html
    dashboard-demo.html
    test-page.html
```

---

## 4) Core модули и роли

### `server.js`
- Инициализира Express, CORS, rate-limit, API guards
- Инициализира DB schema (таблици/индекси)
- Регистрира всички route модули
- Управлява host routing и статични страници
- Има graceful shutdown и опционален локален scheduler

### `services/ai_service.js`
- Главен orchestration слой за AI
- Роля и достъп (guest/host/stranger) чрез `determineUserRole`
- Чете public/private manual според роля
- Обработва команди за ток и power status заявки
- Интегрира live lookup (Places/Directions/Brave) според policy

### `services/ai/auth.js`
- Верификация на host (код/token/history)
- Верификация на guest по HM reservation code
- Защита за активна/валидна резервация
- Name fallback е ограничен до не-cancelled и не-изтекли записи,
  с приоритет активна резервация, иначе първа предстояща

### `services/autoremote.js`
- SmartThings OAuth refresh lifecycle
- Команди ON/OFF към device
- Fallback потоци и trace логове

### `routes/powerRoutes.js`
- Meter command endpoints
- Tasker feedback приемане и dedup/noise window
- Read endpoints за статус/история/trace

### `routes/bookingsRoutes.js`
- Bookings listing/sync
- Reservation power scheduler (power_on_time/power_off_time прозорци)
- Scheduler status endpoint за наблюдение без логове
- Inquiry + pricing quote
- Requests lifecycle (approve/mark-paid/cancel/delete)
- Gmail sync hooks

### `services/notifications/index.js`
- Queue + retry + exponential backoff
- Telegram/Email channels
- Dedup по event key
- Логване в `notification_log`

### `middlewares/security.js`
- API key guard
- Simple in-memory rate limiter

### `services/sessionManager.js`
- In-memory session tokens
- Validate/invalidate lifecycle

---

## 5) API карта (актуална)

### Auth / Chat
- `POST /api/login`
- `POST /api/logout`
- `POST /api/chat`
- `GET /callback` (SmartThings OAuth callback)

### Power / Meter
- `POST /api/meter`
- `POST /api/meter/on`
- `POST /api/meter/off`
- `POST /api/power-status`
- `POST /api/power/status`
- `GET /api/power-status`
- `GET /api/power-history`
- `GET /api/power/trace-help`

### Bookings / Requests / Pricing
- `GET /api/bookings`
- `GET /bookings`
- `GET /api/bookings/unavailable-ranges`
- `POST /api/pricing/quote`
- `POST /add-booking`
- `DELETE /bookings/:id`
- `POST /api/reservations/sync`
- `GET /api/reservations/sync-status`
- `POST /api/gmail/sync`
- `POST /api/email/sync`
- `POST /api/inquiry`
- `GET /api/requests`
- `POST /api/requests/:id/approve`
- `POST /api/requests/:id/mark-paid`
- `POST /api/requests/:id/cancel`
- `DELETE /api/requests/:id`
- `DELETE /api/test-data`

### Admin / System
- `GET /api/pins`
- `POST /api/pins`
- `DELETE /api/pins/:id`
- `GET /calendar.ics`
- `GET /status`

### Service endpoints
- `GET /health`
- `POST /api/alert`
- `POST /smartthings`

---

## 6) Данни и таблици

`initializeDatabase()` в `server.js` управлява bootstrap/alter за:
- `power_history`
- `bookings` (добавени operational колони като `power_status`, `pin_assigned_at`, `total_price`)
- `pin_depot`
- `Requests`
- `notification_log`
- `Pricing`

Целта е deploy-safe стартиране без отделен миграционен процес.

---

## 7) Сигурност и operational guards

- Global `generalLimiter` за `/api`
- Специализиран limiter за meter/email/chat
- `dashboardKeyGuard` за защитени `/api` маршрути
- `meterCommandGuard` за `/api/meter*`
- Optional Tasker key guard (`TASKER_STATUS_API_KEY`) за feedback routes
- CORS allowlist + suffix стратегия за `*.bgm-design.com`

---

## 8) Текущо поведение на чата

- Единен интерфейс: `agent.html` (mobile-first, desktop-polished)
- Ролева логика:
  - `stranger` -> public information only
  - `guest` -> scoped booking-aware behavior
  - `host` -> admin-capable behavior
- Render root (`/`) и stay domain root водят към chat интерфейса

---

## 9) Деплой и проверка

### След deploy проверявай:
- `https://smart-stay.onrender.com/` -> трябва да отваря chat UI
- `https://smart-stay.onrender.com/health` -> JSON operational
- `https://stay.bgm-design.com/` -> chat UI (agent)
- `https://reservation.bgm-design.com/` -> reservation page
- `https://admin.bgm-design.com/` -> dashboard
- `https://demo.bgm-design.com/` -> demo dashboard

### Scheduler проверка без логове
- `GET /api/reservations/sync-status` -> връща последен run/success/error, следващ run и последен резултат
- Полезни полета в отговора:
  - `scheduler.lastRunAt`
  - `scheduler.lastSuccessAt`
  - `scheduler.nextRunAt`
  - `scheduler.lastTrigger` (`local_initial`, `local_interval`, `api_manual`)
  - `scheduler.lastResult.powerOnWindowCount`
  - `scheduler.lastResult.powerOnActions`
  - `scheduler.lastError`
- Endpoint-ът е зад същите API guards като останалите `/api` маршрути.

---

## 10) Бележка: незадължителни следващи подобрения

Системата в момента е функционално стабилна и повечето критични проблеми са изчистени.
Оставащите стъпки са по-скоро quality/scale подобрения, не блокери:

- Tool registry extraction (MVP) за по-строг control layer на AI действията
- Cron persistence (`cron_jobs`, `cron_runs`) и reminder automation
- Testing + CI (unit/integration + pipeline)
- Monitoring/alerting разширения
- Документация и диаграми за екипно onboarding ниво

Тези подобрения са препоръчителни, но не задължителни за текуща работеща експлоатация.

---

## 11) Настройки за lock code достъп

Системата има отделен прозорец за показване/изпращане на временния lock code към госта.

- `LOCK_CODE_ACCESS_START_BEFORE_CHECKIN_HOURS` (default: `12`)
- `LOCK_CODE_ACCESS_END_AFTER_CHECKOUT_HOURS` (default: `3`)

Пример: ако check-in е `14:00`, а check-out е `12:00`, default прозорецът за lock code ще е:
- от `02:00` в деня на check-in
- до `15:00` в деня на check-out

Забележка: това е отделно от общия `ACCESS_*` прозорец и позволява по-гъвкава политика за конфиденциална информация.

---

## 12) Всички тайм лимити в системата

### Достъп и сесии
- `SESSION_DURATION` = `30 мин` (login token)
- `ACCESS_START_BEFORE_CHECKIN_HOURS` = `2` (общ guest access)
- `ACCESS_END_AFTER_CHECKOUT_HOURS` = `1` (общ guest access)
- `LOCK_CODE_ACCESS_START_BEFORE_CHECKIN_HOURS` = `12` (lock code access)
- `LOCK_CODE_ACCESS_END_AFTER_CHECKOUT_HOURS` = `3` (lock code access)

### API rate limits
- Global `/api`: `100 заявки / 15 мин`
- Power `/api/meter*`: `10 заявки / 1 мин`
- Email sync `/api/gmail/sync`, `/api/email/sync`: `5 заявки / 1 час`
- `/api/chat` (simple limiter): `25 заявки / 60 сек`
- `/api/meter*` (simple limiter): `20 заявки / 60 сек`
- `/api/power-status`, `/api/power/status`, `/api/ha-webhook` (simple limiter): `60 заявки / 60 сек`

### Tasker/Power anti-noise
- `TASKER_NOISE_WINDOW_MS` = `45000 ms` (45 сек)
- `REQUEST_LOG_SUPPRESS_MS` = `30000 ms` (30 сек)
- `TASKER_CONFIRM_TIMEOUT_MS` = `20000 ms` (20 сек)
- `TASKER_CONFIRM_POLL_MS` = `1000 ms` (1 сек)

### AI и външни интеграции
- `GEMINI_MODEL_TIMEOUT_MS` = `12000 ms`
- `GEMINI_MODEL_COOLDOWN_MS` = `60000 ms`
- `GROQ_TIMEOUT_MS` = `8000 ms`
- `BACKUP_TIMEOUT_MS` = `15000 ms`
- `GOOGLE_PLACES_TIMEOUT_MS` = `5000 ms`
- `GOOGLE_PLACES_BLOCK_COOLDOWN_MS` = `3600000 ms` (1 час)
- `GOOGLE_DIRECTIONS_TIMEOUT_MS` = `6000 ms`
- `BRAVE_SEARCH_TIMEOUT_MS` = `6000 ms`
- `BRAVE_SEARCH_MONTHLY_QUOTA` = `1000 / месец`

### Retry / Scheduler
- Notifications retry: `MAX_ATTEMPTS=3`, `BASE_RETRY_DELAY_MS=600` (експоненциален backoff)
- Detective DB retry: `3 опита`, `delay 10000 ms`
- Local detective scheduler: `на всеки 2 часа`
- Local reservations scheduler (когато `USE_LOCAL_CRON=true`): `на всеки 10 мин` + initial run при старт
- Reservation power-on lookback: `SCHEDULER_POWER_ON_LOOKBACK_MINUTES` (default: `360`, min: `10`, max: `1440`)

---

## 13) Препоръчан работен профил (балансиран за продукция)

Този профил пази сигурността, но е по-удобен за реални гости и намалява фалшивите откази.

### Препоръчани ENV стойности
- `LOCK_CODE_ACCESS_START_BEFORE_CHECKIN_HOURS=18`
- `LOCK_CODE_ACCESS_END_AFTER_CHECKOUT_HOURS=6`
- `ACCESS_START_BEFORE_CHECKIN_HOURS=4`
- `ACCESS_END_AFTER_CHECKOUT_HOURS=2`
- `TASKER_NOISE_WINDOW_MS=30000`
- `REQUEST_LOG_SUPPRESS_MS=15000`
- `TASKER_CONFIRM_TIMEOUT_MS=25000`
- `GEMINI_MODEL_TIMEOUT_MS=15000`
- `GROQ_TIMEOUT_MS=10000`
- `BACKUP_TIMEOUT_MS=20000`

### Оперативни бележки
- Ако имате повече трафик, увеличете постепенно лимитите за `/api/chat` и global `/api`.
- Ако често има бавни отговори от външни API, увеличете timeout-ите с `20-30%`.
- Ако искате по-строг режим, върнете `LOCK_CODE_ACCESS_*` към `12/3` или по-ниско.
