import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';
import fs from 'fs/promises'; // Модул за четене на файлове
import path from 'path';

const MODELS = ["gemini-3-pro-preview", "gemini-flash-latest", "gemini-3-flash-preview"];
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

/**
 * Основна функция за комуникация с AI
 */
export async function getAIResponse(userMessage, history) {
    if (!genAI) return "Error: Gemini API Key missing.";

    // 1. ЧЕТЕНЕ НА MANUAL.TXT
    let houseManual = "";
    try {
        // Търсим файла в основната директория
        houseManual = await fs.readFile(path.join(process.cwd(), 'manual.txt'), 'utf-8');
    } catch (err) {
        console.error("⚠️ Не мога да намеря manual.txt, Ико ще кара на автопилот.");
    }

    // 2. Проверка за ПИН код (Резервация)
    const possibleCodeMatch = userMessage.match(/\b[A-Z0-9]{5,10}\b/i);
    let pinContext = "";

    if (possibleCodeMatch) {
        const code = possibleCodeMatch[0].toUpperCase();
        const pinData = await checkBookingAndGetPin(code);
        if (pinData) {
            pinContext = `Групата е: ${pinData.guest_name}. ПИН за вратата: ${pinData.pin}. Настаняване: ${pinData.check_in}.`;
        }
    }

    // 3. Избор на модел и отговор
    for (const modelName of MODELS) {
        try {
            const model = genAI.getGenerativeModel({ model: modelName });

            // Тук сглобяваме цялата информация
            const systemInstruction = `
            Ти си Ико - виртуалният иконом на Комплекс Aspen Walei. 
            Ето твоите основни правила и информация за имота (MANUAL):
            Парола за WiFi (Internet) и кодове за достъп се дават само след проверка и наличност на платена резервация.
            ---
            ${houseManual}
            ---
            СПЕЦИФИЧНА ИНФОРМАЦИЯ ЗА ТЕКУЩИЯ ГОСТ:
            ${pinContext}
            
            ИНСТРУКЦИИ:
            - Отговаряй винаги на езика, на който ти пишат.
            - Бъди кратък и точен, използвай информацията от MANUAL-а.
            - Ако те питат за ПИН и не го виждаш в "Специфична информация", искай им Airbnb код.
            `;

            const chat = model.startChat({
                history: formatHistory(history),
                generationConfig: { maxOutputTokens: 800 },
            });

            const result = await chat.sendMessage(`${systemInstruction}\n\nПотребителят пита: ${userMessage}`);
            return result.response.text();

        } catch (error) {
            console.error(`⚠️ Грешка с модел ${modelName}:`, error.message);
            continue; 
        }
    }

    return "Съжалявам, имам технически проблем. Моля опитайте пак.";
}

/**
 * Логика за ПИН-ове
 */
async function checkBookingAndGetPin(reservationCode) {
    if (!sql) return null;
    try {
        const bookings = await sql`SELECT * FROM bookings WHERE reservation_code = ${reservationCode} OR reservation_code ILIKE ${reservationCode} LIMIT 1`;
        if (bookings.length === 0) return null;
        const b = bookings[0];
        if (b.lock_pin) return { guest_name: b.guest_name, pin: b.lock_pin, check_in: b.check_in };

        const freePins = await sql`SELECT * FROM pin_depot WHERE is_used = FALSE ORDER BY id ASC LIMIT 1`;
        if (freePins.length === 0) return null;

        const pin = freePins[0];
        await sql`UPDATE pin_depot SET is_used = TRUE WHERE id = ${pin.id}`;
        await sql`UPDATE bookings SET lock_pin = ${pin.pin_code} WHERE id = ${b.id}`;

        return { guest_name: b.guest_name, pin: pin.pin_code, check_in: b.check_in };
    } catch (e) {
        console.error("DB Error:", e);
        return null;
    }
}

function formatHistory(history) {
    let parsed = [];
    if (typeof history === 'string') {
        try { parsed = JSON.parse(history); } catch (e) {}
    } else if (Array.isArray(history)) {
        parsed = history;
    }
    return parsed.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
    }));
}