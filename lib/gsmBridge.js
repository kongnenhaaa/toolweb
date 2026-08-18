export const GSM_BRIDGE_PURPOSE = 'zalo-manual-mo';
export const GSM_MACHINE_HEARTBEAT_MAX_AGE_MS = 300_000;

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const ZALO_MO_RE = /^(?:\[Zalo\]\s+[A-Za-z0-9_-]{8,160}|ZALO)$/i;
const COM_PORT_RE = /^COM[0-9]{1,4}$/i;
const GSM_SUCCESS_STATUSES = new Set(['sent', 'done', 'success', 'otp_received']);
const GSM_WAITING_STATUSES = new Set(['queued', 'running']);

export function normalizeVietnamPhone(value) {
    let digits = String(value || '').replace(/\D/g, '');
    if (/^84\d{9,10}$/.test(digits)) digits = `0${digits.slice(2)}`;
    return /^0\d{9,10}$/.test(digits) ? digits : '';
}

export function normalizeSmsDestination(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (/^\d{3,8}$/.test(digits)) return digits;
    return normalizeVietnamPhone(value);
}

export function validateGsmBridgeRequest(input) {
    const body = input && typeof input === 'object' && !Array.isArray(input)
        ? input
        : {};
    const value = {
        schemaVersion: Number(body.schemaVersion),
        requestId: String(body.requestId || '').trim(),
        purpose: String(body.purpose || '').trim(),
        sourcePhone: normalizeVietnamPhone(body.sourcePhone),
        destination: normalizeSmsDestination(body.destination),
        message: String(body.message || ''),
        machineId: String(body.machineId || '').trim(),
        portName: String(body.portName || '').trim()
    };

    if (value.schemaVersion !== 1) return invalid('schemaVersion phải bằng 1');
    if (value.purpose !== GSM_BRIDGE_PURPOSE) return invalid('purpose không hợp lệ');
    if (!REQUEST_ID_RE.test(value.requestId)) return invalid('requestId không hợp lệ');
    if (!value.sourcePhone) return invalid('sourcePhone không hợp lệ');
    if (!value.destination) return invalid('destination không hợp lệ');
    if (!ZALO_MO_RE.test(value.message)) return invalid('Nội dung SMS không đúng định dạng MO Zalo');
    if (value.portName && !COM_PORT_RE.test(value.portName)) {
        return invalid('portName phải có định dạng COMx');
    }
    return { ok: true, value };

    function invalid(error) {
        return { ok: false, error, statusCode: 400 };
    }
}

export function findGsmBridgePorts(
    machines,
    request,
    now = Date.now(),
    maxHeartbeatAgeMs = GSM_MACHINE_HEARTBEAT_MAX_AGE_MS
) {
    const matches = [];
    const source = normalizeVietnamPhone(request?.sourcePhone);
    if (!source || !machines || typeof machines !== 'object') return matches;

    for (const [machineId, machineNode] of Object.entries(machines)) {
        if (!machineNode || typeof machineNode !== 'object') continue;
        if (request.machineId && request.machineId !== machineId) continue;
        let lastSync = Number(
            machineNode.server_status?.lastSync
            || machineNode.lastSync
            || machineNode.lastHeartbeat
            || machineNode.updatedAt
            || 0
        );
        if (lastSync > 0 && lastSync < 1e11) lastSync *= 1000;
        if (lastSync > 0 && now - lastSync > maxHeartbeatAgeMs) continue;

        const ports = machineNode.ports;
        if (!ports || typeof ports !== 'object') continue;
        for (const [firebasePortId, portNode] of Object.entries(ports)) {
            if (!portNode || typeof portNode !== 'object') continue;
            const stableFirebasePortId = String(firebasePortId || '').trim();
            const payloadPortId = String(portNode.portId || portNode.id || '').trim();
            const portId = /^COM\d+$/i.test(stableFirebasePortId)
                ? stableFirebasePortId.toUpperCase()
                : (/^COM\d+$/i.test(payloadPortId) ? payloadPortId.toUpperCase() : (stableFirebasePortId || payloadPortId));
            if (!portId || (request.portName && request.portName !== portId)) continue;
            const portStatus = String(portNode.status || '').trim().toLowerCase();
            if (portStatus && !['online', 'ready', 'idle', 'active'].includes(portStatus)) continue;
            const portPhone = normalizeVietnamPhone(portNode.phone || portNode.phoneNumber || portNode.number);
            if (portPhone !== source) continue;
            matches.push({ machineId, portId, port: portNode });
        }
    }
    return matches.sort((a, b) =>
        a.machineId.localeCompare(b.machineId)
        || portNumber(a.portId) - portNumber(b.portId)
        || a.portId.localeCompare(b.portId));
}

