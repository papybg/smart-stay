import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';

// --- КОНСТАНТИ И МОДЕЛИ (НЕ ПРОМЕНЯЙ) ---
const MODELS = ["gemini-3-pro-preview", "gemini-flash-latest", "gemini-3-flash-preview"];
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

/**
 * Основна функция за комуникация с AI
 * @param {string} userMessage - Съобщението от клиента
 * @param {any} history - История на чата
 */
export async function getAIResponse(userMessage, history) {
    if (!genAI) return "Error: Gemini API Key missing.";

    // 1. Проверка за резервационен код в съобщението
    // Търсим 5 до 10 символа (букви и цифри), напр. HMQWZ123
    const possibleCodeMatch = userMessage.match(/\b[A-Z0-9]{5,10}\b/i);
    let systemContext = "";

    if (possibleCodeMatch) {
        const code = possibleCodeMatch[0].toUpperCase();
        const pinData = await checkBookingAndGetPin(code);
        
        if (pinData) {
            systemContext = `
            [СИСТЕМНА ИНФОРМАЦИЯ]: 
            Потребителят предостави валиден код за резервация: ${code}.
            Име на госта: ${pinData.guest_name}.
            Неговият ПИН код за вратата е: ${pinData.pin}.
            Дата на настаняване: ${pinData.check_in}.
            Предостави му ПИН кода учтиво сега.
            `;
        }
    }

    // 2. Завъртане на моделите
    for (const modelName of MODELS) {
        try {
            const model = genAI.getGenerativeModel({ model: modelName });

            const systemInstruction = `
            Ти си Ико - виртуалният иконом на Smart Stay.
            Твоята цел е да помагаш на гостите. Бъди кратък, учтив и полезен.
            Ако те питат за ПИН код или достъп, помоли ги за техния резервационен номер (код от Airbnb).
            ${systemContext}
            ВАЖНО: Ако имаш [СИСТЕМНА ИНФОРМАЦИЯ] по-горе с ПИН код, дай го на потребителя.
            `;

            const chat = model.startChat({
                history: formatHistory(history),
                generationConfig: { maxOutputTokens: 600 },
            });

            // Изпращаме системната инструкция като част от първото съобщение
            const result = await chat.sendMessage(`${systemInstruction}\nUser message: ${userMessage}`);
            return result.response.text();

        } catch (error) {
            console.error(`⚠️ Грешка с модел ${modelName}:`, error.message);
            continue; // Пробвай следващия модел
        }
    }

    return "Съжалявам, имам малък технически проблем в момента. Моля опитайте пак след малко.";
}

/**
 * Вътрешна функция: Проверява резервация и вади ПИН от pin_depot
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

        // Б. Ако вече има ПИН, връщаме го веднага
        if (booking.lock_pin) {
            return { guest_name: booking.guest_name, pin: booking.lock_pin, check_in: booking.check_in };
        }

        // В. Ако няма ПИН, взимаме от склада (pin_depot)
        // Взимаме първия свободен
        const freePins = await sql`
            SELECT * FROM pin_depot 
            WHERE is_used = FALSE 
            ORDER BY id ASC 
            LIMIT 1
        `;

        if (freePins.length === 0) {
            console.error("🚨 КРИТИЧНО: Няма свободни ПИН кодове в склада (pin_depot)!");
            return null; 
        }

        const pinToAssign = freePins[0];

        // Г. Маркираме ПИН-а като използван в склада
        await sql`UPDATE pin_depot SET is_used = TRUE WHERE id = ${pinToAssign.id}`;

        // Д. Записваме ПИН-а в резервацията
        await sql`UPDATE bookings SET lock_pin = ${pinToAssign.pin_code} WHERE id = ${booking.id}`;

        return { 
            guest_name: booking.guest_name, 
            pin: pinToAssign.pin_code, 
            check_in: booking.check_in 
        };

    } catch (e) {
        console.error("DB Error in checkBookingAndGetPin:", e);
        return null;
    }
}

// Помощна функция за форматиране на историята
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