// State
const state = {
    ports: [],
    history: [],
    currentActionPortId: null
};

let lastSyncTime = 0;
let globalWebStates = {};
let pendingBalanceChecks = new Set();
let autoHistoryTimeouts = {};

function scheduleAutoHistory(portId) {
    if (autoHistoryTimeouts[portId]) {
        clearTimeout(autoHistoryTimeouts[portId]);
    }
    autoHistoryTimeouts[portId] = setTimeout(() => {
        const port = state.ports.find(p => p.id === portId);
        if (port && port.otp && !port.hidden) {
            markAsUsed(portId);
        }
    }, 10000);
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

// Fetch real data from Firebase
function fetchPorts() {
    db.ref('ports').on('value', (snapshot) => {
        const data = snapshot.val();
        if (data) {
            // Convert to array and filter out nulls/undefined if any
            const portsArray = Object.values(data).filter(p => p);
            
            portsArray.forEach(newPort => {
                if (newPort.otp) {
                    const existingPort = state.ports.find(p => p.id === newPort.id);
                    if (!existingPort || existingPort.otp !== newPort.otp) {
                        scheduleAutoHistory(newPort.id);
                    }
                }
            });
            
            // Retain locally created test ports
            const testPorts = state.ports.filter(p => p.isTest);
            state.ports = [...portsArray, ...testPorts];
            
            applyWebStates();
        } else {
            // Không có dữ liệu
            state.ports = state.ports.filter(p => p.isTest);
            renderPorts();
        }
    }, (error) => {
        console.error('Lỗi khi tải dữ liệu từ Firebase:', error);
    });

    // Lắng nghe trạng thái dùng chung (ẩn cổng, đã gửi sms)
    db.ref('web_states/ports').on('value', (snapshot) => {
        globalWebStates = snapshot.val() || {};
        applyWebStates();
    });
}

function applyWebStates() {
    if (state.ports.length === 0) return;

    state.ports.forEach(port => {
        if (port.isTest) return; // Bỏ qua cổng test

        const webState = globalWebStates[port.id] || {};
        
        let shouldHide = false;
        let isSmsSent = webState.smsSent || false;

        if (webState.hiddenOtp) {
            // Đã bị ẩn bởi một người dùng nào đó
            // Ktra xem C# có cập nhật SĐT mới không (thay SIM)?
            if (port.phone && webState.phone && port.phone !== webState.phone && port.phone !== 'N/A' && port.phone !== 'Unknown') {
                db.ref(`web_states/ports/${port.id}`).remove();
                shouldHide = false;
                isSmsSent = false;
            } 
            // Ktra xem C# có cập nhật OTP mới không?
            else if (port.otp && port.otp !== webState.hiddenOtp) {
                db.ref(`web_states/ports/${port.id}`).remove();
                shouldHide = false;
                isSmsSent = false;
            } else {
                shouldHide = true;
            }
        }

        port.hidden = shouldHide;
        port.smsSent = isSmsSent;
    });

    renderPorts();
}

// Render Ports
function renderPorts() {
    const container = document.getElementById('ports-container');
    container.innerHTML = '';

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
    const portsToRender = myAssignedPorts.filter(p => !p.hidden);

    if (portsToRender.length === 0) {
        container.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--text-muted);">Không có cổng nào (hoặc đã dùng hết) trong phần này.</div>`;
        return;
    }

    portsToRender.forEach(port => {
        const row = document.createElement('div');
        row.className = 'grid-row';
        if (port.smsSent) {
            row.classList.add('row-highlight-red');
        }
        row.id = `row-${port.id}`;

        const statusDot = port.status === 'online' ? 
            '<div class="status-indicator online"></div>' : 
            '<div class="status-indicator" style="background: red;"></div>';

        let otpContent = port.smsSent ? 
            '<span style="color: #f39c12">Đang chờ mã...</span>' : 
            '<span style="color: var(--text-muted)">Chưa gửi tin nhắn</span>';
        const isChecking = pendingBalanceChecks.has(port.id);
        let actionButtons = `
            <button class="btn btn-primary" onclick="openSmsModal('${port.id}')" title="Gửi SMS Lấy OTP">
                <i data-lucide="send"></i> Gửi SMS
            </button>
            <button class="btn btn-outline${isChecking ? ' btn-loading' : ''}" id="btn-balance-${port.id}" onclick="checkBalance('${port.id}')" title="Kiểm tra số dư" ${isChecking ? 'disabled' : ''}>
                ${isChecking ? '<span class="spinner"></span> Đang kiểm tra...' : '<i data-lucide="dollar-sign"></i> Kiểm tra số dư'}
            </button>
        `;

        if (port.otp) {
            otpContent = `<span class="otp-badge">${port.otp}</span>`;
            actionButtons = `
                <button class="btn btn-success" onclick="markAsUsed('${port.id}')">
                    <i data-lucide="check-circle"></i> Đã dùng
                </button>
            `;
        }

        row.innerHTML = `
            <div class="col-status">${statusDot}</div>
            <div class="col-port">${port.id}</div>
            <div class="col-phone">${port.phone ? port.phone.replace(/(\d{4})(\d{3})(\d{3})/, '$1 $2 $3') : '<span style="color:gray; font-style:italic">Trống</span>'}</div>
            <div class="col-tkc">${port.balance || 'N/A'}</div>
            <div class="col-otp">${otpContent}</div>
            <div class="col-actions">
                ${actionButtons}
            </div>
        `;

        container.appendChild(row);
    });

    lucide.createIcons();
    if (typeof checkConnectionStatus === 'function') {
        checkConnectionStatus();
    }
}

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

    state.history.sort((a, b) => new Date(b.usedTime) - new Date(a.usedTime)).forEach(item => {
        const row = document.createElement('div');
        row.className = 'grid-row';

        row.innerHTML = `
            <div class="col-port">${item.id}</div>
            <div class="col-phone">${item.phone ? item.phone.replace(/(\d{4})(\d{3})(\d{3})/, '$1 $2 $3') : '<span style="color:gray; font-style:italic">Trống</span>'}</div>
            <div class="col-otp"><span style="color: var(--success); font-weight: bold;">${item.otp}</span></div>
            <div class="col-time">${item.usedTime}</div>
            <div class="col-actions">
                <button class="btn btn-primary" onclick="restoreFromHistory('${item.id}', '${item.usedTime}')" title="Khôi phục trạng thái hoạt động">
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
        const phone = item.phone || '';
        const otp = item.otp || '';
        const time = item.usedTime || '';
        
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

// Modal Logic
function openSmsModal(portId) {
    state.currentActionPortId = portId;
    const port = state.ports.find(p => p.id === portId);
    
    document.getElementById('sms-port-name').textContent = port.id;
    document.getElementById('sms-phone-number').textContent = port.phone;
    
    document.getElementById('sms-recipient-select').value = '8500';
    document.getElementById('sms-recipient-custom').value = '';
    document.getElementById('sms-recipient-custom').style.display = 'none';
    
    document.getElementById('sms-content').value = 'ZALO'; // Default content
    
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
    if (!actionPortId) return;

    let recipient = document.getElementById('sms-recipient-select').value;
    if (recipient === 'custom') {
        recipient = document.getElementById('sms-recipient-custom').value;
    }
    
    if (!recipient) {
        showToast('Vui lòng nhập đầu số nhận!', 'error');
        return;
    }
    
    const content = document.getElementById('sms-content').value;

    // Xử lý cổng mô phỏng (Test)
    if (actionPortId.startsWith('COM_TEST')) {
        const port = state.ports.find(p => p.id === actionPortId);
        if (port) port.smsSent = true;
        renderPorts();
        showToast(`[TEST] Đã gửi lệnh SMS từ ${actionPortId} đến ${recipient}`);
        closeModal('sms-modal');
        
        // Mô phỏng mã OTP về sau 3 giây
        simulateOtpArrival(actionPortId, content.toUpperCase().includes('ZALO'));
        return;
    }
    
    try {
        const recipients = recipient.split(',').map(r => r.trim()).filter(r => r);
        
        for (const rec of recipients) {
            // Đẩy lệnh lên Firebase để phần mềm C# nhận
            const commandRef = db.ref('commands').push();
            await commandRef.set({
                portId: actionPortId,
                recipient: rec,
                content: content,
                timestamp: firebase.database.ServerValue.TIMESTAMP
            });
        }
        
        const port = state.ports.find(p => p.id === actionPortId);
        if (port && !port.isTest) {
            db.ref(`web_states/ports/${actionPortId}`).update({
                smsSent: true
            });
        } else if (port) {
            port.smsSent = true;
            renderPorts();
        }
        
        if (recipients.length > 1) {
            showToast(`Đã gửi ${recipients.length} lệnh SMS từ ${actionPortId}`);
        } else {
            showToast(`Đã gửi lệnh SMS từ ${actionPortId} đến ${recipients[0]}`);
        }
    } catch (error) {
        showToast('Không thể đẩy lệnh lên Firebase!', 'error');
    }
    
    closeModal('sms-modal');
}

window.checkBalance = async function(portId) {
    if (portId.startsWith('COM_TEST')) {
        showToast(`[TEST] Đã gửi lệnh kiểm tra số dư cho cổng ${portId}`);
        return;
    }

    if (pendingBalanceChecks.has(portId)) return; // Đang kiểm tra rồi

    try {
        pendingBalanceChecks.add(portId);
        renderPorts();

        const commandRef = db.ref('commands').push();
        await commandRef.set({
            portId: portId,
            recipient: 'USSD',
            content: 'BALANCE',
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
        showToast(`Đã gửi lệnh kiểm tra số dư cho cổng ${portId}`);

        // Tự tắt spinner sau 15s nếu không nhận được kết quả
        setTimeout(() => {
            if (pendingBalanceChecks.has(portId)) {
                pendingBalanceChecks.delete(portId);
                renderPorts();
            }
        }, 15000);
    } catch (error) {
        pendingBalanceChecks.delete(portId);
        renderPorts();
        showToast('Không thể đẩy lệnh lên Firebase!', 'error');
    }
}

window.checkAllBalance = async function() {
    const visiblePorts = state.ports.filter(p => !p.hidden && !p.isTest && p.status === 'online');
    if (visiblePorts.length === 0) {
        showToast('Không có cổng nào đang hoạt động!', 'error');
        return;
    }

    showToast(`Đang gửi lệnh kiểm tra TKC cho ${visiblePorts.length} cổng...`);
    for (const port of visiblePorts) {
        await checkBalance(port.id);
    }
}

// Mark as Used
function markAsUsed(portId) {
    if (autoHistoryTimeouts[portId]) {
        clearTimeout(autoHistoryTimeouts[portId]);
        delete autoHistoryTimeouts[portId];
    }
    const portIndex = state.ports.findIndex(p => p.id === portId);
    if (portIndex > -1) {
        const port = state.ports[portIndex];
        
        // Add exit animation class
        const row = document.getElementById(`row-${portId}`);
        if(row) {
            row.classList.add('row-exit');
            
            // Add to history (vẫn lưu ở trình duyệt cá nhân để tuỳ chỉnh báo cáo)
            state.history.push({
                ...port,
                usedTime: new Date().toLocaleTimeString('vi-VN')
            });

            // Save to localStorage
            localStorage.setItem('gsm_history', JSON.stringify(state.history));
            
            // Đồng bộ trạng thái ẨN cho mọi người
            db.ref(`web_states/ports/${portId}`).update({
                hiddenOtp: port.otp || 'NONE',
                phone: port.phone || 'NONE'
            });

            setTimeout(() => {
                showToast(`Đã lưu SĐT ${port.phone} vào lịch sử.`);
            }, 400); // wait for animation
        }
    }
}

// Restore from History
function restoreFromHistory(portId, usedTime) {
    // Xoá trạng thái ẩn trên Firebase cho tất cả mọi người
    db.ref(`web_states/ports/${portId}`).remove();
    
    // Cập nhật state local
    const port = state.ports.find(p => p.id === portId);
    if (port) {
        port.hidden = false;
        port.smsSent = false;
    }
    
    // Xóa entry khỏi lịch sử
    const indexToRemove = state.history.findIndex(h => h.id === portId && h.usedTime === usedTime);
    if (indexToRemove > -1) {
        state.history.splice(indexToRemove, 1);
        localStorage.setItem('gsm_history', JSON.stringify(state.history));
        renderHistory();
    }
    
    showToast(`Đã khôi phục cổng ${portId} về trạng thái đang hoạt động.`);
}

// Simulation helpers
function manualRefresh() {
    renderPorts();
    showToast('Đã cập nhật dữ liệu mới nhất!');
}

function simulateOtpArrival(portId, isZalo = false) {
    setTimeout(() => {
        const port = state.ports.find(p => p.id === portId);
        if (port && !port.hidden) {
            port.otp = isZalo ? Math.floor(1000 + Math.random() * 9000).toString() : Math.floor(100000 + Math.random() * 900000).toString();
            scheduleAutoHistory(portId);
            renderPorts();
            showToast(`Có mã OTP mới ở cổng ${portId}!`);
        }
    }, 3000);
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
        <span>${message}</span>
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
    // Load history from localStorage
    try {
        const savedHistory = localStorage.getItem('gsm_history');
        if (savedHistory) {
            state.history = JSON.parse(savedHistory);
        }
    } catch(e) {}

    fetchPorts();
    
    // Firebase on('value') tự động realtime nên không cần setInterval hay SSE nữa
    
    // Lắng nghe thông báo OTP mới từ Firebase
    db.ref('ports').on('child_changed', (snapshot) => {
        const port = snapshot.val();
        if (port && port.otp) {
            const existingPort = state.ports.find(p => p.id === port.id);
            if (!existingPort || existingPort.otp !== port.otp) {
                showToast(`Có mã OTP mới ở cổng ${port.id}!`);
                playNotificationSound();
            }
        }
        // Tắt spinner kiểm tra TKC khi balance thay đổi
        if (port && port.id && pendingBalanceChecks.has(port.id)) {
            pendingBalanceChecks.delete(port.id);
            // renderPorts sẽ được gọi bởi fetchPorts listener
        }
    });

    db.ref('server_status').on('value', (snapshot) => {
        const data = snapshot.val();
        if (data && data.lastSync) {
            lastSyncTime = data.lastSync;
            checkConnectionStatus();
        }
    });

    setInterval(checkConnectionStatus, 2000);
};

function checkConnectionStatus() {
    const indicator = document.querySelector('.system-status .status-indicator');
    const textSpan = document.querySelector('.system-status span');
    if (!indicator || !textSpan) return;

    const visibleCount = state.ports.filter(p => !p.hidden && !p.isTest).length;
    const now = Date.now();
    
    // Check if we haven't received a heartbeat in 6 seconds
    if (lastSyncTime === 0 || now - lastSyncTime > 6000) {
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
