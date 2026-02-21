export function registerSystemRoutes(app) {
    app.get('/status', (_req, res) => {
        res.json({
            online: true,
            timestamp: new Date().toISOString(),
            uptime: Math.floor(process.uptime()),
            powerState: global.powerState.is_on ? 'on' : 'off'
        });
    });
}
