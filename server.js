require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');
const cron = require('node-cron');
const ical = require('node-ical');
const fs = require('fs');

const app = express();

// --- 1. CORS НАСТРОЙКИ ---
app.use(cors({
    origin: [
        'https://stay.bgm-design.com',
        'http://localhost:5500',
        'http://127.0.0.1:5500'
    ],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

app.use(express.json());

// --- 2. SECURITY: BASIC AUTH ---
const basicAuth = (req, res, next) => {
    const user = process.env.ADMIN_USER || 'admin';
    const pass = process.env.ADMIN_PASS || 'smartstay2026';
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
    if (login && password && login === user && password === pass) return next();
    res.set('WWW-Authenticate', 'Basic realm="Smart Stay Admin"');
    res.status(401).send('Authentication required.');
};

app.get(['/admin.html', '/remote.html'], basicAuth, (req, res, next) => next());
app.use(express.static('public'));

// --- 3. ВРЪЗКИ ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const tuya = new TuyaContext({
  baseUrl: 'https://openapi.tuyaeu.com',
  accessKey: process.env.TUYA_ACCESS_ID,
  secretKey: process.env.TUYA_ACCESS_SECRET,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- 4. КЕШ ЗА TUYA ---
let deviceCache = { isOn: false, lastUpdated: 0 };

async function getSmartStatus() {
    const now = Date.now();
    if (now - deviceCache.lastUpdated > 30000) {
        try {
            const data = await tuya.request({ path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/status`, method: 'GET' });
            if(data.success) {
                const sw = data.result.find(i => i.code === 'switch');
                deviceCache.isOn = sw ? sw.value : false;
                deviceCache.lastUpdated = now;
            }
        } catch (e) { console.error("Tuya Status Error:", e.message); }
    }
    return deviceCache.isOn;
}

// --- 5. ЕКСПОРТ НА КАЛЕНДАР (.ics) ---
app.get('/feed.ics', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM bookings");
        let icsData = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//SmartStay//NONSGML v1.0//EN\n";
        
        result.rows.forEach(b => {
            const start = new Date(b.check_in).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
            const end = new Date(b.check_out).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
            icsData += "BEGIN:VEVENT\n";
            icsData += `UID:${b.id}@smartstay.com\n`;
            icsData += `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'}\n`;
            icsData += `DTSTART:${start}\n`;
            icsData += `DTEND:${end}\n`;
            icsData += `SUMMARY:Blocked: ${b.guest_name}\n`;
            icsData += "END:VEVENT\n";
        });
        
        icsData += "END:VCALENDAR";
        res.set('Content-Type', 'text/calendar');
        res.send(icsData);
    } catch (e) {
        console.error(e);
        res.status(500).send("Calendar Error");
    }
});

// --- 6. AI ЧАТ (С ФУНКЦИЯ ЗА РЕЗЕРВЕН МОДЕЛ) ---
app.post('/chat', async (req, res) => {
    const userMessage = req.body.message;

    // Четене на ръководството
    let manualData = "";
    try {
        if (fs.existsSync('manual.txt')) manualData = fs.readFileSync('manual.txt', 'utf8');
    } catch (err) { console.error("No manual found."); }

    const systemInstruction = `
    Ти си Smart Stay Иконом.
    1. ВИДИШ ЛИ КОД (HMxxxx, A1B2C3): Върни САМО "CHECK_CODE: [кодът]".
    2. НЯМА ЛИ КОД: Говори любезно на БГ, ползвайки тези данни:
    ${manualData}
    `;

    // ФУНКЦИЯ ЗА ГЕНЕРИРАНЕ С fallback
    async function generateAIResponse(prompt, instructions) {
        try {
            console.log("🤖 Опит с Gemini 3 Flash Preview...");
            const model = genAI.getGenerativeModel({ model: "gemini-3.0-flash-preview", systemInstruction: instructions });
            const result = await model.generateContent(prompt);
            return result.response.text();
        } catch (error) {
            console.warn("⚠️ Gemini 3 failed. Превключвам на Gemini 2.5 Flash.", error.message);
            try {
                const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", systemInstruction: instructions });
                const result = await model.generateContent(prompt);
                return result.response.text();
            } catch (err2) {
                throw new Error("И двата модела се провалиха.");
            }
        }
    }

    try {
        let botResponse = await generateAIResponse(userMessage, systemInstruction);
        botResponse = botResponse.trim();

        if (botResponse.includes("CHECK_CODE:")) {
            const code = botResponse.split(":")[1].trim().replace(/[\[\]]/g, "");
            const dbRes = await pool.query("SELECT * FROM bookings WHERE reservation_code = $1", [code]);
            const dbData = dbRes.rows.length > 0 ? dbRes.rows[0] : null;

            if (dbData) {
                // Пак викаме AI да оформи отговора
                const prompt = `Резервация намерена: ${JSON.stringify(dbData)}. Поздрави госта, дай му ПИН кода (${dbData.lock_pin}) и му пожелай приятен престой.`;
                botResponse = await generateAIResponse(prompt, systemInstruction);
            } else {
                botResponse = "Не намирам резервация с този код.";
            }
        }
        res.json({ reply: botResponse });
    } catch (err) {
        console.error("AI Error:", err);
        res.json({ reply: "В момента обновяваме системите си. Моля опитайте след малко." });
    }
});

// --- 7. АВТОПИЛОТ (Cron) ---
cron.schedule('*/10 * * * *', async () => {
    try {
        const r = await pool.query("SELECT * FROM bookings WHERE check_in::timestamp < (NOW() AT TIME ZONE 'UTC' + INTERVAL '6 hours') AND check_out::timestamp > (NOW() AT TIME ZONE 'UTC') AND power_on_time IS NULL");
        for (const b of r.rows) {
            await tuya.request({ path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`, method: 'POST', body: { commands: [{ code: 'switch', value: true }] } });
            await pool.query("UPDATE bookings SET power_on_time = NOW() WHERE id = $1", [b.id]);
        }
    } catch (e) { console.error(e); }
});

cron.schedule('*/10 * * * *', async () => {
    try {
        const r = await pool.query("SELECT * FROM bookings WHERE check_out::timestamp < (NOW() AT TIME ZONE 'UTC' - INTERVAL '1 hour') AND check_out::timestamp > (NOW() AT TIME ZONE 'UTC' - INTERVAL '24 hours') AND power_off_time IS NULL");
        for (const b of r.rows) {
            await tuya.request({ path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`, method: 'POST', body: { commands: [{ code: 'switch', value: false }] } });
            await pool.query("UPDATE bookings SET power_off_time = NOW() WHERE id = $1", [b.id]);
        }
    } catch (e) { console