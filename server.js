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

// 1. БАЗА ДАННИ
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 2. TUYA (ЕЛЕКТРОМЕР)
const tuya = new TuyaContext({
  baseUrl: 'https://openapi.tuyaeu.com',
  accessKey: process.env.TUYA_ACCESS_ID,
  secretKey: process.env.TUYA_ACCESS_SECRET,
});

// 3. GEMINI (AI МОЗЪК)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- АВТОПИЛОТ (Включва се на всеки 10 мин) ---
cron.schedule('*/10 * * * *', async () => {
    console.log('⏰ [Auto-Pilot] Сканиране за резервации...');
    
    try {
        // Търсим резервации в следващите 4 часа (заради часовата разлика с UTC)
        // Ако гостът идва в 14:00, а сега е 11:00, това ще го хване.
        const query = `
            SELECT * FROM bookings 
            WHERE check_in::timestamp > NOW() 
            AND check_in::timestamp < (NOW() + INTERVAL '4 hours')
        `;
        
        const result = await pool.query(query);

        if (result.rows.length > 0) {
            console.log(`🛎️ Намерени са ${result.rows.length} чакащи гости! Проверявам тока...`);
            await checkAndTurnOnPower();
        } else {
            console.log('💤 Няма гости в близките 4 часа.');
        }

    } catch (err) {
        console.error('Грешка при таймера:', err);
    }
});

async function checkAndTurnOnPower() {
    const deviceId = process.env.TUYA_DEVICE_ID;
    try {
        // Проверка: Свети ли вече?
        const statusData = await tuya.request({
            path: `/v1.0/iot-03/devices/${deviceId}/status`,
            method: 'GET',
        });

        const switchStatus = statusData.result.find(item => item.code === 'switch');
        
        // Ако switch e false (спрян), го пускаме
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

// --- ЕНДПОЙНТИ ---

// Бутон за ръчно управление (Дистанционното)
app.get('/toggle', async (req, res) => {
  const deviceId = process.env.TUYA_DEVICE_ID;
  try {
    const statusData = await tuya.request({ path: `/v1.0/iot-03/devices/${deviceId}/status`, method: 'GET' });
    const switchStatus = statusData.result.find(item => item.code === 'switch');
    
    if (!switchStatus) return res.send('Грешка: Не намирам шалтер!');

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
  
  // Използваме твоя мощен Gemini 3
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
        // Резерва: Gemini 2.5
        modelName = "gemini-2.5-flash"; 
        usedFallback = true;
        model = genAI.getGenerativeModel({ model: modelName });
        result = await model.generateContent(userMessage);
    }

    let botResponse = result.response.text().trim();

    // Логика за проверка на код
    if (botResponse.includes("CHECK_CODE:")) {
      const code = botResponse.split(":")[1].trim().replace("[", "").replace("]", "");
      
      // Търсим в базата
      let dbData;
      try {
        const dbRes = await pool.query(
          "SELECT guest_name, check_in, check_out, lock_pin, payment_status FROM bookings WHERE reservation_code = $1", 
          [code.trim()]
        );
        dbData = dbRes.rows.length > 0 ? dbRes.rows[0] : { error: "Няма такава резервация." };
      } catch (e) { dbData = { error: "Грешка база." }; }
      
      const finalModel = genAI.getGenerativeModel({ model: modelName });
      const finalResult = await finalModel.generateContent(`Данни: ${JSON.stringify(dbData)}. Отговори любезно.`);
      botResponse = finalResult.response.text();
    }

    const debugInfo = usedFallback ? " (v2.5 ⚡)" : " (v3 🚀)";
    res.json({ reply: botResponse + debugInfo });
  } catch (err) {
    res.status(500).json({ reply: "Грешка при АИ модула." });
  }
});

// Админ панелът ползва това за добавяне
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
app.listen(PORT, () => console.log(`🤖 SMART STAY СЪРВЪРЪТ Е ГОТОВ!`));