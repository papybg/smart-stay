require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');
const cron = require('node-cron'); // <--- НОВИЯТ ТАЙМЕР

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 1. БАЗА ДАННИ
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 2. TUYA (ТОК)
const tuya = new TuyaContext({
  baseUrl: 'https://openapi.tuyaeu.com',
  accessKey: process.env.TUYA_ACCESS_ID,
  secretKey: process.env.TUYA_ACCESS_SECRET,
});

// 3. GEMINI (AI)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- АВТОМАТИЗАЦИЯТА (CRON JOB) ---
// Стартира се на всеки 10 минути
cron.schedule('*/10 * * * *', async () => {
    console.log('⏰ [Auto-Check] Проверка за пристигащи гости...');
    
    try {
        // Търсим резервации, които започват в следващите 150 минути (2 часа и малко)
        // Използваме timezone 'EET' (Източна Европа), за да е точно времето
        const query = `
            SELECT * FROM bookings 
            WHERE check_in::timestamp BETWEEN (NOW() AT TIME ZONE 'UTC') 
            AND (NOW() AT TIME ZONE 'UTC' + INTERVAL '150 minutes')
        `;
        
        const result = await pool.query(query);

        if (result.rows.length > 0) {
            console.log(`🛎️ Намерени са ${result.rows.length} пристигащи гости! Проверка на тока...`);
            await checkAndTurnOnPower();
        } else {
            console.log('💤 Няма гости в следващите 2 часа.');
        }

    } catch (err) {
        console.error('Greška pri Cron Job:', err);
    }
});

// Функция, която умната брава ползва само ако е нужно
async function checkAndTurnOnPower() {
    const deviceId = process.env.TUYA_DEVICE_ID;
    try {
        // 1. Виждаме дали вече свети
        const statusData = await tuya.request({
            path: `/v1.0/iot-03/devices/${deviceId}/status`,
            method: 'GET',
        });

        const switchStatus = statusData.result.find(item => item.code === 'switch');
        
        if (switchStatus && switchStatus.value === false) {
            console.log("🔌 Токът е СПРЯН. Гостите идват -> ПУСКАМ ГО!");
            
            await tuya.request({
                path: `/v1.0/iot-03/devices/${deviceId}/commands`,
                method: 'POST',
                body: { commands: [{ code: 'switch', value: true }] }
            });
            console.log("✅ Токът е пуснат успешно!");
        } else {
            console.log("⚡ Токът вече е пуснат. Няма нужда от действие.");
        }
    } catch (error) {
        console.error("Tuya Error:", error);
    }
}

// --- СТАНДАРТНИ ЕНДПОЙНТИ ---

async function checkBookingInDB(code) {
  try {
    const res = await pool.query(
      "SELECT guest_name, check_in, check_out, lock_pin, payment_status FROM bookings WHERE reservation_code = $1", 
      [code.trim()]
    );
    return res.rows.length > 0 ? res.rows[0] : { error: "Няма такава резервация." };
  } catch (err) {
    return { error: "Проблем с базата." };
  }
}

app.get('/toggle', async (req, res) => {
  // Този endpoint остава за ръчното дистанционно
  const deviceId = process.env.TUYA_DEVICE_ID;
  try {
    const statusData = await tuya.request({ path: `/v1.0/iot-03/devices/${deviceId}/status`, method: 'GET' });
    const switchStatus = statusData.result.find(item => item.code === 'switch');
    const newVal = !switchStatus.value; 

    await tuya.request({
      path: `/v1.0/iot-03/devices/${deviceId}/commands`,
      method: 'POST',
      body: { commands: [{ code: 'switch', value: newVal }] }
    });
    res.send(`УСПЕХ! Токът е ${newVal ? 'ПУСНАТ' : 'СПРЯН'}.`);
  } catch (error) {
    res.status(500).send('Грешка: ' + error.message);
  }
});

app.post('/chat', async (req, res) => {
  const userMessage = req.body.message;
  let modelName = "gemini-3-flash-preview"; 
  let usedFallback = false;
  
  try {
    let model = genAI.getGenerativeModel({ 
      model: modelName, 
      systemInstruction: "Ти си Smart Stay Agent. Ако получиш код, само провери базата."
    });

    let result;
    try {
        result = await model.generateContent(userMessage);
    } catch (aiErr) {
        modelName = "gemini-2.5-flash";
        usedFallback = true;
        model = genAI.getGenerativeModel({ model: modelName });
        result = await model.generateContent(userMessage);
    }

    let botResponse = result.response.text().trim();

    if (botResponse.includes("CHECK_CODE:")) {
      const code = botResponse.split(":")[1].trim().replace("[", "").replace("]", "");
      const dbData = await checkBookingInDB(code);
      
      const finalModel = genAI.getGenerativeModel({ model: modelName });
      const finalResult = await finalModel.generateContent(`Данни: ${JSON.stringify(dbData)}. Отговори дали резервацията е намерена.`);
      botResponse = finalResult.response.text();
    }

    const debugInfo = usedFallback ? " (v2.5 ⚡)" : " (v3 🚀)";
    res.json({ reply: botResponse + debugInfo });
  } catch (err) {
    res.status(500).json({ reply: "Грешка при АИ модула." });
  }
});

app.post('/add-booking', async (req, res) => {
  const { guest_name, check_in, check_out, reservation_code } = req.body;
  const lock_pin = Math.floor(100000 + Math.random() * 900000).toString();
  try {
    // ВАЖНО: Тук check_in трябва да е формат 'YYYY-MM-DD HH:MM:SS' за да работи точно
    const result = await pool.query(
      `INSERT INTO bookings (guest_name, check_in, check_out, reservation_code, lock_pin, payment_status) 
       VALUES ($1, $2, $3, $4, $5, 'paid') RETURNING *`,
      [guest_name, check_in, check_out, reservation_code, lock_pin]
    );
    res.json({ success: true, booking: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/bookings', async (req, res) => {
  const result = await pool.query('SELECT * FROM bookings ORDER BY created_at DESC');
  res.json(result.rows);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🤖 SMART STAY SERVER + AUTO PILOT READY`));