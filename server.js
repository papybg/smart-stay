import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import fs from 'fs';
import { syncBookingsFromGmail } from './services/detective.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';

// ==========================================
// 1. ИНИЦИАЛИЗАЦИЯ И НАСТРОЙКИ
// ==========================================
const app = express();
const PORT = process.env.PORT || 10000;
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ==========================================
// 2. МОСТ КЪМ TASKER (ПРЕЗ JOIN И FETCH)
// ==========================================
async function sendToTasker(command, text) {
    const JOIN_API_KEY = process.env.JOIN_API_KEY;
    const JOIN_DEVICE_ID = process.env.JOIN_DEVICE_ID;
    
    const message = `${command}:::${text}`; 
    const url = `https://joinjoaomgcd.appspot.com/_ah/api/messaging/v1/sendPush?apikey=${JOIN_API_KEY}&deviceId=${JOIN_DEVICE_ID}&text=${encodeURIComponent(message)}`;

    try {
        // Използваме вградения fetch вместо axios
        const response = await fetch(url);
        if (response.ok) {
            console.log(`📲 [TASKER BRIDGE] Изпратено: ${command}`);
            return true;
        }
        return false;
    } catch (e) {
        console.error("❌ [JOIN FETCH ERROR]:", e.message);
        return false;
    }
}

// ==========================================
// 3. ФУНКЦИИ ЗА УПРАВЛЕНИЕ (ПЛАН Б)
// ==========================================

async function createLockPin(pin, name) {
    console.log(`🔐 [LOCK] Заявка за ПИН ${pin} към Motorola...`);
    return await sendToTasker("SET_LOCK_PIN", `${pin}|${name}`);
}

async function controlPower(state) {
    const cmd = state ? "POWER_ON" : "POWER_OFF";
    console.log(`🔌 [POWER] Заявка за ток: ${cmd}`);
    return await sendToTasker(cmd, "relay");
}

// ==========================================
// 4. АВТОПИЛОТ (CRON ЗА ТОКА)
// ==========================================
cron.schedule('*/1 * * * *', async () => {
    try {
        const bookings = await sql`SELECT * FROM bookings`;
        const now = new Date();
        for (const b of bookings) {
            if (!b.power_on_time || !b.power_off_time) continue;
            const start = new Date(b.power_on_time);
            const end = new Date(b.power_off_time);

            if (now >= start && now < end) {
                await controlPower(true);
            } 
            else if (now >= end && now < new Date(end.getTime() + 5*60000)) {
                await controlPower(false);
            }
        }
    } catch (err) { console.error("Cron Error:", err); }
});

// ==========================================
// 5. ЧАТ БОТ (GEMINI МОДЕЛИ)
// ==========================================
app.post('/api/chat', async (req, res) => {
    const { message, history, authCode } = req.body;
    const currentDateTime = new Date().toLocaleString('bg-BG', { timeZone: 'Europe/Sofia' });
    
    let role = (authCode === process.env.HOST_CODE) ? "host" : "stranger";
    let bookingData = null;
    
    const textCodeMatch = message.trim().toUpperCase().match(/HM[A-Z0-9]+/);
    const codeToTest = textCodeMatch ? textCodeMatch[0] : authCode;
    
    if (codeToTest && codeToTest !== process.env.HOST_CODE) {
        const r = await sql`SELECT * FROM bookings WHERE reservation_code = ${codeToTest} LIMIT 1`;
        if (r.length > 0) { 
            bookingData = r[0]; 
            role = "guest"; 
        }
    }

    let manualContent = "Липсва manual.txt";
    try { 
        if (fs.existsSync('manual.txt')) manualContent = fs.readFileSync('manual.txt', 'utf8'); 
    } catch(e) {}

    const systemInstruction = `Време: ${currentDateTime}. Роля: ${role}. Наръчник: ${manualContent}. Ти си Ико.`;
    
    const modelsToTry = ["gemini-3-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"];
    let finalReply = "Ико има техническо затруднение.";

    for (const modelName of modelsToTry) {
        try {
            const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
            const chat = model.startChat({ history: history || [] });
            const result = await chat.sendMessage(message);
            finalReply = result.response.text();
            break; 
        } catch (error) { 
            console.error(`❌ Грешка при ${modelName}:`, error.message); 
        }
    }
    res.json({ reply: finalReply });
});

// ==========================================
// 6. API ЕНДПОЙНТИ
// ==========================================

app.get('/sync', async (req, res) => { 
    try {
        await syncBookingsFromGmail(); 
        res.send('✅ Синхронизирано успешно.'); 
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
        
        await sql`INSERT INTO bookings (guest_name, reservation_code, check_in, check_out, lock_pin) 
                  VALUES (${guest_name}, ${reservation_code}, ${check_in}, ${check_out}, ${pin})`;
        
        await createLockPin(pin, guest_name.split(' ')[0]);
        
        res.send('OK');
    } catch(e) { res.status(500).send(e.message); }
});

app.get('/feed.ics', async (req, res) => {
    try {
        const bookings = await sql`SELECT * FROM bookings`;
        let ics = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//SmartStay//EN\n";
        bookings.forEach(b => {
            const start = new Date(b.check_in).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
            const end = new Date(b.check_out).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
            ics += `BEGIN:VEVENT\nSUMMARY:${b.guest_name}\nDTSTART:${start}\nDTEND:${end}\nDESCRIPTION:PIN: ${b.lock_pin}\nEND:VEVENT\n`;
        });
        ics += "END:VCALENDAR";
        res.header('Content-Type', 'text/calendar').send(ics);
    } catch(e) { res.status(500).send("Error"); }
});

app.get('/test-lock', async (req, res) => {
    const ok = await sendToTasker("SET_LOCK_PIN", "123456|TestGuest");
    res.json({ success: ok, target: "Motorola G40", message: "Провери телефона!" });
});

app.get('/test-power', async (req, res) => {
    const ok = await controlPower(true);
    res.json({ success: ok, command: "POWER_ON" });
});

// ==========================================
// 7. СТАРТ НА СЪРВЪРА
// ==========================================
app.listen(PORT, () => {
    console.log(`🚀 Iko Tasker-Bridge Server running on ${PORT}`);
    syncBookingsFromGmail();
    setInterval(syncBookingsFromGmail, 15 * 60 * 1000);
});