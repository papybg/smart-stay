import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import fs from 'fs';
import nodemailer from 'nodemailer';
import { syncBookingsFromGmail } from './services/detective.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';
import { TuyaContext } from '@tuya/tuya-connector-nodejs';

// --- НАСТРОЙКИ ---
const app = express();
const PORT = process.env.PORT || 10000;
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// --- 1. НАСТРОЙКА НА ПОЩА ---
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
            from: `"Smart Stay Bot" <${process.env.GMAIL_USER}>`,
            to: process.env.GMAIL_USER,
            subject: `⚡ ${subject}`,
            text: text
        });
        console.log(`📧 Изпратен имейл: ${subject}`);
    } catch (e) { console.error("Mail Error:", e.message); }
}

// --- 2. ЗАРЕЖДАНЕ НА НАРЪЧНИКА ---
let manualContent = "Липсва файл manual.txt.";
try {
    if (fs.existsSync('manual.txt')) {
        manualContent = fs.readFileSync('manual.txt', 'utf8');
    }
} catch (err) { console.error(err); }

// --- 3. TUYA & SMART DEVICES ---
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
    } catch (e) { console.error('Tuya Error:', e.message); return false; }
}

async function getTuyaStatus() {
    try {
        const res = await tuya.request({ method: 'GET', path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/status` });
        return res.result.find(s => s.code === 'switch');
    } catch (e) { return null; }
}

async function getLockStatus() {
    return { installed: false, battery: 0, status: "Unknown" };
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- 4. АВТОПИЛОТ (CRON) С ИМЕЙЛИ ---
cron.schedule('*/1 * * * *', async () => {
    try {
        const bookings = await sql`SELECT * FROM bookings`;
        const currentStatus = await getTuyaStatus();
        const isDeviceOn = currentStatus ? currentStatus.value : false;
        const now = new Date();

        for (const b of bookings) {
            const checkIn = new Date(b.check_in);
            const checkOut = new Date(b.check_out);
            const onTime = new Date(checkIn.getTime() - (2 * 60 * 60 * 1000));
            const offTime = new Date(checkOut.getTime() + (1 * 60 * 60 * 1000));

            if (now >= onTime && now < offTime && !b.power_on_time) {
                if (!isDeviceOn) {
                    await controlDevice(true);
                    await sendNotification("ТОКЪТ Е ПУСНАТ", `Гост: ${b.guest_name}.`);
                }
                await sql`UPDATE bookings SET power_on_time = NOW() WHERE id = ${b.id}`;
            } else if (now >= offTime && !b.power_off_time) {
                if (isDeviceOn) {
                    await controlDevice(false);
                    await sendNotification("ТОКЪТ Е СПРЯН", `Гост: ${b.guest_name} напусна.`);
                }
                await sql`UPDATE bookings SET power_off_time = NOW() WHERE id = ${b.id}`;
            }
        }
    } catch (err) { console.error('Cron Error'); }
});

// --- 5. МОЗЪКЪТ НА ИКО (CHAT API) ---
app.post('/api/chat', async (req, res) => {
    const { message, history, authCode } = req.body;
    
    // Проверка на хардуера
    const powerStatus = await getTuyaStatus();
    const isOnline = powerStatus !== null;
    const isOn = isOnline ? powerStatus.value : false;

    let bookingData = null;
    const textCodeMatch = message.trim().toUpperCase().match(/HM[A-Z0-9]{8,10}/);
    const codeToTest = textCodeMatch ? textCodeMatch[0] : authCode;
    if (codeToTest) {
        try {
            const r = await sql`SELECT * FROM bookings WHERE reservation_code = ${codeToTest} LIMIT 1`;
            if (r.length > 0) bookingData = r[0];
        } catch (e) { console.error("DB Error", e); }
    }

    let systemInstruction = `Ти си Ико. НАРЪЧНИК: ${manualContent}
    СЪСТОЯНИЕ НА ТОКА:
    - МРЕЖА: ${isOnline ? "ОНЛАЙН" : "ОФЛАЙН (Няма връзка)"}.
    - БУШОН: ${isOn ? "ВКЛЮЧЕН" : "ИЗКЛЮЧЕН"}.
    
    ИНСТРУКЦИИ:
    1. Ако е ОФЛАЙН: Прати клиента на https://energo-pro.bg/bg/novini/avarii-i-profilaktika
    2. Ако е ОНЛАЙН, но ИЗКЛЮЧЕН: Кажи "Включвам предпазителя веднага!" и го направи.
    3. При проблем ползвай [ALERT: съобщение].
    `;

    // --- ТУК СА ТВОИТЕ МОДЕЛИ ---
    const modelsToTry = ["gemini-3.0-pro-preview", "gemini-flash-latest", "gemini-3-flash-preview"];
    let finalReply = "Ико има техническо затруднение.";

    for (const modelName of modelsToTry) {
        try {
            const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
            const chat = model.startChat({ history: history || [] });
            const result = await chat.sendMessage(message);
            finalReply = result.response.text();

            // Автоматично пускане на тока
            if (message.toLowerCase().includes("ток") && isOnline && !isOn) {
                await controlDevice(true);
                if (!finalReply.includes("Включвам")) {
                    finalReply += "\n\n(Система: Автоматично възстанових захранването.)";
                }
                await sendNotification("АВАРИЙНО ВКЛЮЧВАНЕ", `Клиентът поиска ток. Устройството беше изключено, но онлайн. Пуснах го.`);
            }

            // Обработка на ALERT
            if (finalReply.includes('[ALERT:')) {
                const match = finalReply.match(/\[ALERT:(.*?)\]/);
                if (match && match[1]) {
                    await sendNotification("СЪОБЩЕНИЕ ОТ ГОСТ", `${match[1]}\nГост: ${bookingData ? bookingData.guest_name : 'Непознат'}`);
                }
                finalReply = finalReply.replace(/\[ALERT:.*?\]/g, '').trim();
            }

            break; // Ако успеем с първия модел, спираме цикъла
        } catch (error) { 
            console.warn(`Грешка с модел ${modelName}, опитвам следващия...`); 
        }
    }

    res.json({ reply: finalReply });
});

// --- ДРУГИ ENDPOINTS ---
app.get('/bookings', async (req, res) => { res.json(await sql`SELECT * FROM bookings ORDER BY created_at DESC`); });
app.get('/status', async (req, res) => { try { const s = await getTuyaStatus(); res.json({ is_on: s ? s.value : false }); } catch (e) { res.json({ is_on: false }); } });
app.get('/toggle', async (req, res) => { try { const s = await getTuyaStatus(); if(s) { await controlDevice(!s.value); res.json({success:true}); } else throw new Error(); } catch(e){ res.status(500).json({error:"Fail"}); } });
app.get('/lock-status', async (req, res) => { res.json(await getLockStatus()); });

app.listen(PORT, () => {
    console.log(`🚀 Iko is live on port ${PORT}`);
    syncBookingsFromGmail();
    setInterval(syncBookingsFromGmail, 15 * 60 * 1000);
});