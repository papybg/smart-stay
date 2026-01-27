import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import fs from 'fs';
import nodemailer from 'nodemailer'; // <--- НОВО: Библиотека за поща
import { syncBookingsFromGmail } from './services/detective.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';
import { TuyaContext } from '@tuya/tuya-connector-nodejs';

// --- НАСТРОЙКИ ---
const app = express();
const PORT = process.env.PORT || 10000;
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// --- НОВО: НАСТРОЙКА НА ПОЩАЛЬОНА ---
const mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER, // Твоят имейл (същия като за детектив)
        pass: process.env.GMAIL_APP_PASSWORD // Твоята App парола
    }
});

// Функция за пращане на имейл до теб
async function sendAlertToHost(text, guestInfo) {
    const guestName = guestInfo ? guestInfo.guest_name : "Непознат/Потенциален клиент";
    const guestPin = guestInfo ? guestInfo.lock_pin : "Няма ПИН";
    
    const mailOptions = {
        from: '"Iko AI Assistant" <' + process.env.GMAIL_USER + '>',
        to: process.env.GMAIL_USER, // Праща го на теб самия
        subject: `🔔 СЪОБЩЕНИЕ ОТ ГОСТ: ${guestName}`,
        text: `
        Ико получи съобщение за теб!
        ------------------------------------------------
        👤 Гост: ${guestName}
        🔢 ПИН: ${guestPin}
        ------------------------------------------------
        💬 СЪОБЩЕНИЕ:
        ${text}
        ------------------------------------------------
        `
    };

    try {
        await mailer.sendMail(mailOptions);
        console.log("📧 Имейл изпратен успешно до хоста.");
    } catch (error) {
        console.error("Грешка при пращане на имейл:", error);
    }
}

// --- 1. ЗАРЕЖДАНЕ НА НАРЪЧНИКА ---
let manualContent = "Липсва файл manual.txt.";
try {
    if (fs.existsSync('manual.txt')) {
        manualContent = fs.readFileSync('manual.txt', 'utf8');
    }
} catch (err) { console.error(err); }

