import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildGsmCommand,
    buildGsmBridgeStatus,
    extractGsmBridgeOtp,
    findGsmBridgePorts,
    normalizeSmsDestination,
    normalizeVietnamPhone,
    validateGsmBridgeRequest
} from '../lib/gsmBridge.js';

const now = 1_800_000_000_000;

function request(overrides = {}) {
    return {
        schemaVersion: 1,
        requestId: 'zalo-mo-0123456789abcdef',
        purpose: 'zalo-manual-mo',
        sourcePhone: '0912345678',
        destination: '+84362669166',
        message: '[Zalo] 3zJzYNy2N320f9WhqHn82M3B4EoxcKXa',
        ...overrides
    };
}

test('normalizes Vietnamese phone formats', () => {
    assert.equal(normalizeVietnamPhone('0912 345 678'), '0912345678');
    assert.equal(normalizeVietnamPhone('+84 912 345 678'), '0912345678');
    assert.equal(normalizeVietnamPhone('123'), '');
    assert.equal(normalizeSmsDestination('8066'), '8066');
});

test('accepts a carrier short code as the SMS destination', () => {
    const validated = validateGsmBridgeRequest(request({ destination: '8066' }));
    assert.equal(validated.ok, true);
    assert.equal(validated.value.destination, '8066');
});

test('accepts only the dedicated Zalo MO payload', () => {
    assert.equal(validateGsmBridgeRequest(request()).ok, true);
    assert.equal(validateGsmBridgeRequest(request({
        destination: '8066',
        message: 'ZALO'
    })).ok, true);
    assert.equal(validateGsmBridgeRequest(request({ message: 'ZALO OTHER' })).ok, false);
    assert.equal(validateGsmBridgeRequest(request({ message: 'generic SMS' })).ok, false);
    assert.equal(validateGsmBridgeRequest(request({ purpose: 'other' })).ok, false);
});

test('selects the exact online source SIM on a live machine', () => {
    const machines = {
        PC_A: {
            server_status: { lastSync: now - 1000 },
            ports: {
                COM8: { id: 'COM8', phone: '0900000000', status: 'online' },
                COM9: { id: 'COM9', phone: '+84912345678', status: 'online' }
            }
        },
        STALE_PC: {
            server_status: { lastSync: now - 60_000 },
            ports: {
                COM1: { id: 'COM1', phone: '0912345678', status: 'online' }
            }
        }
    };
    const validated = validateGsmBridgeRequest(request());
    const matches = findGsmBridgePorts(machines, validated.value, now);
    assert.deepEqual(
        matches.map(item => [item.machineId, item.portId]),
        [['PC_A', 'COM9']]
    );
});

test('uses the Firebase COM key when the GSM payload id is transiently wrong', () => {
    const machines = {
        PC_A: {
            server_status: { lastSync: now - 1000 },
            ports: {
                COM3: { id: 'COM8', portId: 'COM8', phone: '0912345678', status: 'online' }
            }
        }
    };
    const validated = validateGsmBridgeRequest(request());
    const matches = findGsmBridgePorts(machines, validated.value, now);

    assert.deepEqual(
        matches.map(item => [item.machineId, item.portId]),
        [['PC_A', 'COM3']]
    );
});

test('builds the Firebase command contract consumed by ToolGSM', () => {
    const validated = validateGsmBridgeRequest(request()).value;
    const command = buildGsmCommand(
        validated,
        { machineId: 'PC_A', portId: 'COM9', port: { deviceName: 'GSM A' } },
        now
    );
    assert.equal(command.id, validated.requestId);
    assert.equal(command.machineId, 'PC_A');
    assert.equal(command.portId, 'COM9');
    assert.equal(command.recipient, '0362669166');
    assert.equal(command.content, validated.message);
    assert.equal(command.status, 'queued');
});

test('keeps polling after the MO SMS is sent but before OTP arrives', () => {
    const status = buildGsmBridgeStatus(
        'zalo-mo-0123456789abcdef',
        { status: 'sent', machineId: 'PC_A', portId: 'COM9', result: 'SMS sent' },
        null,
        {
            commandId: 'zalo-mo-0123456789abcdef',
            commandStatus: 'sent',
            smsSent: true
        }
    );

    assert.equal(status.found, true);
    assert.equal(status.payload.ok, false);
    assert.equal(status.payload.status, 'running');
    assert.equal(status.payload.phase, 'waiting_otp');
    assert.equal(status.payload.smsSent, true);
    assert.equal('otp' in status.payload, false);
});

