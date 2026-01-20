import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { neon } from '@neondatabase/serverless';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { syncBookingsFromGmail } from './services/detective.js';

const app = express();

app.use(cors(), express.json());

// Add a health check endpoint to verify the server is running
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.post('/api/chat', async (req, res) => {
  try {
    // Initialize services within the handler to catch runtime configuration errors
    if (!process.env.DATABASE_URL || !process.env.GEMINI_API_KEY) {
      console.error('❌ Грешка: Липсват DATABASE_URL или GEMINI_API_KEY.');
      return res.status(503).json({ error: 'Услугата в момента не е налична поради конфигурационен проблем.' });
    }

    const sql = neon(process.env.DATABASE_URL);
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const { message } = req.body;
    const input = message.trim().toUpperCase();

    // 1. Проверяваме за истински кратък код (Airbnb кодовете са кратки)
    const booking = await sql`SELECT * FROM bookings WHERE reservation_code = ${input} OR reservation_code LIKE ${'%' + input + '%'}`;
    
    if (booking.length > 0 && input.length > 4) {
      return res.json({ reply: `✅ Здравейте, ${booking[0].guest_name}! Кодът е валиден. ПИН: 1234#` });
    }

    // 2. Ако не е код, Gemini отговаря
    const result = await model.generateContent(`Ти си Бобо, домакин. Отговори на: ${message}`);
    res.json({ reply: result.response.text() });

  } catch (error) {
    console.error('❌ Грешка в /api/chat:', error);
    res.status(500).json({ error: 'Възникна вътрешна грешка в сървъра.' });
  }
});

app.listen(process.env.PORT || 3001, () => {
  console.log('🚀 Bobo is live!');
  // These functions are now self-contained and will handle their own errors without crashing the server
  syncBookingsFromGmail();
  setInterval(syncBookingsFromGmail, 15 * 60 * 1000);
});