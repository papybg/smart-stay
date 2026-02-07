/**
 * ============================================================================
 * SMART-STAY HOME AUTOMATION EXPRESS SERVER
 * ============================================================================
 * 
 * Многофункционален Express сървър за управление на апартамент:
 * - Чат интеграция с AI асистент (Gemini)
 * - Управление на системата за тока с глобално синхронизирано състояние
 * - Интеграция с Tasker за мобилни устройства
 * - Детайлна система за логване на всички заявки
 * - Безопасни връзки към Neon PostgreSQL база данни
 * - Статични файлове за фронтенда
 * - TELEGRAM ИНТЕГРАЦИЯ за отправяне на команди на робот
 * - CRON SCHEDULER за автоматизирано включване/изключване на ток
 * 
 * Поддържани модули: AI Service, Power Control, Booking Management, Alert System, Telegram Bot, Scheduler
 * Създадено: февруари 2026
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

// ============================================================================
// ИНИЦИАЛИЗАЦИЯ НА АПЛИКАЦИЯТА
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 10000;

/**
 * @type {any} sql - Neon PostgreSQL клиент за база данни
 * Инициализира се от DATABASE_URL променлива на окръжение
 * Null ако няма конфигуриран DATABASE_URL
 */
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

/**
 * @type {string} TELEGRAM_BOT_TOKEN - Токен за Telegram бот
 * Получава се от environment variable TELEGRAM_BOT_TOKEN
 */
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

/**
 * @type {string} TELEGRAM_CHAT_ID - ID на Telegram чата за команди
 * Получава се от environment variable TELEGRAM_CHAT_ID
 */
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!sql) {
    console.warn('⚠️ [DATABASE] DATABASE_URL не е зададена - база данни е недостъпна');
} else {
    console.log('✅ [DATABASE] Neon PostgreSQL клиент инициализиран успешно');
}

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('⚠️ [TELEGRAM] TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не са зададени');
} else {
    console.log('✅ [TELEGRAM] Telegram бот интеграция активна');
}

// ============================================================================
// ГЛОБАЛНО СЪСТОЯНИЕ НА СИСТЕМАТА
// ============================================================================

/**
 * @global
 * @type {Object} powerState - Синхронизирано състояние на системата за тока
 * Използва се за синхронизация между Tasker, Web UI и AI асистент
 * 
 * @property {boolean} is_on - Дали токът е включен
 * @property {Date} last_update - Последно време на обновяване
 * @property {string} source - Източник на последната промяна (tasker/web/ai/system/scheduler)
 */
global.powerState = {
    is_on: true,
    last_update: new Date(),
    source: 'system'
};

console.log('✅ [SYSTEM] Глобално състояние на тока инициализирано');

// ============================================================================
// TELEGRAM BOT ИНТЕГРАЦИЯ
// ============================================================================

/**
 * Изпраща команда към Telegram бот за управление на тока
 * Се използва при автоматични действия от scheduler или при AI команди
 * 
 * @async
 * @param {string} command - Команда за изпращане ('ВКЛ' или 'ИЗКЛ')
 * @returns {Promise<boolean>} True ако съобщението е изпратено успешно
 */
async function sendTelegramCommand(command) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn('[TELEGRAM] ⚠️ Telegram bot е недостъпен - пропускам');
        return false;
    }

    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const payload = {
            chat_id: TELEGRAM_CHAT_ID,
            text: `🤖 Smart Stay: ${command}`,
            parse_mode: 'HTML'
        };

        console.log(`[TELEGRAM] 📤 Изпращам команда към бот: ${command}`);

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            console.error(`[TELEGRAM] ❌ Грешка от API (${response.status}):`, response.statusText);
            return false;
        }

        const result = await response.json();
        if (result.ok) {
            console.log(`[TELEGRAM] ✅ Команда изпратена успешно`);
            return true;
        } else {
            console.error('[TELEGRAM] ❌ Telegram API vrзна грешка:', result.description);
            return false;
        }

    } catch (error) {
        console.error('[TELEGRAM] 🔴 ГРЕШКА при изпращане:', error.message);
        return false;
    }
}

