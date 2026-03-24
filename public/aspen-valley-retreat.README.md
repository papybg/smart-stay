# Aspen Valley Retreat Page - Overview

## Цел на страницата
`aspen-valley-retreat.html` е landing страница за хотелски/ваканционен комплекс „Aspen Valley Retreat". Целта е:
- да представи обекта (с галерия, удобства, правила и локация)
- да приема запитвания за резервиране на апартамента
- да дава instant AI помощ (бутон "Попитай Ико")
- да бъде свързана с бекенд, който управлява резервации, плащания и известия

## Структура на страницата
- `<!DOCTYPE html>` + `<html lang="bg">`
- `<head>`
  - Tailwind CDN + theme config
  - Google fonts
  - инлайн стилове за фон, gallery thumb
- `<body>`
  - контейнер `div.max-w-6xl` (широко на desktop)
  - header (лого, езици)
  - hero секция (cover image + call to action)
  - highlights (pool/spa/ski)
  - amenities grid
  - rules section
  - photo gallery (`gallery-thumb`) + lightbox скрипт
  - location map (Google embed)
  - footer
  - floating AI chat button
  - chat widget iframe към `https://smart-stay.onrender.com/`

## Какво е създадено до момента
1. фронтенд поведение
   - галерия с 12 снимки + lightbox
   - глобален фон от Cloudinary, cover + responsive
   - gallery thumbnails с фиксирани пропорции (obj-fit, височина 180/140)
   - AI chat widget и плаващ бутон (отворяне/затваряне + Esc + click-outside)
   - адаптация (desktop/tablet/mobile)
2. бекенд (routes/bookingsRoutes.js и server.js)
   - `/api/inquiry` записва запитване в таблица `bookings` с status `pending`
   - API `/api/bookings` за listing
   - `/api/reservations/sync` scheduler за power on/off
   - email sync + book sync
   - закоментирана Telegram интеграция (`sendTelegramCommand`)
3. системни workflow компоненти
   - checkin/checkout power schedule
   - lock pin assignment от depot
   - `payment_status` + `reservation_code`

## Какво още трябва да се довърши
### Описание (текстово)
- Бекенд трябва да поддържа пълен резервационен статус:
  - `pending` -> `paid` -> `confirmed`/`cancelled`
- Индикатори в базата за уведомление:
  - `notification_sent_host` / `notification_sent_guest`
- Известяване чрез:
  - Telegram (домакин, клиент)
  - Email (SMTP/Nodemailer)
  - Viber (API)
- Платежно проследяване:
  - webhook/endpoint за платежен оператор
  - 3D-secure и статус update
- Front-end URL за `booking status lookup` (customer can check with code)
- Cross-domain защита и CORS политика

### План (стъпка по стъпка)
1. Добавяне на полета в `bookings`:
   - `reservation_status` enum(\'pending\', \'confirmed\', \'cancelled\')
   - `notification_status` JSON (host/chat/email)
   - `payment_reference` и `payment_received_at`
2. Разширяване на `/api/inquiry`:
   - валидация на input (email, phone, dates)
   - връща `bookingId`, `reservation_code`, `status`
   - ако `payment_status`=pending, добавя reminder / confirm link
3. Добавяне на endpoint `POST /api/bookings/:id/pay`:
   - записва `payment_status='paid'`, `reservation_status='confirmed'`
   - изпраща host+guest известия
   - записва `system_notes`
4. Добавяне на endpoint `GET /api/bookings/:id`:
   - върни детайли, статуса, пин, checkin/out, payment
5. Telegram функция (в `server.js`):
   - активирана с `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
   - helper `sendTelegramMessage(chat_id, text)`
   - callback + try/catch logging
6. Email функция:
   - npm пакети `nodemailer`, `dotenv` config
   - helper `sendEmail(to, subject, html)`
   - допълване към `app.post('/api/bookings/:id/confirm'...)`
7. Интерфейс за стоп на host/guest:
   - `ai_inquiry` форма -> `busy indicator` -> `success message`
   - стъпка confirmation link с код (GET /confirm?code=...)
8. Автоматично синхронизиране и статус:
   - `cron` (server scheduler) провери `pending`>24ч -> нотифицира
   - `syncBookingsFromGmail` че извлича нови резервации
9. Тестове:
   - unit tests за routes (`/api/inquiry`, `/api/bookings/:id/pay`)
   - интеграционни тестове (DB, API response)
10. Документация:
    - допълнение към `README.md` + `SYSTEM_ARCHITECTURE.md`

## Статус (плейсхолдър)
- [x] Landing съдържание (описание, галерия, правила)
- [x] AI widget с бутон
- [x] Inquiry API + DB insert `pending`
- [ ] Payment confirmation endpoint
- [ ] Host / guest notification channel (Telegram/Email/Viber)
- [ ] Status transition и изчакване
- [ ] UI за клиент проверка на резервация
- [ ] QA и production checklist
