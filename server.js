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
import { getAIResponse } from './services/ai_service.js';
import { controlPower } from './services/autoremote.js';
import { generateToken, validateToken, cleanupExpiredTokens, invalidateToken, SESSION_DURATION } from './services/sessionManager.js';

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
        // Създай таблица ако не съществува
        await sql`
            CREATE TABLE IF NOT EXISTS power_history (
                id SERIAL PRIMARY KEY,
                is_on BOOLEAN NOT NULL,
                status VARCHAR(50),
                device VARCHAR(100),
                battery INT,
                source VARCHAR(50),
                timestamp TIMESTAMPTZ DEFAULT NOW(),
                duration_seconds INT,
                booking_id INT REFERENCES bookings(id),
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `;
        
        // Добави нови колони ако не съществуват (для old databases)
        try {
            await sql`ALTER TABLE power_history ADD COLUMN status VARCHAR(50);`;
        } catch (e) { /* колона вече съществува */ }
        
        try {
            await sql`ALTER TABLE power_history ADD COLUMN device VARCHAR(100);`;
        } catch (e) { /* колона вече съществува */ }
        
        try {
            await sql`ALTER TABLE power_history ADD COLUMN battery INT;`;
        } catch (e) { /* колона вече съществува */ }
        
        await sql`CREATE INDEX IF NOT EXISTS idx_power_history_timestamp ON power_history(timestamp DESC);`;
        console.log('[DB] ✅ power_history таблица готова (със Tasker данни)');
        
        // 🆕 ИНИЦИАЛЕН ЗАПИС - Ако таблицата е един има писък, направи запис за текущото состояние
        try {
            const countResult = await sql`SELECT COUNT(*) as cnt FROM power_history;`;
            console.log('[DB] 🔍 COUNT result:', JSON.stringify(countResult));
            
            const recordCount = Number(countResult[0].cnt) || 0;
            console.log('[DB] 🔍 recordCount:', recordCount, 'type:', typeof recordCount);
            
            if (recordCount === 0) {
                console.log('[DB] 📝 Таблица е ПРАЗНА - правя инициален запис...');
                const insertResult = await sql`
                    INSERT INTO power_history (is_on, source, timestamp, booking_id)
                    VALUES (${global.powerState.is_on}, 'system_startup', NOW(), NULL)
                `;
                console.log(`[DB] ✅ Инициален запис създаден: is_on=${global.powerState.is_on}`);
            } else {
                console.log(`[DB] ℹ️ Таблица има ${recordCount} записа - без инициален запис`);
            }
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

// POST /api/power/status
// 📱 Tasker интеграция - обновление статус когато има ПРОМЯНА
// 🛡️ ЛОГИКА: Записва в power_history САМО ако состоянието е променено
app.post('/api/power/status', async (req, res) => {
    try {
        const { is_on, source, booking_id } = req.body;
        const prevState = global.powerState.is_on;
        const timestamp = new Date();
        
        // 1. ЛОГВАНЕ НА ВХОДЯЩИ ДАННИ
        console.log(`[TASKER] 📨 Получени данни:`, JSON.stringify(req.body));
        console.log(`[TASKER] 📊 prevState=${prevState}, newState=${is_on}, changed=${prevState !== is_on}`);

        // 2. ВАЛИДИРАНЕ НА STATE (преобразуване в boolean)
        const newState = Boolean(is_on);

        console.log(`[TASKER] 📊 State: ${newState ? 'ON' : 'OFF'} (беше ${prevState ? 'ON' : 'OFF'})`);
        console.log(`[TASKER] 🔍 sql available: ${sql ? '✅ YES' : '❌ NO'}`);
        
        // 3. ОБНОВЯВАНЕ НА ГЛОБАЛНО СЪСТОЯНИЕ (винаги)
        global.powerState.is_on = newState;
        global.powerState.last_update = timestamp;
        global.powerState.source = source || 'tasker_direct';
        
        // 4. ЗАПИС В БАЗА ДАННИ (САМО ако има промяна)
        if (sql && prevState !== newState) {
            try {
                console.log(`[DB] 📝 Inserting: is_on=${newState}, source=${source || 'tasker_direct'}, booking_id=${booking_id || null}`);
                await sql`
                    INSERT INTO power_history (is_on, source, timestamp, booking_id)
                    VALUES (${newState}, ${source || 'tasker_direct'}, ${timestamp}, ${booking_id || null})
                `;
                console.log(`[DB] ✅ Промяна записана: ${prevState ? 'ON' : 'OFF'} → ${newState ? 'ON' : 'OFF'}`);
            } catch (dbError) {
                console.error('[DB] 🔴 Грешка при логване:', dbError.message);
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
                source: source || 'tasker_direct',
                booking_id,
                stateChanged: prevState !== newState,
                note: prevState === newState ? 'Състояние без промяна' : 'Записано в power_history'
            }
        });
    } catch (error) {
        console.error('[TASKER] 🔴 Грешка:', error.message);
        res.status(500).json({ error: error.message });
    }
});

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
                    INSERT INTO power_history (is_on, timestamp, source)
                    VALUES (${willTurnOn}, ${timestamp}, 'api_meter')
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
                            VALUES (true, ${now}, 'scheduler_checkin', ${booking.id})
                        `;
                        console.log('[DB] ✅ Check-in включване записано');
                    } catch (dbErr) {
                        console.error('[DB] 🔴 Грешка при запис scheduler check-in:', dbErr.message);
                    }
                    
                    global.powerState.is_on = true;
                    global.powerState.source = 'scheduler-checkin';
                    
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
                            VALUES (false, ${now}, 'scheduler_checkout', ${booking.id})
                        `;
                        console.log('[DB] ✅ Check-out изключване записано');
                    } catch (dbErr) {
                        console.error('[DB] 🔴 Грешка при запис scheduler check-out:', dbErr.message);
                    }
                    
                    global.powerState.is_on = false;
                    global.powerState.source = 'scheduler-checkout';
                    
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

    // Периодично почистване на изтекли сесии
    setInterval(cleanupExpiredTokens, 5 * 60 * 1000);
    console.log('[SESSION] ✅ Периодичното почистване на токени е активно (на всеки 5 минути)');
});