// ============================================================================
// SCHEDULER СИСТЕМА ЗА АВТОМАТИЗИРАНО УПРАВЛЕНИЕ НА ТОК
// ============================================================================

/**
 * Cron job, който работи всеки 10 минути
 * Проверява резервациите и автоматично управлява тока:
 * - Включва ток 2 часа преди check-in
 * - Изключва ток 1 час след check-out
 * 
 * Работи только ако Telegram интеграцията е активна
 */
function initializeScheduler() {
    if (!sql || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn('[SCHEDULER] ⚠️ Scheduler не е инициализиран - липсват зависимости');
        return;
    }

    console.log('[SCHEDULER] 📅 Инициализиране на cron scheduler...');

    // Работи всеки 10 минути
    cron.schedule('*/10 * * * *', async () => {
        try {
            console.log(`\n[SCHEDULER] ⏰ Проверявам график... (${new Date().toISOString()})`);

            // Получава текущото време
            const now = new Date();
            const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
            const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000);

            console.log(`[SCHEDULER] 🔍 Текущо време: ${now.toISOString()}`);
            console.log(`[SCHEDULER] 🔍 Check-in винаги до: ${twoHoursFromNow.toISOString()}`);
            console.log(`[SCHEDULER] 🔍 Check-out по-рано от: ${oneHourAgo.toISOString()}`);

            // Запитва резервациите от базата данни
            const bookings = await sql`
                SELECT id, guest_name, reservation_code, check_in, check_out 
                FROM bookings 
                WHERE check_in <= ${twoHoursFromNow} 
                AND check_in >= ${now}
                AND check_out > ${now}
                LIMIT 10
            `;

            // Проверява резервации за включване на ток
            for (const booking of bookings) {
                console.log(`[SCHEDULER] 📋 Намеренa резервация: ${booking.guest_name} (${booking.reservation_code})`);
                
                const checkInTime = new Date(booking.check_in);
                const hoursUntilCheckIn = (checkInTime.getTime() - now.getTime()) / (1000 * 60 * 60);
                
                console.log(`[SCHEDULER] ⏱️ Часове до check-in: ${hoursUntilCheckIn.toFixed(2)}`);

                if (hoursUntilCheckIn <= 2 && hoursUntilCheckIn > 0 && !global.powerState.is_on) {
                    console.log(`[SCHEDULER] 🚨 ДЕЙСТВИЕ: Включвам ток за ${booking.guest_name}`);
                    
                    global.powerState.is_on = true;
                    global.powerState.last_update = new Date();
                    global.powerState.source = 'scheduler-checkin';
                    
                    const success = await sendTelegramCommand('ВКЛ');
                    if (success) {
                        console.log(`[SCHEDULER] ✅ Ток включен за гост ${booking.guest_name}`);
                    }
                }
            }

            // Запитва резервации за изключване на ток
            const checkoutBookings = await sql`
                SELECT id, guest_name, reservation_code, check_out 
                FROM bookings 
                WHERE check_out <= ${now}
                AND check_out >= ${oneHourAgo}
                LIMIT 10
            `;

            for (const booking of checkoutBookings) {
                console.log(`[SCHEDULER] 📋 Check-out резервация: ${booking.guest_name} (${booking.reservation_code})`);
                
                const checkOutTime = new Date(booking.check_out);
                const hoursSinceCheckOut = (now.getTime() - checkOutTime.getTime()) / (1000 * 60 * 60);
                
                console.log(`[SCHEDULER] ⏱️ Часове след check-out: ${hoursSinceCheckOut.toFixed(2)}`);

                if (hoursSinceCheckOut >= 1 && global.powerState.is_on) {
                    console.log(`[SCHEDULER] 🚨 ДЕЙСТВИЕ: Изключвам ток след check-out на ${booking.guest_name}`);
                    
                    global.powerState.is_on = false;
                    global.powerState.last_update = new Date();
                    global.powerState.source = 'scheduler-checkout';
                    
                    const success = await sendTelegramCommand('ИЗКЛ');
                    if (success) {
                        console.log(`[SCHEDULER] ✅ Ток изключен след check-out`);
                    }
                }
            }

            console.log('[SCHEDULER] ✅ Проверка завършена\n');

        } catch (error) {
            console.error('[SCHEDULER] 🔴 ГРЕШКА при проверка на график:', error.message);
            console.error('[SCHEDULER] Stack:', error.stack);
        }
    });

    console.log('[SCHEDULER] ✅ Cron scheduler инициализиран (всеки 10 минути)');
}

