require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs'); // <--- НОВОТО ОРЪЖИЕ

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 1. НАСТРОЙКИ ЗА БАЗАТА ДАННИ
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 2. НАСТРОЙКИ ЗА TUYA (ТОКА)
const tuya = new TuyaContext({
  baseUrl: 'https://openapi.tuyaeu.com',
  accessKey: process.env.TUYA_ACCESS_ID,
  secretKey: process.env.TUYA_ACCESS_SECRET,
});

// 3. НАСТРОЙКИ ЗА GEMINI (ЧАТА)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- ПОМОЩНИ ФУНКЦИИ ---
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

// --- ЕНДПОЙНТИ ---

// А) УПРАВЛЕНИЕ НА ТОКА (Твоят код)
app.get('/toggle', async (req, res) => {
  const deviceId = process.env.TUYA_DEVICE_ID;

  try {
    // Взимаме статуса
    const statusData = await tuya.request({
      path: `/v1.0/iot-03/devices/${deviceId}/status`,
      method: 'GET',
    });

    if (!statusData.success) throw new Error(statusData.msg);

    // Намираме точния ключ 'switch'
    const switchStatus = statusData.result.find(item => item.code === 'switch');
    
    if (!switchStatus) {
        return res.send('Грешка: Не намирам команда "switch"!');
    }

    const currentVal = switchStatus.value;
    const newVal = !currentVal; 

    console.log(`🔌 ПРЕВКЛЮЧВАНЕ НА ТОКА КЪМ: ${newVal}`);

    // Изпращаме команда
    const commandResult = await tuya.request({
      path: `/v1.0/iot-03/devices/${deviceId}/commands`,
      method: 'POST',
      body: {
        commands: [{ code: 'switch', value: newVal }]
      }
    });

    if (commandResult.success) {
        res.send(`УСПЕХ! Токът е ${newVal ? 'ПУСНАТ' : 'СПРЯН'}.`);
    } else {
        res.send(`Грешка Tuya: ${commandResult.msg}`);
    }

  } catch (error) {
    console.error("Tuya Error:", error);
    res.status(500).send('Грешка: ' + error.message);
  }
});

// Б) ЧАТ С ИЗКУСТВЕН ИНТЕЛЕКТ (Gemini 3 + 2.5)
app.post('/chat', async (req, res) => {
  const userMessage = req.body.message;
  let modelName = "gemini-3-flash-preview"; 
  let usedFallback = false;
  
  try {
    let model = genAI.getGenerativeModel({ 
      model: modelName, 
      systemInstruction: "Ти си Smart Stay Agent. Ако потребителят ти даде код (напр. TEST1), отговори само: CHECK_CODE: [кода]."
    });

    let result;
    try {
        result = await model.generateContent(userMessage);
    } catch (aiErr) {
        console.log("⚠️ Gemini 3 е зает! Минавам на Gemini 2.5 Flash...");
        modelName = "gemini-2.5-flash"; // Използваме модела от твоето меню
        usedFallback = true;
        model = genAI.getGenerativeModel({ 
            model: modelName,
            systemInstruction: "Ти си Smart Stay Agent."
        });
        result = await model.generateContent(userMessage);
    }

    let botResponse = result.response.text().trim();

    if (botResponse.includes("CHECK_CODE:")) {
      const code = botResponse.split(":")[1].trim().replace("[", "").replace("]", "");
      const dbData = await checkBookingInDB(code);
      
      const finalModel = genAI.getGenerativeModel({ model: modelName });
      const finalResult = await finalModel.generateContent(`Данни: ${JSON.stringify(dbData)}. Отговори дали резервацията е намерена и кажи ПИН кода само ако е paid.`);
      botResponse = finalResult.response.text();
    }

    const debugInfo = usedFallback ? " (v2.5 ⚡)" : " (v3 🚀)";
    res.json({ reply: botResponse + debugInfo });

  } catch (err) {
    console.error("AI Error:", err.message);
    res.status(500).json({ reply: "Грешка при АИ модула." });
  }
});

// В) АДМИН ПАНЕЛ И РЕЗЕРВАЦИИ
app.post('/add-booking', async (req, res) => {
  const { guest_name, check_in, check_out, reservation_code } = req.body;
  const lock_pin = Math.floor(100000 + Math.random() * 900000).toString();
  try {
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
app.listen(PORT, () => console.log(`🤖 SMART STAY SERVER READY (Chat + Tuya)`));