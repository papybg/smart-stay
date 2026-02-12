import crypto from 'crypto';

// ============================================================
// СПОДЕЛЕНА СЕСИЯ ЗА ЦЯЛАТА СИСТЕМА
// ============================================================
// Този модул се импортира от:
// - server.js (генерира токени)
// - ai_service.js (валидира токени)
// ============================================================

export const SESSION_DURATION = 30 * 60 * 1000; // 30 минути
const sessions = new Map(); // token -> {role, expiresAt, createdAt}

/**
 * Генерира нов валиден токен
 * @param {string} role - 'host', 'guest', 'stranger'
 * @returns {string} Токен (32-байтов хекс низ)
 */
export function generateToken(role) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_DURATION;
    sessions.set(token, { role, expiresAt, createdAt: Date.now() });
    console.log(`[SESSION] ✅ Генериран token за ${role}, валиден до ${new Date(expiresAt).toLocaleTimeString('bg-BG')}`);
    return token;
}

/**
 * Валидира дали токен е валиден и не е изтекъл
 * @param {string} token - Токен за проверка
 * @returns {object|null} {role, valid: true} или null
 */
export function validateToken(token) {
    if (!token || !sessions.has(token)) {
        console.log('[SESSION] ❌ Token не е намерен в сесии');
        return null;
    }
    
    const session = sessions.get(token);
    
    if (Date.now() > session.expiresAt) {
        console.log('[SESSION] ⏰ Token изтекъл, изтривам от сесии');
        sessions.delete(token);
        return null;
    }
    
    console.log(`[SESSION] ✅ Token валиден за ${session.role}`);
    return { role: session.role, valid: true };
}

/**
 * Почистване на изтекли токени (извиква се периодично)
 */
export function cleanupExpiredTokens() {
    let removed = 0;
    for (const [token, session] of sessions.entries()) {
        if (Date.now() > session.expiresAt) {
            sessions.delete(token);
            removed++;
        }
    }
        if (removed > 0) {
            console.log(`[CLEANUP] 🧹 Изтрити ${removed} изтекли token`);
        }
        return removed;
    }
    
    /**
     * Изтрива токен при logout
     * @param {string} token - Токен за изтриване
     */
    export function invalidateToken(token) {
        if (token && sessions.has(token)) {
            sessions.delete(token);
            console.log('[SESSION] 🗑️ Token изтрит (logout)');
            return true;
        }
        return false;
    }
    