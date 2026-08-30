export type KnowledgeSource = {
  title: string;
  publisher: string;
  url?: string;
};

export type KnowledgeChunk = {
  id: string;
  title: string;
  category: "system" | "technique" | "measurement" | "motion";
  tags: string[];
  content: string;
  source: KnowledgeSource;
};

export const BADMINTON_KNOWLEDGE: KnowledgeChunk[] = [
  {
    id: "motion-evidence",
    title: "Motion Capture quan sát được gì",
    category: "system",
    tags: ["motion capture", "pose", "bằng chứng", "điểm chuyển động", "accuracy", "camera"],
    content:
      "SmashLab quan sát chuỗi mốc cơ thể, góc khớp, nhịp tăng tốc, độ duỗi và khả năng trở lại cân bằng. Evidence là mức đủ dữ liệu của chuỗi pose; overallScore là điểm nội bộ theo tiêu chí chuyển động. Cả hai đều không phải accuracy hay điểm chính thức của BWF.",
    source: { title: "Phạm vi đo của SmashLab Motion Capture", publisher: "SmashLab" },
  },
  {
    id: "motion-limitations",
    title: "Giới hạn khi không theo dõi vợt và quả cầu",
    category: "measurement",
    tags: ["quả cầu", "vợt", "km h", "tiếp xúc", "quỹ đạo", "điểm rơi", "giới hạn"],
    content:
      "Mốc cơ thể không cho biết chính xác mặt vợt, thời điểm vợt chạm cầu, tốc độ cầu, quỹ đạo hoặc điểm rơi. Vì vậy hệ thống chỉ chấm hình thái chuyển động; Clear, Drop, Drive và Backhand được đánh giá theo bài tập người dùng đã chọn, không xác nhận kết quả đường cầu.",
    source: { title: "Phạm vi đo của SmashLab Motion Capture", publisher: "SmashLab" },
  },
  {
    id: "bwf-hitting-cycle",
    title: "Chu trình sáu pha của một lần lặp",
    category: "motion",
    tags: ["sẵn sàng", "chuẩn bị", "kéo vợt", "tăng tốc", "tiếp xúc", "theo đà", "hồi vị", "6 pha"],
    content:
      "Tài liệu huấn luyện BWF tổ chức việc dạy cú đánh quanh các phần chuẩn bị, kéo vợt, vung tới và chạm cầu, theo đà rồi hồi vị. Phản hồi nên xem toàn bộ chuỗi và khả năng trở lại tư thế cân bằng, thay vì kết luận từ một khung hình hoặc một góc khớp riêng lẻ.",
    source: {
      title: "BWF Coach Education — Coaches’ Manual Level 1",
      publisher: "Badminton World Federation",
      url: "https://bwf.worldacademysport.com/?academy=9",
    },
  },
  {
    id: "smash-motion",
    title: "Dấu hiệu kỹ thuật của chuyển động smash",
    category: "technique",
    tags: ["smash", "đập cầu", "khuỷu", "vai", "xoay thân", "gập gối", "vươn cao", "hồi vị"],
    content:
      "Với smash, phản hồi từ pose nên tập trung vào chuẩn bị sớm, tạo tải từ chân và thân, phối hợp xoay thân với vai–khuỷu–cẳng tay, vươn cao trong vùng tiếp xúc, theo đà tự nhiên và giữ thăng bằng để hồi vị. Cường độ tay cao một mình không chứng minh kỹ thuật tốt.",
    source: {
      title: "BWF Coach Education — Coaches’ Manual Level 1",
      publisher: "Badminton World Federation",
      url: "https://bwf.worldacademysport.com/?academy=9",
    },
  },
  {
    id: "backhand-motion",
    title: "Dấu hiệu kỹ thuật của chuyển động backhand",
    category: "technique",
    tags: ["backhand", "trái tay", "khuỷu", "cẳng tay", "trước thân", "động tác gọn"],
    content:
      "Khi chấm backhand từ pose, nên quan sát việc đưa khuỷu vào vị trí sớm, động tác cẳng tay gọn, vùng đánh ở trước hoặc bên thân phù hợp với bài tập, phối hợp xoay thân vừa đủ và hồi vị cân bằng. Không nên suy ra hướng mặt vợt hoặc chất lượng tiếp xúc khi camera chỉ thấy mốc cơ thể.",
    source: {
      title: "BWF Coach Education — Coaches’ Manual Level 1",
      publisher: "Badminton World Federation",
      url: "https://bwf.worldacademysport.com/?academy=9",
    },
  },
  {
    id: "overhead-family",
    title: "Clear, Drop và Smash có động tác chuẩn bị gần nhau",
    category: "technique",
    tags: ["clear", "drop", "smash", "overhead", "trên đầu", "động tác giả"],
    content:
      "Clear, Drop và Smash có thể dùng phần chuẩn bị trên đầu khá giống nhau. Pose giúp so sánh vùng tiếp xúc, độ duỗi, nhịp tăng tốc và hồi vị, nhưng không thể tách chắc chắn kết quả cú đánh nếu không quan sát vợt và quỹ đạo cầu. Chọn trước bài tập là cách phù hợp để chấm hình thái kỹ thuật.",
    source: {
      title: "BST: Badminton Stroke-type Transformer",
      publisher: "CVPR Workshops / arXiv",
      url: "https://arxiv.org/abs/2502.21085",
    },
  },
  {
    id: "recording-quality",
    title: "Góc quay phù hợp cho Motion Capture",
    category: "system",
    tags: ["camera", "điện thoại", "góc quay", "toàn thân", "ánh sáng", "che khuất", "khung hình"],
    content:
      "Để mốc cơ thể ổn định, nên đặt camera cố định khoảng ngang hông, cách người tập đủ để thấy trọn đầu, hai tay và hai chân. Góc chéo nhẹ giúp quan sát xoay thân; ánh sáng đều và nền ít người qua lại giúp giảm mất mốc. Nên phân tích một người mỗi set.",
    source: {
      title: "MediaPipe Pose Landmarker Guide",
      publisher: "Google AI Edge",
      url: "https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker",
    },
  },
  {
    id: "bwf-movement-cycle",
    title: "Chu kỳ bộ pháp Start–Approach–Hit–Recovery",
    category: "motion",
    tags: ["footwork", "bộ pháp", "start", "approach", "hit", "recovery", "hồi vị", "chu kỳ"],
    content:
      "BWF Coach Education tổ chức chuyển động cầu lông thành bốn phần: Start để phản ứng và xuất phát, Approach để tiếp cận điểm đánh, Hit là hình thái cơ thể khi đánh, và Recovery để di chuyển về trạng thái sẵn sàng cho tình huống tiếp theo. Khi chấm bộ pháp nên xem đủ cả chu kỳ thay vì chỉ đo tốc độ chân.",
    source: {
      title: "BWF Coach Education — Coaches’ Manual Level 1, Module 6: Technical Movement Skills",
      publisher: "Badminton World Federation",
      url: "https://bwf.worldacademysport.com/?academy=9",
    },
  },
  {
    id: "bwf-footwork-components",
    title: "Các thành phần bộ pháp nền tảng",
    category: "technique",
    tags: ["split step", "running step", "chasse", "cross behind", "hop", "pivot", "lunge", "jump", "landing", "bộ pháp"],
    content:
      "BWF liệt kê các thành phần chuyển động lặp lại gồm split step, running steps, chassé, cross-behind, hop/pivot, lunge, jump và landing. Các thành phần có thể tập riêng, sau đó nối thành chu kỳ di chuyển hoàn chỉnh. Một nhãn tự động từ pose chỉ mô tả hình thái gần nhất và cần được đối chiếu với bài tập đã chọn.",
    source: {
      title: "BWF Coach Education — Coaches’ Manual Level 1, Module 6: Technical Movement Skills",
      publisher: "Badminton World Federation",
      url: "https://bwf.worldacademysport.com/?academy=9",
    },
  },
  {
    id: "split-step-lunge",
    title: "Split step, chassé và lunge",
    category: "technique",
    tags: ["split step", "bước tách", "chasse", "bước đuổi", "lunge", "bước chùng", "gối", "thăng bằng"],
    content:
      "Split step là bước bật nông với chân mở rộng và gối gập khi tiếp đất để sẵn sàng đẩy đi. Chassé là một chân đuổi chân kia mà không bắt chéo. Lunge cần phạm vi bước phù hợp, kiểm soát gối và khả năng đẩy trở lại. Phản hồi từ pose nên ưu tiên tải gối, độ rộng trụ, nhịp tiếp cận, thăng bằng và hồi vị.",
    source: {
      title: "BWF Coach Education — Coaches’ Manual Level 1, Module 6: Technical Movement Skills",
      publisher: "Badminton World Federation",
      url: "https://bwf.worldacademysport.com/?academy=9",
    },
  },
  {
    id: "footwork-measurement-limit",
    title: "Giới hạn đo bộ pháp bằng một camera",
    category: "measurement",
    tags: ["footwork", "camera", "đơn vị tương đối", "khoảng cách", "tốc độ chân", "tiếp đất", "giới hạn"],
    content:
      "Một camera pose có thể so sánh tương đối vị trí hông, gối, cổ chân, nhịp chân và cân bằng. Nếu không hiệu chuẩn mặt phẳng sân, hệ thống không được đổi chuyển động ảnh thành mét hoặc m/s và không biết VĐV phản ứng đúng thời điểm với quả cầu. Góc quay phải thấy rõ cả hai bàn chân và nên giữ cố định giữa các set.",
    source: {
      title: "MediaPipe Pose Landmarker Guide",
      publisher: "Google AI Edge",
      url: "https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker",
    },
  },
];
