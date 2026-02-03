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

// --- 1. CONFIGURATION & SETUP ---
const app = express();
const PORT = process.env.PORT || 10000;
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- 2. MAIL SYSTEM ---
const mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
});

async function sendNotification(subject, text) {
    try {
        await mailer.sendMail({
            from: `"Smart Stay Bot" <${process.env.GMAIL_USER}>`,
            to: process.env.GMAIL_USER,
            subject: `⚡ ${subject}`,
            text: text
        });
    } catch (e) { console.error("Mail Error:", e.message); }
}

// --- 3. MANUAL LOAD ---
let manualContent = "Липсва файл manual.txt.";
try { 
    if (fs.existsSync('manual.txt')) manualContent = fs.readFileSync('manual.txt', 'utf8'); 
} catch (err) {}

// --- 4. TUYA CONNECTION ---
const tuya = new TuyaContext({
    baseUrl: 'https://openapi.tuyaeu.com',
    accessKey: process.env.TUYA_ACCESS_ID,
    secretKey: process.env.TUYA_ACCESS_SECRET,
});

// --- 5. HELPER FUNCTIONS ---
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
    } catch (e) { return null; }
}

async function getLockStatus() {
    try {
        const res = await tuya.request({ method: 'GET', path: `/v1.0/iot-03/devices/${process.env.LOCK_DEVICE_ID}/status` });
        return res.result;
    } catch (e) { return null; }
}

// --- 6. CORE LOGIC: CREATE LOCK PIN (Ticket Strategy) ---
async function createLockPin(pin, name, checkInDate, checkOutDate) {
    console.log(`🔐 [LOCK] Стартиране на процедура за ${name} (PIN: ${pin})...`);
    
    const now = new Date();
    const startMs = now.getTime() - 600000; // 10 минути буфер назад
    const endMs = new Date(checkOutDate).getTime();
    
    const startSec = Math.floor(startMs / 1000);
    const endSec = Math.floor(endMs / 1000);

    let report = [];
    let success = false;

    // СТРАТЕГИЯ 1: TICKET (Специален протокол за G30 EU)
    // Това е най-вероятният работещ метод за твоята версия
    try {
        console.log("   👉 Опит 1: Ticket Method...");
        const res = await tuya.request({
            method: 'POST',
            path: `/v1.0/devices/${process.env.LOCK_DEVICE_ID}/door-lock/temp-password`,
            body: { 
                name: "Guest", 
                password: pin.toString(), 
                start_time: startMs, 
                expire_time: endMs, 
                password_type: "ticket" 
            }
        });
        if (res.success) {
            report.push("✅ Метод 1 (Ticket): УСПЕХ");
            success = true;
        } else {
            report.push(`❌ Метод 1: Неуспешен отговор`);
        }
    } catch (e) { 
        report.push(`❌ Метод 1 Грешка: ${e.message}`); 
    }

    // СТРАТЕГИЯ 2: ДИРЕКТНА КОМАНДА (Gateway Pass-through)
    // Ако Ticket не сработи, пробваме да го "налеем" директно в паметта
    if (!success) {
        try {
            console.log("   👉 Опит 2: Direct Command (add_temp_password)...");
            const res = await tuya.request({
                method: 'POST',
                path: `/v1.0/devices/${process.env.LOCK_DEVICE_ID}/commands`,
                body: {
                    commands: [
                        {
                            code: "add_temp_password",
                            value: JSON.stringify({
                                name: "G_Backup",
                                password: pin.toString(),
                                start_time: startSec,
                                expire_time: endSec,
                                type: 1 // Тук пробваме стандартен тип, но през команда
                            })
                        }
                    ]
                }
            });
            if (res.success) {
                report.push("✅ Метод 2 (Direct): УСПЕХ");
                success = true;
            }
        } catch (e) { 
            report.push(`❌ Метод 2 Грешка: ${e.message}`); 
        }
    }

    // СТРАТЕГИЯ 3: STANDARD (Type 1)
    // Последен шанс - класически метод
    if (!success) {
        try {
            console.log("   👉 Опит 3: Standard One-Time...");
            await tuya.request({
                method: 'POST',
                path: `/v1.0/devices/${process.env.LOCK_DEVICE_ID}/door-lock/temp-password`,
                body: { 
                    name: "Guest", 
                    password: pin.toString(), 
                    start_time: startMs, 
                    expire_time: endMs, 
                    password_type: 1 
                }
            });
            report.push("✅ Метод 3 (Standard): УСПЕХ");
            success = true;
        } catch (e) { 
            report.push(`❌ Метод 3 Грешка: ${e.message}`); 
        }
    }

    console.log("📝 [LOCK REPORT]:", JSON.stringify(report, null, 2));
    return { success, report };
}

// --- 7. CRON JOB (ELECTRICITY) ---
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
                    console.log(`💡 [CRON] Токът е ПУСНАТ за ${b.guest_name}`);
                }
            } 
            else if (now >= end && now < new Date(end.getTime() + 5*60000)) {
                // Проверка за застъпване
                const hasOverlap = bookings.some(other => {
                    if (other.id === b.id) return false;
                    const oStart = new Date(other.power_on_time);
                    const oEnd = new Date(other.power_off_time);
                    return now >= oStart && now < oEnd;
                });

                if (!hasOverlap && isDeviceOn) {
                    await controlDevice(false);
                    console.log(`🌑 [CRON] Токът е СПРЯН след ${b.guest_name}`);
                }
            }
        }
    } catch (err) { console.error("Cron Error:", err); }
});

