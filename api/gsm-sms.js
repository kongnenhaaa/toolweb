import crypto from 'node:crypto';
import { getAdminDb } from '../lib/firebaseAdmin.js';
import {
    buildGsmCommand,
    buildGsmBridgeStatus,
    findGsmBridgePorts,
    validateGsmBridgeRequest
} from '../lib/gsmBridge.js';

const RESERVATION_TTL_MS = 8 * 60 * 1000;

function sendError(res, statusCode, errorCode, message) {
    res.status(statusCode).json({
        ok: false,
        status: 'failed',
        errorCode,
        error: message
    });
}

function verifyBridgeToken(req) {
    const expected = String(process.env.GSM_BRIDGE_TOKEN || '').trim();
    if (expected.length < 24) {
        const error = new Error('GSM_BRIDGE_TOKEN chưa được cấu hình');
        error.statusCode = 503;
        error.errorCode = 'bridge_not_configured';
        throw error;
    }
    const authorization = String(req.headers?.authorization || '');
    const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
    const supplied = String(
        req.headers?.['x-toolweb-bridge-token'] || bearer || ''
    ).trim();
    const expectedBytes = Buffer.from(expected, 'utf8');
    const suppliedBytes = Buffer.from(supplied, 'utf8');
    if (expectedBytes.length !== suppliedBytes.length
        || !crypto.timingSafeEqual(expectedBytes, suppliedBytes)) {
        const error = new Error('API token không hợp lệ');
        error.statusCode = 401;
        error.errorCode = 'unauthorized';
        throw error;
    }
}

function validRequestId(value) {
    return /^[A-Za-z0-9_-]{8,80}$/.test(String(value || '').trim());
}

