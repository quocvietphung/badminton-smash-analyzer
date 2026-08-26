# SmashLab — Badminton Smash Analyzer

MVP phân tích động tác smash cầu lông qua camera trực tiếp. Ứng dụng dùng
MediaPipe Pose Landmarker để lấy 33 điểm cơ thể ngay trong trình duyệt, sau đó
tính góc khớp, tốc độ cổ tay tương đối và nhận diện các pha của cú smash. Các
chỉ số chuyển động được gửi tới FastAPI để phân loại cú đánh; khung hình camera
không được tải lên backend.

## Chạy local

```sh
npm run dev
```

Mở `http://localhost:3000`, bấm **Bật camera** và cho phép trình duyệt truy cập
camera. Lần đầu chạy cần Internet để tải WebAssembly và model Pose Landmarker.

Backend Python nằm trong `backend/` và được Vercel gắn tại `/api`. Có thể chạy
riêng ở local bằng lệnh sau trong thư mục `backend`:

```sh
python -m uvicorn main:app --reload --port 8000
```

Các endpoint chính:

- `GET /api/health`: kiểm tra FastAPI đang hoạt động
- `POST /api/analyze`: phân loại cú đánh từ các chỉ số tư thế
- `GET /api/docs`: tài liệu API tương tác

## Chỉ số MVP

- Góc khuỷu, góc vai và độ gập gối
- Tốc độ cổ tay tương đối và tốc độ duỗi tay
- Độ cao tiếp xúc tương đối và độ duỗi cơ thể
- Pha chuẩn bị, kéo vợt, tăng tốc, chạm cầu và theo đà
- Bảng UI phân loại và đếm Smash, Bỏ nhỏ, Cắt/chặt, Tạt cầu, Phông cầu
- Điểm kỹ thuật cùng lịch sử cú đánh trong phiên tập

> Tốc độ trong MVP chưa phải km/h. Muốn đo tốc độ quả cầu cần thêm model
> shuttlecock tracking và hiệu chuẩn không gian/camera.

## GitFlow local

Repository dùng hai nhánh dài hạn:

- `master`: mã ổn định để phát hành
- `develop`: nhánh tích hợp cho phiên bản kế tiếp

Nhánh ngắn hạn:

- `feature/*` tạo từ `develop`, merge lại `develop`
- `release/*` tạo từ `develop`, merge vào `master` và `develop`
- `hotfix/*` tạo từ `master`, merge vào `master` và `develop`

Tính năng phân tích live được phát triển tại `feature/live-smash-analysis`.
