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
import path from 'path';

// ==================================================================
// --- 0. ГЛОБАЛНИ НАСТРОЙКИ И ИНИЦИАЛИЗАЦИЯ ---
// ==================================================================

const app = express();
const PORT = process.env.PORT || 10000;

// Връзка с Базата Данни (Neon/Postgres)
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

// Връзка с AI (Google Gemini)
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// Middleware (Настройки на Express)
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ==================================================================
// --- 1. НАСТРОЙКА НА ПОЩА (NODEMAILER) ---
// ==================================================================

const mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
    }
});

/**
 * Изпраща известие до администратора при важни събития
 */
async function sendNotification(subject, text) {
    try {
        const info = await mailer.sendMail({
            from: `"Smart Stay Bot" <${process.env.GMAIL_USER}>`,
            to: process.env.GMAIL_USER,
            subject: `⚡ ${subject}`,
            text: text
        });
        console.log(`📧 [EMAIL] Изпратен: ${subject}`);
    } catch (e) {
        console.error("❌ [EMAIL ERROR]:", e.message);
    }
}

// ==================================================================
// --- 2. ЗАРЕЖДАНЕ НА НАРЪЧНИКА (Manual.txt) ---
// ==================================================================

let manualContent = "Липсва файл manual.txt. Моля, създайте го в главната директория.";
try {
    if (fs.existsSync('manual.txt')) {
        manualContent = fs.readFileSync('manual.txt', 'utf8');
        console.log("📖 [SYSTEM] Наръчникът е зареден успешно.");
    }
} catch (err) {
    console.error("❌ [SYSTEM] Грешка при четене на manual.txt:", err);
}

// ==================================================================
// --- 3. TUYA ВРЪЗКА (УМЕН ДОМ) ---
// ==================================================================

const tuya = new TuyaContext({
    baseUrl: 'https://openapi.tuyaeu.com',
    accessKey: process.env.TUYA_ACCESS_ID,
    secretKey: process.env.TUYA_ACCESS_SECRET,
});

/**
 * Управление на релето за тока (Power Switch)
 */
async function controlDevice(state) {
    console.log(`🔌 [POWER] Опит за превключване на тока: ${state ? 'ON' : 'OFF'}`);
    try {
        const response = await tuya.request({
            method: 'POST',
            path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
            body: { commands: [{ code: 'switch', value: state }] }
        });
        return true;
    } catch (e) {
        console.error('❌ [TUYA ERROR] Control Device:', e.message);
        return false;
    }
}

/**
 * Взима текущия статус на тока (ON/OFF)
 */
