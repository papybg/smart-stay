require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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

// --- АВТОПИЛОТ ---
cron.schedule('*/10 * * * *', async () => {
    try {
        const query = `
            SELECT * FROM bookings 
            WHERE check_in::timestamp > (NOW() AT TIME ZONE 'UTC' + INTERVAL '2 hours') 
            AND check_in::timestamp < (NOW() AT TIME ZONE 'UTC' + INTERVAL '6 hours')
        `;
        const result = await pool.query(query);
        if (result.rows.length > 0) {
            console.log("🛎️ Автопилот: Пускам тока за гости.");
            await tuya.request({
                path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
                method: 'POST',
                body: { commands: [{ code: 'switch', value: true }] }
            });
        }
    } catch (err) { console.error('Cron error:', err); }
});

app.get('/status', async (req, res) => {
    try {
        const data = await tuya.request({ path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/status`, method: 'GET' });
        const sw = data.result.find(i => i.code === 'switch');
        res.json({ is_on: sw.value });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/toggle', async (req, res) => {
    try {
        const data = await tuya.request({ path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/status`, method: 'GET' });
        const sw = data.result.find(i => i.code === 'switch');
        const newVal = !sw.value;
        await tuya.request({
            path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
            method: 'POST',
            body: { commands: [{ code: 'switch', value: newVal }] }
        });
        res.send(`OK: ${newVal}`);
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/chat', async (req, res) => {
    const userMessage = req.body.message;
    const systemInstruction = "Ти си Smart Stay Асистент. Ако видиш код, отговори само: CHECK_CODE: [кода]. Ако получиш данни, ги кажи любезно на БЪЛГАРСКИ. Ако няма данни, кажи че не намираш такава резервация.";

    // Помощна функция за изпълнение на заявката с конкретен модел
    const runAI = async (modelName) => {
        const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
        let result = await model.generateContent(userMessage);
        let botResponse = result.response.text().trim();

        if (botResponse.includes("CHECK_CODE:")) {
            const code = botResponse.split(":")[1].trim().replace(/[\[\]]/g, "");
            const dbRes = await pool.query("SELECT * FROM bookings WHERE reservation_code = $1", [code]);
            const dbData = dbRes.rows.length > 0 ? dbRes.rows[0] : { error: "not_found" };
            const finalResult = await model.generateContent(`ДАННИ: ${JSON.stringify(dbData)}. Отговори любезно.`);
            botResponse = finalResult.response.text();
        }
        return botResponse;
    };

    try {
        // 1. Опит с основния модел (Gemini 3.0 Preview)
        const reply = await runAI("gemini-3.0-flash-preview");
        res.json({ reply });
    } catch (err) {
        console.warn("⚠️ Gemini 3.0 failed, switching to fallback (2.5 Flash)...", err.message);
        try {
            // 2. Fallback към по-стабилен модел (Gemini 2.5)
            const reply = await runAI("gemini-2.5-flash");
            res.json({ reply });
        } catch (fallbackErr) {
            console.error("❌ All models failed:", fallbackErr);
            res.json({ reply: "Опитай пак. (Грешка в AI модула)" });
        }
    }
});

app.post('/add-booking', async (req, res) => {
    const { guest_name, check_in, check_out, reservation_code } = req.body;
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    const result = await pool.query(
        "INSERT INTO bookings (guest_name, check_in, check_out, reservation_code, lock_pin, payment_status) VALUES ($1, $2, $3, $4, $5, 'paid') RETURNING lock_pin",
        [guest_name, check_in, check_out, reservation_code, pin]
    );
    res.json({ success: true, pin: result.rows[0].lock_pin });
});

app.get('/bookings', async (req, res) => {
    const result = await pool.query('SELECT * FROM bookings ORDER BY created_at DESC');
    res.json(result.rows);
});

app.listen(process.env.PORT || 10000);