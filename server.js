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
import cron from 'node-cron';
import { getAIResponse, assignPinFromDepot } from './services/ai_service.js';
import { controlPower } from './services/autoremote.js';
import { generateToken, validateToken, cleanupExpiredTokens, invalidateToken, SESSION_DURATION } from './services/sessionManager.js';
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

async function handlePowerStatusUpdate(req, res) {
    try {
        const rawState = req.body?.is_on ?? req.body?.isOn ?? req.body?.status ?? req.body?.state;
        const source = req.body?.source || 'tasker_direct';
        const booking_id = req.body?.booking_id ?? source;
        const rawBattery = req.body?.battery;
        const prevState = global.powerState.is_on;
        const timestamp = new Date();

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
        if (sql && prevState !== newState) {
            try {
                console.log(`[DB] 📝 Inserting: is_on=${newState}, source=${source}, battery=${batteryValue}, booking_id=${booking_id}`);
                await sql`
                    INSERT INTO power_history (is_on, source, timestamp, battery, booking_id)
                    VALUES (${newState}, ${source}, ${timestamp}, ${batteryValue}, ${booking_id})
                `;
                console.log(`[DB] ✅ Промяна записана: ${prevState ? 'ON' : 'OFF'} → ${newState ? 'ON' : 'OFF'}`);
            } catch (dbError) {
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
        } else if (sql && prevState === newState) {
            console.log(`[TASKER] ℹ️ Състоянието е същото (${newState ? 'ON' : 'OFF'}), без запис`);
        } else if (!sql) {
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
                note: prevState === newState ? 'Състояние без промяна' : 'Записано в power_history'
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

/**
 * POST /api/meter
 * 🔌 Управление на електромера от Tasker или админ панел
 * Очаква: { "action": "on" } или { "action": "off" }
 */
app.post('/api/meter', async (req, res) => {
    try {
        const { action } = req.body;

        // Валидирай action параметъра
        if (action !== 'on' && action !== 'off') {
            return res.status(400).json({ error: 'Невалидна действие. Очаква: "on" или "off"' });
        }

        // Преведи action към команда
        const command = action === 'on' ? 'meter_on' : 'meter_off';
        const willTurnOn = action === 'on';
        const timestamp = new Date();

        console.log(`[METER API] 🎛️  Управление на ток: ${action.toUpperCase()}`);

        // 1. ЗАПИС В БД ПРЕДИ ПРАЩА КЪМ TASKER
        if (sql) {
            try {
                await sql`
                    INSERT INTO power_history (is_on, timestamp, source, booking_id)
                    VALUES (${willTurnOn}, ${timestamp}, 'api_meter', 'api_meter')
                `;
                console.log('[DB] ✅ API команда записана в power_history');
            } catch (dbErr) {
                console.error('[DB] 🔴 Грешка при запис API meter:', dbErr.message);
            }
        }

        // 2. ПРАЩА КЪМ TASKER
        const success = await controlPower(willTurnOn);

        if (success) {
            res.status(200).json({ 
                success: true, 
                message: `Команда "${command}" изпратена към телефона`,
                action: action 
            });
        } else {
            res.status(500).json({ 
                success: false, 
                error: 'Неуспешна връзка с AutoRemote' 
            });
        }
    } catch (error) {
        console.error('[METER API] 🔴 Грешка:', error.message);
        res.status(500).json({ error: error.message });
    }
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
// CRON SCHEDULER - Всеки 10 минути
// ============================================================================

function initializeScheduler() {
    if (!sql) {
        console.warn('[SCHEDULER] ⚠️ Липсват зависимости - Scheduler е ИЗКЛЮЧЕН');
        return;
    }

    cron.schedule('*/10 * * * *', async () => {
        try {
            console.log(`[SCHEDULER] ⏰ ${new Date().toISOString()}`);
            const now = new Date();
            const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
            const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000);

            // 🔌 CHECK-IN: Ток за гост за 2 часа
            const checkinBookings = await sql`
                SELECT id, guest_name FROM bookings 
                WHERE check_in <= ${twoHoursFromNow} AND check_in >= ${now} AND check_out > ${now}
                LIMIT 10
            `;
            for (const booking of checkinBookings) {
                if (!global.powerState.is_on) {
                    console.log(`[SCHEDULER] 🚨 CHECK-IN за ${booking.guest_name} - ВКЛ`);
                    
                    // 1. ЗАПИС В БД ПРЕДИ ПРАЩА КЪМ TASKER
                    try {
                        await sql`
                            INSERT INTO power_history (is_on, timestamp, source, booking_id)
                            VALUES (true, ${now}, 'scheduler_checkin', 'scheduler_checkin')
                        `;
                        console.log('[DB] ✅ Check-in включване записано');
                    } catch (dbErr) {
                        console.error('[DB] 🔴 Грешка при запис scheduler check-in:', dbErr.message);
                    }
                    
                    global.powerState.is_on = true;
                    global.powerState.source = 'scheduler-checkin';

                    // Обнови bookings.power_status за тази резервация
                    try {
                        await sql`
                            UPDATE bookings
                            SET power_status = 'on',
                                power_status_updated_at = ${now}
                            WHERE id = ${booking.id}
                        `;
                    } catch (bookingErr) {
                        console.error('[DB] 🔴 Грешка при scheduler check-in power_status:', bookingErr.message);
                    }
                    
                    // 2. ПРАЩА КЪМ TASKER
                    await controlPower(true); // Праща команда към Tasker через AutoRemote
                }
            }

            // 🔌 CHECK-OUT: Выключи ток 1 час след check-out
            const checkoutBookings = await sql`
                SELECT id, guest_name FROM bookings 
                WHERE check_out <= ${now} AND check_out >= ${oneHourAgo}
                LIMIT 10
            `;
            for (const booking of checkoutBookings) {
                if (global.powerState.is_on) {
                    console.log(`[SCHEDULER] 🚨 CHECK-OUT ${booking.guest_name} - ИЗКЛ`);
                    
                    // 1. ЗАПИС В БД ПРЕДИ ПРАЩА КЪМ TASKER
                    try {
                        await sql`
                            INSERT INTO power_history (is_on, timestamp, source, booking_id)
                            VALUES (false, ${now}, 'scheduler_checkout', 'scheduler_checkout')
                        `;
                        console.log('[DB] ✅ Check-out изключване записано');
                    } catch (dbErr) {
                        console.error('[DB] 🔴 Грешка при запис scheduler check-out:', dbErr.message);
                    }
                    
                    global.powerState.is_on = false;
                    global.powerState.source = 'scheduler-checkout';

                    // Обнови bookings.power_status за тази резервация
                    try {
                        await sql`
                            UPDATE bookings
                            SET power_status = 'off',
                                power_status_updated_at = ${now}
                            WHERE id = ${booking.id}
                        `;
                    } catch (bookingErr) {
                        console.error('[DB] 🔴 Грешка при scheduler check-out power_status:', bookingErr.message);
                    }
                    
                    // 2. ПРАЩА КЪМ TASKER
                    await controlPower(false); // Праща команда към Tasker през AutoRemote
                }
            }
        } catch (error) {
            console.error('[SCHEDULER] 🔴 Грешка:', error.message);
        }
    });
    console.log('[SCHEDULER] ✅ Cron job е активен (всеки 10 минути)');
}

function initializeDetectiveScheduler() {
    console.log('[DETECTIVE] ✅ Gmail sync cron е активен (всеки 15 минути)');

    setTimeout(async () => {
        try {
            console.log('[DETECTIVE] 🚀 Начален sync...');
            await syncBookingsFromGmail();
        } catch (error) {
            console.error('[DETECTIVE] 🔴 Начален sync грешка:', error.message);
        }
    }, 5000);

    cron.schedule('*/15 * * * *', async () => {
        try {
            await syncBookingsFromGmail();
        } catch (error) {
            console.error('[DETECTIVE] 🔴 Cron sync грешка:', error.message);
        }
    });
}

// ============================================================================
// СТАРТИРАНЕ НА СЪРВЪРА
// ============================================================================

app.listen(PORT, async () => {
    console.log('\n🚀 SMART-STAY LEAN CONTROLLER STARTED');
    console.log(`   🌐 http://localhost:${PORT}`);
    // console.log(`   📤 Telegram: ${TELEGRAM_BOT_TOKEN ? '✅' : '⚠️'}`);
    console.log(`   🗄️  Database: ${sql ? '✅' : '⚠️'}`);
    console.log(`   📅 Scheduler: Инициализиране...\n`);
    
    // Инициализирай базата и съедини power_history таблица
    await initializeDatabase();
    
    initializeScheduler();
    initializeDetectiveScheduler();

    // Периодично почистване на изтекли сесии
    setInterval(cleanupExpiredTokens, 5 * 60 * 1000);
    console.log('[SESSION] ✅ Периодичното почистване на токени е активно (на всеки 5 минути)');
});