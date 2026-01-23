import { google } from 'googleapis';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';

// Helper function to retry failed database queries
async function executeQueryWithRetry(queryFn, maxRetries = 3, delay = 10000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await queryFn();
    } catch (err) {
      // Check for common connection error signatures, adjust as needed
      if (err.message.includes('timeout') || err.message.includes('connection')) {
        console.log(`⚠️ Грешка при връзка с базата (опит ${i + 1}/${maxRetries}). Опитвам отново след ${delay / 1000} сек...`);
        if (i < maxRetries - 1) {
          await new Promise(res => setTimeout(res, delay));
        } else {
          console.error('❌ Достигнат максимален брой опити за връзка с базата.');
          throw err; // Re-throw the error after the last attempt
        }
      } else {
        // If it's not a connection error, throw it immediately
        throw err;
      }
    }
  }
}

export async function syncBookingsFromGmail() {
  console.log('🕵️ Бобо Детектива чисти грешните кодове от iCal...');
  try {
    // Initialize services here to catch configuration errors
    if (!process.env.DATABASE_URL || !process.env.GEMINI_API_KEY || !process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !process.env.GMAIL_REFRESH_TOKEN) {
      console.error('❌ Грешка: Липсват задължителни променливи на средата (DATABASE_URL, GEMINI_API_KEY, GMAIL credentials). Синхронизацията се прекратява.');
      return;
    }

    const sql = neon(process.env.DATABASE_URL);
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      'https://developers.google.com/oauthplayground'
    );

    oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    
    const query = '(from:automated@airbnb.com OR from:me) subject:(confirmed OR потвърдена) is:unread';
    const res = await gmail.users.messages.list({ userId: 'me', q: query });
    const messages = res.data?.messages || [];

    for (const msg of messages) {
      const details = await processMessage(msg.id, gmail, genAI);
      if (details) {
        // Using the retry helper for the database operation
        await executeQueryWithRetry(async () => {
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
        });
        
        await gmail.users.messages.modify({
          userId: 'me', id: msg.id, requestBody: { removeLabelIds: ['UNREAD'] }
        });
        console.log(`✅ Поправен код за: ${details.guest_name}`);
      }
    }
  } catch (err) { console.error('❌ Пълна грешка при синхронизация:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2)); }
}

async function processMessage(id, gmail, genAI) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const res = await gmail.users.messages.get({ userId: 'me', id });
    const prompt = `Extract a valid JSON object with these exact keys: "reservation_code", "guest_name", "check_in", "check_out". The date format for check_in and check_out MUST be YYYY-MM-DD. Text: ${res.data.snippet}`;
    const result = await model.generateContent(prompt);
    const data = JSON.parse(result.response.text().replace(/```json|```/g, '').trim());
    return data;
  } catch (err) {
    console.error(`❌ Грешка при обработка на съобщение с ID: ${id}`, err);
    return null;
  }
}