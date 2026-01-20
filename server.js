import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { neon } from '@neondatabase/serverless';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { syncBookingsFromGmail } from './services/detective.js';

const app = express();
const sql = neon(process.env.DATABASE_URL);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

app.use(cors(), express.json());

app.post('/api/chat', async (req, res) => {
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
});

app.listen(process.env.PORT || 3001, () => {
  console.log('🚀 Bobo is live!');
  syncBookingsFromGmail();
  setInterval(syncBookingsFromGmail, 15 * 60 * 1000);
});