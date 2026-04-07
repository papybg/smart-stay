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
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { neon } from '@neondatabase/serverless';
import { getAIResponse, assignPinFromDepot } from './services/ai_service.js';
import { controlPower, controlMeterByAction } from './services/autoremote.js';
import { generateToken, invalidateToken, validateToken, SESSION_DURATION } from './services/sessionManager.js';
import { syncBookingsFromGmail, syncBookingsPowerFromLatestHistory } from './services/detective.js';
import { createApiKeyGuard, createSimpleRateLimiter } from './middlewares/security.js';
import { registerPowerRoutes } from './routes/powerRoutes.js';
import { registerAuthRoutes, registerSmartThingsCallbackRoute } from './routes/authRoutes.js';
import { registerBookingsRoutes } from './routes/bookingsRoutes.js';
import { registerAdminRoutes } from './routes/adminRoutes.js';
import { registerSystemRoutes } from './routes/systemRoutes.js';
import { createNotificationService } from './services/notifications/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
// behind Render’s proxy; ensures rate limiter sees real IP
app.set('trust proxy', 1);

function parseCsvEnv(value) {
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function normalizeHost(value) {
    return String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function getIncomingHost(req) {
    const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim().toLowerCase();
    const direct = String(req.headers.host || '').split(':')[0].trim().toLowerCase();
    return (forwarded || direct).replace(/\.$/, '');
}

function parseHostPageMap(value) {
    const map = new Map();
    for (const pair of parseCsvEnv(value)) {
        const [hostRaw, pageRaw] = pair.split('=');
        const host = normalizeHost(hostRaw);
        const page = String(pageRaw || '').trim();
        if (!host || !page) continue;
        map.set(host, page);
    }
    return map;
}

function parseHostRedirects(value) {
    const map = new Map();
    for (const pair of parseCsvEnv(value)) {
        const [fromRaw, toRaw] = pair.split('=');
        const from = normalizeHost(fromRaw);
        const to = normalizeHost(toRaw);
        if (!from || !to) continue;
        map.set(from, to);
    }
    return map;
}

const defaultAllowedOrigins = [
    'https://stay.bgm-design.com',
    'https://demo.bgm-design.com',
    'https://admin.bgm-design.com',
    'https://reservation.bgm-design.com',
    'https://www.reservation.bgm-design.com',
    'https://smart-stay.onrender.com',
    'http://localhost:3000'
];
const allowedOrigins = new Set([
    ...defaultAllowedOrigins,
    ...parseCsvEnv(process.env.CORS_ALLOWED_ORIGINS)
]);
const allowedOriginHostSuffixes = parseCsvEnv(process.env.CORS_ALLOWED_ORIGIN_SUFFIXES || '.bgm-design.com');

function isAllowedOrigin(origin) {
    if (!origin) return true;
    if (allowedOrigins.has(origin)) return true;
    try {
        const url = new URL(origin);
        const host = normalizeHost(url.hostname);
        return allowedOriginHostSuffixes.some(suffix => host.endsWith(normalizeHost(suffix)));
    } catch {
        return false;
    }
}

// CORS – трябва да е ПРЕДИ всичко друго
app.use(cors({
    origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) return callback(null, true);
        return callback(new Error('CORS origin denied'));
    }
}));

const hostPageMap = new Map([
    ['stay.bgm-design.com', 'agent.html'],
    ['reservation.bgm-design.com', 'reservation.html'],
    ['www.reservation.bgm-design.com', 'reservation.html'],
    ['demo.bgm-design.com', 'dashboard-demo.html'],
    ['admin.bgm-design.com', 'dashboard.html']
]);
for (const [host, page] of parseHostPageMap(process.env.SAAS_HOST_PAGE_MAP)) {
    hostPageMap.set(host, page);
}

const canonicalHostRedirects = new Map();
for (const [host, target] of parseHostRedirects(process.env.SAAS_CANONICAL_HOST_REDIRECTS)) {
    canonicalHostRedirects.set(host, target);
}

function resolvePublicApiUrl(req) {
    const envUrl = String(process.env.PUBLIC_API_URL || '').trim();
    if (envUrl) return envUrl.replace(/\/$/, '');
    const host = getIncomingHost(req);
    if (!host) return '';
    const proto = req.protocol || 'https';
    return `${proto}://${host}`;
}

