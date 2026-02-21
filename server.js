/**
 * ============================================================================
 * SMART-STAY INFRASTRUCTURE CONTROLLER - LEAN EDITION
 * ============================================================================
 * 
 * ⚙️ АРХИТЕКТУРА: ЛОСТ CONTROLLER (Lightweight Infrastructure Controller)
 * 
 * РОЛЯ: Мост между интернет (HTTP заявки + Cron) и мозъка (ai_service.js)
 * 
 * КРИТИЧНИ ФУНКЦИИ:
 * 1️⃣  Express сървър - слуша HTTP заявки (чат, управление ток)
 * 2️⃣  Глобално състояние - синхронизира ток статус между компоненти
 * 3️⃣  Telegram интеграция - изпраща физически команди към бот
 * 4️⃣  Cron планиране - всеки 10 минути проверява check-in/check-out
 * 5️⃣  Request логване - детайлна информация за дебъг
 * 
 * ⛔ ЗАБРАНЕНО В ТОЗИ ФАЙЛ:
 * ❌ GoogleGenerativeAI (AI логика е в ai_service.js)
 * ❌ fs операции (manual.txt е в ai_service.js)
 * ❌ Бизнес логика за AI (само мост към getAIResponse)
 * ❌ Сложни правила (простота и четливост)
 * 
 * ✅ ТОЗИ ФАЙЛ САМО:
 * ✓ Прочита HTTP заявки -> преминава към ai_service.js
 * ✓ Управлява глобален ток статус
 * ✓ Контролира Telegram командите
 * ✓ Стартира и поддържа Cron job
 * 
 * Създадено: февруари 2026 (LEAN версия)
 * ============================================================================
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { neon } from '@neondatabase/serverless';
import { getAIResponse, assignPinFromDepot } from './services/ai_service.js';
import { controlPower, controlMeterByAction } from './services/autoremote.js';
import { generateToken, validateToken, invalidateToken, SESSION_DURATION } from './services/sessionManager.js';
import { syncBookingsFromGmail } from './services/detective.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 10000;

// ============================================================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================================================
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
// === ТЕЛЕГРАМ (Закомментирано за по-нататък) ===
// const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
// const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || null;

/**
 * 🌍 ГЛОБАЛНО СЪСТОЯНИЕ - Синхронизирано между всички компоненти
 * ИЗПОЛЗВАНЕ: Tasker, Web UI, AI асистент всички четат/пишат тук
 */
global.powerState = {
    is_on: true,
    last_update: new Date(),
    source: 'system'
};

// ============================================================================
// ИНИЦИАЛИЗАЦИЯ НА БАЗА ДАННИ
// ============================================================================

/**
 * 📝 Създава/актуализира power_history таблица със Tasker данни
 */
async function initializeDatabase() {
    if (!sql) {
        console.log('[DB] ⚠️ DATABASE_URL не е зададено - логване на история няма да работи');
        return;
    }
    try {
        // Създай таблица ако не съществува (опростена схема)
        await sql`
            CREATE TABLE IF NOT EXISTS power_history (
                id SERIAL PRIMARY KEY,
                is_on BOOLEAN NOT NULL,
                source VARCHAR(50),
                timestamp TIMESTAMPTZ DEFAULT NOW(),
                battery INT,
                booking_id TEXT
            );
        `;
        try {
            await sql`ALTER TABLE power_history ADD COLUMN booking_id TEXT;`;
        } catch (e) { /* колона вече съществува */ }
        try {
            await sql`ALTER TABLE power_history ALTER COLUMN booking_id TYPE TEXT USING booking_id::TEXT;`;
        } catch (e) { /* вече е TEXT или няма нужда */ }
        
        await sql`CREATE INDEX IF NOT EXISTS idx_power_history_timestamp ON power_history(timestamp DESC);`;
        try {
            await sql`ALTER TABLE power_history ADD COLUMN battery INT;`;
        } catch (e) { /* колона вече съществува */ }

        // bookings.power_status - източник за AI (bookings-first архитектура)
        try {
            await sql`ALTER TABLE bookings ADD COLUMN power_status VARCHAR(10) DEFAULT 'unknown';`;
        } catch (e) { /* колона вече съществува */ }
        try {
            await sql`ALTER TABLE bookings ADD COLUMN power_status_updated_at TIMESTAMPTZ;`;
        } catch (e) { /* колона вече съществува */ }

        // pin_depot таблица за dashboard pin CRUD
        await sql`
            CREATE TABLE IF NOT EXISTS pin_depot (
                id SERIAL PRIMARY KEY,
                pin_code VARCHAR(20) UNIQUE NOT NULL,
                pin_name VARCHAR(100),
                is_used BOOLEAN DEFAULT FALSE,
                assigned_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `;
        try {
            await sql`ALTER TABLE pin_depot ADD COLUMN pin_name VARCHAR(100);`;
        } catch (e) { /* колона вече съществува */ }
        console.log('[DB] ✅ power_history таблица готова');

        // Информационна проверка (без синтетичен запис, за да не въвежда нереално състояние)
        try {
            const countResult = await sql`SELECT COUNT(*) as cnt FROM power_history;`;
            const recordCount = Number(countResult[0].cnt) || 0;
            console.log(`[DB] ℹ️ power_history записи: ${recordCount}`);
        } catch (initError) {
            console.warn('[DB] ⚠️ Инициализиране на история: не е критично', initError.message);
        }
    } catch (error) {
        console.error('[DB] 🔴 Грешка при инициализация:', error.message);
    }
}

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

