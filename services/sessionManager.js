import crypto from 'crypto';

/**
 * ============================================================================
 * SESSION MANAGER - СПОДЕЛЕН МЕЖДУ server.js И ai_service.js
 * ============================================================================
 * 
 * Този модул е ЕДИНСТВЕН източник на истина за управление на сесии
 * Импортира се от ОБА файла за синхронизирана работа с токени
 * 
 * Проблем решен:
 * ❌ ПРЕДИ: server.js имаше sessions Map, ai_service.js имаше VALID_SESSION_TOKENS Map (РАЗНИ!)
 * ✅ СЛЕД: Една sessionManager.js с един sessions Map
 */

// ============================================================================
// КОНФИГУРАЦИЯ
// ============================================================================

export const SESSION_DURATION = 30 * 60 * 1000; // 30 минути в милисекунди

/**
 * ЕДИНСТВЕН източник на истина за активни сесии
 * Структура: token → {role, expiresAt, createdAt}
 * @type {Map<string, {role: string, expiresAt: number, createdAt: number}>}
 */
const sessions = new Map();

// ============================================================================
// ПУБЛИЧНИ ФУНКЦИИ
// ============================================================================

/**
 * 🔑 ГЕНЕРИРАНЕ НА НОВИ ТОКЕНИ
 * 
 * Създава криптографски сигурен токен с определена роля
 * Токенът е валиден за 30 минути
 * 
 * @async
 * @param {string} role - 'host', 'guest', 'stranger'
 * @returns {string} 64-знаков хекс токен (crypto.randomBytes(32))
 */
export function generateToken(role) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_DURATION;
    
    sessions.set(token, {
        role,
        expiresAt,
        createdAt: Date.now()
    });
    
    const expiryTime = new Date(expiresAt).toLocaleTimeString('bg-BG');
    console.log(`[SESSION] ✅ ГЕНЕРИРАН ТОКЕН за ${role.toUpperCase()}`);
    console.log(`[SESSION]    Токен: ${token.substring(0, 16)}...${token.substring(-8)}`);
    console.log(`[SESSION]    Валиден до: ${expiryTime}`);
    
    return token;
}

/**
 * ✅ ВАЛИДИРАНЕ НА ТОКЕНИ
 * 
 * Проверява дали токен е валиден и не е изтекъл
 * Това е ЕДИНСТВЕНОТО място където се проверяват токени
 * 
 * @param {string|null} token - Токен за проверка
 * @returns {{role: string, valid: boolean}|null} Обект с роля ако е валиден, null ако не е
 */
export function validateToken(token) {
    // Ако няма токен, върни null
    if (!token) {
        return null;
    }
    
    // Ако токен не е в Map-а, върни null
    if (!sessions.has(token)) {
        console.log(`[SESSION] ❌ Токен не е намерен в сесии (невалиден)`);
        return null;
    }
    
    const session = sessions.get(token);
    const now = Date.now();
    
    // Ако токен е изтекъл, изтрий го и върни null
    if (now > session.expiresAt) {
        console.log(`[SESSION] ⏰ Токен ИЗТЕКЪЛ, изтривам от сесии`);
        sessions.delete(token);
        return null;
    }
    
    // Токен е валиден
    const remainingTime = Math.round((session.expiresAt - now) / 1000);
    console.log(`[SESSION] ✅ Токен ВАЛИДЕН за ${session.role} (остават ${remainingTime} сек)`);
    
    return {
        role: session.role,
        valid: true
    };
}

/**
 * 🧹 ПОЧИСТВАНЕ НА ИЗТЕКЛИ ТОКЕНИ
 * 
 * Премахва изтекли токени от Map-а
 * Викане се периодично (всеки 5 минути)
 * 
 * @returns {number} Брой изтрити токени
 */
export function cleanupExpiredTokens() {
    let removed = 0;
    const now = Date.now();
    
    for (const [token, session] of sessions.entries()) {
        if (now > session.expiresAt) {
            sessions.delete(token);
            removed++;
        }
    }
    
    if (removed > 0) {
        console.log(`[SESSION:CLEANUP] 🧹 Изтрити ${removed} ИЗТЕКЛИ токени`);
    }
    
    return removed;
}

/**
 * 📊 СТАТИСТИКА НА СЕСИИТЕ
 * Връща информация за активни сесии (само за логване)
 * 
 * @returns {object} {totalTokens, byRole: {host, guest, stranger}}
 */
export function getSessionStats() {
    const stats = {
        totalTokens: sessions.size,
        byRole: { host: 0, guest: 0, stranger: 0 }
    };
    
    for (const [, session] of sessions.entries()) {
        if (stats.byRole[session.role] !== undefined) {
            stats.byRole[session.role]++;
        }
    }
    
    return stats;
}

/**
 * 🔴 ИЗЛЕЗ - ИНВАЛИДИРА ТОКЕН
 * Премахва токен от сесии (користувател изходи)
 * 
 * @param {string} token - Токен за изтриване
 * @returns {boolean} true ако е изтрит, false ако не е намерен
 */
export function invalidateToken(token) {
    if (!token || !sessions.has(token)) {
        return false;
    }
    
    const role = sessions.get(token).role;
    sessions.delete(token);
    console.log(`[SESSION] 🔴 ИНВАЛИДИРАН токен за ${role}`);
    return true;
}

// ============================================================================
// SETUP: Периодично почистване на изтекли токени
// ============================================================================

const CLEANUP_INTERVAL = 5 * 60 * 1000; // Всеки 5 минути
setInterval(() => {
    cleanupExpiredTokens();
}, CLEANUP_INTERVAL);

console.log('[SESSION] ✅ Session Manager инициализиран');
console.log(`[SESSION]    Cleanup job: всеки ${CLEANUP_INTERVAL / 60000} минути`);
console.log(`[SESSION]    Token TTL: ${SESSION_DURATION / 60000} минути`);
