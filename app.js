const state = {
    ports: [],
    history: [],
    firefoxPorts: [],
    currentActionPortId: null
};

let lastSyncTime = 0;
let lastSyncByMachine = {};
let serverTimeOffset = 0;
let globalWebStates = {};
let globalWebStateRefs = {};
let pendingBalanceChecks = new Set();
let autoHistoryTimeouts = {};
let commandResults = {};
let appliedCommandResults = {};
let sendingSmsPorts = new Set();
let soundEnabled = localStorage.getItem('gsm_sound_enabled') !== 'false'; // default true

const SMS_WAIT_TIMEOUT_MS = 120000;
const BALANCE_WAIT_TIMEOUT_MS = 45000;
const COMMAND_STALE_TIMEOUT_MS = 10 * 60 * 1000;
const BALANCE_COMMAND_SPACING_MS = 1200;
const COMMAND_IN_FLIGHT_STATUSES = new Set(['queued', 'running']);
const COMMAND_SUCCESS_STATUSES = new Set(['sent', 'done', 'success', 'maybe_sent']);
const COMMAND_FAILED_STATUSES = new Set(['failed', 'timeout', 'error']);
const CLIENT_SESSION_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

let currentUserProfile = null;
let isImpersonating = false;
window.viewingTenantId = null;

function getTenantId() {
    if (window.viewingTenantId) return window.viewingTenantId;
    if (!currentUserProfile || !currentUserProfile.customerId) {
        throw new Error("Lỗi hệ thống: Chưa có thông tin user, không thể xác định Tenant ID");
    }
    return currentUserProfile.customerId;
}

function tenantPath(path) {
    return `tenants/${getTenantId()}/${path}`;
}

function tenantStorageKey(key) {
    return `${key}_${getTenantId()}`;
}


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

window.showConfirm = function(message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('custom-confirm-modal');
        const msgEl = document.getElementById('custom-confirm-message');
        const btnOk = document.getElementById('custom-confirm-ok');
        const btnCancel = document.getElementById('custom-confirm-cancel');
        
        msgEl.innerHTML = String(message).replace(/\n/g, '<br>');
        modal.classList.add('active');
        
        const cleanup = () => {
            modal.classList.remove('active');
            btnOk.removeEventListener('click', onOk);
            btnCancel.removeEventListener('click', onCancel);
        };
        
        const onOk = () => { cleanup(); resolve(true); };
        const onCancel = () => { cleanup(); resolve(false); };
        
        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
    });
};

function getServerNow() {
    return Date.now() + serverTimeOffset;
}

function toFirebaseKey(value) {
    return String(value || 'NONE').replace(/[.#$/\[\]]/g, '_');
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

function parseBalanceValue(balance) {
    if (!balance) return 0;
    return parseInt(String(balance).replace(/[^\d]/g, ''), 10) || 0;
}

function normalizePhoneNumber(phone) {
    if (phone == null) return phone;
    return String(phone).replace(/\s+/g, '').trim();
}

function getPortUiStatus(port) {
    if (port.errorMsg) return 'error';
    if (COMMAND_IN_FLIGHT_STATUSES.has(port.commandStatus)) return 'busy';
    if (port.commandStatus === 'maybe_sent') return 'maybe_sent';
    if (port.otp) return 'otp';
    if (port.smsSent) return 'waiting';
    return port.status === 'online' ? 'online' : 'offline';
}

function getPortUiStatusLabel(status) {
    return {
        online: 'Online',
        offline: 'Offline',
        waiting: 'Chờ OTP',
        maybe_sent: 'Có thể đã gửi',
        otp: 'Có OTP',
        error: 'Lỗi',
        busy: 'Đang chạy'
    }[status] || status;
}

function updateSelectOptions(selectId, values) {
    const select = document.getElementById(selectId);
    if (!select) return;

    const current = select.value;
    const firstLabel = select.options[0]?.textContent || 'Tất cả';
    select.innerHTML = `<option value="">${firstLabel}</option>`;

    [...new Set(values.filter(Boolean))].sort().forEach(value => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
    });

    if ([...select.options].some(option => option.value === current)) {
        select.value = current;
    }
}

function getStoredOrder(storageKey) {
    try {
        const value = JSON.parse(localStorage.getItem(storageKey) || '[]');
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
}

function saveStoredOrder(storageKey, container) {
    const order = Array.from(container.children)
        .map(child => child.dataset.dragKey)
        .filter(Boolean);
    localStorage.setItem(storageKey, JSON.stringify(order));
}

function sortByStoredOrder(items, storageKey) {
    const order = getStoredOrder(storageKey);
    if (!order.length) return items;
    return [...items].sort((a, b) => {
        const aIndex = order.indexOf(a.key);
        const bIndex = order.indexOf(b.key);
        return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
    });
}

function applyStoredDomOrder(container, storageKey) {
    const order = getStoredOrder(storageKey);
    if (!order.length) return;

    order.forEach(key => {
        const child = Array.from(container.children).find(el => el.dataset.dragKey === key);
        if (child) container.appendChild(child);
    });
}

function enableDragSort(container, storageKey) {
    if (!container || container.dataset.dragReady === 'true') return;
    container.dataset.dragReady = 'true';
    applyStoredDomOrder(container, storageKey);

    container.addEventListener('dragstart', event => {
        const item = event.target.closest('[data-drag-key]');
        if (!item || item.parentElement !== container) return;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', item.dataset.dragKey || '');
        item.classList.add('dragging-card');
    });

    container.addEventListener('dragend', event => {
        const item = event.target.closest('[data-drag-key]');
        if (item) item.classList.remove('dragging-card');
        container.querySelectorAll('.drag-over-card').forEach(el => el.classList.remove('drag-over-card'));
        saveStoredOrder(storageKey, container);
    });

    container.addEventListener('dragover', event => {
        const overItem = event.target.closest('[data-drag-key]');
        if (!overItem || overItem.parentElement !== container) return;
        event.preventDefault();
        overItem.classList.add('drag-over-card');
    });

    container.addEventListener('dragleave', event => {
        const overItem = event.target.closest('[data-drag-key]');
        if (overItem) overItem.classList.remove('drag-over-card');
    });

    container.addEventListener('drop', event => {
        const target = event.target.closest('[data-drag-key]');
        const dragging = container.querySelector('.dragging-card');
        if (!target || !dragging || target === dragging || target.parentElement !== container) return;
        event.preventDefault();

        const rect = target.getBoundingClientRect();
        const insertAfter = event.clientY > rect.top + rect.height / 2 || event.clientX > rect.left + rect.width / 2;
        container.insertBefore(dragging, insertAfter ? target.nextSibling : target);
        target.classList.remove('drag-over-card');
        saveStoredOrder(storageKey, container);
    });
}

function updateAdvancedFilterOptions() {
    updateSelectOptions('filter-machine', state.ports.filter(p => !p.isTest).map(p => p.machineId));
    updateSelectOptions('filter-network', state.ports.filter(p => !p.isTest).map(p => p.networkProvider || p.network || ''));
}

function renderOpsDashboard() {
    const dashboard = document.getElementById('ops-dashboard');
    if (!dashboard) return;

    const ports = state.ports.filter(p => !p.isTest && !p.hidden);
    const online = ports.filter(p => p.status === 'online').length;
    const offline = ports.length - online;
    const waitingOtp = ports.filter(p => p.smsSent && !p.otp && !p.errorMsg).length;
    const smsErrors = ports.filter(p => p.errorMsg).length;
    const runningCommands = ports.filter(p => COMMAND_IN_FLIGHT_STATUSES.has(p.commandStatus)).length;
    const now = getServerNow();
    const lostMachines = Object.entries(lastSyncByMachine).filter(([, sync]) => now - sync > 15000).length;

    const cards = sortByStoredOrder([
        { key: 'ports', icon: 'server', label: 'Cổng online/offline', value: `${online}/${offline}`, tone: online ? 'success' : 'muted' },
        { key: 'waiting-otp', icon: 'clock', label: 'SIM chờ OTP', value: waitingOtp, tone: waitingOtp ? 'warning' : 'muted' },
        { key: 'sms-errors', icon: 'alert-triangle', label: 'Cổng có lỗi SMS', value: smsErrors, tone: smsErrors ? 'danger' : 'muted' },
        { key: 'running-commands', icon: 'activity', label: 'Command đang chạy', value: runningCommands, tone: runningCommands ? 'warning' : 'muted' },
        { key: 'lost-machines', icon: 'wifi-off', label: 'Máy mất kết nối', value: lostMachines, tone: lostMachines ? 'danger' : 'muted' }
    ], 'ops_dashboard_order');

    dashboard.innerHTML = cards.map(({ key, icon, label, value, tone }) => `
        <div class="metric-card ${tone}" data-drag-key="${key}" draggable="true" title="Kéo để sắp xếp">
            <div class="metric-label"><i data-lucide="${icon}"></i>${label}</div>
            <div class="metric-value">${escapeHtml(value)}</div>
        </div>
    `).join('');
    enableDragSort(dashboard, 'ops_dashboard_order');
}

function renderErrorPanel() {
    const list = document.getElementById('error-panel-list');
    const count = document.getElementById('error-panel-count');
    if (!list || !count) return;

    const ports = state.ports
        .filter(p => !p.isTest && !p.hidden)
        .filter(p => p.errorMsg)
        .sort((a, b) => ((b.timeoutCount || 0) + (b.smsErrorCount || 0)) - ((a.timeoutCount || 0) + (a.smsErrorCount || 0)))
        .slice(0, 8);

    count.textContent = ports.length;
    if (!ports.length) {
        list.innerHTML = '<div class="ops-empty">Không có lỗi cần xử lý.</div>';
        return;
    }

    list.innerHTML = ports.map(port => {
        const err = normalizeSmsError(port.errorMsg);
        const totalErrors = (port.timeoutCount || 0) + (port.smsErrorCount || 0);
        return `
            <div class="ops-item">
                <div>
                    <div class="ops-title">
                        <span class="status-pill failed">${escapeHtml(port.id)}</span>
                        <span>${escapeHtml(port.machineId || 'UNKNOWN')}</span>
                    </div>
                    <div class="ops-sub">${escapeHtml(err)} · TO:${port.timeoutCount || 0} SMS:${port.smsErrorCount || 0} RC:${port.reconnectCount || 0}</div>
                </div>
                <div class="ops-actions">
                    <button class="btn btn-outline" onclick="cancelSmsWait('${port.id}', '${port.machineId}')">Hủy chờ OTP</button>
                    <button class="btn btn-primary" onclick="openSmsModal('${port.id}', '${port.machineId}')">Gửi lại</button>
                    <button class="btn btn-secondary" onclick="checkBalance('${port.id}', '${port.machineId}')">TKC</button>
                </div>
            </div>
        `;
    }).join('');
}

function renderCommandMonitor() {
    const list = document.getElementById('command-monitor-list');
    const count = document.getElementById('command-panel-count');
    if (!list || !count) return;

    const rows = Object.entries(commandResults || {})
        .map(([id, result]) => ({ id, ...result }))
        .filter(result => result.machineId && result.portId)
        .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
        .slice(0, 12);

    const activeCount = rows.filter(r => COMMAND_IN_FLIGHT_STATUSES.has(r.status)).length;
    count.textContent = activeCount || rows.length;

    if (!rows.length) {
        list.innerHTML = '<div class="ops-empty">Chưa có command nào.</div>';
        return;
    }

    list.innerHTML = rows.map(result => {
        const status = result.status || 'unknown';
        const time = result.updatedAt ? new Date(result.updatedAt).toLocaleTimeString('vi-VN') : '--:--';
        const content = result.type === 'balance' ? 'Kiểm tra TKC' : (result.content || '');
        const port = state.ports.find(p => p.id === result.portId && p.machineId === result.machineId);
        const otp = port?.otp ? escapeHtml(String(port.otp)) : '<span style="color: var(--text-muted);">--</span>';
        return `
            <div class="ops-item">
                <div>
                    <div class="ops-title">${escapeHtml(result.portId)} <span class="status-pill ${escapeHtml(status)}">${escapeHtml(getCommandStatusText(status, result.type) || status)}</span></div>
                    <div class="ops-sub">${escapeHtml(result.machineId)} · ${escapeHtml(result.recipient || '')}</div>
                    <div class="ops-sub">OTP: ${otp}</div>
                </div>
                <div class="ops-sub">${escapeHtml(content)}</div>
                <div class="ops-sub">${escapeHtml(time)}</div>
            </div>
        `;
    }).join('');
}

function renderOperationalPanels() {
    updateAdvancedFilterOptions();
    enableDragSort(document.querySelector('.ops-panels'), 'ops_panel_order');
    renderOpsDashboard();
    renderErrorPanel();
    renderCommandMonitor();
    if (window.lucide) {
        lucide.createIcons();
    }
}

function isSpecificSmsError(message) {
    if (!message) return false;
    return message.includes('Chọn sai đầu số')
        || message.includes('SĐT đang không yêu cầu mã')
        || message.includes('Hết tiền');
}

function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .toLowerCase();
}

function isActionableSmsError(message) {
    const rawLower = String(message || '').toLowerCase();
    const normalized = normalizeText(message);
    if (!normalized) return false;

    return isSpecificSmsError(message)
        || normalized.includes('chon sai dau so')
        || normalized.includes('sai dau so')
        || normalized.includes('sai cu phap')
        || normalized.includes('sdt dang khong yeu cau ma')
        || normalized.includes('khong yeu cau ma')
        || normalized.includes('khong co yeu cau ma')
        || normalized.includes('khong thuc hien yeu cau')
        || normalized.includes('het tien')
        || normalized.includes('khong du tien')
        || rawLower.includes('hết tiền')
        || rawLower.includes('sai đầu số');
}

function normalizeSmsError(message, fallback = 'Lệnh thất bại') {
    const raw = String(message || '').trim();
    const rawLower = raw.toLowerCase();
    const normalized = normalizeText(raw);

    if (!raw) return fallback;
    if (normalized.includes('chon sai dau so') || normalized.includes('sai dau so') || normalized.includes('sai cu phap') || rawLower.includes('sai đầu số')) {
        return 'Chọn sai đầu số';
    }
    if (normalized.includes('sdt dang khong yeu cau ma') || normalized.includes('khong yeu cau ma') || normalized.includes('khong co yeu cau ma') || normalized.includes('khong thuc hien yeu cau')) {
        return 'SĐT đang không yêu cầu mã';
    }
    if (normalized.includes('het tien') || normalized.includes('khong du tien') || rawLower.includes('hết tiền')) {
        return 'Hết tiền';
    }
    if (normalized.includes('qua thoi gian cho otp')) {
        return 'Quá thời gian chờ OTP';
    }
    if (normalized.includes('timeout') || normalized.includes('maybe_sent')) {
        return 'Có thể đã gửi';
    }
    return raw;
}

function getCommandStatusText(status, type = 'sms') {
    if (status === 'queued') return 'Đang xếp hàng';
    if (status === 'running') return type === 'balance' ? 'Đang kiểm tra số dư' : 'Đang gửi SMS';
    if (status === 'sent') return 'Đã gửi SMS';
    if (status === 'maybe_sent') return 'Có thể đã gửi';
    if (status === 'done' || status === 'success') return type === 'balance' ? 'Đã kiểm tra số dư' : 'Hoàn tất';
    if (status === 'failed') return 'Lỗi';
    if (status === 'timeout') return 'Quá thời gian';
    return '';
}

async function createCommand({ machineId, portId, recipient, content, type = 'sms', commandId = null }) {
    const commandRef = commandId ? db.ref(`commands/${commandId}`) : db.ref('commands').push();
    commandId = commandId || commandRef.key;
    await commandRef.set({
        id: commandId,
        machineId,
        portId,
        recipient,
        content,
        type,
        status: 'queued',
        clientSessionId: CLIENT_SESSION_ID,
        createdAt: firebase.database.ServerValue.TIMESTAMP,
        updatedAt: firebase.database.ServerValue.TIMESTAMP
    });
    return commandId;
}

async function reservePortCommand({ machineId, portId, commandId, type = 'sms', phone = 'NONE' }) {
    const stateRef = db.ref(`web_states/machines/${machineId}/ports/${portId}`);
    const result = await stateRef.transaction(current => {
        current = current || {};
        if (COMMAND_IN_FLIGHT_STATUSES.has(current.commandStatus)) return;
        if (type === 'sms' && current.smsSent && !isActionableSmsError(current.errorMsg)) return;

        return {
            ...current,
            smsSent: type === 'sms' ? true : (current.smsSent || false),
            smsSentTime: type === 'sms' ? firebase.database.ServerValue.TIMESTAMP : (current.smsSentTime || null),
            commandId,
            commandIds: null,
            commandStatus: 'queued',
            errorMsg: null,
            phone: phone || current.phone || 'NONE',
            reservedBy: CLIENT_SESSION_ID,
            reservedAt: firebase.database.ServerValue.TIMESTAMP,
            updatedAt: firebase.database.ServerValue.TIMESTAMP
        };
    }, undefined, false);

    return result.committed;
}

async function releasePortCommandReservation(machineId, portId, commandId, errorMsg = null) {
    await updateCommandStateIfCurrent(machineId, portId, commandId, {
        smsSent: false,
        commandId: null,
        commandIds: null,
        commandStatus: errorMsg ? 'failed' : null,
        errorMsg,
        releasedAt: firebase.database.ServerValue.TIMESTAMP
    });
}

async function cleanupStalePortCommands() {
    const now = getServerNow();
    const entries = Object.entries(globalWebStates || {});

    for (const [stateKey, webState] of entries) {
        if (!webState || !COMMAND_IN_FLIGHT_STATUSES.has(webState.commandStatus)) continue;

        const marker = Math.max(
            Number(webState.updatedAt || 0),
            Number(webState.reservedAt || 0),
            Number(webState.smsSentTime || 0)
        );
        if (!marker || now - marker < COMMAND_STALE_TIMEOUT_MS) continue;

        const stateRef = globalWebStateRefs[stateKey];
        if (!stateRef) continue;
        const { machineId, portId } = stateRef;
        const commandId = webState.commandId || null;

        if (commandId) {
            await db.ref(`commands/${commandId}`).remove();
        }

        await updateCommandStateIfCurrent(machineId, portId, commandId, {
            smsSent: false,
            commandId: null,
            commandIds: null,
            commandStatus: 'timeout',
            errorMsg: 'Command stuck over 10 minutes, auto cleaned',
            timedOutAt: firebase.database.ServerValue.TIMESTAMP
        });
    }
}

async function updateCommandStateIfCurrent(machineId, portId, commandId, payload) {
    const stateRef = db.ref(`web_states/machines/${machineId}/ports/${portId}`);
    const snapshot = await stateRef.once('value');
    const current = snapshot.val() || {};
    const commandIds = Array.isArray(current.commandIds) ? current.commandIds : [];
    const isBatchCommand = commandIds.includes(commandId);
    const isCurrentSmsWaitTimeout = payload?.commandStatus === 'timeout'
        && current.commandId === commandId
        && current.smsSent === true;
    if (!current.commandId && commandIds.length === 0) return false;
    if (current.commandId && current.commandId !== commandId && !isBatchCommand) return false;
    if (!isCurrentSmsWaitTimeout && !isBatchCommand && current.commandId !== commandId && current.commandStatus && !COMMAND_IN_FLIGHT_STATUSES.has(current.commandStatus)) return false;
    await stateRef.update(payload);
    return true;
}

async function applyCommandResult(commandId, result) {
    if (!result || !result.machineId || !result.portId) return false;
    if (result.updatedAt && getServerNow() - result.updatedAt > 10 * 60 * 1000) return false;

    const stateKey = `${result.machineId}_${result.portId}`;
    const webState = globalWebStates[stateKey] || {};
    const webStateCommandIds = Array.isArray(webState.commandIds) ? webState.commandIds : [];
    const port = state.ports.find(p => p.id === result.portId && p.machineId === result.machineId);
    const isOwnResult = webState.reservedBy === CLIENT_SESSION_ID || port?.commandId === commandId;
    if (!isOwnResult) return false;
    if (webState.commandId && webState.commandId !== commandId && !webStateCommandIds.includes(commandId)) return false;
    if (!webState.commandId && webStateCommandIds.length === 0 && port?.commandId !== commandId) return false;

    const status = result.status || 'unknown';
    const type = result.type || (result.recipient === 'USSD' ? 'balance' : 'sms');

    if (type === 'balance') {
        pendingBalanceChecks.delete(stateKey);
    }

    if (port) {
        port.commandId = commandId;
        port.commandStatus = status;
    }

    if (COMMAND_FAILED_STATUSES.has(status)) {
        const currentError = webState.errorMsg || null;
        const nextError = isActionableSmsError(currentError)
            ? normalizeSmsError(currentError)
            : normalizeSmsError(result.error);

        pendingBalanceChecks.delete(stateKey);
        const didUpdate = await updateCommandStateIfCurrent(result.machineId, result.portId, commandId, {
            smsSent: false,
            commandId,
            commandStatus: 'failed',
            errorMsg: nextError,
            failedAt: firebase.database.ServerValue.TIMESTAMP
        });
        if (!didUpdate) return false;
        if (port) {
            port.smsSent = false;
            port.errorMsg = nextError;
        }
    } else if (COMMAND_SUCCESS_STATUSES.has(status)) {
        const currentError = webState.errorMsg || null;
        const updatePayload = {
            commandId,
            commandStatus: status
        };
        if (type !== 'sms') {
            updatePayload.commandStatus = null;
        }
        if (!isActionableSmsError(currentError)) {
            updatePayload.errorMsg = null;
        }

        const didUpdate = await updateCommandStateIfCurrent(result.machineId, result.portId, commandId, updatePayload);
        if (!didUpdate) return false;
        if (port) {
            port.errorMsg = isActionableSmsError(currentError) ? normalizeSmsError(currentError) : null;
            if (type !== 'sms') {
                port.commandStatus = null;
            }
        }
    }

    renderPorts();
    return true;
}


function scheduleAutoHistory(portId, machineId) {
    // Dùng key kết hợp portId và machineId để tránh xung đột
    const timeoutKey = `${machineId}_${portId}`;
    if (autoHistoryTimeouts[timeoutKey]) {
        clearTimeout(autoHistoryTimeouts[timeoutKey]);
    }

    // Tự động chuyển qua lịch sử sau 20 giây
    autoHistoryTimeouts[timeoutKey] = setTimeout(() => {
        const port = state.ports.find(p => p.id === portId && p.machineId === machineId);
        // Chỉ tự động chuyển nếu cổng chưa bị ẩn (tránh bị push trùng từ nhiều máy khách cùng lúc)
        if (port && !port.hidden) {
            markAsUsed(portId, machineId);
        }
    }, 20000);
}

// Âm thanh thông báo OTP (Web Audio API - không cần file ngoài)
function playNotificationSound() {
    if (!soundEnabled) return;
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();

        // Beep 1
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.frequency.value = 880;
        osc1.type = 'sine';
        gain1.gain.setValueAtTime(0.3, ctx.currentTime);
        gain1.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
        osc1.start(ctx.currentTime);
        osc1.stop(ctx.currentTime + 0.15);

        // Beep 2 (cao hơn, sau 0.18s)
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.frequency.value = 1100;
        osc2.type = 'sine';
        gain2.gain.setValueAtTime(0.3, ctx.currentTime + 0.18);
        gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
        osc2.start(ctx.currentTime + 0.18);
        osc2.stop(ctx.currentTime + 0.4);
    } catch (e) { }
}

// Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyABuwTpbvTPboWLuyYzgNioJH2lIz6LuaQ",
    authDomain: "toolweb-c7702.firebaseapp.com",
    databaseURL: "https://toolweb-c7702-default-rtdb.firebaseio.com",
    projectId: "toolweb-c7702",
    storageBucket: "toolweb-c7702.firebasestorage.app",
    messagingSenderId: "643046962878",
    appId: "1:643046962878:web:64ce44407374f92c3250ef",
    measurementId: "G-8ZSDRN39PB"
};

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

