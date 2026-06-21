// State
const state = {
    ports: [],
    history: [],
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

const SMS_WAIT_TIMEOUT_MS = 120000;
const BALANCE_WAIT_TIMEOUT_MS = 45000;
const COMMAND_STALE_TIMEOUT_MS = 10 * 60 * 1000;
const BALANCE_COMMAND_SPACING_MS = 1200;
const COMMAND_IN_FLIGHT_STATUSES = new Set(['queued', 'running']);
const COMMAND_SUCCESS_STATUSES = new Set(['sent', 'done', 'success']);
const COMMAND_FAILED_STATUSES = new Set(['failed', 'timeout', 'error']);
const CLIENT_SESSION_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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
    if (port.otp) return 'otp';
    if (port.smsSent) return 'waiting';
    return port.status === 'online' ? 'online' : 'offline';
}

function getPortUiStatusLabel(status) {
    return {
        online: 'Online',
        offline: 'Offline',
        waiting: 'Chờ OTP',
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
                    <button class="btn btn-outline" onclick="cancelSmsWait('${port.id}', '${port.machineId}')">Hủy</button>
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
    if (normalized.includes('qua thoi gian cho otp') || normalized.includes('timeout')) {
        return 'Quá thời gian chờ OTP';
    }
    return raw;
}

function getCommandStatusText(status, type = 'sms') {
    if (status === 'queued') return 'Đang xếp hàng';
    if (status === 'running') return type === 'balance' ? 'Đang kiểm tra số dư' : 'Đang gửi SMS';
    if (status === 'sent') return 'Đã gửi SMS';
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
    if (!isCurrentSmsWaitTimeout && !isBatchCommand && current.commandStatus && !COMMAND_IN_FLIGHT_STATUSES.has(current.commandStatus)) return false;
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
    } catch (e) {}
}

