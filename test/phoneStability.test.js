import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

function loadPhoneHelpers() {
    const start = appSource.indexOf('function normalizePhoneNumber');
    const end = appSource.indexOf('const ALLOWED_ZALO_SMS_ENDPOINTS');
    assert.ok(start >= 0 && end > start, 'Không tìm thấy nhóm hàm ổn định SĐT');

    const context = {
        pendingPortPhoneChanges: new Map(),
        PHONE_CHANGE_CONFIRMATIONS: 3,
        PHONE_CHANGE_STABLE_MS: 4000,
        getServerNow: () => 0,
        normalizeText: value => String(value || '').toLowerCase()
    };
    vm.createContext(context);
    vm.runInContext(appSource.slice(start, end), context);
    return context;
}

const existingPort = {
    machineId: 'PC_A',
    id: 'COM1',
    phone: '0912345678'
};

test('ignores a one-snapshot phone number glitch', () => {
    const helpers = loadPhoneHelpers();
    const incoming = { ...existingPort, phone: '0987654321' };

    assert.equal(helpers.getStablePortPhone(incoming, existingPort, 0), '0912345678');
    assert.equal(
        helpers.getStablePortPhone({ ...existingPort }, existingPort, 2000),
        '0912345678'
    );
    assert.equal(helpers.pendingPortPhoneChanges.size, 0);
});

test('accepts a real phone change after three stable snapshots and four seconds', () => {
    const helpers = loadPhoneHelpers();
    const incoming = { ...existingPort, phone: '0987654321' };

    assert.equal(helpers.getStablePortPhone(incoming, existingPort, 0), '0912345678');
    assert.equal(helpers.getStablePortPhone(incoming, existingPort, 2000), '0912345678');
    assert.equal(helpers.getStablePortPhone(incoming, existingPort, 4000), '0987654321');
});

test('never accepts alternating phone numbers from mixed COM snapshots', () => {
    const helpers = loadPhoneHelpers();
    const firstWrong = { ...existingPort, phone: '0987654321' };
    const secondWrong = { ...existingPort, phone: '0977777777' };

    assert.equal(helpers.getStablePortPhone(firstWrong, existingPort, 0), '0912345678');
    assert.equal(helpers.getStablePortPhone(secondWrong, existingPort, 3000), '0912345678');
    assert.equal(helpers.getStablePortPhone(firstWrong, existingPort, 6000), '0912345678');
});

test('normalizes +84 and 0 formats as the same Vietnamese phone number', () => {
    const helpers = loadPhoneHelpers();
    const incoming = { ...existingPort, phone: '+84 912 345 678' };

    assert.equal(helpers.getStablePortPhone(incoming, existingPort, 0), '0912345678');
    assert.equal(helpers.pendingPortPhoneChanges.size, 0);
});

test('the Firebase merge applies phone stabilization before rendering', () => {
    const fetchStart = appSource.indexOf('function fetchPorts');
    const fetchEnd = appSource.indexOf('function applyWebStates');
    assert.ok(fetchStart >= 0 && fetchEnd > fetchStart);

    const fetchSource = appSource.slice(fetchStart, fetchEnd);
    assert.equal(fetchSource.includes('newPort.phone = getStablePortPhone(newPort, existingPort, now)'), true);
    assert.equal(fetchSource.includes('getCanonicalPortId(firebasePortId, portValue)'), true);
});

test('uses the Firebase COM key when a payload temporarily reports another COM', () => {
    const helpers = loadPhoneHelpers();

    assert.equal(
        helpers.getCanonicalPortId('COM3', { id: 'COM8', portId: 'COM8' }),
        'COM3'
    );
    assert.equal(
        helpers.getCanonicalPortId('firebase-key', { id: 'COM8' }),
        'COM8'
    );
});
