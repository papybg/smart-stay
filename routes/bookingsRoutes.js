export function registerBookingsRoutes(app, {
    sql,
    assignPinFromDepot,
    controlPower,
    syncBookingsFromGmail,
    notificationService
}) {
    function toUtcDateOnly(dateLike) {
        const date = new Date(dateLike);
        return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    }

    function round2(value) {
        return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
    }

    async function getActivePricing() {
        const rows = await sql`
            SELECT night_price,
                   weekend_night_price,
                   weekly_discount_percent,
                   monthly_discount_percent,
                   pet_surcharge_once,
                   currency
            FROM "Pricing"
            WHERE is_active = TRUE
            ORDER BY updated_at DESC, id DESC
            LIMIT 1
        `;

        if (!rows.length) {
            throw new Error('Няма активна ценова конфигурация');
        }

        return rows[0];
    }

    function calculateQuote({ checkIn, checkOut, withPet, pricing }) {
        const checkInDate = toUtcDateOnly(checkIn);
        const checkOutDate = toUtcDateOnly(checkOut);
        if (checkInDate >= checkOutDate) {
            throw new Error('Невалиден период за цена');
        }

        const nightPrice = Number(pricing.night_price || 0);
        const weekendNightPrice = Number(pricing.weekend_night_price || 0);
        const weeklyDiscountPercent = Number(pricing.weekly_discount_percent || 0);
        const monthlyDiscountPercent = Number(pricing.monthly_discount_percent || 0);
        const petSurchargeOnce = Number(pricing.pet_surcharge_once || 0);

        let nights = 0;
        let baseTotal = 0;
        const cursor = new Date(checkInDate);

        while (cursor < checkOutDate) {
            const day = cursor.getUTCDay(); // 0=Sun ... 6=Sat
            const isWeekendNight = day === 5 || day === 6; // Friday/Saturday nights
            baseTotal += isWeekendNight ? weekendNightPrice : nightPrice;
            nights += 1;
            cursor.setUTCDate(cursor.getUTCDate() + 1);
        }

        const discountPercent = nights >= 30
            ? monthlyDiscountPercent
            : (nights >= 7 ? weeklyDiscountPercent : 0);

        const discountAmount = round2(baseTotal * (discountPercent / 100));
        const subtotalAfterDiscount = round2(baseTotal - discountAmount);
        const petFee = withPet ? round2(petSurchargeOnce) : 0;
        const finalTotal = round2(subtotalAfterDiscount + petFee);

        return {
            nights,
            base_total: round2(baseTotal),
            discount_percent: discountPercent,
            discount_amount: discountAmount,
            pet_fee: petFee,
            total: finalTotal,
            currency: pricing.currency || 'BGN'
        };
    }

    app.get('/api/bookings', async (req, res) => {
        try {
            if (!sql) {
                return res.status(500).json({ error: 'Database not connected' });
            }
            let query = sql`SELECT * FROM bookings`;
            const from = req.query.from;
            const to = req.query.to;
            if (from) {
                const fromDate = new Date(from);
                if (!Number.isNaN(fromDate.getTime())) {
                    query = sql`${query} WHERE check_in >= ${fromDate}`;
                }
            }
            if (to) {
                const toDate = new Date(to);
                if (!Number.isNaN(toDate.getTime())) {
                    query = sql`${query} ${from ? sql`AND` : sql`WHERE`} check_out <= ${toDate}`;
                }
            }
            query = sql`${query} ORDER BY check_in DESC LIMIT 500`;
            const bookings = await query;
            return res.json(bookings);
        } catch (error) {
            console.error('[BOOKINGS] 🔴 Грешка:', error.message);
            return res.status(500).json({ error: 'Database error' });
        }
    });

    app.get('/bookings', async (_req, res) => {
        try {
            if (!sql) {
                return res.status(500).json({ error: 'Database not connected' });
            }
            const bookings = await sql`SELECT * FROM bookings ORDER BY check_in DESC LIMIT 200`;
            return res.json(bookings);
        } catch (error) {
            console.error('[BOOKINGS:LEGACY] 🔴 Грешка:', error.message);
            return res.status(500).json({ error: 'Database error' });
        }
    });

    app.get('/api/bookings/unavailable-ranges', async (_req, res) => {
        try {
            if (!sql) {
                return res.status(500).json({ error: 'Database not connected' });
            }

            const rows = await sql`
                SELECT check_in, check_out
                FROM bookings
                WHERE COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
                ORDER BY check_in ASC
            `;

            const ranges = rows.map((row) => ({
                start: row.check_in,
                end: row.check_out
            }));

            return res.status(200).json({ success: true, ranges });
        } catch (error) {
            console.error('[BOOKINGS:UNAVAILABLE] 🔴 Грешка:', error.message);
            return res.status(500).json({ error: 'Database error' });
        }
    });

    app.post('/api/pricing/quote', async (req, res) => {
        try {
            if (!sql) {
                return res.status(500).json({ error: 'Database not connected' });
            }

            const { check_in, check_out, with_pet } = req.body || {};
            if (!check_in || !check_out) {
                return res.status(400).json({ error: 'Липсват дати за калкулация' });
            }

            const pricing = await getActivePricing();
            const quote = calculateQuote({
                checkIn: check_in,
                checkOut: check_out,
                withPet: Boolean(with_pet),
                pricing
            });

            return res.status(200).json({ success: true, quote });
        } catch (error) {
            console.error('[PRICING:QUOTE] 🔴 Грешка:', error.message);
            return res.status(400).json({ error: error.message || 'Грешка при калкулация' });
        }
    });

    app.post('/add-booking', async (req, res) => {
        try {
            if (!sql) {
                return res.status(500).json({ error: 'Database not connected' });
            }

            const { guest_name, reservation_code, check_in, check_out } = req.body || {};

            if (!guest_name || !reservation_code || !check_in || !check_out) {
                return res.status(400).json({ error: 'Липсват задължителни полета' });
            }

            const checkInDate = new Date(check_in);
            const checkOutDate = new Date(check_out);

            if (Number.isNaN(checkInDate.getTime()) || Number.isNaN(checkOutDate.getTime()) || checkInDate >= checkOutDate) {
                return res.status(400).json({ error: 'Невалидни дати за резервация' });
            }

            // проверка за дублиране на дати (с изключение на самата резервация ако кодът я съществува)
            try {
                const overlapping = await sql`
                    SELECT id
                    FROM bookings
                    WHERE reservation_code != ${reservation_code}
                      AND NOT (
                            check_out <= ${checkInDate.toISOString()} OR
                            check_in >= ${checkOutDate.toISOString()}
                          )
                    LIMIT 1
                `;
                if (overlapping.length) {
                    return res.status(409).json({ error: 'Съществува резервация със засичащ се период' });
                }
            } catch (err) {
                console.error('[BOOKINGS:CHECK] 🔴 Грешка при проверка за припокриване:', err.message);
            }

            const powerOn = new Date(checkInDate.getTime() - 2 * 60 * 60 * 1000);
            const powerOff = new Date(checkOutDate.getTime() + 1 * 60 * 60 * 1000);

            const existing = await sql`
                SELECT lock_pin FROM bookings
                WHERE reservation_code = ${reservation_code}
                LIMIT 1
            `;

            let lockPin = existing[0]?.lock_pin || null;
            const bookingId = existing[0]?.id || null;
            if (!lockPin) {
                // pass at least id or reservation_code so assignment updates row
                lockPin = await assignPinFromDepot({ id: bookingId, reservation_code, guest_name });
            }

            const result = await sql`
                INSERT INTO bookings (
                    reservation_code,
                    guest_name,
                    check_in,
                    check_out,
                    lock_pin,
                    payment_status,
                    power_on_time,
                    power_off_time,
                    source
                )
                VALUES (
                    ${reservation_code},
                    ${guest_name},
                    ${checkInDate.toISOString()},
                    ${checkOutDate.toISOString()},
                    ${lockPin},
                    'paid',
                    ${powerOn.toISOString()},
                    ${powerOff.toISOString()},
                    'manual'
                )
                ON CONFLICT (reservation_code)
                DO UPDATE SET
                    guest_name = EXCLUDED.guest_name,
                    check_in = EXCLUDED.check_in,
                    check_out = EXCLUDED.check_out,
                    power_on_time = EXCLUDED.power_on_time,
                    power_off_time = EXCLUDED.power_off_time,
                    lock_pin = COALESCE(bookings.lock_pin, EXCLUDED.lock_pin)
                RETURNING id, reservation_code, guest_name, lock_pin
            `;

            return res.status(200).json({ success: true, booking: result[0] });
        } catch (error) {
            console.error('[BOOKINGS:ADD] 🔴 Грешка:', error.message);
            return res.status(500).json({ error: 'Грешка при добавяне на резервация' });
        }
    });

    app.delete('/bookings/:id', async (req, res) => {
        try {
            if (!sql) {
                return res.status(500).json({ error: 'Database not connected' });
            }

            const bookingId = Number.parseInt(req.params.id, 10);
            if (Number.isNaN(bookingId)) {
                return res.status(400).json({ error: 'Невалидно ID' });
            }

            const deleted = await sql`
                DELETE FROM bookings
                WHERE id = ${bookingId}
                RETURNING id
            `;

            if (deleted.length === 0) {
                return res.status(404).json({ error: 'Резервацията не е намерена' });
            }

            return res.status(200).json({ success: true, deletedId: bookingId });
        } catch (error) {
            console.error('[BOOKINGS:DELETE] 🔴 Грешка:', error.message);
            return res.status(500).json({ error: 'Грешка при изтриване на резервация' });
        }
    });

    async function runReservationsSync() {
        if (!sql) {
            return { checkinCount: 0, checkoutCount: 0, dbAvailable: false };
        }

        const now = new Date();
        const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
        const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000);

        const checkinBookings = await sql`
            SELECT id, guest_name FROM bookings
            WHERE check_in <= ${twoHoursFromNow} AND check_in >= ${now} AND check_out > ${now}
            LIMIT 10
        `;

        for (const booking of checkinBookings) {
            if (!global.powerState.is_on) {
                console.log(`[SCHEDULER] 🚨 CHECK-IN за ${booking.guest_name} - ВКЛ`);
                try {
                    await sql`
                        INSERT INTO power_history (is_on, timestamp, source, booking_id)
                        VALUES (true, ${now}, 'scheduler_checkin', ${String(booking.id)})
                    `;
                } catch (dbErr) {
                    console.error('[DB] 🔴 Грешка при запис scheduler check-in:', dbErr.message);
                }

                global.powerState.is_on = true;
                global.powerState.source = 'scheduler-checkin';
                global.powerState.last_update = now;

                try {
                    await sql`
                        UPDATE bookings
                        SET power_status = 'on', power_status_updated_at = ${now}
                        WHERE id = ${booking.id}
                    `;
                } catch (bookingErr) {
                    console.error('[DB] 🔴 Грешка при scheduler check-in power_status:', bookingErr.message);
                }

                await controlPower(true);
            }
        }

        const checkoutBookings = await sql`
            SELECT id, guest_name FROM bookings
            WHERE check_out <= ${now} AND check_out >= ${oneHourAgo}
            LIMIT 10
        `;

        for (const booking of checkoutBookings) {
            if (global.powerState.is_on) {
                console.log(`[SCHEDULER] 🚨 CHECK-OUT ${booking.guest_name} - ИЗКЛ`);
                try {
                    await sql`
                        INSERT INTO power_history (is_on, timestamp, source, booking_id)
                        VALUES (false, ${now}, 'scheduler_checkout', ${String(booking.id)})
                    `;
                } catch (dbErr) {
                    console.error('[DB] 🔴 Грешка при запис scheduler check-out:', dbErr.message);
                }

                global.powerState.is_on = false;
                global.powerState.source = 'scheduler-checkout';
                global.powerState.last_update = now;

                try {
                    await sql`
                        UPDATE bookings
                        SET power_status = 'off', power_status_updated_at = ${now}
                        WHERE id = ${booking.id}
                    `;
                } catch (bookingErr) {
                    console.error('[DB] 🔴 Грешка при scheduler check-out power_status:', bookingErr.message);
                }

                await controlPower(false);
            }
        }

        return {
            checkinCount: checkinBookings.length,
            checkoutCount: checkoutBookings.length,
            dbAvailable: true
        };
    }

    app.post('/api/reservations/sync', async (_req, res) => {
        try {
            if (!sql) {
                return res.status(503).json({ error: 'Database not connected' });
            }
            console.log(`[SCHEDULER] ⏰ ${new Date().toISOString()} - Reservations sync`);
            const result = await runReservationsSync();
            return res.status(200).json({ success: true, ...result });
        } catch (error) {
            console.error('[SCHEDULER] 🔴 Грешка:', error.message);
            return res.status(500).json({ error: error.message });
        }
    });

    async function handleGmailSync(_req, res) {
        try {
            console.log('[DETECTIVE] 📧 Email sync стартиран');
            await syncBookingsFromGmail();
            return res.status(200).json({ success: true, message: '✅ Email sync завършен' });
        } catch (error) {
            console.error('[DETECTIVE] 🔴 Грешка при email sync:', error.message);
            return res.status(500).json({ error: error.message });
        }
    }

    app.post('/api/gmail/sync', handleGmailSync);
    app.post('/api/email/sync', handleGmailSync);

    // public inquiry form for website
    app.post('/api/inquiry', async (req, res) => {
        try {
            if (!sql) {
                console.error('[INQUIRY] 🔴 Database connection is not available');
                return res.status(500).json({ error: 'Database connection is not available' });
            }

            const { guest_name, guest_email, guest_phone, guest_telegram_chat_id, check_in, check_out, guests_count, message, with_pet } = req.body || {};
            if (!guest_name || !guest_email || !check_in || !check_out) {
                return res.status(400).json({ error: 'Липсват задължителни полета' });
            }

            const checkInDate = new Date(check_in);
            const checkOutDate = new Date(check_out);
            if (Number.isNaN(checkInDate.getTime()) || Number.isNaN(checkOutDate.getTime())) {
                return res.status(400).json({ error: 'Невалидни дати за настаняване/напускане' });
            }
            if (checkInDate >= checkOutDate) {
                return res.status(400).json({ error: 'Датата на напускане трябва да е след датата на настаняване' });
            }

            const overlapping = await sql`
                SELECT id
                FROM bookings
                WHERE COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
                  AND NOT (
                        check_out <= ${checkInDate.toISOString()} OR
                        check_in >= ${checkOutDate.toISOString()}
                      )
                LIMIT 1
            `;
            if (overlapping.length) {
                return res.status(409).json({ error: 'Избраните дати не са налични' });
            }

            const pricing = await getActivePricing();
            const quote = calculateQuote({
                checkIn: checkInDate,
                checkOut: checkOutDate,
                withPet: Boolean(with_pet),
                pricing
            });

            const requestCode = 'REQ' + Date.now().toString(36).toUpperCase();

            const inserted = await sql`
                INSERT INTO "Requests" (
                    request_code,
                    guest_name,
                    guest_email,
                    guest_phone,
                    guest_telegram_chat_id,
                    check_in,
                    check_out,
                    guests_count,
                    with_pet,
                    quoted_total,
                    message,
                    status,
                    payment_status,
                    source,
                    updated_at
                ) VALUES (
                    ${requestCode},
                    ${guest_name},
                    ${guest_email},
                    ${guest_phone || null},
                    ${guest_telegram_chat_id || null},
                    ${checkInDate.toISOString()},
                    ${checkOutDate.toISOString()},
                    ${Number.isInteger(Number(guests_count)) ? Number(guests_count) : null},
                    ${Boolean(with_pet)},
                    ${quote.total},
                    ${message || null},
                    'pending',
                    'pending',
                    'direct',
                    NOW()
                )
                RETURNING id, request_code, status, payment_status
            `;

            try {
                await notificationService?.emit('request_created', {
                    request_id: inserted[0].id,
                    request_code: inserted[0].request_code,
                    guest_name,
                    guest_email,
                    guest_telegram_chat_id: guest_telegram_chat_id || null,
                    check_in: checkInDate.toISOString(),
                    check_out: checkOutDate.toISOString(),
                    quoted_total: quote.total
                });
            } catch (notifyError) {
                console.error('[NOTIFY:REQUEST_CREATED] 🔴', notifyError.message);
            }

            return res.status(200).json({
                success: true,
                request_id: inserted[0].id,
                request_code: inserted[0].request_code,
                status: inserted[0].status,
                payment_status: inserted[0].payment_status,
                quote,
                reservation_code: inserted[0].request_code
            });
        } catch (error) {
            console.error('[INQUIRY] 🔴 Грешка:', error);
            const safe = error?.message || 'Unexpected error';
            return res.status(500).json({ error: safe });
        }
    });

    app.get('/api/requests', async (_req, res) => {
        try {
            if (!sql) {
                return res.status(500).json({ error: 'Database connection is not available' });
            }

            const rows = await sql`
                    SELECT id, request_code, guest_name, guest_email, guest_phone, guest_telegram_chat_id,
                      check_in, check_out, guests_count, with_pet, quoted_total, message,
                       status, payment_status, converted_booking_id,
                       payment_received_at, created_at, updated_at
                FROM "Requests"
                ORDER BY created_at DESC
                LIMIT 300
            `;

            return res.status(200).json(rows);
        } catch (error) {
            console.error('[REQUESTS] 🔴 Грешка:', error.message);
            return res.status(500).json({ error: 'Грешка при четене на заявки' });
        }
    });

    app.post('/api/requests/:id/approve', async (req, res) => {
        try {
            if (!sql) {
                return res.status(500).json({ error: 'Database connection is not available' });
            }

            const requestId = Number.parseInt(req.params.id, 10);
            if (Number.isNaN(requestId)) {
                return res.status(400).json({ error: 'Невалидно request ID' });
            }

            const rows = await sql`
                UPDATE "Requests"
                SET status = 'approved',
                    updated_at = NOW()
                WHERE id = ${requestId}
                  AND status = 'pending'
                  AND converted_booking_id IS NULL
                RETURNING id, request_code, guest_name, guest_email, guest_telegram_chat_id, check_in, check_out, guests_count, quoted_total, status, payment_status
            `;

            if (!rows.length) {
                return res.status(404).json({ error: 'Заявката не е намерена, не е pending или вече е конвертирана' });
            }

            try {
                await notificationService?.emit('request_approved', {
                    request_id: rows[0].id,
                    request_code: rows[0].request_code,
                    guest_name: rows[0].guest_name,
                    guest_email: rows[0].guest_email,
                    guest_telegram_chat_id: rows[0].guest_telegram_chat_id,
                    check_in: rows[0].check_in,
                    check_out: rows[0].check_out,
                    guests_count: rows[0].guests_count,
                    quoted_total: rows[0].quoted_total
                });
            } catch (notifyError) {
                console.error('[NOTIFY:REQUEST_APPROVED] 🔴', notifyError.message);
            }

            return res.status(200).json({ success: true, request: rows[0] });
        } catch (error) {
            console.error('[REQUESTS:APPROVE] 🔴 Грешка:', error);
            return res.status(500).json({ error: error?.message || 'Грешка при одобряване на заявка' });
        }
    });

    app.post('/api/requests/:id/mark-paid', async (req, res) => {
        try {
            if (!sql) {
                return res.status(500).json({ error: 'Database connection is not available' });
            }

            const requestId = Number.parseInt(req.params.id, 10);
            if (Number.isNaN(requestId)) {
                return res.status(400).json({ error: 'Невалидно request ID' });
            }

            const incomingPaymentDate = req.body?.payment_date || null;
            const paymentReceivedAt = incomingPaymentDate ? new Date(incomingPaymentDate) : new Date();
            if (Number.isNaN(paymentReceivedAt.getTime())) {
                return res.status(400).json({ error: 'Невалидна дата на плащане' });
            }

            const requestRows = await sql`
                SELECT *
                FROM "Requests"
                WHERE id = ${requestId}
                LIMIT 1
            `;

            if (!requestRows.length) {
                return res.status(404).json({ error: 'Заявката не е намерена' });
            }

            const request = requestRows[0];
            if (request.converted_booking_id) {
                return res.status(200).json({
                    success: true,
                    message: 'Заявката вече е конвертирана в резервация',
                    booking_id: request.converted_booking_id
                });
            }

            if (String(request.status || '').toLowerCase() !== 'approved') {
                return res.status(409).json({ error: 'Заявката трябва първо да бъде одобрена' });
            }

            const checkInDate = new Date(request.check_in);
            const checkOutDate = new Date(request.check_out);

            const overlapping = await sql`
                SELECT id
                FROM bookings
                WHERE COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
                  AND NOT (
                        check_out <= ${checkInDate.toISOString()} OR
                        check_in >= ${checkOutDate.toISOString()}
                      )
                LIMIT 1
            `;
            if (overlapping.length) {
                return res.status(409).json({ error: 'Периодът вече е зает от друга резервация' });
            }

            await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_email VARCHAR(255)`;
            await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_phone VARCHAR(50)`;
            await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guests_count INT`;
            await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS notes TEXT`;

            const reservationCode = 'HM' + Date.now().toString(36).toUpperCase();
            const powerOn = new Date(checkInDate.getTime() - 2 * 60 * 60 * 1000);
            const powerOff = new Date(checkOutDate.getTime() + 1 * 60 * 60 * 1000);

            const lockPin = await assignPinFromDepot({
                reservation_code: reservationCode,
                guest_name: request.guest_name
            });

            const bookingRows = await sql`
                INSERT INTO bookings (
                    reservation_code,
                    guest_name,
                    guest_email,
                    guest_phone,
                    check_in,
                    check_out,
                    guests_count,
                    lock_pin,
                    payment_status,
                    total_price,
                    power_on_time,
                    power_off_time,
                    source,
                    notes
                ) VALUES (
                    ${reservationCode},
                    ${request.guest_name},
                    ${request.guest_email},
                    ${request.guest_phone || null},
                    ${checkInDate.toISOString()},
                    ${checkOutDate.toISOString()},
                    ${request.guests_count || null},
                    ${lockPin || null},
                    'paid',
                    ${request.quoted_total || null},
                    ${powerOn.toISOString()},
                    ${powerOff.toISOString()},
                    'direct',
                    ${request.message || null}
                )
                RETURNING id, reservation_code, guest_name, check_in, check_out, payment_status, total_price
            `;

            const booking = bookingRows[0];

            await sql`
                UPDATE "Requests"
                SET payment_status = 'paid',
                    status = 'confirmed',
                    payment_received_at = ${paymentReceivedAt.toISOString()},
                    converted_booking_id = ${booking.id},
                    converted_at = NOW(),
                    updated_at = NOW()
                WHERE id = ${requestId}
            `;

            try {
                await notificationService?.emit('request_paid', {
                    request_id: requestId,
                    request_code: request.request_code,
                    guest_name: request.guest_name,
                    guest_email: request.guest_email,
                    guest_telegram_chat_id: request.guest_telegram_chat_id,
                    check_in: request.check_in,
                    check_out: request.check_out,
                    guests_count: request.guests_count,
                    quoted_total: request.quoted_total,
                    payment_received_at: paymentReceivedAt.toISOString(),
                    booking_id: booking.id,
                    reservation_code: booking.reservation_code
                });
            } catch (notifyError) {
                console.error('[NOTIFY:REQUEST_PAID] 🔴', notifyError.message);
            }

            return res.status(200).json({
                success: true,
                request_id: requestId,
                booking
            });
        } catch (error) {
            console.error('[REQUESTS:MARK-PAID] 🔴 Грешка:', error);
            return res.status(500).json({ error: error?.message || 'Грешка при конвертиране на заявка' });
        }
    });

    app.post('/api/requests/:id/cancel', async (req, res) => {
        try {
            if (!sql) {
                return res.status(500).json({ error: 'Database connection is not available' });
            }

            const requestId = Number.parseInt(req.params.id, 10);
            if (Number.isNaN(requestId)) {
                return res.status(400).json({ error: 'Невалидно request ID' });
            }

            const rows = await sql`
                UPDATE "Requests"
                SET status = 'cancelled',
                    payment_status = 'cancelled',
                    updated_at = NOW()
                WHERE id = ${requestId}
                  AND converted_booking_id IS NULL
                RETURNING id, request_code, guest_name, guest_email, guest_telegram_chat_id, check_in, check_out, quoted_total, status, payment_status
            `;

            if (!rows.length) {
                return res.status(404).json({ error: 'Заявката не е намерена или вече е конвертирана' });
            }

            try {
                await notificationService?.emit('request_cancelled', {
                    request_id: rows[0].id,
                    request_code: rows[0].request_code,
                    guest_name: rows[0].guest_name,
                    guest_email: rows[0].guest_email,
                    guest_telegram_chat_id: rows[0].guest_telegram_chat_id,
                    check_in: rows[0].check_in,
                    check_out: rows[0].check_out,
                    quoted_total: rows[0].quoted_total
                });
            } catch (notifyError) {
                console.error('[NOTIFY:REQUEST_CANCELLED] 🔴', notifyError.message);
            }

            return res.status(200).json({ success: true, request: rows[0] });
        } catch (error) {
            console.error('[REQUESTS:CANCEL] 🔴 Грешка:', error);
            return res.status(500).json({ error: error?.message || 'Грешка при отказване на заявка' });
        }
    });

}
