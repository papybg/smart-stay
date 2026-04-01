# Nanobot → Smart Stay (Node.js) Integration Guide

## Цел на този документ

Този README описва **какво реално можем да вземем от `nanobot-main`** (Python проект) и как да го адаптираме за нашия стек (**Node.js + Express + PostgreSQL**) в `smart-stay`.

Важно: тук не копираме Python код 1:1. Вземаме **архитектурни патерни**, интерфейси и operational практики.

---

## Кратък отговор (какво си струва да вземем)

От nanobot има 5 неща с висока стойност за нас:

1. **Registry pattern** (tools/channels/providers)
2. **Channel abstraction** (Telegram/Email и др. като plug-in модули)
3. **Outbound dispatcher + queue** (централизирано изпращане на нотификации)
4. **Session manager с устойчива история**
5. **Cron service със state и run history**

Точно това ни трябва и за текущите ни pending цели: нотификации, стабилни статуси, по-добра AI orchestration логика.

---

## Какво да НЕ вземаме директно

От nanobot не е добре да пренасяме директно:

- Python-specific implementation (`asyncio`, `dataclass`, `pydantic`)
- Мулти-канална тежка платформа (Slack/QQ/Matrix и т.н.) в MVP етап
- Прекалено генерализиран agent loop (за нас е по-добре целево за booking/ops workflow)

Принцип: **минимален Node вариант**, фокусиран по бизнес нуждите на `smart-stay`.

---

## Python → Node Mapping (конкретно)

| Nanobot идея | Python имплементация | Node еквивалент за Smart Stay |
|---|---|---|
| Tool Registry | `ToolRegistry`, schema validation | `services/ai/toolRegistry.js` + `zod` за параметри |
| Channel Manager | `ChannelManager` + discovery | `services/notifications/channelManager.js` (ръчна регистрация в MVP) |
| Telegram Channel | `python-telegram-bot` | `telegraf` или `node-telegram-bot-api` |
| Outbound bus | async queue | `EventEmitter` + `p-queue` (или BullMQ при растеж) |
| Cron Service | custom cron with persistence | `node-cron` + `cron-jobs` DB table |
| Session Manager | JSONL append-only | PostgreSQL таблица `ai_sessions` + `ai_messages` |
| Tool param safety | schema cast/validate | `zod.safeParse` + guard clauses |
| Logging discipline | loguru | `pino` (JSON logs) + request ids |

---

## Какво да внедрим първо (по приоритет)

## Phase 1: Notifications Core (най-важно за бизнеса)

### Цел
Да имаме надеждни нотификации при:
- нова заявка (`pending`)
- платена заявка (`paid`)
- анулирана заявка (`cancelled`)

### Какво вземаме от nanobot
- Channel abstraction
- централен dispatcher
- retries/backoff при fail

### Какво създаваме в `smart-stay`
- `services/notifications/channelManager.js`
- `services/notifications/channels/telegram.js`
- `services/notifications/channels/email.js`
- `services/notifications/outboundQueue.js`
- `services/notifications/index.js`

### Къде се закача
- `routes/bookingsRoutes.js`
  - след `POST /api/inquiry` → emit `request_created`
  - след `POST /api/requests/:id/mark-paid` → emit `request_paid`
  - след `POST /api/requests/:id/cancel` → emit `request_cancelled`

### Практически правила
- Ако каналът падне, заявката **не се губи** (запис в `notification_log` + retry)
- Идемпотентност: едно и също събитие не се изпраща 2 пъти към същия канал

---

## Phase 2: Tool Registry за AI (управляем и безопасен AI слой)

### Цел
Да извадим бизнес операции в ясни „tools“, вместо огромна условна логика в `ai_service.js`.

### Какво вземаме от nanobot
- Концепцията за tool interface
- Runtime регистрация
- Schema-based parameter validation

### Какво създаваме
- `services/ai/toolRegistry.js`
- `services/ai/tools/getBookingStatus.js`
- `services/ai/tools/getPowerStatus.js`
- `services/ai/tools/createInquiry.js` (по-късно, внимателно)

### Полза
- По-лесно тестване
- По-малко regressions при промени
- Контрол кои операции AI има право да извиква

---

## Phase 3: Session & Conversation Persistence

### Цел
Историята да е стабилна и възстановима между рестарти.

### Какво вземаме от nanobot
- append-only mindset
- legal boundaries around tool calls/messages

### Какво създаваме
- DB таблици:
  - `ai_sessions(id, channel, chat_id, created_at, updated_at, metadata)`
  - `ai_messages(id, session_id, role, content, tool_call_id, created_at)`

### Полза
- Debuggable AI поведение
- Одит и проследимост при клиентски казуси

---