let secondaryApp;
if (!firebase.apps.find(app => app.name === "Secondary")) {
    secondaryApp = firebase.initializeApp(firebaseConfig, "Secondary");
} else {
    secondaryApp = firebase.app("Secondary");
}

const db = firebase.database();
const auth = firebase.auth();

// Lấy độ lệch thời gian giữa Client và Firebase Server
db.ref('.info/serverTimeOffset').on('value', function (snapshot) {
    serverTimeOffset = snapshot.val() || 0;
});

// Fetch real data from Firebase
let isInitialFirebaseLoad = true;

function fetchPorts() {
    db.ref('machines').on('value', (snapshot) => {
        const machinesData = snapshot.val();
        let allPorts = [];
        const now = Date.now() + serverTimeOffset;

        if (machinesData) {
            // Duyệt qua từng máy tính
            Object.keys(machinesData).forEach(machineId => {
                const machineNode = machinesData[machineId];

                let lastSync = 0;
                if (machineNode.server_status && machineNode.server_status.lastSync) {
                    lastSync = machineNode.server_status.lastSync;
                    lastSyncByMachine[machineId] = lastSync;
                }

                // Chỉ lấy cổng của những máy tính đang sống (cập nhật trong 15s gần nhất)
                if (now - lastSync <= 15000) {
                    if (machineNode.ports) {
                        const portsArray = Object.values(machineNode.ports).filter(p => p);
                        portsArray.forEach(p => p.machineId = machineId); // Gắn thêm thông tin máy
                        allPorts = allPorts.concat(portsArray);
                    }
                }
            });
        }

        allPorts.forEach(newPort => {
            if (newPort.phone) {
                newPort.phone = normalizePhoneNumber(newPort.phone);
            }
            const existingPort = state.ports.find(p => p.id === newPort.id && p.machineId === newPort.machineId);

            // Giữ lại OTP trên giao diện nếu C# lỡ xoá sớm (nhưng SĐT vẫn giữ nguyên)
            if (!newPort.otp && existingPort && existingPort.otp && existingPort.phone === newPort.phone) {
                newPort.otp = existingPort.otp;
            }

            // Giữ lại thời gian bắt đầu đếm ngược để không bị reset khi Firebase cập nhật
            if (existingPort && existingPort.smsSentTime) {
                newPort.smsSentTime = existingPort.smsSentTime;
            }

            if (newPort.otp) {
                scheduleAutoHistory(newPort.id, newPort.machineId);
                // Chỉ thông báo nếu không phải lần tải dữ liệu đầu tiên khi vừa mở/refresh trang web
                if (!isInitialFirebaseLoad && (!existingPort || existingPort.otp !== newPort.otp)) {
                    // Có thể thêm âm thanh ở đây nếu cần
                }
            }
        });

        isInitialFirebaseLoad = false;

        // Retain locally created test ports
        const testPorts = state.ports.filter(p => p.isTest);
        state.ports = [...allPorts, ...testPorts];

        applyWebStates();
    }, (error) => {
        console.error('Lỗi khi tải dữ liệu từ Firebase:', error);
    });

    // Lắng nghe trạng thái dùng chung (ẩn cổng, đã gửi sms) của TẤT CẢ CÁC MÁY
    db.ref('web_states/machines').on('value', (snapshot) => {
        const statesData = snapshot.val();
        let mergedStates = {};
        let mergedRefs = {};
        if (statesData) {
            Object.keys(statesData).forEach(mId => {
                if (statesData[mId].ports) {
                    Object.keys(statesData[mId].ports).forEach(pId => {
                        const stateKey = `${mId}_${pId}`;
                        mergedStates[stateKey] = statesData[mId].ports[pId];
                        mergedRefs[stateKey] = { machineId: mId, portId: pId };
                    });
                }
            });
        }
        globalWebStates = mergedStates;
        globalWebStateRefs = mergedRefs;
        applyWebStates();
        cleanupStalePortCommands();
    });
}

function applyWebStates() {
    if (state.ports.length === 0) return;

    state.ports.forEach(port => {
        if (port.isTest) return; // Bỏ qua cổng test

        const stateKey = `${port.machineId}_${port.id}`;
        const webState = globalWebStates[stateKey] || {};
        const isOwnWebCommand = webState.reservedBy === CLIENT_SESSION_ID;

        let shouldHide = false;
        let isSmsSent = webState.smsSent || false;
        let errorMsg = webState.errorMsg ? normalizeSmsError(webState.errorMsg) : null;
        const smsSentTime = webState.smsSentTime || port.smsSentTime || null;
        const activeCommandId = webState.commandId || port.commandId || null;

        if (isSmsSent && smsSentTime && !port.otp && !webState.errorMsg) {
            const elapsed = getServerNow() - smsSentTime;
            if (elapsed > SMS_WAIT_TIMEOUT_MS) {
                errorMsg = normalizeSmsError('Quá thời gian chờ OTP');
                isSmsSent = false;
                updateCommandStateIfCurrent(port.machineId, port.id, activeCommandId, {
                    smsSent: false,
                    commandStatus: 'timeout',
                    errorMsg,
                    timedOutAt: firebase.database.ServerValue.TIMESTAMP
                });
            }
        }

        if (webState.clearedOtp) {
            if (port.otp === webState.clearedOtp) {
                port.otp = null;
            } else if (port.otp && port.otp !== webState.clearedOtp) {
                db.ref(`web_states/machines/${port.machineId}/ports/${port.id}/clearedOtp`).remove();
            }
        }

        if (webState.hiddenOtp) {
            // Đã bị ẩn bởi một người dùng nào đó
            // Ktra xem C# có cập nhật SĐT mới không (thay SIM)?
            if (port.phone && webState.phone && port.phone !== webState.phone && port.phone !== 'N/A' && port.phone !== 'Unknown') {
                db.ref(`web_states/machines/${port.machineId}/ports/${port.id}`).remove();
                shouldHide = false;
                isSmsSent = false;
                errorMsg = null;
            }
            // Ktra xem C# có cập nhật OTP mới không?
            else if (port.otp && port.otp !== webState.hiddenOtp) {
                db.ref(`web_states/machines/${port.machineId}/ports/${port.id}`).remove();
                shouldHide = false;
                isSmsSent = false;
                errorMsg = null;
            } else {
                shouldHide = true;
            }
        } else if (webState.smsSent) {
            // Đang chờ mã nhưng chưa có hiddenOtp
            // Nếu C# cập nhật SĐT mới (thay SIM) thì xoá trạng thái chờ mã
            if (port.phone && webState.phone && port.phone !== webState.phone && port.phone !== 'N/A' && port.phone !== 'Unknown') {
                db.ref(`web_states/machines/${port.machineId}/ports/${port.id}`).remove();
                isSmsSent = false;
                errorMsg = null;
            }
        }

        if (isSmsSent && smsSentTime) {
            port.smsSentTime = smsSentTime;
        } else if (isSmsSent && !port.smsSentTime) {
            port.smsSentTime = getServerNow();
        } else if (!isSmsSent) {
            port.smsSentTime = null;
        }

        // TỰ ĐỘNG ẨN NẾU SĐT ĐÃ CÓ TRONG LỊCH SỬ (HISTORY)
        /* Đã tắt theo yêu cầu
        if (!shouldHide && port.phone && port.phone !== 'N/A' && port.phone !== 'Unknown') {
            // Xóa hết khoảng trắng nếu có để so sánh chính xác
            const cleanPhone = normalizePhoneNumber(port.phone);
            const inHistory = state.history.some(h => {
                const hPhone = h.phone ? normalizePhoneNumber(h.phone) : '';
                return hPhone === cleanPhone;
            });
            if (inHistory) {
                shouldHide = true;
            }
        }
        */

        const shouldShowCommandState = isOwnWebCommand || COMMAND_IN_FLIGHT_STATUSES.has(webState.commandStatus);
        port.commandId = shouldShowCommandState ? (webState.commandId || null) : null;
        port.commandIds = shouldShowCommandState && Array.isArray(webState.commandIds) ? webState.commandIds : null;
        port.commandStatus = shouldShowCommandState ? (webState.commandStatus || null) : null;
        port.hidden = shouldHide;
        port.smsSent = isSmsSent;
        port.errorMsg = errorMsg;
    });

    renderPorts();
}

function getVisibleActivePorts() {
    // Sort ALL ports by COM number to guarantee stable order for division
    const allPorts = [...state.ports].sort((a, b) => {
        const numA = parseInt(a.id.replace(/\D/g, '')) || 0;
        const numB = parseInt(b.id.replace(/\D/g, '')) || 0;
        return numA - numB;
    });

    // --- APPLY SPLIT LOGIC ---
    const workersStr = document.getElementById('split-workers')?.value;
    const partStr = document.getElementById('split-part')?.value;
    const workers = parseInt(workersStr) || 1;
    const part = parseInt(partStr) || 1;

    let myAssignedPorts = allPorts;

    if (workers > 1) {
        // Divide total hardware ports
        const totalPorts = allPorts.length;
        const portsPerPerson = Math.floor(totalPorts / workers);
        const remainder = totalPorts % workers;

        let startIndex = 0;
        for (let i = 1; i < part; i++) {
            startIndex += portsPerPerson + (i <= remainder ? 1 : 0);
        }
        const count = portsPerPerson + (part <= remainder ? 1 : 0);

        myAssignedPorts = allPorts.slice(startIndex, startIndex + count);
    }

    // After assigning the stable chunk, filter out the hidden ones
    let portsToRender = myAssignedPorts.filter(p => !p.hidden);

    const filter5kChecked = document.getElementById('filter-balance-5k')?.checked;
    if (filter5kChecked) {
        portsToRender = portsToRender.filter(p => {
            if (!p.balance) return false;
            return parseBalanceValue(p.balance) >= 5000;
        });
    }

    const selectedMachine = document.getElementById('filter-machine')?.value || '';
    if (selectedMachine) {
        portsToRender = portsToRender.filter(p => p.machineId === selectedMachine);
    }

    const selectedStatus = document.getElementById('filter-status')?.value || '';
    if (selectedStatus) {
        portsToRender = portsToRender.filter(p => getPortUiStatus(p) === selectedStatus);
    }

    const selectedNetwork = document.getElementById('filter-network')?.value || '';
    if (selectedNetwork) {
        portsToRender = portsToRender.filter(p => (p.networkProvider || p.network || '') === selectedNetwork);
    }

    const onlyHeavyErrors = document.getElementById('filter-error-heavy')?.checked;
    if (onlyHeavyErrors) {
        portsToRender = portsToRender.filter(p => ((p.timeoutCount || 0) + (p.smsErrorCount || 0) + (p.reconnectCount || 0)) >= 2);
    }

    return portsToRender;
}

// Render Ports
function renderPorts() {
    const container = document.getElementById('ports-container');
    renderOperationalPanels();
    container.innerHTML = '';

    const portsToRender = getVisibleActivePorts();

    if (portsToRender.length === 0) {
        container.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--text-muted);">Không có cổng nào (hoặc đã dùng hết) trong phần này.</div>`;
        return;
    }

    // Nhóm cổng theo Machine
    const groupedPorts = {};
    portsToRender.forEach(p => {
        const mId = p.machineId || 'TEST_MACHINE';
        if (!groupedPorts[mId]) groupedPorts[mId] = [];
        groupedPorts[mId].push(p);
    });

    Object.keys(groupedPorts).forEach(machineId => {
        // Render Machine Header
        const header = document.createElement('div');
        header.className = 'machine-header';
        header.innerHTML = `<i data-lucide="server"></i> Máy tính: <strong>${escapeHtml(machineId)}</strong> <span class="badge">${groupedPorts[machineId].length} cổng</span>`;
        container.appendChild(header);

        // Render từng cổng của máy này
        groupedPorts[machineId].forEach(port => {
            const row = document.createElement('div');
            row.className = 'grid-row';
            if (port.smsSent) {
                row.classList.add('row-highlight-warning');
            }
            row.id = `row-${port.machineId}-${port.id}`;

            const uiStatus = getPortUiStatus(port);
            const statusDot = `<span class="status-pill ${uiStatus}">${escapeHtml(getPortUiStatusLabel(uiStatus))}</span>`;

            const isChecking = pendingBalanceChecks.has(`${port.machineId}_${port.id}`);
            const commandText = getCommandStatusText(port.commandStatus, port.commandStatus === 'running' && isChecking ? 'balance' : 'sms');
            const isCommandBusy = COMMAND_IN_FLIGHT_STATUSES.has(port.commandStatus);
            const healthText = '';

            let otpContent = port.smsSent ?
                (port.commandStatus === 'maybe_sent' ?
                    `<span style="color: #f39c12">Có thể đã gửi... <span class="wait-timer" data-port="${port.id}" data-machine="${port.machineId}"></span></span>` :
                    `<span style="color: #f39c12">Đang chờ mã... <span class="wait-timer" data-port="${port.id}" data-machine="${port.machineId}"></span></span>`) :
                '<span style="color: var(--text-muted)">Chưa gửi tin nhắn</span>';
            if (!port.smsSent && commandText) {
                otpContent = `<span style="color: var(--warning); font-weight: 600;">${escapeHtml(commandText)}</span>`;
            }

            let actionButtons = `
                <button class="btn btn-primary" onclick="openSmsModal('${port.id}', '${port.machineId}')" title="Gửi SMS Lấy OTP" ${isCommandBusy ? 'disabled' : ''}>
                    <i data-lucide="send"></i> ${isCommandBusy ? escapeHtml(commandText || 'Đang xử lý') : 'Gửi SMS'}
                </button>
                <button class="btn btn-outline${isChecking ? ' btn-loading' : ''}" id="btn-balance-${port.machineId}-${port.id}" onclick="checkBalance('${port.id}', '${port.machineId}')" title="Kiểm tra số dư" ${isChecking ? 'disabled' : ''}>
                    ${isChecking ? '<span class="spinner"></span> Đang kiểm tra...' : '<i data-lucide="dollar-sign"></i> Kiểm tra số dư'}
                </button>
            `;

            if (port.errorMsg) {
                otpContent = `<span style="color: var(--danger); font-weight: 500;"><i data-lucide="alert-triangle" style="width: 14px; height: 14px; display: inline; margin-bottom: -2px;"></i> ${escapeHtml(normalizeSmsError(port.errorMsg))}</span>`;
            } else if (port.otp) {
                otpContent = `<span class="otp-badge">${escapeHtml(port.otp)}</span>`;
                actionButtons = `
                    <button class="btn btn-success" onclick="markAsUsed('${port.id}', '${port.machineId}')">
                        <i data-lucide="check-circle"></i> Đã dùng
                    </button>
                    <button class="btn btn-outline" onclick="cancelSmsWait('${port.id}', '${port.machineId}')" title="Làm mới trạng thái">
                        <i data-lucide="refresh-cw"></i> Làm mới
                    </button>
                `;
            } else {
                // Luôn hiển thị button huỷ chờ
                actionButtons += `
                    <button class="btn btn-outline" onclick="cancelSmsWait('${port.id}', '${port.machineId}')" title="Hủy chờ OTP" style="padding: 0 8px;">
                        <i data-lucide="x-circle"></i>
                    </button>
                `;
            }

            row.innerHTML = `
                <div class="col-status">${statusDot}</div>
                <div class="col-port">${escapeHtml(port.id)}${healthText}</div>
                <div class="col-phone">${port.phone ? escapeHtml(normalizePhoneNumber(port.phone)) : '<span style="color:gray; font-style:italic">Trống</span>'}</div>
                <div class="col-tkc">${escapeHtml(port.balance || 'N/A')}</div>
                <div class="col-otp">${otpContent}</div>
                <div class="col-actions">
                    ${actionButtons}
                </div>
            `;

            container.appendChild(row);
        });
    });

    lucide.createIcons();
    if (typeof checkConnectionStatus === 'function') {
        checkConnectionStatus();
    }
}

// Timer cập nhật đếm giây
setInterval(() => {
    const timers = document.querySelectorAll('.wait-timer');
    timers.forEach(el => {
        const portId = el.getAttribute('data-port');
        const machineId = el.getAttribute('data-machine');
        const port = state.ports.find(p => p.id === portId && p.machineId === machineId);
        if (port && port.smsSentTime) {
            const elapsedSeconds = Math.floor((getServerNow() - port.smsSentTime) / 1000);
            if (elapsedSeconds <= 60) {
                el.textContent = `(${elapsedSeconds}s)`;
            } else {
                el.textContent = `(${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s)`;
            }
        }
    });
}, 1000);

function updateSplitSelect() {
    const workersInput = document.getElementById('split-workers');
    if (!workersInput) return;
    let workers = parseInt(workersInput.value);
    if (isNaN(workers) || workers < 1) {
        workers = 1;
        workersInput.value = 1;
    }

    const partSelect = document.getElementById('split-part');
    if (!partSelect) return;
    const currentPart = parseInt(partSelect.value) || 1;

    partSelect.innerHTML = '';
    for (let i = 1; i <= workers; i++) {
        const option = document.createElement('option');
        option.value = i;
        option.textContent = `Phần ${i}`;
        if (i === currentPart) {
            option.selected = true;
        }
        partSelect.appendChild(option);
    }

    if (currentPart > workers) {
        partSelect.value = "1";
    }
}

// Render History
function renderHistory() {
    const container = document.getElementById('history-container');
    container.innerHTML = '';

    if (state.history.length === 0) {
        container.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--text-muted);">Chưa có lịch sử OTP.</div>`;
        return;
    }

    // Deduplicate history to prevent showing duplicates caused by multiple clients triggering 10s timeout
    const uniqueHistory = [];
    const seen = new Set();

    const sortedHistory = [...state.history].sort((a, b) => getHistorySortTimestamp(b) - getHistorySortTimestamp(a));

    sortedHistory.forEach(item => {
        const uniqueKey = `${item.id}-${item.phone}-${item.otp}`;
        if (!seen.has(uniqueKey)) {
            seen.add(uniqueKey);
            uniqueHistory.push(item);
        }
    });

    uniqueHistory.forEach(item => {
        const row = document.createElement('div');
        row.className = 'grid-row';

        row.innerHTML = `
            <div class="col-port">${escapeHtml(item.id)} <br><span style="font-size: 11px; color: #aaa;">${escapeHtml(item.machineId || '')}</span></div>
            <div class="col-phone">${item.phone ? escapeHtml(normalizePhoneNumber(item.phone)) : '<span style="color:gray; font-style:italic">Trống</span>'}</div>
            <div class="col-otp"><span style="color: var(--success); font-weight: bold;">${escapeHtml(item.otp)}</span></div>
            <div class="col-time">${escapeHtml(item.usedTime)}</div>
            <div class="col-actions">
                <button class="btn btn-primary" onclick="restoreFromHistory('${item.id}', '${item.machineId}', '${item.usedTime}', '${item.fbKey}')" title="Khôi phục trạng thái hoạt động">
                    <i data-lucide="rotate-ccw"></i> Khôi phục
                </button>
            </div>
        `;

        container.appendChild(row);
    });

    lucide.createIcons();
}