export function buildGsmCommand(request, selected, now = Date.now()) {
    return {
        id: request.requestId,
        protocolVersion: 1,
        machineId: selected.machineId,
        portId: selected.portId,
        deviceName: selected.port?.deviceName || selected.machineId,
        recipient: request.destination,
        content: request.message,
        type: 'sms',
        status: 'queued',
        clientSessionId: request.requestId,
        requestSource: 'zalo-tool-api',
        purpose: request.purpose,
        sourcePhone: request.sourcePhone,
        createdAt: now,
        updatedAt: now
    };
}

export function extractGsmBridgeOtp(...records) {
    const explicitFields = ['otp', 'code', 'otpCode', 'verificationCode'];
    const textFields = [
        'smsContent',
        'otpContent',
        'receivedSms',
        'receivedMessage',
        'messageText',
        'result'
    ];

    for (const record of records) {
        if (!record || typeof record !== 'object') continue;
        for (const field of explicitFields) {
            const candidate = String(record[field] ?? '').trim();
            if (/^\d{4,8}$/.test(candidate)) return candidate;
        }
    }

    for (const record of records) {
        if (!record || typeof record !== 'object') continue;
        for (const field of textFields) {
            const text = String(record[field] ?? '').trim();
            if (!text) continue;
            if (/^\d{4,8}$/.test(text)) return text;
            const keywordMatch = text.match(
                /(?:otp|m[aã]\s*x[aá]c\s*(?:thực|nhận)|verification\s*code|security\s*code|passcode|\bcode\b)\D{0,48}(\d{4,8})(?!\d)/iu
            );
            if (keywordMatch?.[1]) return keywordMatch[1];
            const sixDigitMatches = text.match(/(?<!\d)\d{6}(?!\d)/g);
            if (sixDigitMatches?.length) return sixDigitMatches[sixDigitMatches.length - 1];
        }
    }
    return '';
}

export function buildGsmBridgeStatus(requestId, result, command, webState) {
    const hasResult = result && typeof result === 'object';
    const hasCommand = command && typeof command === 'object';
    const ownsWebState = webState && typeof webState === 'object'
        && [webState.commandId, webState.reservationId]
            .some(value => String(value || '') === String(requestId || ''));

    if (!hasResult && !hasCommand && !ownsWebState) {
        return { found: false, payload: null };
    }

    const hasValidCommand = command && typeof command === 'object'
        && typeof command.portId === 'string'
        && typeof command.recipient === 'string'
        && typeof command.content === 'string';
    const falseMalformedResult = hasResult
        && String(result.status || '').toLowerCase() === 'failed'
        && /malformed command/i.test(String(result.error || result.errorMsg || ''))
        && (hasValidCommand || ownsWebState || Boolean(webState?.smsSent || webState?.smsRecipient));
    const rawStatus = String(
        (hasResult && !falseMalformedResult ? result.status : '')
        || (ownsWebState ? webState.commandStatus : '')
        || (falseMalformedResult ? 'running' : '')
        || source.status
        || (hasResult ? 'done' : 'queued')
    ).toLowerCase();
    const otp = extractGsmBridgeOtp(
        hasResult ? result : null,
        ownsWebState ? webState : null
    );
    const portName = String(
        result?.portId || command?.portId || (ownsWebState ? webState.portId : '') || ''
    );
    const machineId = String(
        result?.machineId || command?.machineId || (ownsWebState ? webState.machineId : '') || ''
    );

    if (otp) {
        return {
            found: true,
            payload: {
                ok: true,
                requestId,
                status: 'otp_received',
                phase: 'otp_received',
                otp,
                portName,
                machineId,
                result: result?.result || '',
                smsContent: result?.smsContent || (ownsWebState ? webState.smsContent : '') || '',
                errorCode: '',
                error: ''
            }
        };
    }

    if (GSM_SUCCESS_STATUSES.has(rawStatus)) {
        // Sending the MO message is only phase one. Keep the web client polling
        // until the reply SMS arrives, otherwise Auto Forgot Password opens a
        // manual OTP dialog before ToolGSM has had a chance to publish the code.
        return {
            found: true,
            payload: {
                ok: false,
                queued: false,
                requestId,
                status: 'running',
                phase: 'waiting_otp',
                smsSent: true,
                portName,
                machineId,
                result: result?.result || '',
                errorCode: '',
                error: ''
            }
        };
    }

    const waiting = GSM_WAITING_STATUSES.has(rawStatus);
    return {
        found: true,
        payload: {
            ok: false,
            requestId,
            status: rawStatus,
            phase: waiting ? 'sending_sms' : rawStatus,
            portName,
            machineId,
            queued: waiting,
            result: result?.result || '',
            errorCode: waiting ? '' : rawStatus,
            error: (!falseMalformedResult && (result?.error || result?.errorMsg))
                || (ownsWebState ? webState.errorMsg : '')
                || ''
        }
    };
}

function portNumber(value) {
    const match = String(value || '').match(/\d+/);
    return match ? Number(match[0]) : Number.MAX_SAFE_INTEGER;
}