async function getTuyaStatus() {
    try {
        const res = await tuya.request({
            method: 'GET',
            path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/status`
        });
        return res.result.find(s => s.code === 'switch');
    } catch (e) {
        return null;
    }
}

/**
 * Взима статус на бравата (Lock Status)
 */
async function getLockStatus() {
    try {
        const res = await tuya.request({
            method: 'GET',
            path: `/v1.0/iot-03/devices/${process.env.LOCK_DEVICE_ID}/status`
        });
        return res.result; 
    } catch (e) {
        console.error('❌ [LOCK ERROR] Get Status:', e.message);
        return null;
    }
}

// ==================================================================
// --- 4. УПРАВЛЕНИЕ НА БРАВАТА (3-STEP STRATEGY) ---
// ==================================================================

async function createLockPin(pin, name, checkInDate, checkOutDate) {
    console.log(`🔐 [LOCK] Стартиране на 3-степенна процедура за ${name} (PIN: ${pin})...`);
    
    // ВРЕМЕНА: Връщаме 5 минути назад за буфер, за да избегнем "Time Sync Error"
    const now = new Date();
    const startMs = now.getTime() - 5 * 60000; 
    const endMs = new Date(checkOutDate).getTime();

    let report = [];
    let success = false;

    // --- СТЪПКА 1: TYPE 2 (Periodic) ---
    // Стандартният метод за Gateway брави.
    try {
        console.log("   👉 Опит 1: Gateway Periodic (Type 2)...");
        await tuya.request({
            method: 'POST',
            path: `/v1.0/devices/${process.env.LOCK_DEVICE_ID}/door-lock/temp-password`,
            body: { 
                name: "Guest", 
                password: pin.toString(), 
                start_time: startMs, 
                expire_time: endMs, 
                password_type: 2 
            }
        });
        report.push("✅ Метод 1 (Periodic): ИЗПРАТЕНО УСПЕШНО");
        success = true;
    } catch (e) { 
        report.push(`❌ Метод 1 (Periodic): Грешка (${e.message})`); 
    }

    // --- СТЪПКА 2: TYPE 1 (One-Time) ---
    // Ако първият не сработи (или за подсигуряване).
    if (!success) {
        try {
            console.log("   👉 Опит 2: Gateway One-Time (Type 1)...");
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
            report.push("✅ Метод 2 (One-Time): ИЗПРАТЕНО УСПЕШНО");
            success = true;
        } catch (e) { 
            report.push(`❌ Метод 2 (One-Time): Грешка (${e.message})`); 
        }
    }

    // --- СТЪПКА 3: TICKET (Специално за G30 EU) ---
    // Това е "тежката артилерия" за сигурни брави.
    if (!success) {
        try {
            console.log("   👉 Опит 3: Ticket Method (EU Protocol)...");
            await tuya.request({
                method: 'POST',
                path: `/v1.0/devices/${process.env.LOCK_DEVICE_ID}/door-lock/temp-password`,
                body: { 
                    name: "Guest", 
                    password: pin.toString(), 
                    start_time: startMs, 
                    expire_time: endMs, 
                    password_type: "ticket" // ТОВА Е КЛЮЧЪТ
                }
            });
            report.push("✅ Метод 3 (Ticket): ИЗПРАТЕНО УСПЕШНО");
            success = true;
        } catch (e) { 
            report.push(`❌ Метод 3 (Ticket): Грешка (${e.message})`); 
        }
    }

    console.log("📝 [LOCK REPORT]:", JSON.stringify(report, null, 2));
    return { success, report };
}

// ==================================================================
// --- 5. АВТОПИЛОТ (CRON ЗА ТОКА) ---
// ==================================================================

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
                    console.log(`✅ [AUTO] Пускане на ток за ${b.guest_name}`);
                    await controlDevice(true);
                    await sendNotification("ТОКЪТ Е ПУСНАТ", `Гост: ${b.guest_name}. Настаняване.`);
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
                        console.log(`🛑 [AUTO] Спиране на ток след ${b.guest_name}`);
                        await controlDevice(false);
                        await sendNotification("ТОКЪТ Е СПРЯН", `Гост: ${b.guest_name} напусна.`);
                    }
                }
            }
        }
    } catch (err) { 
        console.error('❌ [CRON ERROR]:', err); 
    }
});

// ==================================================================
// --- 6. ЧАТ БОТ (GEMINI MODELS) ---
// ==================================================================

app.post('/api/chat', async (req, res) => {
    const { message, history, authCode } = req.body;
    
    const powerStatus = await getTuyaStatus();
    const isOnline = powerStatus !== null;
    const currentDateTime = new Date().toLocaleString('bg-BG', { timeZone: 'Europe/Sofia' });

    let bookingData = null;
    let role = "stranger";
    
    const textCodeMatch = message.trim().toUpperCase().match(/HM[A-Z0-9]+/);
    const codeToTest = textCodeMatch ? textCodeMatch[0] : authCode;

    if (codeToTest === process.env.HOST_CODE) {
        role = "host";
    } else if (codeToTest) {
        const r = await sql`SELECT * FROM bookings WHERE reservation_code = ${codeToTest} LIMIT 1`;
        if (r.length > 0) { 
            bookingData = r[0]; 
            role = "guest"; 
        }
    }

    const systemInstruction = `
    Текущо време: ${currentDateTime}.
    Роля на потребителя: ${role}.
    Име на госта: ${bookingData ? bookingData.guest_name : "Неизвестен"}.
    Статус на тока: ${isOnline ? "Онлайн" : "Офлайн"}.
    Наръчник: ${manualContent}.
    Ти си Ико - умен иконом на апартамент в Банско.
    `;
    
    const modelsToTry = ["gemini-3-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"];
    let finalReply = "Съжалявам, Ико има техническо затруднение в момента.";

    for (const modelName of modelsToTry) {
        try {
            const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
            const chat = model.startChat({ history: history || [] });
            const result = await chat.sendMessage(message);
            finalReply = result.response.text();
            break; 
        } catch (error) { 
            console.error(`❌ Грешка с модел ${modelName}:`, error.message); 
        }
    }
    res.json({ reply: finalReply });
});

// ==================================================================
// --- 7. API ЕНДПОЙНТИ ---
// ==================================================================

app.get('/sync', async (req, res) => { 
    try {
        await syncBookingsFromGmail(); 
        res.send('✅ Синхронизацията с Gmail е успешна.'); 
    } catch (e) {
        res.status(500).send('Грешка при синхронизация: ' + e.message);
    }
});

app.get('/bookings', async (req, res) => { 
    try {
        const list = await sql`SELECT * FROM bookings ORDER BY check_in ASC`;
        res.json(list); 
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/bookings/:id', async (req, res) => { 
    try {
        await sql`DELETE FROM bookings WHERE id = ${req.params.id}`; 
        res.send('OK'); 
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.post('/add-booking', async (req, res) => {
    try {
        const { guest_name, reservation_code, check_in, check_out } = req.body;
        const pin = Math.floor(100000 + Math.random() * 899999);
        
        await sql`INSERT INTO bookings (guest_name, reservation_code, check_in, check_out, lock_pin) VALUES (${guest_name}, ${reservation_code}, ${check_in}, ${check_out}, ${pin})`;
        
        createLockPin(pin, guest_name.split(' ')[0], check_in, check_out);
        
        res.send('OK');
    } catch (e) {
        console.error("Add Booking Error:", e);
        res.status(500).send(e.message);
    }
});

app.get('/feed.ics', async (req, res) => {
    try {
        const bookings = await sql`SELECT * FROM bookings`;
        let icsContent = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//SmartStay//Bansko//EN\nCALSCALE:GREGORIAN\nMETHOD:PUBLISH\n";
        
        bookings.forEach(b => {
            const start = new Date(b.check_in).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
            const end = new Date(b.check_out).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
            const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
            
            icsContent += "BEGIN:VEVENT\n";
            icsContent += `UID:${b.reservation_code || b.id}@smartstay.bg\n`;
            icsContent += `DTSTAMP:${stamp}\n`;
            icsContent += `DTSTART:${start}\n`;
            icsContent += `DTEND:${end}\n`;
            icsContent += `SUMMARY:${b.guest_name}\n`;
            icsContent += `DESCRIPTION:Reservation Code: ${b.reservation_code} | PIN: ${b.lock_pin}\n`;
            icsContent += "STATUS:CONFIRMED\n";
            icsContent += "END:VEVENT\n";
        });
        
        icsContent += "END:VCALENDAR";
        
        res.header('Content-Type', 'text/calendar; charset=utf-8');
        res.header('Content-Disposition', 'attachment; filename="calendar.ics"');
        res.send(icsContent);
    } catch (e) {
        console.error("ICS Error:", e);
        res.status(500).send("ICS Generation Error");
    }
});

app.get('/status', async (req, res) => { 
    try {
        const s = await getTuyaStatus(); 
        res.json({ is_on: s ? s.value : false }); 
    } catch (e) {
        res.json({ is_on: false, error: "Tuya Error" });
    }
});

app.get('/lock-status', async (req, res) => {
    const status = await getLockStatus();
    res.json(status || { error: "Няма връзка с бравата" });
});

app.get('/toggle', async (req, res) => { 
    try {
        const s = await getTuyaStatus(); 
        if(s) {
            await controlDevice(!s.value); 
            res.json({success:true, new_state: !s.value}); 
        } else {
            res.status(500).json({success:false, error: "Няма връзка с устройството"});
        }
    } catch(e) {
        res.status(500).json({success:false, error: e.message}); 
    }
});

// --- ДИАГНОСТИЧЕН ТЕСТ ---
app.get('/test-lock', async (req, res) => {
    const now = new Date();
    const later = new Date(now.getTime() + 60 * 60000); 
    
    console.log("🔍 [DIAGNOSTIC] Проверявам какво се крие зад LOCK_DEVICE_ID...");
    try {
        const details = await tuya.request({
            method: 'GET',
            path: `/v1.0/devices/${process.env.LOCK_DEVICE_ID}`
        });
        console.log(`📦 ИМЕ: ${details.result.name} | ID: ${details.result.id}`);
    } catch (e) {
        console.error("⚠️ Грешка при проверка на устройството:", e.message);
    }

    console.log("🛠️ TEST START (Type 1, 2, Ticket)...");
    const result = await createLockPin("654321", "Final_Sync_Test", now, later);
    res.json({ overall_success: result.success, report: result.report });
});

// ==================================================================
// --- 8. СТАРТИРАНЕ НА СЪРВЪРА ---
// ==================================================================

app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🚀 Iko Server is running on port ${PORT}`);
    console.log(`📅 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`=========================================`);
    
    // Първоначална синхронизация при старт
    syncBookingsFromGmail();
    
    // Периодична синхронизация (на всеки 15 мин)
    setInterval(syncBookingsFromGmail, 15 * 60 * 1000);
});