function getRuntimeConfigScript(req) {
    const script = {
        __SMART_STAY_API_URL: resolvePublicApiUrl(req),
        __SMART_STAY_PUBLIC_HOST: getIncomingHost(req)
    };
    return `<script>Object.assign(window, ${JSON.stringify(script)});</script>`;
}

async function serveHtmlWithRuntimeConfig(req, res, fileName, options = {}) {
    try {
        const filePath = path.join(__dirname, 'public', fileName);
        let html = await fs.promises.readFile(filePath, 'utf-8');
        if (options.injectDashboardKey) {
            html = html.replace(/YOUR_KEY_HERE/g, process.env.DASHBOARD_API_KEY || '');
        }
        const runtimeScript = getRuntimeConfigScript(req);
        if (html.includes('</head>')) {
            html = html.replace('</head>', `${runtimeScript}</head>`);
        } else {
            html = runtimeScript + html;
        }
        res.send(html);
    } catch (err) {
        console.error(`[SERVER] 🔴 Error serving ${fileName}:`, err.message);
        res.status(500).send('Server error');
    }
}

const PORT = process.env.PORT || 10000;
const TASKER_NOISE_WINDOW_MS = Number(process.env.TASKER_NOISE_WINDOW_MS || 45000);
const REQUEST_LOG_SUPPRESS_MS = Number(process.env.REQUEST_LOG_SUPPRESS_MS || 30000);
let lastPowerStatusRequestLogTs = 0;
const recentTaskerStatusBySource = new Map();

// === rate limiters ===
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Твърде много заявки, опитай по-късно' }
});

const powerLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Твърде много команди за ток' }
});

const emailLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Синхронизацията е ограничена' }
});

// apply general limiter to all /api routes
app.use('/api', generalLimiter);
// apply stricter rules
app.use(['/api/meter', '/api/meter/on', '/api/meter/off'], powerLimiter);
app.use(['/api/gmail/sync', '/api/email/sync'], emailLimiter);

// === API key guard for dashboard ===
const dashboardApiKey = process.env.DASHBOARD_API_KEY || '';
function dashboardKeyGuard(req, res, next) {
    // skip certain public endpoints (middleware mounted at /api, so urls start after it)
    const open = ['/login', '/logout', '/power-status', '/chat', '/inquiry', '/pricing/quote', '/bookings/unavailable-ranges'];
    if (req.url.startsWith('/api/guest/') || open.some(p => req.url.startsWith(p))) {
        return next();
    }
    const authHeader = String(req.headers['authorization'] || '').trim();
    if (authHeader.toLowerCase().startsWith('bearer ')) {
        const candidateToken = authHeader.substring(7).trim();
        const session = validateToken(candidateToken);
        if (session && session.valid) {
            return next();
        }
    }

    const key = req.headers['x-api-key'];
    if (key && key === dashboardApiKey) return next();

    if (req.url.startsWith('/meter')) {
        const meterIncoming = req.headers['x-meter-api-key'] || req.headers['x-api-key'];
        const expectedMeterKey = process.env.METER_API_KEY || '';
        if (expectedMeterKey && meterIncoming && String(meterIncoming).trim() === expectedMeterKey) {
            return next();
        }
    }

    return res.status(401).json({ error: 'Неоторизиран достъп' });
}
app.use('/api', dashboardKeyGuard);


