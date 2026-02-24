# SmartThings OAuth2 Setup Guide

## Обзор на процеса

Това е 3-степенна интеграция, която свързва Smart Stay с SmartThings API чрез OAuth2:

```
1. Изтегли Personal Access Token от SmartThings
                    ↓
2. Регистрирай OAuth приложение със `get_keys.py`
                    ↓
3. Получи authorization кода от SmartThings (/callback)
                    ↓
4. Размени кода за access_token + refresh_token
                    ↓
5. Слагай токените в .env на Render
```

---

## Стъпка 1️⃣: Изтегли Personal Access Token

1. Отиди на https://smartthings.developer.samsung.com/
2. Влез с Samsung сметка
3. Натисни `Personal Access Tokens` → `Generate token`
4. Даде название (например `Smart Stay OAuth`)
5. Копирай токена в `get_keys.py` (редица 2: `TOKEN = "..."`）

---

## Стъпка 2️⃣: Регистрирай OAuth Приложение

Пусни Python скрипта:

```bash
python get_keys.py
```

Очаквания резултат:
```
✅ Client ID: xxx...
✅ Client Secret: yyy...
```

Копирай и запази где-то, ще са ти нужни в .env файла.

---

## Стъпка 3️⃣: Получи Authorization Code

Отвори този URL в браузъра (замени `CLIENT_ID` с полученото)):

```
https://api.smartthings.com/oauth/authorize?response_type=code&client_id=CLIENT_ID&scope=r:devices:*+w:devices:*+x:devices:*&redirect_uri=https://smart-stay.onrender.com/callback
```

SmartThings ще те редиректне към:
```
https://smart-stay.onrender.com/callback?code=xxx&state=yyy
```

Сървърът автоматично ще размени кода за токени и ще ги логна в console.

---

## Стъпка 4️⃣: Запази Токените в .env

Провери сървърния лог (terminal или Render dashboard) и копирай редовете:

```
ST_ACCESS_TOKEN=...
ST_REFRESH_TOKEN=...
```

Добави към `.env` файл:
```
ST_CLIENT_ID=xxx
ST_CLIENT_SECRET=yyy
ST_ACCESS_TOKEN=zzz
ST_REFRESH_TOKEN=www
```

---

## Стъпка 5️⃣: Рестартирай приложението

Ако деплойваш на Render:
1. Push промените в Git
2. Render ще обнови .env
3. Приложението ще стартира със SmartThings OAuth

Ако локално тестваш:
```bash
npm start
```

---

## 🔄 Как Работи Token Refresh?

- **Access Token**: Експайрира за ~ 1 час
- **Refresh Token**: Експайрира за ~ 1 година
- **Auto-Refresh**: Всеки 12 часа, системата автоматично обновява access token
- **On-Demand Refresh**: При 401 сигнал от SmartThings, refresh се случва веднага

---

## ⚠️ Безопасност

- Никога **не* комитвай `.env` файл в Git
- Personal Access Token (за `get_keys.py`) **не е нужен** след регистрирането
- Access Token + Refresh Token трябва да са **в тайност** (не делиш с никого)

---

## 🧪 Smoke Test

След като сложиш токените в .env, пусни:

```bash
node --input-type=module -e "
import { controlMeterByAction, controlPower } from './services/autoremote.js';
const r = await controlMeterByAction('on');
console.log('Test result:', r);
"
```

Очаквания резултат:
```
[SMARTTHINGS] 📤 Успешно: on
Test result: { success: true, command: 'on' }
```

---

## 🆘 Ако Има Грешка

### Грешка: "Липсват ST_CLIENT_ID/ST_CLIENT_SECRET"
→ Слагай ги в .env и рестартирай

### Грешка: "Липсва ID на устройство"
→ Настрой `SMARTTHINGS_DEVICE_ID_ON` и `SMARTTHINGS_DEVICE_ID_OFF` в .env

### Грешка: "Изтекъл токен"
→ Автоматично се подновява, но провери логовете

---

## 📝 Файлове, Които Изменихме

- `get_keys.py` — скрипт за регистриране на OAuth приложение
- `routes/authRoutes.js` — добавен `/callback` endpoint
- `server.js` — регистрирана `/callback` функция
- `services/autoremote.js` — добавено OAuth refresh + fallback логика

---

**Всичко готово! Системата сега говори с SmartThings чрез OAuth2. 🎉**
