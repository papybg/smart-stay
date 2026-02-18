import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';
import fs from 'fs/promises';
import path from 'path';
import { sendCommandToPhone } from './autoremote.js';
import { validateToken } from './sessionManager.js';

/**
 * ============================================================================
 * SMART-STAY AI SERVICE - ЖЕЛЕЗОБЕТОННА СИСТЕМА ЗА СИГУРНОСТ
 * ============================================================================
 * 
 * Този сервис имплементира мощни контроли на сигурност за автоматизация на имота:
 * - ТОЧНО съответствие на код на домакина (без размито съвпадение)
 * - Верификация на гост чрез HM кодове на резервации в база данни
 * - Защитна стена за предотвращаване на неоторизиран достъп до наръчници
 * - Логика на хранилище на щифтове с автоматично разпределяне
 * - Автоматизирана помощ при аварийна ситуация на тока с известувания
 * - Отказолека на множество модели за отговори на AI
 * 
 * Създано: февруари 2026
 */

// ============================================================================
// КОНФИГУРАЦИЯ И ИНИЦИАЛИЗАЦИЯ
// ============================================================================

// 🔐 EXTERNAL SESSION MANAGEMENT
// Тези функции се постигат от sessionManager.js
// ai_service.js само ВАЛИДИРА токени, НЕ ги генерира или управлява

/**
 * @const {string[]} MODELS - Gemini модели в ред на отказ
 * Първичен модел, последван от каскадни отказни за надежност
 */
const MODELS = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-3-flash-preview"];

/**
 * @const {any} sql - Neon клиент на база данни за PostgreSQL заявки
 * Инициализиран от DATABASE_URL променлива на окръжение
 */
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

/**
 * @const {GoogleGenerativeAI} genAI - Google Generative AI клиент
 * Инициализиран от GEMINI_API_KEY променлива на окръжение
 */
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

/**
 * @const {string} AUTOMATION_URL - Базов URL на услугата за автоматизация
 * Маршрути за контрол на тока, получаване на статус и изпращане на известувания
 */
const AUTOMATION_URL = process.env.AUTOMATION_SERVICE_URL || 'http://localhost:10000';

/**
 * @const {string} HOST_CODE - КРИТИЧНО: Тайния код на домакина
 * Използва се за 100% точно съответствие (размитото съвпадение е забранено)
 * Съхранява се в променлива на окръжение, никога не е твърдо кодирана
 */
const HOST_CODE = process.env.HOST_CODE;

/**
 * @const {string} PUBLIC_INFO_FALLBACK - Твърдо кодирана публична информация
 * Използва се, когда ролята е 'непознат' за предотвращаване на неоторизиран достъп до manual.txt
 * Съдържа само адрес на имот, удобства и обща информация за резервация
 * КРИТИЧНА ЗАЩИТНА СТЕНА: Това предотвращава разтичане на чувствителни оперативни детайли
 */
const PUBLIC_INFO_FALLBACK = `
🏠 ASPEN VALLEY - АПАРТАМЕНТ D106

🔑 РЕЗЕРВАЦИЯ:
- За регистрирани гости: въведете вашия код на резервация
- За нови резервации: посетете нашия уебсайт

⚠️ ВАЖНО:
- Паролите и кодовете не се дават на непознати
- За достъп до услуги е необходима регистрирана резервация
`;


// ============================================================================
// КЛИЕНТ НА УСЛУГАТА ЗА АВТОМАТИЗАЦИЯ
// ============================================================================

/**
 * @namespace automationClient
 * @description Капсулира вся комуникация с външната услуга за автоматизация
 * Управлява управление на тока, известувания и заявки за резервации
 */
const automationClient = {
    /**
     * Получава текущия статус на системата за тока от услугата за автоматизация
     * @async
     * @returns {Promise<{online: boolean, isOn: boolean}>} Обект със статус на тока
     * @throws Мълчаливо връща офлайн статус при мрежова грешка
     */
    async getPowerStatus() {
        try {
            console.log('[AUTOMATION] Получавам статус на тока от услугата за автоматизация...');
            const res = await fetch(`${AUTOMATION_URL}/api/power-status`);
            if (!res.ok) {
                console.warn('[AUTOMATION] Крайната точка върна статус, различен от 200:', res.status);
                return { online: false, isOn: false };
            }
            const status = await res.json();
            console.log('[AUTOMATION] Статус на тока получен:', status);
            return status;
        } catch (e) {
            console.error('[AUTOMATION] Проверката на статус на тока не успя:', e.message);
            return { online: false, isOn: false };
        }
    },

    /**
     * Управлява състоянието на тока чрез услугата за автоматизация
     * КРИТИЧНО: Вика обновения API endpoint, който автоматично триггерира Telegram команда
     * - true изпраща 'ВКЛ' към Telegram бот
     * - false изпраща 'ИЗКЛ' към Telegram бот
     * 
     * Се вика при спешни ситуации (гост докладва липса на ток) или при AI команди
     * @async
     * @param {boolean} state - True за включване на тока, false за изключване
     * @returns {Promise<boolean>} True при успешно управление, false в противния случай
     * @throws Мълчаливо връща false при мрежова грешка
     */
    async controlPower(state, bookingId = null, source = 'ai_command') {
        try {
            const command = state ? 'meter_on' : 'meter_off';
            const timestamp = new Date();
            console.log('[AUTOMATION] 📡 Управление на тока чрез AutoRemote:', command);
            
            // 🔴 ШАГ 1: ЗАПИС В БД ПРЕДИ ПРАЩА КЪМ TASKER
            if (sql) {
                try {
                    await sql`
                        INSERT INTO power_history (is_on, timestamp, source, booking_id)
                        VALUES (${state}, ${timestamp}, ${source}, ${source})
                    `;
                    console.log('[DB] ✅ Команда записана в power_history (is_on=' + state + ', source=' + source + ')');
                } catch (dbError) {
                    console.error('[DB] 🔴 Грешка при запис:', dbError.message);
                }
            }
            
            // 🟢 ШАГ 2: ПРАЩА КЪМ TASKER
            const success = await sendCommandToPhone(command);
            if (success) {
                console.log('[AUTOMATION] ✅ Команда успешно изпратена към Tasker');
            } else {
                console.warn('[AUTOMATION] ⚠️ Неудачна връзка с AutoRemote');
            }
            return success;
        } catch (e) {
            console.error('[AUTOMATION] ❌ Управлението на тока не успя:', e.message);
            return false;
        }
    },

    /**
     * Изпраща спешно известување до домакина чрез услугата за автоматизация
     * Активира се, когато гост докладва проблеми или системата открие проблеми
     * @async
     * @param {string} message - Известувателното съобщение, описващо ситуацията
     * @param {Object} guestInfo - Обект с информация за госта
     * @param {string} guestInfo.guest_name - Пълното име на госта
     * @param {string} guestInfo.reservation_code - HM код, идентифициращ резервацията
     * @returns {Promise<boolean>} True, ако известуванието е изпратено успешно
     */
    async sendAlert(message, guestInfo) {
        try {
            console.log('[AUTOMATION] Изпращам известување до домакина:', message);
            await fetch(`${AUTOMATION_URL}/api/alert`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, guestInfo })
            });
            console.log('[AUTOMATION] Известуванието е изпратено успешно');
            return true;
        } catch (e) {
            console.error('[AUTOMATION] Изпращането на известуване не успя:', e.message);
            return false;
        }
    },

    /**
     * Получава всички текущи резервации от услугата за автоматизация
     * Използва се за верификация на гост и разпределяне на щифт
     * @async
     * @returns {Promise<Array>} Масив от обекти резервации от база данни
     */
    async getBookings() {
        try {
            console.log('[AUTOMATION] Получавам всички резервации...');
            const res = await fetch(`${AUTOMATION_URL}/api/bookings`);
            if (!res.ok) {
                console.warn('[AUTOMATION] Крайната точка за резервации не успя:', res.status);
                return [];
            }
            const bookings = await res.json();
            console.log('[AUTOMATION] Получени', bookings.length, 'резервации');
            return bookings;
        } catch (e) {
            console.error('[AUTOMATION] Получаването на резервации не успя:', e.message);
            return [];
        }
    }
};