async function readStatus(requestId) {
    const db = getAdminDb();
    const [resultSnapshot, commandSnapshot] = await Promise.all([
        db.ref(`command_results/${requestId}`).once('value'),
        db.ref(`commands/${requestId}`).once('value')
    ]);
    const result = resultSnapshot.val();
    const command = commandSnapshot.val();
    let machineId = String(result?.machineId || command?.machineId || '').trim();
    let portId = String(result?.portId || command?.portId || '').trim();
    let webState = null;
    if (machineId && portId) {
        const webStateSnapshot = await db.ref(
            `web_states/machines/${machineId}/ports/${portId}`
        ).once('value');
        webState = webStateSnapshot.val();
    }
    if (!webState) {
        if (machineId) {
            const machinePortsSnapshot = await db.ref(`web_states/machines/${machineId}/ports`).once('value');
            const ports = machinePortsSnapshot.val() || {};
            for (const [pId, pNode] of Object.entries(ports)) {
                if (pNode && (String(pNode.commandId || '') === requestId || String(pNode.reservationId || '') === requestId)) {
                    webState = pNode;
                    portId = pId;
                    break;
                }
            }
        }
        if (!webState) {
            const allMachinesSnapshot = await db.ref('web_states/machines').once('value');
            const machines = allMachinesSnapshot.val() || {};
            for (const [mId, mNode] of Object.entries(machines)) {
                const ports = mNode?.ports || {};
                for (const [pId, pNode] of Object.entries(ports)) {
                    if (pNode && (String(pNode.commandId || '') === requestId || String(pNode.reservationId || '') === requestId)) {
                        webState = pNode;
                        machineId = mId;
                        portId = pId;
                        break;
                    }
                }
                if (webState) break;
            }
        }
    }
    return buildGsmBridgeStatus(requestId, result, command, webState);
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers?.origin) {
        sendError(res, 403, 'origin_rejected', 'Browser Origin không được phép');
        return;
    }

    try {
        verifyBridgeToken(req);

        if (req.method === 'GET') {
            const requestId = String(req.query?.requestId || '').trim();
            if (!validRequestId(requestId)) {
                sendError(res, 400, 'invalid_request', 'requestId không hợp lệ');
                return;
            }
            const status = await readStatus(requestId);
            if (!status.found) {
                sendError(res, 404, 'request_not_found', 'Không tìm thấy lệnh');
                return;
            }
            res.status(200).json(status.payload);
            return;
        }

        if (req.method !== 'POST') {
            res.setHeader('Allow', 'GET, POST');
            sendError(res, 405, 'method_not_allowed', 'Method không được hỗ trợ');
            return;
        }

        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); }
            catch { body = null; }
        }
        const validation = validateGsmBridgeRequest(body);
        if (!validation.ok) {
            sendError(
                res,
                validation.statusCode || 400,
                'invalid_request',
                validation.error
            );
            return;
        }
        const request = validation.value;

        const existing = await readStatus(request.requestId);
        if (existing.found) {
            res.status(200).json({ ...existing.payload, duplicate: true });
            return;
        }

        const db = getAdminDb();
        const machinesSnapshot = await db.ref('machines').once('value');
        const machinesVal = machinesSnapshot.val();

        // --- DEBUG LOG ---
        console.log('[gsm-sms] sourcePhone:', request.sourcePhone);
        if (machinesVal && typeof machinesVal === 'object') {
            for (const [mid, mnode] of Object.entries(machinesVal)) {
                const ls = mnode?.server_status?.lastSync || mnode?.lastSync || 0;
                const age = Date.now() - Number(ls);
                console.log(`[gsm-sms] machine=${mid} lastSync=${ls} age=${age}ms`);
                if (mnode?.ports && typeof mnode.ports === 'object') {
                    for (const [pid, pnode] of Object.entries(mnode.ports)) {
                        if (pnode && typeof pnode === 'object') {
                            console.log(`[gsm-sms]   port=${pid} status=${pnode.status} phone=${pnode.phone||pnode.phoneNumber||pnode.number||'?'}`);
                        }
                    }
                }
            }
        } else {
            console.log('[gsm-sms] machines data is null/empty!');
        }
        // --- END DEBUG ---

        const matches = findGsmBridgePorts(machinesVal, request);
        console.log('[gsm-sms] matches count:', matches.length);
        if (matches.length === 0) {
            sendError(
                res,
                404,
                'source_phone_not_found',
                'Không tìm thấy SIM online có số điện thoại đang đăng ký'
            );
            return;
        }
        if (matches.length > 1) {
            sendError(
                res,
                409,
                'source_phone_ambiguous',
                'Có nhiều COM online cùng số điện thoại; hãy chỉ định machineId/portName'
            );
            return;
        }

        const selected = matches[0];
        const now = Date.now();
        const stateRef = db.ref(
            `web_states/machines/${selected.machineId}/ports/${selected.portId}`
        );
        const reservation = await stateRef.transaction(current => {
            current = current || {};
            const currentId = String(current.commandId || '');
            const currentStatus = String(current.commandStatus || '').toLowerCase();
            const reservationId = String(current.reservationId || '');
            const reservationExpiresAt = Number(current.reservationExpiresAt || 0);
            const busy = ['queued', 'running'].includes(currentStatus);
            if ((busy && currentId && currentId !== request.requestId)
                || (reservationId && reservationId !== request.requestId
                    && reservationExpiresAt > now)) {
                return;
            }
            return {
                ...current,
                phone: selected.port?.phone || request.sourcePhone,
                smsSent: true,
                smsSentTime: now,
                commandId: request.requestId,
                commandIds: null,
                commandStatus: 'queued',
                errorMsg: null,
                otp: null,
                clearedOtp: current.otp || current.clearedOtp || null,
                smsRecipient: request.destination,
                smsRequestContent: request.message,
                smsContent: null,
                smsContentAt: null,
                reservationId: request.requestId,
                reservedBy: 'zalo-tool-api',
                reservedAt: now,
                reservationExpiresAt: now + RESERVATION_TTL_MS,
                updatedAt: now
            };
        }, undefined, false);

        if (!reservation.committed) {
            sendError(res, 409, 'port_busy', 'COM đang xử lý một lệnh khác');
            return;
        }

        try {
            const command = buildGsmCommand(request, selected, now);
            const commandRef = db.ref(`commands/${request.requestId}`);
            const commandWrite = await commandRef.transaction(current =>
                current || command, undefined, false);
            res.status(commandWrite.snapshot.val() ? 202 : 409).json({
                ok: false,
                queued: true,
                duplicate: !commandWrite.committed,
                requestId: request.requestId,
                status: 'queued',
                machineId: selected.machineId,
                portName: selected.portId
            });
        } catch (error) {
            await stateRef.transaction(current => {
                if (!current || current.commandId !== request.requestId) return current;
                return {
                    ...current,
                    smsSent: false,
                    commandId: null,
                    commandStatus: 'failed',
                    errorMsg: 'Không thể tạo command',
                    reservationId: null,
                    reservedBy: null,
                    reservationExpiresAt: null,
                    updatedAt: Date.now()
                };
            }, undefined, false);
            throw error;
        }
    } catch (error) {
        const statusCode = Number(error.statusCode) || 500;
        if (statusCode >= 500) console.error('GSM SMS bridge error:', error);
        sendError(
            res,
            statusCode,
            error.errorCode || 'bridge_error',
            statusCode >= 500 ? 'GSM bridge tạm không sẵn sàng' : error.message
        );
    }
}
