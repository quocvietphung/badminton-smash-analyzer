# Python experiment — không chạy trên production

Thư mục này chỉ lưu bộ luật FastAPI cũ để đối chiếu và thử nghiệm local. Vercel
production của SmashLab **không khởi động service Python này** và giao diện hiện
tại cũng không gọi các endpoint trong đây.

Pipeline production là:

`Camera → MediaPipe Pose Lite trong trình duyệt → Web Worker → IndexedDB`

Route Handler Next.js `/api/ai/chat` chỉ gửi số liệu đã rút gọn tới Azure OpenAI.
Không đưa model TrackNet/BST hoặc số km/h ước tính từ thư mục thử nghiệm này trở
lại giao diện nếu chưa có kiểm định bằng video gắn nhãn.