// ============================================================================
// СЛОЙ ЗА СИГУРНОСТ: ОПРЕДЕЛЯНЕ НА РОЛЯТА НА ПОТРЕБИТЕЛЯ
// ============================================================================

/**
 * ЖЕЛЕЗОБЕТОННА ВЕРИФИКАЦИЯ НА ДОМАКИНА - ТОЧНО СЪОТВЕТСТВИЕ НА КОД
 * 
 * Определя дали потребителят е ДОМАКИНА, като сравнява с process.env.HOST_CODE
 * КРИТИЧНА СИГУРНОСТ: Използва === за ТОЧНО съответствие на строка
 * ЗАБРАНЕНО: .includes(), размито съвпадение или частично сравнение на низове
 * 
 * @private
 * @param {string|null} authCode - Код от заглавка за разрешение или форма
 * @param {string|null} userMessage - Съобщение на потребителя (проверено за вграден код)
 * @returns {boolean} True само ако е намерено ТОЧНО съответствие
 */
function isHostVerified(authCode, userMessage) {
    // ПРАВИЛО НА СИГУРНОСТ #1: СЪДЪРЖАНЕ НА КОД НА ДОМАКИНА
    // Проверява дали authCode или съобщението СЪДЪРЖА HOST_CODE
    
    // Проверка дали HOST_CODE е дефиниран
    if (!HOST_CODE) {
        console.error('[SECURITY] ❌ КРИТИЧНО: HOST_CODE не е конфигуран в Render environment');
        return false;
    }
    
    console.log('[SECURITY] Верификация на домакина: проверявам authCode...');
    // Нормализирай authCode за whitespace проблеми от JSON
    if (authCode) {
        const normalizedAuthCode = String(authCode).trim().toLowerCase();
        const normalizedHostCode = String(HOST_CODE).trim().toLowerCase();
        
        console.log(`[SECURITY] DEBUG: authCode="${normalizedAuthCode}" (${normalizedAuthCode.length} знака)`);
        console.log(`[SECURITY] DEBUG: HOST_CODE="${normalizedHostCode}" (${normalizedHostCode.length} знака)`);
        
        // Проверява ТОЧНО съответствие (case-insensitive)
        if (normalizedAuthCode === normalizedHostCode) {
            console.log('[SECURITY] ✅ ДОМАКИН ВЕРИФИЦИРАН: authCode съвпада с HOST_CODE');
            return true;
        }
    }

    if (userMessage) {
        console.log('[SECURITY] Верификация на домакина: проверявам userMessage...');
        const trimmedMessage = String(userMessage).trim().toLowerCase();
        const normalizedHostCode = String(HOST_CODE).trim().toLowerCase();

        // 1) Точно съответствие на целото съобщение
        if (trimmedMessage === normalizedHostCode) {
            console.log('[SECURITY] ✅ ДОМАКИН ВЕРИФИЦИРАН: userMessage съвпада с HOST_CODE');
            return true;
        }

        // 2) Точно съответствие на token вътре в съобщението
        const messageTokens = trimmedMessage.split(/[^a-z0-9]+/i).filter(Boolean);
        if (messageTokens.includes(normalizedHostCode)) {
            console.log('[SECURITY] ✅ ДОМАКИН ВЕРИФИЦИРАН: намерен точен token за HOST_CODE в userMessage');
            return true;
        }
    }

    console.log('[SECURITY] ❌ Верификация на домакина НЕУДАЧНА: не е намерено съответствие');
    return false;
}

/**
 * ВЕРИФИКАЦИЯ НА ГОСТ ЧРЕЗ HM КОДОВЕ НА РЕЗЕРВАЦИИ
 * 
 * Използва regex за извличане на HM кодове от съобщения и верификация срещу таблица резервации
 * HM кодове са уникални идентификатори на резервации на гости
 * 
 * @private
 * @async
 * @param {string|null} authCode - Код, предоставен в заглавката за разрешение
 * @param {string} userMessage - Съобщение потенциално съдържащо HM код
 * @returns {Promise<{role: 'guest'|'stranger', booking: Object|null}>}
 */
async function verifyGuestByHMCode(authCode, userMessage) {
    console.log('[SECURITY] Верификация на гост: търся HM код...');
    
    // ПРАВИЛО НА СИГУРНОСТ #2: REGEX ШАБЛОН ЗА HM КОДОВЕ
    // Шаблон: HM seguito от алфанумерични знаци (формат на код на резервация)
    const hmCodePattern = /HM[A-Z0-9]+/i;
    
    // Проверя authCode първо
    let codeToVerify = null;
    if (authCode && hmCodePattern.test(authCode)) {
        codeToVerify = authCode.toUpperCase();
        console.log('[SECURITY] HM код намерен в authCode:', codeToVerify);
    }
    
    // Проверя userMessage за вграден HM код
    if (!codeToVerify && userMessage) {
        const match = userMessage.match(hmCodePattern);
        if (match) {
            codeToVerify = match[0].toUpperCase();
            console.log('[SECURITY] HM код намерен в userMessage:', codeToVerify);
        }
    }

    if (!codeToVerify) {
        console.log('[SECURITY] Не е намерен HM код в authCode или съобщение');
        return { role: 'stranger', booking: null };
    }

    // Ако нямаме база данни, не можем да верифицираме
    if (!sql) {
        console.warn('[DATABASE] SQL клиент не е инициализиран - не мога да верифицирам HM код');
        return { role: 'stranger', booking: null };
    }

    try {
        console.log('[DATABASE] Запитвам таблица резервации за HM код:', codeToVerify);
        const bookings = await sql`
            SELECT * FROM bookings 
            WHERE UPPER(reservation_code) = ${codeToVerify.toUpperCase()}
              AND COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
              AND check_out > NOW()
            LIMIT 1
        `;

        if (bookings.length > 0) {
            const booking = bookings[0];
            console.log('[DATABASE] ✅ Резервация намерена за код:', codeToVerify);
            console.log('[DATABASE] Име на гост:', booking.guest_name);
            return { role: 'guest', booking };
        }

        // Допълнителен диагностичен лог: кодът съществува ли, но е изтекъл/анулиран
        const archived = await sql`
            SELECT reservation_code, payment_status, check_out
            FROM bookings
            WHERE UPPER(reservation_code) = ${codeToVerify.toUpperCase()}
            LIMIT 1
        `;
        if (archived.length > 0) {
            console.log('[DATABASE] ⚠️ Кодът съществува, но не е активен (изтекъл или анулиран):', codeToVerify);
        }

        console.log('[DATABASE] ❌ Не е намерена резервация за HM код:', codeToVerify);
        return { role: 'stranger', booking: null };
    } catch (e) {
        console.error('[DATABASE] Грешка при запитване на резервации:', e.message);
        return { role: 'stranger', booking: null };
    }
}

/**
 * ЛОГИКА НА ХРАНИЛИЩЕ НА ЩИФТОВЕ - АВТОМАТИЧНО РАЗПРЕДЕЛЯНЕ
 * 
 * Вземи първия неизползван щифт от таблица pin_depot
 * Маркира го като използван в база данни
 * Актуализира резервацията на гост със своя назначен щифт
 * 
 * КРИТИЧНО: Вика се само веднъж на гост (проверено по съществуване на lock_pin)
 * Гарантира, че всеки гост получава уникален щифт за достъп до имота
 * 
 * @private
 * @async
 * @param {Object} booking - Обект резервация от база данни
 * @returns {Promise<string|null>} Назначен щифт код или null ако няма налични
 */
