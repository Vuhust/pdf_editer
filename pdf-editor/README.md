# PDFix – PDF Editor (Demo)

Client-side PDF editor chạy **100% trong browser**, không upload file lên server.

## Công nghệ

- **PDF.js** – render và xem PDF
- **pdf-lib** – tạo file PDF khi lưu
- **Fabric.js** – vẽ, chữ, hình, chữ ký trên canvas

## Chạy demo

Mở file `index.html` trực tiếp trong trình duyệt (Chrome/Firefox/Edge), hoặc dùng local server:

```bash
# Python 3
python3 -m http.server 8080

# Node (npx)
npx serve .
```

Sau đó mở `http://localhost:8080` (hoặc đường dẫn tới thư mục chứa `index.html`).

## Tính năng

- **Open PDF** – chọn file PDF từ máy (chỉ đọc local, không gửi lên server).
- **Công cụ**: Chọn, Text, Vẽ tay, Hình chữ nhật, Hình elip, Highlight, Chữ ký.
- **Màu & độ dày** – đổi màu và kích thước nét.
- **Nhiều trang** – chuyển trang; annotation lưu theo từng trang.
- **Clear annotations** – xóa hết annotation trên trang hiện tại.
- **Save PDF** – tải xuống file PDF đã flatten (trang + annotation) với tên `pdfix-edited.pdf`.
