import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { syncBookingsFromGmail } from './services/detective.js';

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
  // Вашата логика за чата идва тук...
  // Засега връщаме прост отговор.
  res.json({ reply: "Здравейте! Аз съм Бобо. Получих вашето съобщение." });
});

// --- Стартиране на сървъра ---

app.listen(PORT, () => {
  console.log(`🚀 Bobo is live on port ${PORT}!`);
  
  // Стартира синхронизацията с Gmail при старт и я насрочва
  console.log('Starting initial Gmail sync...');
  syncBookingsFromGmail();
  setInterval(syncBookingsFromGmail, 15 * 60 * 1000); // На всеки 15 минути
});