export async function assignPinFromDepot(booking) {
    console.log('[PIN_DEPOT] Проверявам дали гост вече има щифт...');
    
    // Ако гост вече има щифт, го върни
    if (booking.lock_pin) {
        console.log('[PIN_DEPOT] Гост вече има назначен щифт:', booking.lock_pin);
        return booking.lock_pin;
    }

    console.log('[PIN_DEPOT] Гост все още нема щифт - вземам от хранилище...');

    if (!sql) {
        console.warn('[PIN_DEPOT] SQL не е налично - не мога да назнача щифт');
        return null;
    }

    try {
        console.log('[DATABASE] Запитвам pin_depot за първи неизползван щифт...');
        const freePins = await sql`
            SELECT id, pin_code FROM pin_depot 
            WHERE is_used = FALSE 
            ORDER BY id ASC 
            LIMIT 1
        `;

        if (freePins.length === 0) {
            console.error('[PIN_DEPOT] ❌ Нямаме налични неизползвани щифтове в хранилището!');
            return null;
        }

        const pin = freePins[0];
        console.log('[PIN_DEPOT] Намерен налична щифт, маркирам като използван:', pin.pin_code);

        // Маркира щифта като използван в хранилището
        await sql`
            UPDATE pin_depot 
            SET is_used = TRUE, assigned_at = NOW()
            WHERE id = ${pin.id}
        `;
        console.log('[PIN_DEPOT] ✅ Щифт маркиран като използван в хранилището');

        // Актуализира резервацията с новия щифт
        console.log('[DATABASE] Назначавам щифт на запис резервация...');
        await sql`
            UPDATE bookings 
            SET lock_pin = ${pin.pin_code}, pin_assigned_at = NOW()
            WHERE id = ${booking.id}
        `;
        console.log('[PIN_DEPOT] ✅ Щифт назначен на резервация на гост:', pin.pin_code);

        return pin.pin_code;
    } catch (e) {
        console.error('[PIN_DEPOT] Грешка при разпределяне на щифт:', e.message);
        return null;
    }
}

/**
 * ОСНОВНА ФУНКЦИЯ ЗА ОПРЕДЕЛЯНЕ НА РОЛЯТА
 * 
 * Организира всички проверки за сигурност, за да определи ролята на потребителя:
 * 1. Е ли потребителят ДОМАКИНА? (ТОЧНО съответствие на код)
 * 2. Е ли потребителят ГОСТ? (HM верификация на код в база данни)
 * 3. В противния случай: НЕПОЗНАТ (ограничен достъп)
 * 
 * За гости, също обработва разпределяне на щифт от хранилище
 * 
 * @async
 * @param {string|null} authCode - Код за разрешение от заявка
 * @param {string|null} userMessage - Текст на съобщение на потребителя
 * @returns {Promise<{role: 'host'|'guest'|'stranger', data: Object|null}>}
 *          Връща ролята и свързаните метаданни (инфо на гост, данни на резервация)
 */
export async function determineUserRole(authCode, userMessage) {
    console.log('\n[SECURITY] ========== НАЧАЛО ОПРЕДЕЛЯНЕ НА РОЛЯТА НА ПОТРЕБИТЕЛЯ ==========');
    console.log('[SECURITY] authCode/token предоставен:', !!authCode);
    console.log('[SECURITY] userMessage предоставен:', !!userMessage);

    // ПРОВЕРКА #0: ВАЛИДИРАНЕ НА SESSION TOKEN (НОВО)
    if (authCode) {
        const sessionToken = validateToken(authCode);  // ← Използва функцията от sessionManager
        if (sessionToken) {
            console.log(`[SECURITY] ✅ SESSION TOKEN валиден за ${sessionToken.role}`);
            console.log('[SECURITY] ========== ПРОВЕРКА НА СИГУРНОСТ ЗАВЪРШЕНА ==========\n');
            return { role: sessionToken.role, data: null };
        }
    }

    // ПРОВЕРКА #1: ВЕРИФИКАЦИЯ НА ДОМАКИНА (ТОЧНО СЪОТВЕТСТВИЕ НА КОД)
    if (isHostVerified(authCode, userMessage)) {
        console.log('[SECURITY] Определена роля: ДОМАКИН');
        console.log('[SECURITY] ========== ПРОВЕРКА НА СИГУРНОСТ ЗАВЪРШЕНА ==========\n');
        return { role: 'host', data: null };
    }

    // ПРОВЕРКА #2: ВЕРИФИКАЦИЯ НА ГОСТ (HM КОД В БАЗА ДАННИ)
    const guestCheck = await verifyGuestByHMCode(authCode, userMessage);
    if (guestCheck.role === 'guest' && guestCheck.booking) {
        const booking = guestCheck.booking;
        console.log('[PIN_DEPOT] Четя щифт за гост от резервация...');

        // Четем щифта из резервация (детектив вече го е разпределил)
        const lockPin = booking.lock_pin;

        const guestData = {
            guest_name: booking.guest_name,
            reservation_code: booking.reservation_code,
            check_in: booking.check_in,
            check_out: booking.check_out,
            lock_pin: lockPin,
            booking_id: booking.id
        };

        console.log('[SECURITY] Определена роля: ГОСТ');
        console.log('[SECURITY] Данни на гост подготвени:', guestData.guest_name);
        console.log('[SECURITY] ========== ПРОВЕРКА НА СИГУРНОСТ ЗАВЪРШЕНА ==========\n');
        return { role: 'guest', data: guestData };
    }

    // ПО ПОДРАЗБИРАНЕ: НЕПОЗНАТ (ОГРАНИЧЕН ДОСТЪП)
    console.log('[SECURITY] Определена роля: НЕПОЗНАТ');
    console.log('[SECURITY] ========== ПРОВЕРКА НА СИГУРНОСТ ЗАВЪРШЕНА ==========\n');
    return { role: 'stranger', data: null };
}

// ============================================================================
// СТРОИТЕЛ НА СИСТЕМНО УКАЗАНИЕ - SINGLE SOURCE OF TRUTH (SSoT) АРХИТЕКТУРА
// ============================================================================

/**
 * ⚙️ АНАЛИЗ НА РЕФАКТОРИРАНЕ - SINGLE SOURCE OF TRUTH ПРИНЦИП
 * 
 * ПРОБЛЕМ - Старата версия:
 * ❌ Хардкодирани данни вътре в JavaScript (Apartment D105, SmartStay_Guest, etc.)
 * ❌ Дублирана информация между JavaScript и manual.txt
 * ❌ AI беше подвластен на JavaScript логика, не на manual
 * ❌ Сложност и конфликти при актуализирани на имота
 * 
 * РЕШЕНИЕ - SSoT архитектура:
 * ✅ ЕДИН източник на истина = manual.txt файлът
 * ✅ JavaScript е само "машина за доставка" на данни
 * ✅ Динамични данни = bookingData + powerStatus
 * ✅ AI инструкции наказват: "Използвай САМО manual съдържанието"
 * 
 * ПОТОК НА ИНФОРМАЦИЯ:
 * 1. manual.txt (всичко за имота - WiFi, правила, удобства, контакти)
 * 2. bookingData (кой е гостът, когато пристига, когато си тръгва)
 * 3. powerStatus (дали тока е работи)
 * 4. currentDateTime (когато е сега)
 * 5. role (домакин/гост/непознат) => ДОСТЪП ДО manual
 * 
 * ВХОД: function buildSystemInstruction(role, data, powerStatus, manual, currentDateTime)
 * ИЗХОД: Системна инструкция за AI (базирана на role + manual + динамични данни)
 * 
 * @param {string} role - 'host' | 'guest' | 'stranger' (от determineUserRole)
 * @param {Object|null} data - Всичко за гост или null: {guest_name, reservation_code, check_in, check_out, lock_pin, booking_id}
 * @param {Object} powerStatus - {online: boolean, isOn: boolean}
 * @param {string} manual - Пълното съдържание на manual.txt (вход от файл или PUBLIC_INFO_FALLBACK)
 * @param {string} currentDateTime - ISO дата/час на български
 * @returns {string} Системна инструкция за Gemini AI (с СТРОГИ правила за manual-only)
 */
