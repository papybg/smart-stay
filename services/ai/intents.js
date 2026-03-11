/**
 * intents.js — Разпознаване на намерения от потребителски съобщения.
 * Чисти функции без странични ефекти. Не импортира от другите ai/ модули.
 */

// ── Power command detection ────────────────────────────────────────────────

export function detectPowerCommandIntent(rawMessage = '') {
    const normalizedText = String(rawMessage || '').toLowerCase();
    if (!normalizedText.trim()) return { isInclude: false, isExclude: false };

    const cleaned = normalizedText.replace(/[^\p{L}\p{N}\s]+/gu, ' ');
    const tokens = new Set(cleaned.split(/\s+/).filter(Boolean));

    const excludeTokenHits = [
        'изключи','изключа','изключване','изключвам',
        'спри','спирай','спиране',
        'угаси','угасване','изгаси','изгася','изгасване',
        'κλείσε','κλεισε','κλείσιμο','σβήσε','σβησε','σταμάτα','σταματα',
        'opreste','oprește','oprire','stinge','stingeți',
        'iskljuci','isključi','ugasite','ugasi','stani',
        'искључи','угаси','стани','исклучи','изгаси','згасни','стопирај','сопри',
        'ausschalten','ausschalte','ausmachen','aus','stoppen',
        'kapat','kapatın','kapatin','durdur','söndür','sondur',
        'off'
    ];
    const includeTokenHits = [
        'включи','включа','включване','включвам',
        'пусни','пусна','пуснеш','пускане',
        'цъкни','цъкна','възстанови','възстановяване',
        'άναψε','αναψε','άνοιξε','ανοιξε','άνοιγμα',
        'porneste','pornește','aprinde','activeaza','activează',
        'ukljuci','uključi','upali','pokreni',
        'укључи','упали','покрени','вклучи','пушти','уклучи',
        'einschalten','einschalte','anmachen',
        'aç','ac','açın','acin','yak',
        'on'
    ];

    const hasExcludeToken = excludeTokenHits.some(t => tokens.has(t));
    const hasExcludePhrase = /power\s*off|turn\s*off|cut\s*power|κλείσε\s+το\s+ρεύμα|κλεισε\s+το\s+ρευμα|σβήσε\s+το\s+ρεύμα|σβησε\s+το\s+ρευμα|σταμάτα|σταματα|opreste\s+curentul|oprește\s+curentul|stinge\s+curentul|iskljuci\s+struju|isključi\s+struju|угаси\s+струју|исклучи\s+струја|aus\s+strom|strom\s+aus|schalte\s+strom\s+aus|elektriği\s+kapat|elektrigi\s+kapat/i.test(normalizedText);
    const isExclude = hasExcludeToken || hasExcludePhrase;

    const hasIncludeToken = includeTokenHits.some(t => tokens.has(t)) || /дай\s+ток/i.test(normalizedText);
    const hasIncludePhrase = /power\s*on|turn\s*on|restore\s*power|άναψε\s+το\s+ρεύμα|αναψε\s+το\s+ρευμα|άνοιξε\s+το\s+ρεύμα|ανοιξε\s+το\s+ρευμα|porneste\s+curentul|pornește\s+curentul|aprinde\s+curentul|ukljuci\s+struju|uključi\s+struju|укључи\s+струју|вклучи\s+струја|strom\s+an|schalte\s+strom\s+ein|elektriği\s+aç|elektrigi\s+ac/i.test(normalizedText);
    const isInclude = !isExclude && (hasIncludeToken || hasIncludePhrase);

    return { isInclude, isExclude };
}

export function isLikelyPowerCommand(userMessage = '') {
    const { isInclude, isExclude } = detectPowerCommandIntent(userMessage);
    if (isInclude || isExclude) return true;
    const text = String(userMessage || '');
    return /включи|включване|пусни|пуснеш|цъкни|възстанови|спри|изключи|угаси|изгаси|power\s*on|power\s*off|turn\s*on|turn\s*off|restore\s*power|cut\s*power|άναψε|αναψε|άνοιξε|ανοιξε|κλείσε|κλεισε|σβήσε|σβησε|σταμάτα|σταματα|porneste|pornește|aprinde|activeaza|activează|opreste|oprește|stinge|ukljuci|uključi|iskljuci|isključi|укључи|искључи|вклучи|исклучи|einschalten|ausschalten|anmachen|ausmachen|strom\s+an|strom\s+aus|aç|ac|kapat|durdur|söndür|sondur/i.test(text);
}