// ============================================================================
// MIDDLEWARE - КОРС И ПАРСВАНЕ НА ДАННИ
// ============================================================================

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// ============================================================================
// MIDDLEWARE - ДЕТАЙЛНО ЛОГВАНЕ НА ВСИЧКИ ЗАЯВКИ
// ============================================================================

/**
 * Логира всяка входна заявка с детайли:
 * - ISO 8601 Timestamp
 * - HTTP метод (GET, POST, PUT, DELETE)
 * - URL пътка
 * - IP адрес на клиента
 * - Размер на payload (ако POST/PUT)
 * 
 * Помага за дебъгване и мониторинг на сървъра
 */
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    const method = req.method.padEnd(6);
    const ip = req.ip || req.connection.remoteAddress || 'UNKNOWN';
    const payloadSize = req.body ? JSON.stringify(req.body).length : 0;
    
    console.log(`[${timestamp}] 📨 ${method} ${req.url.padEnd(30)} | IP: ${ip.padEnd(15)} | Payload: ${payloadSize} bytes`);
    
    next();
});

// ============================================================================
// MIDDLEWARE - СТАТИЧНИ ФАЙЛОВЕ
// ============================================================================

/**
 * Сервира статични файлове (HTML, CSS, JS, изображения) от папката 'public'
 * Позволява фронтенд приложението да работи правилно
 */
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));
console.log(`✅ [STATIC] Публични файлове сервирани от: ${publicPath}`);

// ============================================================================
// ТЕСТОВ ENDPOINT - ПРОВЕРКА НА СЪРВЪР
// ============================================================================

app.get('/', (req, res) => {
    res.json({
        name: 'Smart Stay Home Automation Server',
        version: '1.0.0',
        status: 'operational',
        timestamp: new Date().toISOString(),
        modules: ['AI Chat', 'Power Control', 'Booking Management', 'Alert System']
    });
});

// ============================================================================
// ENDPOINT: /api/chat - ЧАТ С AI АСИСТЕНТ
// ============================================================================

/**
 * POST /api/chat
 * 
 * Прихваща съобщение на потребителя и го изпраща към AI асистент (Gemini)
 * 
 * @body {string} message - Съобщение на потребителя
 * @body {Array} history - История на разговор (масив от предишни съобщения)
 * @body {string} authCode - Код за разрешение (QR код, HM резервационен код или HOST_CODE)
 * 
 * БЕЗОПАСНОСТ:
 * - authCode се проверява за верификация на потребителя (host/guest/stranger)
 * - Логира се детектираната роля преди отговора
 * - Всички входни данни се валидират
 * 
 * @returns {Object} { response: string } - Текст на отговор от AI
 */