export function buildSystemInstruction(role, data, powerStatus, manual, currentDateTime, preferredLanguage = 'bg') {
    const { online, isOn } = powerStatus;
    const languageInstruction = preferredLanguage === 'en'
        ? 'Respond in ENGLISH. Keep answers concise, clear, and practical.'
        : 'Отговаряй на БЪЛГАРСКИ език. Тон: приветлив, професионален, насочен към помощ.';
    
    // АНАЛИЗ: Логиране на входни параметри (за дебъг)
    console.log('[AI:SSoT] 🏗️ Строя системно указание със SSoT архитектура');
    console.log('[AI:SSoT] Role:', role, '| Manual дължина:', manual.length, 'байта');
    console.log('[AI:SSoT] Power: онлайн=' + online + ', включен=' + isOn);
    if (data) {
        console.log('[AI:SSoT] Guest data: ' + data.guest_name + ' (период: ' + new Date(data.check_in).toLocaleDateString('bg-BG') + ' - ' + new Date(data.check_out).toLocaleDateString('bg-BG') + ')');
    }

    // ============================================================================
    // ДИНАМИЧЕН BASE БЛОК - Еднакъв за всички роли
    // КРИТИЧНО: Само текущо време и статус, БЕЗ хардкодирани детайли
    // ============================================================================
    const baseBlock = `
⏰ ДАТА И ЧАС: ${currentDateTime} (българска часова зона)
🔌 СТАТУС НА СИСТЕМАТА: ${online && isOn ? '✅ ОНЛАЙН И ВКЛЮЧЕН' : online && !isOn ? '⚠️ ОНЛАЙН НО ИЗКЛЮЧЕН' : '❌ ОФЛАЙН'}
`;

    // ============================================================================
    // ROLE-SPECIFIC БЛОКОВЕ - Минимално и фокусирано
    // ============================================================================
    let roleBlock = '';
    let accessWarning = '';

    if (role === 'host') {
        console.log('[AI:SSoT] 👑 Режим ДОМАКИН - Пълен административен достъп');
        roleBlock = `
🔐 НИВО НА ДОСТЪП: АДМИНИСТРАТОР
📋 ФУНКЦИИ: Управление на имот, гости, известувания, диагностика на ток
`;
    } else if (role === 'guest') {
        console.log('[AI:SSoT] 👤 Режим ГОСТ - Ограничен достъп базиран на резервация');
        
        // КРИТИЧНО: Само ако имаме действителна резервация
        if (data) {
            const checkInDate = new Date(data.check_in);
            const checkOutDate = new Date(data.check_out);
            const hoursUntilCheckIn = (checkInDate.getTime() - new Date().getTime()) / (1000 * 60 * 60);
            
            // ДИНАМИЧНА SCHEDULER БЕЛЕЖКА - Само ако ток е ИЗКЛЮЧЕН и чек-ин е близо
            const schedulerNote = !isOn && hoursUntilCheckIn <= 2 && hoursUntilCheckIn > 0 
                ? '\n📌 СИСТЕМА: Токът е планиран да се включи автоматично 2 часа преди твоя check-in.'
                : '';
            
            roleBlock = `
🎟️ **ВАШАТА РЕЗЕРВАЦИЯ**
• **Име:** ${data.guest_name}
• **Код:** ${data.reservation_code}
• **Вход:** ${checkInDate.toLocaleString('bg-BG')}
• **Изход:** ${checkOutDate.toLocaleString('bg-BG')}

🏠 **ИНФОРМАЦИЯ ЗА ИМОТА**
• **Комплекс:** Aspen Valley, Апартамент D106 (Първи етаж, Крило Д)
• **Адрес:** ул. Св. Никола 32, 2760 Разлог (600м преди разклона за Разлог откъм Симитли)

📶 **WI-FI ДОСТЪП**
• **Мрежа:** PAPYNET
• **Парола:** kokokoko1

🔐 **КОД ЗА ДОСТЪП**
• ${data.lock_pin || 'Попълваме го сега...'}${schedulerNote}

📞 **ВАЖНИ КОНТАКТИ**
• **Домакин:** 0888 600 851
• **Охрана/Рецепция:** 0883 292 339

Ако имате нужда от информация за удобствата в комплекса (басейн, СПА, паркинг) или района (магазини, ресторанти), не се колебайте да попитате! 😊

🔐 НИВО НА ДОСТЪП: ГОСТ
📋 ФУНКЦИИ: Информация за престой, вода/ток статус, контакти за спешност
`;
        } else {
            console.warn('[AI:SSoT] ⚠️ ГОСТ без данни за резервация - нещо е грешно!');
            roleBlock = `
🔐 НИВО НА ДОСТЪП: ГОСТ (резервация не намерена)
`;
        }
    } else if (role === 'stranger') {
        console.log('[AI:SSoT] 🚫 Режим НЕПОЗНАТ - Защитена публична информация');
        accessWarning = `
🔓 ⚠️ ЗАЩИТА НА ДОСТЪПА:
   Вече немаш активна резервация. Видима е САМО публична информация.
    За полен достъп: въведи своя код за резервация или направи нова резервация.
`;
    }

    // ЯЗЫКОВИ ПРАВИЛА - INTELLIGENT MODE (CONTEXT-AWARE FILTERING)
    // АНАЛИЗ: Интелигентен режим - разрешава общите познания за неимотни въпроси
    // ============================================================================
    const strictInstructions = `

════════════════════════════════════════════════════════════════════════
🧠 ИНТЕЛИГЕНТНО РЕЖИМ ЗА AI АСИСТЕНТА (INTELLIGENT FILTERING)
════════════════════════════════════════════════════════════════════════

✅ ПРАВИЛО 1 - ИНФОРМАЦИЯ ЗА ИМОТА (STRICT MODE - ПЪЛНА ИНФОРМАЦИЯ):
   • Въпроси за имот / комплекс → ВСЯКА релевантна информация от MANUAL
   • Въпроси за удобства → ВСИЧКИ: кухненски бокс, отопление, бойлер, техника, СПА, басейн, паркинг
   • Въпроси за район → ВСИЧКИ: магазини, ресторанти, здравеопазване, адрес, разположение
   • Въпроси за контакти / правила / WiFi / кодове → САМО от MANUAL, НЕ измислени!
   • Въпроси за комплекс и апартамент ЕДНОВРЕМЕННО → ЦЯЛАТА информация: апартамент + 4 блока + удобства + район
   ⚠️ ЗАБРАНЕНО: Частични отговори! Ако питат за комплекса, включи ВСИЧКИ секции от MANUAL!

✅ ПРАВИЛО 2 - ОБЩИ ПОЗНАНИЯ (NATURAL MODE):
   • Въпроси за метеорология, география, история → Ползвай знанието си
   • Математика, наука, съвети, препоръки → Ползвай знанието си
   • Информация за България, региона, местоположението → Ползвай знанието си
   • Полезни советики за туристи, пътуване → Ползвай знанието си
   🎯 Цел: Помогни на гост като интелигентен асистент, не като файл читач

✅ ПРАВИЛО 3 - ГИБРИДНА КОМБИНИРАНА ЛОГИКА:
   • Ако въпросът смесва имот + общо (e.g. "Близо ли е до плажа?"):
     → Начало: "Според информацията ми, имотът е в Разлог..."
     → Следом: "...около 200km от плажа на Южния черноморски бряг"
   • Ако гост пита нещо специално което не е в MANUAL:
     → "В информацията за имота това не е описано. Препоръчвам свързване със собственика."

════════════════════════════════════════════════════════════════════════
`;

    // ============================================================================
    // АСЕМБЛИРАЙ ОКОНЧАТЕЛНИЯ СИСТЕМЕН БЛОК
    // АНАЛИЗ: Структура е: Base + Role + Warning + Manual (в края) + Strict Instructions
    // ============================================================================
    const systemPrompt = `
╔════════════════════════════════════════════════════════════════════════╗
║              🏠 SMART-STAY HOME AUTOMATION AI ASSISTANT               ║
║                  (Single Source of Truth Architecture)                 ║
╚════════════════════════════════════════════════════════════════════════╝

${baseBlock}
${roleBlock}
${accessWarning}

════════════════════════════════════════════════════════════════════════
📋 НАРЪЧНИК НА ИМОТА - ЕДИНСТВЕНА ИСТИНА
════════════════════════════════════════════════════════════════════════

${manual}

${strictInstructions}

════════════════════════════════════════════════════════════════════════
� ЗАБРАНЕНО ЗА AI - НИКОГА НЕ ПРАВИШ ТОВА:
════════════════════════════════════════════════════════════════════════

❌ ЗАБРАНЕНО: Измислянето на функции
   • НЕ казвай "Мога да управлявам осветлението"
   • НЕ казвай "Мога да включа/изключа бойлера"
   • НЕ казвай "Мога да управлявам кондиционера"
   • НЕ казвай "Мога да控制" отделни уреди (вентилатор, телевизор, и т.н.)
   • ЕДИНСТВЕНО ЧТО МОЖЕШ: Управляване на ОБЩИЯ ТОК (ВКЛ/ИЗКЛ) чрез AutoRemote

❌ ЗАБРАНЕНО: Претворство на знание
   • НЕ предполагай информация която НЕ е в manual
   • НЕ "помисли си" детайли за имота
   • НЕ измислявай кодове, пароли или контакти
   • Ако питат за нещо което НЕ е в manual → "Това не е описано в наръчника"

❌ ЗАБРАНЕНО: Халюцинирани умения
   • НЕ казвай "Мога да контролирам" системи които НЕ са в manual
   • НЕ казвай "Можа да отворя/затворя" врати/прозорци
   • НЕ казвай "Можеш да" направиш нещо което НЕ е технически възможно

✅ ПРАВИЛНО ДЕЙСТВИЕ:
   Ако гост/домакин пита за нещо което НЕ можеш:
   → Кажи директно: "Това не мога да направя. Това не е описано в наръчника / системата не поддържа това."
   → Препоръчай контакт със собственика ако е спешно

════════════════════════════════════════════════════════════════════════
    ${languageInstruction}

════════════════════════════════════════════════════════════════════════
📐 ФОРМАТИРАНЕ НА ОТГОВОРИТЕ:
════════════════════════════════════════════════════════════════════════

✅ ЗА ИМОТНИ ВЪПРОСИ (комплекс, апартамент, удобства):
   • Структурирай в ясни, логични СЕКЦИИ с емодзи заголовки
   • Пример: 📍 ЛОКАЦИЯ | 🏢 КОМПЛЕКС | 🏠 АПАРТАМЕНТ | 🍽️ РАЙОН | 🏊 УДОБСТВА
   • Всяка секция: заголовка + маркирани точки (•)
   •没有混合 информация - всяко нещо на място
   •格式: Професионален, лесно читаем

✅ ЗА ОБЩИ ВЪПРОСИ (метеорология, география, съвети):
   • Кратко (2-3 изречения за прости въпроси)
   • Дължина: Зависи от контекста, но НЕ повече от необходимото
   • Тонът: Информативен и практичен

✅ ЗА СМЕСЕНИ ВЪПРОСИ (комплекс + близко до плажа):
   • Начало: Manual информация (структурирана)
   • Преход: "Регионалният контекст:"
   • След това: Географски/туристически контекст

════════════════════════════════════════════════════════════════════════
🎯 ТОНЪТ ПО РОЛЯ:
════════════════════════════════════════════════════════════════════════

👑 ДОМАКИН (host):
   • Кратък и директен
   • Само конкретния отговор

👤 ГОСТ (guest):
   • Приветлив и кратък
   • Само конкретния отговор

🚫 НЕПОЗНАТ (stranger):
   • Учтив и кратък
   • Само публична информация

════════════════════════════════════════════════════════════════════════
⚠️ ОГРАНИЧЕНИЯ НА ФУНКЦИИТЕ (НЕ на общите познания):
════════════════════════════════════════════════════════════════════════

❌ Системата НЯМА управление на отделни уреди:
   • НЕ можеш управлявам осветление, бойлер, кондиционер, телевизор и т.н.
   • ЕДИНСТВЕНО управление: ОБЩ ТОК (ВКЛ/ИЗКЛ) за целия апартамент
   • Ако питат как да управляват уреди → "Нямам достъп до тези системи, съжалявам! Единствено могу да включа или изключа целия ток на апартамента."

❌ За ИМОТНИ детайли: SZIGORODUAN от manual
   • Ако е в manual → цял отговор с данни
   • Ако НЕ е в manual → "Това не мога да вам кажа. Най-добре е да попитате собственика! 😊"
   • Кодове, пароли, контакти → НИКОГА не измислявай! Само точно това което е в manual

✅ За ОБЩИТЕ ПОЗНАНИЯ: Свободен отговор!
   • Виц → КДА, мога да кажа виц! 😄
   • История, география, matematik → ДА, могу!
   • Съвети за туризъм, пътуване → ДА, могу!
   • Препоръки, советики → ДА, могу!
   → Ключ: Общите познания са ПОЗВОЛЕНИ, ограниченията са за ФУНКЦИИ на системата, НЕ за разговор!

════════════════════════════════════════════════════════════════════════
`;

    console.log('[AI:SSoT] ✅ Системна инструкция завършена (' + systemPrompt.length + ' символа)');
    return systemPrompt;
}