## Phase 4: Cron Jobs със state (оперативна автоматизация)

### Цел
Да имаме предвидими задачи и историчност на изпълненията.

### Какво вземаме от nanobot
- scheduler service + run status
- next_run / last_run / last_error

### Какво създаваме
- таблица `cron_jobs`
- таблица `cron_runs`
- `services/cron/cronService.js`

### Примери задачи
- напомняне за неплатени заявки > 24ч
- daily digest към host за нови/платени/анулирани

---

## Препоръчана MVP архитектура (Node-friendly)

```text
routes/bookingsRoutes.js
    -> emit domain events
services/notifications/outboundQueue.js
    -> dispatch by event type
services/notifications/channelManager.js
    -> telegram/email adapters
services/notifications/channels/*.js
    -> provider-specific send()
```

Това е достатъчно да вземем 80% от стойността на nanobot идеите без да вкарваме излишна сложност.

---

## Конкретен rollout план (за нашия repo)

## Стъпка 1: Notification foundation
1. Добави notification service (канали + queue)
2. Добави `notification_log` таблица
3. Закачи 3 събития от `bookingsRoutes.js`
4. Логирай success/fail per channel

## Стъпка 2: Telegram първо, Email второ
1. Telegram host notifications
2. Email template за клиента (paid confirmation)
3. Retry policy: 3 опита (exponential backoff)

## Стъпка 3: Tool registry extraction
1. Извади read-only tools
2. Интегрирай в `ai_service.js`
3. Добави deny-list за чувствителни операции

## Стъпка 4: Cron persistence
1. `cron_jobs` + `cron_runs`
2. Daily summary + pending reminder
3. Dashboard tab „Системни задачи“ (по-късно)

---

## Рискове и как ги контролираме

1. **Over-engineering**
   - Решение: само Telegram+Email в MVP, без multi-channel explosion.

2. **Дублирани нотификации**
   - Решение: unique key `(event_id, channel, recipient)` + upsert.

3. **AI прави неподходящи actions**
   - Решение: tools permissions + schema validation + allowlist.

4. **Scheduler drift / пропуснати jobs**
   - Решение: persistent next_run + recovery scan на startup.

---

## Какво можем да вземем веднага още днес

Ако искаме бърз practically-usable резултат:

1. Взимаме nanobot патерна за `ChannelManager` и го правим в Node.
2. Правим Telegram adapter.
3. Връзваме `request_created`, `request_paid`, `request_cancelled`.
4. Добавяме базов retry и `notification_log`.

Това ще даде immediate стойност за операциите без да чакаме пълен „agent framework“.

---

## Финално правило

**Не пренасяме Python код, пренасяме архитектурна дисциплина.**

За `smart-stay` правилният подход е:
- Node-native имплементация
- бизнес-first (Requests/Bookings/Payments)
- малки, ясни, testable модули
- поетапно внедряване с измерим operational ефект

---

## Phase 1: Runtime конфигурация (вече имплементирано)

Добави следните променливи в средата (Render/локално):

- `TELEGRAM_BOT_TOKEN` – Telegram bot token
- `TELEGRAM_CHAT_ID` – chat id за host нотификации
- `NOTIF_HOST_EMAIL` – имейл на домакин за нотификации
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` – SMTP настройки
- `SMTP_FROM` – optional from адрес (ако липсва, ползва `SMTP_USER`)

Поведение:
- При `request_created` се пращат host нотификации (Telegram/Email)
- При `request_paid` и `request_cancelled` се пращат host + guest email (ако guest email съществува)
- Всеки опит се записва в `notification_log` със статус `sent/retrying/failed`
- Retry policy: 3 опита с exponential backoff

---

## Актуален статус и какво остава (April 2026)

### Вече завършено
- Notification foundation е внедрено (`services/notifications/*` + `notification_log`)
- Booking lifecycle endpoint-ите са налични (`inquiry`, `approve`, `mark-paid`, `cancel`)
- Retry и idempotency логика за нотификациите е активна

### Оставащи стъпки (по приоритет)
1. SmartThings readback
  - добавяне на директен state read от SmartThings capability endpoint
  - reconcile между direct read и Tasker feedback
2. Session/chat persistence
  - таблици `guest_chats` (или `ai_sessions` + `ai_messages`)
  - API за fetch на история по резервация/сесия
3. Tool registry extraction (MVP)
  - изкарване на read-only tools (`getBookingStatus`, `getPowerStatus`)
  - строг allowlist за write операции
4. Cron persistence
  - `cron_jobs` + `cron_runs`
  - pending reminder и pre-checkin PIN reminder
5. Testing + CI
  - unit + integration тестове за booking/notification flow
  - автоматично пускане в CI pipeline
