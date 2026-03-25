function formatDateRange(checkIn, checkOut) {
    const ci = checkIn ? new Date(checkIn) : null;
    const co = checkOut ? new Date(checkOut) : null;
    if (!ci || !co || Number.isNaN(ci.getTime()) || Number.isNaN(co.getTime())) {
        return '—';
    }
    return `${ci.toLocaleString('bg-BG')} → ${co.toLocaleString('bg-BG')}`;
}

function formatDateOnly(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString('bg-BG');
}

export function formatNotification(eventType, payload = {}) {
    const requestCode = payload.request_code || payload.reservation_code || '—';
    const guestName = payload.guest_name || 'Гост';
    const period = formatDateRange(payload.check_in, payload.check_out);
    const totalPrice = payload.quoted_total != null ? `${Number(payload.quoted_total).toFixed(2)} BGN` : '—';

    if (eventType === 'request_created') {
        return {
            subject: `Нова заявка ${requestCode}`,
            text: `Нова заявка за Aspen Valley\nКод: ${requestCode}\nГост: ${guestName}\nПериод: ${period}\nЦена: ${totalPrice}`,
            html: `<h3>Нова заявка за Aspen Valley</h3><p><b>Код:</b> ${requestCode}<br/><b>Гост:</b> ${guestName}<br/><b>Период:</b> ${period}<br/><b>Цена:</b> ${totalPrice}</p>`
        };
    }

    if (eventType === 'request_paid') {
        const checkInDate = formatDateOnly(payload.check_in);
        const checkOutDate = formatDateOnly(payload.check_out);
        const guestsCount = payload.guests_count ?? '—';
        const confirmationCode = payload.reservation_code || payload.request_code || '—';

        const confirmationText = `Уважаеми ${guestName},\nУведомяваме Ви, че резервация е потвърдена за времето от 14:00 часа на ${checkInDate} до 12:00 часа на ${checkOutDate} включително. Гости ${guestsCount} бр.\nКод за потвърждение ${confirmationCode}\nВ деня за настаняване ще получите код за бравата.\nИко AI`;

        return {
            subject: `Потвърдена резервация за Aspen Valley – ${confirmationCode}`,
            text: confirmationText,
            html: `<p>Уважаеми ${guestName},</p><p>Уведомяваме Ви, че резервация е потвърдена за времето от 14:00 часа на ${checkInDate} до 12:00 часа на ${checkOutDate} включително. Гости ${guestsCount} бр.</p><p><b>Код за потвърждение ${confirmationCode}</b></p><p>В деня за настаняване ще получите код за бравата.</p><p>Ико AI</p>`
        };
    }

    if (eventType === 'request_approved') {
        const checkInDate = formatDateOnly(payload.check_in);
        const checkOutDate = formatDateOnly(payload.check_out);
        const guestsCount = payload.guests_count ?? '—';
        const amount = payload.quoted_total != null ? `${Number(payload.quoted_total).toFixed(2)} BGN` : '—';
        const approvedCode = payload.request_code || '—';

        const approvalText = `Уважаеми ${guestName},\nУведомяваме Ви, че заявката с код ${approvedCode} е одобрена за времето от 14:00 часа на ${checkInDate} до 12:00 часа на ${checkOutDate} включително. Гости ${guestsCount} бр.\nМоля до 24 часа да заплатите сумата ${amount} по сметка BG41STSA93000006082804 банка ДСК\nИко AI`;

        return {
            subject: `Одобрена заявка за резервация – ${approvedCode}`,
            text: approvalText,
            html: `<p>Уважаеми ${guestName},</p><p>Уведомяваме Ви, че заявката с код ${approvedCode} е одобрена за времето от 14:00 часа на ${checkInDate} до 12:00 часа на ${checkOutDate} включително. Гости ${guestsCount} бр.</p><p>Моля до 24 часа да заплатите сумата ${amount} по сметка BG41STSA93000006082804 банка ДСК</p><p>Ико AI</p>`
        };
    }

    if (eventType === 'request_cancelled') {
        return {
            subject: `Канцелирана заявка ${requestCode}`,
            text: `Заявката е канселирана\nКод: ${requestCode}\nГост: ${guestName}\nПериод: ${period}`,
            html: `<h3>Канцелирана заявка</h3><p><b>Код:</b> ${requestCode}<br/><b>Гост:</b> ${guestName}<br/><b>Период:</b> ${period}</p>`
        };
    }

    return {
        subject: `Smart Stay известие (${eventType})`,
        text: `Събитие: ${eventType}\nКод: ${requestCode}`,
        html: `<p><b>Събитие:</b> ${eventType}<br/><b>Код:</b> ${requestCode}</p>`
    };
}
