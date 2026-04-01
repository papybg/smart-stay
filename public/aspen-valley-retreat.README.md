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
   - `/api/inquiry` записва запитване в таблица `Requests` със status `pending`
   - `POST /api/requests/:id/mark-paid` конвертира заявка към реална резервация в `bookings`
   - `GET /api/requests` връща списък със заявки
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
- Потокът `pending -> approved -> paid/confirmed -> cancelled` е наличен през `Requests`.
- Host/guest notifications са активни за ключовите събития (Email/Telegram).
- Основното довършване е UX + QA + production стабилизация.

### План (стъпка по стъпка)
1. Клиентски booking lookup
   - `GET /api/requests/:code` или equivalent endpoint за self-check
   - минимална UI страница за проверка по код
2. Reminder automation
   - cron за pending заявки > 24ч
   - cron за PIN reminder 4 часа преди check-in
3. QA и тестове
   - unit тестове за `/api/inquiry` и request lifecycle
   - интеграционни тестове за conversion към `bookings`
4. Production checklist
   - env validation и health checks
   - logging/alerts при sync и notification грешки

## Статус (актуализиран)
- [x] Landing съдържание (описание, галерия, правила)
- [x] AI widget с бутон
- [x] Inquiry API + DB insert `pending`
- [x] Payment confirmation endpoint (`/api/requests/:id/mark-paid` след approve)
- [x] Host / guest notification channel (Telegram/Email)
- [x] Status transition (`pending -> approved -> confirmed/cancelled`)
- [ ] UI за клиент проверка на резервация
- [ ] Reminder cron задачи (pending>24ч, pre-checkin PIN)
- [ ] QA и production checklist