// ============================================================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================================================
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const notificationService = createNotificationService({ sql });
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
        // колона за момента, в който е назначен PIN/lock_code
        try {
            await sql`ALTER TABLE bookings ADD COLUMN pin_assigned_at TIMESTAMPTZ;`;
        } catch (e) { /* колона вече съществува */ }
        try {
            await sql`ALTER TABLE bookings ADD COLUMN total_price NUMERIC(12,2);`;
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

        // Requests таблица за уеб заявки (преди финална резервация)
        await sql`
            CREATE TABLE IF NOT EXISTS "Requests" (
                id SERIAL PRIMARY KEY,
                request_code VARCHAR(50) UNIQUE NOT NULL,
                guest_name VARCHAR(100) NOT NULL,
                guest_email VARCHAR(255) NOT NULL,
                guest_phone VARCHAR(50),
                guest_telegram_chat_id VARCHAR(100),
                check_in TIMESTAMPTZ NOT NULL,
                check_out TIMESTAMPTZ NOT NULL,
                guests_count INT,
                with_pet BOOLEAN DEFAULT FALSE,
                message TEXT,
                status VARCHAR(20) DEFAULT 'pending',
                payment_status VARCHAR(20) DEFAULT 'pending',
                payment_received_at TIMESTAMPTZ,
                quoted_total NUMERIC(12,2),
                source VARCHAR(20) DEFAULT 'direct',
                converted_booking_id INT,
                converted_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        `;
        await sql`ALTER TABLE "Requests" ADD COLUMN IF NOT EXISTS payment_received_at TIMESTAMPTZ;`;
        await sql`ALTER TABLE "Requests" ADD COLUMN IF NOT EXISTS with_pet BOOLEAN DEFAULT FALSE;`;
        await sql`ALTER TABLE "Requests" ADD COLUMN IF NOT EXISTS quoted_total NUMERIC(12,2);`;
        await sql`ALTER TABLE "Requests" ADD COLUMN IF NOT EXISTS guest_telegram_chat_id VARCHAR(100);`;
        await sql`CREATE INDEX IF NOT EXISTS idx_requests_status_created_at ON "Requests"(status, created_at DESC);`;
        await sql`CREATE INDEX IF NOT EXISTS idx_requests_checkin_checkout ON "Requests"(check_in, check_out);`;

        // notification log таблица за retries/success/failure история
        await sql`
            CREATE TABLE IF NOT EXISTS notification_log (
                id SERIAL PRIMARY KEY,
                event_key VARCHAR(255),
                event_type VARCHAR(50) NOT NULL,
                channel VARCHAR(30) NOT NULL,
                recipient VARCHAR(255) NOT NULL,
                status VARCHAR(20) NOT NULL,
                attempt INT NOT NULL DEFAULT 1,
                error_message TEXT,
                payload JSONB,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `;
        await sql`ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS event_key VARCHAR(255);`;
        await sql`CREATE INDEX IF NOT EXISTS idx_notification_log_event_key ON notification_log(event_key);`;
        await sql`CREATE INDEX IF NOT EXISTS idx_notification_log_created_at ON notification_log(created_at DESC);`;
        await sql`CREATE INDEX IF NOT EXISTS idx_notification_log_event_status ON notification_log(event_type, status);`;
        await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_notification_sent_event_key ON notification_log(event_key) WHERE status = 'sent' AND event_key IS NOT NULL;`;

        // Pricing таблица за ценообразуване на заявки
        await sql`
            CREATE TABLE IF NOT EXISTS "Pricing" (
                id SERIAL PRIMARY KEY,
                night_price NUMERIC(12,2) NOT NULL,
                weekend_night_price NUMERIC(12,2) NOT NULL,
                weekly_discount_percent NUMERIC(5,2) DEFAULT 0,
                monthly_discount_percent NUMERIC(5,2) DEFAULT 0,
                pet_surcharge_once NUMERIC(12,2) DEFAULT 0,
                currency VARCHAR(10) DEFAULT 'BGN',
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        `;

        const pricingCount = await sql`SELECT COUNT(*)::INT AS cnt FROM "Pricing"`;
        if ((pricingCount?.[0]?.cnt || 0) === 0) {
            await sql`
                INSERT INTO "Pricing" (
                    night_price,
                    weekend_night_price,
                    weekly_discount_percent,
                    monthly_discount_percent,
                    pet_surcharge_once,
                    currency,
                    is_active
                ) VALUES (
                    120,
                    150,
                    10,
                    20,
                    40,
                    'BGN',
                    TRUE
                )
            `;
        }

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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const chatRateLimiter = createSimpleRateLimiter({ windowMs: 60_000, maxRequests: 25, methods: ['POST'] });
const meterRateLimiter = createSimpleRateLimiter({ windowMs: 60_000, maxRequests: 20, methods: ['POST'] });
const powerStatusRateLimiter = createSimpleRateLimiter({ windowMs: 60_000, maxRequests: 60, methods: ['POST'] });

const meterCommandGuard = (req, res, next) => {
    if (req.method.toUpperCase() !== 'POST') return next();

    const incoming = String(
        req.headers['x-meter-api-key']
        || req.headers['x-api-key']
        || req.body?.apiKey
        || req.query?.apiKey
        || ''
    ).trim();

    const meterKey = String(process.env.METER_API_KEY || '').trim();
    const dashKey = String(process.env.DASHBOARD_API_KEY || '').trim();

    if (!incoming) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if ((meterKey && incoming === meterKey) || (dashKey && incoming === dashKey)) {
        return next();
    }

    return res.status(401).json({ error: 'Unauthorized' });
};

const taskerFeedbackGuard = createApiKeyGuard({
    envVar: 'TASKER_STATUS_API_KEY',
    headerName: 'x-tasker-api-key',
    optional: true,
    methods: ['POST']
});

app.use('/api/chat', chatRateLimiter);
app.use(['/api/meter', '/api/meter/on', '/api/meter/off'], meterCommandGuard, meterRateLimiter);
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

// serve dashboard with runtime config and key injection
app.get('/dashboard.html', async (req, res) => {
    return serveHtmlWithRuntimeConfig(req, res, 'dashboard.html', { injectDashboardKey: true });
});

app.get('/dashboard', (_req, res) => {
    return res.redirect(301, '/dashboard.html');
});

app.use((req, res, next) => {
    const host = getIncomingHost(req);
    const canonicalTargetHost = canonicalHostRedirects.get(host);
    if (canonicalTargetHost) {
        const target = `https://${canonicalTargetHost}${req.originalUrl || req.url}`;
        return res.redirect(301, target);
    }
    return next();
});