// Export Excel (XLS)
function exportHistoryToExcel() {
    if (state.history.length === 0) {
        showToast('Không có dữ liệu để xuất!', 'error');
        return;
    }

    // Tạo nội dung HTML tương thích với Excel, cho phép tuỳ chỉnh màu sắc, độ rộng và giữ số 0
    let html = `
        <html xmlns:o="urn:schemas-microsoft-com:office:office"
              xmlns:x="urn:schemas-microsoft-com:office:excel"
              xmlns="http://www.w3.org/TR/REC-html40">
        <head>
            <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
            <style>
                table { border-collapse: collapse; font-family: 'Times New Roman', Times, serif; }
                th { background-color: #1976D2; color: #ffffff; font-weight: bold; border: 1px solid #000000; padding: 10px; font-size: 13pt; text-align: center; }
                td { border: 1px solid #000000; padding: 8px; font-size: 12pt; text-align: center; vertical-align: middle; }
                .text-cell { mso-number-format: "\\@"; } /* Định dạng Text, giữ số 0 ở đầu */
                .title-row { font-size: 18pt; font-weight: bold; color: #D32F2F; text-align: center; height: 50px; vertical-align: middle; }
            </style>
        </head>
        <body>
            <table>
                <tr>
                    <td colspan="4" class="title-row">BÁO CÁO LỊCH SỬ NHẬN OTP</td>
                </tr>
                <tr>
                    <td colspan="4" style="text-align: center; font-style: italic; height: 30px; font-size: 11pt;">Ngày xuất báo cáo: ${new Date().toLocaleString('vi-VN')}</td>
                </tr>
                <tr>
                    <th style="width: 80px;">Cổng</th>
                    <th style="width: 150px;">Số Điện Thoại</th>
                    <th style="width: 150px;">OTP Đã Nhận</th>
                    <th style="width: 200px;">Thời Gian Nhận</th>
                </tr>
    `;

    state.history.forEach(item => {
        const phone = escapeHtml(normalizePhoneNumber(item.phone || ''));
        const otp = escapeHtml(item.otp || '');
        const time = escapeHtml(item.usedTime || '');

        html += `
                <tr>
                    <td>${item.id}</td>
                    <td class="text-cell">${phone}</td>
                    <td class="text-cell" style="color: #2E7D32; font-weight: bold;">${otp}</td>
                    <td>${time}</td>
                </tr>`;
    });

    html += `
            </table>
        </body>
        </html>
    `;

    const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `Lich_Su_OTP_${new Date().toLocaleDateString('vi-VN').replace(/\//g, '-')}.xls`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showToast('Đã xuất báo cáo Excel thành công!');
}

function exportActivePortsToExcel() {
    const ports = getVisibleActivePorts().filter(port => port.phone && port.phone !== 'N/A' && port.phone !== 'Unknown');
    if (ports.length === 0) {
        showToast('Không có SĐT đang hoạt động để xuất!', 'error');
        return;
    }

    let html = `
        <html xmlns:o="urn:schemas-microsoft-com:office:office"
              xmlns:x="urn:schemas-microsoft-com:office:excel"
              xmlns="http://www.w3.org/TR/REC-html40">
        <head>
            <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
            <style>
                table { border-collapse: collapse; font-family: 'Times New Roman', Times, serif; }
                th { background-color: #1976D2; color: #ffffff; font-weight: bold; border: 1px solid #000000; padding: 10px; font-size: 13pt; text-align: center; }
                td { border: 1px solid #000000; padding: 8px; font-size: 12pt; text-align: center; vertical-align: middle; }
                .text-cell { mso-number-format: "\\@"; }
                .title-row { font-size: 18pt; font-weight: bold; color: #D32F2F; text-align: center; height: 50px; vertical-align: middle; }
            </style>
        </head>
        <body>
            <table>
                <tr>
                    <td colspan="4" class="title-row">DANH SÁCH SĐT ĐANG HOẠT ĐỘNG</td>
                </tr>
                <tr>
                    <td colspan="4" style="text-align: center; font-style: italic; height: 30px; font-size: 11pt;">Ngày xuất báo cáo: ${new Date().toLocaleString('vi-VN')}</td>
                </tr>
                <tr>
                    <th style="width: 80px;">Cổng</th>
                    <th style="width: 150px;">Số Điện Thoại</th>
                    <th style="width: 150px;">TKC</th>
                    <th style="width: 150px;">Máy</th>
                </tr>
    `;

    ports.forEach(port => {
        html += `
                <tr>
                    <td>${escapeHtml(port.id || '')}</td>
                    <td class="text-cell">${escapeHtml(normalizePhoneNumber(port.phone || ''))}</td>
                    <td class="text-cell">${escapeHtml(String(port.balance || 'N/A').replace(/vnd|vnđ/ig, '').trim())}</td>
                    <td class="text-cell">${escapeHtml(port.machineId || '')}</td>
                </tr>`;
    });

    html += `
            </table>
        </body>
        </html>
    `;

    const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `SDT_TKC_Dang_Hoat_Dong_${new Date().toLocaleDateString('vi-VN').replace(/\//g, '-')}.xls`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    showToast(`Đã xuất ${ports.length} SĐT/TKC đang hoạt động!`);
}

// Modal Logic
let currentActionMachineId = null;
function openSmsModal(portId, machineId) {
    state.currentActionPortId = portId;
    currentActionMachineId = machineId;
    const port = state.ports.find(p => p.id === portId && p.machineId === machineId);

    document.getElementById('sms-port-name').textContent = port.id + (machineId ? ` (${machineId})` : '');
    document.getElementById('sms-phone-number').textContent = port.phone || 'Chưa có SĐT';

    // Hiển thị nhà mạng trong modal
    const networkEl = document.getElementById('sms-network-badge');
    if (networkEl) {
        const net = (port.network || 'UNKNOWN').toUpperCase();
        let badgeColor = '#888';
        if (net.includes('VIETTEL')) badgeColor = '#e74c3c';
        else if (net.includes('VINA') || net.includes('VINAPHONE')) badgeColor = '#2980b9';
        else if (net.includes('MOBI')) badgeColor = '#27ae60';
        else if (net.includes('SKY')) badgeColor = '#00a8ff';
        else if (net.includes('LOCAL')) badgeColor = '#e1b12c';
        else if (net.includes('WINTEL')) badgeColor = '#e84393';
        else if (net.includes('ITELECOM') || net.includes('ITEL')) badgeColor = '#d35400';
        else if (net.includes('VIETNAMOBILE') || net.includes('VNM')) badgeColor = '#f39c12';
        networkEl.textContent = port.network || 'UNKNOWN';
        networkEl.style.background = badgeColor;
    }

    // Không tự động đổi đầu số theo nhà mạng vì Zalo có thể yêu cầu gửi 8500 từ SIM Viettel và ngược lại.
    // UI sẽ giữ nguyên lựa chọn cuối cùng của người dùng.
    const select = document.getElementById('sms-recipient-select');
    const customInput = document.getElementById('sms-recipient-custom');

    if (select.value === 'custom') {
        // giữ hiện custom input nếu đang ở mode custom
    } else {
        customInput.value = '';
        customInput.style.display = 'none';
    }

    document.getElementById('sms-content').value = 'ZALO';

    document.getElementById('sms-modal').classList.add('active');
}

function toggleCustomRecipient() {
    const select = document.getElementById('sms-recipient-select');
    const customInput = document.getElementById('sms-recipient-custom');
    if (select.value === 'custom') {
        customInput.style.display = 'block';
        customInput.focus();
    } else {
        customInput.style.display = 'none';
    }
}

function openSettingsModal() {
    document.getElementById('setting-sound-toggle').checked = soundEnabled;
    document.getElementById('settings-modal').classList.add('active');
}

function toggleSoundSetting(checkbox) {
    soundEnabled = checkbox.checked;
    localStorage.setItem('gsm_sound_enabled', soundEnabled);
    if (soundEnabled) {
        playNotificationSound();
    }
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
    state.currentActionPortId = null;
}

// Execute actions
async function executeSendSms() {
    if (isImpersonating) return showToast('Bạn đang ở chế độ Chỉ Đọc', 'error');
    const actionPortId = state.currentActionPortId;
    const actionMachineId = currentActionMachineId;
    if (!actionPortId) return;

    const actionKey = `${actionMachineId}_${actionPortId}`;
    const actionPort = state.ports.find(p => p.id === actionPortId && p.machineId === actionMachineId);
    const webState = globalWebStates[actionKey] || {};

    if (!actionPort) {
        showToast('Không tìm thấy cổng đang chọn, vui lòng tải lại dữ liệu.', 'error');
        return;
    }

    if (!actionPort.isTest && actionPort.status !== 'online') {
        showToast('Cổng này đang offline, không thể gửi SMS.', 'error');
        return;
    }

    if (sendingSmsPorts.has(actionKey)) {
        showToast('Lệnh gửi SMS đang được tạo, vui lòng đợi.', 'error');
        return;
    }

    if (COMMAND_IN_FLIGHT_STATUSES.has(webState.commandStatus)) {
        showToast('Cổng này đang xử lý lệnh trước đó.', 'error');
        return;
    }

    if (actionPort && actionPort.smsSent && !isActionableSmsError(actionPort.errorMsg)) {
        showToast('Cổng này đang chờ OTP, hãy hủy chờ OTP trước khi gửi lại.', 'error');
        return;
    }

    if (!checkUserLimits()) {
        return;
    }

    let recipient = document.getElementById('sms-recipient-select').value;
    if (recipient === 'custom') {
        recipient = document.getElementById('sms-recipient-custom').value;
    }
    recipient = (recipient || '').trim();

    if (!recipient) {
        showToast('Vui lòng nhập đầu số nhận!', 'error');
        return;
    }

    if (/[,;\s]/.test(recipient)) {
        showToast('Chỉ được nhập một đầu số mỗi lần gửi. Không dùng dấu phẩy hoặc khoảng trắng.', 'error');
        return;
    }

    const content = document.getElementById('sms-content').value.trim();
    if (!content) {
        showToast('Vui lòng nhập nội dung SMS!', 'error');
        return;
    }

    // Xử lý cổng mô phỏng (Test)
    if (actionPortId.startsWith('COM_TEST')) {
        const port = state.ports.find(p => p.id === actionPortId);
        if (port) port.smsSent = true;
        renderPorts();
        showToast(`[TEST] Đã gửi lệnh SMS từ ${actionPortId} đến ${recipient}`);
        closeModal('sms-modal');

        // Mô phỏng mã OTP về sau 3 giây
        simulateOtpArrival(actionPortId, actionMachineId, content.toUpperCase().includes('ZALO'));
        return;
    }

    let commandId = null;
    try {
        sendingSmsPorts.add(actionKey);
        commandId = db.ref('commands').push().key;
        const reserved = await reservePortCommand({
            machineId: actionMachineId,
            portId: actionPortId,
            commandId,
            type: 'sms',
            phone: actionPort.phone || 'NONE'
        });

        if (!reserved) {
            showToast('Cổng này vừa được người khác giữ lệnh, vui lòng đợi.', 'error');
            return;
        }

        await createCommand({
            machineId: actionMachineId,
            portId: actionPortId,
            recipient,
            content: content,
            type: 'sms',
            commandId
        });

        const port = state.ports.find(p => p.id === actionPortId && p.machineId === actionMachineId);
        if (port && !port.isTest) {
            // Xoá OTP cũ hiển thị trên trình duyệt để chuyển sang trạng thái "Đang chờ mã..."
            port.otp = null;
            port.errorMsg = null;
            port.commandId = commandId;
            port.commandIds = null;
            port.commandStatus = 'queued';

            await Promise.all([
                db.ref(`machines/${actionMachineId}/ports/${actionPortId}/otp`).remove(),
                db.ref(`web_states/machines/${actionMachineId}/ports/${actionPortId}`).update({ errorMsg: null })
            ]);
        } else if (port) {
            port.otp = null;
            port.smsSent = true;
            renderPorts();
        }

        showToast(`Đã gửi lệnh SMS từ ${actionPortId} (${actionMachineId}) đến ${recipient}`);
    } catch (error) {
        if (commandId) {
            await releasePortCommandReservation(actionMachineId, actionPortId, commandId, 'Không thể đẩy lệnh lên Firebase');
        }
        showToast('Không thể đẩy lệnh lên Firebase!', 'error');
    } finally {
        sendingSmsPorts.delete(actionKey);
    }

    closeModal('sms-modal');
}

window.checkBalance = async function (portId, machineId) {
    if (portId.startsWith('COM_TEST')) {
        showToast(`[TEST] Đã gửi lệnh kiểm tra số dư cho cổng ${portId}`);
        return;
    }

    const stateKey = `${machineId}_${portId}`;
    if (pendingBalanceChecks.has(stateKey)) return; // Đang kiểm tra rồi
    const webState = globalWebStates[stateKey] || {};
    const port = state.ports.find(p => p.id === portId && p.machineId === machineId);

    if (!port) {
        showToast('Không tìm thấy cổng đang chọn.', 'error');
        return;
    }

    if (port.status !== 'online') {
        showToast('Cổng này đang offline, không thể kiểm tra số dư.', 'error');
        return;
    }

    if (COMMAND_IN_FLIGHT_STATUSES.has(webState.commandStatus)) {
        showToast('Cổng này đang xử lý lệnh trước đó.', 'error');
        return;
    }

    let commandId = null;
    try {
        pendingBalanceChecks.add(stateKey);
        renderPorts();

        commandId = db.ref('commands').push().key;
        const reserved = await reservePortCommand({
            machineId,
            portId,
            commandId,
            type: 'balance',
            phone: port.phone || 'NONE'
        });

        if (!reserved) {
            pendingBalanceChecks.delete(stateKey);
            showToast('Cổng này vừa được người khác giữ lệnh, vui lòng đợi.', 'error');
            renderPorts();
            return;
        }

        await createCommand({
            machineId: machineId,
            portId: portId,
            recipient: 'USSD',
            content: 'BALANCE',
            type: 'balance',
            commandId
        });
        if (port) {
            port.commandId = commandId;
            port.commandStatus = 'queued';
        }
        showToast(`Đã gửi lệnh kiểm tra số dư cho cổng ${portId} (${machineId})`);

        // Tự tắt spinner sau 45s nếu không nhận được kết quả
        setTimeout(async () => {
            if (pendingBalanceChecks.has(stateKey)) {
                pendingBalanceChecks.delete(stateKey);
                await updateCommandStateIfCurrent(machineId, portId, commandId, {
                    commandStatus: 'timeout',
                    errorMsg: 'Kiểm tra số dư quá thời gian'
                });
                renderPorts();
            }
        }, BALANCE_WAIT_TIMEOUT_MS);
    } catch (error) {
        if (commandId) {
            await releasePortCommandReservation(machineId, portId, commandId, 'Không thể đẩy lệnh lên Firebase');
        }
        pendingBalanceChecks.delete(stateKey);
        renderPorts();
        showToast('Không thể đẩy lệnh lên Firebase!', 'error');
    }
}

async function clearCommandResults(ids) {
    if (!Array.isArray(ids)) return;
    const promises = [];
    ids.forEach(id => {
        if (!id) return;
        delete commandResults[id];
        delete appliedCommandResults[id];
        promises.push(db.ref(`command_results/${id}`).remove());
    });
    await Promise.all(promises);
}

window.cancelSmsWait = async function (portId, machineId) {
    if (isImpersonating) return showToast('Bạn đang ở chế độ Chỉ Đọc', 'error');
    const stateKey = `${machineId}_${portId}`;
    const webState = globalWebStates[stateKey] || {};
    const idsToCancel = Array.isArray(webState.commandIds)
        ? webState.commandIds
        : (webState.commandId ? [webState.commandId] : []);

    const portResults = Object.keys(commandResults).filter(id => {
        const res = commandResults[id];
        return res && res.portId === portId && res.machineId === machineId;
    });
    const allIdsToCancel = [...new Set([...idsToCancel, ...portResults])];

    const promises = [];
    if (idsToCancel.length && COMMAND_IN_FLIGHT_STATUSES.has(webState.commandStatus)) {
        idsToCancel.forEach(id => promises.push(db.ref(`commands/${id}`).remove()));
    }
    promises.push(clearCommandResults(allIdsToCancel));

    const port = state.ports.find(p => p.id === portId && p.machineId === machineId);
    if (port && port.otp) {
        promises.push(db.ref(`web_states/machines/${machineId}/ports/${portId}`).update({ clearedOtp: port.otp, smsSent: null, commandId: null, commandIds: null, commandStatus: null, errorMsg: null }));
    } else {
        promises.push(db.ref(`web_states/machines/${machineId}/ports/${portId}`).remove());
    }
    promises.push(db.ref(`machines/${machineId}/ports/${portId}/otp`).remove());

    await Promise.all(promises);

    // Xoá OTP trên giao diện nếu đang có
    if (port) {
        if (port.otp) port.otp = null;
        port.smsSent = false;
        port.commandId = null;
        port.commandIds = null;
        port.commandStatus = null;
        port.errorMsg = null;
        renderPorts();
    }

    showToast(`Đã hủy chờ OTP cho cổng ${portId} (${machineId})`);
}

window.cancelAllSmsWait = async function () {
    if (isImpersonating) return showToast('Bạn đang ở chế độ Chỉ Đọc', 'error');
    const visiblePorts = state.ports.filter(p => !p.hidden && !p.isTest && p.status === 'online');
    if (visiblePorts.length === 0) {
        showToast('Không có cổng nào đang hoạt động!', 'error');
        return;
    }

    showToast(`Đang hủy chờ OTP cho ${visiblePorts.length} cổng...`);
    const promises = [];
    visiblePorts.forEach(port => {
        const webState = globalWebStates[`${port.machineId}_${port.id}`] || {};
        const idsToCancel = Array.isArray(webState.commandIds)
            ? webState.commandIds
            : (webState.commandId ? [webState.commandId] : []);

        const portResults = Object.keys(commandResults).filter(id => {
            const res = commandResults[id];
            return res && res.portId === port.id && res.machineId === port.machineId;
        });
        const allIdsToCancel = [...new Set([...idsToCancel, ...portResults])];

        if (idsToCancel.length && COMMAND_IN_FLIGHT_STATUSES.has(webState.commandStatus)) {
            idsToCancel.forEach(id => promises.push(db.ref(`commands/${id}`).remove()));
        }
        promises.push(clearCommandResults(allIdsToCancel));
        if (port.otp) {
            promises.push(db.ref(`web_states/machines/${port.machineId}/ports/${port.id}`).update({ clearedOtp: port.otp, smsSent: null, commandId: null, commandIds: null, commandStatus: null, errorMsg: null }));
        } else {
            promises.push(db.ref(`web_states/machines/${port.machineId}/ports/${port.id}`).remove());
        }
        promises.push(db.ref(`machines/${port.machineId}/ports/${port.id}/otp`).remove());
        if (port.otp) port.otp = null;
        port.smsSent = false;
        port.commandId = null;
        port.commandIds = null;
        port.commandStatus = null;
        port.errorMsg = null;
    });
    await Promise.all(promises);
    renderPorts();
    showToast(`Đã hủy chờ OTP cho ${visiblePorts.length} cổng`);
}

window.clearAllCommandResults = async function () {
    if (isImpersonating) return showToast('Bạn đang ở chế độ Chỉ Đọc', 'error');
    await db.ref('command_results').remove();
    commandResults = {};
    appliedCommandResults = {};
    renderOperationalPanels();
    showToast('Đã dọn sạch toàn bộ kết quả lệnh trên Firebase và giao diện.');
}

window.restoreAllHiddenPorts = function () {
    if (isImpersonating) return showToast('Bạn đang ở chế độ Chỉ Đọc', 'error');
    let count = 0;
    Object.keys(globalWebStates).forEach(stateKey => {
        const webState = globalWebStates[stateKey];
        if (webState.hiddenOtp) {
            const ref = globalWebStateRefs[stateKey];
            if (ref) {
                db.ref(`web_states/machines/${ref.machineId}/ports/${ref.portId}`).remove();
                count++;
            }
        }
    });
    if (count > 0) {
        showToast(`Đã khôi phục ${count} cổng ẩn.`);
        renderPorts();
    } else {
        showToast('Không có cổng nào đang bị ẩn.', 'error');
    }
}

window.checkAllBalance = async function () {
    const visiblePorts = state.ports.filter(p => !p.hidden && !p.isTest && p.status === 'online');
    if (visiblePorts.length === 0) {
        showToast('Không có cổng nào đang hoạt động!', 'error');
        return;
    }

    showToast(`Đang xếp hàng kiểm tra TKC cho ${visiblePorts.length} cổng...`);
    for (let i = 0; i < visiblePorts.length; i++) {
        const port = visiblePorts[i];
        await checkBalance(port.id, port.machineId);
        if (i < visiblePorts.length - 1) {
            await sleep(BALANCE_COMMAND_SPACING_MS);
        }
    }
}

window.refreshAllPorts = function () {
    showToast('Đang gửi lệnh làm mới toàn bộ cổng trên tất cả các máy...');
    // Lấy danh sách các máy tính đang hoạt động
    const activeMachines = [...new Set(state.ports.filter(p => !p.isTest).map(p => p.machineId))];

    activeMachines.forEach(mId => {
        createCommand({
            machineId: mId,
            portId: 'ALL',
            recipient: 'SYSTEM',
            content: 'REFRESH_ALL',
            type: 'system'
        });
    });
}

// Mark as Used
async function markAsUsed(portId, machineId) {
    if (isImpersonating) return showToast('Bạn đang ở chế độ Chỉ Đọc', 'error');
    const timeoutKey = `${machineId}_${portId}`;
    if (autoHistoryTimeouts[timeoutKey]) {
        clearTimeout(autoHistoryTimeouts[timeoutKey]);
        delete autoHistoryTimeouts[timeoutKey];
    }
    const portIndex = state.ports.findIndex(p => p.id === portId && p.machineId === machineId);
    if (portIndex > -1) {
        const port = state.ports[portIndex];

        // Ngăn chặn bấm nhiều lần liên tiếp (double click spam)
        if (port.isMarking) return;
        port.isMarking = true;

        // Add exit animation class
        const row = document.getElementById(`row-${port.machineId}-${port.id}`);
        if (row) {
            row.classList.add('row-exit');

            const phoneKey = toFirebaseKey((port.phone || 'NO_PHONE').replace(/\s+/g, ''));
            const otpKey = toFirebaseKey(port.otp || 'NO_OTP');
            const historyKey = `${toFirebaseKey(machineId)}_${toFirebaseKey(portId)}_${phoneKey}_${otpKey}`;
            const historyRef = db.ref(tenantPath(`history/${historyKey}`));

            try {
                const result = await historyRef.transaction(current => {
                    if (current) return current;
                    return {
                        ...port,
                        machineId: machineId,
                        id: portId,
                        usedTime: new Date().toLocaleTimeString('vi-VN'),
                        timestamp: firebase.database.ServerValue.TIMESTAMP,
                        customerId: getTenantId(),
                        source: 'local',
                        status: 'success'
                    };
                });
                if (!result.committed && result.snapshot.exists()) {
                    showToast(`SĐT ${port.phone} đã có trong lịch sử.`);
                }
            } catch (error) {
                showToast('Không thể lưu lịch sử OTP!', 'error');
                port.isMarking = false;
                return;
            }

            // Đồng bộ trạng thái ẨN cho mọi người
            db.ref(`web_states/machines/${port.machineId}/ports/${port.id}`).update({
                hiddenOtp: port.otp || 'NONE',
                phone: port.phone || 'NONE'
            });

            setTimeout(() => {
                showToast(`Đã lưu SĐT ${port.phone} vào lịch sử.`);
            }, 400); // wait for animation
        }
    }
}

