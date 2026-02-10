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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 10000;

// ============================================================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================================================

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
// === ТЕЛЕГРАМ (Закомментирано за по-нататък) ===
// const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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
// /**
//  * 📤 Изпраща команда към Telegram бот
//  * @async
//  * @param {string} command - 'ВКЛ' или 'ИЗКЛ'
//  * @returns {Promise<boolean>} True ако успешно
//  */
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
 * POST /api/chat
 * 📝 Мост към AI асистент - само преминава данни към getAIResponse()
 */
app.post('/api/chat', async (req, res) => {
    try {
        const { message, history = [], authCode } = req.body;
        if (!message?.trim()) {
            return res.status(400).json({ error: 'Съобщението е празно' });
        }
        console.log('[CHAT] 🤖 Викам AI асистент...');
        const aiResponse = await getAIResponse(message, history, authCode);
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
// /**
//  * POST /api/power-control
//  * 🔌 Управление ток + Telegram команда
//  */
// app.post('/api/power-control', async (req, res) => {
//     try {
//         const { state } = req.body;
//         if (typeof state !== 'boolean') {
//             return res.status(400).json({ error: 'State е boolean' });
//         }
//         global.powerState.is_on = state;
//         global.powerState.last_update = new Date();
//         global.powerState.source = 'api';
//         
//         const command = state ? 'ВКЛ' : 'ИЗКЛ';
//         const telegramSuccess = await sendTelegramCommand(command);
//         console.log(`[POWER] 🔌 ${state ? 'ВКЛЮЧЕН' : 'ИЗКЛЮЧЕН'}`);
//         res.json({ success: true, state, telegramSent: telegramSuccess });
//     } catch (error) {
//         console.error('[POWER] 🔴 Грешка:', error.message);
//         res.status(500).json({ error: 'Power error' });
//     }
// });
*/

/**
 * POST /api/power/status
 * 📱 Tasker интеграция - обновление статус + Tasker данни (status, device, battery)
 * Приема и батерия като число или Tasker переменна (например %BATT)
 */
app.post('/api/power/status', async (req, res) => {
    try {
        // Събери данни от Tasker
        let { is_on, booking_id, status, device, battery } = req.body;
        const prevState = global.powerState.is_on;
        const timestamp = new Date();
        
        // Валидирай и преобразувай battery (ако е строка като "%BATT", остави null)
        let batteryValue = null;
        if (battery && typeof battery === 'string') {
            const parsed = parseInt(battery, 10);
            batteryValue = isNaN(parsed) ? null : parsed; // Ако е "%BATT" или невалидно, стави null
        } else if (typeof battery === 'number') {
            batteryValue = battery;
        }
        
        // Обновяване на глобално състояние
        global.powerState.is_on = !!is_on;
        global.powerState.last_update = timestamp;
        global.powerState.source = 'tasker';
        
        console.log(`[TASKER] 📱 Статус: ${is_on ? 'ON' : 'OFF'} (от ${prevState ? 'ON' : 'OFF'})`);
        if (status) console.log(`[TASKER] 📊 Status: ${status}`);
        if (device) console.log(`[TASKER] 📱 Device: ${device}`);
        if (batteryValue !== null) console.log(`[TASKER] 🔋 Battery: ${batteryValue}%`);
        if (battery && batteryValue === null && battery.toString().startsWith('%')) {
            console.log(`[TASKER] ⚠️ Battery е Tasker переменна: ${battery}`);
        }
        
        // Логване в база данни ако има промяна на състоянието
        if (sql && prevState !== is_on) {
            try {
                await sql`
                    INSERT INTO power_history (is_on, status, device, battery, source, timestamp, booking_id)
                    VALUES (${is_on}, ${status || null}, ${device || null}, ${batteryValue}, 'tasker', ${timestamp}, ${booking_id || null})
                `;
                console.log('[DB] ✅ power_history записан със Tasker данни');
            } catch (dbError) {
                console.error('[DB] 🔴 Грешка при логване:', dbError.message);
            }
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'Статус получен и обработен',
            received: { 
                is_on, 
                status, 
                device, 
                battery: batteryValue || battery, // Покажи оригинално ако е переменна
                stateChanged: prevState !== is_on 
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

        console.log(`[METER API] 🎛️  Управление на ток: ${action.toUpperCase()}`);

        // Изпрати команда към Tasker через AutoRemote
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
                booking_id,
                created_at
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
    if (!sql || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
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
                    global.powerState.is_on = true;
                    global.powerState.source = 'scheduler-checkin';
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
                    global.powerState.is_on = false;
                    global.powerState.source = 'scheduler-checkout';
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
    console.log(`   📤 Telegram: ${TELEGRAM_BOT_TOKEN ? '✅' : '⚠️'}`);
    console.log(`   🗄️  Database: ${sql ? '✅' : '⚠️'}`);
    console.log(`   📅 Scheduler: Инициализиране...\n`);
    
    // Инициализирай базата и съедини power_history таблица
    await initializeDatabase();
    
    initializeScheduler();
});