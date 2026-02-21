/**
 * ============================================================================
 * SAMSUNG SMARTTHINGS DIRECT INTEGRATION
 * ============================================================================
 *
 * Основен поток: Backend → SmartThings API → Tuya/SmartLife интегрирано устройство
 * Tasker е само за ОБРАТНА ВРЪЗКА (feedback) през /api/power-status.
 */

import axios from 'axios';

const SMARTTHINGS_TOKEN = process.env.SMARTTHINGS_API_TOKEN
    || process.env.SMARTTHINGS_TOKEN
    || process.env.SAMSUNG_API_KEY
    || '';
const SMARTTHINGS_DEVICE_ID = process.env.SMARTTHINGS_DEVICE_ID
    || process.env.SAMSUNG_DEVICE_ID
    || '';
const SMARTTHINGS_DEVICE_ID_ON = process.env.SMARTTHINGS_DEVICE_ID_ON || SMARTTHINGS_DEVICE_ID;
const SMARTTHINGS_DEVICE_ID_OFF = process.env.SMARTTHINGS_DEVICE_ID_OFF || SMARTTHINGS_DEVICE_ID;
const SMARTTHINGS_COMPONENT = process.env.SMARTTHINGS_COMPONENT || 'main';
const SMARTTHINGS_API_URL = process.env.SMARTTHINGS_API_URL || 'https://api.smartthings.com/v1';
const SMARTTHINGS_COMMAND_ON = process.env.SMARTTHINGS_COMMAND_ON || 'on';
const SMARTTHINGS_COMMAND_OFF = process.env.SMARTTHINGS_COMMAND_OFF || 'off';
const SMARTTHINGS_SCENE_COMMAND = process.env.SMARTTHINGS_SCENE_COMMAND || 'on';
const USE_SPLIT_SCENE_DEVICES =
    Boolean(SMARTTHINGS_DEVICE_ID_ON)
    && Boolean(SMARTTHINGS_DEVICE_ID_OFF)
    && SMARTTHINGS_DEVICE_ID_ON !== SMARTTHINGS_DEVICE_ID_OFF;

if (!SMARTTHINGS_TOKEN || (!SMARTTHINGS_DEVICE_ID_ON && !SMARTTHINGS_DEVICE_ID_OFF)) {
    console.warn('[SMARTTHINGS] ⚠️ Липсват SMARTTHINGS token/device id в env');
}

/**
 * Изпраща команда към Samsung SmartThings устройството
 *
 * @async
 * @param {'on'|'off'} switchCommand
 * @returns {Promise<boolean>} True ако успешно е изпратено
 */
export async function sendCommandToSamsung(switchCommand, targetDeviceId = SMARTTHINGS_DEVICE_ID) {
    if (!SMARTTHINGS_TOKEN || !targetDeviceId) {
        console.error('[SMARTTHINGS] ❌ Липсва SMARTTHINGS_TOKEN или SMARTTHINGS_DEVICE_ID');
        return false;
    }

    const normalized = String(switchCommand || '').trim().toLowerCase();
    if (normalized !== 'on' && normalized !== 'off') {
        console.error(`[SMARTTHINGS] ❌ Невалидна команда: ${switchCommand}`);
        return false;
    }

    const url = `${SMARTTHINGS_API_URL}/devices/${targetDeviceId}/commands`;

    try {
        console.log(`[SMARTTHINGS] 📤 Изпращам ${normalized.toUpperCase()} към device ${targetDeviceId}`);

        const response = await axios.post(url, {
            commands: [
                {
                    component: SMARTTHINGS_COMPONENT,
                    capability: 'switch',
                    command: normalized
                }
            ]
        }, {
            headers: {
                Authorization: `Bearer ${SMARTTHINGS_TOKEN}`,
                'Content-Type': 'application/json'
            },
            timeout: 8000
        });

        if (response.status >= 200 && response.status < 300) {
            console.log(`[SMARTTHINGS] ✅ Команда ${normalized.toUpperCase()} изпратена успешно`);
            return true;
        }

        console.warn('[SMARTTHINGS] ⚠️ Неочакван отговор:', response.status);
        return false;
    } catch (error) {
        const details = error?.response?.data ? JSON.stringify(error.response.data) : error.message;
        console.error('[SMARTTHINGS] ❌ Грешка при команда:', details);
        return false;
    }
}

/**
 * Управление на тока (директно през Samsung)
 * @async
 * @param {boolean} turnOn - true за ВКЛ, false за ИЗКЛ
 * @returns {Promise<boolean>}
 */
export async function controlPower(turnOn) {
    const command = USE_SPLIT_SCENE_DEVICES
        ? SMARTTHINGS_SCENE_COMMAND
        : (turnOn ? SMARTTHINGS_COMMAND_ON : SMARTTHINGS_COMMAND_OFF);
    const targetDeviceId = turnOn ? SMARTTHINGS_DEVICE_ID_ON : SMARTTHINGS_DEVICE_ID_OFF;
    return await sendCommandToSamsung(command, targetDeviceId);
}

/**
 * Управление на електромера по текстова команда (за Samsung/Tasker endpoint-и)
 * @param {'on'|'off'} action
 * @returns {Promise<{success: boolean, command: string}>}
 */
export async function controlMeterByAction(action) {
    const normalized = String(action || '').trim().toLowerCase();
    if (normalized !== 'on' && normalized !== 'off') {
        return { success: false, command: '' };
    }

    const turnOn = normalized === 'on';
    const command = USE_SPLIT_SCENE_DEVICES
        ? SMARTTHINGS_SCENE_COMMAND
        : (turnOn ? SMARTTHINGS_COMMAND_ON : SMARTTHINGS_COMMAND_OFF);
    const targetDeviceId = turnOn ? SMARTTHINGS_DEVICE_ID_ON : SMARTTHINGS_DEVICE_ID_OFF;
    const success = await sendCommandToSamsung(command, targetDeviceId);
    return { success, command };
}

/*
// LEGACY TASKER COMMAND FLOW (disabled intentionally)
// const AR_KEY = process.env.AUTOREMOTE_KEY;
// export async function sendCommandToPhone(command) { ... }
*/
