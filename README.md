# SmashLab Pose Lite

Ứng dụng Next.js/PWA phân tích chuyển động cầu lông ngay trong trình duyệt. Bản
này được thiết kế riêng cho Vercel Hobby và điện thoại: video camera không được
gửi lên máy chủ, không cần FastAPI hoặc GPU cloud.

## Bản Lite đang làm được

- Nhận diện tối đa hai người bằng MediaPipe Pose Landmarker Lite và giữ ID A/B
  ổn định qua các frame, kể cả khi thứ tự kết quả MediaPipe thay đổi.
- Khóa tay cầm vợt bằng lựa chọn người dùng hoặc suy luận chuyển động nhiều frame.
- Chuẩn hóa tốc độ, độ cao và độ duỗi theo kích thước cơ thể; dùng thêm world
  landmarks 3D cho góc khớp khi MediaPipe cung cấp.
- Phát hiện cửa sổ vung tay có nhịp tăng tốc–đỉnh–giảm tốc rõ và phân loại theo
  tầng. Chế độ tự do không ép Clear/Drop khi không có quỹ đạo; chế độ bài tập
  cho phép chọn Smash, Clear, Drop shot hoặc Drive/tạt làm ngữ cảnh.
- Nội suy chuỗi tư thế về nhịp thời gian ổn định thay vì phụ thuộc số frame máy xử lý.
- Hiển thị mức bằng chứng, cường độ vung tay và điểm tư thế. Đây không phải
  accuracy của model đã kiểm định.
- Tự tìm bốn góc sân qua nhiều khung hình, chấm chất lượng hình học, cảnh báo
  khung lệch và cho kéo từng góc bằng thao tác cảm ứng toàn màn hình.
- Lưu tối đa 12 phiên bằng IndexedDB trên thiết bị, không cần database.
- Chạy cả MediaPipe inference và phân loại trong Web Worker khi thiết bị hỗ trợ;
  tự fallback về luồng chính nếu Worker không khởi tạo được.
- Có SmashLab Coach dùng Azure GPT-4.1 mini để giải thích số liệu của phiên đang
  hiển thị. Chatbot chỉ nhận dữ liệu đã rút gọn, không nhận video hoặc khung hình.
- Coach dùng RAG nhẹ ngay trong Vercel Function: tìm các đoạn liên quan trong kho
  kiến thức BWF Coach Education, ShuttleSet, TrackNetV3 và giới hạn nội bộ trước
  khi gọi Azure. Không cần vector database hoặc model embedding riêng.

## Giới hạn được ghi rõ trên giao diện

- Không có TrackNetV3 nên chưa nhìn thấy hoặc theo dõi quả cầu.
- Không có BST đã huấn luyện; phân loại hiện là bộ ước tính theo chuỗi pose.
- Không đo tốc độ cầu km/h.
- Không kết luận điểm rơi, đường cầu dài/ngắn, thẳng/chéo hoặc chiến thuật rally.
- Clear, Drop và Drive vẫn bị giới hạn bằng chứng vì cần quỹ đạo cầu để xác nhận.
  Ở chế độ tự do, động tác overhead có kiểm soát được ghi là
  “Clear / Drop chưa phân biệt”.
- Không gán nhãn cắt/slice từ pose.

## Chạy local

Sao chép các tên biến trong `.env.example` vào `.env.local`. API key chỉ được
đặt ở biến `AZURE_API_KEY` phía server, tuyệt đối không dùng tiền tố
`NEXT_PUBLIC_`.

```sh
npm run dev
```

Mở `http://localhost:3000`, chọn **Mở camera** và cho phép camera. Lần đầu cần
Internet để trình duyệt tải MediaPipe WASM và model Pose Landmarker Lite.

## Kiểm tra

```sh
npm run lint
npm run test:vision
npm run test:calibration
npm run test:rag
npm run build
```

## Triển khai Vercel Hobby

`vercel.json` chỉ triển khai ứng dụng Next.js. Thư mục `backend/` có banner riêng
và chỉ được giữ để tham khảo/thử nghiệm local; nó không phải service production. Pose
Lite vẫn chạy trong trình duyệt; Route Handler `/api/ai/chat` chỉ gửi bản tóm
tắt số liệu sang Azure OpenAI. Vercel cần các biến `AZURE_RESOURCE_NAME`,
`AZURE_API_KEY`, `AZURE_OPENAI_DEPLOYMENT` và `AZURE_OPENAI_API_VERSION`.

Endpoint chat giới hạn kích thước yêu cầu, số lượt trong một khoảng thời gian
và số token trả lời. Nếu có `UPSTASH_REDIS_REST_URL` và
`UPSTASH_REDIS_REST_TOKEN`, giới hạn lượt gọi được đồng bộ giữa các Vercel
Function; nếu chưa cấu hình, app tự dùng bộ giới hạn memory dành cho MVP.

## GitFlow local

- `master`: phiên bản phát hành.
- `develop`: nhánh tích hợp.
- `feature/*`: tính năng mới từ `develop`.
- `release/*`: chuẩn bị phát hành.
- `hotfix/*`: sửa khẩn cấp từ `master`.
