import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import fs from 'fs';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';
import { TuyaContext } from '@tuya/tuya-connector-nodejs';

const app = express();
const PORT = process.env.PORT || 10000;
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// --- ПАМЕТ ЗА ЧАТОВЕТЕ (За резюме на 10 мин) ---
let activeChats = {}; 

// --- НАСТРОЙКА НА ПОЩАТА ---
const mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
    }
});

async function sendNotification(subject, text) {
    try {
        await mailer.sendMail({
            from: `"Iko Admin" <${process.env.GMAIL_USER}>`,
            to: process.env.GMAIL_USER,
            subject: `🔔 ${subject}`,
            text: text
        });
        console.log(`📧 Изпратен имейл: ${subject}`);
    } catch (error) {
        console.error("❌ Грешка при имейл:", error.message);
    }
}

// --- TUYA (УМЕН ЕЛЕКТРОМЕР) ---
const tuya = new TuyaContext({
    baseUrl: 'https://openapi.tuyaeu.com',
    accessKey: process.env.TUYA_ACCESS_ID,
    secretKey: process.env.TUYA_ACCESS_SECRET,
});

async function controlDevice(state) {
    try {
        await tuya.request({
            method: 'POST',
            path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
            body: { commands: [{ code: 'switch', value: state }] }
        });
        return true;
    } catch (e) { return false; }
}

