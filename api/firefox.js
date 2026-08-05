import {
    applyCors,
    verifyBearerToken,
    verifyDeviceSession
} from '../lib/firebaseAdmin.js';

export default async function handler(req, res) {
    const corsAllowed = applyCors(req, res);
    if (!corsAllowed) {
        res.status(403).json({ error: 'Origin is not allowed' });
        return;
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET, OPTIONS');
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        const decodedToken = await verifyBearerToken(req);
        await verifyDeviceSession(req, decodedToken);

        // Forward only query parameters; the browser can never supply the upstream token.
        const urlParams = new URLSearchParams(req.query);
        urlParams.delete('token');
        urlParams.set('token', process.env.FIREFOX_TOKEN || '');

        const targetUrl = `https://www.firefox.fun/yhapi.ashx?${urlParams.toString()}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        let response;
        let data;
        try {
            response = await fetch(targetUrl, {
                signal: controller.signal,
                cache: 'no-store',
                headers: { Accept: 'text/plain' }
            });
            data = await response.text();
        } finally {
            clearTimeout(timeoutId);
        }

        if (!response.ok) {
            res.status(response.status).send(data || `Firefox API HTTP ${response.status}`);
            return;
        }

        res.status(200).send(data);
    } catch (error) {
        const status = Number(error.statusCode)
            || (error.name === 'AbortError' ? 504 : 500);
        console.error('Firefox proxy error:', error);
        res.status(status).json({
            error: status === 409
                ? 'This account is active on another device'
                : status === 504
                    ? 'Firefox API timeout'
                    : status === 401
                        ? error.message || 'Authentication required'
                        : 'Failed to fetch from Firefox API'
        });
    }
}
