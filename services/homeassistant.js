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
//   HA_SCRIPT_ENTITY_ON  = script.entity_id за включване (напр. script.vklyuchi_toka_bezopasno)
//   HA_SCRIPT_ENTITY_OFF = script.entity_id за изключване (напр. script.izklyuchi_toka_bezopasno)
// ============================================================================

import axios from 'axios';
import { neon } from '@neondatabase/serverless';
import { controlPower as controlPowerViaSmartThings } from './autoremote.js';

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

const HA_URL = (process.env.HA_URL || '').replace(/\/$/, '');
const HA_SLAVE_URL = (process.env.HA_SLAVE_URL || '').replace(/\/$/, '');
const HA_TOKEN = process.env.HA_TOKEN || '';
const HA_SLAVE_TOKEN = process.env.HA_SLAVE_TOKEN || HA_TOKEN;
const CF_ACCESS_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID || '';
const CF_ACCESS_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET || '';
const CF_ACCESS_HEADER_NAME = process.env.HA_CUSTOM_HEADER_NAME || '';
const CF_ACCESS_HEADER_VALUE = process.env.HA_CUSTOM_HEADER_VALUE || '';
const CF_ACCESS_SLAVE_CLIENT_ID = process.env.CF_ACCESS_SLAVE_CLIENT_ID || CF_ACCESS_CLIENT_ID;
const CF_ACCESS_SLAVE_CLIENT_SECRET = process.env.CF_ACCESS_SLAVE_CLIENT_SECRET || CF_ACCESS_CLIENT_SECRET;
const CF_ACCESS_SLAVE_HEADER_NAME = process.env.HA_SLAVE_CUSTOM_HEADER_NAME || CF_ACCESS_HEADER_NAME;
const CF_ACCESS_SLAVE_HEADER_VALUE = process.env.HA_SLAVE_CUSTOM_HEADER_VALUE || CF_ACCESS_HEADER_VALUE;
const HA_SCRIPT_ON = process.env.HA_SCRIPT_ENTITY_ON || process.env.HA_SWITCH_ENTITY_ON || process.env.HA_SWITCH_ENTITY || '';
const HA_SCRIPT_OFF = process.env.HA_SCRIPT_ENTITY_OFF || process.env.HA_SCRIPT_ENTITY_ON || process.env.HA_SWITCH_ENTITY_OFF || process.env.HA_SWITCH_ENTITY_ON || process.env.HA_SWITCH_ENTITY || '';
const HA_SLAVE_SCRIPT_ON = process.env.HA_SLAVE_SCRIPT_ENTITY_ON || HA_SCRIPT_ON;
const HA_SLAVE_SCRIPT_OFF = process.env.HA_SLAVE_SCRIPT_ENTITY_OFF || HA_SCRIPT_OFF;
const POWER_FAILOVER_DELAY_MS = Number(process.env.POWER_FAILOVER_DELAY_MS || 30000);
const POWER_FORCE_SLAVE_ONLY = String(process.env.POWER_FORCE_SLAVE_ONLY || 'false').toLowerCase() === 'true';

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

function normalizeBaseUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    return withScheme.replace(/\/$/, '');
}

function safeUrlForLog(value) {
    try {
        const u = new URL(value);
        return `${u.protocol}//${u.host}`;
    } catch {
        return String(value || 'invalid');
    }
}

function buildTargetHeaders(token, targetName) {
    const headers = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
    };

    const isSlaveTarget = String(targetName || '').toUpperCase() === 'SLAVE';
    const clientId = isSlaveTarget ? CF_ACCESS_SLAVE_CLIENT_ID : CF_ACCESS_CLIENT_ID;
    const clientSecret = isSlaveTarget ? CF_ACCESS_SLAVE_CLIENT_SECRET : CF_ACCESS_CLIENT_SECRET;
    const customHeaderName = isSlaveTarget ? CF_ACCESS_SLAVE_HEADER_NAME : CF_ACCESS_HEADER_NAME;
    const customHeaderValue = isSlaveTarget ? CF_ACCESS_SLAVE_HEADER_VALUE : CF_ACCESS_HEADER_VALUE;

    if (clientId && clientSecret) {
        headers['CF-Access-Client-Id'] = clientId;
        headers['CF-Access-Client-Secret'] = clientSecret;
    }

    if (customHeaderName && customHeaderValue) {
        headers[customHeaderName] = customHeaderValue;
    }

    return headers;
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

async function callHAServiceToTarget(entityId, turnOn, traceId, {
    baseUrl,
    token,
    targetName,
    allowSmartThingsFallback
}) {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

    if (!normalizedBaseUrl || !token) {
        traceLog(traceId, 'HA/ERR', `${targetName} URL или TOKEN липсват`, null, 'error');
        return false;
    }
    if (!entityId) {
        traceLog(traceId, 'HA/ERR', 'Entity ID липсва (HA_SCRIPT_ENTITY_ON/OFF)', null, 'error');
        return false;
    }

    const domain = entityId.split('.')[0]; // switch, light, script и т.н.
    const isScriptEntity = domain === 'script';
    const service = isScriptEntity ? 'turn_on' : (turnOn ? 'turn_on' : 'turn_off');
    const url = `${normalizedBaseUrl}/api/services/${domain}/${service}`;

    traceLog(traceId, 'HA/1', `Send ${targetName}`, {
        entity_id: entityId,
        service,
        url: safeUrlForLog(normalizedBaseUrl)
    });

    try {
        const headers = buildTargetHeaders(token, targetName);
        const response = await axios.post(
            url,
            { entity_id: entityId },
            {
                headers,
                timeout: 10000
            }
        );

        traceLog(traceId, 'HA/2', `${targetName} OK`, { status: response.status });

        return true;
    } catch (err) {
        const status = err.response?.status;
        traceLog(traceId, 'HA/ERR', `${targetName} FAIL`, { status, error: err.message }, 'error');
        if (!allowSmartThingsFallback) return false;
        traceLog(traceId, 'HA/FALLBACK', 'Fallback SmartThings', null, 'warn');
        return await controlPowerViaSmartThings(turnOn, { traceId });
    }
}

