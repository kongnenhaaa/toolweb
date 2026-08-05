import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';

const DEFAULT_DATABASE_URL = 'https://toolweb-c7702-default-rtdb.firebaseio.com';

function parseServiceAccount(rawValue, sourceName) {
    let parsed;
    try {
        parsed = JSON.parse(String(rawValue).trim());
        // Support an accidentally JSON-encoded JSON string without exposing its contents.
        if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    } catch {
        const error = new Error(`${sourceName} is not valid JSON`);
        error.code = 'firebase/invalid-service-account-json';
        throw error;
    }

    const privateKey = String(parsed?.privateKey ?? parsed?.private_key ?? '')
        .replace(/\\n/g, '\n');

    const serviceAccount = {
        projectId: parsed?.projectId ?? parsed?.project_id,
        clientEmail: parsed?.clientEmail ?? parsed?.client_email,
        privateKey
    };

    if (!serviceAccount.projectId || !serviceAccount.clientEmail || !serviceAccount.privateKey) {
        const error = new Error(`${sourceName} is missing projectId, clientEmail, or privateKey`);
        error.code = 'firebase/incomplete-service-account';
        throw error;
    }

    return serviceAccount;
}

function getServiceAccount() {
    const base64Value = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 || '').trim();
    if (base64Value) {
        try {
            const jsonValue = Buffer.from(base64Value, 'base64').toString('utf8');
            return parseServiceAccount(jsonValue, 'FIREBASE_SERVICE_ACCOUNT_JSON_BASE64');
        } catch (error) {
            if (error?.code === 'firebase/invalid-service-account-json'
                || error?.code === 'firebase/incomplete-service-account') throw error;
            const configError = new Error('FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 could not be decoded');
            configError.code = 'firebase/invalid-service-account-base64';
            throw configError;
        }
    }

    const jsonValue = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
    if (jsonValue) return parseServiceAccount(jsonValue, 'FIREBASE_SERVICE_ACCOUNT_JSON');

    const serviceAccount = {
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
    };
    if (!serviceAccount.projectId || !serviceAccount.clientEmail || !serviceAccount.privateKey) {
        const error = new Error('Firebase Admin credentials are not configured');
        error.code = 'firebase/missing-service-account';
        throw error;
    }
    return serviceAccount;
}

function getAdminApp() {
    const existingApps = getApps();
    if (existingApps.length > 0) return existingApps[0];

    const serviceAccount = getServiceAccount();

    return initializeApp({
        credential: cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL || DEFAULT_DATABASE_URL
    });
}

export function getAdminAuth() {
    return getAuth(getAdminApp());
}

export function getAdminDb() {
    return getDatabase(getAdminApp());
}

export async function verifyBearerToken(req) {
    const authorization = req.headers?.authorization || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) {
        const error = new Error('Missing Firebase ID token');
        error.statusCode = 401;
        throw error;
    }

    try {
        return await getAdminAuth().verifyIdToken(match[1], true);
    } catch (cause) {
        const expectedTokenError = [
            'auth/id-token-expired',
            'auth/id-token-revoked',
            'auth/invalid-id-token',
            'auth/argument-error'
        ].includes(cause?.code);

        if (expectedTokenError) {
            console.warn('Firebase ID token rejected:', {
                code: cause?.code || 'unknown',
                message: cause?.message || String(cause)
            });
        } else {
            console.error('Firebase Admin auth setup/verification error:', {
                code: cause?.code || 'unknown',
                message: cause?.message || String(cause)
            });
            const error = new Error('Firebase authentication service unavailable');
            error.statusCode = 500;
            throw error;
        }

        const error = new Error('Invalid or revoked Firebase ID token');
        error.statusCode = 401;
        throw error;
    }
}

export async function verifyDeviceSession(req, decodedToken) {
    const profileSnapshot = await getAdminDb()
        .ref(`users/${decodedToken.uid}`)
        .once('value');
    const profile = profileSnapshot.val();
    if (!profile || profile.active === false) {
        const error = new Error('Account is not active');
        error.statusCode = 403;
        throw error;
    }

    const expireAt = Number(profile.limits?.expireAt || 0);
    if (expireAt > 0 && expireAt < Date.now()) {
        const error = new Error('Account has expired');
        error.statusCode = 403;
        throw error;
    }

    if (profile.role !== 'admin' && profile.allowFirefoxApi === false) {
        const error = new Error('Firefox API is disabled for this account');
        error.statusCode = 403;
        throw error;
    }

    if (profile?.role === 'admin') return null;

    const sessionId = String(req.headers?.['x-device-session'] || '').trim();
    if (!/^[a-f0-9]{64}$/.test(sessionId)) {
        const error = new Error('Missing or invalid device session');
        error.statusCode = 401;
        throw error;
    }

    const snapshot = await getAdminDb()
        .ref(`users/${decodedToken.uid}/activeSessionId`)
        .once('value');
    if (snapshot.val() !== sessionId) {
        const error = new Error('This account is active on another device');
        error.statusCode = 409;
        throw error;
    }

    return sessionId;
}

export function applyCors(req, res) {
    const origin = req.headers?.origin;
    const forwardedProto = String(req.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const requestOrigin = req.headers?.host ? `${forwardedProto}://${req.headers.host}` : '';
    const configuredOrigins = String(process.env.FIREBASE_ALLOWED_ORIGINS || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    const allowed = !origin || origin === requestOrigin || configuredOrigins.includes(origin);

    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Device-Session');
    if (origin && allowed) res.setHeader('Access-Control-Allow-Origin', origin);

    return allowed;
}
