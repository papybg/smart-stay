require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

app.post('/chat', async (req, res) => {
  const userMessage = req.body.message;
  
  // 1. ОСНОВЕН ОПИТ: Gemini 3 Flash Preview
  // (Това е най-горният от твоя списък)
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
        // 2. РЕЗЕРВЕН ОПИТ: Gemini 2.5 Flash
        // (Това е стабилната алтернатива от твоя списък)
        console.log("⚠️ Gemini 3 е зает! Минавам на Gemini 2.5 Flash...");
        modelName = "gemini-2.5-flash";
        usedFallback = true;
        
        model = genAI.getGenerativeModel({ 
            model: modelName,
            systemInstruction: "Ти си Smart Stay Agent. Ако потребителят ти даде код (напр. TEST1), отговори само: CHECK_CODE: [кода]."
        });
        result = await model.generateContent(userMessage);
    }

    let botResponse = result.response.text().trim();

    if (botResponse.includes("CHECK_CODE:")) {
      const code = botResponse.split(":")[1].trim().replace("[", "").replace("]", "");
      const dbData = await checkBookingInDB(code);
      
      const finalModel = genAI.getGenerativeModel({ model: modelName });
      const finalResult = await finalModel.generateContent(`Данни: ${JSON.stringify(dbData)}. Отговори любезно на български дали резервацията е намерена и кажи ПИН кода само ако статусът е paid.`);
      
      botResponse = finalResult.response.text();
    }

    // Маркери за диагностика:
    // (v3 🚀) = Gemini 3
    // (v2.5 ⚡) = Gemini 2.5
    const debugInfo = usedFallback ? " (v2.5 ⚡)" : " (v3 🚀)";
    res.json({ reply: botResponse + debugInfo });

  } catch (err) {
    console.error("❌ ГРЕШКА:", err.message);
    res.status(500).json({ reply: "В момента Агентът се обновява. Моля, опитайте пак след малко." });
  }
});

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
app.listen(PORT, () => console.log(`🤖 АГЕНТЪТ Е ОНЛАЙН (Gemini 3 + 2.5 Fallback)`));