/**
 * 📊 REQUEST ЛОГВАНЕ - Timestamp + Method + URL + IP + Payload Size
 * Помага за дебъг и мониторинг на сървъра
 */
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    const method = req.method.padEnd(6);
    const ip = req.ip || req.connection.remoteAddress || 'UNKNOWN';
    const payloadSize = req.body ? JSON.stringify(req.body).length : 0;
    console.log(`[${timestamp}] 📨 ${method} ${req.url.padEnd(25)} | IP: ${ip.padEnd(15)} | Payload: ${payloadSize} B`);
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// TELEGRAM ИНТЕГРАЦИЯ (Закомментирано за по-нататък)
// ============================================================================
/*
 * 📤 Изпраща команда към Telegram бот
 * @async
 * @param {string} command - 'ВКЛ' vagy 'ИЗКЛ'
 * @returns {Promise<boolean>} True ако успешно

// async function sendTelegramCommand(command) {
//     if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
//         console.warn('[TELEGRAM] ⚠️ Telegram не е конфигуриран');
//         return false;
//     }
//     try {
//         const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
//         const response = await fetch(url, {
//             method: 'POST',
//             headers: { 'Content-Type': 'application/json' },
//             body: JSON.stringify({
//                 chat_id: TELEGRAM_CHAT_ID,
//                 text: `🤖 Smart Stay: ${command}`,
//                 parse_mode: 'HTML'
//             })
//         });
//         const success = response.ok;
//         console.log(`[TELEGRAM] ${success ? '✅' : '❌'} Команда: ${command}`);
//         return success;
//     } catch (e) {
//         console.error('[TELEGRAM] 🔴 Грешка:', e.message);
//         return false;
//     }
// }
*/

// ============================================================================
// ENDPOINTS
// ============================================================================

app.get('/', (req, res) => {
    res.json({ name: 'Smart Stay', status: 'operational', timestamp: new Date().toISOString() });
});

/**
 * POST /api/login
 * 🔐 Аутентификация с парола - генерира SESSION TOKEN
 */
app.post('/api/login', async (req, res) => {
    try {
        const { password } = req.body;
        if (!password || !password.trim()) {
            return res.status(400).json({ error: 'Паролата е задължителна' });
        }

        // 🔑 Verify password matches HOST_CODE
        const HOST_CODE = process.env.HOST_CODE || '';
        const normalizedPassword = password.trim().toLowerCase();
        const normalizedHostCode = HOST_CODE.trim().toLowerCase();
        
        if (normalizedPassword !== normalizedHostCode && !normalizedPassword.includes(normalizedHostCode)) {
            console.log('[LOGIN] ❌ Невалидна парола');
            return res.status(401).json({ error: 'Невалидна парола' });
        }

        // ✅ Password valid - generate token
        const token = generateToken('host');
        const expiresIn = Math.floor(SESSION_DURATION / 1000); // seconds
        console.log('[LOGIN] ✅ Успешна аутентификация за host');
        
        res.json({ 
            success: true,
            token, 
            expiresIn,
            role: 'host',
            message: 'Разбрах! Влезте успешно.'
        });
    } catch (error) {
        console.error('[LOGIN] 🔴 Грешка:', error.message);
        res.status(500).json({ error: 'Грешка при вход' });
    }
});

/**
 * POST /api/logout
 * 🔐 Излез и изтрий SESSION TOKEN
 */
