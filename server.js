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
            console.log("🛎️ Гост идва! Пускам тока автоматично...");
            await toggleTuya(true);
        }
    } catch (err) { console.error('Cron error:', err); }
});

async function toggleTuya(targetValue) {
    const deviceId = process.env.TUYA_DEVICE_ID;
    await tuya.request({
        path: `/v1.0/iot-03/devices/${deviceId}/commands`,
        method: 'POST',
        body: { commands: [{ code: 'switch', value: targetValue }] }
    });
}

// --- ЕНДПОЙНТИ ---

app.get('/status', async (req, res) => {
    try {
        const data = await tuya.request({
            path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/status`,
            method: 'GET'
        });
        const sw = data.result.find(i => i.code === 'switch');
        res.json({ is_on: sw.value });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/toggle', async (req, res) => {
    try {
        const data = await tuya.request({ path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/status`, method: 'GET' });
        const sw = data.result.find(i => i.code === 'switch');
        const newVal = !sw.value;
        await toggleTuya(newVal);
        res.send(`Токът е ${newVal ? 'ПУСНАТ' : 'СПРЯН'}`);
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/chat', async (req, res) => {
    const userMessage = req.body.message;
    const model = genAI.getGenerativeModel({ 
        model: "gemini-3-flash-preview", 
        systemInstruction: "Ти си любезен Smart Stay Асистент. Ако видиш код, отговори: CHECK_CODE: [кода]. Ако получиш данни, ги кажи любезно на БЪЛГАРСКИ. Ако данните показват грешка, кажи, че няма такава резервация и НЕ СИ ИЗМИСЛЯЙ НИЩО."
    });

    try {
        const result = await model.generateContent(userMessage);
        let botResponse = result.response.text().trim();

        if (botResponse.includes("CHECK_CODE:")) {
            const code = botResponse.split(":")[1].trim().replace("[", "").replace("]", "");
            const dbRes = await pool.query("SELECT * FROM bookings WHERE reservation_code = $1", [code]);
            const dbData = dbRes.rows.length > 0 ? dbRes.rows[0] : { error: "НЕ СЪЩЕСТВУВА" };
            
            const finalResult = await model.generateContent(`Данни от базата: ${JSON.stringify(dbData)}. Ако е грешка, кажи че няма такава резервация. Ако е истинска, кажи името на госта, датата и ПИН кода.`);
            botResponse = finalResult.response.text();
        }
        res.json({ reply: botResponse });
    } catch (err) { res.status(500).json({ reply: "Грешка при АИ." }); }
});

app.post('/add-booking', async (req, res) => {
    const { guest_name, check_in, check_out, reservation_code } = req.body;
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    try {
        const result = await pool.query(
            "INSERT INTO bookings (guest_name, check_in, check_out, reservation_code, lock_pin, payment_status) VALUES ($1, $2, $3, $4, $5, 'paid') RETURNING *",
            [guest_name, check_in, check_out, reservation_code, pin]
        );
        res.json({ success: true, booking: result.rows[0] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/bookings', async (req, res) => {
    const result = await pool.query('SELECT * FROM bookings ORDER BY created_at DESC');
    res.json(result.rows);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));