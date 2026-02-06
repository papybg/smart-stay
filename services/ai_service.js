import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';
import fs from 'fs/promises';
import path from 'path';

const MODELS = ["gemini-3-pro-preview", "gemini-flash-latest", "gemini-3-flash-preview"];
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const AUTOMATION_URL = process.env.AUTOMATION_SERVICE_URL || 'http://localhost:10000';
const HOST_CODE = process.env.HOST_CODE;

/**
 * Automation Service API Client
 */
const automationClient = {
    async getPowerStatus() {
        try {
            const res = await fetch(`${AUTOMATION_URL}/api/power-status`);
            if (!res.ok) return { online: false, isOn: false };
            return await res.json();
        } catch (e) {
            console.error('Power status check failed:', e.message);
            return { online: false, isOn: false };
        }
    },

    async controlPower(state) {
        try {
            const res = await fetch(`${AUTOMATION_URL}/api/power-control`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ state })
            });
            return res.ok;
        } catch (e) {
            console.error('Power control failed:', e.message);
            return false;
        }
    },

    async sendAlert(message, guestInfo) {
        try {
            await fetch(`${AUTOMATION_URL}/api/alert`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, guestInfo })
            });
            return true;
        } catch (e) {
            console.error('Alert send failed:', e.message);
            return false;
        }
    },

    async getBookings() {
        try {
            const res = await fetch(`${AUTOMATION_URL}/api/bookings`);
            if (!res.ok) return [];
            return await res.json();
        } catch (e) {
            console.error('Get bookings failed:', e.message);
            return [];
        }
    }
};

/**
 * Определяне на ролята на потребителя
 */
export async function determineUserRole(authCode, userMessage) {
    // 1. Проверка за HOST
    if (authCode === HOST_CODE) {
        return { role: 'host', data: null };
    }

    // 2. Проверка за код в съобщението или authCode
    const textCodeMatch = userMessage?.trim().toUpperCase().match(/HM[A-Z0-9]+/);
    const codeToTest = textCodeMatch ? textCodeMatch[0] : authCode;

    if (!codeToTest) {
        return { role: 'stranger', data: null };
    }

    // 3. Проверка в базата
    if (!sql) return { role: 'stranger', data: null };

    try {
        const bookings = await sql`
            SELECT * FROM bookings 
            WHERE reservation_code = ${codeToTest} 
            LIMIT 1
        `;

        if (bookings.length > 0) {
            const booking = bookings[0];
            
            // Взимане/създаване на PIN
            let lockPin = booking.lock_pin;
            
            if (!lockPin) {
                const freePins = await sql`
                    SELECT * FROM pin_depot 
                    WHERE is_used = FALSE 
                    ORDER BY id ASC 
                    LIMIT 1
                `;
                
                if (freePins.length > 0) {
                    const pin = freePins[0];
                    await sql`UPDATE pin_depot SET is_used = TRUE WHERE id = ${pin.id}`;
                    await sql`UPDATE bookings SET lock_pin = ${pin.pin_code} WHERE id = ${booking.id}`;
                    lockPin = pin.pin_code;
                }
            }

            return {
                role: 'guest',
                data: {
                    guest_name: booking.guest_name,
                    reservation_code: booking.reservation_code,
                    check_in: booking.check_in,
                    check_out: booking.check_out,
                    lock_pin: lockPin,
                    booking_id: booking.id
                }
            };
        }
    } catch (e) {
        console.error('Role determination DB error:', e.message);
    }

    return { role: 'stranger', data: null };
}

/**
 * Генериране на system instruction според роля
 */
export function buildSystemInstruction(role, bookingData, powerStatus, manual, currentDateTime) {
    const { online, isOn } = powerStatus;

    if (role === 'host') {
        return `
📅 ДНЕС Е: ${currentDateTime} (Българско време)
🔑 РЕЖИМ: ДОМАКИН/АДМИНИСТРАТОР

📊 ТОК СТАТУС:
- Мрежа: ${online ? "✅ ОНЛАЙН" : "❌ ОФЛАЙН"}
- Бушон: ${isOn ? "✅ ВКЛЮЧЕН" : "⚠️ ИЗКЛЮЧЕН"}

📋 ПЪЛЕН НАРЪЧНИК:
${manual}

🤖 ТВОИ ВЪЗМОЖНОСТИ:
- Пълен достъп до информация и управление.
- Отговаряй на български.
`;
    }

    if (role === 'guest') {
        const guestInfo = bookingData ? `
👤 ВАШАТА РЕЗЕРВАЦИЯ:
- Име: ${bookingData.guest_name}
- Check-in: ${new Date(bookingData.check_in).toLocaleString('bg-BG')}
- Check-out: ${new Date(bookingData.check_out).toLocaleString('bg-BG')}
- Код за брава: ${bookingData.lock_pin || 'генерира се...'}
` : '';

        return `
📅 ДНЕС Е: ${currentDateTime} (Българско време)
🏠 ДОБРЕ ДОШЛИ В АПАРТАМЕНТ D105!

${guestInfo}

📋 ИНФОРМАЦИЯ ЗА ВАШИЯ ПРЕСТОЙ:
${manual}

📊 СТАТУС НА СИСТЕМИТЕ:
- Електричество: ${isOn ? "✅ Работи" : "⚠️ Проблем"}

🎯 ВАЖНО ЗА WIFI:
- Мрежа: SmartStay_Guest
- Парола: vacation_mode
(Давай паролата само ако питат)

⚠️ ПРИ ПРОБЛЕМ:
- При спешност използвам [ALERT: ...] за да уведомя домакина.

💬 ТОНЪТ МИ: Приятелски, полезен. Отговарям на български.
`;
    }

    // Stranger
    return `
📅 ДНЕС Е: ${currentDateTime} (Българско време)
👋 ЗДРАВЕЙТЕ! АЗ СЪМ ИКО.

🔒 СТАТУС: Непознат посетител.

ℹ️ МОГА ДА ВИ КАЖА:
- Обща информация за комплекса и района.
- Как да направите резервация.

🚫 НЕ МОГА ДА СПОДЕЛЯ:
- WiFi парола
- Код за врата
- Лична информация

🔑 ЗА ДОСТЪП: Моля въведете код на резервация (HM...), за да активирам асистента.
`;
}