// ============================================================================
// АВТОМАТИЗАЦИЯ НА СПЕШНОСТ НА ТОК
// ============================================================================

/**
 * ⏳ ОЧАКВАНЕ НА TASKER ПОТВЪРЖДЕНИЕ
 * 
 * Когато изпратим команда към Tasker, изчакваме реалния отговор
 * Вместо да казваме "включих тока" (лъжа), чакаме 20 сек
 * и тогава казваме реалното состояние
 * 
 * @async
 * @param {boolean} expectedState - Какво состояние очаквам (true за ON, false за OFF)
 * @param {number} timeoutMs - Максимално време за чакане (ms)
 * @returns {Promise<{success: boolean, actualState: boolean|null, waited: number}>}
 */
async function waitForPowerConfirmation(expectedState, timeoutMs = 20000) {
    console.log(`[POWER:WAIT] ⏳ Очаквам потвърждение от Tasker за ${expectedState ? 'ON' : 'OFF'}...`);
    
    const startTime = Date.now();
    const pollInterval = 500; // Проверка всеки 500ms
    
    while (Date.now() - startTime < timeoutMs) {
        const latestStatus = await automationClient.getPowerStatus();
        const currentState = latestStatus?.isOn;
        const hasChanged = currentState === expectedState;
        
        if (hasChanged) {
            const waited = Date.now() - startTime;
            console.log(`[POWER:WAIT] ✅ ПОТВЪРДЕНО! Actual state: ${currentState}, Чакахме: ${waited}ms`);
            return {
                success: true,
                actualState: currentState,
                waited: waited
            };
        }
        
        // Чакай преди следващата проверка
        await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    
    // Timeout - не получихме потвърждение
    const waited = Date.now() - startTime;
    console.log(`[POWER:WAIT] ⏰ TIMEOUT! Очаквахме ${expectedState ? 'ON' : 'OFF'}, но не се случи в ${waited}ms`);
    return {
        success: false,
        actualState: null,
        waited: waited
    };
}

/**
 * РАЗПОЗНАВАНЕ НА СПЕШНОСТ НА ТОК И ОТГОВОР
 * 
 * Мониторира съобщенията на гост за оплаквания, свързани с ток
 * Ако гост докладва липса на ток И powerStatus.isOn е false:
 * 1. Автоматично задейства controlPower(true) за възстановяване на ток
 * 2. Изпраща спешно известување до домакина с информация за гост
 * 3. Връща системна бележка, която да се добави към отговор на AI
 * 
 * КРИТИЧНО: Изпълнява се само за ролята ГОСТ (не за непознати или домакини)
 * 
 * Ключни думи, които се разпознават: няма ток, без ток, не работи ток и т.н.
 * 
 * @async
 * @param {string} userMessage - Съобщение на гост
 * @param {string} role - Ролята на потребителя
 * @param {Object|null} bookingData - Информация за резервация на гост
 * @returns {Promise<string>} Системна бележка за добавяне (или празен низ)
 */
export async function checkEmergencyPower(userMessage, role, bookingData) {
    console.log('\n[POWER] Проверявам за спешни ситуации на тока...');

    // АВТОМАТИЗАЦИЯ НА ТОК: За гости и домакини
    if (role !== 'guest' && role !== 'host') {
        console.log('[POWER] Не е гост или домакин - пропускам проверките на ток');
        return "";
    }

    // Разпознава ключови думи на български език, свързани със спешни ситуации
    const emergencyPowerKeywords = /няма ток|без ток|не работи ток|спрян ток|изключен ток|няма енергия|NO POWER|нет тока/i;
    const medicalEmergencyKeywords = /болен|травма|инфаркт|помощ|спешност|здравословен|насилие|пожар/i;
    const powerCommandKeywords = /включи тока|включи ток|пусни тока|пусни ток|изключи тока|изключи ток|спри тока|спри ток|включ|изключ/i;
    
    const needsPower = emergencyPowerKeywords.test(userMessage);
    const needsMedical = medicalEmergencyKeywords.test(userMessage);
    const isPowerCommand = powerCommandKeywords.test(userMessage);

    if (!needsPower && !needsMedical && !isPowerCommand) {
        console.log('[POWER] Не са разпознати ключови думи за спешност или команди за управление');
        return "";
    }

    // КОМАНДИ ЗА УПРАВЛЕНИЕ НА ТОК (за всички роли - ако е разпозната команда)
    // Ако има ясна команда за управление на тока, изпълни я независимо от роля
    if (isPowerCommand) {
        console.log('[POWER] 🎯 КОМАНДА ЗА УПРАВЛЕНИЕ НА ТОК РАЗПОЗНАТА (role=' + role + ')');
        const commandSource = role === 'host' ? 'host_command' : 'guest_command';
        
        const isInclude = /включи|пусни|включ/i.test(userMessage);
        const isExclude = /изключи|спри|изключ/i.test(userMessage);
        
        if (isInclude) {
            console.log('[POWER] ⚡ КОМАНДА: ВКЛЮЧИ ТОКА');
            await automationClient.controlPower(true, bookingData?.id, commandSource);
            
            // ⏳ ИЗЧАКАЙ РЕАЛНОТО ПОТВЪРЖДЕНИЕ ОТ TASKER
            const confirmation = await waitForPowerConfirmation(true, 20000);
            console.log(`[POWER] Резултат: success=${confirmation.success}, waited=${confirmation.waited}ms`);

            return confirmation.success
                ? 'Разбрах. Пуснах тока и получих потвърждение от системата. ✅'
                : 'Изпратих команда за включване на тока, но още нямам потвърждение от Tasker. Провери след 20-30 секунди.';
        } else if (isExclude) {
            console.log('[POWER] ⚡ КОМАНДА: ИЗКЛЮЧИ ТОКА');
            await automationClient.controlPower(false, bookingData?.id, commandSource);
            
            // ⏳ ИЗЧАКАЙ РЕАЛНОТО ПОТВЪРЖДЕНИЕ ОТ TASKER
            const confirmation = await waitForPowerConfirmation(false, 20000);
            console.log(`[POWER] Резултат: success=${confirmation.success}, waited=${confirmation.waited}ms`);

            return confirmation.success
                ? 'Разбрах. Спрях тока и получих потвърждение от системата. ✅'
                : 'Изпратих команда за спиране на тока, но още нямам потвърждение от Tasker. Провери след 20-30 секунди.';
        }
    }

    // МЕДИЦИНСКА СПЕШНОСТ
    if (needsMedical) {
        console.log('[POWER] 🚑 МЕДИЦИНСКА СПЕШНОСТ РАЗПОЗНАТА: Гост има здравословна проблем!');
        
        // Известява домакина - това е критично
        await automationClient.sendAlert(
            `🚑 МЕДИЦИНСКА СПЕШНОСТ: Гост ${bookingData?.guest_name} (${bookingData?.reservation_code}) докладва здравословна проблем.`,
            {
                guest_name: bookingData?.guest_name || 'Непознат',
                reservation_code: bookingData?.reservation_code || 'N/A',
                role: role,
                timestamp: new Date().toISOString(),
                action: 'medical-emergency',
                severity: 'CRITICAL'
            }
        );
        
        // Остави AI да генерира отговор от manual (където е казано да се обади 112)
        return "";
    }

    console.log('[POWER] ⚠️ СПЕШНОСТ РАЗПОЗНАТА: Гост докладва липса на ток!');

    // ОВЪРАЙД НА ГОСТ: Ако гост се жали на "Няма ток", автоматично включва тока
    // Това е защитна мярка - гостът ще получи ток дори ако е планирано изключване
    console.log('[POWER] 🚨 ОВЪРАЙД НА ГОСТ АКТИВИРАН: Принудително включване на ток');
    
    const overrideSuccess = await automationClient.controlPower(true, bookingData?.id, 'ai_emergency_override');
    
    // ⏳ ИЗЧАКАЙ РЕАЛНОТО ПОТВЪРЖДЕНИЕ ОТ TASKER
    const confirmation = await waitForPowerConfirmation(true, 20000);
    console.log(`[POWER:OVERRIDE] Резултат: success=${confirmation.success}, waited=${confirmation.waited}ms`);

    if (overrideSuccess || confirmation.success) {
        console.log('[POWER] ✅ Команда за возстановяване на ток изпратена успешно');
        
        // Изпраща известуване до домакина
        await automationClient.sendAlert(
            `🚨 СПЕШНО ВЪЗСТАНОВЯВАНЕ НА ТОК: Гост ${bookingData?.guest_name} (${bookingData?.reservation_code}) докладва липса на ток. Ток е включен автоматично.`,
            {
                guest_name: bookingData?.guest_name || 'Непознат',
                reservation_code: bookingData?.reservation_code || 'N/A',
                role: role,
                timestamp: new Date().toISOString(),
                action: 'power-override'
            }
        );

        console.log('[POWER] Известуванието е изпратено до домакина');
        return 'Получих сигнал за липса на ток. Пуснах тока и уведомих домакина. ✅';
    } else {
        console.log('[POWER] ❌ Команда за управление на ток не успя');
        
        // Известува домакина за проблема
        await automationClient.sendAlert(
            `🔴 КРИТИЧНО: Гост ${bookingData?.guest_name} докладва липса на ток, но автоматичното включване не успя. Необходима е преглед.`,
            {
                guest_name: bookingData?.guest_name || 'Непознат',
                reservation_code: bookingData?.reservation_code || 'N/A',
                role: role,
                timestamp: new Date().toISOString(),
                action: 'power-override-failed'
            }
        );
        
        return 'Опитах да включа тока, но автоматичното възстановяване не успя. Уведомих домакина за спешна проверка.';
    }
}

/**
 * Разпознава дали потребителят иска директно управление на тока
 * Използва се за твърда авторизационна бариера преди AI отговор
 *
 * @param {string} userMessage
 * @returns {boolean}
 */
function isPowerCommandRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    const powerCommandKeywords = /включи тока|включи ток|пусни тока|пусни ток|изключи тока|изключи ток|спри тока|спри ток|включ|изключ|turn on power|turn off power|power on|power off/i;
    return powerCommandKeywords.test(userMessage);
}