app.post('/api/logout', (req, res) => {
    try {
        const { token } = req.body;
        if (invalidateToken(token)) {
            console.log('[LOGOUT] ✅ Излязъл успешно, token изтрит');
        }
        res.json({ success: true });
    } catch (error) {
        console.error('[LOGOUT] 🔴 Грешка:', error.message);
        res.status(500).json({ error: 'Грешка при изход' });
    }
});

/**
 * POST /api/chat
 * 📝 Мост към AI асистент - проверява SESSION TOKEN или парола
 */
app.post('/api/chat', async (req, res) => {
    try {
        const { message, history = [], token, authCode } = req.body;
        if (!message?.trim()) {
            return res.status(400).json({ error: 'Съобщението е празно' });
        }

        let authToken = token || authCode; // Support both token and legacy authCode
        console.log('[CHAT] 🤖 Викам AI асистент...');
        
        const aiResponse = await getAIResponse(message, history, authToken);
        res.json({ response: aiResponse });
    } catch (error) {
        console.error('[CHAT] 🔴 Грешка:', error.message);
        res.status(500).json({ error: 'AI грешка' });
    }
});


/**
 * GET /api/power-status
 * 🔌 Текущи ток статус (за UI/AI/Tasker)
 */
app.get('/api/power-status', (req, res) => {
    res.json({
        online: true,
        isOn: global.powerState.is_on,
        lastUpdate: global.powerState.last_update.toISOString(),
        source: global.powerState.source
    });
});

// ============================================================================
// TELEGRAM CONTROL (Закомментирано - ще се активира с интеграция на бот)
// ============================================================================
/*
 * POST /api/power-control
 * 🔌 Управление ток + Telegram команда
 *
 * async function sendTelegramCommand(command) {
 *     if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
 *         console.warn('[TELEGRAM] ⚠️ Telegram не е конфигуриран');
 *         return false;
 *     }
 *     try {
 *         const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
 *         const response = await fetch(url, {
 *             method: 'POST',
 *             headers: { 'Content-Type': 'application/json' },
 *             body: JSON.stringify({
 *                 chat_id: TELEGRAM_CHAT_ID,
 *                 text: `🤖 Smart Stay: ${command}`,
 *                 parse_mode: 'HTML'
 *             })
 *         });
 *         const success = response.ok;
 *         console.log(`[TELEGRAM] ${success ? '✅' : '❌'} Команда: ${command}`);
 *         return success;
 *     } catch (e) {
 *         console.error('[TELEGRAM] 🔴 Грешка:', e.message);
 *         return false;
 *     }
 * }
 */

function normalizePowerState(rawValue) {
    if (typeof rawValue === 'boolean') return rawValue;
    if (typeof rawValue === 'number') {
        if (rawValue === 1) return true;
        if (rawValue === 0) return false;
        return null;
    }
    if (typeof rawValue === 'string') {
        const value = rawValue.trim().toLowerCase();
        if (['on', 'true', '1', 'вкл', 'включен', 'включи'].includes(value)) return true;
        if (['off', 'false', '0', 'изкл', 'изключен', 'изключи'].includes(value)) return false;
    }
    return null;
}

function normalizeMeterAction(rawAction) {
    const value = String(rawAction || '').trim().toLowerCase();
    if (['on', '1', 'true', 'вкл', 'включи', 'start'].includes(value)) return 'on';
    if (['off', '0', 'false', 'изкл', 'изключи', 'stop'].includes(value)) return 'off';
    return null;
}

