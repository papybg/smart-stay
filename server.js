import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { syncBookingsFromGmail } from './services/detective.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// --- Конфигурация ---

// 1. CORS: Позволява заявки от други домейни. Опростено за лесна настройка.
app.use(cors());

// 2. JSON Parser: Позволява на сървъра да чете JSON данни, изпратени от чата.
app.use(express.json());

// 3. Сервиране на статични файлове (КЛЮЧОВА КОРЕКЦИЯ):
// Това казва на сървъра да покаже файловете от папката 'public' (index.html, admin.html и т.н.).
// Така като отворите https://smart-stay.onrender.com, ще се зареди чатът.
app.use(express.static(path.join(__dirname, 'public')));

// --- API Маршрути ---

// API за чат функционалността
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  const userInput = message.trim();

  // --- Инициализация на услуги ---
  const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
  const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

  // --- Логика на Бота ---

  // 1. Проверка за код за резервация
  const codeRegex = /^HM[A-Z0-9]{8,10}$/;
  if (codeRegex.test(userInput)) {
    if (!sql) {
      return res.status(500).json({ reply: "Грешка: Липсва връзка с базата данни." });
    }
    
    try {
      const result = await sql`
        SELECT guest_name, check_in, check_out 
        FROM bookings 
        WHERE reservation_code = ${userInput.toUpperCase()} 
        AND payment_status = 'paid' 
        AND check_in <= NOW() AND check_out >= NOW()
        LIMIT 1;
      `;

      if (result.length > 0) {
        const booking = result[0];
        const reply = `Добре дошли, ${booking.guest_name}! 🎉\n\n**Детайли за престоя:**\n- **Настаняване:** ${new Date(booking.check_in).toLocaleDateString('bg-BG')}\n- **Напускане:** ${new Date(booking.check_out).toLocaleDateString('bg-BG')}\n\nПо-долу ще намерите инструкции за достъп.`;
        return res.json({ reply });
      } else {
        // Ако кодът е валиден, но не е намерен, Gemini ще отговори.
        return await getGeminiReply(res, genAI, userInput, "Hint: The user provided a reservation code that is either invalid or expired.");
      }
    } catch (error) {
      console.error('Error querying database:', error);
      return res.status(500).json({ reply: "Грешка при проверка в базата данни." });
    }
  }

  // 2. Ако не е код, а обикновен разговор
  await getGeminiReply(res, genAI, userInput);
});

async function getGeminiReply(res, genAI, userInput, hint = "Hint: This is a general conversation.") {
  if (!genAI) {
    return res.status(500).json({ reply: "Грешка: Липсва API ключ за Gemini." });
  }

  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const prompt = `
    Ти си Бобо, виртуален иконом в модерен апартамент.
    Твоята основна роля е да помагаш на гостите. Бъди приятелски настроен, услужлив и малко остроумен.
    Можеш да помагаш със:
    - Общи въпроси за апартамента.
    - Препоръки за местни заведения и забележителности.
    - Управление на умни устройства (това е бъдеща функция).

    Ако потребителят даде грешен код за резервация, информирай го по приятелски начин и го помоли да опита пак.
    Ако потребителят попита нещо извън твоите възможности, откажи учтиво и обясни какво можеш да направиш.

    Съобщение от потребителя: "${userInput}"
    (${hint})
  `;

  try {
    const result = await model.generateContent(prompt);
    const reply = result.response.text();
    res.json({ reply });
  } catch (error) {
    console.error('Error calling Gemini API:', error);
    res.status(500).json({ reply: "Грешка при комуникация с AI асистента." });
  }
}

// --- Стартиране на сървъра ---

app.listen(PORT, () => {
  console.log(`🚀 Bobo is live on port ${PORT}!`);
  
  // Стартира синхронизацията с Gmail при старт и я насрочва
  console.log('Starting initial Gmail sync...');
  syncBookingsFromGmail();
  setInterval(syncBookingsFromGmail, 15 * 60 * 1000); // На всеки 15 минути
});