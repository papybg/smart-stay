export function createSimpleRateLimiter({
    windowMs = 60_000,
    maxRequests = 30,
    keyHeader = 'x-forwarded-for',
    methods = []
} = {}) {
    const hits = new Map();

    return function rateLimiter(req, res, next) {
        if (methods.length && !methods.includes(req.method.toUpperCase())) {
            return next();
        }

        const now = Date.now();
        const ip = String(req.headers[keyHeader] || req.ip || req.connection?.remoteAddress || 'unknown')
            .split(',')[0]
            .trim();

        const bucket = hits.get(ip) || { count: 0, resetAt: now + windowMs };

        if (now > bucket.resetAt) {
            bucket.count = 0;
            bucket.resetAt = now + windowMs;
        }

        bucket.count += 1;
        hits.set(ip, bucket);

        if (bucket.count > maxRequests) {
            return res.status(429).json({
                error: 'Too many requests',
                retryAfterMs: Math.max(0, bucket.resetAt - now)
            });
        }

        next();
    };
}

export function createApiKeyGuard({
    envVar,
    headerName = 'x-api-key',
    optional = false,
    methods = []
} = {}) {
    const expectedKey = process.env[envVar] || '';

    return function apiKeyGuard(req, res, next) {
        if (methods.length && !methods.includes(req.method.toUpperCase())) {
            return next();
        }

        if (!expectedKey) {
            if (optional) return next();
            return res.status(503).json({ error: `${envVar} is not configured` });
        }

        const incoming = req.headers[headerName] || req.headers['x-api-key'] || req.body?.apiKey || req.query?.apiKey;
        if (!incoming || String(incoming).trim() !== expectedKey) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        next();
    };
}
