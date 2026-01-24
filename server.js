import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { syncBookingsFromGmail } from './services/detective.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';
import { TuyaContext } from '@tuya/tuya-connector-nodejs';

const app = express();
const PORT = process.env.PORT || 10000;
const sql = neon(process.env.DATABASE_URL);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const tuya = new TuyaContext({
    baseUrl: 'https://openapi.tuyaeu.com',
    accessKey: process.env.TUYA_ACCESS_ID || process.env.TUYA_DEVICE_ID,
    secretKey: process.env.TUYA_ACCESS_SECRET || process.env.TUYA_LOCAL_KEY,
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

async function controlDevice(state) {
    try {
        await tuya.request({
            method: 'POST',
            path: `/v1.0/devices/${process.env.TUYA_DEVICE_ID}/commands`,
            body: { commands: [{ code: 'switch_1', value: state }] }
        });
    } catch (e) { console.error('Cloud Error:', e.message); }
}

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
    } catch (err) { res.status(500).json({ error: "Cloud failed" }); }
} );

app.get('/bookings', async (req, res) => {
    res.json(await sql`SELECT * FROM bookings ORDER BY created_at DESC`);
});

app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    if (/^HM[A-Z0-9]{8,10}$/.test(message.trim())) {
        const r = await sql`SELECT lock_pin FROM bookings WHERE reservation_code = ${message.trim().toUpperCase()} LIMIT 1`;
        if (r.length > 0) return res.json({ reply: `ПИН: ${r[0].lock_pin}` });
    }
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(`Ти си Бобо, иконом. Отговори кратко: ${message}`);
    res.json({ reply: result.response.text() });
});

app.listen(PORT, () => {
    console.log(`🚀 Бобо е на линия на порт ${PORT}`);
    setInterval(syncBookingsFromGmail, 15 * 60 * 1000);
});