async function handlePowerStatusUpdate(req, res) {
    try {
        const rawState = req.body?.is_on ?? req.body?.isOn ?? req.body?.status ?? req.body?.state;
        const source = req.body?.source || 'tasker_direct';
        const booking_id = req.body?.booking_id ?? source;
        const rawBattery = req.body?.battery;
        const forceLog = req.body?.force_log === true || String(req.body?.force_log || '').toLowerCase() === 'true';
        const prevState = global.powerState.is_on;
        const timestamp = new Date();
        let dbLogged = false;
        let dbLogError = null;

        console.log(`[TASKER] 📨 Получени данни:`, JSON.stringify(req.body));
        const newState = normalizePowerState(rawState);
        if (newState === null) {
            console.warn(`[TASKER] ⚠️ Невалидно състояние: ${rawState}`);
            return res.status(400).json({
                success: false,
                error: 'Невалидно поле за състояние. Изпратете is_on/status/state като true|false|on|off|1|0'
            });
        }

        console.log(`[TASKER] 📊 State: ${newState ? 'ON' : 'OFF'} (беше ${prevState ? 'ON' : 'OFF'})`);
        console.log(`[TASKER] 🔍 sql available: ${sql ? '✅ YES' : '❌ NO'}`);

        let batteryValue = null;
        if (rawBattery !== undefined && rawBattery !== null && String(rawBattery).trim() !== '') {
            const parsedBattery = Number.parseInt(String(rawBattery), 10);
            if (!Number.isNaN(parsedBattery)) {
                batteryValue = parsedBattery;
            }
        }

        // 1) Обновяване на глобално състояние
        global.powerState.is_on = newState;
        global.powerState.last_update = timestamp;
        global.powerState.source = source;

        // 2) Запис в БД само при промяна
        if (sql && (prevState !== newState || forceLog)) {
            try {
                console.log(`[DB] 📝 Inserting: is_on=${newState}, source=${source}, battery=${batteryValue}, booking_id=${booking_id}`);
                await sql`
                    INSERT INTO power_history (is_on, source, timestamp, battery, booking_id)
                    VALUES (${newState}, ${source}, ${timestamp}, ${batteryValue}, ${booking_id})
                `;
                dbLogged = true;
                console.log(`[DB] ✅ Промяна записана: ${prevState ? 'ON' : 'OFF'} → ${newState ? 'ON' : 'OFF'}`);
            } catch (dbError) {
                dbLogError = dbError.message;
                console.error('[DB] 🔴 Грешка при логване:', dbError.message);
            }

            // 3) Обнови bookings.power_status за активните резервации
            try {
                await sql`
                    UPDATE bookings
                    SET power_status = ${newState ? 'on' : 'off'},
                        power_status_updated_at = ${timestamp}
                    WHERE check_in <= ${timestamp}
                      AND check_out > ${timestamp}
                      AND COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
                `;
            } catch (bookingErr) {
                console.error('[DB] 🔴 Грешка при update на bookings.power_status:', bookingErr.message);
            }
        } else if (sql && prevState === newState && !forceLog) {
            console.log(`[TASKER] ℹ️ Състоянието е същото (${newState ? 'ON' : 'OFF'}), без запис`);
        } else if (!sql) {
            dbLogError = 'Database not connected';
            console.error(`[DB] 🔴 КРИТИЧНО: sql е NULL/undefined - База недостъпна!`);
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'Статус получен и обработен',
            received: { 
                is_on: newState, 
                source,
                battery: batteryValue,
                booking_id,
                stateChanged: prevState !== newState,
                forceLog,
                dbLogged,
                dbLogError,
                note: prevState === newState && !forceLog ? 'Състояние без промяна' : (dbLogged ? 'Записано в power_history' : 'Записът не е потвърден')
            }
        });
    } catch (error) {
        console.error('[TASKER] 🔴 Грешка:', error.message);
        res.status(500).json({ error: error.message });
    }
}

// Поддържа и двата endpoint варианта, за да не чупи Tasker конфигурации
app.post('/api/power/status', handlePowerStatusUpdate);
app.post('/api/power-status', handlePowerStatusUpdate);

async function executeMeterAction(action, sourceTag, res) {
    const timestamp = new Date();
    const willTurnOn = action === 'on';
    const dbSource = sourceTag || 'api_meter';

    let dbLogged = false;
    let dbError = null;

    if (sql) {
        try {
            await sql`
                INSERT INTO power_history (is_on, timestamp, source, booking_id)
                VALUES (${willTurnOn}, ${timestamp}, ${dbSource}, ${dbSource})
            `;
            dbLogged = true;
            console.log('[DB] ✅ API команда записана в power_history');
        } catch (err) {
            dbError = err.message;
            console.error('[DB] 🔴 Грешка при запис API meter:', err.message);
        }
    } else {
        dbError = 'Database not connected';
    }

    const commandResult = await controlMeterByAction(action);

    if (!commandResult.success) {
        return res.status(500).json({
            success: false,
            error: 'Неуспешна команда към Samsung SmartThings',
            action,
            dbLogged,
            dbError
        });
    }

    return res.status(200).json({
        success: true,
        message: `Команда "${commandResult.command}" изпратена към телефона`,
        action,
        command: commandResult.command,
        dbLogged,
        dbError
    });
}

/**
 * POST /api/meter
 * 🔌 Управление на електромера от Tasker или админ панел
 * Очаква: { "action": "on" } или { "action": "off" }
 */
