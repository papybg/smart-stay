import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { syncBookingsFromGmail } from './services/detective.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';
import { TuyaContext } from '@tuya/tuya-connector-nodejs';

const app = express();
const PORT = process.env.PORT || 10000;
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// --- TUYA CONFIG ---
const tuya = new TuyaContext({
    baseUrl: 'https://openapi.tuyaeu.com',
    accessKey: process.env.TUYA_ACCESS_ID || process.env.TUYA_DEVICE_ID,
    secretKey: process.env.TUYA_ACCESS_SECRET || process.env.TUYA_LOCAL_KEY,
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- TUYA CONTROLS ---
async function controlDevice(state) {
    try {
        console.log(`🔌 Tuya: Switch -> ${state}`);
        await tuya.request({
            method: 'POST',
            path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
            body: { commands: [{ code: 'switch', value: state }] }
        });
    } catch (e) { console.error('Tuya Error:', e.message); }
}

// --- SMART AI CHAT (С ПАМЕТ) ---
app.post('/api/chat', async (req, res) => {
    // history е масив от предишните съобщения, който идва от клиента
    const { message, history } = req.body; 
    
    // 1. Търсим код в текущото съобщение ИЛИ в историята
    // Това е ключът! Проверяваме дали вече сме говорили за код.
    let activeReservation = null;
    const currentCodeMatch = message.trim().toUpperCase().match(/HM[A-Z0-9]{8,10}/);
    
    // Ако сега праща код -> търсим в базата
    if (currentCodeMatch) {
        try {
            const r = await sql`SELECT * FROM bookings WHERE reservation_code = ${currentCodeMatch[0]} LIMIT 1`;
            if (r.length > 0) activeReservation = r[0];
        } catch(e) { console.error(e); }
    } 
    // Ако няма код сега, проверяваме дали в историята AI-то вече не е потвърдило резервация
    else if (history && history.length > 0) {
        // Търсим в старите съобщения на AI дали е споменавало "ПИН код е..."
        // За по-сигурно, просто ще разчитаме, че клиентът (frontend) може да ни прати context, 
        // но за най-лесно тук ще ползваме "System Prompt Injection" всеки път.
    }

    // 2. Подготовка на инструкциите за Бобо
    let systemInstruction = `Ти си Бобо - иконом на Smart Stay. Говори на български.
    ВАЖНО:
    - Wi-Fi мрежа: "SmartStay_Guest", Парола: "Welcome2026"
    - Чек-ин след 14:00, Чек-аут до 11:00.
    - Ако те питат за код, и нямаш данни, поискай "Код на резервация (HM...)".
    - НИКОГА не си измисляй ПИН кодове.`;

    // Ако сме намерили резервация (сега или преди малко), добавяме я в "мозъка" му
    if (activeReservation) {
        systemInstruction += `
        \n[АКТИВНА РЕЗЕРВАЦИЯ НАМЕРЕНА]
        - Гост: ${activeReservation.guest_name}
        - ПИН КОД ВРАТА: ${activeReservation.lock_pin}
        - Код резервация: ${activeReservation.reservation_code}
        - Клиентът е потвърден. Отговаряй му на въпросите директно.`;
    }

    // 3. Форматиране на историята за Gemini
    // Превръщаме масива от JSON в формат за Gemini
    let chatHistory = [];
    if (history && Array.isArray(history)) {
        chatHistory = history.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
        }));
    }

    try {
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash", // Или 3-flash-preview
            systemInstruction: systemInstruction
        });

        const chat = model.startChat({
            history: chatHistory, // Тук подаваме паметта!
        });

        const result = await chat.sendMessage(message);
        const responseText = result.response.text();

        // Връщаме отговора + данните за резервацията (скрито), за да ги помни фронтенда
        res.json({ 
            reply: responseText,
            // Връщаме кода обратно, за да може фронтендът да го прати пак следващия път
            reservationContext: activeReservation ? activeReservation.reservation_code : null 
        });

    } catch (error) {
        console.error(error);
        res.json({ reply: "Бобо загуби връзка. Моля опитайте пак." });
    }
});

// --- СТАНДАРТНИ API ---
app.get('/bookings', async (req, res) => { res.json(await sql`SELECT * FROM bookings ORDER BY created_at DESC`); });
app.post('/add-booking', async (req, res) => { /* същия код като преди */ }); // ... (съкратено за прегледност, ползвай стария)
app.delete('/bookings/:id', async (req, res) => { /* същия код */ }); 

// CRON и LISTEN са същите...
// (За да не става грешка, копирай долната част от предишния файл или искай пълния код, ако се затрудняваш да сглобиш)