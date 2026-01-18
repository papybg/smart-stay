require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');
const cron = require('node-cron');
const ical = require('node-ical');

const app = express();

// --- 1. CORS НАСТРОЙКИ (Връзка с твоя сайт) ---
app.use(cors({
    origin: [
        'https://stay.bgm-design.com',  // Твоят официален сайт
        'http://localhost:5500',        // За локални тестове
        'http://127.0.0.1:5500'
    ],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

app.use(express.json());

// --- 2. SECURITY: BASIC AUTH (За админ панела) ---
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

// --- 3. ВРЪЗКИ (DB, TUYA, AI) ---
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

// --- 4. КЕШ СИСТЕМА ЗА TUYA ---
let deviceCache = {
    isOn: false,
    lastUpdated: 0
};

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

// --- 5. УМЕН AI ЧАТ (Подобрен) ---
app.post('/chat', async (req, res) => {
    const userMessage = req.body.message;

    // ИНСТРУКЦИИ ЗА ИНТЕЛЕКТА НА АГЕНТА
    const systemInstruction = `
    Ти си Smart Stay Иконом - любезен, интелигентен и услужлив AI домакин.
    
    ТВОИТЕ ЗАДАЧИ:
    1. ИДЕНТИФИКАЦИЯ НА КОД:
       - Ако потребителят напише текст, който прилича на код (напр. "HM12345", "RES-555", "A1B2C3"), ВЕДНАГА приеми, че това е кодът им.
       - Върни САМО: "CHECK_CODE: [кодът]".
    
    2. СВОБОДЕН РАЗГОВОР:
       - Ако няма код, разговаряй свободно и любезно на БЪЛГАРСКИ.
       - Отговаряй на въпроси за апартамента.
    
    3. ЗНАНИЕ ЗА АПАРТАМЕНТА:
       - Настаняване: След 14:00 часа.
       - Напускане: До 11:00 часа.
       - Wi-Fi: Мрежа "SmartStay_Guest", парола "welcome2026".
       - Паркиране: Свободно пред блока.
       - Топла вода: Бойлерът е автоматичен.
       - Спешен телефон: 0888 123 456.
    `;

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash", systemInstruction });
        let result = await model.generateContent(userMessage);
        let botResponse = result.response.text().trim();

        // Ако AI открие код, проверяваме в базата
        if (botResponse.includes("CHECK_CODE:")) {
            const code = botResponse.split(":")[1].trim().replace(/[\[\]]/g, "");
            console.log("🔍 AI Checking Code:", code);

            const dbRes = await pool.query("SELECT * FROM bookings WHERE reservation_code = $1", [code]);
            const dbData = dbRes.rows.length > 0 ? dbRes.rows[0] : null;

            if (dbData) {
                // Връщаме данните на AI за оформяне
                const finalResult = await model.generateContent(`
                    Намерих резервацията! Ето данните: ${JSON.stringify(dbData)}.
                    Поздрави госта по име (${dbData.guest_name}).
                    Дай му ПИН кода за вратата: ${dbData.lock_pin}.
                    Пожелай му приятен престой.
                `);
                botResponse = finalResult.response.text();
            } else {
                botResponse = "Съжалявам, но не откривам активна резервация с код " + code + ". Моля проверете дали го изписвате правилно.";
            }
        }
        res.json({ reply: botResponse });
    } catch (err) {
        console.error("AI Error:", err);
        res.json({ reply: "Моля опитайте пак, имам малък технически проблем." });
    }
});

// --- 6. АВТОПИЛОТ (Cron Jobs) ---

// ВКЛЮЧВАНЕ (6 часа преди check-in)
cron.schedule('*/10 * * * *', async () => {
    try {
        const query = `
            SELECT * FROM bookings 
            WHERE check_in::timestamp < (NOW() AT TIME ZONE 'UTC' + INTERVAL '6 hours')
            AND check_out::timestamp > (NOW() AT TIME ZONE 'UTC')
            AND power_on_time IS NULL
        `;
        const result = await pool.query(query);
        
        for (const booking of result.rows) {
            console.log(`🛎️ Автопилот: Пускам тока за ${booking.guest_name}`);
            await tuya.request({
                path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
                method: 'POST',
                body: { commands: [{ code: 'switch', value: true }] }
            });
            deviceCache.isOn = true;
            deviceCache.lastUpdated = Date.now();
            await pool.query("UPDATE bookings SET power_on_time = NOW() WHERE id = $1", [booking.id]);
        }
    } catch (err) { console.error('Cron ON error:', err); }
});

// ИЗКЛЮЧВАНЕ (1 час след check-out)
cron.schedule('*/10 * * * *', async () => {
    try {
        const query = `
            SELECT * FROM bookings 
            WHERE check_out::timestamp < (NOW() AT TIME ZONE 'UTC' - INTERVAL '1 hour') 
            AND check_out::timestamp > (NOW() AT TIME ZONE 'UTC' - INTERVAL '24 hours')
            AND power_off_time IS NULL
        `;
        const result = await pool.query(query);
        
        for (const booking of result.rows) {
            console.log(`🌑 Автопилот: Спирам тока след ${booking.guest_name}`);
            await tuya.request({
                path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
                method: 'POST',
                body: { commands: [{ code: 'switch', value: false }] }
            });
            deviceCache.isOn = false;
            deviceCache.lastUpdated = Date.now();
            await pool.query("UPDATE bookings SET power_off_time = NOW() WHERE id = $1", [booking.id]);
        }
    } catch (err) { console.error('Cron OFF error:', err); }
});

// --- 7. AIRBNB SYNC ---
const syncAirbnb = async () => {
    console.log("🔄 Airbnb Sync...");
    const icalUrl = process.env.AIRBNB_ICAL_URL;
    if (!icalUrl) return;

    try {
        const events = await ical.async.fromURL(icalUrl);
        for (const k in events) {
            const ev = events[k];
            if (ev.type !== 'VEVENT') continue;

            const checkIn = new Date(ev.start);
            const checkOut = new Date(ev.end);
            
            let resCode = ev.uid; 
            const desc = ev.description || "";
            const codeMatch = desc.match(/(HM[A-Z0-9]{8})/);
            if (codeMatch) resCode = codeMatch[1];
            const guestName = ev.summary || "Airbnb Guest";

            const exists = await pool.query("SELECT id FROM bookings WHERE reservation_code = $1", [resCode]);
            if (exists.rows.length === 0) {
                console.log(`🆕 New Booking: ${guestName}`);
                const pin = Math.floor(100000 + Math.random() * 900000).toString();
                await pool.query(
                    "INSERT INTO bookings (guest_name, check_in, check_out, reservation_code, lock_pin, payment_status) VALUES ($1, $2, $3, $4, $5, 'paid')",
                    [guestName, checkIn, checkOut, resCode, pin]
                );
            }
        }
    } catch (err) { console.error("Airbnb Error:", err.message); }
};
cron.schedule('*/30 * * * *', syncAirbnb);

// --- 8. API ROUTES ---

app.get('/update-db', basicAuth, async (req, res) => {
    try {
        await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS power_on_time TIMESTAMP");
        await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS power_off_time TIMESTAMP");
        res.send("✅ Базата данни е обновена.");
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/status', basicAuth, async (req, res) => {
    try { const isOn = await getSmartStatus(); res.json({ is_on: isOn }); } 
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/toggle', basicAuth, async (req, res) => {
    try {
        const current = await getSmartStatus();
        await tuya.request({
            path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
            method: 'POST',
            body: { commands: [{ code: 'switch', value: !current }] }
        });
        deviceCache.isOn = !current;
        deviceCache.lastUpdated = Date.now();
        res.send(`OK: ${!current}`);
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/add-booking', basicAuth, async (req, res) => {
    const { guest_name, check_in, check_out, reservation_code } = req.body;
    if (!guest_name || !check_in || !check_out || !reservation_code) return res.status(400).json({ error: "Липсват данни!" });

    try {
        const codeCheck = await pool.query("SELECT id FROM bookings WHERE reservation_code = $1", [reservation_code]);
        if (codeCheck.rows.length > 0) return res.status(400).json({ error: "Дублиран код!" });

        const pin = Math.floor(100000 + Math.random() * 900000).toString();
        const result = await pool.query(
            "INSERT INTO bookings (guest_name, check_in, check_out, reservation_code, lock_pin, payment_status) VALUES ($1, $2, $3, $4, $5, 'paid') RETURNING lock_pin",
            [guest_name, check_in, check_out, reservation_code, pin]
        );
        res.json({ success: true, pin: result.rows[0].lock_pin });
    } catch (err) { res.status(500).json({ error: "Грешка при запис." }); }
});

app.get('/bookings', basicAuth, async (req, res) => {
    const result = await pool.query('SELECT * FROM bookings ORDER BY check_in DESC');
    res.json(result.rows);
});

app.delete('/bookings/:id', basicAuth, async (req, res) => {
    await pool.query('DELETE FROM bookings WHERE id = $1', [req.params.id]);
    res.json({ success: true });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    syncAirbnb();
});