app.get('/', (req, res, next) => {
    const host = getIncomingHost(req);
    const targetPage = hostPageMap.get(host);
    if (targetPage === 'agent.html') {
        return serveHtmlWithRuntimeConfig(req, res, 'agent.html');
    }
    if (targetPage === 'dashboard.html') {
        return serveHtmlWithRuntimeConfig(req, res, 'dashboard.html', { injectDashboardKey: true });
    }
    if (targetPage) {
        return serveHtmlWithRuntimeConfig(req, res, targetPage);
    }
    return next();
});

app.get('/agent.html', (req, res) => {
    return serveHtmlWithRuntimeConfig(req, res, 'agent.html');
});

app.get('/reservation.html', (req, res) => {
    return serveHtmlWithRuntimeConfig(req, res, 'reservation.html');
});

app.get('/test.html', (req, res) => {
    return serveHtmlWithRuntimeConfig(req, res, 'test-page.html');
});

app.get('/aspen-valley-retreat.html', (_req, res) => {
    return res.redirect(301, '/reservation.html');
});

// static middleware for other assets
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

app.get('/health', (_req, res) => {
    res.json({ name: 'Smart Stay', status: 'operational', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
    return serveHtmlWithRuntimeConfig(req, res, 'agent.html');
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
    syncBookingsFromGmail,
    notificationService
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
//   POST /api/gmail/sync        (на всеки 15 мин)
//
// Ако за някаква причина няма да конфигурирате Render cron,
// има резервен вътрешен scheduler по‑долу. Той изпълнява
// syncBookingsFromGmail() на всеки 2 часа и може да се активира
// със среда USE_LOCAL_CRON=true (или по подразбиране при dev).

function initializeDetectiveScheduler() {
    const interval = 2 * 60 * 60 * 1000; // 2 часа
    console.log('[SCHEDULER] 🕵️ Детективът ще проверява имейли на всеки 2h (локален cron)');
    // run immediately once
    syncBookingsFromGmail().catch(err => console.error('[SCHEDULER] 🔴', err.message));
    setInterval(() => {
        console.log('[SCHEDULER] ⏰ Локален cron задейства email sync');
        syncBookingsFromGmail().catch(err => console.error('[SCHEDULER] 🔴', err.message));
    }, interval);
}

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
    // Локален detective scheduler (работи в dev или когато явно е поискан):
    if (process.env.USE_LOCAL_CRON === 'true' || !process.env.RENDER) {
        initializeDetectiveScheduler();
    }

    // ❌ ИЗКЛЮЧЕНО: setInterval за cleanupExpiredTokens
    // console.log('[SESSION] ✅ Периодичното почистване на токени е активно (на всеки 5 минути)');
    console.log('[SESSION] ℹ️ Token cleanup сега е ON-DEMAND (извиква се при заявки за вход)');
});