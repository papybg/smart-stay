const SOFIA_TIME_ZONE = 'Europe/Sofia';

function getTimeZoneParts(date, timeZone = SOFIA_TIME_ZONE) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });

    const parts = formatter.formatToParts(date);
    const map = {};
    for (const part of parts) {
        if (part.type !== 'literal') {
            map[part.type] = part.value;
        }
    }
    return map;
}

function getTimeZoneOffsetMinutes(date, timeZone = SOFIA_TIME_ZONE) {
    const parts = getTimeZoneParts(date, timeZone);
    const asUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
        Number(parts.second)
    );
    return Math.round((asUtc - date.getTime()) / 60000);
}

export function parseSofiaDateTime(dateLike) {
    if (dateLike == null) return null;

    const raw = String(dateLike).trim();
    if (!raw) return null;

    // Already timezone-aware.
    if (/[zZ]$/.test(raw) || /[+-]\d{2}:?\d{2}$/.test(raw)) {
        const parsed = new Date(raw);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const [datePart, timePart = '00:00:00'] = normalized.split('T');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute, second = '0'] = timePart.split(':');

    if ([year, month, day].some(Number.isNaN)) return null;

    const baseUtc = Date.UTC(
        year,
        month - 1,
        day,
        Number(hour),
        Number(minute),
        Number(second)
    );

    let utcMillis = baseUtc;
    for (let index = 0; index < 2; index++) {
        const offsetMinutes = getTimeZoneOffsetMinutes(new Date(utcMillis), SOFIA_TIME_ZONE);
        utcMillis = baseUtc - (offsetMinutes * 60 * 1000);
    }

    return new Date(utcMillis);
}
