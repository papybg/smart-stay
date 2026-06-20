// ============================================================================
// HOME ASSISTANT SERVICE (замества autoremote.js / SmartThings)
// ============================================================================
//
// Вика Home Assistant REST API вместо SmartThings.
// Запазва същите exports като autoremote.js за пълна съвместимост:
//   • controlPower(turnOn, context)
//   • controlMeterByAction(action, context)
//   • ensureValidSTAccessToken() – тук само връща HA токена (не прави refresh)
//
// ENV variables needed:
//   HA_URL   = https://xxxx.ngrok-free.app  (или статичен домейн)
//   HA_TOKEN = Long-Lived Access Token от Home Assistant
//   HA_SWITCH_ENTITY_ON  = switch.entity_id за включване (напр. switch.meter_on)
//   HA_SWITCH_ENTITY_OFF = switch.entity_id за изключване (може да е същото)
// ============================================================================

import axios from 'axios';
import { neon } from '@neondatabase/serverless';

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

const HA_URL = (process.env.HA_URL || '').replace(/\/$/, '');
const HA_TOKEN = process.env.HA_TOKEN || '';
const HA_SWITCH_ON  = process.env.HA_SWITCH_ENTITY_ON  || process.env.HA_SWITCH_ENTITY || '';
const HA_SWITCH_OFF = process.env.HA_SWITCH_ENTITY_OFF || process.env.HA_SWITCH_ENTITY || '';

const POWER_TRACE_LOGS_ENABLED = (process.env.POWER_TRACE_LOGS || 'true').toLowerCase() !== 'false';

// ── helpers ──────────────────────────────────────────────────────────────────

function createTraceId() {
    return `ha_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function traceLog(traceId, step, msg, data = null, level = 'info') {
    if (!POWER_TRACE_LOGS_ENABLED) return;
    const prefix = `[HA][${traceId}][${step}]`;
    const payload = data ? ` ${JSON.stringify(data)}` : '';
    if (level === 'error') console.error(`${prefix} ${msg}${payload}`);
    else if (level === 'warn') console.warn(`${prefix} ${msg}${payload}`);
    else console.log(`${prefix} ${msg}${payload}`);
}

function getTraceContext(context = {}) {
    return {
        traceId: context.traceId || createTraceId(),
        source: context.source || 'api',
        action: context.action || 'unknown',
        requestPath: context.requestPath || ''
    };
}

function parsePowerState(raw) {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') {
        const v = raw.trim().toLowerCase();
        if (['on', 'true', '1', 'вкл', 'включен', 'active'].includes(v)) return true;
        if (['off', 'false', '0', 'изкл', 'изключен', 'inactive'].includes(v)) return false;
    }
    return null;
}

export async function readLatestPowerStateFromHistory() {
    if (!sql) return null;
    try {
        const rows = await sql`
            SELECT is_on, source, timestamp
            FROM power_history
            ORDER BY timestamp DESC
            LIMIT 1
        `;
        if (!rows.length) return null;
        return {
            isOn: parsePowerState(rows[0].is_on),
            source: rows[0].source || 'db',
            timestamp: rows[0].timestamp || null
        };
    } catch (error) {
        console.warn('[HA] ⚠️ Неуспех при четене на power_history:', error.message);
        return null;
    }
}

// ── Home Assistant API call ───────────────────────────────────────────────────

async function callHAService(entityId, turnOn, traceId) {
    if (!HA_URL || !HA_TOKEN) {
        traceLog(traceId, 'HA/ERR', 'HA_URL или HA_TOKEN липсват в ENV', null, 'error');
        return false;
    }
    if (!entityId) {
        traceLog(traceId, 'HA/ERR', 'Entity ID липсва (HA_SWITCH_ENTITY_ON/OFF)', null, 'error');
        return false;
    }

    const domain = entityId.split('.')[0]; // switch, light, script и т.н.
    const service = turnOn ? 'turn_on' : 'turn_off';
    const url = `${HA_URL}/api/services/${domain}/${service}`;

    traceLog(traceId, 'HA/1', 'Изпращане на команда към Home Assistant', {
        url,
        entity_id: entityId,
        service
    });

    try {
        const response = await axios.post(
            url,
            { entity_id: entityId },
            {
                headers: {
                    Authorization: `Bearer ${HA_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );

        traceLog(traceId, 'HA/2', 'Команда изпратена успешно', {
            status: response.status,
            entity_id: entityId
        });

        return true;
    } catch (err) {
        const status = err.response?.status;
        traceLog(traceId, 'HA/ERR', 'Грешка при HA команда', {
            entity_id: entityId,
            status,
            error: err.message
        }, 'error');
        console.error('[HA] ❌ Грешка:', err.response?.data || err.message);
        return false;
    }
}

// ── Public API (съвместимо с autoremote.js) ───────────────────────────────────

// Съвместимост – в autoremote.js се ползва за проверка на SmartThings токен.
// Тук просто връщаме HA_TOKEN (не е нужен refresh).
export async function ensureValidSTAccessToken() {
    return HA_TOKEN || null;
}

export async function controlPower(turnOn, context = {}) {
    const traceContext = getTraceContext({ ...context, action: turnOn ? 'on' : 'off' });
    const traceId = traceContext.traceId;

    traceLog(traceId, 'CP/1', 'controlPower извикан', {
        requestedState: turnOn ? 'on' : 'off',
        source: traceContext.source
    });

    const entityId = turnOn ? HA_SWITCH_ON : HA_SWITCH_OFF;
    const success = await callHAService(entityId, turnOn, traceId);

    traceLog(traceId, 'CP/2', 'controlPower завършен', { success });
    return success;
}

export async function controlMeterByAction(action, context = {}) {
    const traceContext = getTraceContext({ ...context, action });
    const traceId = traceContext.traceId;

    traceLog(traceId, 'CM/1', 'controlMeterByAction извикан', {
        incomingAction: action,
        source: traceContext.source
    });

    const normalized = String(action || '').trim().toLowerCase();
    if (normalized !== 'on' && normalized !== 'off') {
        traceLog(traceId, 'CM/ERR', 'Невалидно действие', { normalized });
        return { success: false, command: '', traceId };
    }

    const turnOn = normalized === 'on';
    const entityId = turnOn ? HA_SWITCH_ON : HA_SWITCH_OFF;

    traceLog(traceId, 'CM/2', 'Изпращане към HA', { normalized, entityId });

    const success = await callHAService(entityId, turnOn, traceId);

    traceLog(traceId, 'CM/3', 'controlMeterByAction завършен', { success, normalized });

    return {
        success,
        command: normalized,
        traceId,
        usedTaskerFallback: false,
        taskerConfirmed: false
    };
}
