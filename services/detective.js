import { google } from 'googleapis';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  'https://developers.google.com/oauthplayground'
);

oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

export async function syncBookingsFromGmail() {
  console.log('🕵️ Бобо Детектива чисти грешните кодове от iCal...');
  try {
    const query = '(from:automated@airbnb.com OR from:me) subject:(confirmed OR потвърдена) is:unread';
    const res = await gmail.users.messages.list({ userId: 'me', q: query });
    const messages = res.data.messages || [];

    for (const msg of messages) {
      const details = await processMessage(msg.id);
      if (details) {
        // ТУК Е МАГИЯТА: Търсим по дати, за да намерим записа от iCal и да му сменим кода
        await sql`
          INSERT INTO bookings (reservation_code, guest_name, check_in, check_out, source, payment_status)
          VALUES (${details.reservation_code}, ${details.guest_name}, ${details.check_in}, ${details.check_out}, 'airbnb', 'paid')
          ON CONFLICT (check_in, check_out) 
          DO UPDATE SET 
            reservation_code = EXCLUDED.reservation_code,
            guest_name = EXCLUDED.guest_name,
            payment_status = 'paid',
            updated_at = NOW();
        `;
        
        await gmail.users.messages.modify({
          userId: 'me', id: msg.id, requestBody: { removeLabelIds: ['UNREAD'] }
        });
        console.log(`✅ Поправен код за: ${details.guest_name}`);
      }
    }
  } catch (err) { console.error('❌ Грешка:', err); }
}

async function processMessage(id) {
  try {
    const res = await gmail.users.messages.get({ userId: 'me', id });
    const prompt = `Extract JSON: reservation_code (6-10 chars like HMQW123), guest_name, check_in, check_out. Text: ${res.data.snippet}`;
    const result = await model.generateContent(prompt);
    const data = JSON.parse(result.response.text().replace(/```json|```/g, '').trim());
    return data;
  } catch { return null; }
}