export function isPowerCommandRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return isLikelyPowerCommand(userMessage);
}

export function isPowerStatusRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /има ли ток|има ток|няма ли ток|статус на тока|как е токът|токът има ли го|има ли електричество|има електричество|няма електричество|има ли захранване|има захранване|няма захранване|има ли ток в апартамента|ток има ли|power status|is there power|electricity status|is electricity on/i.test(userMessage);
}

// ── Reservation / booking ──────────────────────────────────────────────────

export function containsReservationCode(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /HM[A-Z0-9_-]+/i.test(userMessage);
}

export function isBareReservationCodeMessage(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /^HM[A-Z0-9_-]+$/i.test(String(userMessage).trim());
}

export function isReservationCodeIntro(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /код(ът)?\s*(ми)?\s*за\s*резервация|reservation code|my code is|my reservation is|i am\s+hm[a-z0-9_-]+|i'm\s+hm[a-z0-9_-]+|аз\s+съм\s*hm[a-z0-9_-]+|имам резервация|i have reservation|i have a reservation/i.test(userMessage);
}

export function isReservationRefreshRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /провери пак|провери отново|обнови резервацията|рефрешни резервацията|check again|check my reservation again|refresh reservation|recheck reservation/i.test(userMessage);
}

export function isLockCodeLookupRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /код\s+за\s+бравата|код\s+за\s+вратата|код\s+за\s+вход|lock\s+code|door\s+code|entry\s+code|tuya\s+code|парола\s+за\s+бравата/i.test(userMessage);
}

// ── Host report requests ───────────────────────────────────────────────────

export function isTodayRegistrationsRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /каква(и)?\s+регистраци(я|и)\s+има\s+за\s+днес|регистраци(я|и)\s+за\s+днес|резерваци(я|и)\s+за\s+днес|какви\s+резервации\s+има\s+днес|днешн(и|ата)\s+регистраци(я|и)|има\s+ли\s+регистраци(я|и)\s+днес|today registrations|today bookings|bookings for today/i.test(userMessage);
}

export function isActiveNowRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /активни\s+резерваци(я|и)\s+сега|активни\s+регистраци(я|и)\s+сега|колко\s+са\s+активните\s+сега|има\s+ли\s+активни\s+гост(и|а)\s+в\s+момента|кой\s+е\s+настанен\s+в\s+момента|active\s+bookings\s+now|active\s+registrations\s+now/i.test(userMessage);
}

export function isTomorrowRegistrationsRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /резерваци(я|и)\s+за\s+утре|регистраци(я|и)\s+за\s+утре|tomorrow\s+bookings|tomorrow\s+registrations/i.test(userMessage);
}

export function isCheckoutTodayRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /check\s*-?out\s+днес|напускан(е|ия)\s+днес|излиза(т)?\s+днес|checkout\s+today|check-out\s+today/i.test(userMessage);
}

export function isRecentCancelledRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /анулиран(и|ия)\s+(резерваци(я|и))?|cancelled\s+bookings|canceled\s+bookings|анулаци(я|и)\s+последните/i.test(userMessage);
}

export function isUnknownPowerStatusRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /unknown\s+power|неизвестен\s+статус\s+на\s+тока|липсващ\s+статус\s+на\s+тока|power_status\s+unknown/i.test(userMessage);
}

export function isDatabaseSnapshotRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /прочети\s+базата|чети\s+базата|покажи\s+базата|какво\s+има\s+в\s+базата|покажи\s+данните\s+от\s+bookings|дай\s+справка\s+от\s+базата|статус\s+на\s+базата|резюме\s+от\s+базата|използвай\s+базата|database\s+snapshot|database\s+report|read\s+the\s+database|show\s+database\s+status|bookings\s+database\s+summary/i.test(userMessage);
}

