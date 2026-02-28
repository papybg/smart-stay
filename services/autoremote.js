import axios from 'axios';
import { neon } from '@neondatabase/serverless';
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
let stAccessToken = process.env.ST_ACCESS_TOKEN;
let stRefreshToken = process.env.ST_REFRESH_TOKEN;
export { stAccessToken };
async function loadTokenFromDB() {
    if (!sql) return;
    try {
        await sql`CREATE TABLE IF NOT EXISTS system_settings (key VARCHAR(50) PRIMARY KEY, value TEXT)`;
        const rows = await sql`SELECT value FROM system_settings WHERE key = 'st_refresh_token'`;
        if (rows.length > 0 && rows[0].value) {
            stRefreshToken = rows[0].value;
            console.log('[SMARTTHINGS] ℹ️ Refresh token зареден от базата данни');
        }
    } catch (e) {
        console.error('[SMARTTHINGS] ⚠️ Грешка при зареждане на токена от DB:', e.message);
    }
}
export async function ensureValidSTAccessToken({ forceRefresh = false } = {}) {
    if (forceRefresh || !stAccessToken) {
        const refreshed = await refreshSTToken();
        if (!refreshed) return null;
    }
    return stAccessToken || null;
}
const SMARTTHINGS_DEVICE_ID_ON = process.env.SMARTTHINGS_DEVICE_ID_ON || process.env.SMARTTHINGS_DEVICE_ID;
const SMARTTHINGS_DEVICE_ID_OFF = process.env.SMARTTHINGS_DEVICE_ID_OFF || process.env.SMARTTHINGS_DEVICE_ID;
const SMARTTHINGS_COMMAND_ON = process.env.SMARTTHINGS_COMMAND_ON || 'on';
const SMARTTHINGS_COMMAND_OFF = process.env.SMARTTHINGS_COMMAND_OFF || 'off';
console.log('[SMARTTHINGS:DEBUG] ENV DEVICE IDs ON/OFF:', SMARTTHINGS_DEVICE_ID_ON, SMARTTHINGS_DEVICE_ID_OFF);
async function refreshSTToken() {
    if (!process.env.ST_CLIENT_ID || !process.env.ST_CLIENT_SECRET || !stRefreshToken) {
        console.error('[SMARTTHINGS] ❌ Липсват ST_CLIENT_ID/ST_CLIENT_SECRET/ST_REFRESH_TOKEN за OAuth refresh');
        return false;
    }
    try {
        const previewParams = { grant_type: 'refresh_token', refresh_token: stRefreshToken ? stRefreshToken.substring(0,10) + '...' : undefined };
        console.log('[SMARTTHINGS:REFRESH_DEBUG] Request params (body):', previewParams);
        const basicAuth = Buffer.from(`${process.env.ST_CLIENT_ID}:${process.env.ST_CLIENT_SECRET}`).toString('base64');
        console.log('[SMARTTHINGS:REFRESH_DEBUG] Using Basic Auth header for client credentials');
        const response = await axios.post('https://api.smartthings.com/oauth/token', new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: stRefreshToken
        }).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + basicAuth },
            timeout: 10000
        });
        if (!response.data?.access_token) {
            console.error('[SMARTTHINGS] ❌ Липсва access_token в OAuth refresh отговора');
            return false;
        }
        stAccessToken = response.data.access_token;
        if (response.data.refresh_token) {
            stRefreshToken = response.data.refresh_token;
            if (sql) {
                try {
                    await sql`CREATE TABLE IF NOT EXISTS system_settings (key VARCHAR(50) PRIMARY KEY, value TEXT)`;
                    await sql`INSERT INTO system_settings (key, value) VALUES ('st_refresh_token', ${stRefreshToken}) ON CONFLICT (key) DO UPDATE SET value = ${stRefreshToken}`;
                    console.log('[SMARTTHINGS] ✅ Новият Refresh token е записан в базата данни');
                } catch (dbErr) {
                    console.error('[SMARTTHINGS] ⚠️ Грешка при запис на токена в DB:', dbErr.message);
                }
            }
        }
        console.log('[SMARTTHINGS] ✅ Токенът е обновен!');
        return true;
    } catch (err) {
        console.error('[SMARTTHINGS] ❌ Грешка (refresh):', err.response?.data || err.message);
        return false;
    }
}
async function sendSTCommand(deviceId, cmd, retryCount = 0) {
    try {
        const token = await ensureValidSTAccessToken();
        global.lastTokenRefresh = global.lastTokenRefresh || null;
        console.log('[SMARTTHINGS:DEBUG] Използван токен:', token ? 'От паметта (fresh)' : 'От env (може да е изтекъл)');
        console.log('[SMARTTHINGS:DEBUG] Token value (първи 20 символа):', (token || process.env.ST_ACCESS_TOKEN || '').substring(0, 20));
        console.log('[SMARTTHINGS:DEBUG] Token последно обновен:', global.lastTokenRefresh || 'Никога');
        console.log('[SMARTTHINGS:DEBUG] Времето сега:', new Date().toISOString());
        const url = `https://api.smartthings.com/v1/devices/${deviceId}/commands`;
        console.log('[SMARTTHINGS:DEBUG] Request URL:', url);
        console.log('[SMARTTHINGS:DEBUG] Device ID:', deviceId);
        console.log('[SMARTTHINGS:DEBUG] Command:', cmd);
        await axios.post(url, { commands: [{ component: 'main', capability: 'switch', command: cmd }] }, { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 });
        console.log(`[SMARTTHINGS] 📤 Успешно: ${cmd}`);
        return true;
    } catch (err) {
        if (err.response?.status === 401 && retryCount < 1) {
            console.log('[SMARTTHINGS] ⚠️ Изтекъл токен, подновявам...');
            const refreshed = await refreshSTToken();
            if (!refreshed) return false;
            global.lastTokenRefresh = new Date().toISOString();
            return sendSTCommand(deviceId, cmd, retryCount + 1);
        }
        if (err.response?.status === 403 && retryCount < 1) {
            console.warn('[SMARTTHINGS] ⚠️ 403 Forbidden - проверявам налични устройства');
            const newId = await discoverDeviceId(deviceId);
            if (newId && newId !== deviceId) {
                console.log('[SMARTTHINGS] ℹ️ Открито ново deviceId:', newId);
                if (deviceId === SMARTTHINGS_DEVICE_ID_ON) process.env.SMARTTHINGS_DEVICE_ID_ON = newId;
                if (deviceId === SMARTTHINGS_DEVICE_ID_OFF) process.env.SMARTTHINGS_DEVICE_ID_OFF = newId;
                return sendSTCommand(newId, cmd, retryCount + 1);
            }
        }
        console.error('[SMARTTHINGS] ❌ Грешка (команда):', err.response?.data || err.message);
        console.error('[SMARTTHINGS:DEBUG] Full error:', err.response?.data);
        return false;
    }
}
async function discoverDeviceId(failedId) {
    const token = await ensureValidSTAccessToken();
    if (!token) return null;
    try {
        const resp = await axios.get('https://api.smartthings.com/v1/devices', { headers: { Authorization: `Bearer ${token}` } });
        const list = resp.data?.items || resp.data;
        if (!Array.isArray(list)) return null;
        for (const d of list) {
            if (d.deviceId === failedId) continue;
            const lbl = String(d.label || '').toLowerCase();
            if (lbl.includes('start') || lbl.includes('stop') || lbl.includes('c2c')) return d.deviceId;
        }
        const viper = list.find(d => d.type === 'VIPER');
        return viper?.deviceId || null;
    } catch (e) {
        console.warn('[SMARTTHINGS] ⚠️ Неуспех при търсене на устройства:', e.message);
        return null;
    }
}
(async () => {
    await loadTokenFromDB();
    if (stRefreshToken) {
        try {
            const ok = await refreshSTToken();
            if (ok) {
                global.lastTokenRefresh = new Date().toISOString();
                console.log('[SMARTTHINGS] ℹ️ Initial token refresh completed on startup');
            }
        } catch (e) {
            console.warn('[SMARTTHINGS] ⚠️ Initial token refresh failed:', e.message);
        }
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
        if (typeof tokenRefreshInterval.unref === 'function') tokenRefreshInterval.unref();
    }
})();
export async function controlPower(turnOn) {
    const command = turnOn ? SMARTTHINGS_COMMAND_ON : SMARTTHINGS_COMMAND_OFF;
    const targetDeviceId = turnOn ? SMARTTHINGS_DEVICE_ID_ON : SMARTTHINGS_DEVICE_ID_OFF;
    if (!targetDeviceId) {
        console.error('[SMARTTHINGS] ❌ Липсва ID на устройство (SMARTTHINGS_DEVICE_ID_ON/OFF)');
        return false;
    }
    return await sendSTCommand(targetDeviceId, command);
}
export async function controlMeterByAction(action) {
    const normalized = String(action || '').trim().toLowerCase();
    if (normalized !== 'on' && normalized !== 'off') return { success: false, command: '' };
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
if (!process.env.ST_CLIENT_ID || !process.env.ST_CLIENT_SECRET) {
    console.warn('[SMARTTHINGS] ⚠️ OAuth2 не е напълно конфигуриран. Липсват ST_CLIENT_ID, ST_CLIENT_SECRET.');
}