function restoreFromHistory(portId, machineId, usedTime, fbKey) {
    if (isImpersonating) return showToast('Bạn đang ở chế độ Chỉ Đọc', 'error');
    // Xoá trạng thái ẩn trên Firebase cho tất cả mọi người
    db.ref(`web_states/machines/${machineId}/ports/${portId}`).remove();

    // Cập nhật state local
    const port = state.ports.find(p => p.id === portId && p.machineId === machineId);
    if (port) {
        port.hidden = false;
        port.smsSent = false;
        port.isMarking = false; // Reset cờ trạng thái
    }

    // Xóa entry khỏi lịch sử trên Firebase
    if (fbKey && fbKey !== 'undefined') {
        db.ref(tenantPath(`history/${fbKey}`)).remove();
    } else {
        // Fallback cho dữ liệu cũ từ localStorage chưa có fbKey
        const indexToRemove = state.history.findIndex(h => h.id === portId && h.usedTime === usedTime);
        if (indexToRemove > -1) {
            state.history.splice(indexToRemove, 1);
            localStorage.setItem(tenantStorageKey('gsm_history'), JSON.stringify(state.history));
            renderHistory();
        }
    }

    showToast(`Đã khôi phục cổng ${portId} (${machineId}) về trạng thái đang hoạt động.`);
}

// Simulation helpers
function manualRefresh() {
    renderPorts();
    showToast('Đã cập nhật dữ liệu mới nhất!');
}

function simulateOtpArrival(portId, machineId, isZalo = false) {
    setTimeout(() => {
        const port = state.ports.find(p => p.id === portId && p.machineId === machineId);
        if (port && !port.hidden) {
            port.otp = isZalo ? Math.floor(1000 + Math.random() * 9000).toString() : Math.floor(100000 + Math.random() * 900000).toString();
            scheduleAutoHistory(portId, machineId);
            renderPorts();
            // OTP mới vẫn hiển thị trên bảng, không hiện toast/âm thanh.
        }
    }, 3000);
}

function getHistorySortTimestamp(item) {
    const timestamp = Number(item?.timestamp || item?.updatedAt || item?.createdAt || 0);
    if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;

    const parsedUsedTime = Date.parse(item?.usedTime || '');
    return Number.isFinite(parsedUsedTime) ? parsedUsedTime : 0;
}

function simulateIncomingOtp() {
    // Tạo một cổng mô phỏng mới
    const testId = `COM_TEST_${Math.floor(100 + Math.random() * 900)}`;
    const newTestPort = {
        id: testId,
        phone: `0999${Math.floor(100000 + Math.random() * 900000)}`,
        status: 'online',
        balance: '10000',
        network: 'TEST',
        isTest: true,
        smsSent: false,
        hidden: false,
        otp: null
    };
    state.ports.push(newTestPort);
    renderPorts();
    showToast(`Đã thêm cổng mô phỏng ${testId}. Vui lòng bấm Gửi SMS để test tiếp.`);
}

// Toast notification
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';

    const icon = type === 'success' ? 'check-circle' : 'alert-circle';
    const color = type === 'success' ? 'var(--success)' : 'var(--danger)';

    toast.innerHTML = `
        <i data-lucide="${icon}" style="color: ${color}"></i>
        <span>${escapeHtml(message)}</span>
    `;

    container.appendChild(toast);
    lucide.createIcons();

    setTimeout(() => {
        toast.style.animation = 'toastOut 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards';
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, 3000);
}

// Navigation Helper
function setActiveNav(activeId) {
    const navs = ['nav-active', 'nav-history', 'nav-firefox', 'nav-guide', 'nav-contact', 'nav-admin', 'nav-dashboard'];
    navs.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            if (id === activeId) el.classList.add('active');
            else el.classList.remove('active');
        }
    });
}

// Navigation
document.getElementById('logo-home').addEventListener('click', () => {
    document.getElementById('nav-active').click();
});

document.getElementById('nav-active').addEventListener('click', (e) => {
    e.preventDefault();
    setActiveNav('nav-active');

    document.getElementById('active-view').style.display = 'flex';
    document.getElementById('history-view').style.display = 'none';
    const firefoxView = document.getElementById('firefox-view');
    if (firefoxView) firefoxView.style.display = 'none';
    const guideView = document.getElementById('guide-view');
    if (guideView) guideView.style.display = 'none';
    const adminView = document.getElementById('admin-view');
    if (adminView) adminView.style.display = 'none';
    const dashboardView = document.getElementById('dashboard-view');
    if (dashboardView) dashboardView.style.display = 'none';

    const topBarControls = document.getElementById('top-bar-controls');
    if (topBarControls) topBarControls.style.display = 'flex';

    renderPorts();
});

async function reloadHistoryAndRender() {
    const container = document.getElementById('history-container');
    if (container) {
        container.innerHTML = `<div style="padding:40px;color:var(--text-muted);">Đang tải lịch sử OTP...</div>`;
    }

    try {
        const snapshot = await db.ref(tenantPath('history'))
            .orderByChild('timestamp')
            .limitToLast(500)
            .once('value');

        const data = snapshot.val();

        const firebaseHistory = data
            ? Object.entries(data).map(([key, value]) => ({
                ...value,
                phone: value?.phone ? normalizePhoneNumber(value.phone) : value?.phone,
                fbKey: key
            }))
            : [];

        let localHistory = [];
        try {
            localHistory = JSON.parse(localStorage.getItem(tenantStorageKey('gsm_history')) || '[]');
            if (!Array.isArray(localHistory)) localHistory = [];
        } catch {
            localHistory = [];
        }

        state.history = [...firebaseHistory, ...localHistory];
        renderHistory();
    } catch (error) {
        console.error('Lỗi tải lại history:', error);
        if (container) {
            container.innerHTML = `<div style="padding:40px;color:var(--danger);">Lỗi tải lịch sử OTP: ${escapeHtml(error.message)}</div>`;
        }
    }
}

document.getElementById('nav-history').addEventListener('click', (e) => {
    e.preventDefault();
    setActiveNav('nav-history');

    document.getElementById('active-view').style.display = 'none';
    document.getElementById('history-view').style.display = 'flex';
    const firefoxView = document.getElementById('firefox-view');
    if (firefoxView) firefoxView.style.display = 'none';
    const guideView = document.getElementById('guide-view');
    if (guideView) guideView.style.display = 'none';
    const adminView = document.getElementById('admin-view');
    if (adminView) adminView.style.display = 'none';
    const dashboardView = document.getElementById('dashboard-view');
    if (dashboardView) dashboardView.style.display = 'none';

    const topBarControls = document.getElementById('top-bar-controls');
    if (topBarControls) topBarControls.style.display = 'none';

    const pageTitle = document.getElementById('page-title');
    if (pageTitle) pageTitle.textContent = 'Lịch sử OTP';
    reloadHistoryAndRender();
});

const navFirefoxBtn = document.getElementById('nav-firefox');
if (navFirefoxBtn) {
    navFirefoxBtn.addEventListener('click', (e) => {
        e.preventDefault();
        setActiveNav('nav-firefox');

        document.getElementById('active-view').style.display = 'none';
        document.getElementById('history-view').style.display = 'none';
        document.getElementById('firefox-view').style.display = 'block'; // Or flex if preferred
        const guideView = document.getElementById('guide-view');
        if (guideView) guideView.style.display = 'none';
        const adminView = document.getElementById('admin-view');
        if (adminView) adminView.style.display = 'none';
        const dashboardView = document.getElementById('dashboard-view');
        if (dashboardView) dashboardView.style.display = 'none';

        const topBarControls = document.getElementById('top-bar-controls');
        if (topBarControls) topBarControls.style.display = 'none';

        renderFirefoxPorts();
    });
}

const navGuideBtn = document.getElementById('nav-guide');
if (navGuideBtn) {
    navGuideBtn.addEventListener('click', (e) => {
        e.preventDefault();
        setActiveNav('nav-guide');

        document.getElementById('active-view').style.display = 'none';
        document.getElementById('history-view').style.display = 'none';
        const firefoxView = document.getElementById('firefox-view');
        if (firefoxView) firefoxView.style.display = 'none';
        const guideView = document.getElementById('guide-view');
        if (guideView) guideView.style.display = 'block';
        const adminView = document.getElementById('admin-view');
        if (adminView) adminView.style.display = 'none';
        const dashboardView = document.getElementById('dashboard-view');
        if (dashboardView) dashboardView.style.display = 'none';

        const topBarControls = document.getElementById('top-bar-controls');
        if (topBarControls) topBarControls.style.display = 'none';
    });
}

const navAdminBtn = document.getElementById('nav-admin');
if (navAdminBtn) {
    navAdminBtn.addEventListener('click', (e) => {
        e.preventDefault();
        setActiveNav('nav-admin');

        document.getElementById('active-view').style.display = 'none';
        document.getElementById('history-view').style.display = 'none';
        const firefoxView = document.getElementById('firefox-view');
        if (firefoxView) firefoxView.style.display = 'none';
        const guideView = document.getElementById('guide-view');
        if (guideView) guideView.style.display = 'none';
        
        const adminView = document.getElementById('admin-view');
        if (adminView) adminView.style.display = 'block';
        const dashboardView = document.getElementById('dashboard-view');
        if (dashboardView) dashboardView.style.display = 'none';

        const topBarControls = document.getElementById('top-bar-controls');
        if (topBarControls) topBarControls.style.display = 'none';
    });
}

const navContactBtn = document.getElementById('nav-contact');
if (navContactBtn) {
    navContactBtn.addEventListener('click', (e) => {
        e.preventDefault();
        setActiveNav('nav-contact');

        document.getElementById('active-view').style.display = 'none';
        document.getElementById('history-view').style.display = 'none';
        const firefoxView = document.getElementById('firefox-view');
        if (firefoxView) firefoxView.style.display = 'none';
        const guideView = document.getElementById('guide-view');
        if (guideView) guideView.style.display = 'none';
        const adminView = document.getElementById('admin-view');
        if (adminView) adminView.style.display = 'none';
        const dashboardView = document.getElementById('dashboard-view');
        if (dashboardView) dashboardView.style.display = 'none';
        
        const contactView = document.getElementById('contact-view');
        if (contactView) contactView.style.display = 'block';

        const topBarControls = document.getElementById('top-bar-controls');
        if (topBarControls) topBarControls.style.display = 'none';
    });
}

const navDashboardBtn = document.getElementById('nav-dashboard');
if (navDashboardBtn) {
    navDashboardBtn.addEventListener('click', (e) => {
        e.preventDefault();
        setActiveNav('nav-dashboard');

        document.getElementById('active-view').style.display = 'none';
        document.getElementById('history-view').style.display = 'none';
        const firefoxView = document.getElementById('firefox-view');
        if (firefoxView) firefoxView.style.display = 'none';
        const guideView = document.getElementById('guide-view');
        if (guideView) guideView.style.display = 'none';
        const contactView = document.getElementById('contact-view');
        if (contactView) contactView.style.display = 'none';
        const adminView = document.getElementById('admin-view');
        if (adminView) adminView.style.display = 'none';
        
        const dashboardView = document.getElementById('dashboard-view');
        if (dashboardView) dashboardView.style.display = 'flex';

        const topBarControls = document.getElementById('top-bar-controls');
        if (topBarControls) topBarControls.style.display = 'none';

        // Khởi tạo Dashboard Data
        const adminControls = document.getElementById('dashboard-admin-controls');
        if (currentUserProfile && currentUserProfile.role === 'admin' && !isImpersonating) {
            if (adminControls) adminControls.style.display = 'flex';
            loadDashboardData(document.getElementById('dashboard-tenant-select').value);
        } else {
            if (adminControls) adminControls.style.display = 'none';
            loadDashboardData('customer_self');
        }
    });
}

async function loginWithEmail() {
    let email = document.getElementById('auth-email').value.trim();
    let password = document.getElementById('auth-password').value;
    const errorText = document.getElementById('login-error-text');
    const btnText = document.getElementById('login-btn-text');
    const btnSubmit = document.getElementById('btn-login-submit');

    if (errorText) {
        errorText.style.display = 'none';
        errorText.textContent = '';
    }

    if (!email || !password) {
        if (errorText) {
            errorText.style.display = 'block';
            errorText.textContent = 'Vui lòng nhập đầy đủ Email và Mật khẩu.';
        } else {
            showToast('Vui lòng nhập email và mật khẩu', 'error');
        }
        return;
    }

    // Loading state
    if (btnText && btnSubmit) {
        btnText.textContent = 'Đang đăng nhập...';
        btnSubmit.disabled = true;
        btnSubmit.style.opacity = '0.7';
    }

    try {
        await auth.signInWithEmailAndPassword(email, password);
        // Thành công: không cần restore nút vì form sẽ tự ẩn khi đổi tab
        showToast('Đăng nhập thành công');
    } catch (error) {
        // Restore button
        if (btnText && btnSubmit) {
            btnText.textContent = 'Đăng nhập';
            btnSubmit.disabled = false;
            btnSubmit.style.opacity = '1';
        }

        let errorMsg = error.message;
        try {
            const parsed = JSON.parse(error.message);
            if (parsed.error && parsed.error.message) {
                errorMsg = parsed.error.message;
            }
        } catch(e) {}
        
        let friendlyMsg = 'Lỗi đăng nhập không xác định';
        if (errorMsg.includes('INVALID_LOGIN_CREDENTIALS') || errorMsg.includes('wrong-password') || errorMsg.includes('user-not-found')) {
            friendlyMsg = 'Sai tài khoản hoặc mật khẩu.';
        } else if (errorMsg.includes('USER_DISABLED') || errorMsg.includes('user-disabled')) {
            friendlyMsg = 'Tài khoản của bạn đã bị khoá.';
        } else if (errorMsg.includes('TOO_MANY_ATTEMPTS_TRY_LATER') || errorMsg.includes('too-many-requests')) {
            friendlyMsg = 'Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau.';
        } else if (errorMsg.includes('invalid-email')) {
            friendlyMsg = 'Định dạng email không hợp lệ.';
        } else {
            friendlyMsg = errorMsg;
        }
        
        if (errorText) {
            errorText.style.display = 'block';
            errorText.textContent = friendlyMsg;
        } else {
            showToast('Lỗi đăng nhập: ' + friendlyMsg, 'error');
        }
    }
}

async function adminCreateUser() {
    if (isImpersonating) return showToast('Bạn đang ở chế độ Chỉ Đọc', 'error');
    if (!currentUserProfile || currentUserProfile.role !== 'admin') {
        return showToast('Chỉ Admin mới có quyền tạo tài khoản', 'error');
    }
    
    const email = document.getElementById('admin-new-email').value.trim();
    const password = document.getElementById('admin-new-password').value;
    let customerId = document.getElementById('admin-new-customerid').value.trim();
    
    if (!email || !password) return showToast('Vui lòng điền Email và Mật khẩu', 'error');
    
    if (!customerId) {
        customerId = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '_');
    }
    
    let dailyLimit = parseInt(document.getElementById('admin-new-dailylimit').value) || 0;
    let expireDateStr = document.getElementById('admin-new-expiredate').value;
    let expireAt = 0;
    if (expireDateStr) {
        let ed = new Date(expireDateStr);
        ed.setHours(23, 59, 59, 999);
        expireAt = ed.getTime();
    }
    
    try {
        const userCredential = await secondaryApp.auth().createUserWithEmailAndPassword(email, password);
        const newUid = userCredential.user.uid;
        
        await db.ref(`users/${newUid}`).set({
            email: email,
            customerId: customerId,
            role: 'customer',
            active: true,
            deleted: false,
            limits: {
                dailyLimit: dailyLimit,
                expireAt: expireAt
            },
            internalNotes: {
                price: '',
                source: '',
                notes: '',
                issues: ''
            },
            createdBy: auth.currentUser.uid,
            createdAt: Date.now()
        });
        
        await db.ref('admin_logs').push({
            action: 'CREATE_USER',
            targetUid: newUid,
            targetEmail: email,
            by: auth.currentUser.uid,
            timestamp: Date.now()
        });
        
        showToast(`Tạo thành công khách hàng: ${email}`);
        document.getElementById('admin-new-email').value = '';
        document.getElementById('admin-new-password').value = '';
        document.getElementById('admin-new-customerid').value = '';
        document.getElementById('admin-create-form').style.display = 'none';
    } catch (error) {
        showToast('Lỗi tạo tài khoản: ' + error.message, 'error');
    }
}

async function toggleUserLock(uid, currentActive) {
    if (!currentUserProfile || currentUserProfile.role !== 'admin') return;
    try {
        await db.ref(`users/${uid}/active`).set(!currentActive);
        showToast(`Đã ${currentActive ? 'khoá' : 'mở khoá'} tài khoản!`);
    } catch (e) {
        showToast('Lỗi cập nhật trạng thái: ' + e.message, 'error');
    }
}

// Lắng nghe sự kiện cập nhật danh sách users (Dành cho Admin)
let adminUsersData = {};
let adminStatsData = {};

function setupAdminUserList() {
    db.ref('users').on('value', async (snapshot) => {
        adminUsersData = snapshot.val() || {};
        
        // Cập nhật thẻ Select trong Dashboard
        populateDashboardTenantSelect();
        
        // Lấy thống kê tất cả tenants
        try {
            const tenantsSnap = await db.ref('tenants').once('value');
            adminStatsData = tenantsSnap.val() || {};
        } catch(e) {
            console.error('Không thể lấy thống kê tenants', e);
        }
        
        renderAdminUsers();
    });
}

window.filterAdminUsers = function() {
    renderAdminUsers();
}

function populateDashboardTenantSelect() {
    const select = document.getElementById('dashboard-tenant-select');
    if (!select) return;
    
    // Giữ lại option hiện tại nếu có
    const currentVal = select.value;
    
    select.innerHTML = `
        <option value="all" style="background: #0f172a; color: white; padding: 8px;">Tất cả Khách (Tổng hợp)</option>
    `;
    
    Object.keys(adminUsersData).forEach(uid => {
        const u = adminUsersData[uid];
        if (u.role === 'admin') return; // Không hiển thị admin trong list khách
        
        const option = document.createElement('option');
        option.value = u.customerId;
        option.textContent = `Khách: ${u.email || u.customerId}`;
        option.style.background = '#0f172a';
        option.style.color = 'white';
        option.style.padding = '8px';
        select.appendChild(option);
    });
    
    // Khôi phục giá trị đã chọn
    if (currentVal && Array.from(select.options).some(o => o.value === currentVal)) {
        select.value = currentVal;
    }
}

