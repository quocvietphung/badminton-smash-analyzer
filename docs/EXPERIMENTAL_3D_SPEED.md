# Báo cáo thử nghiệm tốc độ cầu 3D

Ngày chạy: 17-11-2026. Đây là prototype nghiên cứu, không phải máy đo tốc độ và chưa được xác nhận bằng radar.

## Kết luận

- Bộ giải vật lý đã chạy thật trên quỹ đạo tổng hợp có ground truth ở 30, 60, 120 và 240 FPS.
- Trên 8 ca đủ dữ liệu (không nhiễu hoặc nhiễu Gaussian 1,5 px + mất 10% khung), MAE là **2,0838 km/h**; lỗi tương đối lớn nhất **8,6912%**; sensitivity interval chứa ground truth ở **75%** ca.
- 4 ca stress (nhiễu 4 px + mất 30% khung) đều bị từ chối trước fit bởi gate `tracking_gaps_dominate`. Tổng failure rate của ma trận 12 ca là **33,33%**, có chủ ý.
- Sample A không cho phép một tốc độ vật lý duy nhất. Sweep 75 giả định cho candidate **26,960–115,282 km/h**, median **43,181 km/h**, spread **204,54%**. Vì vậy HUD production hiển thị **Physical speed unavailable**.
- Cấu hình nghiên cứu danh nghĩa tại frame 52 cho **62,258 km/h**, nhưng residual RMS **7,766 px**, P95 **11,106 px**, cao hơn gate 4/8 px; camera/contact/timestamp cũng chưa được xác minh. Con số này bị loại, không phải kết quả đo.

## Mã nguồn nguyên bản

- `backend/app/physics/camera.py`: camera pinhole, projection, ray, validation và phân rã homography chỉ để chẩn đoán.
- `backend/app/physics/trajectory.py`: gravity, quadratic drag và RK4 hai chiều theo timestamp.
- `backend/app/physics/speed3d.py`: soft-L1 least squares, multi-start, net-plane fit, reprojection, sensitivity và quality gates.
- `backend/tools/benchmark_speed3d.py`: benchmark tổng hợp có ground truth.
- `backend/tools/explore_sample_a_speed3d.py`: sweep nghiên cứu Sample A, tách khỏi production.
- `backend/tests/test_speed3d.py`: kiểm thử RK4, ground truth, 30 FPS có nhiễu, net-plane và gate từ chối.

Không có code, model hay weight từ MonoTrack/FreeTrack được sao chép. SciPy 1.16.3 (BSD) cung cấp `least_squares`; phần mô hình, parameterisation, gate và benchmark là của SmashLab.

## Mô hình vật lý và camera

Trạng thái gồm vị trí `p=[x,y,z]` và vận tốc `v` trong hệ mét, với `z` hướng lên:

```text
dp/dt = v
dv/dt = [0, 0, -g] - k ||v|| v
g = 9.80665 m/s²
k = g / v_terminal²
v_terminal mặc định = 6.70 m/s
```

RK4 tích phân với bước tối đa 1/240 s. Camera dùng:

```text
q = K R (p - C)
pixel = [q_x/q_z, q_y/q_z]
```

Free monocular fit đặt điểm đầu trên viewing ray `p0 = C + s d` và tối ưu `[s,vx,vy,vz]`. Net-plane fit đặt trạng thái tại `y=6.70 m` và tối ưu `[x,z,vx,vy,vz,t_net]`. Residual pixel dùng `scipy.optimize.least_squares`, TRF, loss `soft_l1`, `f_scale=4 px`, nhiều điểm khởi tạo.

Ba đại lượng không bị trộn:

- `speed_first_observed_kmh`
- `speed_at_net_kmh`
- `speed_at_contact_extrapolated_kmh` (chỉ khi contact đủ gần quan sát đầu tiên)

## Quality gates production

Kết quả trả `unavailable` nếu thiếu một trong các điều kiện: contact được xác nhận; timestamp presentation thật; camera 3D độc lập với reprojection ≤3 px; ít nhất 10 quan sát; interpolation ≤20%; tracking gaps ≤25%; optimizer không chạm bounds; RMS ≤4 px và P95 ≤8 px; multi-start spread ≤12%; camera/drag sensitivity spread ≤20%; speed trong 18–500 km/h.

Các ngưỡng tracking/reprojection được stress-test trong benchmark. Chúng không phải confidence giả lập. Riêng uncertainty hiện chỉ perturb drag ±15% và focal ±1%; benchmark cho thấy nó chưa bao phủ hết tracking noise (coverage 75%), nên chưa được coi là khoảng tin cậy thống kê.

## Benchmark tổng hợp thực tế

Ground truth ban đầu là **104,0425 km/h**, camera pinhole đã biết, flight 0,60 s.

