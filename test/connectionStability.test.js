import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

function loadConnectionCheck({ heartbeatAge, status = 'offline' }) {
    const start = appSource.indexOf('function checkConnectionStatus');
    const end = appSource.indexOf('// Đóng modal khi nhấn ra ngoài');
    assert.ok(start >= 0 && end > start, 'Không tìm thấy hàm kiểm tra kết nối');

    const port = {
        machineId: 'PC_A',
        id: 'COM1',
        status,
        connectionStale: status !== 'online'
    };
    let renderCount = 0;
    const context = {
        state: { ports: [port] },
        lastSyncByMachine: { PC_A: Date.now() - heartbeatAge },
        serverTimeOffset: 0,
        MACHINE_OFFLINE_CONFIRM_MS: 5 * 60 * 1000,
        document: { querySelector() { return null; } },
        renderPorts() { renderCount += 1; }
    };
    vm.createContext(context);
    vm.runInContext(appSource.slice(start, end), context);
    context.checkConnectionStatus();
    return { context, port, renderCount };
}

test('keeps a COM online through a delayed heartbeat', () => {
    const result = loadConnectionCheck({ heartbeatAge: 60_000, status: 'offline' });

    assert.equal(result.context.state.ports.length, 1);
    assert.equal(result.port.status, 'online');
    assert.equal(result.port.connectionStale, false);
    assert.equal(result.renderCount, 1);
});

test('confirms a real disconnect only after five minutes', () => {
    const result = loadConnectionCheck({ heartbeatAge: 6 * 60_000, status: 'online' });

    assert.equal(result.context.state.ports.length, 0);
    assert.equal(result.renderCount, 1);
});

test('normalizes fresh machine snapshots to online', () => {
    const fetchStart = appSource.indexOf('function fetchPorts');
    const fetchEnd = appSource.indexOf('function applyWebStates');
    assert.ok(fetchStart >= 0 && fetchEnd > fetchStart);

    const fetchSource = appSource.slice(fetchStart, fetchEnd);
    assert.equal(fetchSource.includes('now - lastSync <= MACHINE_OFFLINE_CONFIRM_MS'), true);
    assert.equal(fetchSource.includes("status: 'online'"), true);
    assert.equal(fetchSource.includes('MACHINE_HEARTBEAT_TIMEOUT_MS'), false);
});