// --- 8. CHAT BOT API ---
app.post('/api/chat', async (req, res) => {
    const { message, history, authCode } = req.body;
    const powerStatus = await getTuyaStatus();
    const isOnline = powerStatus !== null;
    const currentDateTime = new Date().toLocaleString('bg-BG', { timeZone: 'Europe/Sofia' });
    
    let role = (authCode === process.env.HOST_CODE) ? "host" : "stranger";
    let bookingData = null;
    
    const textCodeMatch = message.trim().toUpperCase().match(/HM[A-Z0-9]+/);
    const codeToTest = textCodeMatch ? textCodeMatch[0] : authCode;
    
    if (codeToTest && codeToTest !== process.env.HOST_CODE) {
        const r = await sql`SELECT * FROM bookings WHERE reservation_code = ${codeToTest} LIMIT 1`;
        if (r.length > 0) { bookingData = r[0]; role = "guest"; }
    }

    const systemInstruction = `Време: ${currentDateTime}. Роля: ${role}. Наръчник: ${manualContent}`;
    const modelsToTry = ["gemini-3-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"];
    let finalReply = "Грешка.";

    for (const modelName of modelsToTry) {
        try {
            const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
            const chat = model.startChat({ history: history || [] });
            const result = await chat.sendMessage(message);
            finalReply = result.response.text();
            break; 
        } catch (error) { console.error(error.message); }
    }
    res.json({ reply: finalReply });
});

// --- 9. API ENDPOINTS ---
app.get('/sync', async (req, res) => { 
    try {
        await syncBookingsFromGmail(); 
        res.send('Synced'); 
    } catch(e) { res.status(500).send(e.message); }
});

app.get('/bookings', async (req, res) => { 
    try {
        const b = await sql`SELECT * FROM bookings ORDER BY check_in ASC`;
        res.json(b);
    } catch(e) { res.status(500).json([]); }
});

app.delete('/bookings/:id', async (req, res) => { 
    try {
        await sql`DELETE FROM bookings WHERE id = ${req.params.id}`; 
        res.send('OK'); 
    } catch(e) { res.status(500).send(e.message); }
});

app.post('/add-booking', async (req, res) => {
    try {
        const { guest_name, reservation_code, check_in, check_out } = req.body;
        const pin = Math.floor(100000 + Math.random() * 899999);
        await sql`INSERT INTO bookings (guest_name, reservation_code, check_in, check_out, lock_pin) VALUES (${guest_name}, ${reservation_code}, ${check_in}, ${check_out}, ${pin})`;
        createLockPin(pin, guest_name.split(' ')[0], check_in, check_out);
        res.send('OK');
    } catch(e) { res.status(500).send(e.message); }
});

app.get('/feed.ics', async (req, res) => {
    try {
        const bookings = await sql`SELECT * FROM bookings`;
        let icsContent = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//SmartStay//Bansko//EN\n";
        bookings.forEach(b => {
            const start = new Date(b.check_in).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
            const end = new Date(b.check_out).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
            icsContent += `BEGIN:VEVENT\nSUMMARY:${b.guest_name}\nDTSTART:${start}\nDTEND:${end}\nDESCRIPTION:PIN: ${b.lock_pin}\nEND:VEVENT\n`;
        });
        icsContent += "END:VCALENDAR";
        res.header('Content-Type', 'text/calendar').send(icsContent);
    } catch(e) { res.status(500).send("ICS Error"); }
});

app.get('/status', async (req, res) => { 
    const s = await getTuyaStatus(); 
    res.json({ is_on: s ? s.value : false }); 
});

app.get('/lock-status', async (req, res) => { 
    const s = await getLockStatus();
    res.json(s || {}); 
});

app.get('/toggle', async (req, res) => { 
    const s = await getTuyaStatus(); 
    if(s) await controlDevice(!s.value); 
    res.json({success:true}); 
});

// --- 10. DIAGNOSTIC ENDPOINT ---
app.get('/test-lock', async (req, res) => {
    const now = new Date();
    const later = new Date(now.getTime() + 60 * 60000); // 1 час валидност
    
    // Диагностика на ID-то
    try {
        const d = await tuya.request({ method: 'GET', path: `/v1.0/devices/${process.env.LOCK_DEVICE_ID}` });
        console.log(`📦 TEST TARGET: ${d.result.name} (${d.result.id})`);
    } catch(e) { console.log("⚠️ Cannot fetch device details"); }

    const result = await createLockPin("654321", "Test_Mode", now, later);
    res.json(result);
});

// --- 11. START SERVER ---
app.listen(PORT, () => {
    console.log(`🚀 Iko Server running on ${PORT}`);
    syncBookingsFromGmail();
    setInterval(syncBookingsFromGmail, 15 * 60 * 1000);
});