function renderAdminUsers() {
    const adminUsersList = document.getElementById('admin-users-list');
    if (!adminUsersList) return;
    
    const searchTerm = (document.getElementById('admin-search-user')?.value || '').toLowerCase();
    const filterStatus = document.getElementById('admin-filter-status')?.value || 'all';
    
    adminUsersList.innerHTML = '';
    
    Object.keys(adminUsersData).forEach(uid => {
        const u = adminUsersData[uid];
        
        const isDeleted = u.deleted === true;
        const isActive = u.active !== false;
        
        // Tính toán thống kê nhanh
        let totalUsed = 0;
        let todayUsed = 0;
        const tenantData = adminStatsData[u.customerId];
        if (tenantData && tenantData.history) {
            const historyVals = Object.values(tenantData.history);
            totalUsed = historyVals.length;
            const todayStr = new Date().toLocaleDateString('vi-VN');
            todayUsed = historyVals.filter(item => {
                const ts = Number(item.timestamp || 0);
                if (ts > 0) return new Date(ts).toLocaleDateString('vi-VN') === todayStr;
                return (item.usedTime || '').includes(todayStr);
            }).length;
        }
        
        const limits = u.limits || { dailyLimit: 0, expireAt: 0 };
        const expireStr = limits.expireAt ? new Date(limits.expireAt).toLocaleDateString('vi-VN') : 'Không GH';
        const limitStr = limits.dailyLimit > 0 ? `${todayUsed}/${limits.dailyLimit}` : 'Không GH';
        
        // Kiểm tra Hết hạn và Limit
        const isExpired = limits.expireAt > 0 && limits.expireAt < Date.now();
        const isNearExpire = limits.expireAt > 0 && limits.expireAt - Date.now() < 3 * 24 * 60 * 60 * 1000 && !isExpired;
        const isOverLimit = limits.dailyLimit > 0 && todayUsed >= limits.dailyLimit;

        // Filtering
        if (filterStatus === 'active' && (!isActive || isDeleted)) return;
        if (filterStatus === 'locked' && (isActive || isDeleted)) return;
        if (filterStatus === 'deleted' && !isDeleted) return;
        if (filterStatus === 'expired' && (!isExpired || isDeleted)) return;
        if (filterStatus === 'near_expire' && (!isNearExpire || isDeleted)) return;
        if (filterStatus === 'over_limit' && (!isOverLimit || isDeleted)) return;
        if (filterStatus !== 'deleted' && isDeleted) return; // Mặc định ẩn deleted nếu filter = all/active/locked

        if (searchTerm) {
            const emailMatch = (u.email || '').toLowerCase().includes(searchTerm);
            const idMatch = (u.customerId || '').toLowerCase().includes(searchTerm);
            const phoneMatch = (u.internalNotes?.source || '').toLowerCase().includes(searchTerm);
            const noteMatch = (u.internalNotes?.notes || '').toLowerCase().includes(searchTerm);
            const priceMatch = (u.internalNotes?.price || '').toLowerCase().includes(searchTerm);
            const tagMatch = (u.internalNotes?.tags || '').toLowerCase().includes(searchTerm);
            if (!emailMatch && !idMatch && !phoneMatch && !noteMatch && !priceMatch && !tagMatch) return;
        }

        let tagsHtml = '';
        if (u.internalNotes?.tags) {
            const tags = u.internalNotes.tags.split(',').map(t => t.trim()).filter(Boolean);
            tagsHtml = tags.map(t => `<span style="display:inline-block; margin-left: 4px; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 500; background: rgba(59, 130, 246, 0.2); color: var(--primary-color);">${escapeHtml(t)}</span>`).join('');
        }

        let statusHtml = '';
        if (isDeleted) {
            statusHtml = `<span style="padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; background: rgba(100, 100, 100, 0.2); color: #aaa;">Đã Xoá</span>`;
        } else if (!isActive) {
            statusHtml = `<span style="padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; background: rgba(239, 68, 68, 0.1); color: var(--danger);">Đã Khoá</span>`;
        } else {
            if (isExpired) {
                statusHtml += `<span style="display:inline-block; margin-bottom:4px; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; background: rgba(239, 68, 68, 0.1); color: var(--danger);">Hết hạn</span><br>`;
            }
            if (isOverLimit) {
                statusHtml += `<span style="display:inline-block; margin-bottom:4px; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; background: rgba(245, 158, 11, 0.1); color: var(--warning);">Vượt Limit</span><br>`;
            }
            if (!isExpired && !isOverLimit) {
                statusHtml = `<span style="padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; background: rgba(16, 185, 129, 0.1); color: var(--success);">Hoạt động</span>`;
            }
        }
        
        if (u.role !== 'admin' && !isDeleted) {
            statusHtml += `<div style="margin-top: 6px; display: flex; align-items: center; justify-content: flex-start;">
                <label class="switch" style="transform: scale(0.7); transform-origin: left center; margin: 0;">
                    <input type="checkbox" onchange="toggleToolGsm('${uid}', this.checked)" ${u.allowGsmTool ? 'checked' : ''}>
                    <span class="slider round"></span>
                </label>
                <span style="font-size:10px; font-weight: 600; color:var(--text-muted); margin-left: -6px;">Tool GSM</span>
            </div>`;
        }

        const row = document.createElement('div');
        row.className = 'grid-row';
        if ((isExpired || isOverLimit) && !isDeleted) row.style.borderLeft = '3px solid var(--danger)';
        
        row.innerHTML = `
            <div class="col-admin-email" title="${escapeHtml(u.email || '')}">${escapeHtml(u.email || '')} ${u.role === 'admin' ? '<span style="color:var(--warning);font-size:10px;">[ADMIN]</span>' : ''} <br> ${tagsHtml}</div>
            <div class="col-admin-tenant">${escapeHtml(u.customerId || '')}</div>
            <div class="col-admin-limits">Ngày: <b>${limitStr}</b><br>Hạn: <b>${expireStr}</b></div>
            <div class="col-admin-stats">Tổng: <b>${totalUsed}</b><br>Hôm nay: <b>${todayUsed}</b></div>
            <div class="col-admin-status">
                ${statusHtml}
            </div>
            <div class="col-admin-actions">
                ${u.role !== 'admin' ? `
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 11px;" onclick="openEditUserModal('${uid}')" title="Cấu hình & Ghi chú"><i data-lucide="settings" style="width:14px;height:14px;"></i> Sửa</button>
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 11px; color: var(--warning); border-color: var(--warning);" onclick="adminResetPassword('${u.email}')" title="Reset Mật Khẩu"><i data-lucide="key" style="width:14px;height:14px;"></i></button>
                    <button class="btn btn-primary" style="padding: 4px 8px; font-size: 11px;" onclick="viewUserStats('${u.customerId}')" title="Xem Thống Kê"><i data-lucide="pie-chart" style="width:14px;height:14px;"></i></button>
                    <button class="btn btn-primary" style="padding: 4px 8px; font-size: 11px;" onclick="simulateUser('${u.customerId}')" title="Xem Lịch Sử"><i data-lucide="history" style="width:14px;height:14px;"></i></button>
                    ${!isDeleted ? `<button class="btn btn-outline" style="padding: 4px 8px; font-size: 11px; color: var(--danger); border-color: var(--danger);" onclick="adminDeleteUser('${uid}', true)" title="Xoá Mềm"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>` : `<button class="btn btn-outline" style="padding: 4px 8px; font-size: 11px;" onclick="adminDeleteUser('${uid}', false)" title="Khôi phục"><i data-lucide="refresh-cw" style="width:14px;height:14px;"></i></button>`}
                ` : ''}
            </div>
        `;
        adminUsersList.appendChild(row);
    });
    if (window.lucide) lucide.createIcons();
    if (window.lucide) lucide.createIcons();
}

window.toggleToolGsm = async function(uid, isEnabled) {
    if (isImpersonating) return showToast('Không thể thay đổi thiết lập trong chế độ xem (Impersonate)', 'error');
    if (!currentUserProfile || currentUserProfile.role !== 'admin') return;
    
    try {
        await db.ref(`users/${uid}/allowGsmTool`).set(isEnabled);
        
        // Ghi log
        const u = adminUsersData[uid];
        await db.ref('admin_logs').push({
            action: 'UPDATE_TOOLGSM',
            targetUid: uid,
            adminEmail: currentUserProfile.email,
            details: `Thay đổi quyền Tool GSM cho khách hàng [${u?.email || uid}]: ${isEnabled ? 'Bật' : 'Tắt'}`,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
        showToast(`Đã ${isEnabled ? 'Bật' : 'Tắt'} quyền đẩy tool GSM cho khách hàng này.`, 'success');
    } catch (e) {
        console.error(e);
        showToast('Lỗi thay đổi thiết lập: ' + e.message, 'error');
        renderAdminUsers(); // revert UI
    }
}

window.simulateUser = async function(customerId) {
    if (!currentUserProfile || currentUserProfile.role !== 'admin') return;
    
    if (await showConfirm(`Hệ thống sẽ mở tab Lịch sử dưới góc nhìn của khách hàng [${customerId}]. Nhấn F5 (Tải lại trang) nếu bạn muốn thoát chế độ này.`)) {
        window.viewingTenantId = customerId;
        isImpersonating = true;
        
        // Dọn dẹp state lịch sử hiện tại
        state.history = [];
        
        // Về trang Lịch Sử
        const navHistory = document.getElementById('nav-history');
        if (navHistory) navHistory.click();
        
        // Hiển thị Banner
        const banner = document.getElementById('impersonation-banner');
        if (banner) {
            banner.textContent = `ĐANG XEM DỮ LIỆU KHÁCH [${customerId}] (CHẾ ĐỘ CHỈ ĐỌC) - Vui lòng F5 trang web để thoát.`;
            banner.style.display = 'block';
        }
        
        // Chặn các tính năng tạo SMS bằng cách ẩn UI
        const activeView = document.getElementById('active-view');
        const ffView = document.getElementById('firefox-view');
        if (activeView) activeView.style.pointerEvents = 'none';
        if (activeView) activeView.style.opacity = '0.5';
        if (ffView) ffView.style.pointerEvents = 'none';
        if (ffView) ffView.style.opacity = '0.5';
        
        showToast(`Đang hiển thị lịch sử của khách: ${customerId}`);
    }
}

window.openAdminLogsModal = async function() {
    if (!currentUserProfile || currentUserProfile.role !== 'admin') return;
    
    document.getElementById('admin-logs-modal').classList.add('active');
    const list = document.getElementById('admin-logs-list');
    list.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted);">Đang tải nhật ký... <i class="lucide-loader animate-spin" style="width: 16px; height: 16px; display: inline-block; vertical-align: middle;"></i></div>`;
    
    try {
        const snap = await db.ref('admin_logs').orderByChild('timestamp').limitToLast(100).once('value');
        const logs = snap.val() || {};
        
        list.innerHTML = '';
        const sortedKeys = Object.keys(logs).sort((a, b) => logs[b].timestamp - logs[a].timestamp);
        
        if (sortedKeys.length === 0) {
            list.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted);">Chưa có nhật ký nào.</div>`;
            return;
        }
        
        sortedKeys.forEach(k => {
            const item = logs[k];
            const d = new Date(item.timestamp || Date.now());
            const dateStr = `${d.toLocaleDateString('vi-VN')} ${d.toLocaleTimeString('vi-VN')}`;
            
            let actionText = item.action;
            let actionColor = 'var(--text-main)';
            switch(item.action) {
                case 'CREATE_USER': actionText = 'Tạo User mới'; actionColor = 'var(--success)'; break;
                case 'UPDATE_CONFIG': actionText = 'Sửa Cấu hình'; actionColor = 'var(--primary-color)'; break;
                case 'SOFT_DELETE': actionText = 'Xoá Mềm'; actionColor = 'var(--danger)'; break;
                case 'RESTORE_USER': actionText = 'Khôi phục User'; actionColor = 'var(--success)'; break;
                case 'RESET_PASSWORD': actionText = 'Reset Mật khẩu'; actionColor = 'var(--warning)'; break;
            }
            
            let byEmail = 'N/A';
            if (adminUsersData[item.by]) byEmail = adminUsersData[item.by].email;
            
            let targetEmail = item.targetUid;
            if (adminUsersData[item.targetUid]) targetEmail = adminUsersData[item.targetUid].email;
            
            const row = document.createElement('div');
            row.className = 'grid-row';
            row.style.borderBottom = '1px solid var(--border-color)';
            row.innerHTML = `
                <div style="font-size: 12px; color: var(--text-muted);">${dateStr}</div>
                <div style="font-size: 13px;">${escapeHtml(byEmail)}</div>
                <div style="font-size: 13px; font-weight: 600; color: ${actionColor};">${actionText}</div>
                <div style="font-size: 13px; color: var(--text-muted);">${escapeHtml(targetEmail)}</div>
            `;
            list.appendChild(row);
        });
        
    } catch (e) {
        list.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--danger);">Lỗi tải nhật ký: ${e.message}</div>`;
    }
}

window.openEditUserModal = function(uid) {
    const u = adminUsersData[uid];
    if (!u) return;

    document.getElementById('edit-user-uid').value = uid;
    document.getElementById('edit-user-dailylimit').value = u.limits?.dailyLimit || 0;
    
    if (u.limits?.expireAt) {
        const d = new Date(u.limits.expireAt);
        document.getElementById('edit-user-expiredate').value = d.toISOString().split('T')[0];
    } else {
        document.getElementById('edit-user-expiredate').value = '';
    }

    document.getElementById('edit-user-price').value = u.internalNotes?.price || '';
    document.getElementById('edit-user-source').value = u.internalNotes?.source || '';
    document.getElementById('edit-user-tags').value = u.internalNotes?.tags || '';
    document.getElementById('edit-user-notes').value = u.internalNotes?.notes || '';
    document.getElementById('edit-user-issues').value = u.internalNotes?.issues || '';

    document.getElementById('edit-user-modal').classList.add('active');
}

window.quickExtendDays = function(days) {
    const input = document.getElementById('edit-user-expiredate');
    let baseDate = new Date();
    if (input.value) {
        const current = new Date(input.value);
        if (current > baseDate) baseDate = current; // Gia hạn nối tiếp nếu chưa hết hạn
    }
    baseDate.setDate(baseDate.getDate() + days);
    input.value = baseDate.toISOString().split('T')[0];
}

window.adminSaveUserConfig = async function() {
    if (isImpersonating) return showToast('Bạn đang ở chế độ Chỉ Đọc', 'error');
    if (!currentUserProfile || currentUserProfile.role !== 'admin') return;
    
    const uid = document.getElementById('edit-user-uid').value;
    const dailyLimit = parseInt(document.getElementById('edit-user-dailylimit').value) || 0;
    const expireDateStr = document.getElementById('edit-user-expiredate').value;
    const expireAt = expireDateStr ? new Date(expireDateStr).getTime() : 0;
    
    const price = document.getElementById('edit-user-price').value.trim();
    const source = document.getElementById('edit-user-source').value.trim();
    const tags = document.getElementById('edit-user-tags').value.trim();
    const notes = document.getElementById('edit-user-notes').value.trim();
    const issues = document.getElementById('edit-user-issues').value.trim();

    try {
        await db.ref(`users/${uid}/limits`).set({ dailyLimit, expireAt });
        await db.ref(`users/${uid}/internalNotes`).set({ price, source, tags, notes, issues });
        
        await db.ref('admin_logs').push({
            action: 'UPDATE_CONFIG',
            targetUid: uid,
            by: auth.currentUser.uid,
            timestamp: Date.now()
        });

        showToast('Đã lưu cấu hình Khách hàng!');
        closeModal('edit-user-modal');
    } catch (e) {
        showToast('Lỗi lưu cấu hình: ' + e.message, 'error');
    }
}

window.adminDeleteUser = async function(uid, setDeleted) {
    if (isImpersonating) return showToast('Bạn đang ở chế độ Chỉ Đọc', 'error');
    if (!currentUserProfile || currentUserProfile.role !== 'admin') return;
    const u = adminUsersData[uid];
    if (!u) return;

    if (setDeleted) {
        if (!(await showConfirm(`Bạn có chắc chắn muốn XOÁ MỀM khách [${u.email}]? Khách sẽ bị mất quyền truy cập hệ thống.`))) return;
    }

    try {
        await db.ref(`users/${uid}/deleted`).set(setDeleted);
        // Tự động vô hiệu hoá hoặc kích hoạt
        await db.ref(`users/${uid}/active`).set(!setDeleted);
        
        await db.ref('admin_logs').push({
            action: setDeleted ? 'SOFT_DELETE' : 'RESTORE_USER',
            targetUid: uid,
            by: auth.currentUser.uid,
            timestamp: Date.now()
        });
        showToast(setDeleted ? 'Đã xoá mềm thành công!' : 'Đã khôi phục thành công!');
    } catch (e) {
        showToast('Lỗi thao tác: ' + e.message, 'error');
    }
}

window.adminResetPassword = async function(email) {
    if (isImpersonating) return showToast('Bạn đang ở chế độ Chỉ Đọc', 'error');
    if (!(await showConfirm(`Gửi email đặt lại mật khẩu cho: ${email}?`))) return;
    try {
        await auth.sendPasswordResetEmail(email);
        showToast(`Đã gửi thư Reset Mật Khẩu tới: ${email}`);
        
        await db.ref('admin_logs').push({
            action: 'RESET_PASSWORD',
            targetEmail: email,
            by: auth.currentUser.uid,
            timestamp: Date.now()
        });
    } catch (e) {
        showToast('Lỗi gửi email: ' + e.message, 'error');
    }
}

window.viewUserStats = function(customerId) {
    const navDashboardBtn = document.getElementById('nav-dashboard');
    if (navDashboardBtn) {
        navDashboardBtn.click();
        const tenantSelect = document.getElementById('dashboard-tenant-select');
        if (tenantSelect) {
            // Thêm option tạm thời nếu chưa có để xem riêng khách này
            let opt = tenantSelect.querySelector(`option[value="${customerId}"]`);
            if (!opt) {
                opt = document.createElement('option');
                opt.value = customerId;
                opt.textContent = `Khách: ${customerId}`;
                tenantSelect.appendChild(opt);
            }
            tenantSelect.value = customerId;
            loadDashboardData(customerId);
        }
    }
}

function logout() {
    auth.signOut();
}

window.checkUserLimits = function() {
    // Admin không bị giới hạn hoặc chế độ đọc
    if (!currentUserProfile || currentUserProfile.role === 'admin' || isImpersonating) return true;

    const limits = currentUserProfile.limits;
    if (!limits) return true;

    if (limits.expireAt > 0 && limits.expireAt < Date.now()) {
        showToast('Tài khoản của bạn đã HẾT HẠN sử dụng. Vui lòng liên hệ Admin.', 'error');
        return false;
    }

    if (limits.dailyLimit > 0) {
        // Đếm số OTP hôm nay trong state.history
        const todayStr = new Date().toLocaleDateString('vi-VN');
        const todayCount = (state.history || []).filter(item => {
            const ts = Number(item.timestamp || 0);
            if (ts > 0) return new Date(ts).toLocaleDateString('vi-VN') === todayStr;
            return (item.usedTime || '').includes(todayStr);
        }).length;

        if (todayCount >= limits.dailyLimit) {
            showToast(`Bạn đã vượt quá giới hạn ${limits.dailyLimit} OTP / ngày. Vui lòng thử lại vào ngày mai.`, 'error');
            return false;
        }
    }

    return true;
}

auth.onAuthStateChanged(async (user) => {
    if (user) {
        // Đã đăng nhập
        try {
            const snapshot = await db.ref(`users/${user.uid}`).once('value');
            if (snapshot.exists()) {
                currentUserProfile = snapshot.val();
                
                // RBAC: Check active status
                if (currentUserProfile.active === false) {
                    showToast('Tài khoản của bạn đã bị khoá', 'error');
                    auth.signOut();
                    return;
                }
            } else {
                // P1: Chặn không tự động tạo profile. Yêu cầu Admin cấp quyền.
                showToast('Tài khoản của bạn chưa được cấp phép truy cập. Vui lòng liên hệ Admin.', 'error');
                auth.signOut();
                return;
            }
            
            document.getElementById('login-container').style.display = 'none';
            document.getElementById('main-app').style.display = 'flex';
            
            // RBAC: Show/hide Admin tab
            const navAdmin = document.getElementById('nav-admin');
            if (currentUserProfile.role === 'admin') {
                if (navAdmin) navAdmin.style.display = 'flex';
            } else {
                if (navAdmin) navAdmin.style.display = 'none';
            }
            
            showToast(`Xin chào, ID của bạn là: ${currentUserProfile.customerId}`);
            
            initializeAppFlow();
        } catch (e) {
            console.error('Lỗi khi tải hồ sơ', e);
            showToast('Lỗi tải hồ sơ người dùng', 'error');
            auth.signOut();
        }
    } else {
        // Chưa đăng nhập
        currentUserProfile = null;
        document.getElementById('login-container').style.display = 'flex';
        document.getElementById('main-app').style.display = 'none';
        
        // Dọn dẹp dữ liệu hiển thị
        state.ports = [];
        state.history = [];
        state.firefoxPorts = [];
        if (typeof renderPorts === 'function') renderPorts();
        if (typeof renderFirefoxPorts === 'function') {
            const fv = document.getElementById('firefox-view');
            if (fv && (fv.style.display === 'block' || fv.style.display === 'flex')) renderFirefoxPorts();
        }
    }
});

// Init
let isAppInitialized = false;
function initializeAppFlow() {
    if (isAppInitialized) return;
    isAppInitialized = true;
    
    if (currentUserProfile && currentUserProfile.role === 'admin') {
        setupAdminUserList();
    }
    
    loadFirefoxConfig();


    // Global Note Sync
    const noteEl = document.getElementById('global-note');
    if (noteEl) {
        let isLocalUpdate = false;

        db.ref('global_note').on('value', (snapshot) => {
            const val = snapshot.val() || '';
            if (!isLocalUpdate) {
                noteEl.value = val;
            }
        });

        noteEl.addEventListener('input', (e) => {
            isLocalUpdate = true;
            db.ref('global_note').set(e.target.value).then(() => {
                isLocalUpdate = false;
            });
        });
    }

    // Load history từ Firebase và kết hợp với local
    const renderHistorySafe = () => {
        const view = document.getElementById('history-view');
        if (view && view.style.display !== 'none') {
            renderHistory();
        }
    };

    db.ref(tenantPath('history'))
      .orderByChild('timestamp')
      .limitToLast(500)
      .on('value', (snapshot) => {
          const data = snapshot.val();

          const firebaseHistory = data
              ? Object.entries(data).map(([key, value]) => ({
                  ...value,
                  phone: value?.phone ? normalizePhoneNumber(value.phone) : value?.phone,
                  fbKey: key
              }))
              : [];

          let localHistory = [];
          try {
              localHistory = JSON.parse(localStorage.getItem(tenantStorageKey('gsm_history')) || '[]');
              if (!Array.isArray(localHistory)) localHistory = [];
          } catch {
              localHistory = [];
          }

          state.history = [...firebaseHistory, ...localHistory];

          renderHistorySafe();
          applyWebStates();
      }, (error) => {
          console.error('Lỗi tải history:', error);
          const container = document.getElementById('history-container');
          if (container) {
              container.innerHTML = `<div style="padding:40px;color:var(--danger);">Lỗi tải lịch sử OTP: ${escapeHtml(error.message)}</div>`;
          }
      });

    db.ref('command_results').orderByChild('updatedAt').limitToLast(200).on('value', async (snapshot) => {
        const results = snapshot.val() || {};

        for (const id in commandResults) {
            if (!results[id]) {
                delete commandResults[id];
                delete appliedCommandResults[id];
            }
        }

        const visibleResults = { ...commandResults };
        const now = Date.now() + serverTimeOffset;
        const AGE_LIMIT = 30 * 60 * 1000;

        for (const [commandId, result] of Object.entries(results)) {
            if (result.updatedAt && (now - result.updatedAt) > AGE_LIMIT) {
                delete visibleResults[commandId];
                continue;
            }
            const signature = `${result.status || ''}_${result.updatedAt || ''}_${result.error || ''}`;
            if (appliedCommandResults[commandId] === signature) continue;
            if (await applyCommandResult(commandId, result)) {
                appliedCommandResults[commandId] = signature;
                visibleResults[commandId] = result;
            }
        }

        commandResults = visibleResults;
        renderOperationalPanels();
    });

    fetchPorts();

    // Firebase on('value') tự động realtime nên không cần setInterval hay SSE nữa
    // Lắng nghe server_status đã được gộp vào fetchPorts() qua lastSyncByMachine

    setInterval(checkConnectionStatus, 2000);
    setInterval(cleanupStalePortCommands, 30000);
};