test('returns OTP from the reserved port state to the bridge caller', () => {
    const status = buildGsmBridgeStatus(
        'zalo-mo-0123456789abcdef',
        { status: 'sent', machineId: 'PC_A', portId: 'COM9' },
        null,
        {
            reservationId: 'zalo-mo-0123456789abcdef',
            commandStatus: 'otp_received',
            otp: '654321',
            smsContent: 'Ma OTP Zalo cua ban la 654321'
        }
    );

    assert.equal(status.payload.ok, true);
    assert.equal(status.payload.status, 'otp_received');
    assert.equal(status.payload.otp, '654321');
    assert.match(status.payload.smsContent, /654321/);
});

test('does not leak an OTP from a port reserved by another request', () => {
    const status = buildGsmBridgeStatus(
        'zalo-mo-0123456789abcdef',
        { status: 'sent', machineId: 'PC_A', portId: 'COM9' },
        null,
        {
            commandId: 'zalo-mo-other-request',
            commandStatus: 'otp_received',
            otp: '111222'
        }
    );

    assert.equal(status.payload.status, 'running');
    assert.equal('otp' in status.payload, false);
});

test('returns a terminal GSM failure even if the web state update is delayed', () => {
    const status = buildGsmBridgeStatus(
        'zalo-mo-0123456789abcdef',
        {
            status: 'failed',
            machineId: 'PC_A',
            portId: 'COM9',
            error: 'Không gửi được SMS'
        },
        null,
        {
            commandId: 'zalo-mo-0123456789abcdef',
            commandStatus: 'queued'
        }
    );

    assert.equal(status.payload.status, 'failed');
    assert.equal(status.payload.error, 'Không gửi được SMS');
});

test('ignores the ToolGSM partial-patch malformed error and keeps waiting for OTP', () => {
    const status = buildGsmBridgeStatus(
        'zalo-mo-0123456789abcdef',
        {
            status: 'failed',
            machineId: 'PC_A',
            portId: '',
            error: 'Malformed command: required portId/recipient/content fields are missing.'
        },
        {
            status: 'running',
            machineId: 'PC_A',
            portId: 'COM9',
            recipient: '8066',
            content: 'ZALO'
        },
        {
            commandId: 'zalo-mo-0123456789abcdef',
            commandStatus: 'running'
        }
    );

    assert.equal(status.payload.status, 'running');
    assert.equal(status.payload.error, '');
});

test('ignores the ToolGSM partial-patch malformed error even if command is deleted and keeps waiting for OTP', () => {
    const status = buildGsmBridgeStatus(
        'zalo-mo-0123456789abcdef',
        {
            status: 'failed',
            machineId: 'PC_A',
            portId: '',
            error: 'Malformed command: required portId/recipient/content fields are missing.'
        },
        null,
        {
            portId: 'COM9',
            machineId: 'PC_A',
            commandId: 'zalo-mo-0123456789abcdef',
            commandStatus: 'running',
            smsSent: true
        }
    );

    assert.equal(status.payload.status, 'running');
    assert.equal(status.payload.error, '');
});

test('extracts OTP from webState even if result reports malformed command failure', () => {
    const status = buildGsmBridgeStatus(
        'zalo-mo-0123456789abcdef',
        {
            status: 'failed',
            machineId: 'PC_A',
            portId: '',
            error: 'Malformed command: required portId/recipient/content fields are missing.'
        },
        null,
        {
            portId: 'COM9',
            machineId: 'PC_A',
            commandId: 'zalo-mo-0123456789abcdef',
            commandStatus: 'running',
            smsSent: true,
            otp: '654321'
        }
    );

    assert.equal(status.payload.status, 'otp_received');
    assert.equal(status.payload.ok, true);
    assert.equal(status.payload.otp, '654321');
});

test('extracts an OTP from the inbound SMS when no explicit otp field exists', () => {
    assert.equal(
        extractGsmBridgeOtp({ smsContent: 'Ma xac nhan cua ban la 778899.' }),
        '778899'
    );
});

