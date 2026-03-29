import { formatNotification } from './formatters.js';
import { sendTelegram } from './channels/telegram.js';
import { sendEmail } from './channels/email.js';

const MAX_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 600;

function normalizeRecipient(channel, recipient) {
    const value = String(recipient || '').trim();
    if (!value) return '';
    return channel === 'email' ? value.toLowerCase() : value;
}

function buildEventKey(eventType, payload, channel, recipient, audience = 'host') {
    const eventRef = payload?.request_code
        || payload?.reservation_code
        || payload?.request_id
        || payload?.booking_id
        || 'na';
    return `${eventType}:${eventRef}:${channel}:${recipient}:${audience}`;
}

function getChannelTargets(eventType, payload) {
    const targets = [];

    const hasTelegram = Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
    if (hasTelegram) {
        targets.push({
            channel: 'telegram',
            recipient: process.env.TELEGRAM_CHAT_ID,
            audience: 'host'
        });
    }

    if (process.env.NOTIF_HOST_EMAIL) {
        targets.push({
            channel: 'email',
            recipient: process.env.NOTIF_HOST_EMAIL,
            audience: 'host'
        });
    }

    const shouldNotifyGuest = eventType === 'request_paid' || eventType === 'request_cancelled' || eventType === 'request_approved';
    if (shouldNotifyGuest && payload?.guest_email) {
        targets.push({
            channel: 'email',
            recipient: payload.guest_email,
            audience: 'guest'
        });
    }

    if (shouldNotifyGuest && payload?.guest_telegram_chat_id) {
        targets.push({
            channel: 'telegram',
            recipient: payload.guest_telegram_chat_id,
            audience: 'guest'
        });
    }

    const unique = new Map();
    for (const target of targets) {
        const recipient = normalizeRecipient(target.channel, target.recipient);
        if (!recipient) continue;
        const key = `${target.channel}:${recipient}`;
        if (!unique.has(key)) {
            unique.set(key, {
                channel: target.channel,
                recipient,
                audience: target.audience || 'host'
            });
        }
    }

    return Array.from(unique.values());
}

export function createNotificationService({ sql }) {
    const queue = [];
    let processing = false;

    async function logAttempt({ eventType, channel, recipient, status, attempt, error, payload, eventKey }) {
        if (!sql) return;
        try {
            await sql`
                INSERT INTO notification_log (
                    event_key,
                    event_type,
                    channel,
                    recipient,
                    status,
                    attempt,
                    error_message,
                    payload
                ) VALUES (
                    ${eventKey || null},
                    ${eventType},
                    ${channel},
                    ${recipient},
                    ${status},
                    ${attempt},
                    ${error || null},
                    ${JSON.stringify(payload || {})}
                )
            `;
        } catch (logError) {
            console.error('[NOTIFY:LOG] 🔴', logError.message);
        }
    }

    async function deliver(job) {
        const formatted = formatNotification(job.eventType, job.payload, job.channel, job.audience || 'host');

        if (job.channel === 'telegram') {
            await sendTelegram({
                token: process.env.TELEGRAM_BOT_TOKEN,
                chatId: job.recipient,
                text: formatted.text
            });
            return;
        }

        if (job.channel === 'email') {
            await sendEmail({
                to: job.recipient,
                subject: formatted.subject,
                text: formatted.text,
                html: formatted.html
            });
            return;
        }

        throw new Error(`Unknown channel: ${job.channel}`);
    }

    function scheduleRetry(job, nextAttempt) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, nextAttempt - 1);
        setTimeout(() => {
            queue.push({ ...job, attempt: nextAttempt });
            void processQueue();
        }, delay);
    }

    async function processJob(job) {
        try {
            await deliver(job);
            await logAttempt({
                eventType: job.eventType,
                channel: job.channel,
                recipient: job.recipient,
                status: 'sent',
                attempt: job.attempt,
                payload: job.payload,
                eventKey: job.eventKey
            });
        } catch (error) {
            const errorMessage = error?.message || 'Unknown notification error';
            const canRetry = job.attempt < MAX_ATTEMPTS;

            await logAttempt({
                eventType: job.eventType,
                channel: job.channel,
                recipient: job.recipient,
                status: canRetry ? 'retrying' : 'failed',
                attempt: job.attempt,
                error: errorMessage,
                payload: job.payload,
                eventKey: job.eventKey
            });

            console.error(`[NOTIFY:${job.channel}] 🔴 ${errorMessage}`);

            if (canRetry) {
                scheduleRetry(job, job.attempt + 1);
            }
        }
    }

    async function processQueue() {
        if (processing) return;
        processing = true;
        try {
            while (queue.length > 0) {
                const job = queue.shift();
                await processJob(job);
            }
        } finally {
            processing = false;
        }
    }

    async function emit(eventType, payload = {}) {
        const targets = getChannelTargets(eventType, payload);
        if (!targets.length) {
            return { enqueued: 0 };
        }

        let enqueued = 0;
        for (const target of targets) {
            const eventKey = buildEventKey(eventType, payload, target.channel, target.recipient, target.audience || 'host');
            if (sql) {
                try {
                    const existing = await sql`
                        SELECT id
                        FROM notification_log
                        WHERE event_key = ${eventKey}
                          AND status = 'sent'
                        LIMIT 1
                    `;
                    if (existing.length) {
                        continue;
                    }
                } catch (dedupError) {
                    console.error('[NOTIFY:DEDUP] 🔴', dedupError.message);
                }
            }

            queue.push({
                eventType,
                channel: target.channel,
                recipient: target.recipient,
                audience: target.audience || 'host',
                payload,
                attempt: 1,
                eventKey
            });
            enqueued += 1;
        }

        if (enqueued === 0) {
            return { enqueued: 0 };
        }

        void processQueue();
        return { enqueued };
    }

    return {
        emit
    };
}
