# Báo cáo thử nghiệm tốc độ cầu 3D

Ngày chạy: 17-11-2026, cập nhật 20-11-2026. Đây là prototype nghiên cứu, không phải máy đo tốc độ và chưa được kiểm tra bằng radar.

## Cập nhật 20-11-2026: ba tầng kết quả

| Tầng | Ý nghĩa | Trạng thái với sample A–D |
|---|---|---|
| Observed 2D | điểm TrackNet/InpaintNet sau bộ lọc dùng chung observed-2d/v1, px/s | luôn có |
| Estimated 3D — monocular experimental | fit một camera (gravity + quadratic drag), chỉ "available" khi mọi gate đạt | rejected: không có calibration camera 3D độc lập, contact chưa xác nhận |
| Measured 3D — stereo | triangulation từ hai camera đồng bộ đã calibrate | NOT RUN — stereo input unavailable |

`estimate_monocular()` (thay cho `estimate_shot_speed()`) trả về schema:

```json
{
  "mode": "estimated_monocular",
  "status": "available | rejected",
  "trajectory_xyz_m": [],
  "speed_candidate_kmh": null,
  "speed_range_kmh": null,
  "reprojection_rms_px": null,
  "reprojection_p95_px": null,
  "parameter_spread_percent": null,
  "quality": "low | medium | high",
  "assumptions": [],
  "rejection_reasons": [],
  "gates": [{"id": "...", "passed": true, "value": null, "limit": null}]
}
```

- Quan sát: chỉ điểm TrackNet đã qua observed-2d/v1 (tracker jump đã bị loại), từ frame contact tới contact kế tiếp hoặc
  tối đa 0,70 s; điểm InpaintNet không bao giờ là quan sát. Thời gian là presentation timestamp thật của video.
- Gate trước khi fit: contact được xác nhận; presentation timestamp; ≥10 quan sát; nội suy ≤20%; khoảng trống ≤25%;
  camera 3D độc lập (`camera_3d`). Một homography mặt sân không phải camera 3D độc lập, nên sample A–D bị từ chối ở đây,
  không chạy fit.
- Gate sau khi fit: optimizer hội tụ trong bounds; RMS ≤4 px và P95 ≤8 px; multistart spread ≤12%; tốc độ 18–500 km/h;
  sensitivity spread ≤20% và không kịch bản nào thất bại.
- Sensitivity (mọi tốc độ lấy tại thời điểm quan sát đầu của baseline): focal ±(độ bất định của calibration, mặc định 1%),
  principal point ±0,5% theo x và y, contact −2/−1/+1/+2 frame, drag ±15%, bỏ mỗi điểm thứ ba, bỏ hai điểm đầu.
  Kịch bản contact trước frame đầu video ghi `not_applicable`.
- `speed_range_kmh` là [min, max] của baseline và mọi kịch bản; `parameter_spread_percent` = (max − min) / median.
- Chỉ khi `status = available` mới có `speed_candidate_kmh`, `speed_range_kmh` và `trajectory_xyz_m`. Kết quả bị từ chối
  giữ RMS/P95/spread để chẩn đoán nhưng không có km/h; giao diện ghi "Physical trajectory unavailable" và vẫn giữ quỹ
  đạo 2D. Estimated 3D không bao giờ được gọi là measured hay ground truth.
- Kết quả được tính một lần trong worker và ghi vào `derived/estimated_3d.json`; Measured 3D ghi `derived/measured_3d.json`
  với `status: not_run`.

### Measured 3D — stereo (`backend/app/physics/stereo.py`)

Chỉ có interface và thuật toán, kiểm thử bằng dữ liệu tổng hợp có ground truth (`backend/tests/test_stereo.py`):
camera intrinsics + distortion Brown-Conrady (k1, k2, p1, p2, k3), extrinsics, đồng bộ timestamp có offset và tolerance,
epipolar matching bằng fundamental matrix, triangulation DLT trên toạ độ đã khử méo, kiểm tra depth dương ở cả hai camera,
góc tia tối thiểu 2°, reprojection ≤2 px, rồi làm mượt vật lý (gravity + drag). Trên chuyến bay tổng hợp với hai camera
có méo, lệch đồng hồ 2 ms và điểm nhiễu: sai số vị trí 3D < 2 cm, reprojection RMS < 0,5 px, tốc độ lệch < 1%.
Sample A–D chỉ có một camera, nên không có camera thứ hai nào được giả lập.