| FPS | Nhiễu / gap | Kết quả | Ước lượng | Lỗi tương đối | RMS | Uncertainty |
| ---: | --- | --- | ---: | ---: | ---: | --- |
| 30 | 0 px / 0% | pass | 104,0 | 0,0408% | 0,000 px | 100,2–108,1 |
| 30 | 1,5 px / 10% | pass | 103,7 | 0,3292% | 1,697 px | 99,9–107,7 |
| 60 | 0 px / 0% | pass | 104,0 | 0,0408% | 0,000 px | 100,3–108,0 |
| 60 | 1,5 px / 10% | pass | 95,0 | 8,6912% | 2,055 px | 91,8–98,4 (không chứa truth) |
| 120 | 0 px / 0% | pass | 104,0 | 0,0408% | 0,000 px | 100,3–107,9 |
| 120 | 1,5 px / 10% | pass | 106,4 | 2,2659% | 2,004 px | 102,6–110,3 |
| 240 | 0 px / 0% | pass | 104,0 | 0,0408% | 0,000 px | 100,4–107,9 |
| 240 | 1,5 px / 10% | pass | 108,8 | 4,5727% | 2,114 px | 105,0–112,8 (không chứa truth) |
| 30/60/120/240 | 4 px / 30% | reject | – | – | – | `tracking_gaps_dominate` |

Lệnh tái lập:

```bash
PYTHONPATH=backend backend/.venv-dev/bin/python backend/tools/benchmark_speed3d.py
```

## Sample A — thí nghiệm nghiên cứu

Nguồn: 1920×1080, 30 FPS, 450 frame, 15 s. TrackNet có điểm quanh frame 52; production đọc được 22 quan sát không nội suy từ frame 52–73. File hiện tại ghi `frame/fps`, không phải presentation timestamp đã lưu. Frame 52 là automatic candidate, chưa có manual confirmation.

Floor homography được phân rã với các giả định: square pixels, zero skew, principal point gần tâm ảnh, zero distortion; trục y của sân được đảo để tạo hệ x/y/z-up tay phải. Cấu hình danh nghĩa ước lượng `f=4190,246 px`, camera `[3,059; -20,933; 6,447] m`. Đây không phải calibration 3D độc lập.

### Contact-time sensitivity (camera danh nghĩa, terminal velocity 6,70 m/s)

| Frame | Candidate km/h | RMS / P95 px | Trạng thái fit |
| ---: | ---: | ---: | --- |
| 50 | 42,804 | 23,677 / 56,743 | chạm bounds, loại |
| 51 | 28,983 | 12,065 / 27,635 | residual quá cao |
| 52 | 62,258 | 7,766 / 11,106 | residual quá cao |
| 53 | 46,020 | 6,261 / 11,376 | residual quá cao |
| 54 | 39,286 | 4,041 / 7,614 | RMS vẫn vượt gate |

### Focal sensitivity tại frame 52

Focal scale 0,8→1,2 làm candidate đổi **56,066→66,812 km/h**; RMS vẫn khoảng 7,72–7,80 px. Thay đổi terminal velocity 6,0→7,4 m/s làm candidate đổi **55,199→69,156 km/h**, trong khi RMS gần như không đổi (7,787→7,756 px). Residual không phân biệt tốt các giả định drag này.

Toàn sweep 5 focal × 3 principal-y × 5 contact frame chạy **139,726 s**, peak RSS **69,39 MB**. 66/75 fit hội tụ; candidate 26,960–115,282 km/h. Đây là bằng chứng thực nghiệm rằng bài toán hiện tại không identifiable đủ để công bố một speed.

Lệnh tái lập:

```bash
PYTHONPATH=backend backend/.venv-dev/bin/python backend/tools/explore_sample_a_speed3d.py outputs/275f90cf23ae47ff82b6f6d6844e6002
```

## Sample B–D

- B: 30 FPS, floor homography có nhưng vẫn thiếu camera 3D độc lập, timestamp thật và contact xác nhận; production phải trả unavailable.
- C: 30 FPS, court calibration failed; không đủ điều kiện thử 3D.
- D: 25 FPS, court calibration failed; không đủ điều kiện thử 3D.

Không có speed nào được điền để “làm đẹp” giao diện.

## Muốn đo đáng tin cậy hơn cần gì

1. Quay 120–240 FPS, shutter nhanh, camera cố định; lưu presentation timestamps theo từng frame.
2. Calibrate `K` và lens distortion bằng checkerboard/Charuco ở cùng zoom/focus.
3. Xác định extrinsics bằng các điểm sân và ít nhất hai ràng buộc ngoài mặt phẳng (đỉnh cột lưới/net tape hoặc calibration target 3D); lưu reprojection residual.
4. Người dùng xác nhận contact frame; tốt hơn là camera thứ hai đồng bộ.
5. Thu radar/speed-gun ground truth độc lập để đánh giá bias, uncertainty coverage và đặt gate trên dữ liệu thật.

Cho tới khi có các dữ liệu trên, px/s vẫn là số đo image-space độc lập; km/h chỉ hiện khi mọi gate pass và luôn mang nhãn **Experimental 3D Speed Estimate — Not Radar Validated**.
