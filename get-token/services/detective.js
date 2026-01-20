import { google } from 'googleapis';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';

// Инициализация на връзките
const sql = neon(process.env.DATABASE_URL);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Конфигурация на Gmail OAuth2
const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  'https://developers.google.com/oauthplayground'
);

oauth2Client.setCredentials({
  refresh_token: process.env.GMAIL_REFRESH_TOKEN
});

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

/**
 * Основна функция за синхронизация на имейли
 */
export async function syncBookingsFromGmail() {
  console.log('🕵️ Бобо Детектива проверява пощата за нови потвърждения...');

  try {
    // Търсим непрочетени писма от Airbnb или от теб (за тест)
    const query = '(from:automated@airbnb.com OR from:me) subject:(confirmed OR потвърдена) is:unread';
    const res = await gmail.users.messages.list({ userId: 'me', q: query });
    const messages = res.data.messages || [];

    if (messages.length === 0) {
      console.log('📭 Няма нови имейли за обработка.');
      return;
    }

    for (const msg of messages) {
      await processMessage(msg.id);
    }
  } catch (error) {
    console.error('❌ Грешка при сканиране на Gmail:', error);
  }
}

/**
 * Обработка и анализ на конкретен имейл с Gemini
 */
async function processMessage(messageId) {
  try {
    const res = await gmail.users.messages.get({ userId: 'me', id: messageId });
    const body = res.data.snippet; // Взимаме на първо време snippet-а за бързина

    console.log(`🤖 Анализирам имейл ID: ${messageId}...`);

    const prompt = `
      Анализирай този текст на имейл за резервация в Airbnb. 
      Извлечи данните и ги върни само като чист JSON обект.
      Полета: reservation_code, guest_name, check_in (YYYY-MM-DD), check_out (YYYY-MM-DD).
      Текст: ${body}
    `;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
    const data = JSON.parse(responseText);

    if (data.reservation_code && data.guest_name) {
      // Запис или обновяване в Neon
      await sql`
        INSERT INTO bookings (reservation_code, guest_name, check_in, check_out, source, payment_status)
        VALUES (${data.reservation_code}, ${data.guest_name}, ${data.check_in}, ${data.check_out}, 'airbnb', 'paid')
        ON CONFLICT (reservation_code) 
        DO UPDATE SET 
          guest_name = EXCLUDED.guest_name,
          payment_status = 'paid',
          updated_at = NOW()
      `;

      console.log(`✅ Успешно синхронизиран гост: ${data.guest_name}`);

      // Маркираме като прочетен
      await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['UNREAD'] }
      });
    }
  } catch (err) {
    console.error(`❌ Грешка при обработка на съобщение ${messageId}:`, err);
  }
}