app.post('/api/chat', async (req, res) => {
    try {
        const { message, history = [], authCode } = req.body;
        
        console.log(`[CHAT] Получено съобщение от клиент`);
        console.log(`[CHAT] authCode предоставен: ${!!authCode}`);
        
        // Валидация на входни данни
        if (!message || message.trim() === '') {
            console.warn('[CHAT] ❌ Празно съобщение - отхвърлено');
            return res.status(400).json({ error: 'Съобщението не може да бъде празно' });
        }

        console.log(`[CHAT] 🤖 Изпращам към AI асистент със authCode...`);
        
        // Вика AI асистент с authCode за верификация
        const aiResponse = await getAIResponse(message, history, authCode);
        
        console.log(`[CHAT] ✅ Получен отговор от AI (${aiResponse.length} символа)`);
        
        res.json({ response: aiResponse });
        
    } catch (error) {
        console.error('[CHAT] 🔴 ГРЕШКА:', error.message);
        console.error('[CHAT] Stack trace:', error.stack);
        res.status(500).json({ 
            error: 'Възникна вътрешна грешка при обработка на чата',
            response: '❌ Съжалявам, имам технически проблем. Моля опитайте пак.' 
        });
    }
});

// ============================================================================
// ENDPOINT: /api/power-status - СЪСТОЯНИЕ НА ТОКА (ЗА AI И ФРОНТЕНД)
// ============================================================================

/**
 * GET /api/power-status
 * 
 * Връща текущото състояние на системата за тока
 * Използвано от AI асистент и фронтенд приложението
 * 
 * @returns {Object} { online: boolean, isOn: boolean, lastUpdate: string }
 */
app.get('/api/power-status', (req, res) => {
    console.log(`[POWER] 📊 Запитвам статус на тока`);
    
    res.json({
        online: true,
        isOn: global.powerState.is_on,
        lastUpdate: global.powerState.last_update.toISOString(),
        source: global.powerState.source
    });
});

// ============================================================================
// ENDPOINT: /api/power-control - УПРАВЛЕНИЕ НА ТОК (ЗА AI И TASKER)
// ============================================================================

/**
 * POST /api/power-control
 * 
 * Управлява състоянието на тока (на/изключи)
 * Вико се от AI асистент при спешни ситуации
 * АКТУАЛИЗИРАНО: Автоматично изпраща Telegram команда
 * 
 * @body {boolean} state - True = включи, False = изключи
 * 
 * @returns {Object} { success: boolean, state: boolean }
 */
app.post('/api/power-control', async (req, res) => {
    try {
        const { state } = req.body;
        
        if (typeof state !== 'boolean') {
            console.warn('[POWER] ❌ Невалидна стойност на state:', state);
            return res.status(400).json({ error: 'State трябва да бъде boolean' });
        }

        global.powerState.is_on = state;
        global.powerState.last_update = new Date();
        global.powerState.source = 'ai-agent';
        
        console.log(`[POWER] 🔌 Управление на ток от AI: ${state ? 'ВКЛЮЧЕНО' : 'ИЗКЛЮЧЕНО'}`);
        
        // Изпраща Telegram команда
        const command = state ? 'ВКЛ' : 'ИЗКЛ';
        const telegramSuccess = await sendTelegramCommand(command);
        
        res.json({ success: true, state: global.powerState.is_on, telegramSent: telegramSuccess });
        
    } catch (error) {
        console.error('[POWER] 🔴 ГРЕШКА при управление на ток:', error.message);
        res.status(500).json({ error: 'Грешка при управление на тока' });
    }
});

// ============================================================================
// ENDPOINT: /api/power/status - TASKER ИНТЕГРАЦИЯ
// ============================================================================

/**
 * POST /api/power/status
 * 
 * Специален endpoint за Tasker мобилно приложение
 * Актуализира статуса на тока от умния дом
 * 
 * @body {boolean} is_on -状ояние на тока
 * 
 * @returns {string} "Status Updated"
 */
