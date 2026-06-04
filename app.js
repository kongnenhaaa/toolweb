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
            
            // Merge hidden history state
            data.forEach(serverPort => {
                const existingPort = state.ports.find(p => p.id === serverPort.id);
                if (existingPort && existingPort.hidden) {
                    serverPort.hidden = true;
                }
            });
            
            state.ports = data;
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

    visiblePorts.forEach(port => {
        const row = document.createElement('div');
        row.className = 'grid-row';
        row.id = `row-${port.id}`;

        const statusDot = port.status === 'online' ? 
            '<div class="status-indicator online"></div>' : 
            '<div class="status-indicator" style="background: red;"></div>';

        let otpContent = '<span style="color: var(--text-muted)">Đang chờ...</span>';
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
            <div class="col-phone">${port.phone.replace(/(\d{4})(\d{3})(\d{3})/, '$1 $2 $3')}</div>
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
            <div class="col-phone">${item.phone.replace(/(\d{4})(\d{3})(\d{3})/, '$1 $2 $3')}</div>
            <div class="col-otp"><span style="color: var(--success); font-weight: bold;">${item.otp}</span></div>
            <div class="col-time">${item.usedTime}</div>
        `;

        container.appendChild(row);
    });
}

// Export Excel (CSV)
function exportHistoryToExcel() {
    if (state.history.length === 0) {
        showToast('Không có dữ liệu để xuất!', 'error');
        return;
    }

    // Thêm BOM để Excel đọc tiếng Việt UTF-8 không bị lỗi font
    let csvContent = "\uFEFFCổng,Số Điện Thoại,OTP Đã Nhận,Thời Gian\n";
    
    state.history.forEach(item => {
        const phone = item.phone || '';
        const otp = item.otp || '';
        const time = item.usedTime || '';
        csvContent += `${item.id},"${phone}","${otp}","${time}"\n`;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `Lich_Su_OTP_${new Date().toLocaleDateString('vi-VN').replace(/\//g, '-')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showToast('Đã tải xuống file Excel!');
}

// Modal Logic
function openSmsModal(portId) {
    state.currentActionPortId = portId;
    const port = state.ports.find(p => p.id === portId);
    
    document.getElementById('sms-port-name').textContent = port.id;
    document.getElementById('sms-phone-number').textContent = port.phone;
    
    document.getElementById('sms-recipient-select').value = '8069';
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
    let recipient = document.getElementById('sms-recipient-select').value;
    if (recipient === 'custom') {
        recipient = document.getElementById('sms-recipient-custom').value;
    }
    
    if (!recipient) {
        showToast('Vui lòng nhập đầu số nhận!', 'error');
        return;
    }
    
    const content = document.getElementById('sms-content').value;
    
    try {
        const response = await fetch('http://localhost:5000/api/sms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                PortId: state.currentActionPortId,
                Recipient: recipient,
                Content: content
            })
        });
        
        if (response.ok) {
            showToast(`Đã gửi lệnh SMS từ ${state.currentActionPortId} đến ${recipient}`);
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
    // Pick a random visible port without OTP
    const available = state.ports.filter(p => !p.hidden && !p.otp);
    if(available.length > 0) {
        const randomPort = available[Math.floor(Math.random() * available.length)];
        simulateOtpArrival(randomPort.id);
        showToast(`Đang giả lập tin nhắn đến ${randomPort.id}...`);
    } else {
        showToast('Tất cả các cổng đã có OTP hoặc đã dùng.');
    }
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
    setInterval(fetchPorts, 2000); // Poll every 2 seconds
};
