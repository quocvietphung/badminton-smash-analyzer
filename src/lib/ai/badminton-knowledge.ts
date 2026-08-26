export type KnowledgeSource = {
  title: string;
  publisher: string;
  url?: string;
};

export type KnowledgeChunk = {
  id: string;
  title: string;
  category: "system" | "technique" | "measurement" | "tactics";
  tags: string[];
  content: string;
  source: KnowledgeSource;
};

export const BADMINTON_KNOWLEDGE: KnowledgeChunk[] = [
  {
    id: "pose-lite-evidence",
    title: "Pose Lite quan sát được gì",
    category: "system",
    tags: ["pose lite", "bằng chứng", "độ tin cậy", "camera", "giới hạn", "accuracy"],
    content:
      "SmashLab Pose Lite chỉ quan sát chuỗi mốc cơ thể, góc khớp, cường độ vung và vị trí tương đối của người chơi. Evidence là điểm bằng chứng của bộ luật, không phải xác suất đúng. Hệ thống không thấy vợt hoặc quả cầu nên một nhãn kỹ thuật vẫn có thể bị nhầm.",
    source: { title: "Phạm vi đo của SmashLab Pose Lite", publisher: "SmashLab" },
  },
  {
    id: "pose-lite-unavailable-measurements",
    title: "Những số liệu chưa thể xác nhận",
    category: "measurement",
    tags: ["km h", "tốc độ", "quỹ đạo", "điểm rơi", "dài ngắn", "chéo thẳng", "slice", "cắt cầu"],
    content:
      "Không được suy ra tốc độ cầu theo km/h, quỹ đạo, điểm rơi, dài/ngắn, thẳng/chéo hoặc slice chỉ từ pose. Các kết luận này cần quan sát quả cầu, xác định thời điểm chạm và hiệu chuẩn không gian; bản Vercel Hobby hiện chưa thu các tín hiệu đó.",
    source: { title: "Phạm vi đo của SmashLab Pose Lite", publisher: "SmashLab" },
  },
  {
    id: "bwf-hitting-cycle",
    title: "Chu trình thực hiện một cú đánh",
    category: "technique",
    tags: ["chuẩn bị", "kéo vợt", "vung vợt", "chạm cầu", "theo đà", "hồi vị", "kỹ thuật"],
    content:
      "Tài liệu huấn luyện BWF chia việc dạy một cú đánh thành chuẩn bị, kéo vợt, vung tới và chạm cầu, theo đà, rồi hồi vị. Khi góp ý từ pose nên xem cả chuỗi chuyển động và khả năng trở lại tư thế cân bằng, thay vì chỉ nhìn một góc khớp ở một khung hình.",
    source: {
      title: "BWF Coach Education — Coaches’ Manual Level 1",
      publisher: "Badminton World Federation",
      url: "https://bwf.worldacademysport.com/?academy=9",
    },
  },
  {
    id: "overhead-stroke-family",
    title: "Smash, drop và clear là nhóm cú đánh trên đầu",
    category: "technique",
    tags: ["smash", "đập cầu", "drop", "drop shot", "bỏ nhỏ", "clear", "phông cầu", "trên đầu"],
    content:
      "Smash, drop và clear đều có thể bắt đầu bằng động tác trên đầu khá giống nhau. Pose có thể cho biết mức chuẩn bị, tốc độ vung và tư thế, nhưng đường bay sau chạm mới là tín hiệu quan trọng để tách chắc chắn ba loại cú đánh. Vì vậy Drop và Clear của Pose Lite chỉ nên được xem là ứng viên.",
    source: {
      title: "BST: Badminton Stroke-type Transformer",
      publisher: "CVPR Workshops / arXiv",
      url: "https://arxiv.org/abs/2502.21085",
    },
  },
  {
    id: "smash-coaching-cues",
    title: "Gợi ý kỹ thuật smash từ dữ liệu pose",
    category: "technique",
    tags: ["smash", "đập cầu", "vai", "khuỷu", "cổ tay", "xoay thân", "tiếp xúc cao", "hồi vị"],
    content:
      "Với smash, phản hồi từ pose nên tập trung vào chuẩn bị sớm, phối hợp xoay thân với chuyển động vai–khuỷu–cẳng tay, vươn cao trong vùng tiếp xúc và giữ thăng bằng để hồi vị. Cường độ vung cao không tự chứng minh đó là smash; cần tránh khẳng định chất lượng tiếp xúc khi không nhìn thấy cầu và vợt.",
    source: {
      title: "BWF Coach Education — Coaches’ Manual Level 1",
      publisher: "Badminton World Federation",
      url: "https://bwf.worldacademysport.com/?academy=9",
    },
  },
  {
    id: "drive-coaching-cues",
    title: "Gợi ý kỹ thuật drive/tạt cầu",
    category: "technique",
    tags: ["drive", "tạt cầu", "phản tạt", "tiếp xúc thấp", "vung ngắn", "trước thân"],
    content:
      "Drive thường gắn với đường cầu nhanh và tương đối phẳng. Pose có thể nhận ra một chuyển động vung gọn ở vùng thấp hơn cú trên đầu, nhưng không thể xác nhận đường cầu phẳng nếu không theo dõi quả cầu. Hãy diễn đạt nhãn Drive là có khả năng và ưu tiên góp ý về tư thế, sự gọn của động tác và hồi vị.",
    source: {
      title: "BWF Coach Education — Coaches’ Manual Level 1",
      publisher: "Badminton World Federation",
      url: "https://bwf.worldacademysport.com/?academy=9",
    },
  },
  {
    id: "tracknetv3-scope",
    title: "TrackNetV3 theo dõi cầu, không phân loại kỹ thuật",
    category: "measurement",
    tags: ["tracknet", "tracknetv3", "quả cầu", "tracking", "quỹ đạo", "model", "phân loại"],
    content:
      "TrackNetV3 được thiết kế để định vị quả cầu trong video cầu lông phát sóng và sửa đoạn quỹ đạo bị che khuất. Nó cung cấp tín hiệu quỹ đạo nhưng không tự phân loại smash, drop, clear hoặc drive; phân loại kỹ thuật cần thêm mô hình hoặc luật sử dụng pose, quỹ đạo và bối cảnh sân.",
    source: {
      title: "TrackNetV3: Enhancing ShuttleCock Tracking",
      publisher: "ACM Multimedia Asia 2023",
      url: "https://github.com/qaz812345/TrackNetV3",
    },
  },
  {
    id: "shuttleset-tactical-data",
    title: "Dữ liệu cần cho phân tích rally và chiến thuật",
    category: "tactics",
    tags: ["rally", "chiến thuật", "shuttleset", "18 loại", "vị trí", "chuỗi cú đánh", "điểm đánh"],
    content:
      "ShuttleSet lưu chuỗi cú đánh được con người gắn nhãn cùng loại cú đánh, vị trí đánh và vị trí hai người chơi. Đây là cấu trúc phù hợp để nghiên cứu chiến thuật rally. Một danh sách nhãn suy đoán chỉ từ pose, không có quỹ đạo cầu và điểm đến, chưa đủ để kết luận mẫu điều cầu hoặc chiến thuật thắng rally.",
    source: {
      title: "ShuttleSet: A Human-Annotated Stroke-Level Singles Dataset",
      publisher: "arXiv",
      url: "https://arxiv.org/abs/2306.04948",
    },
  },
  {
    id: "recording-quality",
    title: "Cách quay để Pose Lite ổn định hơn",
    category: "system",
    tags: ["quay video", "camera", "điện thoại", "youtube", "ánh sáng", "góc quay", "toàn thân", "ổn định"],
    content:
      "Để phân tích pose ổn định hơn, camera nên cố định, khung hình nhìn trọn người chơi, ánh sáng đủ và hạn chế vật che. Quay lại màn hình YouTube làm giảm chi tiết và có thể tạo phản sáng hoặc nhòe chuyển động. Cải thiện góc quay giúp pose tốt hơn nhưng không bổ sung khả năng theo dõi quả cầu cho bản Lite.",
    source: { title: "Hướng dẫn ghi hình Pose Lite", publisher: "SmashLab" },
  },
];