function checkConnectionStatus() {
    const indicator = document.querySelector('.system-status .status-indicator');
    const textSpan = document.querySelector('.system-status span');

    const now = Date.now() + serverTimeOffset;
    let hasChanges = false;

    // Loại bỏ các cổng của máy tính đã chết (không có ping trong 15s)
    const alivePorts = state.ports.filter(p => {
        if (p.isTest) return true;
        const lastSync = lastSyncByMachine[p.machineId] || 0;
        return (now - lastSync) <= 15000;
    });

    if (alivePorts.length !== state.ports.length) {
        state.ports = alivePorts;
        hasChanges = true;
    }

    if (hasChanges) {
        renderPorts();
    }

    if (!indicator || !textSpan) return;

    const visibleCount = state.ports.filter(p => !p.hidden && !p.isTest).length;

    let isAnyAlive = false;
    Object.values(lastSyncByMachine).forEach(sync => {
        if (now - sync <= 15000) isAnyAlive = true;
    });

    // Nếu không có máy nào sống
    if (!isAnyAlive && Object.keys(lastSyncByMachine).length > 0) {
        indicator.className = 'status-indicator';
        indicator.style.background = 'red';
        textSpan.textContent = `Hệ thống mất kết nối (${visibleCount} Cổng)`;
    } else {
        indicator.className = 'status-indicator online';
        indicator.style.background = '';
        textSpan.textContent = `Hệ thống trực tuyến (${visibleCount} Cổng)`;
    }
}

// Đóng modal khi nhấn ra ngoài
window.onclick = function (event) {
    if (event.target.classList.contains('modal-overlay')) {
        closeModal(event.target.id);
    }
}

// --------------------------------------------------------
// Firefox API Integration
// --------------------------------------------------------

function getFfConfigKey() { return tenantStorageKey('firefox_api_config'); }
function getFfPortsKey() { return tenantStorageKey('firefox_api_ports'); }

function loadFirefoxConfig() {
    try {
        const config = JSON.parse(localStorage.getItem(getFfConfigKey()) || '{}');
        const baseUrlEl = document.getElementById('ff-base-url');
        if (baseUrlEl) baseUrlEl.value = config.baseUrl || '/api/firefox';

        const tokenEl = document.getElementById('ff-token');
        if (tokenEl) tokenEl.value = config.token || '';

        const srvIdEl = document.getElementById('ff-service-id');
        if (srvIdEl) srvIdEl.value = config.serviceId || '';

        const countryEl = document.getElementById('ff-country');
        if (countryEl) countryEl.value = config.country || 'vn';

        state.firefoxPorts = JSON.parse(localStorage.getItem(getFfPortsKey()) || '[]');

        // Clean up expired ports on load
        const now = Date.now();
        state.firefoxPorts.forEach(p => {
            if (p.status === 'waiting' && p.expireTime <= now) {
                p.status = 'releasing';
                callFirefoxApi({ act: 'setRel', pkey: p.pkey }).then(res => {
                    if (res && res.startsWith('1|')) {
                        state.firefoxPorts = state.firefoxPorts.filter(px => px.pkey !== p.pkey);
                        saveFirefoxPorts();
                    } else if (res && res.startsWith('0|')) {
                        const errCode = res.split('|')[1];
                        if (!isNaN(errCode) && parseInt(errCode) > 0) {
                            const fp = state.firefoxPorts.find(px => px.pkey === p.pkey);
                            if (fp) {
                                fp.status = 'waiting';
                                fp.expireTime = Date.now() + (parseInt(errCode) + 2) * 1000;
                                saveFirefoxPorts();
                            }
                        } else {
                            const fp = state.firefoxPorts.find(px => px.pkey === p.pkey);
                            if (fp) {
                                fp.status = 'releasing_failed';
                                fp.lastError = res;
                                saveFirefoxPorts();
                            }
                        }
                    } else {
                        const fp = state.firefoxPorts.find(px => px.pkey === p.pkey);
                        if (fp) {
                            fp.status = 'releasing_failed';
                            fp.lastError = res;
                            saveFirefoxPorts();
                        }
                    }
                }).catch(e => {
                    const fp = state.firefoxPorts.find(px => px.pkey === p.pkey);
                    if (fp) {
                        fp.status = 'releasing_failed';
                        fp.lastError = e.message;
                        saveFirefoxPorts();
                    }
                });
            }
        });
        saveFirefoxPorts();
    } catch (e) {
        console.error('Failed to load firefox config', e);
    }
}

function saveFirefoxPorts() {
    localStorage.setItem(getFfPortsKey(), JSON.stringify(state.firefoxPorts));
    const ffView = document.getElementById('firefox-view');
    if (ffView && (ffView.style.display === 'block' || ffView.style.display === 'flex')) {
        renderFirefoxPorts();
    }
}

window.firefoxSaveConfig = function () {
    if (isImpersonating) return showToast('Bạn đang ở chế độ Chỉ Đọc', 'error');
    const config = {
        baseUrl: document.getElementById('ff-base-url') ? document.getElementById('ff-base-url').value.trim() : '/api/firefox',
        token: 'HIDDEN',
        serviceId: document.getElementById('ff-service-id') ? document.getElementById('ff-service-id').value.trim() : '1049',
        country: document.getElementById('ff-country') ? document.getElementById('ff-country').value.trim() : 'vnm'
    };
    localStorage.setItem(getFfConfigKey(), JSON.stringify(config));
    showToast('Đã lưu cấu hình Firefox API');
    return config;
}

function getFirefoxConfig() {
    return {
        baseUrl: '/api/firefox',
        token: 'HIDDEN',
        serviceId: '1049',
        country: 'vnm'
    };
}

async function callFirefoxApi(params) {
    const config = getFirefoxConfig();
    const baseUrl = config.baseUrl || '/api/firefox';
    if (!config.token && params.act !== 'getItem') {
        showToast('Vui lòng nhập Token trước!', 'error');
        return null;
    }

    if (config.token) {
        params.token = config.token;
    }

    let urlStr = baseUrl;
    if (urlStr.includes('?')) {
        urlStr += '&' + new URLSearchParams(params).toString();
    } else {
        urlStr += '?' + new URLSearchParams(params).toString();
    }

    try {
        const response = await fetch(urlStr, {
            method: 'GET',
        });
        const text = await response.text();
        return text;
    } catch (e) {
        showToast(`Lỗi gọi API: ${e.message}`, 'error');
        return null;
    }
}

window.firefoxCheckBalance = async function () {
    const res = await callFirefoxApi({ act: 'myInfo' });
    if (res) {
        const parts = res.split('|');
        if (parts[0] === '1' && parts[1]) {
            const balEl = document.getElementById('firefox-balance');
            const levelEl = document.getElementById('firefox-level');
            const intEl = document.getElementById('firefox-integral');
            if (balEl) balEl.textContent = `Số dư: ${parts[1]} VND`;
            if (levelEl && parts[2]) levelEl.textContent = `Cấp độ: ${parts[2]}`;
            if (intEl && parts[3]) intEl.textContent = `Điểm: ${parts[3]}`;
            showToast(`Kết nối thành công. Số dư: ${parts[1]} VND`);
        } else if (res === '0|-3') {
            showToast('Lỗi: Thao tác quá nhanh, vui lòng đợi 60s trước khi kiểm tra lại.', 'error');
        } else if (res === '0|-1' || res === '0|-2') {
            showToast('Lỗi: Token không hợp lệ hoặc đã hết hạn.', 'error');
        } else {
            showToast(`Lỗi kiểm tra số dư: ${res}`, 'error');
        }
    }
}

window.firefoxGetPhone = async function () {
    if (isImpersonating) return showToast('Bạn đang ở chế độ Chỉ Đọc', 'error');
    const config = getFirefoxConfig();
    if (!config.serviceId) {
        showToast('Vui lòng nhập Service ID!', 'error');
        return;
    }

    showToast('Đang thuê số mới...');
    const res = await callFirefoxApi({
        act: 'getPhone',
        iid: config.serviceId,
        country: config.country || 'vn'
    });

    if (res) {
        const parts = res.split('|');
        if (parts[0] === '1') {
            const pkey = parts[1];
            const mobile = parts[7] || parts[4]; // Fallback if format is weird, but docs say 7

            state.firefoxPorts.unshift({
                pkey: pkey,
                phone: mobile,
                status: 'waiting',
                startTime: Date.now(),
                expireTime: Date.now() + 5 * 60 * 1000, // 5 phút timeout (mặc định)
                otp: null,
                smsContent: null
            });
            saveFirefoxPorts();
            showToast(`Thuê số thành công: ${mobile}`);
        } else if (parts[0] === '0') {
            const errCode = parts[1];
            let errorMsg = `Lỗi thuê số (Mã ${errCode})`;
            switch (errCode) {
                case '-1': errorMsg = 'Đã hết số cho dịch vụ này'; break;
                case '-3': errorMsg = 'ID Dịch vụ không đúng'; break;
                case '-4': errorMsg = 'Mã quốc gia không đúng'; break;
                case '-8': errorMsg = 'Tài khoản không đủ tiền'; break;
                case '-9': errorMsg = 'Thuê quá nhiều số cùng lúc, vui lòng thử lại sau'; break;
            }
            showToast(errorMsg, 'error');
        } else {
            showToast(`Lỗi thuê số: ${res}`, 'error');
        }
    }
}

window.firefoxSetRel = async function (pkey) {
    if (isImpersonating) return showToast('Bạn đang ở chế độ Chỉ Đọc', 'error');
    const port = state.firefoxPorts.find(p => p.pkey === pkey);
    if (port) {
        port.status = 'releasing';
        saveFirefoxPorts();
        // Cập nhật UI ngay lập tức
        if (typeof renderFirefoxPorts === 'function') renderFirefoxPorts();
    }

    const res = await callFirefoxApi({ act: 'setRel', pkey: pkey });
    if (res && res.startsWith('1|')) {
        state.firefoxPorts = state.firefoxPorts.filter(p => p.pkey !== pkey);
        saveFirefoxPorts();
        showToast(`Đã huỷ số (Release) pkey ${pkey}`);
    } else if (res && res.startsWith('0|')) {
        const errCode = res.split('|')[1];
        if (!isNaN(errCode) && parseInt(errCode) > 0) {
            showToast(`Bạn phải chờ ${errCode} giây nữa mới được huỷ số này!`, 'error');
            const portToUpdate = state.firefoxPorts.find(p => p.pkey === pkey);
            if (portToUpdate) {
                portToUpdate.status = 'waiting';
                portToUpdate.expireTime = Date.now() + (parseInt(errCode) + 1) * 1000;
                saveFirefoxPorts();
            }
            return;
        }
        
        let confirmMsg = `Hệ thống báo lỗi: ${res}\nBạn có muốn bắt buộc xoá số này khỏi màn hình không?\n(Lưu ý: Số vẫn có thể bị tính phí nếu API chưa Huỷ thành công)`;
        if (errCode === '-4') {
            confirmMsg = `Hệ thống báo lỗi: 0|-4 (Lỗi: Số này đã nhận được tin nhắn từ tổng đài, API không cho phép huỷ/hoàn tiền nữa).\nBạn có muốn bắt buộc xoá số này khỏi màn hình không?`;
        }

        showToast(`Lỗi huỷ số: ${res}`, 'error');
        if (await showConfirm(confirmMsg)) {
            state.firefoxPorts = state.firefoxPorts.filter(p => p.pkey !== pkey);
            saveFirefoxPorts();
        }
    } else {
        showToast(`Lỗi huỷ số: ${res}`, 'error');
        if (await showConfirm(`Hệ thống báo lỗi: ${res}\nBạn có muốn bắt buộc xoá số này khỏi màn hình không?\n(Lưu ý: Số vẫn có thể bị tính phí nếu API chưa Huỷ thành công)`)) {
            state.firefoxPorts = state.firefoxPorts.filter(p => p.pkey !== pkey);
            saveFirefoxPorts();
        }
    }
}

window.firefoxAddBlack = async function (pkey) {
    if (isImpersonating) return showToast('Bạn đang ở chế độ Chỉ Đọc', 'error');
    const res = await callFirefoxApi({ act: 'addBlack', pkey: pkey, reason: 'error' });
    if (res && res.startsWith('1|')) {
        state.firefoxPorts = state.firefoxPorts.filter(p => p.pkey !== pkey);
        saveFirefoxPorts();
        showToast(`Đã Blacklist số pkey ${pkey}`);
    } else {
        let errorMsg = `Lỗi Blacklist: ${res}`;
        if (res && res.startsWith('0|')) {
            const errCode = res.split('|')[1];
            switch (errCode) {
                case '-1': errorMsg = 'Token lỗi hoặc hết hạn'; break;
                case '-2': errorMsg = 'PKey không hợp lệ hoặc đã hết hạn'; break;
                case '-3': errorMsg = 'Không thể Blacklist số này'; break;
            }
        }
        showToast(errorMsg, 'error');
        if (await showConfirm(`Hệ thống báo: ${errorMsg}\nBạn có muốn bắt buộc xoá số này khỏi màn hình không?`)) {
            state.firefoxPorts = state.firefoxPorts.filter(p => p.pkey !== pkey);
            saveFirefoxPorts();
        }
    }
}

window.firefoxSetAgain = async function (pkey) {
    if (!(await showConfirm('Dùng lại số (Reuse) sẽ bị tính phí thêm một lần nữa. Bạn có chắc chắn muốn dùng lại số này không?'))) return;

    showToast('Đang yêu cầu dùng lại số...');
    const res = await callFirefoxApi({ act: 'setAgain', pkey: pkey, min: 5 });
    if (res && res.startsWith('1|')) {
        const port = state.firefoxPorts.find(p => p.pkey === pkey);
        if (port) {
            port.status = 'waiting';
            port.expireTime = Date.now() + 5 * 60 * 1000;
            port.otp = '';
            port.smsContent = '';
            saveFirefoxPorts();
            showToast('Đã chuyển số về trạng thái Đang chờ để nhận OTP tiếp theo!');
        }
    } else {
        let errorMsg = `Lỗi dùng lại số: ${res}`;
        if (res && res.startsWith('0|')) {
            const errCode = res.split('|')[1];
            switch (errCode) {
                case '-1': errorMsg = 'Token lỗi hoặc hết hạn'; break;
                case '-2': errorMsg = 'PKey không hợp lệ hoặc đã huỷ'; break;
                case '-3': errorMsg = 'Không tìm thấy số để dùng lại'; break;
                case '-4': errorMsg = 'Số đang bị khoá hoặc không thể nhận SMS'; break;
                case '-8': errorMsg = 'Không đủ tiền để dùng lại số'; break;
            }
        }
        showToast(errorMsg, 'error');
    }
}

window.firefoxApiReturn = async function (pkey) {
    const remark = prompt('Nhập mã Feedback (0: Thành công, -1: Thất bại, -2: Không có mã, -3: Số đã bị dùng):', '0');
    if (remark === null) return; // user cancelled

    if (!['0', '-1', '-2', '-3'].includes(remark)) {
        showToast('Mã feedback không hợp lệ!', 'error');
        return;
    }

    showToast('Đang gửi feedback...');
    const res = await callFirefoxApi({ act: 'apiReturn', pkey: pkey, remark: remark });
    if (res && res.startsWith('1|')) {
        showToast('Gửi Feedback thành công!');
    } else {
        let errorMsg = `Lỗi Feedback: ${res}`;
        if (res && res.startsWith('0|')) {
            const errCode = res.split('|')[1];
            switch (errCode) {
                case '-1': errorMsg = 'Token lỗi hoặc hết hạn'; break;
                case '-2': errorMsg = 'PKey không hợp lệ'; break;
            }
        }
        showToast(errorMsg, 'error');
    }
}

let isFirefoxPolling = false;

function translateFirefoxReply(text) {
    if (!text) return text;
    let translated = text;
    const dict = {
        '短信发送成功': 'Gửi SMS thành công',
        '发送成功': 'Gửi thành công',
        '发送中': 'Đang gửi',
        '失败': 'Thất bại',
        '成功': 'Thành công',
        '等待接收': 'Đang chờ nhận mã'
    };
    for (const [zh, vi] of Object.entries(dict)) {
        translated = translated.replace(new RegExp(zh, 'g'), vi);
    }
    return translated;
}

function extractFirefoxOtp(code, smsText) {
    const joined = `${code || ''} ${smsText || ''}`;
    const match = joined.match(/\b\d{4,8}\b/);
    return match ? match[0] : '';
}

async function pollFirefoxOtps() {
    if (isFirefoxPolling) return;
    isFirefoxPolling = true;

    try {
        let hasChanges = false;
        const now = Date.now();

        for (let i = 0; i < state.firefoxPorts.length; i++) {
            const port = state.firefoxPorts[i];

            // Tự động Release nếu quá hạn
            if ((port.status === 'waiting' || port.status === 'waiting_receipt') && now > port.expireTime) {
                port.status = 'releasing';
                hasChanges = true;

                callFirefoxApi({ act: 'setRel', pkey: port.pkey }).then(res => {
                    if (res && res.startsWith('1|')) {
                        state.firefoxPorts = state.firefoxPorts.filter(p => p.pkey !== port.pkey);
                        saveFirefoxPorts();
                    } else if (res && res.startsWith('0|')) {
                        const errCode = res.split('|')[1];
                        if (!isNaN(errCode) && parseInt(errCode) > 0) {
                            const fp = state.firefoxPorts.find(p => p.pkey === port.pkey);
                            if (fp) {
                                fp.status = 'waiting';
                                fp.expireTime = Date.now() + (parseInt(errCode) + 2) * 1000;
                                saveFirefoxPorts();
                            }
                        } else {
                            const fp = state.firefoxPorts.find(p => p.pkey === port.pkey);
                            if (fp) {
                                fp.status = 'releasing_failed';
                                fp.lastError = res;
                                saveFirefoxPorts();
                            }
                        }
                    } else {
                        const fp = state.firefoxPorts.find(p => p.pkey === port.pkey);
                        if (fp) {
                            fp.status = 'releasing_failed';
                            fp.lastError = res;
                            saveFirefoxPorts();
                        }
                    }
                }).catch(e => {
                    const fp = state.firefoxPorts.find(p => p.pkey === port.pkey);
                    if (fp) {
                        fp.status = 'releasing_failed';
                        fp.lastError = e.message;
                        saveFirefoxPorts();
                    }
                });
                continue;
            }

            if (port.status === 'waiting' || port.status === 'waiting_receipt') {
                const res = await callFirefoxApi({ act: 'getPhoneCode', pkey: port.pkey });
                if (res) {
                    const parts = res.split('|');
                    if (parts[0] === '1' && parts[1]) {
                        const code = String(parts[1] || '').trim();
                        const smsText = parts.slice(2).join('|').trim();
                        
                        const translatedCode = translateFirefoxReply(code);
                        const translatedSmsText = translateFirefoxReply(smsText);

                        port.lastReply = translatedSmsText || translatedCode;
                        port.lastReplyAt = Date.now();

                        const otp = extractFirefoxOtp(code, smsText);

                        const isSendReceipt =
                            code.includes('发送成功') ||
                            smsText.includes('发送成功') ||
                            smsText.includes('短信发送成功');

                        if (isSendReceipt) {
                            if (port.status === 'waiting_receipt') {
                                port.lastStatus = 'SMS đã gửi thành công, đang lấy lại số...';
                                port.smsContent = port.lastReply;
                                hasChanges = true;

                                const config = getFirefoxConfig();
                                callFirefoxApi({
                                    act: 'getPhone',
                                    iid: config.serviceId,
                                    country: config.country || 'vn',
                                    mobile: port.phone
                                }).then(reuseRes => {
                                    if (reuseRes && reuseRes.startsWith('1|')) {
                                        const newPkey = reuseRes.split('|')[1];
                                        if (newPkey) {
                                            port.pkey = newPkey;
                                            port.status = 'waiting';
                                            port.lastStatus = 'Đã lấy lại số, đang chờ OTP';
                                            port.expireTime = Date.now() + 5 * 60 * 1000;
                                            saveFirefoxPorts();
                                            showToast('Đã lấy lại số thành công. Đang chờ OTP...');
                                        }
                                    } else {
                                        port.lastStatus = `Lỗi lấy lại số: ${reuseRes}`;
                                        saveFirefoxPorts();
                                        showToast(`Gửi SMS thành công, nhưng lấy lại số lỗi: ${reuseRes}`, 'error');
                                    }
                                });
                            } else {
                                port.lastStatus = 'SMS đã gửi thành công, đang chờ OTP';
                                port.smsContent = port.lastReply;
                                hasChanges = true;
                            }
                            continue;
                        }

                        if (otp) {
                            port.status = 'otp';
                            port.otp = otp;
                            port.smsContent = port.lastReply;
                            if (!port.otpReceivedAt) port.otpReceivedAt = Date.now();

                            // Lưu vào History
                            try {
                                const historyKey = `FIREFOX_${port.pkey}_${Date.now()}`;
                                const historyRef = db.ref(tenantPath(`history/${historyKey}`));
                                await historyRef.set({
                                    id: `FF_${port.pkey.slice(0, 5)}`,
                                    machineId: 'FIREFOX_API',
                                    phone: port.phone,
                                    otp: port.otp,
                                    usedTime: new Date().toLocaleTimeString('vi-VN'),
                                    timestamp: firebase.database.ServerValue.TIMESTAMP,
                                    customerId: getTenantId(),
                                    source: 'firefox',
                                    status: 'success'
                                });
                            } catch (err) {
                                console.error('Lỗi lưu Firebase:', err);
                                showToast(`Lỗi lưu lịch sử OTP lên hệ thống: ${err.message}`, 'error');
                            }

                            hasChanges = true;
                            playNotificationSound();
                            showToast(`Có OTP mới cho số ${port.phone}: ${port.otp}`);
                        } else {
                            port.lastStatus = `Phản hồi chưa có OTP: ${code}`;
                            port.smsContent = smsText;
                            hasChanges = true;
                            continue;
                        }
                    } else if (parts[0] === '0') {
                        const errCode = parts[1];

                        if (errCode === '-3') {
                            port.lastStatus = 'Chưa nhận được SMS/OTP, sẽ kiểm tra lại sau 5 giây';
                            port.lastReply = 'Đang chờ verification code';
                            port.lastReplyAt = Date.now();
                            hasChanges = true;
                            continue;
                        }

                        if (errCode === '-1') {
                            port.status = 'releasing_failed';
                            port.lastError = 'Token không tồn tại hoặc không hợp lệ';
                            hasChanges = true;
                            continue;
                        }

                        if (errCode === '-2') {
                            port.status = 'releasing_failed';
                            port.lastError = 'PKey không hợp lệ';
                            hasChanges = true;
                            continue;
                        }

                        if (errCode === '-4') {
                            port.status = 'releasing_failed';
                            port.lastError = 'Số không khả dụng, nên bỏ số này';
                            hasChanges = true;
                            continue;
                        }

                        if (errCode === '-5') {
                            port.status = 'releasing_failed';
                            port.lastError = 'Số đã bị black, nên bỏ số này';
                            hasChanges = true;
                            continue;
                        }

                        port.lastStatus = `Lỗi getPhoneCode: ${res}`;
                        hasChanges = true;
                    }
                }
            }
        }

        if (hasChanges) {
            saveFirefoxPorts();
        }
    } finally {
        isFirefoxPolling = false;
    }
}