/**
 * Разпознава въпрос от типа "има ли ток" (само статус)
 * Използва се за кратък детерминистичен отговор без генерация от AI
 *
 * @param {string} userMessage
 * @returns {boolean}
 */
function isPowerStatusRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    const statusKeywords = /има ли ток|има ток|няма ли ток|статус на тока|как е токът|токът има ли го|има ли електричество|има електричество|няма електричество|има ли захранване|има захранване|няма захранване|има ли ток в апартамента|ток има ли|power status|is there power|electricity status|is electricity on/i;
    return statusKeywords.test(userMessage);
}

/**
 * Разпознава въпроси за ролята на потребителя
 *
 * @param {string} userMessage
 * @returns {boolean}
 */
function isRoleIdentityRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    const roleKeywords = /какъв съм аз|каква е ролята ми|кой съм аз|дали съм гост|дали съм домакин|am i guest|am i host|what is my role|who am i/i;
    return roleKeywords.test(userMessage);
}

/**
 * Открива предпочитан език от текущо съобщение и history
 * По подразбиране: български
 *
 * @param {string} userMessage
 * @param {Array} history
 * @returns {'bg'|'en'}
 */
function detectPreferredLanguage(userMessage, history = []) {
    const toEnglishRegex = /please in english|in english|speak english|english please|на английски|говори на английски/i;
    const toBulgarianRegex = /на български|говори на български|in bulgarian|bulgarian please|speak bulgarian/i;

    const candidates = [
        userMessage,
        ...((Array.isArray(history) ? history : [])
            .slice()
            .reverse()
            .filter(msg => msg && msg.role === 'user' && typeof msg.content === 'string')
            .map(msg => msg.content))
    ];

    for (const text of candidates) {
        if (!text) continue;
        if (toEnglishRegex.test(text)) return 'en';
        if (toBulgarianRegex.test(text)) return 'bg';
    }

    return 'bg';
}

