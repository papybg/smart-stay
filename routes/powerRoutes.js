import { ensureValidSTAccessToken } from '../services/autoremote.js';

export function registerPowerRoutes(app, {
    sql,
    controlMeterByAction,
    syncBookingsPowerFromLatestHistory,
    taskerNoiseWindowMs,
    recentTaskerStatusBySource
}) {
    app.get('/api/st-token', async (req, res) => {
        const forceRefresh = String(req.query?.refresh || '').toLowerCase() === '1'
            || String(req.query?.refresh || '').toLowerCase() === 'true';
        const token = await ensureValidSTAccessToken({ forceRefresh });
        if (!token) {
            return res.status(503).json({
                error: 'No valid SmartThings access token available. Check ST_CLIENT_ID, ST_CLIENT_SECRET, ST_REFRESH_TOKEN.'
            });
        }
        res.json({ access_token: token, refreshed: forceRefresh });
    });

    app.get('/api/power-status', async (_req, res) => {
        // respond with cached state but try to refresh from SmartThings device if configured
        const responseObj = {
            online: true,
            isOn: global.powerState.is_on,
            lastUpdate: global.powerState.last_update.toISOString(),
            source: global.powerState.source
        };

        // if we have a device ID and a valid access token, query the real status
        const deviceId = process.env.SMARTTHINGS_DEVICE_ID_ON || process.env.SMARTTHINGS_DEVICE_ID;
        if (deviceId) {
            try {
                const token = await ensureValidSTAccessToken();
                if (token) {
                    const url = `https://api.smartthings.com/v1/devices/${deviceId}/components/main/capabilities/switch/status`;
                    const stRes = await fetch(url, {
                        headers: { Authorization: `Bearer ${token}` },
                        timeout: 10000
                    });
                    if (stRes.ok) {
                        const data = await stRes.json();
                        // SmartThings returns an array of status entries
                        const stateEntry = data?.data?.[0] || data?.[0] || null;
                        if (stateEntry && stateEntry.value !== undefined) {
                            const realIsOn = stateEntry.value === 'on' || stateEntry.value === true;
                            responseObj.isOn = realIsOn;
                            responseObj.source = 'smartthings';
                            // optionally update global cache
                            global.powerState.is_on = realIsOn;
                            global.powerState.last_update = new Date();
                            global.powerState.source = 'smartthings';
                        }
                    } else {
                        console.warn('[SMARTTHINGS] ⚠️ Неуспешен статус заявка:', stRes.status);
                    }
                }
            } catch (err) {
                console.warn('[SMARTTHINGS] ⚠️ Грешка при четене на статус:', err.message);
            }
        }

        res.json(responseObj);
    });

    function normalizePowerState(rawValue) {
        if (typeof rawValue === 'boolean') return rawValue;
        if (typeof rawValue === 'number') {
            if (rawValue === 1) return true;
            if (rawValue === 0) return false;
            return null;
        }
        if (typeof rawValue === 'string') {
            const value = rawValue.trim().toLowerCase();
            if (['on', 'true', '1', 'вкл', 'включен', 'включи'].includes(value)) return true;
            if (['off', 'false', '0', 'изкл', 'изключен', 'изключи'].includes(value)) return false;
        }
        return null;
    }

    function normalizeMeterAction(rawAction) {
        const value = String(rawAction || '').trim().toLowerCase();
        if (['on', '1', 'true', 'вкл', 'включи', 'start'].includes(value)) return 'on';
        if (['off', '0', 'false', 'изкл', 'изключи', 'stop'].includes(value)) return 'off';
        return null;
    }

    async function handlePowerStatusUpdate(req, res) {
        try {
            const rawState = req.body?.is_on ?? req.body?.isOn ?? req.body?.status ?? req.body?.state;
            const source = req.body?.source || 'tasker_direct';
            const booking_id = req.body?.booking_id ?? source;
            const rawBattery = req.body?.battery;
            const forceLog = req.body?.force_log === true || String(req.body?.force_log || '').toLowerCase() === 'true';
            const prevState = global.powerState.is_on;
            const timestamp = new Date();
            let dbLogged = false;
            let dbLogError = null;
            let detectiveSync = null;

            console.log(`[TASKER] 📨 update from ${source}`);
            const newState = normalizePowerState(rawState);
            if (newState === null) {
                console.warn(`[TASKER] ⚠️ Невалидно състояние: ${rawState}`);
                return res.status(400).json({
                    success: false,
                    error: 'Невалидно поле за състояние. Изпратете is_on/status/state като true|false|on|off|1|0'
                });
            }

            console.log(`[TASKER] 📊 State: ${newState ? 'ON' : 'OFF'} (беше ${prevState ? 'ON' : 'OFF'})`);
            console.log(`[TASKER] 🔍 sql available: ${sql ? '✅ YES' : '❌ NO'}`);

            let batteryValue = null;
            if (rawBattery !== undefined && rawBattery !== null && String(rawBattery).trim() !== '') {
                const parsedBattery = Number.parseInt(String(rawBattery), 10);
                if (!Number.isNaN(parsedBattery)) {
                    batteryValue = parsedBattery;
                }
            }

            const recent = recentTaskerStatusBySource.get(source);
            const isDuplicateNoise = Boolean(
                !forceLog
                && recent
                && recent.state === newState
                && (Date.now() - recent.ts) < taskerNoiseWindowMs
            );

            if (isDuplicateNoise) {
                // even if we think it's noise, update cache and also write a row so
                // that downstream systems (AI, reports) see the latest timestamp.
                global.powerState.is_on = newState;
                global.powerState.last_update = timestamp;
                global.powerState.source = source;

                let dbLoggedNoise = false;
                let dbLogErrorNoise = null;
                if (sql) {
                    try {
                        await sql`
                            INSERT INTO power_history (is_on, source, timestamp, battery, booking_id)
                            VALUES (${newState}, ${source}, ${timestamp}, ${batteryValue}, ${booking_id})
                        `;
                        dbLoggedNoise = true;
                        console.log('[DB] 📝 Duplicate noise entry recorded');
                    } catch (dbErr) {
                        dbLogErrorNoise = dbErr.message;
                        console.error('[DB] 🔴 Error logging duplicate noise:', dbErr.message);
                    }
                }

                return res.status(200).json({
                    success: true,
                    message: 'Duplicate status suppressed (logged)',
                    received: {
                        is_on: newState,
                        source,
                        battery: batteryValue,
                        booking_id,
                        stateChanged: false,
                        duplicateSuppressed: true,
                        dbLogged: dbLoggedNoise,
                        dbLogError: dbLogErrorNoise,
                        note: dbLoggedNoise ? 'Потиснат дублиран периодичен update (записан)' : 'Потиснат дублиран периодичен update'
                    }
                });
            }

            global.powerState.is_on = newState;
            global.powerState.last_update = timestamp;
            global.powerState.source = source;
            recentTaskerStatusBySource.set(source, { state: newState, ts: Date.now() });

            if (sql) {
                try {
                    console.log(`[DB] 📝 Inserting: is_on=${newState}, source=${source}, battery=${batteryValue}, booking_id=${booking_id}`);
                    await sql`
                        INSERT INTO power_history (is_on, source, timestamp, battery, booking_id)
                        VALUES (${newState}, ${source}, ${timestamp}, ${batteryValue}, ${booking_id})
                    `;
                    dbLogged = true;
                    console.log(`[DB] ✅ Записано: ${prevState ? 'ON' : 'OFF'} → ${newState ? 'ON' : 'OFF'}`);
                } catch (dbError) {
                    dbLogError = dbError.message;
                    console.error('[DB] 🔴 Грешка при логване:', dbError.message);
                }

                detectiveSync = await syncBookingsPowerFromLatestHistory();
            } else {
                dbLogError = 'Database not connected';
                console.error('[DB] 🔴 КРИТИЧНО: sql е NULL/undefined - База недостъпна!');
            }

            return res.status(200).json({
                success: true,
                message: 'Статус получен и обработен',
                received: {
                    is_on: newState,
                    source,
                    battery: batteryValue,
                    booking_id,
                    stateChanged: prevState !== newState,
                    forceLog,
                    dbLogged,
                    dbLogError,
                    detectiveSync,
                    note: prevState === newState && !forceLog ? 'Състояние без промяна' : (dbLogged ? 'Записано в power_history' : 'Записът не е потвърден')
                }
            });
        } catch (error) {
            console.error('[TASKER] 🔴 Грешка:', error.message);
            return res.status(500).json({ error: error.message });
        }
    }

    app.post('/api/power/status', handlePowerStatusUpdate);
    app.post('/api/power-status', handlePowerStatusUpdate);

    async function executeMeterAction(action, _sourceTag, res) {
        let dbLogged = false;
        let dbError = null;
        let detectiveSync = null;
        const commandResult = await controlMeterByAction(action);

        if (!commandResult.success) {
            return res.status(500).json({
                success: false,
                error: 'Неуспешна команда към Samsung SmartThings',
                action,
                dbLogged,
                dbError
            });
        }

        const newState = action === 'on';
        const eventTimestamp = new Date();

        global.powerState.is_on = newState;
        global.powerState.last_update = eventTimestamp;
        global.powerState.source = 'render_command';

        if (sql) {
            try {
                await sql`
                    INSERT INTO power_history (is_on, source, timestamp, booking_id)
                    VALUES (${newState}, ${'render_command'}, ${eventTimestamp}, ${'render_command'})
                `;
                dbLogged = true;
                detectiveSync = await syncBookingsPowerFromLatestHistory();
            } catch (error) {
                dbError = error.message;
                console.error('[DB] 🔴 Грешка при fallback логване на Render команда:', error.message);
            }
        } else {
            dbError = 'Database not connected';
        }

        return res.status(200).json({
            success: true,
            message: `Команда "${commandResult.command}" изпратена към телефона`,
            action,
            command: commandResult.command,
            dbLogged,
            dbError,
            detectiveSync,
            note: dbLogged
                ? 'Fallback запис в power_history е направен; Tasker feedback може да доуточни статуса.'
                : 'Командата е изпратена, но записът в power_history не е потвърден.'
        });
    }

    app.post('/api/meter', async (req, res) => {
        try {
            const action = normalizeMeterAction(req.body?.action);
            if (!action) {
                return res.status(400).json({ error: 'Невалидна действие. Очаква: "on" или "off"' });
            }

            console.log(`[METER API] 🎛️  Управление на ток: ${action.toUpperCase()}`);
            return await executeMeterAction(action, 'api_meter', res);
        } catch (error) {
            console.error('[METER API] 🔴 Грешка:', error.message);
            return res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/meter/on', async (_req, res) => {
        console.log('[METER API] 🎛️ Samsung ON команда');
        return await executeMeterAction('on', 'samsung_meter_on', res);
    });

    app.post('/api/meter/off', async (_req, res) => {
        console.log('[METER API] 🎛️ Samsung OFF команда');
        return await executeMeterAction('off', 'samsung_meter_off', res);
    });

    // Simple in-memory cache to reduce load when many clients poll the same data
    const powerHistoryCache = new Map(); // key -> { ts, payload }
    const POWER_HISTORY_CACHE_MS = Number(process.env.POWER_HISTORY_CACHE_MS || 15000);

    app.get('/api/power-history', async (req, res) => {
        if (!sql) {
            return res.status(503).json({ error: 'Database not available' });
        }
        try {
            const days = Number(req.query?.days || 30);
            const cacheKey = `days:${days}`;
            const now = Date.now();
            const cached = powerHistoryCache.get(cacheKey);
            if (cached && (now - cached.ts) < POWER_HISTORY_CACHE_MS) {
                return res.json(cached.payload);
            }

            const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

            const history = await sql`
                SELECT
                    id,
                    is_on,
                    source,
                    timestamp,
                    battery,
                    booking_id
                FROM power_history
                WHERE timestamp >= ${sinceDate}
                ORDER BY timestamp DESC
                LIMIT 500
            `;

            const payload = {
                count: history.length,
                data: history,
                period: { since: sinceDate, until: new Date() }
            };

            powerHistoryCache.set(cacheKey, { ts: now, payload });
            return res.json(payload);
        } catch (error) {
            console.error('[DB] 🔴 Грешка при четене:', error.message);
            return res.status(500).json({ error: error.message });
        }
    });
}
