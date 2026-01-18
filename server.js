require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');
const cron = require('node-cron');
const ical = require('node-ical');

const app = express();

// --- CORS НАСТРОЙКИ (Връзка с твоя сайт) ---
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

// --- SECURITY: BASIC AUTH ---
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

// --- DATABASE & APIS ---
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

// --- КЕШ ЗА TUYA ---
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

// --- 🤖 AI ЧАТ МОДУЛ (Тук е промяната) ---
app.post('/chat', async (req, res) => {
    const userMessage = req.body.message;

    // ТУК ДЕФИНИРАМЕ ИНТЕЛЕКТА НА АГЕНТА
    const systemInstruction = `
    Ти си Smart Stay Иконом - любезен, интелигентен и услужлив AI домакин на апартамент.
    
    ТВОИТЕ ЗАДАЧИ:
    1. ИДЕНТИФИКАЦИЯ НА КОД:
       - Ако потребителят напише текст, който прилича на резервационен код (напр. "HM12345", "RES-555", или просто комбинация от букви и цифри като "A1B2C3"), ВЕДНАГА приеми, че това е кодът им.
       - В този случай върни САМО: "CHECK_CODE: [кодът]".
    
    2. СВОБОДЕН РАЗГОВОР:
       - Ако няма код, дръж се като човек. Поздравявай, бъди учтив.
       - Отговаряй на въпроси за апартамента (използвай "Знанието" по-долу).
       - Винаги говори на БЪЛГАРСКИ език, освен ако те не питат на английски.
    
    3. ТВОЕТО ЗНАНИЕ (Инфо за апартамента):
       - Настаняване: След 14:00 часа.
       - Напускане: До 11:00 часа.
       - Wi-Fi: Мрежа "SmartStay_Guest", парола "welcome2026".
       - Паркиране: Свободно паркиране пред блока (или синя зона, ако е приложимо).
       - Топла вода: Има бойлер, който е винаги включен.
       - Климатик: Управлява се с дистанционното на стената.
       - Спешни случаи: При проблем, свържете се с домакина на тел. 0888 123 456.

    Ако те питат нещо, което не знаеш, кажи любезно: "За този детайл трябва да попитам собственика, моля изчакайте малко."
    `;

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash", systemInstruction });
        let result = await model.generateContent(userMessage);
        let botResponse = result.response.text().trim();

        // Логика за проверка на код в базата
        if (botResponse.includes("CHECK_CODE:")) {
            const code = botResponse.split(":")[1].trim().replace(/[\[\]]/g, "");
            console.log("🔍 AI откри код:", code);

            const dbRes = await pool.query("SELECT * FROM bookings WHERE reservation_code = $1", [code]);
            const dbData = dbRes.rows.length > 0 ? dbRes.rows[0] : null;

            if (dbData) {
                // Връщаме данните на AI, за да ги поднесе красиво
                const finalResult = await model.generateContent(`
                    Намерих резервацията! Ето данните: ${JSON.stringify(dbData)}.
                    Сега поздрави госта по име (${dbData.guest_name}), кажи му че всичко е наред.
                    Дай му ПИН кода за вратата (${dbData.lock_pin}) и му пожелай приятен престой.
                    Не споменавай технически данни като ID или created_at.
                `);
                botResponse = finalResult.response.text();
            } else {
                botResponse = "Съжалявам, но не откривам резервация с този код (" + code + "). Моля, проверете дали го изписвате правилно.";
            }
        }
        res.json({ reply: botResponse });
    } catch (err) {
        console.error("AI Error:", err);
        res.json({ reply: "Имам малък проблем с връзката. Моля опитайте пак." });
    }
});
// ------------------------------------------

// --- ОСТАНАЛИТЕ ФУНКЦИИ (Admin, Cron, Airbnb) ---

app.get('/update-db', basicAuth, async (req, res) => {
    try {
        await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS power_on_time TIMESTAMP");
        await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS power_off_time TIMESTAMP");
        res.send("✅ Базата е обновена.");
    } catch (e) { res.status(500).send(e.message); }
});

cron.schedule('*/10 * * * *', async () => { /* Logic ON */
    // ... (старият код за включване си остава същия, спестявам го за краткост, но ако го нямаш, кажи)
}); 

// Тук слагам съкратените cron и airbnb функции, тъй като те не се променят
// Ако искаш целия файл абсолютно 1:1, кажи ми, но горната AI промяна е ключовата.
// За да не става грешка, ето най-важните API рутове надолу:

app.get('/status', basicAuth, async (req, res) => {
    try { const isOn = await getSmartStatus(); res.json({ is_on: isOn }); } 
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/add-booking', basicAuth, async (req, res) => {
    const { guest_name, check_in, check_out, reservation_code } = req.body;
    if (!guest_name || !check_in || !check_out || !reservation_code) return res.status(400).json({ error: "Липсват данни!" });

    try {
        const codeCheck = await pool.query("SELECT id FROM bookings WHERE reservation_code = $1", [reservation_code]);
        if (codeCheck.rows.length > 0) return res.status(400).json({ error: "Този код вече съществува!" });

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
});