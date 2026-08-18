import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

function setupTestEnvironment(initialDbData = {}, initialLocalHistory = [], profile = { role: 'admin', email: 'admin@test.com', customerId: 'admin_cust' }) {
    let dbData = JSON.parse(JSON.stringify(initialDbData));
    const adminLogs = [];
    const toasts = [];

    const db = {
        ref(path) {
            return {
                once(event) {
                    if (path === 'tenants') {
                        return Promise.resolve({
                            val() {
                                return dbData.tenants || {};
                            }
                        });
                    }
                    if (path.startsWith('tenants/') && path.endsWith('/history')) {
                        const parts = path.split('/');
                        const tId = parts[1];
                        return Promise.resolve({
                            val() {
                                return dbData.tenants?.[tId]?.history || null;
                            }
                        });
                    }
                    return Promise.resolve({ val() { return null; } });
                },
                set(value) {
                    const parts = path.split('/');
                    if (parts[0] === 'tenants' && parts[2] === 'history') {
                        const tId = parts[1];
                        if (!dbData.tenants) dbData.tenants = {};
                        if (!dbData.tenants[tId]) dbData.tenants[tId] = {};
                        dbData.tenants[tId].history = value;
                    }
                    return Promise.resolve();
                },
                remove() {
                    const parts = path.split('/');
                    if (parts[0] === 'tenants' && parts[2] === 'history') {
                        const tId = parts[1];
                        if (dbData.tenants?.[tId]?.history) {
                            delete dbData.tenants[tId].history;
                        }
                    }
                    return Promise.resolve();
                },
                push(item) {
                    if (path === 'admin_logs') {
                        adminLogs.push(item);
                    }
                    return Promise.resolve();
                }
            };
        }
    };

    const localStorageStore = {
        'gsm_history_cust1': JSON.stringify(initialLocalHistory)
    };

    const localStorage = {
        getItem(key) { return localStorageStore[key] || null; },
        setItem(key, val) { localStorageStore[key] = String(val); },
        removeItem(key) { delete localStorageStore[key]; },
        key(i) { return Object.keys(localStorageStore)[i]; },
        get length() { return Object.keys(localStorageStore).length; }
    };

    const context = {
        window: {},
        isImpersonating: false,
        currentUserProfile: { ...profile },
        auth: { currentUser: { uid: profile.role === 'admin' ? 'admin_uid' : 'cust1_uid', email: profile.email } },
        state: { history: [...initialLocalHistory] },
        adminUsersData: {
            'u1': { customerId: 'cust1', email: 'cust1@test.com' }
        },
        adminStatsData: {},
        db,
        localStorage,
        firebase: { database: { ServerValue: { TIMESTAMP: Date.now() } } },
        showConfirm: async () => true,
        showToast: (msg, type) => { toasts.push({ msg, type }); },
        renderHistory: () => {},
        renderAdminUsers: () => {},
        loadDashboardData: () => {},
        document: {
            getElementById: (id) => {
                if (id === 'edit-user-uid') return { value: 'u1' };
                if (id === 'dashboard-tenant-select') return { value: 'all' };
                return null;
            }
        },
        console
    };

    vm.createContext(context);

    // Extract adminClearGsmLocalHistory and adminClearGsmLocalHistoryForModalUser functions
    const fnStart = appSource.indexOf('async function adminClearGsmLocalHistory');
    const fnEnd = appSource.indexOf('window.viewUserStats =', fnStart);
    assert.ok(fnStart >= 0 && fnEnd > fnStart, 'Không tìm thấy hàm adminClearGsmLocalHistory trong app.js');

    vm.runInContext(appSource.slice(fnStart, fnEnd), context);

    return { context, getDbData: () => dbData, adminLogs, toasts, localStorageStore };
}

