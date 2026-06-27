import { syncBookingsFromGmail } from './detective.js';

export async function runDetectiveCommand(command, payload = {}) {
    const action = String(command || '').trim().toLowerCase();

    if (action === 'sync_email_now') {
        const ignoreLastCheck = payload?.ignoreLastCheck !== false;
        const result = await syncBookingsFromGmail({ ignoreLastCheck });
        return {
            success: Boolean(result?.success),
            action: 'sync_email_now',
            result: result || null,
            error: result?.success ? null : (result?.reason || 'SYNC_EMAIL_FAILED')
        };
    }

    return {
        success: false,
        action,
        result: null,
        error: 'UNKNOWN_DETECTIVE_COMMAND'
    };
}
