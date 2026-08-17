import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildGsmCommand,
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