async function getTuyaStatus() {
    try {
        const res = await tuya.request({ method: 'GET', path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/status` });
        return res.result.find(s => s.code === 'switch');
    } catch (e) { return null; } // Offline
}

// --- ДЕТЕКТИВ ЗА РЕЗЕРВАЦИИ ---
async function syncBookingsFromGmail() {
    console.log("🕵️ Детектива сканира пощата...");
    if (!process.env.GMAIL_CLIENT_ID) return;
    try {
        const auth = new google.auth.OAuth2(
            process.env.GMAIL_CLIENT_ID, 
            process.env.GMAIL_CLIENT_SECRET, 
            "https://developers.google.com/oauthplayground"
        );
        auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
        const gmail = google.gmail({ version: 'v1', auth });
        const res = await gmail.users.messages.list({ userId: 'me', q: 'subject:(reservation confirmed) after:2024/01/01', maxResults: 5 });
        if (!res.data.messages) return;

        for (const msg of res.data.messages) {
            const msgFull = await gmail.users.messages.get({ userId: 'me', id: msg.id });
            const snippet = msgFull.data.snippet;
            const codeMatch = snippet.match(/(HM[A-Z0-9]{8,10})/);
            if (codeMatch) {
                const resCode = codeMatch[1];
                const exists = await sql`SELECT id FROM bookings WHERE reservation_code = ${resCode}`;
                if (exists.length === 0) {
                    const pin = Math.floor(1000 + Math.random() * 9000);
                    await sql`INSERT INTO bookings (guest_name, check_in, check_out, reservation_code, lock_pin, payment_status) VALUES ('Airbnb Guest', NOW(), NOW() + INTERVAL '1 day', ${resCode}, ${pin}, 'paid')`;
                    await sendNotification("💰 НОВА РЕЗЕРВАЦИЯ", `Открих нов код: ${resCode}. ПИН: ${pin}`);
                }
            }
        }
    } catch (error) { console.error("❌ Gmail Sync Error:", error.message); }
}

// --- УМЕН CRON: ТОК & ЧАТ ОТЧЕТИ ---
cron.schedule('*/1 * * * *', async () => {
    const now = new Date();

    // 1. ПРОВЕРКА НА ЧАТОВЕТЕ (10 МИН ТИШИНА)
    try {
        for (const [userId, session] of Object.entries(activeChats)) {
            const diffMinutes = (now - session.lastActive) / 1000 / 60;
            if (diffMinutes >= 10) {
                let summaryText = `Резюме на чата с ${userId}:\n\n` + session.messages.map(m => `🔹 В: ${m.q}\n🔸 О: ${m.a}`).join('\n\n');
                await sendNotification(`💬 Чат Отчет (${userId})`, summaryText);
                delete activeChats[userId];
            }
        }
    } catch (e) { console.error("❌ Chat Cron Error"); }

    // 2. УПРАВЛЕНИЕ НА ТОКА
    try {
        const bookings = await sql`SELECT * FROM bookings WHERE power_off_time IS NULL`;
        if (bookings.length === 0) return;

        const currentStatus = await getTuyaStatus();
        const isDeviceOn = currentStatus ? currentStatus.value : false;

        for (const b of bookings) {
            const checkIn = new Date(b.check_in);
            const checkOut = new Date(b.check_out);
            const onTime = new Date(checkIn.getTime() - (2 * 60 * 60 * 1000));
            const offTime = new Date(checkOut.getTime() + (1 * 60 * 60 * 1000));

            if (now >= onTime && now < offTime && !b.power_on_time) {
                if (!isDeviceOn) await controlDevice(true);
                await sql`UPDATE bookings SET power_on_time = NOW() WHERE id = ${b.id}`;
                if (!isDeviceOn) await sendNotification("⚡ ТОКЪТ Е ПУСНАТ", `Гост: ${b.guest_name}. Очаква се пристигане.`);
            } else if (now >= offTime && !b.power_off_time) {
                if (isDeviceOn) await controlDevice(false);
                await sql`UPDATE bookings SET power_off_time = NOW() WHERE id = ${b.id}`;
                if (isDeviceOn) await sendNotification("🌑 ТОКЪТ Е СПРЯН", `Гост: ${b.guest_name} напусна.`);
            }
        }
    } catch (err) { console.error('❌ Power Cron Error'); }
});

// --- API ---
let manualContent = "Добре дошли в Апартамент D105 Aspen Valley.";
try { manualContent = fs.readFileSync('manual.txt', 'utf8'); } catch(e){}

app.use(cors()); app.use(express.json()); app.use(express.static('public'));

app.post('/api/chat', async (req, res) => {
    const { message, history, authCode } = req.body;
    console.log(`📩 Получено съобщение: "${message.substring(0, 30)}..."`);

    try {
        const status = await getTuyaStatus();
        const isOnline = status !== null;
        const isOn = isOnline ? status.value : false;

        let bookingData = null;
        const codeMatch = message.trim().toUpperCase().match(/HM[A-Z0-9]{8,10}/);
        const codeToTest = codeMatch ? codeMatch[0] : authCode;
        if (codeToTest) {
            const r = await sql`SELECT * FROM bookings WHERE reservation_code = ${codeToTest} LIMIT 1`;
            if (r.length > 0) bookingData = r[0];
        }
        const userId = bookingData ? bookingData.guest_name : (codeToTest || "Непознат");

        const systemInstruction = `Ти си Ико, иконом на Апартамент D105 в Aspen Valley. МАНУАЛ: ${manualContent}. ТЕХНИЧЕСКИ СТАТУС: Токът е ${isOnline ? (isOn ? 'ВКЛЮЧЕН' : 'ИЗКЛЮЧЕН (Бушон)') : 'ОФЛАЙН'}. Ако гостът пита за ток и е ОФЛАЙН - дай сайта на енергото. Ако е ИЗКЛЮЧЕН (Бушон) - кажи че го пускаш. Ако има авария, ползвай [ALERT: текст].`;

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash", systemInstruction });
        const chat = model.startChat({ history: history || [] });
        const result = await chat.sendMessage(message);
        let reply = result.response.text();

        if (message.toLowerCase().includes("ток") && isOnline && !isOn) {
            await controlDevice(true);
            reply += "\n\n(Система: Засекох паднал предпазител и го включих дистанционно.)";
        }

        if (reply.includes('[ALERT:')) {
            const m = reply.match(/\[ALERT:(.*?)\]/);
            if (m) sendNotification("🚨 СПЕШНО", m[1]);
            reply = reply.replace(/\[ALERT:.*?\]/g, '').trim();
        }

        if (!activeChats[userId]) activeChats[userId] = { lastActive: new Date(), messages: [] };
        activeChats[userId].lastActive = new Date();
        activeChats[userId].messages.push({ q: message, a: reply });

        res.json({ reply });
    } catch (e) { 
        console.error("❌ ГРЕШКА В ЧАТА:", e.message); 
        res.json({ reply: `Ико се рестартира (Техническа грешка: ${e.message})` }); 
    }
});

app.get('/bookings', async (req, res) => {
    try { res.json(await sql`SELECT * FROM bookings ORDER BY created_at DESC`); } catch(e) { res.status(500).send("DB Error"); }
});

app.get('/status', async (req, res) => {
    const s = await getTuyaStatus();
    res.json({ is_on: s ? s.value : false, online: s !== null, property: "D105 Aspen Valley" });
});

app.get('/toggle', async (req, res) => {
    const s = await getTuyaStatus();
    if(s) { const success = await controlDevice(!s.value); res.json({ success }); }
    else res.status(500).json({ error: "Offline" });
});

app.listen(PORT, () => {
    console.log(`🚀 Ико е на линия на порт ${PORT} (Платен план)`);
    syncBookingsFromGmail();
    setInterval(syncBookingsFromGmail, 15 * 60 * 1000);
});