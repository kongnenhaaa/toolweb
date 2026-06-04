// State
const state = {
    ports: [],
    history: [],
    currentActionPortId: null
};

// Fetch real data from C# API
async function fetchPorts() {
    try {
        const response = await fetch('http://localhost:5000/api/ports');
        if (response.ok) {
            const data = await response.json();
            
            // Merge hidden history state and smsSent status
            data.forEach(serverPort => {
                const existingPort = state.ports.find(p => p.id === serverPort.id);
                if (existingPort) {
                    if (existingPort.hidden) {
                        // Tự động hiện lại cổng nếu C# báo OTP mới hoặc OTP bị reset (thay SIM mới)
                        if (serverPort.otp !== existingPort.otp) {
                            serverPort.hidden = false;
                            serverPort.smsSent = false; // Reset trạng thái gửi SMS
                        } else {
                            serverPort.hidden = true;
                        }
                    }
                    if (existingPort.smsSent && !serverPort.hidden) {
                        serverPort.smsSent = true;
                    }
                }
            });
            
            // Retain locally created test ports
            const testPorts = state.ports.filter(p => p.isTest);
            state.ports = [...data, ...testPorts];
            
            renderPorts();
        }
    } catch (error) {
        console.error('Lỗi khi tải dữ liệu từ máy chủ:', error);
    }
}

// Render Ports
function renderPorts() {
    const container = document.getElementById('ports-container');
    container.innerHTML = '';

    const visiblePorts = state.ports.filter(p => !p.hidden);

    if (visiblePorts.length === 0) {
        container.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--text-muted);">Tất cả các số đã được sử dụng.</div>`;
        return;
    }

    // Sort ports by COM number (e.g. COM1, COM2, COM10)
    visiblePorts.sort((a, b) => {
        const numA = parseInt(a.id.replace(/\D/g, '')) || 0;
        const numB = parseInt(b.id.replace(/\D/g, '')) || 0;
        return numA - numB;
    });

    visiblePorts.forEach(port => {
        const row = document.createElement('div');
        row.className = 'grid-row';
        row.id = `row-${port.id}`;

        const statusDot = port.status === 'online' ? 
            '<div class="status-indicator online"></div>' : 
            '<div class="status-indicator" style="background: red;"></div>';

        let otpContent = port.smsSent ? 
            '<span style="color: #f39c12">Đang chờ mã...</span>' : 
            '<span style="color: var(--text-muted)">Chưa gửi tin nhắn</span>';
        let actionButtons = `
            <button class="btn btn-primary" onclick="openSmsModal('${port.id}')" title="Gửi SMS Lấy OTP">
                <i data-lucide="send"></i> Gửi SMS
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
        `;

        container.appendChild(row);
    });
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
        const response = await fetch('http://localhost:5000/api/sms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                PortId: actionPortId,
                Recipient: recipient,
                Content: content
            })
        });
        
        if (response.ok) {
            const port = state.ports.find(p => p.id === actionPortId);
            if (port) port.smsSent = true;
            renderPorts();
            showToast(`Đã gửi lệnh SMS từ ${actionPortId} đến ${recipient}`);
        } else {
            showToast('Lỗi khi gửi SMS!', 'error');
        }
    } catch (error) {
        showToast('Không thể kết nối tới máy chủ!', 'error');
    }
    
    closeModal('sms-modal');
}

// Mark as Used
function markAsUsed(portId) {
    const portIndex = state.ports.findIndex(p => p.id === portId);
    if (portIndex > -1) {
        const port = state.ports[portIndex];
        
        // Add exit animation class
        const row = document.getElementById(`row-${portId}`);
        if(row) {
            row.classList.add('row-exit');
            
            // Add to history
            state.history.push({
                ...port,
                usedTime: new Date().toLocaleTimeString('vi-VN')
            });

            setTimeout(() => {
                port.hidden = true; // hide from main view
                renderPorts();
                showToast(`Đã lưu SĐT ${port.phone} vào lịch sử.`);
            }, 400); // wait for animation
        }
    }
}

// Simulation helpers
function manualRefresh() {
    fetchPorts().then(() => {
        showToast('Đã cập nhật dữ liệu mới nhất!');
    });
}

function simulateOtpArrival(portId, isZalo = false) {
    setTimeout(() => {
        const port = state.ports.find(p => p.id === portId);
        if (port && !port.hidden) {
            port.otp = isZalo ? Math.floor(1000 + Math.random() * 9000).toString() : Math.floor(100000 + Math.random() * 900000).toString();
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
document.getElementById('nav-active').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('nav-active').classList.add('active');
    document.getElementById('nav-history').classList.remove('active');
    
    document.getElementById('active-view').style.display = 'block';
    document.getElementById('history-view').style.display = 'none';
    document.getElementById('page-title').textContent = 'Quản lý Cổng SIM';
    renderPorts();
});

document.getElementById('nav-history').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('nav-history').classList.add('active');
    document.getElementById('nav-active').classList.remove('active');
    
    document.getElementById('active-view').style.display = 'none';
    document.getElementById('history-view').style.display = 'block';
    document.getElementById('page-title').textContent = 'Lịch sử OTP';
    renderHistory();
});

// Init
window.onload = () => {
    fetchPorts();
    setInterval(fetchPorts, 3000); // Poll every 3 seconds để giảm tải
};