async function hasDbConfirmationAfter({ expectedState, sentAtIso }) {
    if (!sql || !sentAtIso) return false;
    try {
        const rows = await sql`
            SELECT id
            FROM power_history
            WHERE is_on = ${expectedState}
              AND timestamp > ${sentAtIso}::timestamptz
            ORDER BY timestamp ASC
            LIMIT 1
        `;
        return rows.length > 0;
    } catch (error) {
        return false;
    }
}

function scheduleSlaveFailover({ turnOn, action, traceId, sentAtIso }) {
    const delayMs = Number.isFinite(POWER_FAILOVER_DELAY_MS) && POWER_FAILOVER_DELAY_MS > 0
        ? POWER_FAILOVER_DELAY_MS
        : 30000;

    setTimeout(async () => {
        const confirmed = await hasDbConfirmationAfter({ expectedState: turnOn, sentAtIso });
        if (confirmed) {
            traceLog(traceId, 'FO/OK', 'Master confirmed');
            return;
        }

        traceLog(traceId, 'FO/1', 'Master timeout 30s. Send Slave...', null, 'warn');

        if (!HA_SLAVE_URL) {
            traceLog(traceId, 'FO/ERR', 'HA_SLAVE_URL missing', null, 'error');
            return;
        }

        const slaveEntityId = turnOn ? HA_SLAVE_SCRIPT_ON : HA_SLAVE_SCRIPT_OFF;
        const slaveOk = await callHAServiceToTarget(slaveEntityId, turnOn, traceId, {
            baseUrl: HA_SLAVE_URL,
            token: HA_SLAVE_TOKEN,
            targetName: 'SLAVE',
            allowSmartThingsFallback: false
        });
        traceLog(traceId, 'FO/2', slaveOk ? `Slave OK: ${action}` : `Slave FAIL: ${action}`, null, slaveOk ? 'info' : 'error');
    }, delayMs);
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

    const entityId = turnOn
        ? (POWER_FORCE_SLAVE_ONLY ? HA_SLAVE_SCRIPT_ON : HA_SCRIPT_ON)
        : (POWER_FORCE_SLAVE_ONLY ? HA_SLAVE_SCRIPT_OFF : HA_SCRIPT_OFF);
    const action = turnOn ? 'on' : 'off';
    const sentAtIso = new Date().toISOString();

    const masterSuccess = await callHAServiceToTarget(entityId, turnOn, traceId, {
        baseUrl: POWER_FORCE_SLAVE_ONLY ? HA_SLAVE_URL : HA_URL,
        token: POWER_FORCE_SLAVE_ONLY ? HA_SLAVE_TOKEN : HA_TOKEN,
        targetName: POWER_FORCE_SLAVE_ONLY ? 'SLAVE' : 'MASTER',
        allowSmartThingsFallback: false
    });

    if (!POWER_FORCE_SLAVE_ONLY) {
        scheduleSlaveFailover({
            turnOn,
            action,
            traceId,
            sentAtIso
        });
    }

    traceLog(traceId, 'CP/2', POWER_FORCE_SLAVE_ONLY ? 'Slave-only mode' : 'Accepted + timer 30s', { masterSuccess });
    return true;
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
    const entityId = turnOn
        ? (POWER_FORCE_SLAVE_ONLY ? HA_SLAVE_SCRIPT_ON : HA_SCRIPT_ON)
        : (POWER_FORCE_SLAVE_ONLY ? HA_SLAVE_SCRIPT_OFF : HA_SCRIPT_OFF);
    const sentAtIso = new Date().toISOString();

    traceLog(traceId, 'CM/2', POWER_FORCE_SLAVE_ONLY ? 'Send SLAVE (only)' : 'Send MASTER', { action: normalized });

    const masterSuccess = await callHAServiceToTarget(entityId, turnOn, traceId, {
        baseUrl: POWER_FORCE_SLAVE_ONLY ? HA_SLAVE_URL : HA_URL,
        token: POWER_FORCE_SLAVE_ONLY ? HA_SLAVE_TOKEN : HA_TOKEN,
        targetName: POWER_FORCE_SLAVE_ONLY ? 'SLAVE' : 'MASTER',
        allowSmartThingsFallback: false
    });

    if (!POWER_FORCE_SLAVE_ONLY) {
        scheduleSlaveFailover({
            turnOn,
            action: normalized,
            traceId,
            sentAtIso
        });
    }

    traceLog(traceId, 'CM/3', POWER_FORCE_SLAVE_ONLY ? 'Slave-only mode' : 'Accepted + timer 30s', { masterSuccess });

    return {
        success: true,
        accepted: true,
        command: normalized,
        traceId,
        usedTaskerFallback: false,
        taskerConfirmed: false,
        awaitingConfirmation: true
    };
}