### Tự hiệu chỉnh camera từ sân (`backend/app/physics/self_calibration.py`, court-self-calibration/v1, 26-11-2026)

- Mặt sàn: homography của vạch sân cho ra camera (xoay, vị trí, tiêu cự) với các giả định ghi rõ trong kết quả: điểm ảnh
  vuông, không skew, tâm ảnh ở giữa khung, không méo ống kính. Sai số chiếu lại vạch sân được đo (`floor_reprojection_rms_px`).
- Kiểm tra độc lập phía trên mặt sàn: mép trên của lưới cao 1,55 m ở cột và 1,524 m ở giữa (Luật Cầu lông BWF, Điều 1).
  Camera dựng chỉ từ mặt sàn dự đoán vị trí băng lưới; băng lưới được dò trên ảnh nền trung vị (top-hat ngang, che các vạch
  sơn đã biết, tâm băng theo trọng tâm độ sáng). Không có gì phía trên mặt sàn được dùng để dựng camera, nên khớp được là
  một ràng buộc 3D độc lập.
- Ngưỡng đặt trước (cho 1080 dòng, co giãn theo chiều cao ảnh): vạch sân ≤ 3 px; băng lưới tìm thấy ở ≥ 60% điểm mẫu, các
  điểm nằm trên một đường cong trơn (lệch ≤ 2 px); sai lệch giữa dự đoán và băng lưới ≤ 3 px. Chỉ khi qua hết, `camera_3d`
  mới có `independent_3d: true`, và vẫn chỉ dùng cho "Estimated 3D — monocular experimental" với mọi gate của bộ ước lượng
  (contact phải được người xác nhận, v.v.). Ứng viên tự động vẫn bị từ chối trước khi fit.
- Sửa lỗi kèm theo: `decompose_floor_homography` trước đây lấy trung vị của hai nghiệm tiêu cự riêng; khi camera nhìn thẳng
  dọc sân, một ràng buộc suy biến (0 = 0) cho nghiệm nhiễu và kéo tiêu cự sai (1132 px thay vì 1600 px trên cảnh tổng hợp).
  Nay giải bình phương tối thiểu theo 1/f², ràng buộc suy biến tự mất trọng số.
- Tổng hợp (`backend/tests/test_self_calibration.py`): hai camera đã biết (1600 px và 1250 px) được khôi phục sai số < 1%,
  sai lệch băng lưới 1,3 px và 1,1 px → validated; lưới vẽ thấp 20% hoặc không có lưới → bị từ chối.
- Sample A và B (`backend/tools/self_calibrate_camera.py`, báo cáo trong `outputs/test-runs/20261126-150544-self-calibration/`):

  | Sample | Vạch sân RMS | Băng lưới tìm thấy | Lệch băng lưới | Tiêu cự từ mặt sàn | Tiêu cự khớp lưới nhất | Kết quả |
  |---|---|---|---|---|---|---|
  | A | 0,018 px | 96% (lệch quanh đường cong 0,51 px) | **4,66 px** | 4190 px | 4714 px (lệch còn 0,71 px) | bị từ chối |
  | B | 0,759 px | 96% (0,52 px) | **3,82 px** | 4212 px | 4654 px (0,76 px) | bị từ chối |

  Camera từ mặt sàn đặt băng lưới gần đúng nhưng vượt ngưỡng 3 px. Tiêu cự dài hơn 11–12% thì khớp, cho thấy giả định
  "tâm ảnh ở giữa khung" (hoặc độ zoom/cắt khung của bản phát sóng) không đúng với các clip này. Ngưỡng không được nới để
  cho qua. Vì vậy A và B vẫn là `insufficient_3d_camera_calibration`; sample C và D không có sân được hiệu chỉnh nên
  không chạy. Không có con số km/h mới nào.

## Kết luận

- Bộ giải vật lý đã chạy thật trên quỹ đạo tổng hợp có ground truth ở 30, 60, 120 và 240 FPS.
- Trên 8 ca đủ dữ liệu (không nhiễu hoặc nhiễu Gaussian 1,5 px + mất 10% khung), MAE là **2,0838 km/h**; lỗi tương đối lớn nhất **8,6912%**; sensitivity interval chứa ground truth ở **75%** ca.
- 4 ca stress (nhiễu 4 px + mất 30% khung) đều bị từ chối trước fit bởi gate `tracking_gaps_dominate`. Tổng failure rate của ma trận 12 ca là **33,33%**, có chủ ý.
- Sample A không cho phép một tốc độ vật lý duy nhất. Sweep 75 giả định cho candidate **26,960–115,282 km/h**, median **43,181 km/h**, spread **204,54%**. Vì vậy HUD production hiển thị **Physical speed unavailable**.
- Cấu hình nghiên cứu danh nghĩa tại frame 52 cho **62,258 km/h**, nhưng residual RMS **7,766 px**, P95 **11,106 px**, cao hơn gate 4/8 px; camera/contact/timestamp cũng chưa được xác minh. Con số này bị loại, không phải kết quả đo.

