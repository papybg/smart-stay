/**
 * ============================================================================
 * AUTOREMOTE INTEGRATION - Communication with Tasker on Phone
 * ============================================================================
 * 
 * Праща команди към Tasker на телефона через AutoRemote облачен сервис
 * AutoRemote работи като push notification - изпраща message към телефона
 * Tasker чака точния message и стартира сцена в Smart Life
 * 
 * ПОТОК: Backend → AutoRemote API → Push Notification → Tasker → Smart Life → Tuya Device
 */

import axios from 'axios';

// Твоят личен AutoRemote ключ (идентифицира телефона)
const AR_KEY = process.env.AUTOREMOTE_KEY || "ezBgKKyplbw:APA91bFragO5EGz97gX7--T6_4hM8Ke33l_ycW_46ks3tGTUZoAyglhekPyMczmv6PBpFCvDIot1tjylhx-mgskkrVNXWRneOeu6I9JOW35qFd6jqyRpeqU";

/**
 * Изпраща команда към Tasker на телефона
 * 
 * @async
 * @param {string} command - 'meter_on' или 'meter_off'
 * @returns {Promise<boolean>} True ако успешно изпратено
 */
export async function sendCommandToPhone(command) {
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
 * Управление на тока (мост функция)
 * @async
 * @param {boolean} turnOn - true за ВКЛ, false за ИЗКЛ
 * @returns {Promise<boolean>}
 */
export async function controlPower(turnOn) {
    const command = turnOn ? 'meter_on' : 'meter_off';
    return await sendCommandToPhone(command);
}
