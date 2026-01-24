import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { syncBookingsFromGmail } from './services/detective.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';
import { TuyaContext } from '@tuya/tuya-connector-nodejs';

const app = express();
const PORT = process.env.PORT || 10000;
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// --- TUYA CONFIG (CLOUD) ---
// Използваме ключовете, които имаш в Render. 
// Ако си объркал имената, тези редове (||) ще хванат правилната стойност.
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

// --- TUYA CORE FUNCTIONS (IOT-03 STANDARD) ---
// Използваме пътя от стария код, защото е доказано работещ за твоето устройство

async function getTuyaStatus() {
    // Взимаме статуса през специализирания Electrical Endpoint
    const res = await tuya.request({ 
        method: 'GET', 
        path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/status` 
    });
    // Търсим точно 'switch', както е при електромерите
    return res.result.find(s => s.code === 'switch');
}

async function controlDevice(state) {
    try {
        console.log(`🔌 IOT-03: Изпращане на switch=${state}`);
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

// --- ENDPOINTS ---

app.get('/status', async (req, res) => {
    try {
        const status = await getTuyaStatus();
        res.json({ is_on: status ? status.value : false });
    } catch (err) { res.json({ is_on: false, error: err.message }); }
});

app.get('/toggle', async (req, res) => {
    try {
        const status = await getTuyaStatus();
        if (status) {
            await controlDevice(!status.value);
            res.json({ success: true, new_state: !status.value });
        } else {
            throw new Error("Device switch not found");
        }
    } catch (err) { 
        console.error(err);
        res.status(500).json({ error: "Toggle Failed" }); 
    }
});

// --- SMART AI CHAT (HYBRID MODEL) ---
app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    let systemContext = "";

    // 1. Проверка за код в съобщението (Бърз метод)
    const codeMatch = message.trim().toUpperCase().match(/HM[A-Z0-9]{8,10}/);
    
    if (codeMatch) {
        try {
            const r = await sql`SELECT * FROM bookings WHERE reservation_code = ${codeMatch[0]} LIMIT 1`;
            if (r.length > 0) {
                systemContext = `[СИСТЕМНИ ДАННИ: Намерена е резервация! Гост: ${r[0].guest_name}. ПИН код за вратата: ${r[0].lock_pin}. Предай ПИН кода на госта учтиво.]`;
            } else {
                systemContext = `[СИСТЕМНИ ДАННИ: Кодът ${codeMatch[0]} е валиден формат, но не съществува в базата.]`;
            }
        } catch (e) { console.error("DB Error", e); }
    }

    // 2. Генерация на отговор
    try {
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            systemInstruction: "Ти си Бобо, интелигентен иконом на Smart Stay. Говориш на български. Твоята цел е да помагаш на гостите. Ако получиш СИСТЕМНИ ДАННИ за ПИН код, задължително ги предай на госта."
        });
        
        const result = await model.generateContent(systemContext + "\nПотребител: " + message);
        res.json({ reply: result.response.text() });
    } catch (error) {
        res.json({ reply: "Бобо е малко изморен (AI Error). Моля, опитайте пак." });
    }
});

// --- ADMIN & AUTO ---

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

// Автопилот (на всеки 5 мин)
async function handlePowerAutomation() {
    try {
        const now = new Date();
        const bookings = await sql`SELECT * FROM bookings`;
        for (const b of bookings) {
            const checkIn = new Date(b.check_in);
            const checkOut = new Date(b.check_out);
            
            // Настройки за време: 2 часа преди настаняване / 1 час след напускане
            const onTime = new Date(checkIn.getTime() - (2 * 60 * 60 * 1000));
            const offTime = new Date(checkOut.getTime() + (1 * 60 * 60 * 1000));

            if (now >= onTime && now < offTime && !b.power_on_time) {
                console.log(`💡 Авто-ON: ${b.guest_name}`);
                await controlDevice(true);
                await sql`UPDATE bookings SET power_on_time = NOW() WHERE id = ${b.id}`;
            } else if (now >= offTime && !b.power_off_time) {
                console.log(`🌑 Авто-OFF: ${b.guest_name}`);
                await controlDevice(false);
                await sql`UPDATE bookings SET power_off_time = NOW() WHERE id = ${b.id}`;
            }
        }
    } catch (e) { console.error('Auto Loop Error'); }
}

app.listen(PORT, () => {
    console.log(`🚀 Bobo is live on port ${PORT}`);
    setInterval(syncBookingsFromGmail, 15 * 60 * 1000);
    setInterval(handlePowerAutomation, 5 * 60 * 1000);
});