require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');
const cron = require('node-cron');
const ical = require('node-ical');

const app = express();

// --- ВАЖНО: CORS НАСТРОЙКИ ЗА ТВОЯ САЙТ ---
// Това позволява на stay.bgm-design.com да "вижда" сървъра
app.use(cors({
    origin: [
        'https://stay.bgm-design.com', // Твоят официален сайт
        'http://localhost:5500',       // За локални тестове
        'http://127.0.0.1:5500'
    ],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

app.use(express.json());

// --- SECURITY: BASIC AUTH (За админ панела) ---
const basicAuth = (req, res, next) => {
    const user = process.env.ADMIN_USER || 'admin';
    const pass = process.env.ADMIN_PASS || 'smartstay2026';
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
    if (login && password && login === user && password === pass) return next();
    res.set('WWW-Authenticate', 'Basic realm="Smart Stay Admin"');
    res.status(401).send('Authentication required.');
};

// Защитаваме админските панели
app.get(['/admin.html', '/remote.html'], basicAuth, (req, res, next) => next());
app.use(express.static('public'));

// --- DB CONNECTION ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- TUYA SMART HOME ---
const tuya = new TuyaContext({
  baseUrl: 'https://openapi.tuyaeu.com',
  accessKey: process.env.TUYA_ACCESS_ID,
  secretKey: process.env.TUYA_ACCESS_SECRET,
});

// --- GEMINI AI ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- CACHE SYSTEM (Пестене на заявки към Tuya) ---
let deviceCache = {
    isOn: false,
    lastUpdated: 0
};

// Помощна функция: Взима статус интелигентно
async function getSmartStatus() {
    const now = Date.now();
    // Ако кешът е по-стар от 30 секунди, питаме Tuya
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

// --- DB MIGRATION TOOL (Ако липсват колони) ---
app.get('/update-db', basicAuth, async (req, res) => {
    try {
        await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS power_on_time TIMESTAMP");
        await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS power_off_time TIMESTAMP");
        res.send("✅ Базата данни е обновена успешно!");
    } catch (e) { res.status(500).send("Грешка: " + e.message); }
});

// --- АВТОПИЛОТ: ВКЛЮЧВАНЕ (6 часа преди check-in) ---
cron.schedule('*/10 * * * *', async () => {
    try {
        // Търсим резервации, които започват след по-малко от 6 часа UTC
        const query = `
            SELECT * FROM bookings 
            WHERE check_in::timestamp < (NOW() AT TIME ZONE 'UTC' + INTERVAL '6 hours')
            AND check_out::timestamp > (NOW() AT TIME ZONE 'UTC')
            AND power_on_time IS NULL
        `;
        const result = await pool.query(query);
        
        for (const booking of result.rows) {
            console.log(`🛎️ Автопилот: Опит за пускане на ток за ${booking.guest_name}`);
            
            // Пускаме тока
            await tuya.request({
                path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
                method: 'POST',
                body: { commands: [{ code: 'switch', value: true }] }
            });

            // Обновяваме кеша
            deviceCache.isOn = true;
            deviceCache.lastUpdated = Date.now();

            // Записваме в базата, че сме го пуснали
            await pool.query("UPDATE bookings SET power_on_time = NOW() WHERE id = $1",