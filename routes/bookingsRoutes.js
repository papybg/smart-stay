export function registerBookingsRoutes(app, {
    sql,
    assignPinFromDepot,
    controlPower,
    syncBookingsFromGmail
}) {
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

    app.post('/api/email/sync', async (_req, res) => {
        try {
            console.log('[DETECTIVE] 📧 Email sync стартиран');
            await syncBookingsFromGmail();
            return res.status(200).json({ success: true, message: '✅ Email sync завършен' });
        } catch (error) {
            console.error('[DETECTIVE] 🔴 Грешка при email sync:', error.message);
            return res.status(500).json({ error: error.message });
        }
    });

    app.get('/sync', async (_req, res) => {
        try {
            console.log('[DETECTIVE] 🔄 Ръчен sync стартиран от dashboard');
            await syncBookingsFromGmail();
            return res.status(200).send('✅ Sync завършен');
        } catch (error) {
            console.error('[DETECTIVE] 🔴 Грешка при ръчен sync:', error.message);
            return res.status(500).send('❌ Грешка при sync');
        }
    });
}
