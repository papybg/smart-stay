/**
 * ============================================================================
 * ИНТЕГРАЦИЯ С AUTOREMOTE - Комуникация с Tasker на телефона
 * ============================================================================
 * 
 * Праща команди към Tasker на телефона през AutoRemote облачен сервис
 * AutoRemote работи като push notification - изпраща съобщение към телефона
 * Tasker чака точното съобщение и стартира сцена в Smart Life
 * 
 * ПОТОК: Backend → AutoRemote API → Push Notification → Tasker → Smart Life → Tuya устройство
 */

import axios from 'axios';

// Личен AutoRemote ключ - ЗАДЪЛЖИТЕЛНО В .env ФАЈЛ
const AR_KEY = process.env.AUTOREMOTE_KEY;

// Проверка дали ключа е зададен
if (!AR_KEY) {
    console.warn('[AUTOREMOTE] ⚠️ AUTOREMOTE_KEY не е зададен в environment variables!');
    console.warn('[AUTOREMOTE] ⚠️ Командите към Tasker НЯМА ДА РАБОТЯТ');
}

/**
 * Изпраща команда към Tasker на телефона
 * 
 * @async
 * @param {string} command - 'meter_on' или 'meter_off'
 * @returns {Promise<boolean>} True ако успешно е изпратено
 */
export async function sendCommandToPhone(command) {
    // Ако ключа не е зададен, върни false
    if (!AR_KEY) {
        console.error('[AUTOREMOTE] ❌ Невозможно да се изпрати команда - AUTOREMOTE_KEY липсва');
        return false;
    }

    const url = 'https://autoremotejoaomgcd.appspot.com/sendmessage';

    try {
        console.log(`[AUTOREMOTE] 📤 Изпращам команда към Tasker: ${command}`);
        
        const response = await axios.get(url, {
            params: {
                key: AR_KEY,
                message: command
            },
            timeout: 5000 // 5 секунди timeout
        });

        // AutoRemote връща 200 ако е успешно
        if (response.status === 200) {
            console.log(`[AUTOREMOTE] ✅ ${command} изпратена към телефона`);
            return true;
        } else {
            console.warn(`[AUTOREMOTE] ⚠️ Неочакван отговор:`, response.status);
            return false;
        }
    } catch (error) {
        console.error(`[AUTOREMOTE] ❌ Грешка при връзка:`, error.message);
        return false;
    }
}

/**
 * Управление на тока (мостова функция)
 * @async
 * @param {boolean} turnOn - true за ВКЛ, false за ИЗКЛ
 * @returns {Promise<boolean>}
 */
export async function controlPower(turnOn) {
    const command = turnOn ? 'meter_on' : 'meter_off';
    return await sendCommandToPhone(command);
}
