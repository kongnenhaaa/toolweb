import {
    applyCors,
    getAdminDb,
    verifyBearerToken
} from '../lib/firebaseAdmin.js';

function sendError(res, statusCode, message) {
    res.status(statusCode).json({ error: message });
}

export default async function handler(req, res) {
    const corsAllowed = applyCors(req, res);
    if (!corsAllowed) {
        sendError(res, 403, 'Origin is not allowed');
        return;
    }

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
        res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
        sendError(res, 405, 'Method not allowed');
        return;
    }

    try {
        const decodedToken = await verifyBearerToken(req);
        const sessionId = String(
            req.headers?.['x-device-session']
            || req.body?.sessionId
            || ''
        ).trim();
        if (!/^[a-f0-9]{64}$/.test(sessionId)) {
            sendError(res, 400, 'Invalid device session');
            return;
        }

        const profileSnapshot = await getAdminDb().ref(`users/${decodedToken.uid}`).once('value');
        const profile = profileSnapshot.val();
        if (!profile || profile.active === false) {
            sendError(res, 403, 'Account is not active');
            return;
        }

        // Admin accounts are intentionally allowed to use multiple devices.
        if (profile.role === 'admin') {
            res.status(200).json({ ok: true, singleDevice: false });
            return;
        }

        const userRef = getAdminDb().ref(`users/${decodedToken.uid}`);

        if (req.method === 'GET') {
            const activeSessionSnapshot = await userRef.child('activeSessionId').once('value');
            if (activeSessionSnapshot.val() !== sessionId) {
                const error = new Error('This account is active on another device');
                error.statusCode = 409;
                throw error;
            }

            res.status(200).json({ ok: true, active: true });
            return;
        }

        if (req.method === 'DELETE') {
            const releaseResult = await userRef.transaction(current => {
                if (!current || current.activeSessionId !== sessionId) return;
                return {
                    ...current,
                    activeSessionId: null,
                    activeSessionUpdatedAt: null
                };
            });

            res.status(200).json({
                ok: true,
                released: Boolean(releaseResult.committed)
            });
            return;
        }

        // Latest login wins. The previous device observes this value through
        // its realtime listener and signs out with a visible notification.
        await userRef.update({
            activeSessionId: sessionId,
            activeSessionUpdatedAt: Date.now()
        });

        res.status(200).json({ ok: true });
    } catch (error) {
        const statusCode = Number(error.statusCode) || 500;
        if (statusCode >= 500) console.error('Session claim error:', error);
        sendError(res, statusCode, statusCode >= 500 ? 'Failed to claim device session' : error.message);
    }
}
