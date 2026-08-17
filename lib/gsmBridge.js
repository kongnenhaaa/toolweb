export const GSM_BRIDGE_PURPOSE = 'zalo-manual-mo';
export const GSM_MACHINE_HEARTBEAT_MAX_AGE_MS = 30_000;

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const ZALO_MO_RE = /^(?:\[Zalo\]\s+[A-Za-z0-9_-]{8,160}|ZALO)$/i;
const COM_PORT_RE = /^COM[0-9]{1,4}$/i;

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
    if (!ZALO_MO_RE.test(value.message)) {
        return invalid('message không đúng lệnh SMS Zalo được phép');
    }
    if (value.portName && !COM_PORT_RE.test(value.portName)) {
        return invalid('portName không hợp lệ');
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
        const lastSync = Number(machineNode.server_status?.lastSync || 0);
        if (!lastSync || now - lastSync > maxHeartbeatAgeMs) continue;

        const ports = machineNode.ports;
        if (!ports || typeof ports !== 'object') continue;
        for (const [firebasePortId, portNode] of Object.entries(ports)) {
            if (!portNode || typeof portNode !== 'object') continue;
            const portId = String(
                portNode.portId || portNode.id || firebasePortId || ''
            ).trim();
            if (!portId || (request.portName && request.portName !== portId)) continue;
            if (String(portNode.status || '').toLowerCase() !== 'online') continue;
            if (normalizeVietnamPhone(portNode.phone) !== source) continue;
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

function portNumber(value) {
    const match = String(value || '').match(/\d+/);
    return match ? Number(match[0]) : Number.MAX_SAFE_INTEGER;
}