/**
 * Проверка за аварийно управление на тока
 */
export async function checkEmergencyPower(userMessage, role, bookingData) {
    const needsPower = /няма ток|без ток|не работи ток|изключен ток|спрян ток/i.test(userMessage);
    
    if (needsPower && role === 'guest') {
        const powerStatus = await automationClient.getPowerStatus();
        
        if (powerStatus.online && !powerStatus.isOn) {
            const success = await automationClient.controlPower(true);
            
            if (success) {
                await automationClient.sendAlert(
                    `АВАРИЙНО ВКЛЮЧВАНЕ: Клиентът поиска ток. Пуснах го автоматично.`,
                    {
                        guest_name: bookingData?.guest_name || 'Непознат',
                        reservation_code: bookingData?.reservation_code || 'N/A',
                        role: role
                    }
                );
                return "\n\n✅ (Система: Автоматично възстанових захранването.)";
            }
        }
    }
    
    return "";
}

/**
 * Обработка на [ALERT] тагове
 */
export async function processAlerts(aiResponse, role, bookingData) {
    if (!aiResponse.includes('[ALERT:')) {
        return aiResponse;
    }

    const match = aiResponse.match(/\[ALERT:(.*?)\]/);
    
    if (match && match[1]) {
        await automationClient.sendAlert(
            match[1].trim(),
            {
                guest_name: bookingData?.guest_name || 'Непознат',
                reservation_code: bookingData?.reservation_code || 'N/A',
                role: role
            }
        );
    }

    // Премахване на [ALERT:...] таговете от отговора
    return aiResponse.replace(/\[ALERT:.*?\]/g, '').trim();
}

/**
 * Основна функция за комуникация с AI
 */
export async function getAIResponse(userMessage, history = [], authCode = null) {
    // Validation
    if (!userMessage || userMessage.trim() === '') {
        return "Моля напишете нещо.";
    }

    if (!genAI) {
        return "Error: Gemini API Key missing.";
    }

    // 1. ЧЕТЕНЕ НА MANUAL.TXT
    let houseManual = "";
    try {
        houseManual = await fs.readFile(path.join(process.cwd(), 'manual.txt'), 'utf-8');
    } catch (err) {
        console.error("⚠️ Не мога да намеря manual.txt");
        houseManual = "Липсва manual.txt файл.";
    }

    // 2. ОПРЕДЕЛЯНЕ НА РОЛЯ
    const { role, data: bookingData } = await determineUserRole(authCode, userMessage);
    
    console.log(`🔐 User role: ${role}`, bookingData ? `(${bookingData.guest_name})` : '');

    // 3. HARDWARE STATUS
    const powerStatus = await automationClient.getPowerStatus();

    // 4. ТЕКУЩА ДАТА/ЧАС
    const currentDateTime = new Date().toLocaleString('bg-BG', { 
        timeZone: 'Europe/Sofia',
        dateStyle: 'full',
        timeStyle: 'short'
    });

    // 5. BUILD SYSTEM INSTRUCTION
    const systemInstruction = buildSystemInstruction(
        role, 
        bookingData, 
        powerStatus, 
        houseManual, 
        currentDateTime
    );

    // 6. AI RESPONSE (с fallback)
    let finalReply = "Съжалявам, имам технически проблем. Моля опитайте пак.";

    for (const modelName of MODELS) {
        try {
            const model = genAI.getGenerativeModel({ 
                model: modelName,
                systemInstruction 
            });

            const chat = model.startChat({ 
                history: formatHistory(history) 
            });

            const result = await chat.sendMessage(userMessage);
            finalReply = result.response.text();
            
            console.log(`✅ AI response from ${modelName}`);
            break; 
            
        } catch (error) {
            console.error(`❌ Грешка с модел ${modelName}:`, error.message);
            continue;
        }
    }

    // 7. АВАРИЙНО УПРАВЛЕНИЕ
    const emergencyNote = await checkEmergencyPower(userMessage, role, bookingData);
    if (emergencyNote) {
        finalReply += emergencyNote;
    }

    // 8. ОБРАБОТКА НА ALERTS
    finalReply = await processAlerts(finalReply, role, bookingData);

    return finalReply;
}

/**
 * Форматиране на история за Gemini
 */
function formatHistory(history) {
    let parsed = [];
    
    if (typeof history === 'string') {
        try { 
            parsed = JSON.parse(history); 
        } catch (e) {
            console.error('History parse error:', e.message);
        }
    } else if (Array.isArray(history)) {
        parsed = history;
    }
    
    return parsed.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
    }));
}

/**
 * Legacy функция за обратна съвместимост
 */
export async function checkBookingAndGetPin(reservationCode) {
    const { role, data } = await determineUserRole(reservationCode, '');
    
    if (role === 'guest' && data) {
        return {
            guest_name: data.guest_name,
            pin: data.lock_pin,
            check_in: data.check_in
        };
    }
    
    return null;
}