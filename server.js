import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { neon } from '@neondatabase/serverless';
import { getAIResponse } from './services/ai_service.js';

// --- КОНФИГУРАЦИЯ ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 10000;
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

// --- СЪСТОЯНИЕ НА СИСТЕМАТА (В ПАМЕТТА) ---
global.powerState = {
    is_on: true,
    last_update: new Date(),
    source: 'system'
};

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Логване на заявките за дебъгване
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

// --- API ЗА ЧАТ (AI AGENT) ---
app.post('/api/chat', async (req, res) => {
    try {
        const { message, history, authCode } = req.body;
        
        if (!message) {
            return res.status(400).json({ error: "Missing message" });
        }

        const response = await getAIResponse(message, history, authCode);
        res.json({ response });
    } catch (error) {
        console.error('🔴 Chat Error:', error.message);
        res.status(500).json({ response: "Възникна вътрешна грешка. Моля, опитайте пак." });
    }
});

// --- API ЗА УПРАВЛЕНИЕ НА ТОКА (ЗА АГЕНТА И TASKER) ---

// Използва се от Ико, за да види има ли ток
app.get('/api/power-status', (req, res) => {
    res.json({
        online: true,
        isOn: global.powerState.is_on,
        lastUpdate: global.powerState.last_update
    });
});

// Използва се от Ико, за да пусне тока аварийно
app.post('/api/power-control', (req, res) => {
    const { state } = req.body;
    global.powerState.is_on = !!state;
    global.powerState.last_update = new Date();
    console.log(`🔌 Power state updated by AI to: ${state}`);
    res.json({ success: true, state: global.powerState.is_on });
});

// Използва се от Tasker, за да каже на сървъра реалното състояние
app.post('/api/power/status', (req, res) => {
    const { is_on } = req.body;
    global.powerState.is_on = !!is_on;
    global.powerState.last_update = new Date();
    res.status(200).send("Status Updated");
});

// --- API ЗА АЛАРМИ ---
app.post('/api/alert', (req, res) => {
    const { message, guestInfo } = req.body;
    console.log(`🚨 [ИКО АЛАРМА]: ${message}`);
    console.log(`👤 Гост данни:`, guestInfo);
    // Тук може да се добави пращане на имейл или Telegram
    res.sendStatus(200);
});

// --- АДМИНИСТРАТИВНИ ПЪТИЩА ---

// Списък с резервации
app.get('/bookings', async (req, res) => {
    if (!sql) return res.status(500).send("Database not connected");
    try {
        const result = await sql`SELECT * FROM bookings ORDER BY check_in DESC`;
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Списък с ПИН кодове
app.get('/api/pins', async (req, res) => {
    if (!sql) return res.status(500).send("Database not connected");
    try {
        const result = await sql`SELECT * FROM pin_depot ORDER BY created_at DESC`;
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ГРЕШКИ И СТАРТИРАНЕ ---
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Нещо се счупи!');
});

app.listen(PORT, () => {
    console.log(`
🚀 Сървърът е онлайн!
📍 Порт: ${PORT}
🧠 AI Service: Активен
🔌 Power Control API: Готов
    `);
});