import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron'; // Задължително
import { syncBookingsFromGmail } from './services/detective.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';
import { TuyaContext } from '@tuya/tuya-connector-nodejs';

const app = express();
const PORT = process.env.PORT || 10000;
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// --- TUYA CONFIG ---
const tuyaUser = process.env.TUYA_ACCESS_ID || process.env.TUYA_DEVICE_ID;
const tuyaKey = process.env.TUYA_ACCESS_SECRET || process.env.TUYA_LOCAL_KEY;

const tuya = new TuyaContext({
    baseUrl: 'https://openapi.tuyaeu.com',
    accessKey: tuyaUser,
    secretKey: tuyaKey,
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- TUYA ФУНКЦИИ (ПО СТАНДАРТ IOT-03 ОТ СТАРИЯ КОД) ---

async function controlDevice(state) {
    try {
        console.log(`🔌 Tuya IOT-03: Задаване на switch=${state}`);
        await tuya.request({
            method: 'POST',
            path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
            body: { 
                commands: [{ code: 'switch', value: state }] 
            }
        });
        return true;
    } catch (e) { 
        console.error('Tuya Error:', e.message); 
        return false;
    }
}

async function getTuyaStatus() {
    try {
        const res = await tuya.request({ 
            method: 'GET', 
            path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/status` 
        });
        // Търсим точно 'switch' (стандарт за електромери)
        return res.result.find(s => s.code === 'switch');
    } catch (e) { return null; }
}

// --- АВТОПИЛОТ (CRON) ---
cron.schedule('*/10 * * * *', async () => {
    console.log("⏰ CRON: Проверка на графика...");
    try {
        const bookings = await sql`SELECT * FROM bookings`;
        const now = new Date();

        for (const b of bookings) {
            const checkIn = new Date(b.check_in);
            const checkOut = new Date(b.check_out);
            const onTime = new Date(checkIn.getTime() - (2 * 60 * 60 * 1000));
            const offTime = new Date(checkOut.getTime() + (1 * 60 * 60 * 1000));

            if (now >= onTime && now < offTime && !b.power_on_time) {
                console.log(`💡 АВТО: Пускане за ${b.guest_name}`);
                await controlDevice(true);
                await sql`UPDATE bookings SET power_on_time = NOW() WHERE id = ${b.id}`;
            } 
            else if (now >= offTime && !b.power_off_time) {
                console.log(`🌑 АВТО: Спиране след ${b.guest_name}`);
                await controlDevice(false);
                await sql`UPDATE bookings SET power_off_time = NOW() WHERE id = ${b.id}`;
            }
        }
    } catch (err) { console.error('Cron Error:', err); }
});

// --- ENDPOINTS ---
app.get('/status', async (req, res) => {
    try {
        const status = await getTuyaStatus();
        res.json({ is_on: status ? status.value : false });
    } catch (err) { res.json({ is_on: false }); }
});

app.get('/toggle', async (req, res) => {
    try {
        const status = await getTuyaStatus();
        if (status) {
            await controlDevice(!status.value);
            res.json({ success: true, new_state: !status.value });
        } else {
            res.status(500).json({ error: "Device not found" });
        }
    } catch (err) { res.status(500).json({ error: "Fail" }); }
});

// --- SMART AI (FAILOVER SYSTEM) ---
app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    let systemInfo = "";

    // 1. Проверка за код
    const codeMatch = message.trim().toUpperCase().match(/HM[A-Z0-9]{8,10}/);
    if (codeMatch) {
        try {
            const r = await sql`SELECT * FROM bookings WHERE reservation_code = ${codeMatch[0]} LIMIT 1`;
            if (r.length > 0) {
                systemInfo = `[СИСТЕМНА ИНФОРМАЦИЯ: Клиентът е с резервация! Име: ${r[0].guest_name}. ПИН КОД: ${r[0].lock_pin}. Предай му кода учтиво.]`;
            } else {
                systemInfo = `[СИСТЕМНА ИНФОРМАЦИЯ: Кодът ${codeMatch[0]} не е намерен.]`;
            }
        } catch (e) { console.error("DB Error", e); }
    }

    // 2. Списък с модели за пробване (по ред)
    const modelsToTry = ["gemini-3-flash-preview", "gemini-2.5-flash", "gemini-1.5-flash"];
    let finalReply = "Съжалявам, Бобо има технически проблем с мозъка.";

    for (const modelName of modelsToTry) {
        try {
            console.log(`🤖 Опит с модел: ${modelName}`);
            const model = genAI.getGenerativeModel({ 
                model: modelName, 
                systemInstruction: "Ти си Бобо - умен иконом на Smart Stay. Отговаряй кратко и учтиво на български. Ако имаш СИСТЕМНА ИНФОРМАЦИЯ с ПИН код, предай го."
            });
            
            const result = await model.generateContent(systemInfo + "\nКлиент: " + message);
            finalReply = result.response.text();
            
            // Ако сме тук, значи е успешно -> спираме цикъла
            break; 
        } catch (error) {
            console.warn(`⚠️ Грешка с ${modelName}:`, error.message);
            // Продължаваме към следващия модел в списъка...
        }
    }

    res.json({ reply: finalReply });
});

// --- ADMIN ---
app.get('/bookings', async (req, res) => {
    res.json(await sql`SELECT * FROM bookings ORDER BY created_at DESC`);
});

app.post('/add-booking', async (req, res) => {
    const { guest_name, check_in, check_out, reservation_code } = req.body;
    const pin = Math.floor(1000 + Math.random() * 9000);
    try {
        const r = await sql`
            INSERT INTO bookings (guest_name, check_in, check_out, reservation_code, lock_pin, payment_status)
            VALUES (${guest_name}, ${check_in}, ${check_out}, ${reservation_code}, ${pin}, 'paid') RETURNING *`;
        res.json({ success: true, pin, booking: r[0] });
    } catch (e) { res.status(500).json({error: e.message}); }
});

app.delete('/bookings/:id', async (req, res) => {
    await sql`DELETE FROM bookings WHERE id = ${req.params.id}`;
    res.json({success: true});
});

app.get('/calendar.ics', async (req, res) => {
    try {
        const bookings = await sql`SELECT * FROM bookings`;
        let ics = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Bobo//BG\n";
        bookings.forEach(b => {
            const s = new Date(b.check_in).toISOString().replace(/[-:]/g, '').split('.')[0] + "Z";
            const e = new Date(b.check_out).toISOString().replace(/[-:]/g, '').split('.')[0] + "Z";
            ics += `BEGIN:VEVENT\nUID:${b.id}\nDTSTART:${s}\nDTEND:${e}\nSUMMARY:${b.guest_name}\nEND:VEVENT\n`;
        });
        ics += "END:VCALENDAR";
        res.setHeader('Content-Type', 'text/calendar');
        res.send(ics);
    } catch (e) { res.status(500).send("Err"); }
});

app.listen(PORT, () => {
    console.log(`🚀 Bobo is live on port ${PORT}`);
    syncBookingsFromGmail();
    setInterval(syncBookingsFromGmail, 15 * 60 * 1000);
});