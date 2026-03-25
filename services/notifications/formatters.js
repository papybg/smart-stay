function formatDateRange(checkIn, checkOut) {
    const ci = checkIn ? new Date(checkIn) : null;
    const co = checkOut ? new Date(checkOut) : null;
    if (!ci || !co || Number.isNaN(ci.getTime()) || Number.isNaN(co.getTime())) {
        return '—';
    }
    return `${ci.toLocaleString('bg-BG')} → ${co.toLocaleString('bg-BG')}`;
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
        return {
            subject: `Платена заявка ${requestCode}`,
            text: `Заявката е маркирана като платена\nКод: ${requestCode}\nГост: ${guestName}\nПериод: ${period}\nЦена: ${totalPrice}`,
            html: `<h3>Платена заявка</h3><p><b>Код:</b> ${requestCode}<br/><b>Гост:</b> ${guestName}<br/><b>Период:</b> ${period}<br/><b>Цена:</b> ${totalPrice}</p>`
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
