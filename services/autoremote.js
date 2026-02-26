import axios from 'axios';

// ============================================================================
// НОВ OAuth2-базиран модул за SmartThings
// ============================================================================

let stAccessToken = process.env.ST_ACCESS_TOKEN;
let stRefreshToken = process.env.ST_REFRESH_TOKEN;
export { stAccessToken };
// Legacy SmartThings PAT token logic removed. Only OAuth tokens are supported.

export async function ensureValidSTAccessToken({ forceRefresh = false } = {}) {
    if (forceRefresh || !stAccessToken) {
        const refreshed = await refreshSTToken();
        if (!refreshed) {
            return null;
        }
    }
    return stAccessToken || null;
}

// Променливи за устройствата, които се запазват от старата логика
const SMARTTHINGS_DEVICE_ID_ON = process.env.SMARTTHINGS_DEVICE_ID_ON || process.env.SMARTTHINGS_DEVICE_ID;
const SMARTTHINGS_DEVICE_ID_OFF = process.env.SMARTTHINGS_DEVICE_ID_OFF || process.env.SMARTTHINGS_DEVICE_ID;
const SMARTTHINGS_COMMAND_ON = process.env.SMARTTHINGS_COMMAND_ON || 'on';
const SMARTTHINGS_COMMAND_OFF = process.env.SMARTTHINGS_COMMAND_OFF || 'off';

/**
 *  refreshed ST token
 */
async function refreshSTToken() {
    if (!process.env.ST_CLIENT_ID || !process.env.ST_CLIENT_SECRET || !stRefreshToken) {
        console.error('[SMARTTHINGS] ❌ Липсват ST_CLIENT_ID/ST_CLIENT_SECRET/ST_REFRESH_TOKEN за OAuth refresh');
        return false;
    }

    try {
        // debug information about refresh request
        const previewParams = {
            grant_type: 'refresh_token',
            refresh_token: stRefreshToken ? stRefreshToken.substring(0,10) + '...' : undefined
        };
        console.log('[SMARTTHINGS:REFRESH_DEBUG] Request params (body):', previewParams);
        const basicAuth = Buffer.from(`${process.env.ST_CLIENT_ID}:${process.env.ST_CLIENT_SECRET}`).toString('base64');
        console.log('[SMARTTHINGS:REFRESH_DEBUG] Using Basic Auth header for client credentials');
        const response = await axios.post('https://api.smartthings.com/oauth/token', new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: stRefreshToken
        }).toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + basicAuth
            },
            timeout: 10000
        });

        if (!response.data?.access_token) {
            console.error('[SMARTTHINGS] ❌ Липсва access_token в OAuth refresh отговора');
            return false;
        }

        stAccessToken = response.data.access_token;
        if (response.data.refresh_token) {
            stRefreshToken = response.data.refresh_token;
        }
        console.log('[SMARTTHINGS] ✅ Токенът е обновен!');
        return true;
    } catch (err) {
        console.error('[SMARTTHINGS] ❌ Грешка (refresh):', err.response?.data || err.message);
        return false;
    }
}

/**
 * send ST command
 * @param {*} deviceId 
 * @param {*} cmd 
 * @returns 
 */
async function sendSTCommand(deviceId, cmd, retryCount = 0) {
    try {
        const token = await ensureValidSTAccessToken();
        // DEBUG LOGGING
        global.lastTokenRefresh = global.lastTokenRefresh || null;
        console.log('[SMARTTHINGS:DEBUG] Използван токен:', token ? 'От паметта (fresh)' : 'От env (може да е изтекъл)');
        console.log('[SMARTTHINGS:DEBUG] Token value (първи 20 символа):', (token || process.env.ST_ACCESS_TOKEN || '').substring(0, 20));
        console.log('[SMARTTHINGS:DEBUG] Token последно обновен:', global.lastTokenRefresh || 'Никога');
        console.log('[SMARTTHINGS:DEBUG] Времето сега:', new Date().toISOString());

        const url = `https://api.smartthings.com/v1/devices/${deviceId}/commands`;
        console.log('[SMARTTHINGS:DEBUG] Request URL:', url);
        console.log('[SMARTTHINGS:DEBUG] Device ID:', deviceId);
        console.log('[SMARTTHINGS:DEBUG] Command:', cmd);

        await axios.post(url, {
            commands: [{ component: 'main', capability: 'switch', command: cmd }]
        }, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10000
        });

        console.log(`[SMARTTHINGS] 📤 Успешно: ${cmd}`);
        return true; // Връщаме true при успех
    } catch (err) {
        if (err.response?.status === 401 && retryCount < 1) {
            console.log('[SMARTTHINGS] ⚠️ Изтекъл токен, подновявам...');
            const refreshed = await refreshSTToken();
            if (!refreshed) {
                return false;
            }
            global.lastTokenRefresh = new Date().toISOString();
            return sendSTCommand(deviceId, cmd, retryCount + 1);
        }

        console.error('[SMARTTHINGS] ❌ Грешка (команда):', err.response?.data || err.message);
        console.error('[SMARTTHINGS:DEBUG] Full error:', err.response?.data);
        return false; // Връщаме false при грешка
    }
}

