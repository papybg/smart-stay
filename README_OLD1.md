# Smart Stay - AI Rental Management 🏠🤖

Интелигентна система за автоматизация на ваканционни имоти, управлявана от **Ико** – твоят виртуален иконом.

## 🚀 Как работи?

1. **AI Detective (Gmail Sync)**: Ико сканира Gmail на всеки 15 минути за нови потвърждения от Airbnb. Използва **Gemini Flash**, за да извлече имената на гостите, датите и кодовете за резервация, след което ги записва в **Neon DB**.
2. **Smart Power Control**: Системата автоматично включва тока в апартамента (през AutoRemote + Tasker) **2 часа преди** настаняването и го изключва **1 час след** напускането.
3. **iCal Sync**: Генерира динамичен `/calendar.ics` файл, който се подава към Airbnb, за да предотврати грешки в синхронизацията.
4. **Guest Chat**: Гостите могат да чатят с Ико, да получават своя ПИН за достъп и информация за престоя си в реално време.

## 🛠 Технологичен стек

- **Backend**: Node.js, Express (Render)
- **AI**: Google Gemini Flash
- **Database**: Neon (PostgreSQL) 
- **Phone Control**: AutoRemote + Tasker (Android)
- **Integrations**: Gmail API, Google OAuth2

## 📂 Структура на проекта

- `server.js`: Основен сървър, API маршрути и автоматизация на тока.
- `services/detective.js`: AI логика за сканиране на имейли и извличане на данни.
- `services/ai_service.js`: Gemini AI асистент (независим модул).
- `services/autoremote.js`: AutoRemote интеграция за управление на Tasker.
- `public/index.html`: Чат интерфейс за гостите.
- `public/dashboard.html`: Админ панел + история на тока.
- `public/remote.html`: Дистанционно управление на тока.

## ⚙️ Маршрути (Endpoints)

### Chat & AI
- `POST /api/chat` - Комуникация с Ико асистент.

### Power Control
- `POST /api/meter` - Управление на ток (action: "on" или "off").
- `POST /api/power/status` - Tasker feedback (логване на състояние).
- `GET /api/power-status` - Проверка на текущото състояние на тока.
- `GET /api/power-history` - История на всички вкл/изкл операции.

### Bookings & Management
- `GET /bookings` - Списък с резервации (Admin).
- `POST /api/bookings` - Добавяне на нова резервация.
- `GET /calendar.ics` - iCal календар за Airbnb.

### PIN Depot
- `GET /api/pins` - Всички PIN кодове за ключалката.
- `POST /api/pins` - Добавяне на нов PIN.
- `DELETE /api/pins/{id}` - Изтриване на PIN код.

## 🔑 Environment Variables (Render)

Добавете следните ключове в Render Dashboard → Environment:

```
DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/neondb
GEMINI_API_KEY=AIzaSy...
GMAIL_CLIENT_ID=xxx.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=xxx
GMAIL_REFRESH_TOKEN=xxx
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=987654
AUTOREMOTE_KEY=ezBgKK... (твоят личен ключ от AutoRemote)
NODE_ENV=production
```

⚠️ **КРИТИЧНО:** `AUTOREMOTE_KEY` е лично за твоя телефон! Находи го в AutoRemote приложението на телефона.

## 📱 Tasker Configuration (Android Phone)

### Production URL за HTTP заявките

Когда деплойваш на Render, промени URL-ите в Tasker HTTP Request от:
```
http://localhost:10000/api/meter
```
На твоя production Render URL:
```
https://your-project-name.onrender.com/api/meter
```

## 🚀 Deployment на Render

1. Свързване на GitHub repository
2. Ново Web Service на Render
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Добавяне на Environment Variables (вижте по-горе)
6. Deploy

Разработено от PapyBG.
