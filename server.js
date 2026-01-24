import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { syncBookingsFromGmail } from './services/detective.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';
import TuyAPI from 'tuyapi';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// ПРОВЕРКА ЗА TUYA КЛЮЧОВЕ - предотвратява TypeError
let device = null;
if (process.env.TUYA_DEVICE_ID && process.env.TUYA_LOCAL_KEY) {
    device = new TuyAPI({
        id: process.env.TUYA_DEVICE_ID,
        key: process.env.TUYA_LOCAL_KEY,
        ip: process.env.TUYA_DEVICE_IP
    });
} else {
    console.warn("⚠️ ВНИМАНИЕ: Tuya ключовете липсват. Дистанционното няма да работи.");
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
    } catch (e) { res.status(500).send("Грешка при календар"); }
});

// --- АВТОМАТИЗАЦИЯ НА ТОКА ---
async function handlePowerAutomation() {
    if (!device) return;
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
    } catch (err) { console.error('Автоматизация грешка:', err); }
}

async function controlDevice(state) {
    if (!device) return;
    try {
        await device.find();
        await device.connect();
        await device.set({set: state});
        await device.disconnect();
    } catch (e) { console.error('Tuya Error:', e.message); }
}

// --- API ЗА ADMIN & REMOTE ---
app.get('/bookings', async (req, res) => {
    try { res.json(await sql`SELECT * FROM bookings ORDER BY created_at DESC`); } 
    catch (err) { res.status(500).json({ error: err.message }); }
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

app.get('/status', async (req, res) => {
    if (!device) return res.json({ is_on: false, error: "Tuya not configured" });
    try {
        await device.find(); await device.connect();
        const status = await device.get(); await device.disconnect();
        res.json({ is_on: status });
    } catch (err) { res.json({ is_on: false, error: "Offline" }); }
});

app.get('/toggle', async (req, res) => {
    if (!device) return res.status(400).json({ error: "Tuya not configured" });
    try {
        await device.find(); await device.connect();
        const status = await device.get();
        await device.set({set: !status}); await device.disconnect();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Toggle failed" }); }
});

// --- API ЗА ЧАТ ---
app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    const userInput = message.trim();
    if (/^HM[A-Z0-9]{8,10}$/.test(userInput)) {
        try {
            const result = await sql`SELECT * FROM bookings WHERE reservation_code = ${userInput.toUpperCase()} LIMIT 1`;
            if (result.length > 0) return res.json({ reply: `Здравейте! ПИН за вратата: ${result[0].lock_pin}.` });
        } catch (e) {}
    }
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(`Ти си Бобо, иконом. Отговори кратко: ${userInput}`);
    res.json({ reply: result.response.text() });
});

app.listen(PORT, () => {
    console.log(`🚀 Bobo is live on port ${PORT}!`);
    syncBookingsFromGmail();
    setInterval(syncBookingsFromGmail, 15 * 60 * 1000);
    setInterval(handlePowerAutomation, 5 * 60 * 1000);
});