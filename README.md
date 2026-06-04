# GSM PRO - Web Interface 📱

Đây là giao diện Web (Frontend) được thiết kế chuyên biệt để quản lý hệ thống Box SIM (32 cổng) phục vụ cho việc tạo tài khoản, nhận OTP tự động, và đặc biệt tối ưu cho quy trình đăng ký Zalo.

Giao diện Web này hoạt động theo mô hình Client-Server, kết nối trực tiếp với phần mềm **C# (toolgsm)** chạy ngầm ở phía dưới.

---

## ✨ Tính Năng Nổi Bật

1. **Quản lý tập trung 32 Cổng SIM:** Hiển thị trực quan toàn bộ 32 cổng COM, tự động cập nhật số điện thoại và trạng thái (Online/Lỗi) theo thời gian thực.
2. **Gửi SMS Lấy OTP nhanh chóng:** 
   - Hỗ trợ gửi SMS ngay trên trình duyệt mà không cần thao tác với phần mềm kỹ thuật.
   - Hỗ trợ chọn nhanh tổng đài Zalo (8500, 7539) hoặc nhập tổng đài tùy chỉnh.
3. **Bắt và Hiển thị OTP Tự Động:**
   - Cơ chế Polling liên tục kiểm tra tin nhắn. Khi có OTP mới, hệ thống tự động làm nổi bật (highlight màu vàng) mã OTP ngay cạnh số điện thoại.
4. **Quản lý Lịch sử thông minh:**
   - Đánh dấu các số "Đã dùng" chỉ với 1 click. Số sẽ tự động trượt ẩn đi để CTV không bị nhầm lẫn.
   - Toàn bộ số đã dùng được chuyển vào "Lịch sử OTP".
5. **Xuất Báo Cáo Excel:**
   - Hỗ trợ trích xuất toàn bộ lịch sử sử dụng ra file CSV (Excel) kèm thời gian rõ ràng, không bị lỗi font tiếng Việt.
6. **Giao diện Cao Cấp (Premium UI):**
   - Thiết kế Dark Mode, hiệu ứng Glassmorphism mượt mà.

---

## 🚀 Hướng Dẫn Sử Dụng (Dành Cho CTV)

### Bước 1: Khởi động hệ thống máy chủ (Back-end)
*Yêu cầu kỹ thuật viên thao tác:*
1. Cắm thiết bị Box SIM vào máy tính.
2. Mở thư mục chứa mã nguồn C# (`toolgsm`).
3. Chạy phần mềm C# (Có thể dùng lệnh `dotnet run` qua Terminal). 
   *(Lúc này phần mềm C# sẽ tự động mở một máy chủ ngầm tại địa chỉ http://localhost:5000).*

### Bước 2: Làm việc trên Web (Front-end)
1. Mở trình duyệt Web (Chrome/Edge/Cốc Cốc).
2. Truy cập vào địa chỉ: **`http://localhost:5000`** hoặc mở trực tiếp tệp `index.html`.
3. Màn hình sẽ tự động hiển thị danh sách các SIM đang được cắm vào.

### Bước 3: Thao tác Lấy OTP
1. Tìm một số điện thoại đang rảnh trong danh sách.
2. Bấm nút **Gửi SMS** màu xanh nước biển.
3. Chọn tổng đài (VD: 8500) và bấm **Gửi**.
4. Ngồi chờ. Khi tin nhắn phản hồi từ tổng đài về tới Box SIM, mã OTP sẽ tự động hiện lên trên màn hình web.
5. Sau khi lấy mã nhập vào app thành công, bấm nút **Đã dùng** (màu xanh lá) để hệ thống cất số đó vào Lịch sử.

### Bước 4: Cuối ngày làm việc
1. Ở menu bên trái, bấm sang tab **Lịch sử OTP**.
2. Bấm nút **Xuất Excel** để tải báo cáo công việc về máy tính.

---

## 🛠 Cấu Trúc Kỹ Thuật

- **Frontend:** Thuần HTML5, CSS3 (Vanilla), JavaScript (ES6).
- **Thiết kế:** Dark Theme, Flexbox/Grid. Icon được cung cấp bởi Lucide Icons.
- **Backend (API):** ASP.NET Core (Kestrel) được nhúng trực tiếp vào WPF app (`toolgsm`).
- **Giao tiếp:** `app.js` sử dụng `fetch()` API để lấy dữ liệu (GET `/api/ports`) mỗi 2 giây và gửi lệnh (POST `/api/sms`).
