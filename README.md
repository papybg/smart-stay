# 🏠 Smart Stay - AI Property Management System

**Интелигентна система за автоматизация на ваканционни имоти с директен Samsung SmartThings контрол и AI асистент**

> ⚠️ **CURRENT HANDOFF STATE (Feb 2026)**
> - Командите за ток са **директно**: AI/Dashboard → Render → SmartThings → Tuya
> - Tasker е **само feedback** към `POST /api/power-status`
> - `power_history` е event log (пише Tasker feedback)
> - Detective синхронизира `bookings.power_status` от latest `power_history` (event-driven)
> - За `stranger` роля AI ползва само `manual-public` (без Places/Directions/Brave)

---

## 📋 Съдържание
1. [Как работи](#-как-работи)
2. [Технологичен стек](#-технологичен-стек)
3. [Архитектура](#-архитектура)
4. [Структура на проекта](#-структура-на-проекта)
5. [Database Schema](#-database-schema)
6. [API Endpoints](#-api-endpoints)
7. [🔐 SESSION TOKEN Authentication](#-session-token-authentication)
8. [Features & Status](#-features--status)
9. [Конфигурация](#-конфигурация)
10. [Развиване & Deployment](#-развиване--deployment)

---

## 🚀 Как работи?

### Основен поток (актуален)

```
1. GMAIL SYNC (Render Cron / on-demand)
   ├─ detective.js сканира Gmail за Airbnb потвърждения
   ├─ Gemini AI извлича: име, дата check-in/out, резервационен код
   └─ Данни се записват в Neon DB (bookings таблица)

2. POWER COMMAND (AI / Dashboard / API)
  ├─ Render endpoint (`/api/meter`, `/api/meter/on`, `/api/meter/off`)
  ├─ Директно към Samsung SmartThings API
  └─ SmartThings управлява Tuya/SmartLife интегрирания електромер

3. FEEDBACK LOOP (Tasker → Backend, only on change)
  ├─ Tasker праща `POST /api/power/status` само при реална промяна
  ├─ Backend записва в `power_history`
  ├─ Detective sync обновява `bookings.power_status`
  └─ Dashboard/AI четат текущ статус от `bookings`

4. GUEST SUPPORT (AI Assistant)
   ├─ Гостите пишат чат съобщения (index.html)
  ├─ AI използва bookings-first логика за резервации и power status
  ├─ Host справките са детерминистични (read-only към базата)
  └─ Stranger: само `manual-public` (без live външни lookup-и)
```

---

## 🛠 Технологичен стек

| Компонент | Технология | Версия |
|-----------|-----------|--------|
| **Backend** | Node.js + Express | ^4.21.2 |
| **Database** | PostgreSQL (Neon Cloud) | Serverless |
| **AI** | Google Gemini (allowlist 2.0/2.5/3) | Current |
| **Scheduling** | Render Cron Jobs | Managed |
| **HTTP Client** | axios | ^1.13.4 |
| **Email** | Gmail API + OAuth2 | googleapis ^144.0.0 |
| **Device Control** | Samsung SmartThings API | Cloud |
| **Feedback** | Tasker (state callback only) | Android |
| **IoT Device** | Tuya Smart Switch | 220V |

### 🤖 AI модели (фиксиран allowlist)

Това са **единствените одобрени модели** за `services/ai_service.js`.
Ако липсва достъп/квота за конкретен модел, системата автоматично минава към следващия по ред.

1. `gemini-2.5-flash-lite`
2. `gemini-2.5-flash`
3. `gemini-2.5-pro`
4. `gemini-3-flash-preview`
5. `gemini-3-pro-preview`

Правила:
- Не добавяй `TTS`/`Image` варианти в чат fallback списъка.
- Не използвай невалидни alias имена (напр. `gemini-flash-latest`) без проверка за достъп.
- Промяна в реда/списъка се прави само съзнателно и се документира в този README.

### Hosting Platforms
- **Render.com** - Main Backend API
- **Vercel** - Optional Frontend (static files)

---

## 🏗 Архитектура

```
AI / Dashboard / API
  │
  ▼
server.js (Express)
  │
  ▼
services/autoremote.js
  │
  ▼
Samsung SmartThings API
  │
  ▼
Tuya/SmartLife integrated device (meter)

Tasker (feedback only) ──► POST /api/power-status
          │
          ▼
      power_history
          │
          ▼
      Detective sync -> bookings.power_status
```

### Данни flow
```
Gmail (Airbnb) → detective.js → Gemini AI → DB (bookings)
AI queries → bookings (read-only for reports/status)
Power command → server.js → autoremote.js → SmartThings → device ON/OFF
Tasker feedback (only on state change) → POST /api/power/status → power_history
power_history (latest) → detective sync → bookings.power_status
Dashboard / AI reports → read from bookings (+ power_history for audit/history)
```

---

## 📂 Структура на проекта

```
smart-stay/
├── server.js                    # Express API мост + power/status endpoints
├── package.json                 # Dependencies
├── .env                         # Environment variables (local)
│
├── services/
│   ├── ai_service.js           # Gemini AI + Manual базирана система
│   ├── detective.js            # Gmail sync + Airbnb detection
│   ├── autoremote.js           # SmartThings direct control (Tasker legacy commented)
│   ├── manual-private.txt      # Property info (за гостите)
│   └── manual-public.txt       # General knowledge (за всички)
│
├── public/
│   ├── index.html              # Guest chat interface (Ико асистент)
│   ├── dashboard.html          # Admin panel + Power history
│   ├── remote.html             # Manual power control interface
│   ├── aaadmin.html            # Legacy admin panel
│   └── dddesign.html           # UI design reference
│
├── README.md                    # Main documentation (current state)
└── [cache files]

```

### Ключови файлове

#### `server.js`
- Express API мост
- Глобално управление на ток статус
- Meter endpoints + Tasker feedback endpoint
- Endpoints за API

#### `services/ai_service.js` (1000+ lines) - **НЕЗАВИСИМ МОДУЛ**
- ⚡ **ВАЖНО:** AI логиката е напълно отделена от сървъра!
- Gemini Flash AI интеграция
- Intelligent mode: различни отговори за property vs general knowledge
- Medical emergency detection (болест, травма, пожар, насилие)
- Manual-based single source of truth (SSoT)
- Character management (Ико персонаж)
- Работи асинхронно (await getAIResponse) - не блокира сървъра

#### `services/detective.js`
- Gmail API интеграция
- Airbnb detection (парсира потвърждения)
- автоматично добавяне в базата

#### `services/autoremote.js`
- HTTP запитване към Samsung SmartThings API
- Поддържа single-device или split ON/OFF scene device IDs
- Legacy Tasker command flow е оставен само като коментар

---

## 🗄 Database Schema

### Таблица: `bookings`
```sql
CREATE TABLE bookings (
    id SERIAL PRIMARY KEY,
    reservation_code VARCHAR(50) UNIQUE NOT NULL,  -- HMA1234567
    guest_name VARCHAR(100) NOT NULL,              -- "John Doe"
    check_in TIMESTAMP WITH TIME ZONE NOT NULL,    -- 2026-02-20 19:30:00
    check_out TIMESTAMP WITH TIME ZONE NOT NULL,   -- 2026-02-22 14:00:00
    lock_pin VARCHAR(20),                          -- "9590" за брава
    payment_status VARCHAR(20) DEFAULT 'pending',  -- paid/pending
    power_on_time TIMESTAMP,                       -- 2 часа преди check-in
    power_off_time TIMESTAMP,                      -- 1 час след check-out
    power_status VARCHAR(10) DEFAULT 'unknown',    -- on/off/unknown
    power_status_updated_at TIMESTAMPTZ,
    source VARCHAR(20) DEFAULT 'airbnb',           -- airbnb/manual
    created_at TIMESTAMP DEFAULT NOW()
);
```

  ### Таблица: `power_history`
```sql
CREATE TABLE power_history (
    id SERIAL PRIMARY KEY,
    is_on BOOLEAN NOT NULL,                        -- true=ВКЛ, false=ИЗКЛ
    source VARCHAR(50),                            -- tasker/scheduler/guest/host/api
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    battery INT,
    booking_id TEXT                                -- actor label (tasker/host/guest/...)
);

CREATE INDEX idx_power_history_timestamp ON power_history(timestamp DESC);
```

  ### Таблица: `pin_depot` (управление на брава кодове)
```sql
  CREATE TABLE pin_depot (
    id SERIAL PRIMARY KEY,
    pin_code VARCHAR(20) UNIQUE NOT NULL,          -- "123456"
    is_used BOOLEAN DEFAULT FALSE,                 -- дали е използван
    assigned_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Таблица: `guests_chats` (opcional - при реализация на persistent chat)
```sql
CREATE TABLE guest_chats (
    id SERIAL PRIMARY KEY,
    guest_id INT REFERENCES bookings(id),
    message TEXT,
    sender VARCHAR(20),  -- 'guest' или 'ai'
    timestamp TIMESTAMP DEFAULT NOW()
);
```

---

## 🔌 API Endpoints

### 🔵 Chat & AI Assistant

#### `POST /api/chat`
Комуникация с Ико асистент
```bash
curl -X POST http://localhost:10000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Как включвам климатика?",
    "history": []
  }'

Response:
{
  "response": "..."
}
```

### 🟢 Power Control

#### `POST /api/power/status` (Tasker feedback)
Получава обратна връзка от Tasker за текущо състояние
```bash
curl -X POST http://localhost:10000/api/power/status \
  -H "Content-Type: application/json" \
  -d '{"is_on": true, "booking_id": 5, "source": "tasker_direct"}'

Response: 200 OK
```

**Tasker feedback (само при промяна):**
- Trigger: реална промяна на state
- Action: `POST /api/power/status`
- Body пример: `{"is_on": true, "source": "tasker_direct", "booking_id": "tasker_direct"}`
- Без периодичен ping

#### `GET /api/power-status`
Проверка на текущо състояние на тока
```bash
curl http://localhost:10000/api/power-status

Response:
{
  "online": true,
  "isOn": true,
  "lastUpdate": "2026-02-10T15:45:30.000Z",
  "source": "tasker_direct"
}
```

#### `GET /api/power-history`
История на всички включвания/изключвания
```bash
# Последния месец
curl http://localhost:10000/api/power-history?days=30

# Последния ден
curl http://localhost:10000/api/power-history?days=1

Response:
{
  "count": 12,
  "data": [
    {
      "id": 45,
      "is_on": false,
      "source": "cron",
      "timestamp": "2026-02-10T14:00:00Z",
      "battery": 80,
      "booking_id": "tasker_direct"
    },
    ...
  ],
  "period": {
    "since": "2026-01-10T...",
    "until": "2026-02-10T..."
  }
}
```

### 🟡 Bookings Management

#### `GET /api/bookings`
Резервации (API формат)
```bash
curl http://localhost:10000/api/bookings
```

#### `GET /bookings`
Legacy резервации (за dashboard/aaadmin)
```bash
curl http://localhost:10000/bookings

Response:
[
  {
    "id": 33,
    "reservation_code": "HM2026JAN29",
    "guest_name": "John Doe",
    "check_in": "2026-01-30T19:30:00Z",
    "check_out": "2026-01-31T14:00:00Z",
    "lock_pin": "9590",
    "payment_status": "paid",
    "source": "airbnb"
  },
  ...
]
```

#### `POST /add-booking` (Manual добавяне)
```bash
curl -X POST http://localhost:10000/add-booking \
  -H "Content-Type: application/json" \
  -d '{
    "guest_name": "Jane Smith",
    "check_in": "2026-02-15T10:00:00Z",
    "check_out": "2026-02-17T11:00:00Z",
    "reservation_code": "HM999999"
  }'
```

#### `DELETE /bookings/:id`
Изтриване на резервация
```bash
curl -X DELETE http://localhost:10000/bookings/33
```

#### `GET /sync`
Ръчен Detective sync от Gmail
```bash
curl http://localhost:10000/sync
```

### 🔑 PIN/Lock Codes (pin_depot)

#### `GET /api/pins`
Всички PIN кодове за брава
```bash
curl http://localhost:10000/api/pins

Response:
[
  {
    "id": 1,
    "pin_code": "9590",
    "pin_name": "User 5",
    "is_used": true,
    "created_at": "2026-02-01T..."
  },
  ...
]
```

#### `POST /api/pins`
Добавяне на нов PIN код
```bash
curl -X POST http://localhost:10000/api/pins \
  -H "Content-Type: application/json" \
  -d '{
    "pin_name": "Guest Room",
    "pin_code": "123456"
  }'
```

#### `DELETE /api/pins/{id}`
Изтриване на PIN код
```bash
curl -X DELETE http://localhost:10000/api/pins/1
```

### 📅 Calendar

#### `GET /calendar.ics`
iCal формат за Airbnb синхронизация
```bash
curl http://localhost:10000/calendar.ics
```

### 📡 Misc

#### `GET /status` (Health check)
```bash
curl http://localhost:10000/status

Response:
{
  "online": true,
  "isOn": true,
  "lastUpdate": "2026-02-10T...",
  "source": "tasker"
}
```

---

## 🔐 SESSION TOKEN Authentication

**Status:** ✅ Fully Implemented (Feb 10, 2026)

### Overview
The system now uses **SESSION TOKEN** authentication for improved security and user experience. Users log in once and maintain access for **30 minutes** without re-entering passwords.

### Authentication Flow

#### 1️⃣ Login
```bash
POST /api/login
Content-Type: application/json

{
  "password": "YOUR_HOST_CODE"
}

Response (200):
{
  "success": true,
  "token": "a3f8b2c1e9d4f7a6b3e2d8c1f4a7b2e9d3c6f1a4e7b0d2c5f8a1b3d6e9f2a",
  "expiresIn": 1800,
  "role": "host",
  "message": "Разбрах! Влезте успешно."
}
```

#### 2️⃣ Send Message (with Token)
```bash
POST /api/chat
Content-Type: application/json

{
  "message": "спри тока",
  "history": [],
  "token": "a3f8b2c1..."  ← TOKEN (not password!)
}

Response:
{
  "response": "Токът е прекъснат..."
}
```

#### 3️⃣ Logout
```bash
POST /api/logout
Content-Type: application/json

{
  "token": "a3f8b2c1..."
}

Response:
{
  "success": true
}
```

### Key Features

| Feature | Description |
|---------|-------------|
| **Token Duration** | 30 minutes per session |
| **Token Format** | 64-character hexadecimal (cryptographically random) |
| **Storage** | Browser localStorage + Server-side Map |
| **Expiration** | Automatic (background cleanup every 5 min) |
| **Logout** | Immediate token invalidation |
| **Backward Compat** | Old password auth still works |

### Browser Storage (localStorage)

```javascript
// After successful login:
localStorage['smart-stay-token'] = "a3f8b2c1..."  // 64-char hex
localStorage['smart-stay-expiry'] = 1708790500000  // Unix timestamp
```

### Session Timeline Example

```
10:00:00 - User opens app → LOGIN MODAL
10:00:15 - User enters password → Token generated
10:00:30 - User: "спри тока" → Message sent with TOKEN
10:05:00 - User: "Как е WiFi?" → Still same TOKEN (valid)
10:15:00 - User: "Още един тест" → Still same TOKEN (valid)
10:30:00 - TOKEN EXPIRES (30 min elapsed)
10:30:30 - User tries to send message → LOGIN MODAL appears again
```

### User Experience

| Action | Before | After |
|--------|--------|-------|
| **First visit** | Chat visible | Login modal appears |
| **Password** | Sent with each message | Sent once at login |
| **Each message** | Requires auth check | Uses cached token |
| **Page refresh** | Works (stateless) | Session persists |
| **Logout** | No option | One-click logout |
| **30 minutes** | Never happens | Auto re-login prompt |

### Security Improvements

✅ **Password Protection**
- Password sent ONLY at login (1 time)
- NOT sent with every message
- Cannot appear in chat history

✅ **Token Security**
- Cryptographically random (64 hex chars)
- Expires after 30 minutes
- Server validates on every request
- Immediate invalidation on logout

✅ **Automatic Cleanup**
- Expired tokens removed every 5 minutes
- Prevents memory leaks
- Prevents token reuse after expiry

### Documentation

Complete documentation available:
- **SESSION_TOKEN_GUIDE.md** - Full technical documentation
- **SESSION_TOKEN_TEST_GUIDE.md** - Testing & debugging procedures
- **SESSION_TOKEN_QUICK_REFERENCE.md** - Quick API reference
- **DEPLOYMENT_SUMMARY.md** - Deployment procedures
- **SYSTEM_ARCHITECTURE.md** - System diagrams & flows

---

## ✨ Features & Status

| Feature | Status | Notes |
|---------|--------|-------|
| ✅ Gmail автоматична синхронизация | DONE | Всеки 15 минути |
| ✅ AI Assistant (Gemini) | DONE | Intelligent mode със SSoT |
| ✅ Автоматичен check-in контрол | DONE | 2 часа преди |
| ✅ Автоматичен check-out контрол | DONE | 1 час след |
| ✅ SmartThings direct control | DONE | Render → SmartThings → Device |
| ✅ Tasker feedback only | DONE | `POST /api/power-status` on change |
| ✅ Power history logging | DONE | Всяка промяна логвана |
| ✅ Dashboard visualization | DONE | История в таблица |
| ✅ pin_depot (брава кодове) | DONE | CRUD операции |
| ✅ Guest chat интерфейс | DONE | index.html |
| ✅ Admin dashboard | DONE | dashboard.html |
| ✅ Emergency detection | DONE | Medical + fire + violence |
| 🟡 SMS уведомления | PENDING | Nodemailer ready |
| 🟡 Persistent chat history | PENDING | Needs guest_chats table |
| 🔴 Mobile app | NOT PLANNED | Web-only solution |
| 🟡 SmartThings state readback | PARTIAL | Команда е директна, status идва от feedback |

---

## ⚙️ Конфигурация

### Environment Variables (.env)

```bash
# === SERVER ===
PORT=10000
NODE_ENV=production

# === DATABASE (Neon PostgreSQL) ===
DATABASE_URL=postgresql://user:pass@ep-xxxx.neon.tech/neondb?sslmode=require

# === AI (Google Gemini) ===
GEMINI_API_KEY=AIzaSyD...

# === OPTIONAL LIVE MAP SEARCH (Google Places API) ===
# Използва се за въпроси тип "къде има ..." в района на Банско/Разлог
GOOGLE_PLACES_API_KEY=
# GOOGLE_PLACES_MAX_RESULTS=3
# GOOGLE_PLACES_STRICT_MODE=false
# Ако е true: без live Google Places резултат системата НЕ връща непроверен отговор
# GOOGLE_PLACES_TIMEOUT_MS=5000
# GOOGLE_PLACES_BLOCK_COOLDOWN_MS=3600000
# При API_KEY_SERVICE_BLOCKED / PERMISSION_DENIED Places заявките се спират временно
# за да няма излишни 403 заявки до изчистване на API ключа/ограниченията.

# === OPTIONAL LIVE ROUTES (Google Directions API) ===
# За въпроси тип "как да стигна", "маршрут до", "how to get to"
# Ако GOOGLE_DIRECTIONS_API_KEY липсва, използва GOOGLE_PLACES_API_KEY
# GOOGLE_DIRECTIONS_API_KEY=
# GOOGLE_DIRECTIONS_TIMEOUT_MS=6000
# GOOGLE_DIRECTIONS_DEFAULT_ORIGIN=Aspen Valley Golf, Ski and Spa Resort, Razlog

# === OPTIONAL BRAVE SEARCH (Live Web Search для ресторанти, наем, маршрути) ===
# За отговори на въпроси за ресторанти, наем на кола, туристически маршрути
# https://api.search.brave.com/ -> вземи API ключ
BRAVE_SEARCH_API_KEY=
# BRAVE_SEARCH_TIMEOUT_MS=6000
# BRAVE_SEARCH_MONTHLY_QUOTA=1000
# 1000 заявки/месец в free плана (достатъчно за среден volume)
# Soft warning логове при ~70%, ~85%, ~95% usage
# При изчерпан лимит: автоматичен fallback към Gemini без web search

# === OPTIONAL GROQ ROUTER (SAFE ROUTING BEFORE GEMINI) ===
# Groq отговаря на manual/property въпроси.
# При общи въпроси делегира към Gemini.
GROQ_ROUTER_ENABLED=true
GROQ_API_KEY=
# По подразбиране е https://api.groq.com/openai/v1
# GROQ_API_URL=https://api.groq.com/openai/v1
# Пример: llama-3.3-70b-versatile / llama-3.1-8b-instant
# GROQ_MODEL=llama-3.3-70b-versatile
# GROQ_TIMEOUT_MS=8000

# === OPTIONAL BACKUP LLM (OpenAI-compatible, LAST FALLBACK) ===
# Използва се само ако няма отговор нито от Groq router, нито от Gemini.
# Примери:
# DeepSeek -> BACKUP_API_URL=https://api.deepseek.com/v1 , BACKUP_MODEL=deepseek-chat
# Groq     -> BACKUP_API_URL=https://api.groq.com/openai/v1 , BACKUP_MODEL=llama-3.1-8b-instant
BACKUP_API_KEY=
BACKUP_API_URL=
BACKUP_MODEL=
# BACKUP_TIMEOUT_MS=15000

# === EMAIL (Gmail OAuth2) ===
GMAIL_CLIENT_ID=xxx...
GMAIL_CLIENT_SECRET=xxx...
GMAIL_REFRESH_TOKEN=xxx...

# === DIRECT DEVICE CONTROL (Samsung SmartThings) ===
SMARTTHINGS_API_TOKEN=
# Single device mode (switch):
# SMARTTHINGS_DEVICE_ID=
# Split scene mode (recommended for START/STOP scenes):
SMARTTHINGS_DEVICE_ID_ON=
SMARTTHINGS_DEVICE_ID_OFF=
# Optional overrides:
# SMARTTHINGS_COMPONENT=main
# SMARTTHINGS_API_URL=https://api.smartthings.com/v1
# SMARTTHINGS_SCENE_COMMAND=on
# SMARTTHINGS_COMMAND_ON=on
# SMARTTHINGS_COMMAND_OFF=off

# === API SECURITY ===
METER_API_KEY=

# === TASKER FEEDBACK TUNING (optional) ===
# TASKER_NOISE_WINDOW_MS=45000
# REQUEST_LOG_SUPPRESS_MS=30000

# === OPTIONAL: Tuya (НЕ ИЗПОЛЗВАМ) ===
# TUYA_ACCESS_ID=...
# TUYA_ACCESS_SECRET=...
# TUYA_DEVICE_ID=... (Power Switch)
# TUYA_LOCK_ID=... (Smart Lock)
```

### Local Development (.env.local)
```bash
DATABASE_URL=postgresql://localhost/smart_stay_dev
PORT=3000
GEMINI_API_KEY=test_key
# Осталите без стойност за локално тестване
```

---

## 🚀 Развиване & Deployment

### Local Development

```bash
# Install dependencies
npm install

# Create .env file with local variables
cp .env.example .env

# Start server
npm start

# Server běhá на http://localhost:10000
```

#### Тестване на endpoints локално

```bash
# Test chat endpoint
curl -X POST http://localhost:10000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello","history":[]}'

# Test power status
curl http://localhost:10000/api/power-status

# Test bookings
curl http://localhost:10000/bookings

# Test power history
curl http://localhost:10000/api/power-history?days=7

# Simulate Tasker feedback
curl -X POST http://localhost:10000/api/power/status \
  -H "Content-Type: application/json" \
  -d '{"is_on":true,"source":"tasker_direct"}'
```

### Production Deployment (Render)

1. **Prepare Render project:**
   ```
   Service Type: Web Service
   Language: Node
   Build Command: npm install
   Start Command: npm start
   ```

2. **Set environment variables in Render dashboard:**
   - DATABASE_URL (Neon connection string)
   - GEMINI_API_KEY
   - GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
  - SMARTTHINGS_API_TOKEN
  - SMARTTHINGS_DEVICE_ID_ON, SMARTTHINGS_DEVICE_ID_OFF (or SMARTTHINGS_DEVICE_ID)
  - METER_API_KEY
   - NODE_ENV=production
   - PORT=10000

3. **Deploy:**
   ```bash
   git push origin main
   # Render автоматично деплойва
   ```

4. **Verify deployment:**
   ```bash
   curl https://smart-stay-api.onrender.com/status
   ```

### Using Vercel (Static Frontend - Optional)

```bash
# Deploy only public/ folder to Vercel
vercel --prod

# Update API_URL in frontend to point to Render
# const API = 'https://smart-stay-api.onrender.com'
```

---

## 🧠 AI Architecture (Отделна система)

### Разделяне на отговорност

```
┌─────────────────────────────────────────────┐
│           server.js (HTTP Мост)             │
│  - Прослушва POST /api/chat заявки          │
│  - Валидира input                           │
│  - Изпраща request към AI модула            │
│  - Връща response към клиента               │
└─────────────┬───────────────────────────────┘
              │ await getAIResponse()
              ▼
┌─────────────────────────────────────────────┐
│      ai_service.js (Мозък на системата)    │
│  - Gemini AI интеграция                     │
│  - Manual базирана SSoT                     │
│  - Emergency detection                      │
│  - Character personality (Ико)              │
│  - Context aware responses                  │
│  - Completely independent от HTTP           │
└─────────────────────────────────────────────┘
              │ return { reply, source, emergency }
              ▼
```

### Преимущества на отделяне

✅ **Независимост** - AI работи без HTTP зависимости
✅ **Асинхронност** - Не блокира други заявки към сървъра
✅ **Лесна подмяна** - Может да замениш Gemini с друго AI без промяна на server.js
✅ **Тестваемост** - Можеш да тестваш AI отделно
✅ **Масштабируемост** - AI може да работи на отделен процес/сървър
✅ **Чистота на кода** - server.js е просто мост, не бизнес логика

### AI независимост

```javascript
// server.js просто пропълхва данни:
app.post('/api/chat', async (req, res) => {
    const response = await getAIResponse(message, context);
    res.json(response);
});

// ai_service.js е напълно независим:
export async function getAIResponse(message, guestInfo, context) {
    // Читай manual.txt (локалноот fs)
    // Проверй emergency условия
    // Вик Gemini AI
    // Върни структуриран response
    // ВСИЧКО тук, без HTTP или server логика
}
```

---

## 📋 Next TODO (актуално)

- [ ] Добави SmartThings state readback (GET status) за двойна верификация
- [ ] Добави централен rate-limit за чувствителни endpoint-и
- [ ] Раздели `server.js` на модули (`power`, `auth`, `bookings`)
- [ ] Добави `guest_chats` persistence (по резервация)
- [ ] Добави monitoring/alerts за SmartThings и Gmail sync
  - Email/SMS на admin при грешки
  
- [ ] **Backup & Recovery** - Защита на данните
  - Regular database backups
  - Disaster recovery план
  - Manual override за ток контрол
  
- [ ] **Analytics & Reporting** - Статистики
  - Power consumption graphs
  - Guest satisfaction metrics
  - Revenue tracking per booking
  - Maintenance schedule tracking
  
- [ ] **Multi-property support** - Разширение
  - Support за повече от един апартамент
  - Отделни schedules и PIN кодове
  - Property selector в dashboard
  
- [ ] **Advanced AI Features** - Умни функции
  - Context learning (запомня гост preferences)
  - Multi-language support
  - Sentiment analysis (разбира ако гостът е недоволен)
  - Automatic issue escalation
  
- [ ] **Mobile Web Optimization** - Responsive design
  - Test dashboard на mobile
  - Guest chat interface за mobile
  - Power control quick action

### 🔵 PRODUCTION (Deployment ready)

- [ ] **Environment validation** - Проверка преди deploy
  - .env verification script
  - Database connection test
  - API endpoint testing
  - All env variables present
  
- [ ] **Error handling improvement** - Graceful failures
  - Better error messages за клиента
  - Fallback mechanisms
  - Retry logic със exponential backoff
  
- [ ] **Performance optimization** - Speed & efficiency
  - Database query optimization
  - Caching за manual.txt (не читај всеки път)
  - Rate limiting за API endpoints
  - Connection pooling за DB
  
- [ ] **Security hardening** - Защита
  - Input validation & sanitization
  - SQL injection prevention (вече ползваш neon prepared statements ✅)
  - XSS protection в frontend
  - CORS configuration review
  - Rate limiting на chat API
  
- [ ] **Logging improvement** - Logging best practices
  - Structured logging (JSON format)
  - Log levels (debug, info, warn, error)
  - Log rotation & archival
  - Centralized log monitoring (Papertrail или similarно)
  
- [ ] **Documentation** - Документиране
  - API documentation (Swagger/OpenAPI)
  - Deployment guide
  - Troubleshooting guide
  - Contributing guidelines

---

## 🎯 Приоритет за завършване

### Phase 1: CORE FUNCTIONALITY (В момента)
```
1. ✅ SmartThings direct control (DONE)
2. ✅ Tasker feedback-only loop (DONE)
3. ✅ Bookings-first status for AI (DONE)
4. ⏳ SmartThings status readback (IN PROGRESS)
```

### Phase 2: USER EXPERIENCE (Next)
```
1. Guest PIN система - SMS/Email доставка
2. Persistent chat history
3. Mobile responsive dashboard
4. Power history visualization (graph)
```

### Phase 3: PRODUCTION (After testing)
```
1. Environment validation
2. Security hardening
3. Performance optimization
4. Monitoring & alerting
5. Database backups
```

### Phase 4: ADVANCED (Future)
```
1. Multi-property support
2. Advanced AI features
3. Analytics & reporting
4. Mobile app
```

---
### Tasker Feedback Profile (кратко)
```
Trigger: state changed (не периодично)
Action: HTTP POST -> /api/power/status
Body: {"is_on": true|false, "source": "tasker_direct"}
```

---

## 🐛 Troubleshooting

### SmartThings не приема команда
- ✅ Проверяй `SMARTTHINGS_API_TOKEN`
- ✅ Проверяй `SMARTTHINGS_DEVICE_ID_ON/OFF`
- ✅ Проверяй logs: `[SMARTTHINGS]` в консола

### Tasker feedback не идва
- ✅ Trigger да е only-on-change (без периодичен profile)
- ✅ POST към `/api/power/status`
- ✅ Проверяй `[TASKER]` логове

### Power history не се логва
- ✅ Дали DATABASE_URL е верен?
- ✅ Дали power_history таблица съществува?
- ✅ Дали Tasker праща към `/api/power/status` или `/api/power-status`
- ✅ Проверяй `[DB]` логове в консола

### Gmail sync не работи
- ✅ Дали OAuth2 токените са свежи?
- ✅ Дали Gmail акаунт е верен?
- ✅ Проверяй `[DETECTIVE]` логове

### AI отговара неправилно
- ✅ Дали manual.txt има информацията?
- ✅ Дали GEMINI_API_KEY е верен?
- ✅ Дали role е правилно разпозната (host/guest/stranger)
- ✅ За host reports: дали има активен host token/код в сесията
- ✅ Проверяй AI response в Dashboard

---

## 📊 Monitoring & Logging

### Console Output Format

```
[SMARTTHINGS] 📤 Изпращам ON към device ...
[SMARTTHINGS] ✅ Команда ON изпратена успешно
[TASKER] 📨 update from tasker_direct
[DB] ✅ Промяна записана в power_history
[DETECTIVE] ✅ Power sync към bookings
```

### Key Logs to Monitor

1. **[SMARTTHINGS]** - Device command status
2. **[TASKER]** - Feedback updates
3. **[DB]** - Database операции
4. **[DETECTIVE]** - Gmail + power sync status
5. **[ALERT]** - Emergency situations

---

## 🔐 Security Notes

⚠️ **ВАЖНО:**
- `.env` файла никога НЕ пушай в Git
- SmartThings token-ът е чувствителен - пази го!
- Gmail OAuth2 токени са чувствителни данни
- Database connection string е конфиденциален

✅ **Best Practices:**
- Ползвай environment variables за всички secrets
- Render dashboard има secure storage за variables
- Never commit secrets in code
- Rotate OAuth tokens периодично

---

## 🤖 Power Feedback Integration
### Runtime Flow (актуален)

```
Tasker feedback → POST /api/power/status (или /api/power-status)
     ↓
server.js нормализира state (on/off) и source
     ↓
UPDATE global.powerState + INSERT в power_history (само при промяна)
     ↓
Detective sync -> UPDATE bookings.power_status за активните резервации
     ↓
Dashboard polling + AI bookings-first status
```

### Sources Mapping

| Source | Значение | Пример |
|--------|----------|--------|
| `tasker_direct` | Потребител управлява от Smart Life или физически бутон | Гост включва от app |
| `samsung_meter_on` | Команда ON през API/SmartThings | POST /api/meter/on |
| `samsung_meter_off` | Команда OFF през API/SmartThings | POST /api/meter/off |
| `guest_command` / `host_command` | AI команда от гост/домакин | "включи тока" по чат |
| `api_meter` | Външни API запит | Интеграция със трети системи |

---

## 📝 Future Improvements

1. **Database Persistence for Chat History**
   - Създай `guest_chats` таблица
   - Store conversation history per booking

2. **SMS Notifications**
   - Twilio or Nodemailer integration
   - Notify guests on check-in/power issues

3. **Mobile App**
   - React Native for iOS/Android
   - Real-time notifications

4. **Advanced Analytics**
   - Power consumption graphs
   - Guest satisfaction metrics
   - Revenue tracking

5. **Multi-Property Support**
   - Support multiple apartments
   - Separate schedules per property

6. **Webhook System**
   - Custom integrations
   - Third-party automation

---

## 👤 Contributors

- **PapyBG** - Original creator
- **Latest Updates** - February 2026 (SmartThings direct + feedback-only Tasker)

---

## 📄 License

Private project - Smart Stay Property Management System

---

## 📞 Support

For issues or questions:
1. Check troubleshooting section
2. Review console logs with `[TAG]` filters
3. Check `.env` configuration
4. Verify database connectivity

---

**Last Updated:** February 21, 2026
**Version:** 2.3 (SmartThings Direct + Event-Driven Feedback)
