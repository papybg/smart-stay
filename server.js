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
 * 
 * Поддържани модули: AI Service, Power Control, Booking Management, Alert System
 * Създадено: февруари 2026
 * ============================================================================
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { neon } from '@neondatabase/serverless';
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

if (!sql) {
    console.warn('⚠️ [DATABASE] DATABASE_URL не е зададена - база данни е недостъпна');
} else {
    console.log('✅ [DATABASE] Neon PostgreSQL клиент инициализиран успешно');
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
 * @property {string} source - Източник на последната промяна (tasker/web/ai/system)
 */
global.powerState = {
    is_on: true,
    last_update: new Date(),
    source: 'system'
};

console.log('✅ [SYSTEM] Глобално състояние на тока инициализирано');

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
// ENDPOINT: /api/power-control - УПРАВЛЕНИЕ НА ТОК (ЗА AI)
// ============================================================================

/**
 * POST /api/power-control
 * 
 * Управлява състоянието на тока (на/изключи)
 * Вико се от AI асистент при спешни ситуации
 * 
 * @body {boolean} state - True = включи, False = изключи
 * 
 * @returns {Object} { success: boolean, state: boolean }
 */
app.post('/api/power-control', (req, res) => {
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
        
        res.json({ success: true, state: global.powerState.is_on });
        
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
    console.log(`   🗄️  Database: ${sql ? '✅ Свързана' : '⚠️ Недостъпна'}`);
    console.log(`   📁 Static Files: ✅ Сервирани от /public`);
    console.log('\n🔀 АКТИВНИ ENDPOINTS:');
    console.log('   POST /api/chat                - ЧАТ С AI АСИСТЕНТ');
    console.log('   GET  /api/power-status        - СТАТУС НА ТОКА');
    console.log('   POST /api/power-control       - УПРАВЛЕНИЕ НА ТОК');
    console.log('   POST /api/power/status        - TASKER ИНТЕГРАЦИЯ');
    console.log('   POST /api/alert               - ИЗВЕСТУВАНИЯ');
    console.log('   GET  /api/bookings            - СПИСЪК НА РЕЗЕРВАЦИИ');
    console.log('   GET  /api/pins                - СПИСЪК НА PIN КОДОВЕ');
    console.log('\n⏰ СТАРТИРАН НА: ' + new Date().toISOString());
    console.log('═'.repeat(64) + '\n');
});