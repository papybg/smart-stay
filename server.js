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
import { generateToken, invalidateToken, SESSION_DURATION } from './services/sessionManager.js';
import { syncBookingsFromGmail, syncBookingsPowerFromLatestHistory } from './services/detective.js';
import { createApiKeyGuard, createSimpleRateLimiter } from './middlewares/security.js';
import { registerPowerRoutes } from './routes/powerRoutes.js';
import { registerAuthRoutes, registerSmartThingsCallbackRoute } from './routes/authRoutes.js';
import { registerBookingsRoutes } from './routes/bookingsRoutes.js';
import { registerAdminRoutes } from './routes/adminRoutes.js';
import { registerSystemRoutes } from './routes/systemRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 10000;
const TASKER_NOISE_WINDOW_MS = Number(process.env.TASKER_NOISE_WINDOW_MS || 45000);
const REQUEST_LOG_SUPPRESS_MS = Number(process.env.REQUEST_LOG_SUPPRESS_MS || 30000);
let lastPowerStatusRequestLogTs = 0;
const recentTaskerStatusBySource = new Map();

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

const chatRateLimiter = createSimpleRateLimiter({ windowMs: 60_000, maxRequests: 25, methods: ['POST'] });
const meterRateLimiter = createSimpleRateLimiter({ windowMs: 60_000, maxRequests: 20, methods: ['POST'] });
const powerStatusRateLimiter = createSimpleRateLimiter({ windowMs: 60_000, maxRequests: 60, methods: ['POST'] });

const meterApiKeyGuard = createApiKeyGuard({
    envVar: 'METER_API_KEY',
    headerName: 'x-meter-api-key',
    methods: ['POST']
});

const taskerFeedbackGuard = createApiKeyGuard({
    envVar: 'TASKER_STATUS_API_KEY',
    headerName: 'x-tasker-api-key',
    optional: true,
    methods: ['POST']
});

app.use('/api/chat', chatRateLimiter);
app.use(['/api/meter', '/api/meter/on', '/api/meter/off'], meterApiKeyGuard, meterRateLimiter);
app.use(['/api/power/status', '/api/power-status'], taskerFeedbackGuard, powerStatusRateLimiter);

/**
 * 📊 REQUEST ЛОГВАНЕ - Timestamp + Method + URL + IP + Payload Size
 * Помага за дебъг и мониторинг на сървъра
 */
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    const method = req.method.padEnd(6);
    const ip = req.ip || req.connection.remoteAddress || 'UNKNOWN';
    const payloadSize = req.body ? JSON.stringify(req.body).length : 0;

    const ua = req.headers['user-agent'] || '-';
    const isTaskerStatusRoute = req.url.startsWith('/api/power-status') || req.url.startsWith('/api/power/status');
    if (isTaskerStatusRoute) {
        const now = Date.now();
        if (now - lastPowerStatusRequestLogTs < REQUEST_LOG_SUPPRESS_MS) {
            return next();
        }
        lastPowerStatusRequestLogTs = now;
        console.log(`[${timestamp}] 📨 ${method} ${req.url.padEnd(25)} | IP: ${ip.padEnd(15)} | UA: ${String(ua).slice(0,60).padEnd(60)} | Payload: ${payloadSize} B | throttled`);
        return next();
    }

    console.log(`[${timestamp}] 📨 ${method} ${req.url.padEnd(25)} | IP: ${ip.padEnd(15)} | UA: ${String(ua).slice(0,60).padEnd(60)} | Payload: ${payloadSize} B`);
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

async function handleSmartThingsLifecycle(req, res) {
    try {
        const lifecycle = String(req.body?.lifecycle || '').toUpperCase();
        const confirmationUrl = req.body?.confirmationData?.confirmationUrl;

        if (lifecycle === 'CONFIRMATION') {
            if (!confirmationUrl) {
                console.error('[SMARTTHINGS] ❌ CONFIRMATION без confirmationUrl');
                return res.status(400).json({ error: 'Missing confirmationUrl' });
            }

            console.log('[SMARTTHINGS] 🔐 CONFIRMATION получен, потвърждавам webhook...');
            const confirmResponse = await fetch(confirmationUrl, { method: 'GET' });

            if (!confirmResponse.ok) {
                const responseText = await confirmResponse.text().catch(() => '');
                console.error(`[SMARTTHINGS] ❌ confirmationUrl върна ${confirmResponse.status}: ${responseText}`);
                return res.status(502).json({
                    error: 'Confirmation request failed',
                    status: confirmResponse.status
                });
            }

            console.log('[SMARTTHINGS] ✅ Webhook verification успешна');
            return res.status(200).json({
                success: true,
                lifecycle: 'CONFIRMATION',
                confirmed: true
            });
        }

        // За останали lifecycle event-и връщаме 200, за да избегнем retries.
        return res.status(200).json({
            success: true,
            lifecycle: lifecycle || 'UNKNOWN'
        });
    } catch (error) {
        console.error('[SMARTTHINGS] 🔴 Грешка при lifecycle обработка:', error.message);
        return res.status(500).json({ error: 'SmartThings lifecycle handler error' });
    }
}

app.post('/smartthings', handleSmartThingsLifecycle);
app.post('/', handleSmartThingsLifecycle);

registerAuthRoutes(app, {
    getAIResponse,
    generateToken,
    invalidateToken,
    sessionDuration: SESSION_DURATION
});

registerPowerRoutes(app, {
    sql,
    controlMeterByAction,
    syncBookingsPowerFromLatestHistory,
    taskerNoiseWindowMs: TASKER_NOISE_WINDOW_MS,
    recentTaskerStatusBySource
});

registerBookingsRoutes(app, {
    sql,
    assignPinFromDepot,
    controlPower,
    syncBookingsFromGmail
});

registerAdminRoutes(app, { sql });
registerSystemRoutes(app);
registerSmartThingsCallbackRoute(app);

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

