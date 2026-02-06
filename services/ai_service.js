import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';

// --- ТВОИТЕ МОДЕЛИ (ТОЧНО КАКТО ГИ ДАДЕ) ---
const MODELS = ["gemini-3-pro-preview", "gemini-flash-latest", "gemini-3-flash-preview"];

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

/**
 * Основна функция за комуникация с AI
 */
export async function getAIResponse(userMessage, history) {
    if (!genAI) return "Error: Gemini API Key missing.";

    // 1. Проверка за резервационен код
    const possibleCodeMatch = userMessage.match(/\b[A-Z0-9]{5,10}\b/i);
    let systemContext = "";

    if (possibleCodeMatch) {
        const code = possibleCodeMatch[0].toUpperCase();
        const pinData = await checkBookingAndGetPin(code);
        
        if (pinData) {
            systemContext = `
            [СИСТЕМНА ИНФОРМАЦИЯ]: 
            Потребителят даде код: ${code}.
            Гост: ${pinData.guest_name}.
            ПИН: ${pinData.pin}.
            Настаняване: ${pinData.check_in}.
            ДАЙ МУ ПИН КОДА СЕГА.
            `;
        }
    }

    // 2. Завъртане на моделите (Fallback Logic)
    for (const modelName of MODELS) {
        try {
            const model = genAI.getGenerativeModel({ model: modelName });

            const systemInstruction = `
            Ти си Ико - виртуалният иконом на Smart Stay.
            Цел: Помагай на гостите кратко и учтиво.
            Ако искат ПИН, питай за резервационен номер.
            ${systemContext}
            ВАЖНО: Ако виждаш [СИСТЕМНА ИНФОРМАЦИЯ] с ПИН по-горе, дай го веднага!
            `;

            const chat = model.startChat({
                history: formatHistory(history),
                generationConfig: { maxOutputTokens: 600 },
            });

            // Изпращаме промпта + съобщението
            const result = await chat.sendMessage(`${systemInstruction}\nUser message: ${userMessage}`);
            return result.response.text();

        } catch (error) {
            console.error(`⚠️ Грешка с модел ${modelName}:`, error.message);
            // Тук е разковничето: вместо да спре, продължава към следващия модел в списъка!
            continue; 
        }
    }

    return "Съжалявам, в момента правим профилактика на системите. Моля опитайте след 1 минута.";
}

/**
 * Логика за ПИН-ове (pin_depot)
 */
async function checkBookingAndGetPin(reservationCode) {
    if (!sql) return null;

    try {
        // А. Намираме резервацията
        const bookings = await sql`
            SELECT * FROM bookings 
            WHERE reservation_code = ${reservationCode} OR reservation_code ILIKE ${reservationCode}
            LIMIT 1
        `;

        if (bookings.length === 0) return null;
        const booking = bookings[0];

        // Б. Ако вече има ПИН, връщаме го
        if (booking.lock_pin) return { guest_name: booking.guest_name, pin: booking.lock_pin, check_in: booking.check_in };

        // В. Взимаме нов от склада
        const freePins = await sql`SELECT * FROM pin_depot WHERE is_used = FALSE ORDER BY id ASC LIMIT 1`;

        if (freePins.length === 0) {
            console.error("🚨 НЯМА СВОБОДНИ ПИНОВЕ!");
            return null; 
        }

        const pinToAssign = freePins[0];

        // Г. Записваме
        await sql`UPDATE pin_depot SET is_used = TRUE WHERE id = ${pinToAssign.id}`;
        await sql`UPDATE bookings SET lock_pin = ${pinToAssign.pin_code} WHERE id = ${booking.id}`;

        return { guest_name: booking.guest_name, pin: pinToAssign.pin_code, check_in: booking.check_in };

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