app.post('/api/power/status', (req, res) => {
    try {
        const { is_on } = req.body;
        
        global.powerState.is_on = !!is_on;
        global.powerState.last_update = new Date();
        global.powerState.source = 'tasker';
        
        console.log(`[TASKER] 📱 Tasker обновление: Ток е ${is_on ? 'ON' : 'OFF'}`);
        
        res.status(200).send("Status Updated");
        
    } catch (error) {
        console.error('[TASKER] 🔴 ГРЕШКА:', error.message);
        res.status(500).send('Error updating status');
    }
});

// ============================================================================
// ENDPOINT: /api/alert - СИСТЕМА ЗА ИЗВЕСТУВАНИЯ
// ============================================================================

/**
 * POST /api/alert
 * 
 * Получава спешни известувания от AI асистент
 * Логира ги и ги изпраща на домакина
 * 
 * @body {string} message - Текст на известуванието
 * @body {Object} guestInfo - Информация за госта (име, резервационен код)
 * 
 * @returns {number} 200 - Успешно получено
 */
app.post('/api/alert', (req, res) => {
    try {
        const { message, guestInfo } = req.body;
        
        console.log(`[ALERT] 🚨 ИЗВЕСТУВАНЕ ОТ AI:`);
        console.log(`[ALERT] Съобщение: ${message}`);
        if (guestInfo) {
            console.log(`[ALERT] Гост: ${guestInfo.guest_name || 'Неизвестен'}`);
            console.log(`[ALERT] Код: ${guestInfo.reservation_code || 'N/A'}`);
        }
        
        res.sendStatus(200);
        
    } catch (error) {
        console.error('[ALERT] 🔴 ГРЕШКА при получаване на известуване:', error.message);
        res.status(500).send('Error processing alert');
    }
});

// ============================================================================
// ENDPOINT: /api/bookings - СПИСЪК НА РЕЗЕРВАЦИИ
// ============================================================================

/**
 * GET /api/bookings
 * 
 * Връща всички резервации от база данни
 * Сортирани по дата на заселване (нови първи)
 * 
 * БЕЗОПАСНОСТ: Трябва да се добави authentication
 * 
 * @returns {Array} Масив от обекти резервация
 */
app.get('/api/bookings', async (req, res) => {
    try {
        if (!sql) {
            console.error('[BOOKINGS] ❌ База данни е недостъпна');
            return res.status(500).json({ error: 'Database not connected' });
        }

        console.log('[BOOKINGS] 📋 Запитвам резервации от база данни...');
        
        const result = await sql`
            SELECT id, guest_name, reservation_code, check_in, check_out, lock_pin 
            FROM bookings 
            ORDER BY check_in DESC 
            LIMIT 50
        `;
        
        console.log(`[BOOKINGS] ✅ Получени ${result.length} резервации`);
        res.json(result);
        
    } catch (error) {
        console.error('[BOOKINGS] 🔴 ГРЕШКА при запитване:', error.message);
        res.status(500).json({ error: 'Database query failed', details: error.message });
    }
});

// ============================================================================
// ENDPOINT: /api/pins - СПИСЪК НА PIN КОДОВЕ
// ============================================================================

/**
 * GET /api/pins
 * 
 * Връща всички PIN кодове от хранилище
 * Показва кои са използвани и кои са свободни
 * 
 * БЕЗОПАСНОСТ: Трябва да се добави authentication и ограничения
 * 
 * @returns {Array} Масив от обекти PIN кодове
 */
app.get('/api/pins', async (req, res) => {
    try {
        if (!sql) {
            console.error('[PINS] ❌ База данни е недостъпна');
            return res.status(500).json({ error: 'Database not connected' });
        }

        console.log('[PINS] 🔑 Запитвам PIN кодове от база данни...');
        
        const result = await sql`
            SELECT id, pin_code, is_used, assigned_at, created_at 
            FROM pin_depot 
            ORDER BY created_at DESC
        `;
        
        const unused = result.filter(p => !p.is_used).length;
        console.log(`[PINS] ✅ Получени ${result.length} PIN кодове (${unused} свободни)`);
        
        res.json(result);
        
    } catch (error) {
        console.error('[PINS] 🔴 ГРЕШКА при запитване:', error.message);
        res.status(500).json({ error: 'Database query failed', details: error.message });
    }
});

