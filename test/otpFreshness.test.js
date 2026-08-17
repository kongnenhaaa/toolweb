import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

function loadFreshnessHelpers(history = []) {
    const start = appSource.indexOf('function getHistoryOtpBarrier');
    const end = appSource.indexOf('function getTrustedPortOtp');
    assert.ok(start >= 0 && end > start, 'Không tìm thấy nhóm hàm chống OTP cũ');

    const context = {
        state: { history },
        normalizePhoneNumber(value) {
            return String(value || '').replace(/\D/g, '').replace(/^84/, '0');
        },
        getHistorySortTimestamp(item) {
            return Number(item?.timestamp || 0);
        }
    };
    vm.createContext(context);
    vm.runInContext(appSource.slice(start, end), context);
    return context;
}

function loadResetHelpers() {
    const start = appSource.indexOf('function getPortOtpToDismiss');
    const end = appSource.indexOf('window.cancelSmsWait');
    assert.ok(start >= 0 && end > start, 'Không tìm thấy nhóm hàm đặt lại cổng');

    const serverTimestamp = { '.sv': 'timestamp' };
    const context = {
        firebase: { database: { ServerValue: { TIMESTAMP: serverTimestamp } } },
        db: { ref() { return { set() {} }; } },
        CLIENT_SESSION_ID: 'test-client'
    };
    vm.createContext(context);
    vm.runInContext(appSource.slice(start, end), context);
    return { ...context, serverTimestamp };
}

const port = {
    machineId: 'PC_A',
    id: 'COM9',
    phone: '0912345678',
    smsRevision: 10
};

test('blocks an OTP already stored in GSM Local history', () => {
    const helpers = loadFreshnessHelpers([{
        machineId: 'PC_A',
        id: 'COM9',
        phone: '0912345678',
        otp: '123456',
        smsRevision: 10,
        timestamp: 1000,
        source: 'local'
    }]);

    assert.equal(helpers.shouldSuppressConsumedOtp(port, {}, '123456'), true);
});

test('keeps blocking after visible history is cleared by using dismissed marker', () => {
    const helpers = loadFreshnessHelpers([]);
    const webState = {
        dismissedOtp: '123456',
        dismissedSmsRevision: 10,
        dismissedAt: 1000
    };

    assert.equal(helpers.shouldSuppressConsumedOtp(port, webState, '123456'), true);
});

test('accepts the same numeric OTP only when ToolGSM publishes a newer revision', () => {
    const helpers = loadFreshnessHelpers([]);
    const webState = {
        dismissedOtp: '123456',
        dismissedSmsRevision: 10,
        dismissedAt: 1000
    };

    assert.equal(
        helpers.shouldSuppressConsumedOtp({ ...port, smsRevision: 11 }, webState, '123456'),
        false
    );
});

test('accepts a newer authoritative GSM command result', () => {
    const helpers = loadFreshnessHelpers([]);
    const webState = {
        otp: '123456',
        commandStatus: 'otp_received',
        otpReceivedAt: 2000,
        dismissedOtp: '123456',
        dismissedSmsRevision: 10,
        dismissedAt: 1000
    };

    assert.equal(helpers.shouldSuppressConsumedOtp(port, webState, '123456'), false);
});

test('accepts a different OTP newly published by GSM', () => {
    const helpers = loadFreshnessHelpers([{
        machineId: 'PC_A',
        id: 'COM9',
        phone: '0912345678',
        otp: '123456',
        smsRevision: 10,
        timestamp: 1000,
        source: 'local'
    }]);

    assert.equal(helpers.shouldSuppressConsumedOtp(port, {}, '654321'), false);
});

test('full reset keeps only the stale-OTP barrier and clears UI state', () => {
    const helpers = loadResetHelpers();
    const resetState = helpers.buildResetWebState(
        { ...port, otp: '123456' },
        { commandId: 'old-command', commandStatus: 'waiting', errorMsg: 'old-error' }
    );

    assert.equal(resetState.phone, '0912345678');
    assert.equal(resetState.dismissedOtp, '123456');
    assert.equal(resetState.dismissedSmsRevision, 10);
    assert.equal(resetState.dismissedAt, helpers.serverTimestamp);
    assert.equal('otp' in resetState, false);
    assert.equal('commandId' in resetState, false);
    assert.equal('commandStatus' in resetState, false);
    assert.equal('errorMsg' in resetState, false);
});

test('machine reset returns the COM to online and removes every OTP/SMS alias', () => {
    const helpers = loadResetHelpers();
    const payload = helpers.buildMachineOtpResetPayload();

    assert.equal(payload.status, 'online');
    assert.equal(payload.otp, null);
    assert.equal(payload.smsContent, null);
    assert.equal(payload.sms_message, null);
    assert.equal(payload.incomingSms, null);
    assert.equal(payload.lastReply, null);
    assert.equal(payload.errorMsg, null);
});

test('GSM Local SMS detail never falls back to OTP history', () => {
    const start = appSource.indexOf('function openSmsContentModal');
    const end = appSource.indexOf('window.openSmsContentModal');
    assert.ok(start >= 0 && end > start);

    const modalSource = appSource.slice(start, end);
    assert.equal(modalSource.includes('state.history'), false);
    assert.equal(modalSource.includes('historyItem'), false);
    assert.equal(modalSource.includes('shouldSuppressConsumedOtp'), true);
});

