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

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// --- ЛОГИКАТА НА БОБО ---
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  const cleanMessage = message.trim().toUpperCase();

  try {
    // 1. С светкавична проверка в базата: Ако съобщението Е самият код (напр. HMQW123)
    const directMatch = await sql`SELECT * FROM bookings WHERE reservation_code = ${cleanMessage}`;
    
    if (directMatch.length > 0) {
      const guest = directMatch[0];
      return res.json({ 
        reply: `✅ Кодът е валиден! Здравейте, ${guest.guest_name}. Радваме се да ви посрещнем! Вашият ПИН за достъп е: 1234# (активен от 14:00 ч. на ${guest.check_in}).` 
      });
    }

    // 2. Ако не е чист код, питаме Gemini да разбере какво иска гостът
    const systemPrompt = `
      Ти си Бобо - виртуален домакин. Гостът ти пише: "${message}".
      Ако в текста има код за резервация (6-10 символа), извлечи го.
      Ако няма код, отговори любезно. 
      Ако намериш код, върни отговор във формат: CHECK_CODE: [КОДА]
    `;

    const result = await model.generateContent(systemPrompt);
    const aiReply = result.response.text();

    if (aiReply.includes('CHECK_CODE:')) {
      const extractedCode = aiReply.split(':')[1].trim().replace(/[\[\]]/g, '');
      const dbCheck = await sql`SELECT * FROM bookings WHERE reservation_code = ${extractedCode}`;
      
      if (dbCheck.length > 0) {
        return res.json({ reply: `✅ Намерих резервацията! Добре дошли, ${dbCheck[0].guest_name}. ПИН: 1234#` });
      } else {
        return res.json({ reply: `❌ Не откривам резервация с код ${extractedCode}. Моля, проверете го.` });
      }
    }

    res.json({ reply: aiReply });

  } catch (error) {
    console.error('Грешка в чата:', error);
    res.status(500).json({ reply: 'Опа, Бобо се замисли прекалено много. Пробвай пак!' });
  }
});

// --- ДЕТЕКТИВЪТ И СЪРВЪРА ---
app.get('/', (req, res) => res.send('Smart Stay Backend is Running! 🚀'));

app.listen(PORT, () => {
  console.log(`🚀 Сървърът е на порт ${PORT}`);
  
  // Пускаме детектива на всеки 15 мин
  syncBookingsFromGmail();
  setInterval(syncBookingsFromGmail, 15 * 60 * 1000);
});