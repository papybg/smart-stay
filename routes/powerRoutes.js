function normalizePowerState(value) {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		if (value === 1) return true;
		if (value === 0) return false;
		return null;
	}
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		if (['on', 'true', '1', 'вкл', 'включен', 'active'].includes(normalized)) return true;
		if (['off', 'false', '0', 'изкл', 'изключен', 'inactive'].includes(normalized)) return false;
	}
	return null;
}

function createPowerTraceId() {
	return `pwr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getPowerTraceStore() {
	if (!global.__powerTraceStore) {
		global.__powerTraceStore = {
			maxEvents: Number(process.env.POWER_TRACE_MAX_EVENTS || 800),
			events: [],
			lastTraceId: null
		};
	}

	if (!Number.isFinite(global.__powerTraceStore.maxEvents) || global.__powerTraceStore.maxEvents < 100) {
		global.__powerTraceStore.maxEvents = 800;
	}

	return global.__powerTraceStore;
}

function recordPowerTrace(level, traceId, stage, message, payload = null, channel = 'route') {
	const store = getPowerTraceStore();
	const event = {
		ts: new Date().toISOString(),
		traceId,
		channel,
		level,
		stage,
		message,
		payload: payload && typeof payload === 'object' ? payload : null
	};

	store.lastTraceId = traceId || store.lastTraceId;
	store.events.push(event);
	if (store.events.length > store.maxEvents) {
		store.events.splice(0, store.events.length - store.maxEvents);
	}

	const line = `[POWER_FLOW:${traceId}] ${stage} ${message}`;
	if (level === 'error') {
		if (event.payload) console.error(line, event.payload);
		else console.error(line);
		return;
	}
	if (level === 'warn') {
		if (event.payload) console.warn(line, event.payload);
		else console.warn(line);
		return;
	}
	if (event.payload) console.log(line, event.payload);
	else console.log(line);
}

function summarizeClient(req) {
	const ip = String(req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || 'unknown')
		.split(',')[0]
		.trim();
	const ua = String(req.headers['user-agent'] || 'unknown').slice(0, 60);
	return { ip, ua };
}

function resolveMeterAction(req) {
	const fromBody = String(req.body?.action || req.body?.command || '').trim().toLowerCase();
	if (fromBody === 'on' || fromBody === 'off') return fromBody;

	if (req.path.endsWith('/on')) return 'on';
	if (req.path.endsWith('/off')) return 'off';

	return '';
}

function resolveTaskerState(body = {}) {
	const candidates = [
		body.is_on,
		body.isOn,
		body.state,
		body.status,
		body.action,
		body.command,
		body?.received?.is_on,
		body?.received?.isOn,
		body?.received?.state,
		body?.received?.status
	];

	for (const candidate of candidates) {
		const normalized = normalizePowerState(candidate);
		if (typeof normalized === 'boolean') return normalized;
	}

	return null;
}

function getPowerSnapshotFromGlobal() {
	const fallback = {
		is_on: false,
		source: 'system',
		last_update: new Date().toISOString()
	};

	const state = global.powerState || fallback;
	const normalized = normalizePowerState(state.is_on);

	return {
		isOn: typeof normalized === 'boolean' ? normalized : false,
		source: String(state.source || 'system'),
		lastUpdate: state.last_update || new Date().toISOString()
	};
}

export function registerPowerRoutes(app, {
	sql,
	controlMeterByAction,
	syncBookingsPowerFromLatestHistory,
	taskerNoiseWindowMs = 45_000,
	recentTaskerStatusBySource = new Map()
}) {
	async function handleMeterCommand(req, res) {
		try {
			const traceId = String(req.headers['x-trace-id'] || '').trim() || createPowerTraceId();
			const startedAt = Date.now();
			const client = summarizeClient(req);
			res.setHeader('x-trace-id', traceId);

			recordPowerTrace('info', traceId, '▶️ 1/6', 'Route received', {
				path: req.path,
				method: req.method,
				client: client.ip,
				hasApiKey: Boolean(req.headers['x-api-key'] || req.headers['x-meter-api-key'])
			});

			const action = resolveMeterAction(req);
			if (action !== 'on' && action !== 'off') {
				recordPowerTrace('warn', traceId, '⛔ 2/6', 'Invalid action', {
					actionRaw: req.body?.action ?? req.body?.command ?? null,
					path: req.path
				});
				return res.status(400).json({ error: "Invalid action. Use 'on' or 'off'." });
			}

			recordPowerTrace('info', traceId, '✅ 2/6', 'Action resolved', {
				action,
				path: req.path,
				ua: client.ua
			});

			recordPowerTrace('info', traceId, '📡 3/6', 'Dispatch to SmartThings adapter', {
				action,
				adapter: 'controlMeterByAction'
			});

			const result = await controlMeterByAction(action, {
				traceId,
				source: 'api_meter',
				requestPath: req.path
			});
			if (!result?.success) {
				recordPowerTrace('error', traceId, '❌ 4/6', 'SmartThings adapter returned failure', {
					action,
					command: result?.command || '',
					elapsedMs: Date.now() - startedAt
				});
				return res.status(502).json({
					success: false,
					traceId,
					action,
					command: result?.command || '',
					error: 'SmartThings command failed'
				});
			}

			recordPowerTrace('info', traceId, '✅ 4/6', 'SmartThings adapter success', {
				action,
				command: result.command || action,
				elapsedMs: Date.now() - startedAt
			});

			const nowIso = new Date().toISOString();
			global.powerState = {
				is_on: action === 'on',
				source: 'api_meter',
				last_update: nowIso
			};

			recordPowerTrace('info', traceId, '🧠 5/6', 'Global power state updated', {
				is_on: global.powerState.is_on,
				source: global.powerState.source,
				last_update: global.powerState.last_update
			});

			recordPowerTrace('info', traceId, '🏁 6/6', 'Command flow finished', {
				action,
				totalMs: Date.now() - startedAt
			});

			return res.status(200).json({
				success: true,
				traceId,
				action,
				command: result.command || action,
				timestamp: nowIso
			});
		} catch (error) {
			const traceId = String(req.headers['x-trace-id'] || '').trim() || 'no-trace';
			recordPowerTrace('error', traceId, '🔴', 'Route error', { error: error.message });
			return res.status(500).json({ error: 'Meter command error' });
		}
	}

	async function handlePowerStatusFeedback(req, res) {
		try {
			const isOn = resolveTaskerState(req.body || {});
			if (typeof isOn !== 'boolean') {
				return res.status(400).json({ error: 'Invalid power state payload' });
			}

			const source = String(req.body?.source || req.body?.origin || 'tasker_direct').trim() || 'tasker_direct';
			const bookingIdRaw = req.body?.booking_id ?? req.body?.bookingId ?? null;
			const bookingId = bookingIdRaw == null ? null : String(bookingIdRaw).trim();
			const batteryRaw = req.body?.battery ?? req.body?.bat ?? null;
			const battery = Number.isFinite(Number(batteryRaw)) ? Number(batteryRaw) : null;
			const now = new Date();
			const nowIso = now.toISOString();

			const recentKey = `${source}:${isOn ? 'on' : 'off'}`;
			const lastSeenTs = Number(recentTaskerStatusBySource.get(recentKey) || 0);
			const withinNoiseWindow = now.getTime() - lastSeenTs < taskerNoiseWindowMs;
			if (!withinNoiseWindow) {
				recentTaskerStatusBySource.set(recentKey, now.getTime());
			}

			let inserted = false;
			if (sql && !withinNoiseWindow) {
				try {
					const latestRows = await sql`
						SELECT is_on, timestamp
						FROM power_history
						ORDER BY timestamp DESC
						LIMIT 1
					`;

					const latest = latestRows[0] || null;
					const latestState = latest ? normalizePowerState(latest.is_on) : null;
					const latestTs = latest?.timestamp ? new Date(latest.timestamp).getTime() : 0;
					const isDuplicateState = typeof latestState === 'boolean'
						&& latestState === isOn
						&& (now.getTime() - latestTs) < taskerNoiseWindowMs;

					if (!isDuplicateState) {
						await sql`
							INSERT INTO power_history (is_on, source, timestamp, battery, booking_id)
							VALUES (${isOn}, ${source}, ${nowIso}, ${battery}, ${bookingId})
						`;
						inserted = true;
					}
				} catch (dbError) {
					console.error('[POWER_STATUS] 🔴 DB insert error:', dbError.message);
				}
			}

			global.powerState = {
				is_on: isOn,
				source,
				last_update: nowIso
			};

			let syncResult = null;
			if (typeof syncBookingsPowerFromLatestHistory === 'function') {
				try {
					syncResult = await syncBookingsPowerFromLatestHistory();
				} catch (syncError) {
					console.warn('[POWER_STATUS] ⚠️ Booking sync error:', syncError.message);
				}
			}

			return res.status(200).json({
				success: true,
				stored: inserted,
				ignoredAsNoise: withinNoiseWindow,
				power: {
					isOn,
					source,
					timestamp: nowIso
				},
				bookingSync: syncResult
			});
		} catch (error) {
			console.error('[POWER_STATUS] 🔴 Feedback error:', error.message);
			return res.status(500).json({ error: 'Power status feedback error' });
		}
	}

	app.post('/api/meter', handleMeterCommand);
	app.post('/api/meter/on', handleMeterCommand);
	app.post('/api/meter/off', handleMeterCommand);

	app.post('/api/power-status', handlePowerStatusFeedback);
	app.post('/api/power/status', handlePowerStatusFeedback);

	app.get('/api/power-status', async (_req, res) => {
		try {
			if (sql) {
				const rows = await sql`
					SELECT is_on, source, timestamp
					FROM power_history
					ORDER BY timestamp DESC
					LIMIT 1
				`;

				if (rows.length) {
					const row = rows[0];
					const normalized = normalizePowerState(row.is_on);
					return res.json({
						online: true,
						isOn: typeof normalized === 'boolean' ? normalized : false,
						source: row.source || 'db',
						lastUpdate: row.timestamp,
						sourceType: 'db'
					});
				}
			}

			const snapshot = getPowerSnapshotFromGlobal();
			return res.json({
				online: true,
				isOn: snapshot.isOn,
				source: snapshot.source,
				lastUpdate: snapshot.lastUpdate,
				sourceType: 'memory'
			});
		} catch (error) {
			console.error('[POWER_STATUS] 🔴 Read error:', error.message);
			const snapshot = getPowerSnapshotFromGlobal();
			return res.json({
				online: false,
				isOn: snapshot.isOn,
				source: snapshot.source,
				lastUpdate: snapshot.lastUpdate,
				sourceType: 'fallback'
			});
		}
	});

	app.get('/api/power/trace-help', (req, res) => {
		try {
			const store = getPowerTraceStore();
			const requestedTraceId = String(req.query.traceId || '').trim();
			const effectiveTraceId = requestedTraceId || store.lastTraceId || '';
			const requestedLimit = Number.parseInt(String(req.query.limit || '80'), 10);
			const limit = Number.isFinite(requestedLimit)
				? Math.max(1, Math.min(requestedLimit, 300))
				: 80;

			const sourceEvents = effectiveTraceId
				? store.events.filter(event => event.traceId === effectiveTraceId)
				: store.events;

			const events = sourceEvents.slice(-limit);
			const traces = [];
			for (let index = store.events.length - 1; index >= 0 && traces.length < 10; index--) {
				const value = store.events[index]?.traceId;
				if (!value || traces.includes(value)) continue;
				traces.push(value);
			}

			return res.status(200).json({
				success: true,
				traceId: effectiveTraceId || null,
				count: events.length,
				availableTraceIds: traces,
				events,
				hint: 'Use /api/power/trace-help?traceId=<id>&limit=120 to inspect a specific command flow.'
			});
		} catch (error) {
			console.error('[POWER_TRACE] 🔴 Trace-help error:', error.message);
			return res.status(500).json({ success: false, error: 'Trace help error' });
		}
	});

	app.get('/api/power-history', async (req, res) => {
		try {
			if (!sql) {
				return res.status(200).json({
					count: 0,
					data: [],
					period: null,
					note: 'Database not connected'
				});
			}

			const requestedDays = Number.parseInt(String(req.query.days || '30'), 10);
			const days = Number.isFinite(requestedDays)
				? Math.max(1, Math.min(requestedDays, 365))
				: 30;

			const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
			const rows = await sql`
				SELECT id, is_on, source, timestamp, battery, booking_id
				FROM power_history
				WHERE timestamp >= ${since.toISOString()}
				ORDER BY timestamp DESC
				LIMIT 1000
			`;

			return res.status(200).json({
				count: rows.length,
				data: rows,
				period: {
					since: since.toISOString(),
					until: new Date().toISOString(),
					days
				}
			});
		} catch (error) {
			console.error('[POWER_HISTORY] 🔴 Read error:', error.message);
			return res.status(500).json({ error: 'Power history read error' });
		}
	});
}
