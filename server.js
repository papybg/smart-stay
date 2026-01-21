import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { syncBookingsFromGmail } from './services/detective.js';
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
  const reservationCode = message.trim();

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ reply: "Грешка: Липсва връзка с базата данни." });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);
    const result = await sql`
      SELECT guest_name, check_in, check_out 
      FROM bookings 
      WHERE reservation_code = ${reservationCode} 
      AND payment_status = 'paid'
      AND check_in <= NOW() 
      AND check_out >= NOW()
      LIMIT 1;
    `;

    if (result.length > 0) {
      const booking = result[0];
      const reply = `Добре дошли, ${booking.guest_name}! 🎉\n\n**Детайли за престоя:**\n- **Настаняване:** ${new Date(booking.check_in).toLocaleDateString('bg-BG')}\n- **Напускане:** ${new Date(booking.check_out).toLocaleDateString('bg-BG')}\n\nПо-долу ще намерите инструкции за достъп.`;
      res.json({ reply });
    } else {
      res.json({ reply: "Невалиден или изтекъл код за резервация. Моля, проверете кода и опитайте отново." });
    }
  } catch (error) {
    console.error('Error querying database:', error);
    res.status(500).json({ reply: "Грешка при обработка на заявката. Моля, опитайте отново по-късно." });
  }
});

// --- Стартиране на сървъра ---

app.listen(PORT, () => {
  console.log(`🚀 Bobo is live on port ${PORT}!`);
  
  // Стартира синхронизацията с Gmail при старт и я насрочва
  console.log('Starting initial Gmail sync...');
  syncBookingsFromGmail();
  setInterval(syncBookingsFromGmail, 15 * 60 * 1000); // На всеки 15 минути
});