// --- 2. TUYA CONFIG ---
const tuya = new TuyaContext({
    baseUrl: 'https://openapi.tuyaeu.com',
    accessKey: process.env.TUYA_ACCESS_ID,
    secretKey: process.env.TUYA_ACCESS_SECRET,
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- TUYA ФУНКЦИИ ---
async function controlDevice(state) {
    try {
        await tuya.request({
            method: 'POST',
            path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
            body: { commands: [{ code: 'switch', value: state }] }
        });
    } catch (e) { console.error('Tuya Error:', e.message); }
}

async function getTuyaStatus() {
    try {
        const res = await tuya.request({ method: 'GET', path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/status` });
        return res.result.find(s => s.code === 'switch');
    } catch (e) { return null; }
}

// --- 3. АВТОПИЛОТ (CRON) ---
cron.schedule('*/10 * * * *', async () => {
    try {
        const bookings = await sql`SELECT * FROM bookings`;
        const now = new Date();
        for (const b of bookings) {
            const checkIn = new Date(b.check_in);
            const checkOut = new Date(b.check_out);
            const onTime = new Date(checkIn.getTime() - (2 * 60 * 60 * 1000));
            const offTime = new Date(checkOut.getTime() + (1 * 60 * 60 * 1000));

            if (now >= onTime && now < offTime && !b.power_on_time) {
                await controlDevice(true);
                await sql`UPDATE bookings SET power_on_time = NOW() WHERE id = ${b.id}`;
            } else if (now >= offTime && !b.power_off_time) {
                await controlDevice(false);
                await sql`UPDATE bookings SET power_off_time = NOW() WHERE id = ${b.id}`;
            }
        }
    } catch (err) { console.error('Cron Error'); }
});

// --- 4. МОЗЪКЪТ НА ИКО (CHAT API) ---
app.post('/api/chat', async (req, res) => {
    const { message, history, authCode } = req.body; 
    let bookingData = null;

    const textCodeMatch = message.trim().toUpperCase().match(/HM[A-Z0-9]{8,10}/);
    const codeToTest = textCodeMatch ? textCodeMatch[0] : authCode;

    if (codeToTest) {
        try {
            const r = await sql`
                SELECT * FROM bookings 
                WHERE reservation_code = ${codeToTest}
                AND NOW() >= (check_in - INTERVAL '2 hours')
                AND NOW() <= (check_out + INTERVAL '1 hour')
                LIMIT 1
            `;
            if (r.length > 0) bookingData = r[0];
        } catch (e) { console.error("DB Error", e); }
    }

    // --- ОБНОВЕНА ИНСТРУКЦИЯ ЗА СЕКРЕТАРЯ ---
    let systemInstruction = `Ти си Ико - умен иконом на "Smart Stay".
    
    === НАРЪЧНИК ===
    ${manualContent}
    ================
    
    НОВА ВАЖНА ФУНКЦИЯ - "СЕКРЕТАР":
    Ако клиентът иска да се свърже с хоста, да съобщи за проблем, авария или липса на нещо:
    1. Приеми съобщението учтиво.
    2. В отговора си включи следната тайна команда: [ALERT_HOST: Текстът на съобщението].
    3. Кажи на клиента: "Предадох съобщението на домакина веднага."
    
    ПРИМЕР:
    Клиент: "Няма топла вода!"
    Ико: "[ALERT_HOST: Клиентът сигнализира за липса на топла вода] Съжалявам за неудобството! Веднага уведомих домакина за проблема."

    ПРИОРИТЕТИ:
    1. Файл manual.txt (За апартамента).
    2. Обща култура (За района).
    3. Сигурност (ПИН/Wi-Fi само за потвърдени).
    `;

    if (bookingData) {
        systemInstruction += `\n[✅ ПОТВЪРДЕН ГОСТ: ${bookingData.guest_name} | ПИН: ${bookingData.lock_pin}]`;
    } else {
        systemInstruction += `\n[❌ НЕПОЗНАТ ГОСТ]`;
    }

    const modelsToTry = ["gemini-1.5-flash", "gemini-2.5-flash"];
    let finalReply = "Ико загрява. Опитайте пак.";

    for (const modelName of modelsToTry) {
        try {
            const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
            const chat = model.startChat({ history: history || [] });
            const result = await chat.sendMessage(message);
            finalReply = result.response.text();

            // --- ТУК Е МАГИЯТА ЗА ИМЕЙЛА ---
            if (finalReply.includes('[ALERT_HOST:')) {
                // 1. Вадим текста за теб
                const match = finalReply.match(/\[ALERT_HOST:(.*?)\]/);
                if (match && match[1]) {
                    const alertText = match[1].trim();
                    // 2. Пращаме имейла
                    sendAlertToHost(alertText, bookingData);
                }
                // 3. Чистим тайната команда, за да не я вижда клиента в чата
                finalReply = finalReply.replace(/\[ALERT_HOST:.*?\]/g, '').trim();
            }
            // --------------------------------

            break; 
        } catch (error) { console.warn(`Retry model...`); }
    }

    res.json({ reply: finalReply });
});

// --- ДРУГИ ENDPOINTS (БЕЗ ПРОМЯНА) ---
app.get('/feed.ics', async (req, res) => {
    try {
        const bookings = await sql`SELECT * FROM bookings`;
        const formatDate = (d) => new Date(d).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        const now = formatDate(new Date());
        let ics = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Smart Stay//Bg','CALSCALE:GREGORIAN','METHOD:PUBLISH'].join('\r\n');
        bookings.forEach(b => {
            ics += '\r\n' + [
                'BEGIN:VEVENT', `UID:${b.id}@smartstay`, `DTSTAMP:${now}`,
                `DTSTART:${formatDate(b.check_in)}`, `DTEND:${formatDate(b.check_out)}`,
                `SUMMARY:Blocked: ${b.guest_name}`, 'STATUS:CONFIRMED', 'END:VEVENT'
            ].join('\r\n');
        });
        ics += '\r\nEND:VCALENDAR';
        res.header('Content-Type', 'text/calendar; charset=utf-8');
        res.send(ics);
    } catch (e) { res.status(500).send("Error"); }
});

app.get('/bookings', async (req, res) => { res.json(await sql`SELECT * FROM bookings ORDER BY created_at DESC`); });
app.post('/add-booking', async (req, res) => {
    const { guest_name, check_in, check_out, reservation_code } = req.body;
    const pin = Math.floor(1000 + Math.random() * 9000);
    try {
        const r = await sql`INSERT INTO bookings (guest_name, check_in, check_out, reservation_code, lock_pin, payment_status) VALUES (${guest_name}, ${check_in}, ${check_out}, ${reservation_code}, ${pin}, 'paid') RETURNING *`;
        res.json({ success: true, pin, booking: r[0] });
    } catch (e) { res.status(500).json({error: e.message}); }
});
app.delete('/bookings/:id', async (req, res) => { await sql`DELETE FROM bookings WHERE id = ${req.params.id}`; res.json({success: true}); });
app.get('/status', async (req, res) => { try { const s = await getTuyaStatus(); res.json({ is_on: s ? s.value : false }); } catch (e) { res.json({ is_on: false }); } });
app.get('/toggle', async (req, res) => { try { const s = await getTuyaStatus(); if(s) { await controlDevice(!s.value); res.json({success:true}); } else throw new Error(); } catch(e){ res.status(500).json({error:"Fail"}); } });

app.listen(PORT, () => {
    console.log(`🚀 Iko is live on port ${PORT}`);
    syncBookingsFromGmail();
    setInterval(syncBookingsFromGmail, 15 * 60 * 1000);
});