// ============================================================================
// SMARTTHINGS AUTH (OAuth enabled with auto-refresh)
// ============================================================================
//
// Тази версия използва стандартен OAuth2 поток за SmartThings. Token-ите
// се съхраняват и автоматично се обновяват чрез refresh token. Стойностите
// се зареждат от база данни и/или .env (ST_ACCESS_TOKEN / ST_REFRESH_TOKEN).
// 
// Логиката включва:
//   • loadTokenFromDB() – извлича refresh token от system_settings таблицата.
//   • refreshSTToken() – извърша OAuth refresh, записва новите токени в DB.
//   • ensureValidSTAccessToken() – гарантира валиден access token, с optional
//     forceRefresh.
//   • фонова IIFE, която при стартиране зарежда/обновява токена и поставя
//     setInterval за обновяване на всеки 12 часа.
//   • sendSTCommand() – при 401 опитва повторно след обновяване на токена.
//
// Персоналният token (ST_ACCESS_TOKEN) е резервен път, но стандартният OAuth
// е предпочитан.  

import axios from 'axios';
import { neon } from '@neondatabase/serverless';

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
let stAccessToken = process.env.ST_ACCESS_TOKEN;
let stRefreshToken = process.env.ST_REFRESH_TOKEN;
export { stAccessToken };

// helper ensures a valid access token, refreshing if needed
export async function ensureValidSTAccessToken({ forceRefresh = false } = {}) {
    if (forceRefresh || !stAccessToken) {
        const refreshed = await refreshSTToken();
        if (!refreshed) return null;
    }
    return stAccessToken || null;
}

async function loadTokenFromDB() {
    if (!sql) return;
    try {
        await sql`CREATE TABLE IF NOT EXISTS system_settings (key VARCHAR(50) PRIMARY KEY, value TEXT)`;
        const rows = await sql`SELECT value FROM system_settings WHERE key = 'st_refresh_token'`;
        if (rows.length > 0 && rows[0].value) {
            stRefreshToken = rows[0].value;
            console.log('[SMARTTHINGS] ℹ️ Refresh token зареден от базата данни');
        } else if (process.env.ST_REFRESH_TOKEN) {
            stRefreshToken = process.env.ST_REFRESH_TOKEN;
            await sql`INSERT INTO system_settings (key, value) VALUES ('st_refresh_token', ${stRefreshToken}) ON CONFLICT (key) DO UPDATE SET value = ${stRefreshToken}`;
            console.log('[SMARTTHINGS] ℹ️ Refresh token записан от ENV в базата данни');
        }
    } catch (e) {
        console.error('[SMARTTHINGS] ⚠️ Грешка при зареждане на токена от DB:', e.message);
    }
}


const SMARTTHINGS_DEVICE_ID_ON = process.env.SMARTTHINGS_DEVICE_ID_ON || process.env.SMARTTHINGS_DEVICE_ID;
const SMARTTHINGS_DEVICE_ID_OFF = process.env.SMARTTHINGS_DEVICE_ID_OFF || process.env.SMARTTHINGS_DEVICE_ID;
const SMARTTHINGS_COMMAND_ON = process.env.SMARTTHINGS_COMMAND_ON || 'on';
const smartThingsCommandOffFromEnv = String(process.env.SMARTTHINGS_COMMAND_OFF || 'on').trim().toLowerCase();
const SMARTTHINGS_COMMAND_OFF = smartThingsCommandOffFromEnv === 'off' ? 'on' : (process.env.SMARTTHINGS_COMMAND_OFF || 'on');
const POWER_TRACE_LOGS_ENABLED = (process.env.POWER_TRACE_LOGS || 'true').toLowerCase() !== 'false';

