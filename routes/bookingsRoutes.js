import nodemailer from 'nodemailer';

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

    app.post('/api/test/airbnb-send-email', async (req, res) => {
        try {
            if (!sql) {
                return res.status(500).json({ error: 'Database connection is not available' });
            }

            const smtpHost = String(process.env.SMTP_HOST || '').trim();
            const smtpPort = Number(process.env.SMTP_PORT || 587);
            const smtpUser = String(process.env.SMTP_USER || '').trim();
            const smtpPass = String(process.env.SMTP_PASS || '').trim();
            const fromEmail = String(process.env.SMTP_FROM || smtpUser).trim();

            if (!smtpHost || !smtpUser || !smtpPass) {
                return res.status(500).json({ error: 'SMTP не е конфигуриран (SMTP_HOST/SMTP_USER/SMTP_PASS)' });
            }

            const testRecipient = String(req.body?.to || smtpUser).trim();
            const guestName = String(req.body?.guest_name || 'Test').trim();
            const now = new Date();
            const checkIn = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);
            checkIn.setHours(14, 0, 0, 0);
            const checkOut = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
            checkOut.setHours(12, 0, 0, 0);
            const reservationCode = String(req.body?.reservation_code || `HMTST${Date.now().toString(36).toUpperCase()}`).trim();
            const runTag = Date.now().toString(36).toUpperCase();

            const pinCode = `TST${Math.floor(100000 + Math.random() * 900000)}`;
            await sql`
                INSERT INTO pin_depot (pin_code, pin_name, is_used)
                VALUES (${pinCode}, ${`TEST:EMAIL:${runTag}`}, FALSE)
                ON CONFLICT (pin_code) DO NOTHING
            `;

            const dayMonth = (d) => `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
            const subject = `Новата резервация е потвърдена! ${guestName} пристига на ${dayMonth(checkIn)}.`;

            const body = [
                `Новата резервация е потвърдена! ${guestName} пристига на ${dayMonth(checkIn)}.`,
                '',
                `Изпратете съобщение, за да потвърдите данните за настаняване или да приветствате ${guestName}.`,
                '',
                `${guestName} Test`,
                'Самоличността е потвърдена · 13 отзива',
                'Bottrop, Германия',
                '',
                'Aspen Valley Retreat: Уют, СПА, басейн край Разлог',
                'Целият дом/апартамент',
                '',
                'Настаняване',
                dayMonth(checkIn),
                '14:00',
                '',
                'Освобождаване',
                dayMonth(checkOut),
                '12:00',
                '',
                'Гости',
                '2 възрастни (над 12 г.), 2 деца, 1 домашен любимец',
                '',
                'Код за потвърждение',
                reservationCode,
                '',
                'Гостът е заплатил',
                'Настаняване',
                '€ 218,00',
                '',
                'Такса за услугата за гости',
                '€ 36,63',
                '',
                'Общо (EUR)',
                '€ 254,63'
            ].join('\n');

            const transporter = nodemailer.createTransport({
                host: smtpHost,
                port: smtpPort,
                secure: smtpPort === 465,
                auth: {
                    user: smtpUser,
                    pass: smtpPass
                }
            });

            const sendResult = await transporter.sendMail({
                from: fromEmail,
                to: testRecipient,
                subject,
                text: body
            });

            let syncTriggered = false;
            if (typeof syncBookingsFromGmail === 'function') {
                syncTriggered = true;
                // изчакване за Gmail ingestion и 2 опита за sync
                await new Promise(resolve => setTimeout(resolve, 4000));
                await syncBookingsFromGmail();
                await new Promise(resolve => setTimeout(resolve, 3000));
                await syncBookingsFromGmail();
            }

            const rows = await sql`
                SELECT id, reservation_code, guest_name, check_in, check_out, power_on_time, power_off_time, source, payment_status, lock_pin
                FROM bookings
                WHERE reservation_code = ${reservationCode}
                LIMIT 1
            `;

            const booking = rows[0] || null;
            const powerOnDeltaHours = booking ? Math.round((new Date(booking.check_in).getTime() - new Date(booking.power_on_time).getTime()) / (60 * 60 * 1000)) : null;
            const powerOffDeltaHours = booking ? Math.round((new Date(booking.power_off_time).getTime() - new Date(booking.check_out).getTime()) / (60 * 60 * 1000)) : null;

            return res.status(200).json({
                success: true,
                reservation_code: reservationCode,
                email: {
                    from: fromEmail,
                    to: testRecipient,
                    messageId: sendResult?.messageId || null
                },
                syncTriggered,
                bookingFound: Boolean(booking),
                booking,
                validations: {
                    hasLockPin: Boolean(booking?.lock_pin),
                    sourceIsAirbnb: booking?.source === 'airbnb',
                    paymentIsPaid: String(booking?.payment_status || '').toLowerCase() === 'paid',
                    powerOnDeltaHours,
                    powerOffDeltaHours,
                    powerScheduleValid: powerOnDeltaHours === 2 && powerOffDeltaHours === 1
                }
            });
        } catch (error) {
            console.error('[TEST:AIRBNB_EMAIL] 🔴 Грешка:', error);
            return res.status(500).json({ error: error?.message || 'Грешка при реален Airbnb email тест' });
        }
    });

    app.post('/api/test/airbnb-simulate', async (req, res) => {
        try {
            if (!sql) {
                return res.status(500).json({ error: 'Database connection is not available' });
            }

            const status = String(req.body?.status || 'confirmed').trim().toLowerCase();
            const reservationCode = String(req.body?.reservation_code || `TST-ABNB-${Date.now().toString(36).toUpperCase()}`).trim();
            const guestName = String(req.body?.guest_name || `Test User Airbnb ${Date.now().toString(36).toUpperCase()}`).trim();
            const checkInRaw = req.body?.check_in;
            const checkOutRaw = req.body?.check_out;

            if (!reservationCode) {
                return res.status(400).json({ error: 'Липсва reservation_code' });
            }

            if (status === 'cancelled') {
                const cancelled = await sql`
                    UPDATE bookings
                    SET payment_status = 'cancelled',
                        lock_pin = NULL,
                        power_on_time = NULL,
                        power_off_time = NULL,
                        updated_at = NOW()
                    WHERE reservation_code = ${reservationCode}
                    RETURNING id, reservation_code, payment_status
                `;

                return res.status(200).json({
                    success: true,
                    mode: 'airbnb_simulated',
                    status: 'cancelled',
                    affected: cancelled.length,
                    booking: cancelled[0] || null
                });
            }

            const checkInDate = new Date(checkInRaw);
            const checkOutDate = new Date(checkOutRaw);
            if (Number.isNaN(checkInDate.getTime()) || Number.isNaN(checkOutDate.getTime()) || checkInDate >= checkOutDate) {
                return res.status(400).json({ error: 'Невалидни check_in/check_out за симулация' });
            }

            const powerOn = new Date(checkInDate.getTime() - 2 * 60 * 60 * 1000);
            const powerOff = new Date(checkOutDate.getTime() + 1 * 60 * 60 * 1000);

            const existingRows = await sql`
                SELECT id, lock_pin
                FROM bookings
                WHERE reservation_code = ${reservationCode}
                LIMIT 1
            `;

            const existing = existingRows[0] || null;
            let lockPin = existing?.lock_pin || null;
            if (!lockPin) {
                lockPin = await assignPinFromDepot({
                    id: existing?.id,
                    reservation_code: reservationCode,
                    guest_name: guestName
                });
            }

            const upserted = await sql`
                INSERT INTO bookings (
                    reservation_code,
                    guest_name,
                    check_in,
                    check_out,
                    power_on_time,
                    power_off_time,
                    source,
                    payment_status,
                    lock_pin
                )
                VALUES (
                    ${reservationCode},
                    ${guestName},
                    ${checkInDate.toISOString()},
                    ${checkOutDate.toISOString()},
                    ${powerOn.toISOString()},
                    ${powerOff.toISOString()},
                    'airbnb',
                    'paid',
                    ${lockPin}
                )
                ON CONFLICT (reservation_code)
                DO UPDATE SET
                    guest_name = EXCLUDED.guest_name,
                    check_in = EXCLUDED.check_in,
                    check_out = EXCLUDED.check_out,
                    power_on_time = EXCLUDED.power_on_time,
                    power_off_time = EXCLUDED.power_off_time,
                    payment_status = 'paid',
                    source = 'airbnb',
                    lock_pin = COALESCE(bookings.lock_pin, EXCLUDED.lock_pin)
                RETURNING id, reservation_code, guest_name, check_in, check_out, power_on_time, power_off_time, source, payment_status, lock_pin
            `;

            return res.status(200).json({
                success: true,
                mode: 'airbnb_simulated',
                status: 'confirmed',
                booking: upserted[0]
            });
        } catch (error) {
            console.error('[TEST:AIRBNB_SIM] 🔴 Грешка:', error);
            return res.status(500).json({ error: error?.message || 'Грешка при Airbnb симулация' });
        }
    });

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
                return res.status(409).json({ error: 'Някоя от датите е вече заета (check_in/check_out overlap). Проверете текущите резервации.' });
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

    app.delete('/api/requests/:id', async (req, res) => {
        try {
            if (!sql) {
                return res.status(500).json({ error: 'Database connection is not available' });
            }

            const requestId = Number.parseInt(req.params.id, 10);
            if (Number.isNaN(requestId)) {
                return res.status(400).json({ error: 'Невалидно request ID' });
            }

            const requestRows = await sql`
                SELECT id, converted_booking_id
                FROM "Requests"
                WHERE id = ${requestId}
            `;

            if (!requestRows.length) {
                return res.status(404).json({ error: 'Заявката не е намерена' });
            }

            const convertedBookingId = requestRows[0].converted_booking_id;
            let deletedBookingId = null;

            if (convertedBookingId) {
                const deleted = await sql`
                    DELETE FROM bookings
                    WHERE id = ${convertedBookingId}
                    RETURNING id
                `;
                if (deleted.length > 0) {
                    deletedBookingId = deleted[0].id;
                }
            }

            const deletedRequest = await sql`
                DELETE FROM "Requests"
                WHERE id = ${requestId}
                RETURNING id
            `;

            if (!deletedRequest.length) {
                return res.status(404).json({ error: 'Заявката не е намерена при изтриване' });
            }

            return res.status(200).json({
                success: true,
                deletedRequestId: requestId,
                deletedBookingId
            });
        } catch (error) {
            console.error('[REQUESTS:DELETE] 🔴 Грешка:', error);
            return res.status(500).json({ error: error?.message || 'Грешка при изтриване на заявка' });
        }
    });

    app.delete('/api/test-data', async (_req, res) => {
        try {
            if (!sql) {
                return res.status(500).json({ error: 'Database connection is not available' });
            }

            const deletedBookingsFromRequests = await sql`
                DELETE FROM bookings
                WHERE id IN (
                    SELECT converted_booking_id
                    FROM "Requests"
                    WHERE converted_booking_id IS NOT NULL
                      AND (
                        guest_name ILIKE 'Test User%'
                        OR guest_email = 'test@example.com'
                        OR message ILIKE 'Test inquiry from UI%'
                      )
                )
                RETURNING id
            `;

            const deletedRequests = await sql`
                DELETE FROM "Requests"
                WHERE guest_name ILIKE 'Test User%'
                   OR guest_email = 'test@example.com'
                   OR message ILIKE 'Test inquiry from UI%'
                RETURNING id
            `;

            const deletedOrphanBookings = await sql`
                DELETE FROM bookings
                WHERE (
                    guest_name ILIKE 'Test User%'
                    OR reservation_code ILIKE 'TST-%'
                    OR source = 'test'
                    OR message ILIKE 'Test inquiry from UI%'
                )
                RETURNING id
            `;

            const deletedTestPins = await sql`
                DELETE FROM pin_depot
                WHERE pin_name ILIKE 'TEST:%'
                   OR pin_code ILIKE 'TST%'
                RETURNING id
            `;

            return res.status(200).json({
                success: true,
                deletedRequestsCount: deletedRequests.length,
                deletedBookingsFromRequestsCount: deletedBookingsFromRequests.length,
                deletedOrphanBookingsCount: deletedOrphanBookings.length,
                deletedTestPinsCount: deletedTestPins.length
            });
        } catch (error) {
            console.error('[TEST-DATA:DELETE] 🔴 Грешка:', error);
            return res.status(500).json({ error: error?.message || 'Грешка при изтриване на тестови данни' });
        }
    });

}