// Firebase configuration
const firebaseConfig = {
    databaseURL: "https://toolweb-c7702-default-rtdb.firebaseio.com/"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// Lấy độ lệch thời gian giữa Client và Firebase Server
db.ref('.info/serverTimeOffset').on('value', function(snapshot) {
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
        let errorMsg = isOwnWebCommand && webState.errorMsg ? normalizeSmsError(webState.errorMsg) : null;
        const smsSentTime = webState.smsSentTime || port.smsSentTime || null;
        const activeCommandId = webState.commandId || port.commandId || null;

        if (isOwnWebCommand && isSmsSent && smsSentTime && !port.otp && !errorMsg) {
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
                `<span style="color: #f39c12">Đang chờ mã... <span class="wait-timer" data-port="${port.id}" data-machine="${port.machineId}"></span></span>` : 
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
                    <button class="btn btn-outline" onclick="cancelSmsWait('${port.id}', '${port.machineId}')" title="Huỷ trạng thái" style="padding: 0 8px;">
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
        if (net.includes('VIETTEL'))  badgeColor = '#e74c3c';
        else if (net.includes('VINA') || net.includes('VINAPHONE')) badgeColor = '#2980b9';
        else if (net.includes('MOBI'))     badgeColor = '#27ae60';
        else if (net.includes('SKY'))      badgeColor = '#00a8ff';
        else if (net.includes('LOCAL'))    badgeColor = '#e1b12c';
        else if (net.includes('WINTEL'))   badgeColor = '#e84393';
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

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
    state.currentActionPortId = null;
}

// Execute actions
async function executeSendSms() {
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
        showToast('Cổng này đang chờ OTP, hãy huỷ trạng thái trước khi gửi lại.', 'error');
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

window.checkBalance = async function(portId, machineId) {
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

window.cancelSmsWait = function(portId, machineId) {
    const stateKey = `${machineId}_${portId}`;
    const webState = globalWebStates[stateKey] || {};
    const idsToCancel = Array.isArray(webState.commandIds)
        ? webState.commandIds
        : (webState.commandId ? [webState.commandId] : []);
    if (idsToCancel.length && COMMAND_IN_FLIGHT_STATUSES.has(webState.commandStatus)) {
        idsToCancel.forEach(id => db.ref(`commands/${id}`).remove());
    }
    
    const port = state.ports.find(p => p.id === portId && p.machineId === machineId);
    if (port && port.otp) {
        db.ref(`web_states/machines/${machineId}/ports/${portId}`).update({ clearedOtp: port.otp, smsSent: null, commandId: null, commandIds: null, commandStatus: null, errorMsg: null });
    } else {
        db.ref(`web_states/machines/${machineId}/ports/${portId}`).remove();
    }
    db.ref(`machines/${machineId}/ports/${portId}/otp`).remove();
    
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
    
    showToast(`Đã huỷ trạng thái cho cổng ${portId} (${machineId})`);
}

window.cancelAllSmsWait = function() {
    const visiblePorts = state.ports.filter(p => !p.hidden && !p.isTest && p.status === 'online');
    if (visiblePorts.length === 0) {
        showToast('Không có cổng nào đang hoạt động!', 'error');
        return;
    }

    showToast(`Đang huỷ trạng thái chờ cho ${visiblePorts.length} cổng...`);
    visiblePorts.forEach(port => {
        const webState = globalWebStates[`${port.machineId}_${port.id}`] || {};
        const idsToCancel = Array.isArray(webState.commandIds)
            ? webState.commandIds
            : (webState.commandId ? [webState.commandId] : []);
        if (idsToCancel.length && COMMAND_IN_FLIGHT_STATUSES.has(webState.commandStatus)) {
            idsToCancel.forEach(id => db.ref(`commands/${id}`).remove());
        }
        if (port.otp) {
            db.ref(`web_states/machines/${port.machineId}/ports/${port.id}`).update({ clearedOtp: port.otp, smsSent: null, commandId: null, commandIds: null, commandStatus: null, errorMsg: null });
        } else {
            db.ref(`web_states/machines/${port.machineId}/ports/${port.id}`).remove();
        }
        db.ref(`machines/${port.machineId}/ports/${port.id}/otp`).remove();
        if (port.otp) port.otp = null;
        port.smsSent = false;
        port.commandId = null;
        port.commandIds = null;
        port.commandStatus = null;
        port.errorMsg = null;
    });
    renderPorts();
    showToast(`Đã huỷ trạng thái cho ${visiblePorts.length} cổng`);
}

window.restoreAllHiddenPorts = function() {
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

window.checkAllBalance = async function() {
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

window.refreshAllPorts = function() {
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
        if(row) {
            row.classList.add('row-exit');
            
            const phoneKey = toFirebaseKey((port.phone || 'NO_PHONE').replace(/\s+/g, ''));
            const otpKey = toFirebaseKey(port.otp || 'NO_OTP');
            const historyKey = `${toFirebaseKey(machineId)}_${toFirebaseKey(portId)}_${phoneKey}_${otpKey}`;
            const historyRef = db.ref(`history/${historyKey}`);

            try {
                const result = await historyRef.transaction(current => {
                    if (current) return current;
                    return {
                        ...port,
                        machineId: machineId,
                        id: portId,
                        usedTime: new Date().toLocaleTimeString('vi-VN'),
                        timestamp: firebase.database.ServerValue.TIMESTAMP
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
        db.ref(`history/${fbKey}`).remove();
    } else {
        // Fallback cho dữ liệu cũ từ localStorage chưa có fbKey
        const indexToRemove = state.history.findIndex(h => h.id === portId && h.usedTime === usedTime);
        if (indexToRemove > -1) {
            state.history.splice(indexToRemove, 1);
            localStorage.setItem('gsm_history', JSON.stringify(state.history));
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

// Navigation
document.getElementById('logo-home').addEventListener('click', () => {
    document.getElementById('nav-active').click();
});

document.getElementById('nav-active').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('nav-active').classList.add('active');
    document.getElementById('nav-history').classList.remove('active');
    
    document.getElementById('active-view').style.display = 'flex';
    document.getElementById('history-view').style.display = 'none';
    document.getElementById('page-title').textContent = 'Quản lý Cổng SIM';
    renderPorts();
});

document.getElementById('nav-history').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('nav-history').classList.add('active');
    document.getElementById('nav-active').classList.remove('active');
    
    document.getElementById('active-view').style.display = 'none';
    document.getElementById('history-view').style.display = 'flex';
    document.getElementById('page-title').textContent = 'Lịch sử OTP';
    renderHistory();
});

// Init
window.onload = () => {
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

    // Load history từ Firebase (lấy 200 bản ghi gần nhất để tránh lag)
    db.ref('history').orderByChild('timestamp').limitToLast(200).on('value', (snapshot) => {
        const data = snapshot.val();
        if (data) {
            state.history = Object.entries(data).map(([key, value]) => ({
                ...value,
                phone: value?.phone ? normalizePhoneNumber(value.phone) : value?.phone,
                fbKey: key
            }));
        } else {
            state.history = [];
        }
        if (document.getElementById('history-view').style.display === 'flex') {
            renderHistory();
        }
        
        // Gọi lại applyWebStates để lập tức ẩn các số vừa vào lịch sử
        applyWebStates();
    });

    db.ref('command_results').orderByChild('updatedAt').limitToLast(200).on('value', async (snapshot) => {
        const results = snapshot.val() || {};
        const visibleResults = { ...commandResults };

        for (const [commandId, result] of Object.entries(results)) {
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
window.onclick = function(event) {
    if (event.target.classList.contains('modal-overlay')) {
        closeModal(event.target.id);
    }
}
