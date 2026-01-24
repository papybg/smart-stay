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

// ИЗПОЛЗВАМЕ СТАБИЛЕН МОДЕЛ ЗА ДА НЕ Е "ИДИОТ"
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// TUYA CLOUD CONFIG
const tuya = new TuyaContext({
    baseUrl: 'https://openapi.tuyaeu.com',
    accessKey: process.env.TUYA_ACCESS_ID || process.env.TUYA_DEVICE_ID,
    secretKey: process.env.TUYA_ACCESS_SECRET || process.env.TUYA_LOCAL_KEY,
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- TUYA HELPERS ---
async function getTuyaStatus(deviceId) {
    const res = await tuya.request({ method: 'GET', path: `/v1.0/devices/${deviceId}/status` });
    if (!res.result) throw new Error("No status returned");
    // Търсим първия ключ, който прилича на прекъсвач (switch_1, switch, led_switch)
    return res.result.find(s => s.code.includes('switch'));
}

async function controlDevice(state) {
    const deviceId = process.env.TUYA_DEVICE_ID;
    try {
        // Първо виждаме как се казва кода на прекъсвача (switch_1 или само switch)
        const statusItem = await getTuyaStatus(deviceId);
        const codeName = statusItem ? statusItem.code : 'switch_1';
        
        console.log(`🔌 Опит за превключване на ${codeName} към ${state}`);
        
        await tuya.request({
            method: 'POST',
            path: `/v1.0/devices/${deviceId}/commands`,
            body: { commands: [{ code: codeName, value: state }] }
        });
    } catch (e) { console.error('Tuya Error:', e.message); }
}

// --- ENDPOINTS ---

app.get('/status', async (req, res) => {
    try {
        const item = await getTuyaStatus(process.env.TUYA_DEVICE_ID);
        res.json({ is_on: item ? item.value : false });
    } catch (err) { res.json({ is_on: false, error: err.message }); }
});

app.get('/toggle', async (req, res) => {
    try {
        const item = await getTuyaStatus(process.env.TUYA_DEVICE_ID);
        if (item) {
            await controlDevice(!item.value);
            res.json({ success: true, new_state: !item.value });
        } else {
            throw new Error("Device switch not found");
        }
    } catch (err) { 
        console.error(err);
        res.status(500).json({ error: "Toggle Failed: " + err.message }); 
    }
});

// --- SMART AI CHAT (ПОПРАВЕН) ---
app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    const cleanMsg = message.trim().toUpperCase();
    let contextData = "";

    // 1. Проверка: Ако потребителят споменава код (дори в изречение)
    const codeMatch = cleanMsg.match(/HM[A-Z0-9]{8,10}/);
    if (codeMatch) {
        try {
            const booking = await sql`SELECT * FROM bookings WHERE reservation_code = ${codeMatch[0]} LIMIT 1`;
            if (booking.length > 0) {
                contextData = `[СИСТЕМНА БЕЛЕЖКА: Потребителят пита за резервация ${booking[0].reservation_code}. 
                Гост: ${booking[0].guest_name}. 
                Настаняване: ${booking[0].check_in}. 
                ПИН КОД ЗА ВРАТАТА: ${booking[0].lock_pin}.
                Предай му ПИН кода учтиво.]`;
            } else {
                contextData = `[СИСТЕМНА БЕЛЕЖКА: Потребителят даде код ${codeMatch[0]}, но той не съществува в базата.]`;
            }
        } catch (e) { console.error("DB Error", e); }
    }

    try {
        // Използваме 1.5 Pro или Flash, който е по-умен от старите модели
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            systemInstruction: "Ти си Бобо, витуален иконом на апартаменти Smart Stay. Твоята задача е да помагаш на гостите с настаняването. Бъди учтив, кратък и услужлив. Ако имаш информация за ПИН код в системната бележка, дай го на потребителя. Ако не знаеш нещо, кажи, че ще провериш при администратора."
        });

        const chat = model.startChat({
            history: [],
        });

        const result = await chat.sendMessage(contextData + "\nПотребител: " + message);
        res.json({ reply: result.response.text() });
    } catch (error) {
        console.error("AI Error:", error);
        res.json({ reply: "Съжалявам, в момента връзката с мозъка ми е прекъсната. Моля, свържете се с хоста." });
    }
});

// --- ADMIN & SYNC ---
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

// --- AUTO LOOP ---
async function handlePowerAutomation() {
    try {
        const now = new Date();
        const bookings = await sql`SELECT * FROM bookings`;
        for (const b of bookings) {
            const checkIn = new Date(b.check_in);
            const checkOut = new Date(b.check_out);
            const onTime = new Date(checkIn.getTime() - (2 * 60 * 60 * 1000));
            const offTime = new Date(checkOut.getTime() + (1 * 60 * 60 * 1000));

            if (now >= onTime && now < offTime && !b.power_on_time) {
                console.log(`💡 Авто-Включване за ${b.guest_name}`);
                await controlDevice(true);
                await sql`UPDATE bookings SET power_on_time = NOW() WHERE id = ${b.id}`;
            } else if (now >= offTime && !b.power_off_time) {
                console.log(`🌑 Авто-Изключване след ${b.guest_name}`);
                await controlDevice(false);
                await sql`UPDATE bookings SET power_off_time = NOW() WHERE id = ${b.id}`;
            }
        }
    } catch (e) { console.error('Auto Loop Error:', e.message); }
}

app.listen(PORT, () => {
    console.log(`🚀 Bobo is live on port ${PORT}`);
    setInterval(syncBookingsFromGmail, 15 * 60 * 1000);
    setInterval(handlePowerAutomation, 5 * 60 * 1000);
});