// ============================================================================
// ERROR HANDLING - НЕВАЛЯИДНИ ПЪТИЩА
// ============================================================================

app.use((req, res) => {
    console.warn(`[404] 🚫 Неоткриен endpoint: ${req.method} ${req.url}`);
    res.status(404).json({ error: 'Endpoint не е намерен' });
});

// ============================================================================
// СТАРТИРАНЕ НА СЪРВЪРА
// ============================================================================

app.listen(PORT, () => {
    console.log('\n');
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║         🚀 SMART-STAY HOME AUTOMATION SERVER STARTED 🚀        ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log('\n📊 КОНФИГУРАЦИЯ НА СЪРВЪРА:');
    console.log(`   🌐 Адрес: http://localhost:${PORT}`);
    console.log(`   🧠 AI Service: ${getAIResponse ? '✅ Активен' : '❌ Неактивен'}`);
    console.log(`   🔌 Power Control: ✅ Активен (глобално состояние синхронизирано)`);
    console.log(`   📱 Tasker Integration: ✅ Активна`);
    console.log(`   📤 Telegram Bot: ${TELEGRAM_BOT_TOKEN ? '✅ Активен' : '⚠️ Недостъпен'}`);
    console.log(`   📅 Scheduler (Cron): ${sql ? '✅ Активен' : '⚠️ Недостъпен'}`);
    console.log(`   🗄️  Database: ${sql ? '✅ Свързана' : '⚠️ Недостъпна'}`);
    console.log(`   📁 Static Files: ✅ Сервирани от /public`);
    console.log('\n🔀 АКТИВНИ ENDPOINTS:');
    console.log('   POST /api/chat                - ЧАТ С AI АСИСТЕНТ');
    console.log('   GET  /api/power-status        - СТАТУС НА ТОКА');
    console.log('   POST /api/power-control       - УПРАВЛЕНИЕ НА ТОК (+ TELEGRAM)');
    console.log('   POST /api/power/status        - TASKER ИНТЕГРАЦИЯ');
    console.log('   POST /api/alert               - ИЗВЕСТУВАНИЯ');
    console.log('   GET  /api/bookings            - СПИСЪК НА РЕЗЕРВАЦИИ');
    console.log('   GET  /api/pins                - СПИСЪК НА PIN КОДОВЕ');
    console.log('\n📤 TELEGRAM BOT:');
    console.log(`   Статус: ${TELEGRAM_BOT_TOKEN ? '✅ Активен' : '⚠️ Недостъпен'}`);
    console.log(`   Chat ID: ${TELEGRAM_CHAT_ID ? '✅ Конфигуриран' : '⚠️ Липсва'}`);
    console.log('\n📅 SCHEDULER (CRON):');
    console.log(`   Статус: ${sql ? '✅ Активен (всеки 10 минути)' : '⚠️ Недостъпен'}`);
    console.log(`   Функция: Автоматично управление на ток при check-in/check-out`);
    console.log('\n⏰ СТАРТИРАН НА: ' + new Date().toISOString());
    console.log('═'.repeat(64) + '\n');

    // Инициализира scheduler ако са налични необходимите зависимости
    if (sql && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        console.log('[SCHEDULER] 🚀 Инициализиране на scheduler...\n');
        initializeScheduler();
    } else {
        console.warn('[SCHEDULER] ⚠️ Scheduler няма да работи - липсват зависимости');
        if (!sql) console.warn('   ❌ Липсва database свързаност');
        if (!TELEGRAM_BOT_TOKEN) console.warn('   ❌ Липсва TELEGRAM_BOT_TOKEN');
        if (!TELEGRAM_CHAT_ID) console.warn('   ❌ Липсва TELEGRAM_CHAT_ID\n');
    }
});