export function isHostDbCatchAllRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /(база(та)?|database|bookings)/i.test(userMessage) && /(резервац|регистрац|активни|днес|утре|анулиран|справка|статус|summary|report)/i.test(userMessage);
}

// ── Map / directions / places ──────────────────────────────────────────────

export function isLivePlacesLookupRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    const text = String(userMessage).toLowerCase();
    const hasServiceIntent = /къде\s+мога\s+да|къде\s+има|какви|какво\s+има|маршрут|маршрути|колко|как\s+да\s+стигна|адрес|телефон|работно\s+време|препоръчай|where\s+can\s+i|where\s+is|what|which|route|routes|how\s+much|how\s+to\s+get|address|phone|opening\s+hours|recommend/i.test(text);
    const hasLocalBusinessKeyword = /кола\s+под\s+наем|наем|rent\s*a\s*car|car\s*rental|аптека|pharmacy|такси|taxi|ресторант|restaurant|кафе|cafe|бар|bar|магазин|shop|supermarket|супермаркет|банкомат|atm|сервиз|service|repair|ски\s*училище|ski\s*school|училище|school|ски\s*гардероб|ski\s*locker|locker|storage|ски\s*под\s*наем|ski\s*rental|голф|golf|спа|spa|масаж|massage|фитнес|gym|басейн|pool|лекар|doctor|болница|hospital|дентист|dentist|пекарна|bakery|маршрут|route|екскурзия|excursion|tour|гид|guide|транспорт|transport|автобус|bus|трансфер|transfer/i.test(text);
    const hasAreaContext = /банско|разлог|в\s+района|наблизо|nearby|in\s+the\s+area|around/i.test(text);
    return (hasServiceIntent && hasLocalBusinessKeyword) || (hasLocalBusinessKeyword && hasAreaContext);
}

export function isMapStyleQuestion(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    const text = String(userMessage).toLowerCase();
    const hasMapIntent = /къде|какви|маршрут|маршрути|колко|как\s+да\s+стигна|адрес|наблизо|в\s+района|карти|where|which|route|routes|how\s+much|how\s+to\s+get|nearby|map|maps|address|location/i.test(text);
    const hasServiceOrPlace = /под\s+наем|наем|rent|rental|car|кола|аптека|такси|ресторант|кафе|бар|хотел|магазин|банкомат|голф|ски|ски\s*училище|ski\s*school|училище|school|ски\s*гардероб|ski\s*locker|locker|storage|service|pharmacy|taxi|restaurant|hotel|shop|supermarket|atm|golf|ski|spa|massage|gym|pool|doctor|hospital|dentist|bakery|route|excursion|tour|transport|bus|transfer/i.test(text);
    const hasArea = /банско|разлог|bansko|razlog/i.test(text);
    return (hasMapIntent && hasServiceOrPlace) || (hasServiceOrPlace && hasArea);
}

export function isDirectionsRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /как\s+да\s+стигна|как\s+да\s+отида|маршрут\s+до|маршрут|route\s+to|directions\s+to|how\s+to\s+get\s+to|how\s+do\s+i\s+get\s+to/i.test(String(userMessage).toLowerCase());
}

export function buildDirectionsDestination(userMessage) {
    const text = String(userMessage || '').trim();
    if (!text) return null;
    const patterns = [
        /(?:как\s+да\s+стигна\s+до|как\s+да\s+отида\s+до|маршрут\s+до)\s+(.+)$/i,
        /(?:route\s+to|directions\s+to|how\s+to\s+get\s+to|how\s+do\s+i\s+get\s+to)\s+(.+)$/i,
        /\bдо\s+(.+)$/i,
        /\bto\s+(.+)$/i
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) {
            const dest = match[1].trim().replace(/[?.!,]+$/, '').trim();
            if (dest.length >= 2) return dest;
        }
    }
    return text.length >= 3 ? text : null;
}

// ── Identity / role requests ───────────────────────────────────────────────

export function isRoleIdentityRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /какъв съм аз|каква е ролята ми|кой съм аз|дали съм гост|дали съм домакин|am i guest|am i host|what is my role|who am i/i.test(userMessage);
}

// ── Groq router eligibility ────────────────────────────────────────────────