// Автоматично обновяване на всеки 12 часа
if (stRefreshToken) {
    // форсирано обновяване веднага при старта
    (async () => {
        try {
            const ok = await refreshSTToken();
            if (ok) {
                global.lastTokenRefresh = new Date().toISOString();
                console.log('[SMARTTHINGS] ℹ️ Initial token refresh completed on startup');
            }
        } catch (e) {
            console.warn('[SMARTTHINGS] ⚠️ Initial token refresh failed:', e.message);
        }
    })();

    const tokenRefreshInterval = setInterval(async () => {
        try {
            const ok = await refreshSTToken();
            if (ok) {
                global.lastTokenRefresh = new Date().toISOString();
                console.log('[SMARTTHINGS] ℹ️ Periodic token refresh successful');
            }
        } catch (e) {
            console.warn('[SMARTTHINGS] ⚠️ Periodic token refresh error:', e.message);
        }
    }, 43200000);
    if (typeof tokenRefreshInterval.unref === 'function') {
        tokenRefreshInterval.unref();
    }
}


/**
 * Управление на тока (директно през Samsung с OAuth2)
 * @async
 * @param {boolean} turnOn - true за ВКЛ, false за ИЗКЛ
 * @returns {Promise<boolean>}
 */
export async function controlPower(turnOn) {
    const command = turnOn ? SMARTTHINGS_COMMAND_ON : SMARTTHINGS_COMMAND_OFF;
    const targetDeviceId = turnOn ? SMARTTHINGS_DEVICE_ID_ON : SMARTTHINGS_DEVICE_ID_OFF;

    if (!targetDeviceId) {
        console.error('[SMARTTHINGS] ❌ Липсва ID на устройство (SMARTTHINGS_DEVICE_ID_ON/OFF)');
        return false;
    }
    
    return await sendSTCommand(targetDeviceId, command);
}

/**
 * Управление на електромера по текстова команда (за Samsung/Tasker endpoint-и с OAuth2)
 * @param {'on'|'off'} action
 * @returns {Promise<{success: boolean, command: string}>}
 */
export async function controlMeterByAction(action) {
    const normalized = String(action || '').trim().toLowerCase();
    if (normalized !== 'on' && normalized !== 'off') {
        return { success: false, command: '' };
    }

    const turnOn = normalized === 'on';
    const command = turnOn ? SMARTTHINGS_COMMAND_ON : SMARTTHINGS_COMMAND_OFF;
    const targetDeviceId = turnOn ? SMARTTHINGS_DEVICE_ID_ON : SMARTTHINGS_DEVICE_ID_OFF;

    if (!targetDeviceId) {
        console.error('[SMARTTHINGS] ❌ Липсва ID на устройство (SMARTTHINGS_DEVICE_ID_ON/OFF)');
        return { success: false, command: '' };
    }

    const success = await sendSTCommand(targetDeviceId, command);
    return { success, command };
}

// Проверка при стартиране дали са налични нужните OAuth променливи
if (!process.env.ST_CLIENT_ID || !process.env.ST_CLIENT_SECRET || !stRefreshToken) {
    console.warn('[SMARTTHINGS] ⚠️ OAuth2 не е напълно конфигуриран. Липсват ST_CLIENT_ID, ST_CLIENT_SECRET или ST_REFRESH_TOKEN в env променливите.');
}
