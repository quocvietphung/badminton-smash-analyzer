# SmashLab Motion Science Studio

Ứng dụng Next.js/PWA phân tích **kỹ thuật chuyển động cầu lông** ngay trong trình
duyệt. Sản phẩm tập trung vào Motion Capture một vận động viên mỗi set, không còn
phân tích rally, vị trí sân hoặc chiến thuật điều cầu.

## Bản hiện tại làm được

- Nhận diện toàn thân bằng MediaPipe Pose Landmarker Lite và dùng thêm world
  landmarks 3D khi trình duyệt cung cấp.
- Chọn bài tập Smash, Backhand, Clear, Drop shot hoặc Drive; có chế độ tự nhận
  nhóm chuyển động.
- Chuyển sang mô-đun **Footwork** để chấm chu kỳ Start → Approach → Hit →
  Recovery từ mốc hông, gối và cổ chân.
- Danh mục bộ pháp gồm split step, running step, chassé, cross-behind,
  hop/pivot, lunge, jump & landing, bốn mẫu trước/cuối sân, hồi vị về base,
  shadow sáu góc, scissor jump và China jump.
- Khóa tay cầm vợt bằng lựa chọn người dùng hoặc suy luận qua nhiều frame.
- Tách mỗi lần lặp thành sáu pha: sẵn sàng, kéo vợt, tăng tốc, vùng tiếp xúc,
  theo đà và hồi vị.
- Chuẩn hóa tốc độ và hình học theo kích thước cơ thể để giảm ảnh hưởng khi
  người tập đứng gần hoặc xa camera.
- Chấm điểm tư thế, nhịp chuyển động, hồi vị, thăng bằng và chất lượng khung
  hình; hiển thị góc khuỷu, vai, gập gối, xoay thân và độ duỗi.
- So sánh độ ổn định giữa các lần lặp và tạo danh sách điểm mạnh/ưu tiên cần sửa.
- Lưu tối đa 12 set bằng IndexedDB trên thiết bị, không cần database.
- Chạy MediaPipe và đánh giá chuỗi trong Web Worker khi thiết bị hỗ trợ; có
  fallback trên luồng chính.
- Có SmashLab Coach dùng Azure GPT-4.1 mini và RAG để giải thích các chỉ số đã
  rút gọn. Chatbot không nhận video hoặc khung hình.

## Giới hạn được ghi rõ

- Motion Capture không nhìn thấy mặt vợt hoặc quả cầu.
- Không xác nhận thời điểm chạm cầu, chất lượng tiếp xúc, quỹ đạo, điểm rơi hoặc
  tốc độ km/h.
- Clear, Drop, Drive và Backhand được chấm theo bài tập người dùng đã chọn; điểm
  số mô tả hình thái cơ thể, không khẳng định kết quả đường cầu.
- `evidence` là mức đủ dữ liệu của chuỗi pose; `overallScore` là điểm nội bộ,
  không phải accuracy hoặc điểm chính thức của BWF.
- Tốc độ chân, tốc độ trọng tâm, biên độ di chuyển và độ rộng trụ là đơn vị
  tương đối theo cơ thể; không phải m/s hoặc mét vì app không hiệu chuẩn sân.
- Kết quả không thay thế huấn luyện viên và không dùng để chẩn đoán chấn thương.

## Cách quay tốt nhất

1. Phân tích một người mỗi set.
2. Đặt điện thoại cố định ngang hông, cách người tập khoảng 3–5 m.
3. Giữ đầu, hai tay và hai chân trong khung hình; tránh ngược sáng.
4. Chọn mô-đun kỹ thuật vợt hoặc bộ pháp và tay thuận trước khi bấm
   **Bắt đầu ghi set**.
5. Thực hiện từng lần lặp có chuẩn bị, vung và hồi vị rõ ràng.

## Chạy local

Sao chép các tên biến trong `.env.example` vào `.env.local`. API key chỉ được
đặt ở biến `AZURE_API_KEY` phía server, không dùng tiền tố `NEXT_PUBLIC_`.

```sh
npm run dev
```

Mở `http://localhost:3000`, chọn **Mở camera** và cho phép camera. Lần đầu cần
Internet để trình duyệt tải MediaPipe WASM và model Pose Landmarker Lite.

## Kiểm tra

```sh
npm run lint
npm run test:vision
npm run test:rag
npm run build
```

## Vercel Hobby

Vercel phân phối ứng dụng Next.js và chạy Route Handler cho AI Coach. Video,
MediaPipe và Motion Capture chạy trong trình duyệt nên không cần Python, GPU
cloud hoặc backend xử lý video.

Các biến production cho Coach: `AZURE_RESOURCE_NAME`, `AZURE_API_KEY`,
`AZURE_OPENAI_DEPLOYMENT` và `AZURE_OPENAI_API_VERSION`.

## GitFlow

- `master`: phiên bản production.
- `develop`: nhánh tích hợp.
- `feature/*`: tính năng mới.
- `release/*`: chuẩn bị phát hành.
- `hotfix/*`: sửa khẩn cấp.