// Timer rendering cho Firefox
setInterval(() => {
    const ffView = document.getElementById('firefox-view');
    if (ffView && (ffView.style.display === 'block' || ffView.style.display === 'flex')) {
        renderFirefoxPorts();
    }
}, 1000);

setInterval(pollFirefoxOtps, 5000);

window.renderFirefoxPorts = function () {
    const container = document.getElementById('firefox-container');
    if (!container) return;

    container.innerHTML = '';

    if (state.firefoxPorts.length === 0) {
        container.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--text-muted);">Không có số nào đang thuê.</div>`;
        return;
    }

    const now = Date.now();

    state.firefoxPorts.forEach(port => {
        const row = document.createElement('div');
        row.className = 'grid-row';
        if (port.status === 'waiting') {
            row.classList.add('row-highlight-warning');
        } else if (port.status === 'releasing_failed') {
            row.style.background = 'rgba(231, 76, 60, 0.1)';
        }

        let uiStatus = 'waiting';
        let statusLabel = 'Đang chờ';

        if (port.status === 'otp') {
            uiStatus = 'otp';
            statusLabel = 'Đã nhận';
        } else if (port.status === 'releasing') {
            uiStatus = 'waiting';
            statusLabel = 'Đang huỷ...';
        } else if (port.status === 'releasing_failed') {
            uiStatus = 'error';
            statusLabel = 'Huỷ lỗi';
        }

        const statusDot = `<span class="status-pill ${uiStatus}">${escapeHtml(statusLabel)}</span>`;

        let timeText = '--';
        if (port.status === 'waiting' || port.status === 'releasing') {
            const timeLeft = Math.max(0, Math.floor((port.expireTime - now) / 1000));
            if (timeLeft <= 60) {
                timeText = `${timeLeft}s`;
            } else {
                timeText = `${Math.floor(timeLeft / 60)}m ${timeLeft % 60}s`;
            }
        } else if (port.status === 'otp' && port.otpReceivedAt) {
            const dt = new Date(port.otpReceivedAt);
            timeText = `${dt.getHours().toString().padStart(2, '0')}:${dt.getMinutes().toString().padStart(2, '0')}:${dt.getSeconds().toString().padStart(2, '0')}`;
        }

        let otpContent = '';
        if (port.status === 'waiting' || port.status === 'releasing') {
            otpContent = `<span style="color: #f39c12">Đang chờ mã...</span>`;
            if (port.lastReply) {
                otpContent += `<br><span style="font-size:11px;color:var(--text-muted);">Phản hồi: ${escapeHtml(port.lastReply)}</span>`;
            }
        } else if (port.status === 'releasing_failed') {
            otpContent = `<span style="color: #e74c3c">Lỗi tự động huỷ: ${escapeHtml(port.lastError || 'Unknown')}</span>`;
            if (port.lastReply) {
                otpContent += `<br><span style="font-size:11px;color:var(--text-muted);">Phản hồi: ${escapeHtml(port.lastReply)}</span>`;
            }
        } else {
            otpContent = `<span class="otp-badge">${escapeHtml(port.otp)}</span> <br><span style="font-size:11px;color:gray;">${escapeHtml(port.smsContent)}</span>`;
        }

        let actionButtons = '';
        if (port.status === 'waiting') {
            actionButtons = `
                    <button class="btn btn-primary" onclick="firefoxOpenSmsModal('${port.pkey}', '${port.phone}')" title="Gửi SMS đi">
                        <i data-lucide="send"></i> Gửi SMS
                    </button>
                    <button class="btn btn-outline" onclick="firefoxSetRel('${port.pkey}')" title="Huỷ và không tính tiền">
                        <i data-lucide="x-circle"></i> Huỷ số
                    </button>
                    <button class="btn btn-outline" onclick="firefoxAddBlack('${port.pkey}')" title="Blacklist nếu lỗi">
                        <i data-lucide="slash"></i> Báo lỗi
                    </button>
             `;
        } else if (port.status === 'otp') {
            actionButtons = `
                    <button class="btn btn-primary" onclick="firefoxSetAgain('${port.pkey}')" title="Dùng lại số này (Tính thêm tiền)">
                        <i data-lucide="repeat"></i> Dùng lại
                    </button>
                    <button class="btn btn-outline" onclick="firefoxApiReturn('${port.pkey}')" title="Feedback trạng thái">
                        <i data-lucide="message-square"></i> Feedback
                    </button>
                    <button class="btn btn-outline" onclick="firefoxClosePort('${port.pkey}')" title="Đóng số">
                        <i data-lucide="check-circle"></i> Đóng
                    </button>
            `;
        } else if (port.status === 'releasing') {
            actionButtons = `
                    <button class="btn btn-outline" disabled>
                        <i data-lucide="loader"></i> Đang xử lý...
                    </button>
             `;
        } else if (port.status === 'releasing_failed') {
            actionButtons = `
                    <button class="btn btn-outline" onclick="firefoxSetRel('${port.pkey}')" title="Thử huỷ lại">
                        <i data-lucide="refresh-cw"></i> Thử lại
                    </button>
                    <button class="btn btn-outline" onclick="firefoxAddBlack('${port.pkey}')" title="Blacklist nếu lỗi (Bỏ số)">
                        <i data-lucide="slash"></i> Báo lỗi
                    </button>
                    <button class="btn btn-outline" onclick="firefoxClosePort('${port.pkey}')" title="Bỏ qua">
                        <i data-lucide="x"></i> Bỏ qua
                    </button>
            `;
        }

        row.innerHTML = `
            <div class="col-status" style="width: 80px;">${statusDot}</div>
            <div class="col-phone" style="width: 150px;">${escapeHtml(normalizePhoneNumber(port.phone))}</div>
            <div class="col-otp" style="flex: 1;">${otpContent}</div>
            <div class="col-time" style="width: 100px;">${timeText}</div>
            <div class="col-actions" style="width: 300px;">
                ${actionButtons}
            </div>
        `;

        container.appendChild(row);
    });

    if (window.lucide) {
        lucide.createIcons();
    }
}

window.firefoxClosePort = function (pkey) {
    state.firefoxPorts = state.firefoxPorts.filter(p => p.pkey !== pkey);
    saveFirefoxPorts();
}

window.firefoxOpenSmsModal = function (pkey, phone) {
    document.getElementById('ff-sms-pkey').value = pkey;
    document.getElementById('ff-sms-phone').textContent = phone;

    const select = document.getElementById('ff-sms-receiver-select');
    const customInput = document.getElementById('ff-sms-receiver-custom');

    select.value = '8500';
    customInput.value = '';
    customInput.style.display = 'none';

    document.getElementById('ff-sms-content').value = 'ZALO';
    document.getElementById('firefox-sms-modal').classList.add('active');
}

window.firefoxExecuteSendSms = async function () {
    if (isImpersonating) return showToast('Bạn đang ở chế độ Chỉ Đọc', 'error');
    const pkey = document.getElementById('ff-sms-pkey').value;

    let receiver = document.getElementById('ff-sms-receiver-select').value;
    if (receiver === 'custom') {
        receiver = document.getElementById('ff-sms-receiver-custom').value;
    }
    receiver = (receiver || '').trim();

    const content = document.getElementById('ff-sms-content').value.trim();

    if (!receiver || !content) {
        showToast('Vui lòng nhập đủ đầu số nhận và nội dung!', 'error');
        return;
    }
    if (/[,;\s]/.test(receiver)) {
        showToast('Chỉ được nhập một đầu số mỗi lần gửi. Không dùng dấu phẩy hoặc khoảng trắng.', 'error');
        return;
    }

    if (!checkUserLimits()) {
        return;
    }

    showToast('Đang gửi lệnh SMS...');
    const res = await callFirefoxApi({
        act: 'sendCode',
        pkey: pkey,
        receiver: receiver,
        smscontent: content
    });

    if (res && res.startsWith('1|')) {
        showToast('Đã gửi lệnh SMS thành công. Đang chờ xác nhận từ tổng đài...');

        const port = state.firefoxPorts.find(p => p.pkey === pkey);

        if (port?.phone) {
            port.status = 'waiting_receipt';
            port.lastStatus = 'Đang chờ biên lai gửi SMS...';
            port.lastReplyAt = Date.now();
            saveFirefoxPorts();
        }

        closeModal('firefox-sms-modal');
    } else {
        let errorMsg = `Lỗi gửi SMS: ${res}`;
        if (res && res.startsWith('0|')) {
            const errCode = res.split('|')[1];
            switch (errCode) {
                case '-1': errorMsg = 'Token lỗi (Không tồn tại hoặc hết hạn)'; break;
                case '-2': errorMsg = 'PKey không hợp lệ hoặc đã huỷ/hết hạn'; break;
                case '-3': errorMsg = 'Chưa có thông tin'; break;
                case '-4': errorMsg = 'Số không khả dụng (nên bỏ số)'; break;
                case '-5': errorMsg = 'Số đã bị Blacklist (nên bỏ số)'; break;
                case '-6':
                case '-7': errorMsg = `Số không gửi được SMS (Mã ${errCode}, nên bỏ số)`; break;
                case '-8': errorMsg = 'Dịch vụ này không hỗ trợ gửi SMS (Lỗi -8)'; break;
                case '-10': errorMsg = 'Nội dung SMS không đúng định dạng cho phép'; break;
                case '-11': errorMsg = 'Lỗi gửi trùng lặp nội dung'; break;
                default: errorMsg = `Lỗi gửi SMS (Mã: ${errCode})`; break;
            }
        }
        showToast(errorMsg, 'error');
    }
}

function processFirefoxServices(items) {
    const servicesMap = new Map();
    const countriesMap = new Map();

    items.forEach(item => {
        servicesMap.set(item.Item_ID, `${item.Item_Name} - ${item.Item_UPrice} VND`);
        if (item.Country_ID) {
            countriesMap.set(item.Country_ID, item.Country_Title);
        }
    });

    const srvDataList = document.getElementById('ff-services-list');
    if (srvDataList) {
        srvDataList.innerHTML = '';
        servicesMap.forEach((name, id) => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = `${name}`;
            srvDataList.appendChild(opt);
        });
    }

    const countryDataList = document.getElementById('ff-countries-list');
    if (countryDataList) {
        countryDataList.innerHTML = '';
        countriesMap.forEach((name, id) => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = `${name}`;
            countryDataList.appendChild(opt);
        });
    }

    window.ffGlobalPricingData = items;
    renderFirefoxPricingTable(items);
}

window.firefoxLoadServices = async function (force = false) {
    const cached = localStorage.getItem('ff_services_cache');
    if (cached && !force) {
        try {
            const items = JSON.parse(cached);
            processFirefoxServices(items);
            document.getElementById('firefox-pricing-modal').classList.add('active');
            showToast('Đã mở bảng giá (từ bộ nhớ tạm)!');
            return;
        } catch(e) {}
    }

    showToast('Đang tải danh sách dịch vụ...');
    try {
        const res = await callFirefoxApi({ act: 'getItem', key: '' });
        if (res && res.startsWith('[')) {
            const items = JSON.parse(res);
            localStorage.setItem('ff_services_cache', JSON.stringify(items));
            processFirefoxServices(items);
            document.getElementById('firefox-pricing-modal').classList.add('active');
            showToast('Tải danh sách dịch vụ và bảng giá thành công!');
        } else {
            showToast(`Lỗi tải danh sách: ${res}`, 'error');
        }
    } catch (e) {
        showToast('Lỗi tải danh sách dịch vụ (CORS hoặc Network)', 'error');
        console.error(e);
    }
}