/**
 * Детерминистичен отговор за текуща роля
 *
 * @param {'host'|'guest'|'stranger'} role
 * @param {'bg'|'en'} language
 * @returns {string}
 */
function getRoleIdentityReply(role, language = 'bg') {
    if (language === 'en') {
        if (role === 'host') return 'You are authenticated as host.';
        if (role === 'guest') return 'You are authenticated as guest.';
        return 'You are currently unauthenticated.';
    }

    if (role === 'host') return 'В момента сте идентифициран като домакин.';
    if (role === 'guest') return 'В момента сте идентифициран като гост.';
    return 'В момента сте неоторизиран потребител.';
}

// ============================================================================
// ОБРАБОТКА НА ИЗВЕСТУВАНИЯ
// ============================================================================

/**
 * ОБРАБОТКА НА ИЗВЕСТУВАТЕЛНИ МАРКЕРИ
 * 
 * Сканира отговор на AI за маркери [ALERT: ...]
 * Извлича съобщение за известуване и го изпраща до домакина чрез услугата за автоматизация
 * Премахва известувателни маркери от отговора преди връщане към потребителя
 * 
 * Формат: [ALERT: Съобщение за изпращане до домакина]
 * 
 * @async
 * @param {string} aiResponse - Текст на отговор от Gemini AI
 * @param {string} role - Ролята на потребителя
 * @param {Object|null} bookingData - Информация за резервация на гост
 * @returns {Promise<string>} Отговор с премахнати известувателни маркери
 */
export async function processAlerts(aiResponse, role, bookingData) {
    console.log('[ALERTS] Сканирам отговор за известувателни маркери...');

    if (!aiResponse.includes('[ALERT:')) {
        console.log('[ALERTS] Не са намерени известувания в отговора');
        return aiResponse;
    }

    const match = aiResponse.match(/\[ALERT:(.*?)\]/);

    if (match && match[1]) {
        const alertMessage = match[1].trim();
        console.log('[ALERTS] Открит известувателен маркер:', alertMessage);

        await automationClient.sendAlert(
            alertMessage,
            {
                guest_name: bookingData?.guest_name || 'Неизвестен гост',
                reservation_code: bookingData?.reservation_code || 'N/A',
                role: role,
                timestamp: new Date().toISOString()
            }
        );

        console.log('[ALERTS] Известуванието е изпратено до домакина успешно');
    }

    const cleanedResponse = aiResponse.replace(/\[ALERT:.*?\]/g, '').trim();
    console.log('[ALERTS] Известувателни маркери премахнати от отговор');
    return cleanedResponse;
}

// ============================================================================
// ГЕНЕРИРАНЕ НА ОТГОВОР НА AI СЪС МНОГОМОДЕЛНА ОТКАЗОВА ЛОГИКА
// ============================================================================

/**
 * Форматира история на разговор за API на Gemini
 * 
 * Приема история в множество формати (JSON низ или масив)
 * Преобразува към формат, съвместим с Gemini, с правилно съпоставяне на ролята
 * 
 * @private
 * @param {string|Array} history - История на разговор
 * @returns {Array} Форматиран масив от съобщения за Gemini
 */
function formatHistory(history) {
    console.log('[HISTORY] Форматирам история на разговор...');
    let parsed = [];

    if (typeof history === 'string') {
        try {
            parsed = JSON.parse(history);
            console.log('[HISTORY] Разбран JSON низ, съобщения:', parsed.length);
        } catch (e) {
            console.error('[HISTORY] Неудача при разбиране на JSON история:', e.message);
            return [];
        }
    } else if (Array.isArray(history)) {
        parsed = history;
        console.log('[HISTORY] Използвам масив история, съобщения:', parsed.length);
    }

    return parsed.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
    }));
}

/**
 * ОСНОВНА ФУНКЦИЯ ЗА ОТГОВОР НА AI СЪС МНОГОМОДЕЛНА ОТКАЗОВА ЛОГИКА
 * 
 * Организира пълния процес:
 * 1. Валидира входни данни
 * 2. Определя ролята на потребителя (със проверки на сигурност)
 * 3. Зарежда наръчник на имот (почитайки правилата на защитната стена)
 * 4. Получава статус на тока
 * 5. Строи системно указание за ролята
 * 6. Запитва първичния модел Gemini
 * 7. АКО първичния се провали, опитва отказови модели (каскада от 3 модела)
 * 8. Проверява за спешни ситуации на ток и задейства автоматизация
 * 9. Обработва известувателни маркери
 * 10. Връща чист отговор на потребителя
 * 
 * СТРАТЕГИЯ НА ОТКАЗ:
 * - Първо опитва gemini-3-pro-preview
 * - Отказ към gemini-flash-latest ако първичния се провали
 * - Финален отказ към gemini-3-flash-preview
 * - Връща общо съобщение за грешка, ако всички модели се провалят
 * 
 * @async
 * @param {string} userMessage - Входно съобщение на потребителя
 * @param {string|Array} history - История на разговор
 * @param {string|null} authCode - Код за разрешение от заявка
 * @returns {Promise<string>} Текст на отговор на AI на български
 */
