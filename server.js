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

// ТУЯ ОБЛАЧНА ВРЪЗКА
const tuya = new TuyaContext({
    baseUrl: 'https://openapi.tuyaeu.com',
    accessKey: process.env.TUYA_ACCESS_ID || process.env.TUYA_DEVICE_ID,
    secretKey: process.env.TUYA_ACCESS_SECRET || process.env.TUYA_LOCAL_KEY,
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- iCAL ГЕНЕРАТОР ---
app.get('/calendar.ics', async (req, res) => {
    try {
        const bookings = await sql`SELECT * FROM bookings`;
        let icsContent = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//SmartStay//Bobo//BG\n";
        bookings.forEach(b => {
            const start = new Date(b.check_in).toISOString().replace(/[-:]/g, '').split('.')[0] + "Z";
            const end = new Date(b.check_out).toISOString().replace(/[-:]/g, '').split('.')[0] + "Z";
            icsContent += `BEGIN:VEVENT\nUID:${b.id}@smartstay\nDTSTART:${start}\nDTEND:${end}\nSUMMARY:Резервация: ${b.guest_name}\nEND:VEVENT\n`;
        });
        icsContent += "END:VCALENDAR";
        res.setHeader('Content-Type', 'text/calendar');
        res.send(icsContent);
    } catch (e) { res.status(500).send("Cal Error"); }
});

// --- АВТОМАТИЗАЦИЯ НА ТОКА ---
async function handlePowerAutomation() {
    try {
        const now = new Date();
        const bookings = await sql`SELECT * FROM bookings`;
        for (const b of bookings) {
            const checkIn = new Date(b.check_in);
            const checkOut = new Date(b.check_out);
            const powerOnTime = new Date(checkIn.getTime() - (2 * 60 * 60 * 1000));
            const powerOffTime = new Date(checkOut.getTime() + (1 * 60 * 60 * 1000));

            if (now >= powerOnTime && now < powerOffTime && !b.power_on_time) {
                await controlDevice(true);
                await sql`UPDATE bookings SET power_on_time = NOW() WHERE id = ${b.id}`;
            } else if (now >= powerOffTime && !b.power_off_time) {
                await controlDevice(false);
                await sql`UPDATE bookings SET power_off_time = NOW() WHERE id = ${b.id}`;
            }
        }
    } catch (err) { console.error('Auto Error:', err.message); }
}

async function controlDevice(state) {
    try {
        await tuya.request({
            method: 'POST',
            path: `/v1.0/devices/${process.env.TUYA_DEVICE_ID}/commands`,
            body: { commands: [{ code: 'switch_1', value: state }] }
        });
    } catch (e) { console.error('Cloud Cmd Error:', e.message); }
}

// --- ENDPOINTS ---
app.get('/status', async (req, res) => {
    try {
        const r = await tuya.request({ method: 'GET', path: `/v1.0/devices/${process.env.TUYA_DEVICE_ID}/status` });
        const sw = r.result.find(s => s.code.includes('switch'));
        res.json({ is_on: sw ? sw.value : false });
    } catch (err) { res.json({ is_on: false }); }
});

app.get('/toggle', async (req, res) => {
    try {
        const r = await tuya.request({ method: 'GET', path: `/v1.0/devices/${process.env.TUYA_DEVICE_ID}/status` });
        const sw = r.result.find(s => s.code.includes('switch'));
        await controlDevice(!sw.value);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Toggle Failed" }); }
});

app.get('/bookings', async (req, res) => {
    try { res.json(await sql`SELECT * FROM bookings ORDER BY created_at DESC`); }
    catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/add-booking', async (req, res) => {
    const { guest_name, check_in, check_out, reservation_code } = req.body;
    const pin = Math.floor(1000 + Math.random() * 9000);
    try {
        const result = await sql`
            INSERT INTO bookings (guest_name, check_in, check_out, reservation_code, lock_pin, payment_status)
            VALUES (${guest_name}, ${check_in}, ${check_out}, ${reservation_code}, ${pin}, 'paid')
            RETURNING *;
        `;
        res.json({ success: true, pin: pin, booking: result[0] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/bookings/:id', async (req, res) => {
    try { await sql`DELETE FROM bookings WHERE id = ${req.params.id}`; res.json({ success: true }); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    if (/^HM[A-Z0-9]{8,10}$/.test(message.trim())) {
        try {
            const r = await sql`SELECT lock_pin FROM bookings WHERE reservation_code = ${message.trim().toUpperCase()} LIMIT 1`;
            if (r.length > 0) return res.json({ reply: `ПИН: ${r[0].lock_pin}` });
        } catch(e) {}
    }
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(`Ти си Бобо, иконом. Отговори кратко: ${message}`);
    res.json({ reply: result.response.text() });
});

app.listen(PORT, () => {
    console.log(`🚀 Бобо е на линия на порт ${PORT}`);
    setInterval(syncBookingsFromGmail, 15 * 60 * 1000);
    setInterval(handlePowerAutomation, 5 * 60 * 1000);
});