app.post('/api/meter', async (req, res) => {
    try {
        const action = normalizeMeterAction(req.body?.action);

        // Валидирай action параметъра
        if (!action) {
            return res.status(400).json({ error: 'Невалидна действие. Очаква: "on" или "off"' });
        }

        console.log(`[METER API] 🎛️  Управление на ток: ${action.toUpperCase()}`);
        return await executeMeterAction(action, 'api_meter', res);
    } catch (error) {
        console.error('[METER API] 🔴 Грешка:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/meter/on', async (_req, res) => {
    console.log('[METER API] 🎛️ Samsung ON команда');
    return await executeMeterAction('on', 'samsung_meter_on', res);
});

app.post('/api/meter/off', async (_req, res) => {
    console.log('[METER API] 🎛️ Samsung OFF команда');
    return await executeMeterAction('off', 'samsung_meter_off', res);
});

/**
 * GET /api/power-history
 * 📊 Извличане на история на вкл/изкл на ток за дашборд
 */
app.get('/api/power-history', async (req, res) => {
    if (!sql) {
        return res.status(503).json({ error: 'Database not available' });
    }
    try {
        const { days = 30 } = req.query;
        const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        
        const history = await sql`
            SELECT 
                id,
                is_on,
                source,
                timestamp,
                battery,
                booking_id
            FROM power_history
            WHERE timestamp >= ${sinceDate}
            ORDER BY timestamp DESC
            LIMIT 500
        `;
        
        res.json({
            count: history.length,
            data: history,
            period: { since: sinceDate, until: new Date() }
        });
    } catch (error) {
        console.error('[DB] 🔴 Грешка при четене:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/alert
 * 🚨 Получаване известувания от AI
 */
app.post('/api/alert', (req, res) => {
    try {
        const { message, guestInfo } = req.body;
        console.log(`[ALERT] 🚨 ${message}`);
        if (guestInfo) console.log(`[ALERT] Гост: ${guestInfo.guest_name}`);
        res.sendStatus(200);
    } catch (error) {
        console.error('[ALERT] 🔴 Грешка:', error.message);
        res.status(500).send('Error');
    }
});

/**
 * GET /api/bookings
 * 📋 Резервации (за scheduler)
 */
app.get('/api/bookings', async (req, res) => {
    try {
        if (!sql) {
            return res.status(500).json({ error: 'Database not connected' });
        }
        const bookings = await sql`SELECT * FROM bookings ORDER BY check_in DESC LIMIT 50`;
        res.json(bookings);
    } catch (error) {
        console.error('[BOOKINGS] 🔴 Грешка:', error.message);
        res.status(500).json({ error: 'Database error' });
    }
});

/**
 * GET /bookings
 * 📋 Legacy endpoint за dashboard/aaadmin съвместимост
 */
app.get('/bookings', async (req, res) => {
    try {
        if (!sql) {
            return res.status(500).json({ error: 'Database not connected' });
        }
        const bookings = await sql`SELECT * FROM bookings ORDER BY check_in DESC LIMIT 200`;
        res.json(bookings);
    } catch (error) {
        console.error('[BOOKINGS:LEGACY] 🔴 Грешка:', error.message);
        res.status(500).json({ error: 'Database error' });
    }
});

/**
 * POST /add-booking
 * ➕ Legacy endpoint за ръчно добавяне от dashboard
 */
app.post('/add-booking', async (req, res) => {
    try {
        if (!sql) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const { guest_name, reservation_code, check_in, check_out } = req.body || {};

        if (!guest_name || !reservation_code || !check_in || !check_out) {
            return res.status(400).json({ error: 'Липсват задължителни полета' });
        }

        const checkInDate = new Date(check_in);
        const checkOutDate = new Date(check_out);

        if (Number.isNaN(checkInDate.getTime()) || Number.isNaN(checkOutDate.getTime()) || checkInDate >= checkOutDate) {
            return res.status(400).json({ error: 'Невалидни дати за резервация' });
        }

        const powerOn = new Date(checkInDate.getTime() - 2 * 60 * 60 * 1000);
        const powerOff = new Date(checkOutDate.getTime() + 1 * 60 * 60 * 1000);

        const existing = await sql`
            SELECT lock_pin FROM bookings
            WHERE reservation_code = ${reservation_code}
            LIMIT 1
        `;

        let lockPin = existing[0]?.lock_pin || null;
        if (!lockPin) {
            lockPin = await assignPinFromDepot({ reservation_code, guest_name });
        }

        const result = await sql`
            INSERT INTO bookings (
                reservation_code,
                guest_name,
                check_in,
                check_out,
                lock_pin,
                payment_status,
                power_on_time,
                power_off_time,
                source
            )
            VALUES (
                ${reservation_code},
                ${guest_name},
                ${checkInDate.toISOString()},
                ${checkOutDate.toISOString()},
                ${lockPin},
                'paid',
                ${powerOn.toISOString()},
                ${powerOff.toISOString()},
                'manual'
            )
            ON CONFLICT (reservation_code)
            DO UPDATE SET
                guest_name = EXCLUDED.guest_name,
                check_in = EXCLUDED.check_in,
                check_out = EXCLUDED.check_out,
                power_on_time = EXCLUDED.power_on_time,
                power_off_time = EXCLUDED.power_off_time,
                lock_pin = COALESCE(bookings.lock_pin, EXCLUDED.lock_pin)
            RETURNING id, reservation_code, guest_name, lock_pin
        `;

        return res.status(200).json({ success: true, booking: result[0] });
    } catch (error) {
        console.error('[BOOKINGS:ADD] 🔴 Грешка:', error.message);
        return res.status(500).json({ error: 'Грешка при добавяне на резервация' });
    }
});

/**
 * DELETE /bookings/:id
 * 🗑️ Legacy endpoint за изтриване от dashboard
 */
app.delete('/bookings/:id', async (req, res) => {
    try {
        if (!sql) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const bookingId = Number.parseInt(req.params.id, 10);
        if (Number.isNaN(bookingId)) {
            return res.status(400).json({ error: 'Невалидно ID' });
        }

        const deleted = await sql`
            DELETE FROM bookings
            WHERE id = ${bookingId}
            RETURNING id
        `;

        if (deleted.length === 0) {
            return res.status(404).json({ error: 'Резервацията не е намерена' });
        }

        return res.status(200).json({ success: true, deletedId: bookingId });
    } catch (error) {
        console.error('[BOOKINGS:DELETE] 🔴 Грешка:', error.message);
        return res.status(500).json({ error: 'Грешка при изтриване на резервация' });
    }
});

/**
 * GET /sync
 * 🔄 Legacy endpoint за ръчно стартиране на Detective sync
 */

async function runReservationsSync() {
    if (!sql) {
        return { checkinCount: 0, checkoutCount: 0, dbAvailable: false };
    }

    const now = new Date();
    const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000);

    const checkinBookings = await sql`
        SELECT id, guest_name FROM bookings
        WHERE check_in <= ${twoHoursFromNow} AND check_in >= ${now} AND check_out > ${now}
        LIMIT 10
    `;

    for (const booking of checkinBookings) {
        if (!global.powerState.is_on) {
            console.log(`[SCHEDULER] 🚨 CHECK-IN за ${booking.guest_name} - ВКЛ`);
            try {
                await sql`
                    INSERT INTO power_history (is_on, timestamp, source, booking_id)
                    VALUES (true, ${now}, 'scheduler_checkin', ${String(booking.id)})
                `;
            } catch (dbErr) {
                console.error('[DB] 🔴 Грешка при запис scheduler check-in:', dbErr.message);
            }

            global.powerState.is_on = true;
            global.powerState.source = 'scheduler-checkin';
            global.powerState.last_update = now;

            try {
                await sql`
                    UPDATE bookings
                    SET power_status = 'on', power_status_updated_at = ${now}
                    WHERE id = ${booking.id}
                `;
            } catch (bookingErr) {
                console.error('[DB] 🔴 Грешка при scheduler check-in power_status:', bookingErr.message);
            }

            await controlPower(true);
        }
    }

    const checkoutBookings = await sql`
        SELECT id, guest_name FROM bookings
        WHERE check_out <= ${now} AND check_out >= ${oneHourAgo}
        LIMIT 10
    `;

    for (const booking of checkoutBookings) {
        if (global.powerState.is_on) {
            console.log(`[SCHEDULER] 🚨 CHECK-OUT ${booking.guest_name} - ИЗКЛ`);
            try {
                await sql`
                    INSERT INTO power_history (is_on, timestamp, source, booking_id)
                    VALUES (false, ${now}, 'scheduler_checkout', ${String(booking.id)})
                `;
            } catch (dbErr) {
                console.error('[DB] 🔴 Грешка при запис scheduler check-out:', dbErr.message);
            }

            global.powerState.is_on = false;
            global.powerState.source = 'scheduler-checkout';
            global.powerState.last_update = now;

            try {
                await sql`
                    UPDATE bookings
                    SET power_status = 'off', power_status_updated_at = ${now}
                    WHERE id = ${booking.id}
                `;
            } catch (bookingErr) {
                console.error('[DB] 🔴 Грешка при scheduler check-out power_status:', bookingErr.message);
            }

            await controlPower(false);
        }
    }

    return {
        checkinCount: checkinBookings.length,
        checkoutCount: checkoutBookings.length,
        dbAvailable: true
    };
}

/**
 * POST /api/reservations/sync
 * ⏰ Render Cron Job endpoint: Check-in/check-out автоматизация
 */
app.post('/api/reservations/sync', async (req, res) => {
    try {
        if (!sql) {
            return res.status(503).json({ error: 'Database not connected' });
        }
        console.log(`[SCHEDULER] ⏰ ${new Date().toISOString()} - Reservations sync`);
        const result = await runReservationsSync();
        return res.status(200).json({ success: true, ...result });
    } catch (error) {
        console.error('[SCHEDULER] 🔴 Грешка:', error.message);
        return res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/email/sync
 * 📧 Render Cron Job endpoint: Gmail sync
 */
app.post('/api/email/sync', async (req, res) => {
    try {
        console.log('[DETECTIVE] 📧 Email sync стартиран');
        await syncBookingsFromGmail();
        return res.status(200).json({ success: true, message: '✅ Email sync завършен' });
    } catch (error) {
        console.error('[DETECTIVE] 🔴 Грешка при email sync:', error.message);
        return res.status(500).json({ error: error.message });
    }
});

app.get('/sync', async (_req, res) => {
    try {
        console.log('[DETECTIVE] 🔄 Ръчен sync стартиран от dashboard');
        await syncBookingsFromGmail();
        return res.status(200).send('✅ Sync завършен');
    } catch (error) {
        console.error('[DETECTIVE] 🔴 Грешка при ръчен sync:', error.message);
        return res.status(500).send('❌ Грешка при sync');
    }
});

// ============================================================================
// CRON SCHEDULER - Преместен в Render Cron Jobs
// ============================================================================
// Използвайте Render Cron Jobs и извиквайте:
//   POST /api/reservations/sync (на всеки 10 мин)
//   POST /api/email/sync        (на всеки 15 мин)

// ============================================================================
// GRACEFUL SHUTDOWN - Чисто затваряне на DB връзки при SIGTERM/SIGINT
// ============================================================================

async function closeConnections() {
    try {
        if (sql && typeof sql.end === 'function') {
            console.log('[SHUTDOWN] Затваряне на DB пул...');
            await sql.end();
            console.log('[SHUTDOWN] ✅ DB конекции затворени');
        }
    } catch (err) {
        console.error('[SHUTDOWN] ⚠️ Грешка при затваряне:', err.message);
    }
}

process.on('SIGTERM', async () => {
    console.log('[SIGTERM] 📴 Сървърът спира по команда на Render...');
    await closeConnections();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('[SIGINT] 📴 Сървърът спира...');
    await closeConnections();
    process.exit(0);
});

// ============================================================================
// СТАРТИРАНЕ НА СЪРВЪРА
// ============================================================================

const server = app.listen(PORT, async () => {
    console.log('\n🚀 SMART-STAY LEAN CONTROLLER STARTED');
    console.log(`   🌐 http://localhost:${PORT}`);
    // console.log(`   📤 Telegram: ${TELEGRAM_BOT_TOKEN ? '✅' : '⚠️'}`);
    console.log(`   🗄️  Database: ${sql ? '✅' : '⚠️'}`);
    console.log(`   📅 CRON JOBS: Преместени в Render (не работят локално)\n`);
    
    // Инициализирай базата и съедини power_history таблица
    await initializeDatabase();
    
    // ❌ ИЗКЛЮЧЕНО: initializeScheduler(); - използвайте Render Cron Jobs
    // ❌ ИЗКЛЮЧЕНО: initializeDetectiveScheduler(); - използвайте Render Cron Jobs

    // ❌ ИЗКЛЮЧЕНО: setInterval за cleanupExpiredTokens
    // console.log('[SESSION] ✅ Периодичното почистване на токени е активно (на всеки 5 минути)');
    console.log('[SESSION] ℹ️ Token cleanup сега е ON-DEMAND (извиква се при заявки за вход)');
});

/**
 * GET /api/pins
 * 🔑 Връща pin_depot за dashboard
 */
app.get('/api/pins', async (_req, res) => {
    try {
        if (!sql) return res.status(500).json({ error: 'Database not connected' });
        const rows = await sql`
            SELECT id, pin_code, pin_name, is_used, assigned_at, created_at
            FROM pin_depot
            ORDER BY id ASC
        `;
        res.json(rows);
    } catch (error) {
        console.error('[PINS] 🔴 Грешка при четене:', error.message);
        res.status(500).json({ error: 'Грешка при четене на PIN списъка' });
    }
});

/**
 * POST /api/pins
 * ➕ Добавяне на PIN в pin_depot
 */
app.post('/api/pins', async (req, res) => {
    try {
        if (!sql) return res.status(500).json({ error: 'Database not connected' });
        const { pin_code, pin_name } = req.body || {};
        if (!pin_code || !String(pin_code).trim()) {
            return res.status(400).json({ error: 'Липсва pin_code' });
        }

        const result = await sql`
            INSERT INTO pin_depot (pin_code, pin_name, is_used)
            VALUES (${String(pin_code).trim()}, ${pin_name ? String(pin_name).trim() : null}, FALSE)
            ON CONFLICT (pin_code) DO NOTHING
            RETURNING id, pin_code, pin_name, is_used
        `;

        if (result.length === 0) {
            return res.status(409).json({ error: 'Този PIN вече съществува' });
        }
        res.status(201).json(result[0]);
    } catch (error) {
        console.error('[PINS] 🔴 Грешка при добавяне:', error.message);
        res.status(500).json({ error: 'Грешка при добавяне на PIN' });
    }
});

/**
 * DELETE /api/pins/:id
 * 🗑️ Изтриване на PIN
 */
app.delete('/api/pins/:id', async (req, res) => {
    try {
        if (!sql) return res.status(500).json({ error: 'Database not connected' });
        const pinId = Number.parseInt(req.params.id, 10);
        if (Number.isNaN(pinId)) return res.status(400).json({ error: 'Невалидно ID' });

        const deleted = await sql`DELETE FROM pin_depot WHERE id = ${pinId} RETURNING id`;
        if (deleted.length === 0) return res.status(404).json({ error: 'PIN не е намерен' });
        res.json({ success: true, deletedId: pinId });
    } catch (error) {
        console.error('[PINS] 🔴 Грешка при изтриване:', error.message);
        res.status(500).json({ error: 'Грешка при изтриване на PIN' });
    }
});

/**
 * GET /calendar.ics
 * 📅 iCal feed за резервации
 */
app.get('/calendar.ics', async (_req, res) => {
    try {
        if (!sql) return res.status(500).send('Database not connected');

        const rows = await sql`
            SELECT reservation_code, check_in, check_out, payment_status
            FROM bookings
            WHERE COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
            ORDER BY check_in ASC
            LIMIT 500
        `;

        const toIcsDate = (value) => {
            const d = new Date(value);
            const pad = (n) => String(n).padStart(2, '0');
            return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
        };

        const events = rows.map((row) => {
            const uid = `${row.reservation_code || 'booking'}-${toIcsDate(row.check_in)}@smart-stay`;
            return [
                'BEGIN:VEVENT',
                `UID:${uid}`,
                `DTSTAMP:${toIcsDate(new Date())}`,
                `DTSTART:${toIcsDate(row.check_in)}`,
                `DTEND:${toIcsDate(row.check_out)}`,
                `SUMMARY:Smart Stay Booking`,
                `DESCRIPTION:Reservation ${row.reservation_code || 'N/A'}`,
                'END:VEVENT'
            ].join('\r\n');
        }).join('\r\n');

        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Smart Stay//Bookings Calendar//BG',
            'CALSCALE:GREGORIAN',
            events,
            'END:VCALENDAR'
        ].join('\r\n');

        res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
        res.send(ics);
    } catch (error) {
        console.error('[CALENDAR] 🔴 Грешка:', error.message);
        res.status(500).send('Calendar generation error');
    }
});

/**
 * GET /status
 * 🩺 Health check (БЕЗ DB запит - за да позволи Neon да спи)
 * ⚡ ОПТИМИЗИРАНО: Не каква DB, само проверка на app процеса
 */
app.get('/status', (_req, res) => {
    res.json({
        online: true,
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        powerState: global.powerState.is_on ? 'on' : 'off'
    });
});