function createTraceId() {
    return `st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeDeviceId(deviceId) {
    const value = String(deviceId || '').trim();
    if (!value) return 'missing';
    if (value.length <= 10) return value;
    return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function getTraceContext(context = {}) {
    return {
        traceId: String(context.traceId || '').trim() || createTraceId(),
        source: String(context.source || context.origin || 'unknown').trim() || 'unknown',
        requestPath: String(context.requestPath || '').trim() || '',
        action: String(context.action || '').trim().toLowerCase() || ''
    };
}

function getPowerTraceStore() {
    if (!global.__powerTraceStore) {
        global.__powerTraceStore = {
            maxEvents: Number(process.env.POWER_TRACE_MAX_EVENTS || 800),
            events: [],
            lastTraceId: null
        };
    }

    if (!Number.isFinite(global.__powerTraceStore.maxEvents) || global.__powerTraceStore.maxEvents < 100) {
        global.__powerTraceStore.maxEvents = 800;
    }

    return global.__powerTraceStore;
}

function recordSmartThingsTrace(traceId, stage, message, payload = null, level = 'info') {
    const store = getPowerTraceStore();
    const event = {
        ts: new Date().toISOString(),
        traceId,
        channel: 'smartthings',
        level,
        stage,
        message,
        payload: payload && typeof payload === 'object' ? payload : null
    };

    store.lastTraceId = traceId || store.lastTraceId;
    store.events.push(event);
    if (store.events.length > store.maxEvents) {
        store.events.splice(0, store.events.length - store.maxEvents);
    }
}

function traceLog(traceId, stage, message, payload = null, level = 'info') {
    if (!POWER_TRACE_LOGS_ENABLED) return;

    recordSmartThingsTrace(traceId, stage, message, payload, level);

    const line = `[SMARTTHINGS_FLOW:${traceId}] ${stage} ${message}`;
    if (level === 'error') {
        if (payload && typeof payload === 'object') console.error(line, payload);
        else console.error(line);
        return;
    }
    if (level === 'warn') {
        if (payload && typeof payload === 'object') console.warn(line, payload);
        else console.warn(line);
        return;
    }

    if (payload && typeof payload === 'object') {
        console.log(line, payload);
        return;
    }
    console.log(line);
}
// DEBUG: device IDs hidden for security
async function refreshSTToken() {
    if (!process.env.ST_CLIENT_ID || !process.env.ST_CLIENT_SECRET || !stRefreshToken) {
        console.error('[SMARTTHINGS] ❌ Липсват ST_CLIENT_ID/ST_CLIENT_SECRET/ST_REFRESH_TOKEN за OAuth refresh');
        return false;
    }
    try {
        const previewParams = { grant_type: 'refresh_token', refresh_token: stRefreshToken ? stRefreshToken.substring(0,10) + '...' : undefined };
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

async function sendSTCommand(deviceId, cmd, retryCount = 0, context = {}) {
    const traceContext = getTraceContext(context);
    const traceId = traceContext.traceId;

    try {
        traceLog(traceId, '1/6', 'Preparing SmartThings request', {
            command: cmd,
            deviceId: sanitizeDeviceId(deviceId),
            retryCount,
            source: traceContext.source,
            path: traceContext.requestPath || 'n/a'
        });

        const token = await ensureValidSTAccessToken();
        traceLog(traceId, '2/6', 'Access token ready', {
            hasToken: Boolean(token)
        });

        global.lastTokenRefresh = global.lastTokenRefresh || null;
        const url = `https://api.smartthings.com/v1/devices/${deviceId}/commands`;

        traceLog(traceId, '3/6', 'POST SmartThings /commands', {
            url: `https://api.smartthings.com/v1/devices/${sanitizeDeviceId(deviceId)}/commands`,
            command: cmd
        });

        await axios.post(url, { commands: [{ component: 'main', capability: 'switch', command: cmd }] }, { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 });

        traceLog(traceId, '4/6', 'SmartThings accepted command', {
            command: cmd,
            retryCount
        });

        traceLog(traceId, '5/6', 'Command flow completed successfully');
        console.log(`[SMARTTHINGS] 📤 Успешно: ${cmd}`);
        return true;
    } catch (err) {
        const statusCode = err.response?.status || null;

        traceLog(traceId, '4/6', 'SmartThings request failed', {
            statusCode,
            retryCount,
            error: err.message
        }, 'error');

        if (err.response?.status === 401 && retryCount < 1) {
            traceLog(traceId, '↻', '401 received, refreshing token and retrying', {
                retryNext: retryCount + 1
            }, 'warn');
            const refreshed = await refreshSTToken();
            if (!refreshed) return false;
            global.lastTokenRefresh = new Date().toISOString();
            return sendSTCommand(deviceId, cmd, retryCount + 1, traceContext);
        }
        if (err.response?.status === 403 && retryCount < 1) {
            console.warn('[SMARTTHINGS] ⚠️ 403 Forbidden - проверявам налични устройства');
            traceLog(traceId, '↻', '403 received, attempting device discovery', null, 'warn');
            const newId = await discoverDeviceId(deviceId, traceContext);
            if (newId && newId !== deviceId) {
                console.log('[SMARTTHINGS] ℹ️ Открито ново deviceId:', newId);
                traceLog(traceId, '↻', 'Device discovery found replacement device', {
                    oldDeviceId: sanitizeDeviceId(deviceId),
                    newDeviceId: sanitizeDeviceId(newId)
                });
                if (deviceId === SMARTTHINGS_DEVICE_ID_ON) process.env.SMARTTHINGS_DEVICE_ID_ON = newId;
                if (deviceId === SMARTTHINGS_DEVICE_ID_OFF) process.env.SMARTTHINGS_DEVICE_ID_OFF = newId;
                return sendSTCommand(newId, cmd, retryCount + 1, traceContext);
            }
        }
        traceLog(traceId, '6/6', 'Command flow failed permanently', {
            statusCode,
            command: cmd,
            retryCount
        }, 'error');
        console.error('[SMARTTHINGS] ❌ Грешка (команда):', err.response?.data || err.message);
        return false;
    }
}
async function discoverDeviceId(failedId, context = {}) {
    const traceContext = getTraceContext(context);
    const traceId = traceContext.traceId;

    const token = await ensureValidSTAccessToken();
    if (!token) return null;
    try {
        traceLog(traceId, 'D/1', 'Discovering devices after 403', {
            failedDeviceId: sanitizeDeviceId(failedId)
        });
        const resp = await axios.get('https://api.smartthings.com/v1/devices', { headers: { Authorization: `Bearer ${token}` } });
        const list = resp.data?.items || resp.data;
        if (!Array.isArray(list)) return null;
        for (const d of list) {
            if (d.deviceId === failedId) continue;
            const lbl = String(d.label || '').toLowerCase();
            if (lbl.includes('start') || lbl.includes('stop') || lbl.includes('c2c')) return d.deviceId;
        }
        const viper = list.find(d => d.type === 'VIPER');
        traceLog(traceId, 'D/2', 'Device discovery completed', {
            discoveredCount: list.length,
            selectedDeviceId: sanitizeDeviceId(viper?.deviceId || null)
        });
        return viper?.deviceId || null;
    } catch (e) {
        traceLog(traceId, 'D/ERR', 'Device discovery failed', { error: e.message }, 'warn');
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

export async function controlPower(turnOn, context = {}) {
    const traceContext = getTraceContext({ ...context, action: turnOn ? 'on' : 'off' });
    const traceId = traceContext.traceId;

    const command = turnOn ? SMARTTHINGS_COMMAND_ON : SMARTTHINGS_COMMAND_OFF;
    const targetDeviceId = turnOn ? SMARTTHINGS_DEVICE_ID_ON : SMARTTHINGS_DEVICE_ID_OFF;

    traceLog(traceId, 'CP/1', 'controlPower invoked', {
        requestedState: turnOn ? 'on' : 'off',
        command,
        targetDeviceId: sanitizeDeviceId(targetDeviceId),
        source: traceContext.source
    });

    if (!targetDeviceId) {
        console.error('[SMARTTHINGS] ❌ Липсва ID на устройство (SMARTTHINGS_DEVICE_ID_ON/OFF)');
        return false;
    }

    const success = await sendSTCommand(targetDeviceId, command, 0, traceContext);
    traceLog(traceId, 'CP/2', 'controlPower finished', { success });
    return success;
}
export async function controlMeterByAction(action, context = {}) {
    const traceContext = getTraceContext({ ...context, action });
    const traceId = traceContext.traceId;

    traceLog(traceId, 'CM/1', 'controlMeterByAction invoked', {
        incomingAction: action,
        source: traceContext.source,
        requestPath: traceContext.requestPath || 'n/a'
    });

    const normalized = String(action || '').trim().toLowerCase();
    if (normalized !== 'on' && normalized !== 'off') {
        traceLog(traceId, 'CM/ERR', 'Invalid action received', { normalized });
        return { success: false, command: '', traceId };
    }

    const turnOn = normalized === 'on';
    const command = turnOn ? SMARTTHINGS_COMMAND_ON : SMARTTHINGS_COMMAND_OFF;
    const targetDeviceId = turnOn ? SMARTTHINGS_DEVICE_ID_ON : SMARTTHINGS_DEVICE_ID_OFF;

    traceLog(traceId, 'CM/2', 'Action mapped to command/device', {
        normalized,
        command,
        targetDeviceId: sanitizeDeviceId(targetDeviceId)
    });

    if (!targetDeviceId) {
        console.error('[SMARTTHINGS] ❌ Липсва ID на устройство (SMARTTHINGS_DEVICE_ID_ON/OFF)');
        traceLog(traceId, 'CM/ERR', 'Missing target device id', { normalized, command });
        return { success: false, command: '', traceId };
    }

    traceLog(traceId, 'CM/3', 'Dispatching to sendSTCommand', {
        command,
        targetDeviceId: sanitizeDeviceId(targetDeviceId)
    });

    const success = await sendSTCommand(targetDeviceId, command, 0, traceContext);

    traceLog(traceId, 'CM/4', 'controlMeterByAction finished', {
        success,
        normalized,
        command
    });

    return { success, command, traceId };
}