window.renderFirefoxPricingTable = function (items) {
    const tbody = document.getElementById('ff-pricing-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    items.forEach(item => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--border-color)';
        tr.innerHTML = `
            <td style="padding: 12px 16px; white-space: nowrap;">${item.Item_ID}</td>
            <td style="padding: 12px 16px;">${escapeHtml(item.Item_Name)}</td>
            <td style="padding: 12px 16px;">${escapeHtml(item.Country_Title || '')} (${item.Country_ID || ''})</td>
            <td style="padding: 12px 16px; color: #2ecc71; font-weight: bold; white-space: nowrap;">${item.Item_UPrice}</td>
            <td style="padding: 12px 16px; white-space: nowrap;">
                <button class="btn btn-primary" onclick="firefoxSelectService('${item.Item_ID}', '${item.Country_ID || ''}')" style="padding: 6px 12px; font-size: 12px; min-height: unset; height: 28px;">Chọn</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

window.firefoxSelectService = function (srvId, countryId) {
    document.getElementById('ff-service-id').value = srvId;
    document.getElementById('ff-country').value = countryId;
    closeModal('firefox-pricing-modal');
    showToast('Đã chọn dịch vụ thành công!');
}

document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('ff-pricing-search');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            const filtered = (window.ffGlobalPricingData || []).filter(item =>
                (item.Item_Name || '').toLowerCase().includes(term) ||
                (item.Country_Title || '').toLowerCase().includes(term) ||
                (item.Item_ID || '').toString().includes(term)
            );
            renderFirefoxPricingTable(filtered);
        });
    }
});

// --------------------------------------------------------
// Dashboard Logic
// --------------------------------------------------------

let otpChartInstance = null;

let currentDashboardRef = null;

window.loadDashboardData = function (tenantTarget) {
    if (!currentUserProfile) return;
    
    let queryPath = '';
    let targetId = '';
    let targetEmail = '';

    if (currentUserProfile.role === 'admin') {
        if (tenantTarget === 'all') {
            queryPath = 'tenants';
        } else if (tenantTarget === 'owner') {
            targetId = currentUserProfile.customerId;
            queryPath = `tenants/${targetId}/history`;
        } else {
            targetId = tenantTarget;
            queryPath = `tenants/${targetId}/history`;
            targetEmail = adminUsersData && Object.values(adminUsersData).find(u => u.customerId === targetId)?.email || targetId;
        }
    } else {
        targetId = currentUserProfile.customerId;
        queryPath = `tenants/${targetId}/history`;
        targetEmail = currentUserProfile.email;
    }

    if (currentDashboardRef) {
        currentDashboardRef.off('value');
    }

    currentDashboardRef = db.ref(queryPath);
    currentDashboardRef.on('value', (snapshot) => {
        try {
            const data = snapshot.val();
            let allHistory = [];

            if (data) {
                if (tenantTarget === 'all' && currentUserProfile.role === 'admin') {
                    Object.keys(data).forEach(tId => {
                        if (data[tId].history) {
                            const custEmail = adminUsersData && Object.values(adminUsersData).find(u => u.customerId === tId)?.email || tId;
                            Object.entries(data[tId].history).forEach(([key, val]) => {
                                allHistory.push({...val, _customerId: tId, _email: custEmail});
                            });
                        }
                    });
                } else {
                    Object.entries(data).forEach(([key, val]) => {
                        allHistory.push({...val, _customerId: targetId, _email: targetEmail});
                    });
                }
            }

            window.currentDashboardHistory = allHistory; // Store globally for chart re-renders
            
            processDashboardMetrics(allHistory, tenantTarget);
            renderDashboardCharts();
            renderDashboardHistory(allHistory, tenantTarget === 'all' && currentUserProfile.role === 'admin');

            // Admin Only Stats
            const adminPanels = document.getElementById('admin-dashboard-panels');
            if (adminPanels) {
                if (tenantTarget === 'all' && currentUserProfile.role === 'admin') {
                    adminPanels.style.display = 'block';
                    renderAdminDashboardStats(data);
                } else {
                    adminPanels.style.display = 'none';
                }
            }
        } catch (error) {
            console.error('Lỗi xử lý dữ liệu Thống kê:', error);
        }
    }, (error) => {
        showToast('Lỗi tải dữ liệu Thống kê: ' + error.message, 'error');
        console.error(error);
    });
}

function parseRevenue(priceStr) {
    if (!priceStr) return 0;
    const matches = priceStr.replace(/,/g, '').match(/\d+/);
    if (!matches) return 0;
    let num = parseInt(matches[0]);
    if (priceStr.toLowerCase().includes('k')) num *= 1000;
    return num;
}

function renderAdminDashboardStats(tenantsData) {
    let totalUsers = 0, activeUsers = 0, lockedUsers = 0, expiredUsers = 0, totalRevenue = 0;
    const todayStr = new Date().toLocaleDateString('vi-VN');
    const userUsages = [];
    
    Object.keys(adminUsersData).forEach(uid => {
        const u = adminUsersData[uid];
        if (u.role === 'admin' || u.deleted) return;
        
        totalUsers++;
        if (u.active !== false) activeUsers++; else lockedUsers++;
        
        totalRevenue += parseRevenue(u.internalNotes?.price || '');
        
        let todayUsed = 0, totalUsed = 0;
        const tenantData = tenantsData ? tenantsData[u.customerId] : null;
        if (tenantData && tenantData.history) {
            const historyVals = Object.values(tenantData.history);
            totalUsed = historyVals.length;
            todayUsed = historyVals.filter(item => {
                const ts = Number(item.timestamp || 0);
                if (ts > 0) return new Date(ts).toLocaleDateString('vi-VN') === todayStr;
                return (item.usedTime || '').includes(todayStr);
            }).length;
        }
        
        userUsages.push({ customerId: u.customerId, email: u.email, today: todayUsed, total: totalUsed });
        
        const limits = u.limits || { dailyLimit: 0, expireAt: 0 };
        const isExpired = limits.expireAt > 0 && limits.expireAt < Date.now();
        if (isExpired) {
            expiredUsers++;
            if (u.active !== false) activeUsers--;
        }
    });
    
    document.getElementById('dash-admin-total-users').textContent = totalUsers;
    document.getElementById('dash-admin-active').textContent = activeUsers;
    document.getElementById('dash-admin-locked').textContent = lockedUsers;
    document.getElementById('dash-admin-expired').textContent = expiredUsers;
    document.getElementById('dash-admin-revenue').textContent = totalRevenue.toLocaleString('vi-VN') + ' ₫';
    
    const topUsersList = document.getElementById('dash-admin-top-users');
    topUsersList.innerHTML = '';
    userUsages.sort((a, b) => b.today - a.today).slice(0, 10).forEach(u => {
        const row = document.createElement('div');
        row.className = 'grid-row';
        row.style.display = 'grid';
        row.style.gridTemplateColumns = '1fr 80px 80px';
        row.innerHTML = `<div>${escapeHtml(u.email)}</div><div style="font-weight: 600; color: var(--success);">${u.today}</div><div style="color: var(--text-muted);">${u.total}</div>`;
        topUsersList.appendChild(row);
    });
}

function processDashboardMetrics(historyData, tenantTarget) {
    let todayOtp = 0, yesterdayOtp = 0, monthOtp = 0, successCount = 0, failCount = 0;
    let lastOtpTime = 0;
    const now = new Date();
    
    const dToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dYesterday = new Date(dToday); dYesterday.setDate(dYesterday.getDate() - 1);
    const dMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    historyData.forEach(item => {
        let ts = Number(item.timestamp || 0);
        if (ts === 0 && item.usedTime) {
            const timeParts = item.usedTime.split(' ');
            if (timeParts.length > 1) ts = now.getTime();
        }
        
        if (ts > 0) {
            if (ts > lastOtpTime) lastOtpTime = ts;
            if (ts >= dToday.getTime()) todayOtp++;
            else if (ts >= dYesterday.getTime() && ts < dToday.getTime()) yesterdayOtp++;
            if (ts >= dMonthStart.getTime()) monthOtp++;
        }
        
        if (!item.errorMsg) successCount++; else failCount++;
    });

    document.getElementById('dash-today-otp').textContent = todayOtp.toLocaleString('vi-VN');
    document.getElementById('dash-yesterday-otp').textContent = yesterdayOtp.toLocaleString('vi-VN');
    document.getElementById('dash-month-otp').textContent = monthOtp.toLocaleString('vi-VN');
    document.getElementById('dash-fail-count').textContent = failCount.toLocaleString('vi-VN');
    
    const totalProcessed = successCount + failCount;
    document.getElementById('dash-success-rate').textContent = totalProcessed > 0 ? Math.round((successCount / totalProcessed) * 100) + '%' : '0%';
    
    if (lastOtpTime > 0) {
        const d = new Date(lastOtpTime);
        document.getElementById('dash-last-otp-time').textContent = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    } else {
        document.getElementById('dash-last-otp-time').textContent = '--:--';
    }

    // Devices & Ports Stats
    let onlineDevices = 0;
    let busyOrErrorPorts = 0;
    
    const serverNow = Date.now() + serverTimeOffset;
    const aliveMachines = new Set();
    Object.keys(lastSyncByMachine).forEach(mId => {
        if (serverNow - lastSyncByMachine[mId] <= 15000) aliveMachines.add(mId);
    });
    onlineDevices = aliveMachines.size;
    
    state.ports.forEach(p => {
        if (!p.isTest && aliveMachines.has(p.machineId)) {
            if (p.errorMsg || p.commandStatus === 'running' || p.commandStatus === 'queued' || p.commandStatus === 'maybe_sent' || p.smsSent) {
                busyOrErrorPorts++;
            }
        }
    });
    
    document.getElementById('dash-online-devices').textContent = onlineDevices;
    document.getElementById('dash-busy-ports').textContent = busyOrErrorPorts;

    // Admin Customer Info Header
    const custInfoBox = document.getElementById('dash-customer-info');
    if (currentUserProfile.role === 'admin' && tenantTarget !== 'all' && tenantTarget !== 'owner') {
        const u = Object.values(adminUsersData || {}).find(x => x.customerId === tenantTarget);
        if (u) {
            custInfoBox.style.display = 'block';
            document.getElementById('dash-cust-email').textContent = u.email;
            document.getElementById('dash-cust-status').innerHTML = u.deleted ? '<span style="color:var(--danger)">Đã xoá</span>' : (u.active ? '<span style="color:var(--success)">Hoạt động</span>' : '<span style="color:var(--warning)">Bị khoá</span>');
            document.getElementById('dash-cust-limit').textContent = `${todayOtp} / ${u.limits?.dailyLimit || 'Không giới hạn'}`;
            document.getElementById('dash-cust-expire').textContent = u.limits?.expireAt ? new Date(u.limits.expireAt).toLocaleDateString('vi-VN') : 'Không hết hạn';
            document.getElementById('dash-cust-price').textContent = u.internalNotes?.price || 'Không có';
        }
    } else {
        custInfoBox.style.display = 'none';
    }

    // Alerts
    renderDashboardAlerts(historyData, onlineDevices, todayOtp, tenantTarget);
}

function renderDashboardAlerts(historyData, onlineDevices, todayOtp, tenantTarget) {
    const container = document.getElementById('dash-alerts-container');
    container.innerHTML = '';
    const alerts = [];
    
    if (onlineDevices === 0 && (tenantTarget === 'all' || tenantTarget === 'owner')) {
        alerts.push({ type: 'danger', icon: 'wifi-off', text: 'Toàn bộ thiết bị đang Offline! Hệ thống không thể xử lý OTP.' });
    }
    
    let recentFails = 0;
    const now = Date.now();
    historyData.slice(-20).forEach(h => {
        if (h.errorMsg && (now - Number(h.timestamp || 0)) < 60*60*1000) recentFails++;
    });
    if (recentFails >= 10) {
        alerts.push({ type: 'warning', icon: 'alert-triangle', text: `Cảnh báo: Có ${recentFails} giao dịch thất bại trong 1 giờ qua. Vui lòng kiểm tra thiết bị/cổng.` });
    }

    if (currentUserProfile.role === 'admin' && tenantTarget !== 'all' && tenantTarget !== 'owner') {
        const u = Object.values(adminUsersData || {}).find(x => x.customerId === tenantTarget);
        if (u) {
            const limits = u.limits || { dailyLimit: 0, expireAt: 0 };
            if (limits.expireAt > 0 && limits.expireAt < now) alerts.push({ type: 'danger', icon: 'clock', text: 'Khách hàng này đã hết hạn sử dụng.' });
            else if (limits.expireAt > 0 && limits.expireAt - now < 3*24*60*60*1000) alerts.push({ type: 'warning', icon: 'clock', text: 'Khách hàng này sắp hết hạn trong vòng 3 ngày tới.' });
            
            if (limits.dailyLimit > 0 && todayOtp >= limits.dailyLimit) alerts.push({ type: 'danger', icon: 'shield-alert', text: 'Khách hàng này đã vượt giới hạn OTP trong ngày.' });
        }
    }

    if (alerts.length > 0) {
        container.style.display = 'flex';
        alerts.forEach(a => {
            container.innerHTML += `<div style="background: ${a.type==='danger'?'rgba(239, 68, 68, 0.15)':'rgba(245, 158, 11, 0.15)'}; border: 1px solid ${a.type==='danger'?'var(--danger)':'var(--warning)'}; border-radius: 8px; padding: 12px; display: flex; align-items: center; gap: 12px;">
                <i data-lucide="${a.icon}" style="color: ${a.type==='danger'?'var(--danger)':'var(--warning)'};"></i>
                <span style="color: white; font-size: 13px;">${escapeHtml(a.text)}</span>
            </div>`;
        });
        if (window.lucide) lucide.createIcons();
    } else {
        container.style.display = 'none';
    }
}

let dashTrendChartInstance = null;
let dashPieChartInstance = null;

window.renderDashboardCharts = function() {
    const historyData = window.currentDashboardHistory || [];
    const range = document.getElementById('chart-time-range').value; // today, 7days, 30days
    
    // Grouping for Trend Chart
    const labels = [];
    const counts = [];
    const now = new Date();
    
    if (range === 'today') {
        // 24 hours
        const hourlyCounts = new Array(24).fill(0);
        historyData.forEach(item => {
            let ts = Number(item.timestamp || 0);
            if (ts > 0 && (now.getTime() - ts) <= 24*60*60*1000) {
                hourlyCounts[new Date(ts).getHours()]++;
            }
        });
        for (let i=0; i<24; i++) { labels.push(i+'h'); counts.push(hourlyCounts[i]); }
    } else {
        // 7 or 30 days
        const days = range === '7days' ? 7 : 30;
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(d.getDate() - i);
            labels.push(d.toLocaleDateString('vi-VN', {day:'2-digit', month:'2-digit'}));
            counts.push(0);
        }
        const startOfRange = new Date(now);
        startOfRange.setDate(startOfRange.getDate() - days + 1);
        startOfRange.setHours(0,0,0,0);
        
        historyData.forEach(item => {
            let ts = Number(item.timestamp || 0);
            if (ts >= startOfRange.getTime()) {
                const diffDays = Math.floor((now.getTime() - ts) / (1000*60*60*24));
                if (diffDays >= 0 && diffDays < days) counts[days - 1 - diffDays]++;
            }
        });
    }

    // Trend Chart
    if (dashTrendChartInstance) dashTrendChartInstance.destroy();
    dashTrendChartInstance = new Chart(document.getElementById('otpTrendChart').getContext('2d'), {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'OTP/Giao dịch',
                data: counts,
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.3,
                pointRadius: 2
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8' } },
                x: { grid: { display: false }, ticks: { color: '#94a3b8' } }
            },
            plugins: { legend: { display: false } }
        }
    });

    // Pie Chart
    let success = 0, fail = 0;
    let cutoff = range === 'today' ? 24*60*60*1000 : (range === '7days' ? 7*24*60*60*1000 : 30*24*60*60*1000);
    historyData.forEach(item => {
        let ts = Number(item.timestamp || 0);
        if (ts > 0 && (now.getTime() - ts) <= cutoff) {
            if (item.errorMsg) fail++; else success++;
        }
    });
    
    if (dashPieChartInstance) dashPieChartInstance.destroy();
    dashPieChartInstance = new Chart(document.getElementById('otpPieChart').getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: ['Thành công', 'Lỗi/Timeout'],
            datasets: [{
                data: [success, fail],
                backgroundColor: ['#10b981', '#ef4444'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            cutout: '70%',
            plugins: {
                legend: { position: 'bottom', labels: { color: '#fff', usePointStyle: true, padding: 20 } }
            }
        }
    });
}

function renderDashboardHistory(historyData, isAdminAll) {
    const list = document.getElementById('dash-history-list');
    const header = document.getElementById('dash-history-header');
    
    if (isAdminAll) {
        header.style.gridTemplateColumns = '140px 180px 120px 100px 120px 140px 1fr';
        header.innerHTML = `<div>Thời gian</div><div>Khách hàng</div><div>Số điện thoại</div><div>OTP</div><div>Nguồn</div><div>Thiết bị</div><div>Ghi chú</div>`;
    } else {
        header.style.gridTemplateColumns = '140px 140px 100px 140px 140px 1fr';
        header.innerHTML = `<div>Thời gian</div><div>Số điện thoại</div><div>OTP</div><div>Nguồn</div><div>Thiết bị / Port</div><div>Trạng thái</div>`;
    }

    list.innerHTML = '';
    const sorted = [...historyData].sort((a,b) => (Number(b.timestamp||0) - Number(a.timestamp||0)));
    const limit = window.isDashboardHistoryExpanded ? sorted.length : 50;
    const displayData = sorted.slice(0, limit);
    
    const titleEl = document.getElementById('dash-history-title');
    const toggleBtn = document.getElementById('btn-toggle-dash-history');
    if (titleEl) {
        titleEl.textContent = window.isDashboardHistoryExpanded ? `Toàn bộ Giao dịch (${sorted.length} GD)` : `Giao dịch gần nhất (50 GD)`;
    }
    if (toggleBtn) {
        toggleBtn.innerHTML = window.isDashboardHistoryExpanded 
            ? `<i data-lucide="minimize-2" style="width: 14px; height: 14px;"></i> Thu gọn`
            : `<i data-lucide="list" style="width: 14px; height: 14px;"></i> Xem tất cả`;
        if (window.lucide) lucide.createIcons();
    }
    
    if (displayData.length === 0) {
        list.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-muted);">Chưa có lịch sử giao dịch</div>';
        return;
    }

    displayData.forEach((item, index) => {
        let tsStr = item.usedTime || '';
        let createTsStr = 'Không xác định';
        
        if (item.timestamp) {
            const d = new Date(Number(item.timestamp));
            tsStr = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')} ${d.toLocaleDateString('vi-VN')}`;
            if (item.createdAt) {
                const dc = new Date(Number(item.createdAt));
                createTsStr = `${dc.getHours().toString().padStart(2,'0')}:${dc.getMinutes().toString().padStart(2,'0')}:${dc.getSeconds().toString().padStart(2,'0')} ${dc.toLocaleDateString('vi-VN')}`;
            } else {
                createTsStr = tsStr; // If no created timestamp, fallback to received timestamp
            }
        }
        
        let statusHtml = item.errorMsg ? `<span style="color:var(--danger);font-size:11px;">Lỗi: ${escapeHtml(item.errorMsg)}</span>` : `<span style="color:var(--success);font-weight:600;">${escapeHtml(item.otp || '')}</span>`;
        
        // Color badges for sources
        const sourceLower = (item.source || '').toLowerCase();
        let srcBg = 'rgba(255,255,255,0.1)';
        let srcColor = 'white';
        if (sourceLower.includes('firefox')) { srcBg = 'rgba(245, 158, 11, 0.15)'; srcColor = 'var(--warning)'; }
        else if (sourceLower.includes('gsm')) { srcBg = 'rgba(59, 130, 246, 0.15)'; srcColor = 'var(--primary-color)'; }
        else if (sourceLower.includes('manual')) { srcBg = 'rgba(139, 92, 246, 0.15)'; srcColor = '#8b5cf6'; }
        
        let srcHtml = `<span style="background: ${srcBg}; color: ${srcColor}; padding: 2px 6px; border-radius: 4px; font-size: 11px;">${escapeHtml(item.source || 'UNK')}</span>`;
        
        const row = document.createElement('div');
        row.className = 'grid-row';
        row.style.display = 'grid';
        row.style.gridTemplateColumns = header.style.gridTemplateColumns;
        row.style.fontSize = '12px';
        row.style.cursor = 'pointer';
        
        // Add click event to show details
        row.onclick = () => showTransactionDetails(item, tsStr, createTsStr, srcBg, srcColor);
        
        if (isAdminAll) {
            row.innerHTML = `
                <div style="color:var(--text-muted);">${tsStr}</div>
                <div style="color:#3b82f6; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(item._email || '')}</div>
                <div>${escapeHtml(item.phone || '')}</div>
                <div>${statusHtml}</div>
                <div>${srcHtml}</div>
                <div style="color:var(--text-muted); font-family:monospace;">${escapeHtml(item.id || '')}</div>
                <div style="color:var(--warning); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${item.errorMsg ? escapeHtml(item.errorMsg) : ''}</div>
            `;
        } else {
            row.innerHTML = `
                <div style="color:var(--text-muted);">${tsStr}</div>
                <div>${escapeHtml(item.phone || '')}</div>
                <div>${statusHtml}</div>
                <div>${srcHtml}</div>
                <div style="color:var(--text-muted); font-family:monospace;">${escapeHtml(item.id || '')}</div>
                <div style="color:var(--warning);">${item.errorMsg ? escapeHtml(item.errorMsg) : 'Thành công'}</div>
            `;
        }
        list.appendChild(row);
    });
}

function showTransactionDetails(item, receivedTimeStr, createdTimeStr, srcBg, srcColor) {
    document.getElementById('td-otp').textContent = item.otp || 'N/A';
    document.getElementById('td-email').textContent = item._email || item._customerId || 'N/A';
    document.getElementById('td-phone').textContent = item.phone || 'N/A';
    
    const srcSpan = document.getElementById('td-source');
    srcSpan.textContent = item.source || 'UNK';
    srcSpan.style.background = srcBg;
    srcSpan.style.color = srcColor;
    
    document.getElementById('td-device').textContent = item.id || item.machineId || 'N/A';
    document.getElementById('td-time-created').textContent = createdTimeStr;
    document.getElementById('td-time-received').textContent = receivedTimeStr;
    document.getElementById('td-error').textContent = item.errorMsg || 'Không có lỗi';
    
    document.getElementById('transaction-details-modal').classList.add('active');
}

window.fastCopy = function(elementId) {
    const text = document.getElementById(elementId).textContent;
    if (text && text !== '---' && text !== 'N/A') {
        navigator.clipboard.writeText(text).then(() => {
            showToast('Đã copy: ' + text, 'success');
        }).catch(err => {
            showToast('Lỗi khi copy', 'error');
        });
    }
}

window.showDashStatDetails = function(type) {
    const list = document.getElementById('dash-stat-modal-list');
    const header = document.getElementById('dash-stat-modal-header');
    const title = document.getElementById('dash-stat-modal-title');
    
    list.innerHTML = '';
    
    if (type === 'today' || type === 'yesterday' || type === 'month') {
        if (!window.currentDashboardHistory) return;
        
        const now = new Date();
        const dToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const dYesterday = new Date(dToday.getTime() - 86400000);
        const dMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        
        const sorted = [...window.currentDashboardHistory].sort((a,b) => (Number(b.timestamp||0) - Number(a.timestamp||0)));
        const displayData = sorted.filter(item => {
            const ts = Number(item.timestamp || 0);
            if (ts <= 0) return false;
            if (type === 'today') return ts >= dToday.getTime();
            if (type === 'yesterday') return ts >= dYesterday.getTime() && ts < dToday.getTime();
            if (type === 'month') return ts >= dMonthStart.getTime();
        });
        
        const titleStr = type === 'today' ? 'OTP Hôm Nay' : (type === 'yesterday' ? 'OTP Hôm Qua' : 'OTP Tháng Này');
        title.textContent = `${titleStr} (${displayData.length})`;
        
        header.style.gridTemplateColumns = '140px 120px 100px 140px 140px 1fr';
        header.innerHTML = `<div>Thời gian</div><div>Số điện thoại</div><div>OTP</div><div>Nguồn</div><div>Thiết bị / Port</div><div>Trạng thái</div>`;
        
        if (displayData.length === 0) {
            list.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-muted);">Không có dữ liệu</div>';
        } else {
            displayData.forEach(item => {
                let tsStr = item.usedTime || '';
                let createTsStr = 'Không xác định';
                if (item.timestamp) {
                    const d = new Date(Number(item.timestamp));
                    tsStr = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')} ${d.toLocaleDateString('vi-VN')}`;
                    if (item.createdAt) {
                        const dc = new Date(Number(item.createdAt));
                        createTsStr = `${dc.getHours().toString().padStart(2,'0')}:${dc.getMinutes().toString().padStart(2,'0')}:${dc.getSeconds().toString().padStart(2,'0')} ${dc.toLocaleDateString('vi-VN')}`;
                    } else {
                        createTsStr = tsStr;
                    }
                }
                
                let statusHtml = item.errorMsg ? `<span style="color:var(--danger);font-size:11px;">Lỗi: ${escapeHtml(item.errorMsg)}</span>` : `<span style="color:var(--success);font-weight:600;">${escapeHtml(item.otp || '')}</span>`;
                
                const sourceLower = (item.source || '').toLowerCase();
                let srcBg = 'rgba(255,255,255,0.1)';
                let srcColor = 'white';
                if (sourceLower.includes('firefox')) { srcBg = 'rgba(245, 158, 11, 0.15)'; srcColor = 'var(--warning)'; }
                else if (sourceLower.includes('gsm')) { srcBg = 'rgba(59, 130, 246, 0.15)'; srcColor = 'var(--primary-color)'; }
                else if (sourceLower.includes('manual')) { srcBg = 'rgba(139, 92, 246, 0.15)'; srcColor = '#8b5cf6'; }
                let srcHtml = `<span style="background: ${srcBg}; color: ${srcColor}; padding: 2px 6px; border-radius: 4px; font-size: 11px;">${escapeHtml(item.source || 'UNK')}</span>`;
                
                const row = document.createElement('div');
                row.className = 'grid-row';
                row.style.display = 'grid';
                row.style.gridTemplateColumns = header.style.gridTemplateColumns;
                row.style.fontSize = '12px';
                row.style.cursor = 'pointer';
                row.onclick = () => showTransactionDetails(item, tsStr, createTsStr, srcBg, srcColor);
                
                row.innerHTML = `
                    <div style="color:var(--text-muted);">${tsStr}</div>
                    <div>${escapeHtml(item.phone || '')}</div>
                    <div>${statusHtml}</div>
                    <div>${srcHtml}</div>
                    <div style="color:var(--text-muted); font-family:monospace;">${escapeHtml(item.id || '')}</div>
                    <div style="color:var(--warning);">${item.errorMsg ? escapeHtml(item.errorMsg) : 'Thành công'}</div>
                `;
                list.appendChild(row);
            });
        }
    } else if (type === 'devices') {
        const serverNow = Date.now() + serverTimeOffset;
        const aliveMachines = [];
        Object.keys(lastSyncByMachine).forEach(mId => {
            if (serverNow - lastSyncByMachine[mId] <= 15000) aliveMachines.push(mId);
        });
        
        title.textContent = `Thiết bị đang Online (${aliveMachines.length})`;
        header.style.gridTemplateColumns = '200px 1fr';
        header.innerHTML = `<div>Mã Thiết bị (Machine ID)</div><div>Trạng thái</div>`;
        
        if (aliveMachines.length === 0) {
            list.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-muted);">Không có thiết bị online</div>';
        } else {
            aliveMachines.forEach(mId => {
                const row = document.createElement('div');
                row.className = 'grid-row';
                row.style.display = 'grid';
                row.style.gridTemplateColumns = header.style.gridTemplateColumns;
                row.style.fontSize = '13px';
                
                row.innerHTML = `
                    <div style="font-weight: 600; color: var(--primary-color);">${escapeHtml(mId)}</div>
                    <div><span style="color:var(--success); font-weight:600;"><i data-lucide="check-circle" style="width:14px;height:14px;vertical-align:middle;margin-right:4px;"></i> Đang kết nối</span></div>
                `;
                list.appendChild(row);
            });
            if (window.lucide) lucide.createIcons();
        }
    }
    
    document.getElementById('dash-stat-details-modal').classList.add('active');
}

window.isDashboardHistoryExpanded = false;
window.toggleDashboardHistoryLimit = function() {
    window.isDashboardHistoryExpanded = !window.isDashboardHistoryExpanded;
    const historyData = window.currentDashboardHistory || [];
    const isAdminAll = (document.getElementById('dashboard-tenant-select')?.value === 'all') && (currentUserProfile?.role === 'admin');
    renderDashboardHistory(historyData, isAdminAll);
}

window.showExportOptionsModal = function() {
    document.getElementById('export-options-modal').classList.add('active');
}

window.exportDashboardHistoryToExcel = function() {
    if (!window.currentDashboardHistory || window.currentDashboardHistory.length === 0) {
        showToast('Không có dữ liệu để xuất!', 'warning');
        closeModal('export-options-modal');
        return;
    }
    
    const range = document.getElementById('export-time-range')?.value || 'all';
    let filteredData = [...window.currentDashboardHistory];
    const now = Date.now();
    
    if (range === '24h') {
        filteredData = filteredData.filter(item => (now - Number(item.timestamp||0)) <= 24 * 60 * 60 * 1000);
    } else if (range === '7d') {
        filteredData = filteredData.filter(item => (now - Number(item.timestamp||0)) <= 7 * 24 * 60 * 60 * 1000);
    } else if (range === '30d') {
        filteredData = filteredData.filter(item => (now - Number(item.timestamp||0)) <= 30 * 24 * 60 * 60 * 1000);
    }
    
    if (filteredData.length === 0) {
        showToast('Không có giao dịch nào trong khoảng thời gian này!', 'warning');
        closeModal('export-options-modal');
        return;
    }
    
    try {
        const sorted = filteredData.sort((a,b) => (Number(b.timestamp||0) - Number(a.timestamp||0)));
        const data = sorted.map(item => {
            let tsStr = item.usedTime || '';
            let createTsStr = 'Không xác định';
            
            if (item.timestamp) {
                const d = new Date(Number(item.timestamp));
                tsStr = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')} ${d.toLocaleDateString('vi-VN')}`;
                if (item.createdAt) {
                    const dc = new Date(Number(item.createdAt));
                    createTsStr = `${dc.getHours().toString().padStart(2,'0')}:${dc.getMinutes().toString().padStart(2,'0')}:${dc.getSeconds().toString().padStart(2,'0')} ${dc.toLocaleDateString('vi-VN')}`;
                } else {
                    createTsStr = tsStr;
                }
            }
            
            return {
                "Khách hàng": item._email || item._customerId || '',
                "SĐT": item.phone || '',
                "Mã OTP": item.otp || '',
                "Nguồn": item.source || '',
                "Trạng thái": item.errorMsg ? 'Lỗi' : 'Thành công',
                "Thiết bị/Port": item.id || item.machineId || '',
                "Thời gian tạo lệnh": createTsStr,
                "Thời gian nhận OTP": tsStr,
                "Chi tiết Lỗi": item.errorMsg || ''
            };
        });

        const ws = XLSX.utils.json_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Lich_su_OTP");
        XLSX.writeFile(wb, `Lich_su_OTP_${range}_${new Date().toLocaleDateString('vi-VN').replace(/\//g,'-')}.xlsx`);
        showToast(`Đã xuất Excel ${data.length} dòng thành công!`, 'success');
        closeModal('export-options-modal');
    } catch (e) {
        console.error(e);
        showToast('Lỗi khi xuất Excel: ' + e.message, 'error');
    }
}

