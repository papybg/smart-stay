export function registerAdminRoutes(app, { sql }) {
    app.get('/api/pins', async (_req, res) => {
        try {
            if (!sql) return res.status(500).json({ error: 'Database not connected' });
            const rows = await sql`
                SELECT id, pin_code, pin_name, is_used, assigned_at, created_at
                FROM pin_depot
                ORDER BY id ASC
            `;
            return res.json(rows);
        } catch (error) {
            console.error('[PINS] 🔴 Грешка при четене:', error.message);
            return res.status(500).json({ error: 'Грешка при четене на PIN списъка' });
        }
    });

    app.post('/api/pins', async (req, res) => {
        try {
            if (!sql) return res.status(500).json({ error: 'Database not connected' });
            const { pin_code, pin_name } = req.body || {};
            if (!pin_code || !String(pin_code).trim()) {
                return res.status(400).json({ error: 'Липсва pin_code' });
            }

            const result = await sql`
                INSERT INTO pin_depot (pin_code, pin_name, is_used)
                VALUES (${String(pin_code).trim()}, ${pin_name ? String(pin_name).trim() : null}, FALSE)
                ON CONFLICT (pin_code) DO NOTHING
                RETURNING id, pin_code, pin_name, is_used
            `;

            if (result.length === 0) {
                return res.status(409).json({ error: 'Този PIN вече съществува' });
            }
            return res.status(201).json(result[0]);
        } catch (error) {
            console.error('[PINS] 🔴 Грешка при добавяне:', error.message);
            return res.status(500).json({ error: 'Грешка при добавяне на PIN' });
        }
    });

    app.delete('/api/pins/:id', async (req, res) => {
        try {
            if (!sql) return res.status(500).json({ error: 'Database not connected' });
            const pinId = Number.parseInt(req.params.id, 10);
            if (Number.isNaN(pinId)) return res.status(400).json({ error: 'Невалидно ID' });

            const deleted = await sql`DELETE FROM pin_depot WHERE id = ${pinId} RETURNING id`;
            if (deleted.length === 0) return res.status(404).json({ error: 'PIN не е намерен' });
            return res.json({ success: true, deletedId: pinId });
        } catch (error) {
            console.error('[PINS] 🔴 Грешка при изтриване:', error.message);
            return res.status(500).json({ error: 'Грешка при изтриване на PIN' });
        }
    });

    app.get('/calendar.ics', async (_req, res) => {
        try {
            if (!sql) return res.status(500).send('Database not connected');

            const rows = await sql`
                SELECT reservation_code, check_in, check_out, payment_status
                FROM bookings
                WHERE COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
                ORDER BY check_in ASC
                LIMIT 500
            `;

            const toIcsDate = (value) => {
                const d = new Date(value);
                const pad = (n) => String(n).padStart(2, '0');
                return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
            };

            const events = rows.map((row) => {
                const uid = `${row.reservation_code || 'booking'}-${toIcsDate(row.check_in)}@smart-stay`;
                return [
                    'BEGIN:VEVENT',
                    `UID:${uid}`,
                    `DTSTAMP:${toIcsDate(new Date())}`,
                    `DTSTART:${toIcsDate(row.check_in)}`,
                    `DTEND:${toIcsDate(row.check_out)}`,
                    'SUMMARY:Smart Stay Booking',
                    `DESCRIPTION:Reservation ${row.reservation_code || 'N/A'}`,
                    'END:VEVENT'
                ].join('\r\n');
            }).join('\r\n');

            const ics = [
                'BEGIN:VCALENDAR',
                'VERSION:2.0',
                'PRODID:-//Smart Stay//Bookings Calendar//BG',
                'CALSCALE:GREGORIAN',
                events,
                'END:VCALENDAR'
            ].join('\r\n');

            res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
            return res.send(ics);
        } catch (error) {
            console.error('[CALENDAR] 🔴 Грешка:', error.message);
            return res.status(500).send('Calendar generation error');
        }
    });
}