export async function getAIResponse(userMessage, history = [], authCode = null) {
    // 1. ПРОВЕРКА НА API KEY
    if (!genAI) {
        console.error('🔴 ГРЕШКА: Липсва GEMINI_API_KEY');
        return "В момента имам техническо затруднение (API Key Error).";
    }

    // 2. ОПРЕДЕЛЯНЕ НА РОЛЯ И ДАННИ (Поправка: добавено е ", data")
    const { role, data } = await determineUserRole(authCode, userMessage);
    const preferredLanguage = detectPreferredLanguage(userMessage, history);

    // 2.3. ДЕТЕРМИНИСТИЧЕН ОТГОВОР ЗА РОЛЯТА (без Gemini)
    if (isRoleIdentityRequest(userMessage)) {
        return getRoleIdentityReply(role, preferredLanguage);
    }

    // 2.5. ТВЪРДА АВТОРИЗАЦИОННА БАРИЕРА ЗА УПРАВЛЕНИЕ НА ТОК
    // Ако няма валидна роля (guest/host), никога не допускай AI да обещава действие.
    const requestedPowerCommand = isPowerCommandRequest(userMessage);
    if (requestedPowerCommand && role !== 'guest' && role !== 'host') {
        console.warn('[SECURITY] 🚫 Блокирана команда за ток от неоторизиран потребител');
        if (preferredLanguage === 'en') {
            return `I cannot execute power commands because you are not authorized.

To get access:
- Host: sign in with a valid token.
- Guest: send a valid reservation code from an active booking.

After successful verification, I will execute the command immediately.`;
        }
        return `Не мога да изпълня команда за тока, защото не сте оторизиран.

За достъп:
- Домакин: влезте с валиден token.
- Гост: изпратете валиден код за резервация от активна резервация.

След успешна верификация ще изпълня командата веднага.`;
    }
    
    // 3. ПОЛУЧАВАНЕ НА СТАТУС НА ТОКА
    const powerStatus = await automationClient.getPowerStatus();
    const locale = preferredLanguage === 'en' ? 'en-GB' : 'bg-BG';
    const currentDateTime = new Date().toLocaleString(locale, { timeZone: 'Europe/Sofia' });

    // 3.5 КРАТЪК ДЕТЕРМИНИСТИЧЕН ОТГОВОР ЗА СТАТУС НА ТОКА
    // Изискване: без час, само кратка информация
    if (isPowerStatusRequest(userMessage) && !requestedPowerCommand) {
        if (!powerStatus?.online) {
            return preferredLanguage === 'en'
                ? 'I currently have no connection to the power system.'
                : 'В момента нямам връзка със системата за ток.';
        }
        return powerStatus?.isOn
            ? (preferredLanguage === 'en' ? 'Yes, there is electricity.' : 'Да, има ток.')
            : (preferredLanguage === 'en' ? 'No, there is no electricity.' : 'Не, няма ток.');
    }

    // 4. ЧЕТЕНЕ НА МАНУАЛА (РАЗДЕЛЕН НА ПУБЛИЧЕН И ЧАСТЕН)
    let manualContent = "";
    try {
        if (role === 'stranger') {
            // Публична информация за непознати
            const publicPath = path.join(process.cwd(), 'services', 'manual-public.txt');
            manualContent = await fs.readFile(publicPath, 'utf-8');
            console.log('📖 Прочетен manual-public.txt (публичен достъп)');
        } else {
            // Пълна информация за гости и домакин
            const privatePath = path.join(process.cwd(), 'services', 'manual-private.txt');
            manualContent = await fs.readFile(privatePath, 'utf-8');
            console.log('📖 Прочетен manual-private.txt (частен достъп)');
        }
    } catch (error) {
        console.error('🔴 Грешка при четене на наръчник:', error.message);
        // Резервни пътища
        try {
            if (role === 'stranger') {
                manualContent = await fs.readFile(path.join(process.cwd(), 'manual-public.txt'), 'utf-8');
            } else {
                manualContent = await fs.readFile(path.join(process.cwd(), 'manual-private.txt'), 'utf-8');
            }
        } catch (e) {
            manualContent = role === 'stranger' ? PUBLIC_INFO_FALLBACK : "Няма достъп до наръчника.";
        }
    }

    // 5. ИНСТРУКЦИИ ЗА ИКО (Вече 'data' съществува и няма да гърми)
    const systemInstruction = buildSystemInstruction(role, data, powerStatus, manualContent, currentDateTime, preferredLanguage);

    // 5.5. ПРОВЕРКА ЗА КОМАНДИ НА ТОК ПРЕДИ AI ГЕНЕРИРАНЕ
    // Ако домакинът или гост командва управление на тока, изпълни го веднага
    const powerCommandResult = await checkEmergencyPower(userMessage, role, data);
    if (powerCommandResult) {
        console.log('[MAIN] ✅ Команда за управление на ток е разпозната и изпълнена');
        return powerCommandResult;
    }

    // 6. ГЕНЕРИРАНЕ С GEMINI (С Loop през моделите)
    let finalReply = "В момента имам техническо затруднение. Моля, опитайте след малко.";

    for (const modelName of MODELS) {
        try {
            const model = genAI.getGenerativeModel({ 
                model: modelName, 
                systemInstruction: systemInstruction 
            });

            const chat = model.startChat({
                history: (Array.isArray(history) ? history : []).map(msg => ({
                    role: msg.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: msg.content }]
                })),
                generationConfig: { maxOutputTokens: 4000 } // ПОПРАВЕНО: увеличен лимит за пълни отговори
            });

            console.log(`🤖 Опит за генериране с модел: ${modelName}`);
            const result = await chat.sendMessage(userMessage);
            finalReply = result.response.text();
            
            // Ако стигнем тук, значи е успешно
            break; 
        } catch (modelError) {
            console.warn(`⚠️ Модел ${modelName} отказа:`, modelError.message);
            continue; // Пробвай следващия модел
        }
    }

    // 7. АВАРИЙНО УПРАВЛЕНИЕ НА ТОКА
    // Ако е гост, няма ток и се оплаква -> пускаме го
    if (role === 'guest' && !powerStatus.isOn && /няма ток|спря ток|токът не работи/i.test(userMessage)) {
        console.log('🚨 АВАРИЯ: Гост докладва липса на ток. Опит за възстановяване...');
        const success = await automationClient.controlPower(true, data?.booking_id, 'ai_guest_emergency'); // Това ще прати и Telegram команда
        
        // ⏳ ИЗЧАКАЙ РЕАЛНОТО ПОТВЪРЖДЕНИЕ ОТ TASKER
        const confirmation = await waitForPowerConfirmation(true, 20000);
        console.log(`[POWER:GUEST_EMERGENCY] Резултат: success=${confirmation.success}, waited=${confirmation.waited}ms`);
        
        if (success || confirmation.success) {
            await automationClient.sendAlert("Автоматично възстановяване на ток за гост", data);
            finalReply = `Разбрах! Изпратих сигнал към апартамента. 📡

⏳ Какво следва: Трябва да получите потвърждение до 30 секунди.

⚠️ Ако нищо не се случи и аз не потвърдя: Това означава, че комуникацията с апартамента е прекъсната. В 99% от случаите това значи ЦЕНТРАЛНА АВАРИЯ в района.

🔗 Проверете тук: https://info.electrohold.bg (Община Разлог)`;
        }
    }

    return finalReply;
}

// ============================================================================
// ФУНКЦИЯ ЗА ОБРАТНА СЪВМЕСТИМОСТ
// ============================================================================

/**
 * Наследена функция за обратна съвместимост
 * Проверява дали код на резервация съществува и връща информация на гост със щифт
 * 
 * @async
 * @param {string} reservationCode - Код на резервация HM на гост
 * @returns {Promise<Object|null>} Информация на гост със щифт или null ако не е намерена
 */
export async function checkBookingAndGetPin(reservationCode) {
    console.log('[LEGACY] checkBookingAndGetPin викана за код:', reservationCode);
    const { role, data } = await determineUserRole(reservationCode, '');

    if (role === 'guest' && data) {
        const result = {
            guest_name: data.guest_name,
            pin: data.lock_pin,
            check_in: data.check_in
        };
        console.log('[LEGACY] Връщам данни на гост:', result);
        return result;
    }

    console.log('[LEGACY] Не е намерена валидна резервация');
    return null;
}