test('Admin clears all GSM local items across all users while keeping 100% of Firefox API items', async () => {
    const initialDb = {
        tenants: {
            cust1: {
                history: {
                    'gsm_1': { id: 'COM1', machineId: 'M1', phone: '0911111111', otp: '123456', source: 'local' },
                    'gsm_2': { id: 'COM2', machineId: 'M1', phone: '0922222222', otp: '234567' },
                    'FIREFOX_key_1': { id: 'FF_123', machineId: 'FIREFOX_API', phone: '0933333333', otp: '345678', source: 'firefox' },
                    'FIREFOX_key_2': { id: 'FF_456', machineId: 'FIREFOX_API', phone: '0944444444', otp: '456789', source: 'firefox' }
                }
            },
            cust2: {
                history: {
                    'gsm_3': { id: 'COM3', machineId: 'M2', phone: '0955555555', otp: '567890', source: 'local' },
                    'FIREFOX_key_3': { id: 'FF_789', machineId: 'FIREFOX_API', phone: '0966666666', otp: '678901', source: 'firefox' }
                }
            }
        }
    };

    const initialLocal = [
        { id: 'COM1', machineId: 'M1', phone: '0911111111', otp: '123456', source: 'local' },
        { id: 'FF_123', machineId: 'FIREFOX_API', phone: '0933333333', otp: '345678', source: 'firefox' }
    ];

    const env = setupTestEnvironment(initialDb, initialLocal);

    await env.context.window.adminClearGsmLocalHistory();

    const dbResult = env.getDbData();

    // Tenant cust1 should have preserved the 2 Firefox items and removed the 2 GSM items
    assert.ok(dbResult.tenants.cust1.history, 'Tenant cust1 history should still exist');
    assert.equal(Object.keys(dbResult.tenants.cust1.history).length, 2);
    assert.ok(dbResult.tenants.cust1.history['FIREFOX_key_1']);
    assert.ok(dbResult.tenants.cust1.history['FIREFOX_key_2']);
    assert.equal(dbResult.tenants.cust1.history['gsm_1'], undefined);
    assert.equal(dbResult.tenants.cust1.history['gsm_2'], undefined);

    // Tenant cust2 should have preserved the 1 Firefox item and removed the 1 GSM item
    assert.ok(dbResult.tenants.cust2.history, 'Tenant cust2 history should still exist');
    assert.equal(Object.keys(dbResult.tenants.cust2.history).length, 1);
    assert.ok(dbResult.tenants.cust2.history['FIREFOX_key_3']);
    assert.equal(dbResult.tenants.cust2.history['gsm_3'], undefined);

    // Memory state.history should only contain Firefox items
    assert.equal(env.context.state.history.length, 1);
    assert.equal(env.context.state.history[0].source, 'firefox');
    assert.equal(env.context.state.history[0].phone, '0933333333');

    // LocalStorage should only contain Firefox items
    const localParsed = JSON.parse(env.localStorageStore['gsm_history_cust1']);
    assert.equal(localParsed.length, 1);
    assert.equal(localParsed[0].source, 'firefox');

    // Admin log should record CLEAR_GSM_HISTORY
    assert.equal(env.adminLogs.length, 1);
    assert.equal(env.adminLogs[0].action, 'CLEAR_GSM_HISTORY');
});

test('Customer can clear their own GSM local history and keep their Firefox history', async () => {
    const initialDb = {
        tenants: {
            cust1: {
                history: {
                    'gsm_1': { id: 'COM1', machineId: 'M1', phone: '0911111111', otp: '123456', source: 'local' },
                    'FIREFOX_key_1': { id: 'FF_123', machineId: 'FIREFOX_API', phone: '0933333333', otp: '345678', source: 'firefox' }
                }
            },
            cust2: {
                history: {
                    'gsm_2': { id: 'COM2', machineId: 'M2', phone: '0955555555', otp: '567890', source: 'local' }
                }
            }
        }
    };

    const initialLocal = [
        { id: 'COM1', machineId: 'M1', phone: '0911111111', otp: '123456', source: 'local' },
        { id: 'FF_123', machineId: 'FIREFOX_API', phone: '0933333333', otp: '345678', source: 'firefox' }
    ];

    // Customer cust1 logs in
    const env = setupTestEnvironment(initialDb, initialLocal, { role: 'customer', email: 'cust1@test.com', customerId: 'cust1' });

    await env.context.window.adminClearGsmLocalHistory();

    const dbResult = env.getDbData();

    // cust1: GSM removed, Firefox preserved
    assert.equal(dbResult.tenants.cust1.history['gsm_1'], undefined);
    assert.ok(dbResult.tenants.cust1.history['FIREFOX_key_1']);

    // cust2: untouched because cust1 can only clear cust1
    assert.ok(dbResult.tenants.cust2.history['gsm_2']);

    // in-memory state only has firefox
    assert.equal(env.context.state.history.length, 1);
    assert.equal(env.context.state.history[0].source, 'firefox');
});

test('adminClearGsmLocalHistoryForModalUser clears GSM local OTP history for specific modal customer', async () => {
    const initialDb = {
        tenants: {
            cust1: {
                history: {
                    'gsm_1': { id: 'COM1', machineId: 'M1', phone: '0911111111', otp: '123456', source: 'local' },
                    'FIREFOX_key_1': { id: 'FF_123', machineId: 'FIREFOX_API', phone: '0933333333', otp: '345678', source: 'firefox' }
                }
            },
            cust2: {
                history: {
                    'gsm_2': { id: 'COM2', machineId: 'M2', phone: '0955555555', otp: '567890', source: 'local' }
                }
            }
        }
    };

    const env = setupTestEnvironment(initialDb, []);

    // Trigger modal clear for u1 (cust1)
    await env.context.window.adminClearGsmLocalHistoryForModalUser();

    const dbResult = env.getDbData();

    // cust1: GSM item removed, Firefox item preserved
    assert.equal(dbResult.tenants.cust1.history['gsm_1'], undefined);
    assert.ok(dbResult.tenants.cust1.history['FIREFOX_key_1']);

    // cust2: untouched because we only cleared cust1
    assert.ok(dbResult.tenants.cust2.history['gsm_2']);
});
