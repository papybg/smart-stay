# OPENCLAW.md - Smart Stay Project Tracker

Този файл се поддържа от AI асистента. Описва текущото състояние, какво е направено и какво предстои.

---

## 📌 Текущо състояние

### ✅ Направено (до момента)

#### Рефакториране на `ai_service.js`
- Монолитният файл е **разделен и свързан** към `services/ai/`:
  - `auth.js` (319 реда) — автентикация и токени
  - `brave.js` (118 реда) — Brave Search интеграция
  - `config.js` (77 реда) — конфигурация
  - `gemini.js` (212 реда) — Gemini AI логика
  - `groq.js` (101 реда) — Groq fallback
  - `instructions.js` (161 реда) — AI инструкции
  - `intents.js` (276 реда) — intent detection
- `server.js` остава entrypoint и импортира `ai_service.js`, който вече използва модулите.
- **Оставащо по AI слоя:** persistence на chat history и test coverage.

#### Рекламна страница (`public/aspen-valley-retreat.html`)
- **Layout:** Добавен `max-w-lg mx-auto` wrapper за desktop, за да изглежда страницата центрирана и професионална (като мобилен изглед с `shadow-2xl`).
- **Floating UI:** Добавен fixed бутон "Попитай Ико" долу вдясно с директен линк към AI асистента; премахнат стария блок от средата на страницата.
- **Галерия (Lightbox & UI):**
  - Преработена в 4 колони с бързи thumbnails (`w_200` от Cloudinary).
  - Добавен pure JS Lightbox (клик за уголемяване, навигация със стрелки, Esc за затваряне).
  - Актуализирани снимки: заменени счупени линкове, добавени нови реални снимки (15.03.2026).
  - Размер на снимките: Двете снимки от удобствата и новата добавена са с `col-span-2` за по-добър фокус.
- ✅ Commit-нато

---

## 🚧 Предстои

### 1. Core backlog (технически)
- [ ] SmartThings state readback през директен GET към device capability за двойна верификация
- [ ] `guest_chats` persistence (по резервация/сесия)
- [ ] Тестове (unit + integration) за booking/payment flow и power маршрути
- [ ] Monitoring/alerts за SmartThings и Gmail sync

### 2. Страница за резервации — `reservation.bgm-design.com`

**Описание:**
Публична страница за гости, достъпна чрез QR код или директен линк.

**Функционалности:**
- [x] Описание на апартамента + снимки
- [x] Форма за резервация (дати, имена, контакт)
- [x] Интегриран чатбот
- [x] Форма → данните влизат в Neon DB като `Requests`
- [ ] UI за проверка на статус по код (booking lookup)

**Автоматизации (AI следи DB):**
- [x] При смяна на статус към `paid` (след approve) → изпраща guest+host notification
- [ ] Cron job: 4 часа преди check-in → изпраща имейл с PIN код за брава
  - PIN кодовете вече са имплементирани (pin_depot в DB)

**Deployment:**
- Страницата се сервира от Render (smart-stay backend)
- Subdomain: `reservation.bgm-design.com` (bgm-design.com е на Vercel)
- Настройка: CNAME в Vercel DNS → Render + Custom domain в Render

**Email:**
- Email notifications работят през SMTP channel
- Gmail read sync е отделен поток; може да се добави Gmail send channel при нужда

**Плащане:**
- Без онлайн плащане — хостът ръчно обновява статуса в DB
- Workflow е: `pending` -> `approved` -> `paid/confirmed` или `cancelled`

### 3. Production readiness
- [ ] Environment validation script (`.env`, DB, critical API keys)
- [ ] Structured logging + централизиран мониторинг
- [ ] Backup & recovery план
- [ ] Security hardening checklist (input validation, CORS review, XSS review)

---

## 📋 Правила за работа

- **Кодиране само с изрично разрешение от хоста**
- Всяка промяна се описва тук преди и след изпълнение