export function isManualLikeQuestion(userMessage = '') {
    const text = String(userMessage || '').toLowerCase();
    if (!text.trim()) return false;
    const manualHints = [
        'паркинг','wifi','wi-fi','интернет','парола','климатик','клима',
        'отопление','бойлер','пералня','сушилня','печка','фурна','хладилник',
        'check-in','check in','check-out','check out','самонастаняване',
        'адрес','локация','инструкция','инструкции','наръчник','врата','брава',
        'апартамент','апартамента','комплекс','комплекса',
        'tv','телевизор','дистанционно','гараж','асансьор','код за вход',
        'parking','address','manual','instructions','apartment','property','complex',
        'heater','boiler','washing machine','fridge','oven','stove','door',
        'lock','checkin','checkout'
    ];
    return manualHints.some(token => text.includes(token));
}

export function shouldUseGroqRouterForMessage(userMessage = '') {
    const text = String(userMessage || '').toLowerCase();
    if (!text.trim()) return false;
    if (!isManualLikeQuestion(text)) return false;
    const outOfScopePatterns = [
        /кола\s+под\s+наем/i,/наем\s+на\s+кола/i,/rent\s*a\s*car/i,/car\s+rental/i,
        /автомобил\s+под\s+наем/i,/къде\s+мога\s+да\s+наема\s+кола/i,
        /препоръча(й|йте)|recommend|best\s+place|най\s*доб(ър|ра|ро)/i,
        /къде\s+мога\s+да|where\s+can\s+i/i
    ];
    if (outOfScopePatterns.some(p => p.test(text))) return false;
    return true;
}

// ── Brave search eligibility ───────────────────────────────────────────────

export function isSearchEligibleQuery(userMessage = '') {
    if (!userMessage || typeof userMessage !== 'string') return false;
    const text = String(userMessage).trim();
    const lowered = text.toLowerCase();
    if (text.length < 8) return false;
    if (containsReservationCode(text)) return false;
    if (isPowerCommandRequest(text)) return false;
    const shortChatPatterns = [
        /^(здра(вей|сти)|hello|hi|hey|ok|okei|thanks|благодаря|мерси)[!.\s]*$/i,
        /^\d+$/,
        /^(yes|no|да|не)[!.\s]*$/i
    ];
    if (shortChatPatterns.some(p => p.test(lowered))) return false;
    return true;
}

// ── Language detection ─────────────────────────────────────────────────────

export function detectPreferredLanguage(userMessage, history = []) {
    const toEnglishRegex = /please in english|in english|speak english|english please|на английски|говори на английски/i;
    const toBulgarianRegex = /на български|говори на български|in bulgarian|bulgarian please|speak bulgarian/i;

    const detectByAlphabet = (text) => {
        const value = String(text || '');
        const latinChars = (value.match(/[A-Za-z]/g) || []).length;
        const cyrillicChars = (value.match(/[А-Яа-яЁё]/g) || []).length;
        if (latinChars === 0 && cyrillicChars === 0) return null;
        if (latinChars >= 6 && latinChars > cyrillicChars * 2) return 'en';
        if (cyrillicChars >= 6 && cyrillicChars > latinChars * 2) return 'bg';
        const englishSignal = /\b(the|and|is|are|please|hello|wifi|password|electricity|booking|reservation|can you|i need)\b/i;
        const bulgarianSignal = /\b(и|или|има|няма|моля|здравей|парола|интернет|резервация|ток|какво|искам)\b/i;
        if (englishSignal.test(value) && !bulgarianSignal.test(value)) return 'en';
        if (bulgarianSignal.test(value) && !englishSignal.test(value)) return 'bg';
        return null;
    };

    const candidates = [
        userMessage,
        ...((Array.isArray(history) ? history : [])
            .slice().reverse()
            .filter(msg => msg && msg.role === 'user' && typeof msg.content === 'string')
            .map(msg => msg.content))
    ];

    for (const text of candidates) {
        if (!text) continue;
        if (toEnglishRegex.test(text)) return 'en';
        if (toBulgarianRegex.test(text)) return 'bg';
        const inferred = detectByAlphabet(text);
        if (inferred) return inferred;
    }

    return 'bg';
}