test('cancel all cleans orphan web states plus all related commands and results', () => {
    const start = appSource.indexOf('window.cancelAllSmsWait');
    const end = appSource.indexOf('window.clearAllCommandResults');
    assert.ok(start >= 0 && end > start);

    const cancelAllSource = appSource.slice(start, end);
    assert.equal(cancelAllSource.includes('globalWebStateRefs'), true);
    assert.equal(cancelAllSource.includes('orphanWebStates'), true);
    assert.equal(cancelAllSource.includes("db.ref('commands').once('value')"), true);
    assert.equal(cancelAllSource.includes("db.ref('command_results').once('value')"), true);
    assert.equal(cancelAllSource.includes('buildMachineOtpResetPayload'), true);
    assert.equal(cancelAllSource.includes('resetLocalPortToOnline'), true);
});

test('cancel all resets current ports and deletes web-state-only orphan records', async () => {
    const start = appSource.indexOf('function getPortOtpToDismiss');
    const end = appSource.indexOf('window.clearAllCommandResults');
    assert.ok(start >= 0 && end > start);

    const writes = [];
    const toasts = [];
    const ports = [
        { machineId: 'PC_A', id: 'COM1', phone: '0901', status: 'online', smsSent: true, commandStatus: 'queued', hidden: false },
        { machineId: 'PC_A', id: 'COM2', phone: '0902', status: 'error', otp: '222222', errorMsg: 'old', hidden: true }
    ];
    const snapshotValues = {
        commands: {
            cmd1: { machineId: 'PC_A', portId: 'COM1' },
            unrelated: { machineId: 'PC_B', portId: 'COM9' }
        },
        command_results: {
            result1: { machineId: 'PC_A', portId: 'COM2' },
            unrelatedResult: { machineId: 'PC_B', portId: 'COM9' }
        }
    };
    const serverTimestamp = { '.sv': 'timestamp' };
    const context = {
        window: {},
        isImpersonating: false,
        state: { ports },
        globalWebStates: {
            PC_A_COM1: { commandId: 'cmd1', commandStatus: 'queued' },
            PC_A_COM2: { hiddenOtp: '222222', hiddenMode: 'manual' },
            PC_A_COM3: { commandId: 'cmd3', commandStatus: 'running' }
        },
        globalWebStateRefs: {
            PC_A_COM1: { machineId: 'PC_A', portId: 'COM1' },
            PC_A_COM2: { machineId: 'PC_A', portId: 'COM2' },
            PC_A_COM3: { machineId: 'PC_A', portId: 'COM3' }
        },
        commandResults: { result1: snapshotValues.command_results.result1 },
        appliedCommandResults: { result1: 'old-signature' },
        firebase: { database: { ServerValue: { TIMESTAMP: serverTimestamp } } },
        CLIENT_SESSION_ID: 'test-client',
        cancelOtpAutoSave() {},
        renderPorts() {},
        renderOperationalPanels() {},
        showToast(message) { toasts.push(message); },
        db: {
            ref(path) {
                return {
                    once() {
                        return Promise.resolve({ val: () => snapshotValues[path] || null });
                    },
                    remove() {
                        writes.push({ method: 'remove', path });
                        return Promise.resolve();
                    },
                    set(value) {
                        writes.push({ method: 'set', path, value });
                        return Promise.resolve();
                    },
                    update(value) {
                        writes.push({ method: 'update', path, value });
                        return Promise.resolve();
                    }
                };
            }
        }
    };
    vm.createContext(context);
    vm.runInContext(appSource.slice(start, end), context);

    await context.window.cancelAllSmsWait();

    assert.equal(toasts[0], 'Đang đặt lại toàn bộ trạng thái cho 2 COM hiện tại...');
    assert.equal(toasts.at(-1), 'Đã đưa 2 COM hiện tại về trạng thái Online bình thường.');

    assert.equal(ports.every(item => item.status === 'online'), true);
    assert.equal(ports.every(item => item.hidden === false), true);
    assert.equal(ports.every(item => item.smsSent === false), true);
    assert.equal(ports.every(item => item.commandStatus === null), true);
    assert.equal(ports.every(item => item.errorMsg === null), true);

    const resetStatePaths = writes
        .filter(item => item.method === 'set' && item.path.startsWith('web_states/'))
        .map(item => item.path)
        .sort();
    assert.deepEqual(resetStatePaths, [
        'web_states/machines/PC_A/ports/COM1',
        'web_states/machines/PC_A/ports/COM2'
    ]);
    assert.equal(writes.some(item => item.method === 'remove'
        && item.path === 'web_states/machines/PC_A/ports/COM3'), true);
    assert.equal(writes.some(item => item.method === 'remove' && item.path === 'commands/cmd1'), true);
    assert.equal(writes.some(item => item.method === 'remove' && item.path === 'commands/cmd3'), true);
    assert.equal(writes.some(item => item.method === 'remove' && item.path === 'command_results/result1'), true);
    assert.equal(writes.some(item => item.method === 'remove' && item.path === 'commands/unrelated'), false);
});
