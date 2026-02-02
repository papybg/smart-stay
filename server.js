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

// --- 3. TUYA ВРЪЗКА ---
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

// --- ФУНКЦИЯ ЗА ОНЛАЙН ПАРОЛИ (Lockin + Gateway) ---
async function createLockPin(pin, name, checkInDate, checkOutDate) {
    try {
        // За ОНЛАЙН пароли (през Gateway) Tuya иска времето в СЕКУНДИ
        const startTime = Math.floor(new Date(checkInDate).getTime() / 1000);
        const endTime = Math.floor(new Date(checkOutDate).getTime() / 1000);

        const response = await tuya.request({
            method: 'POST',
            path: `/v1.0/smart-lock/devices/${process.env.LOCK_DEVICE_ID}/password/temp`,
            body: {
                name: name,
                password: pin.toString(),
                effective_time: startTime,
                invalid_time: endTime,
                type: 2 // Тип 2 = Онлайн/Периодична парола (изисква Gateway)
            }
        });
        
        console.log(`🔐 Ключалка (Online):`, JSON.stringify(response));
        return response.success;
    } catch (error) {
        console.error("❌ Грешка с Online парола:", error.message);
        return false;
    }
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- 4. АВТОПИЛОТ (CRON) ---
cron.schedule('*/1 * * * *', async () => {
    try {
        const bookings = await sql`SELECT * FROM bookings`;
        const currentStatus = await getTuyaStatus();
        const isDeviceOn = currentStatus ? currentStatus.value : false;
        const now = new Date();

        for (const b of bookings) {
            if (!b.power_on_time || !b.power_off_time) continue;
            const start = new Date(b.power_on_time);
            const end = new Date(b.power_off_time);

            if (now >= start && now < end) {
                if (!isDeviceOn) {
                    await controlDevice(true);
                    await sendNotification("ТОКЪТ Е ПУСНАТ", `Гост: ${b.guest_name}`);
                }
            } 
            else if (now >= end && now < new Date(end.getTime() + 5*60000)) {
                if (isDeviceOn) {
                    const hasOverlap = bookings.some(other => {
                        if (other.id === b.id) return false;
                        const oStart = new Date(other.power_on_time);
                        const oEnd = new Date(other.power_off_time);
                        return now >= oStart && now < oEnd;
                    });
                    if (!hasOverlap) {
                        await controlDevice(false);
                        await sendNotification("ТОКЪТ Е СПРЯН", `Гост: ${b.guest_name}`);
                    }
                }
            }
        }
    } catch (err) { console.error('Cron Error', err); }
});

// --- 5. ЧАТ (ТВОИТЕ МОДЕЛИ: 3 PRO, 2.5 PRO, 2.5 FLASH) ---
app.post('/api/chat', async (req, res) => {
    const { message, history, authCode } = req.body;
    const powerStatus = await getTuyaStatus();
    const isOn = powerStatus ? powerStatus.value : false;
    const currentDateTime = new Date().toLocaleString('bg-BG', { timeZone: 'Europe/Sofia' });

    let bookingData = null;
    let role = "stranger";
    const textCodeMatch = message.trim().toUpperCase().match(/HM[A-Z0-9]+/);
    const codeToTest = textCodeMatch ? textCodeMatch[0] : authCode;

    if (codeToTest === process.env.HOST_CODE) role = "host";
    else if (codeToTest) {
        const r = await sql`SELECT * FROM bookings WHERE reservation_code = ${codeToTest} LIMIT 1`;
        if (r.length > 0) { bookingData = r[0]; role = "guest"; }
    }

    const systemInstruction = `Днес е ${currentDateTime}. Роля: ${role}. Наръчник: ${manualContent}`;
    
    // СПИСЪКЪТ С МОДЕЛИ, КОЙТО ИСКАШЕ
    const modelsToTry = ["gemini-3-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"];
    let finalReply = "Грешка в Ико.";

    for (const modelName of modelsToTry) {
        try {
            const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
            const chat = model.startChat({ history: history || [] });
            const result = await chat.sendMessage(message);
            finalReply = result.response.text();
            break; 
        } catch (error) { 
            console.error(`Проблем с ${modelName}:`, error.message); 
        }
    }
    res.json({ reply: finalReply });
});

// --- 6. DASHBOARD API ---
app.get('/sync', async (req, res) => { await syncBookingsFromGmail(); res.send('Synced'); });
app.get('/bookings', async (req, res) => { res.json(await sql`SELECT * FROM bookings ORDER BY check_in ASC`); });
app.delete('/bookings/:id', async (req, res) => { await sql`DELETE FROM bookings WHERE id = ${req.params.id}`; res.send('OK'); });

app.post('/add-booking', async (req, res) => {
    const { guest_name, reservation_code, check_in, check_out } = req.body;
    const pin = Math.floor(100000 + Math.random() * 899999);
    await sql`INSERT INTO bookings (guest_name, reservation_code, check_in, check_out, lock_pin) VALUES (${guest_name}, ${reservation_code}, ${check_in}, ${check_out}, ${pin})`;
    res.send('OK');
});

app.get('/feed.ics', async (req, res) => {
    const bookings = await sql`SELECT * FROM bookings`;
    let icsContent = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//SmartStay//Bansko//EN\n";
    bookings.forEach(b => {
        const start = new Date(b.check_in).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        const end = new Date(b.check_out).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        icsContent += `BEGIN:VEVENT\nSUMMARY:${b.guest_name}\nDTSTART:${start}\nDTEND:${end}\nDESCRIPTION:PIN: ${b.lock_pin}\nEND:VEVENT\n`;
    });
    icsContent += "END:VCALENDAR";
    res.header('Content-Type', 'text/calendar').send(icsContent);
});

app.get('/status', async (req, res) => { const s = await getTuyaStatus(); res.json({ is_on: s ? s.value : false }); });
app.get('/toggle', async (req, res) => { const s = await getTuyaStatus(); if(s) await controlDevice(!s.value); res.json({success:true}); });

// Тест за ОНЛАЙН парола
app.get('/test-lock', async (req, res) => {
    const now = new Date();
    const later = new Date(now.getTime() + 60 * 60000); // 1 час
    const success = await createLockPin("654321", "Test_Online", now, later);
    res.json({ success, msg: success ? "Изпратен ONLINE код: 654321" : "Грешка" });
});

app.listen(PORT, () => {
    console.log(`🚀 Порт ${PORT}`);
    syncBookingsFromGmail();
    setInterval(syncBookingsFromGmail, 15 * 60 * 1000);
});