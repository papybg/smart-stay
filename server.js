import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { neon } from '@neondatabase/serverless';
import { syncBookingsFromGmail } from './services/detective.js';
import { getAIResponse } from './services/ai_service.js';

// --- CONFIG ---
const app = express();
const PORT = process.env.PORT || 10000;
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

// Global Power Status (съхранява се в паметта)
global.powerState = {
    is_on: false,
    voltage: 0,
    power: 0,
    last_update: new Date()
};

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Обслужва dashboard.html

// ==========================================
// 1. AI AGENT ENDPOINT (За Vercel/Гости)
// ==========================================
app.post('/api/chat', async (req, res) => {
    try {
        const { message, history } = req.body;
        // Викаме "Черната кутия"
        const response = await getAIResponse(message, history);
        res.json({ response });
    } catch (error) {
        console.error("Chat Error:", error);
        res.json({ response: "Моля опитайте отново по-късно." });
    }
});

// ==========================================
// 2. TASKER ENDPOINTS (За Тока)
// ==========================================

// Tasker изпраща данни тук (Webhook)
app.post('/api/power/status', (req, res) => {
    // Очакваме JSON: { "is_on": true, "voltage": 230, "power": 1500 }
    const { is_on, voltage, power } = req.body;
    
    global.powerState = {
        is_on: !!is_on,
        voltage: voltage || 0,
        power: power || 0,
        last_update: new Date()
    };
    
    console.log(`🔌 Tasker Report: ${is_on ? 'ON' : 'OFF'} (${power}W)`);
    res.sendStatus(200);
});

// Dashboard-ът чете данните от тук
app.get('/status', (req, res) => {
    res.json(global.powerState);
});

// За превключване на тока (ще го доразвием в следващия етап)
app.get('/toggle', (req, res) => {
    console.log("⚠️ Заявено превключване (изчаква Tasker интеграция)");
    res.json({ status: "pending", message: "Command queued for Tasker" });
});

// ==========================================
// 3. ADMIN / DASHBOARD API
// ==========================================

// Списък резервации
app.get('/bookings', async (req, res) => {
    if (!sql) return res.json([]);
    try {
        const result = await sql`SELECT * FROM bookings ORDER BY check_in ASC`;
        res.json(result);
    } catch (e) { console.error(e); res.json([]); }
});

// --- СКЛАД ЗА ПИНОВЕ (pin_depot) ---
app.get('/api/pins', async (req, res) => {
    if (!sql) return res.json([]);
    // Взимаме от новата таблица pin_depot
    const pins = await sql`SELECT * FROM pin_depot ORDER BY created_at DESC`;
    res.json(pins);
});

app.post('/api/pins', async (req, res) => {
    const { pin_name, pin_code } = req.body;
    if (!sql) return res.sendStatus(500);
    // Записваме в pin_depot
    await sql`INSERT INTO pin_depot (pin_name, pin_code) VALUES (${pin_name}, ${pin_code})`;
    res.sendStatus(201);
});

app.delete('/api/pins/:id', async (req, res) => {
    const { id } = req.params;
    if (!sql) return res.sendStatus(500);
    // Трием от pin_depot
    await sql`DELETE FROM pin_depot WHERE id = ${id}`;
    res.sendStatus(200);
});

// ==========================================
// 4. CRON JOBS (Автоматизация)
// ==========================================

// Детектив (Gmail) - на 15 мин
cron.schedule('*/15 * * * *', async () => {
    console.log('🕵️ Детективът проверява пощата...');
    await syncBookingsFromGmail();
});

// ==========================================
// SERVER START
// ==========================================
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🧠 AI Service: Loaded`);
    console.log(`🔌 Smart Meter API: Ready`);
});