## Mã nguồn nguyên bản

- `backend/app/physics/camera.py`: camera pinhole, projection, ray, validation và phân rã homography chỉ để chẩn đoán.
- `backend/app/physics/trajectory.py`: gravity, quadratic drag và RK4 hai chiều theo timestamp.
- `backend/app/physics/speed3d.py`: `estimate_monocular()`: soft-L1 least squares, multi-start, net-plane fit, reprojection, sensitivity mở rộng và quality gates.
- `backend/app/physics/stereo.py`: Measured 3D — stereo (interface, triangulation, kiểm tra, NOT RUN khi không có stereo).
- `backend/tools/benchmark_speed3d.py`: benchmark tổng hợp có ground truth.
- `backend/tools/explore_sample_a_speed3d.py`: sweep nghiên cứu Sample A, tách khỏi production.
- `backend/tests/test_speed3d.py`: kiểm thử RK4, ground truth, 30 FPS có nhiễu, net-plane, gate từ chối, sensitivity quá rộng bị từ chối, điểm bị sanitizer loại không thành quan sát.
- `backend/tests/test_stereo.py`: triangulation tổng hợp, depth dương, góc tia tối thiểu, epipolar, đồng bộ, NOT RUN.

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

Các ngưỡng tracking/reprojection được stress-test trong benchmark. Chúng không phải confidence giả lập. Đến 17-11 sensitivity chỉ perturb drag ±15% và focal ±1% (coverage 75%). Từ 20-11 thêm principal point, contact ±1/±2 frame và điểm bị thiếu: trên benchmark tổng hợp, khoảng tốc độ chứa ground truth ở 8/8 ca được chấp nhận. Đây vẫn không phải khoảng tin cậy thống kê.

## Benchmark tổng hợp thực tế

Ground truth ban đầu là **104,0425 km/h**, camera pinhole đã biết, flight 0,60 s.

Chạy lại ngày 20-11-2026 với `estimate_monocular()` và sensitivity mở rộng:

| FPS | Nhiễu / gap | Kết quả | Ước lượng | Lỗi tương đối | RMS | Khoảng (sensitivity) | Spread |
| ---: | --- | --- | ---: | ---: | ---: | --- | ---: |
| 30 | 0 px / 0% | available | 104,0 | 0,0408% | 0,000 px | 100,2–108,1 | 7,6% |
| 30 | 1,5 px / 10% | available | 103,7 | 0,3292% | 1,697 px | 89,5–107,7 | 17,5% |
| 60 | 0 px / 0% | available | 104,0 | 0,0408% | 0,000 px | 100,3–108,0 | 7,4% |
| 60 | 1,5 px / 10% | available | 95,0 | 8,6912% | 2,055 px | 89,1–105,2 | 16,9% |
| 120 | 0 px / 0% | available | 104,0 | 0,0408% | 0,000 px | 100,3–107,9 | 7,3% |
| 120 | 1,5 px / 10% | available | 106,4 | 2,2659% | 2,004 px | 102,6–110,3 | 7,3% |
| 240 | 0 px / 0% | available | 104,0 | 0,0408% | 0,000 px | 100,4–107,9 | 7,2% |
| 240 | 1,5 px / 10% | available | 108,8 | 4,5727% | 2,114 px | 101,1–112,8 | 10,8% |
| 30/60/120/240 | 4 px / 30% | rejected | – | – | – | – | `tracking_gaps_dominate` |

Tổng: 8/12 chấp nhận, MAE 2,0838 km/h, lỗi tương đối trung vị 0,185%, lớn nhất 8,6912%; khoảng chứa ground truth 8/8.

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

Cho tới khi có các dữ liệu trên, px/s vẫn là số đo image-space độc lập; km/h chỉ hiện khi mọi gate pass và luôn mang nhãn **Estimated 3D — monocular experimental** kèm khoảng tốc độ; nếu không, giao diện ghi **Physical trajectory unavailable**.
