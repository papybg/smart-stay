import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { neon } from '@neondatabase/serverless';
import { syncBookingsFromGmail } from './services/detective.js';

const app = express();
const sql = neon(process.env.DATABASE_URL);

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Начална страница
app.get('/', (req, res) => {
  res.send('Smart Stay Backend is Running! 🚀');
});

// Тестов Endpoint за ръчно пускане на Детектива
app.get('/api/sync-test', async (req, res) => {
  await syncBookingsFromGmail();
  res.json({ message: "Sync process triggered manually." });
});

// Стартиране на сървъра
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);

  // Първоначална синхронизация при старт
  syncBookingsFromGmail();

  // Автоматична проверка на всеки 15 минути
  setInterval(() => {
    syncBookingsFromGmail();
  }, 15 * 60 * 1000);
});