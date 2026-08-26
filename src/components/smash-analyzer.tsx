"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import {
  analyzePose,
  initialMetrics,
  type PoseFrameMemory,
  type PoseLandmark,
  type SmashMetrics,
  type SmashPhase,
} from "@/lib/pose-metrics";
import styles from "./smash-analyzer.module.css";

type AnalyzerStatus = "idle" | "loading" | "live" | "error";
type BackendStatus = "checking" | "online" | "offline";
type StrokeType = "smash" | "drop_shot" | "slice" | "drive" | "clear";

type BackendAnalysis = {
  strokeType: StrokeType | "motion";
  strokeLabel: string;
  confidence: number;
  estimatedShuttleSpeedKmh: number | null;
  speedStatus: "calibration_required";
};

type StrokeEvent = {
  id: number;
  label: string;
  score: number;
  wristSpeed: number;
  elbowAngle: number;
  time: string;
};

const STROKE_TYPES: Array<{
  type: StrokeType;
  label: string;
  shortLabel: string;
}> = [
  { type: "smash", label: "Smash", shortLabel: "SM" },
  { type: "drop_shot", label: "Bỏ nhỏ", shortLabel: "BN" },
  { type: "slice", label: "Cắt / chặt", shortLabel: "CC" },
  { type: "drive", label: "Tạt cầu", shortLabel: "TC" },
  { type: "clear", label: "Phông cầu", shortLabel: "PC" },
];

const INITIAL_STROKE_COUNTS: Record<StrokeType, number> = {
  smash: 0,
  drop_shot: 0,
  slice: 0,
  drive: 0,
  clear: 0,
};

function isStrokeType(value: string): value is StrokeType {
  return STROKE_TYPES.some((stroke) => stroke.type === value);
}

type Connection = { start: number; end: number };

const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

async function analyzeWithBackend(metrics: SmashMetrics): Promise<BackendAnalysis> {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wristSpeed: metrics.wristSpeed,
      elbowAngle: metrics.elbowAngle,
      shoulderAngle: metrics.shoulderAngle,
      contactHeight: metrics.contactHeight,
      isContact: metrics.isContact,
    }),
  });

  if (!response.ok) throw new Error("Backend analysis failed");
  return response.json() as Promise<BackendAnalysis>;
}

const PHASE_LABEL: Record<SmashPhase, string> = {
  READY: "Sẵn sàng",
  PREPARATION: "Chuẩn bị",
  LOADING: "Kéo vợt",
  ACCELERATION: "Tăng tốc",
  CONTACT: "Chạm cầu",
  FOLLOW_THROUGH: "Theo đà",
};

const KEY_LANDMARKS = new Set([11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]);

function drawPose(
  canvas: HTMLCanvasElement,
  landmarks: PoseLandmark[],
  connections: Connection[],
) {
  const context = canvas.getContext("2d");
  if (!context) return;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "rgba(92, 255, 202, 0.9)";
  context.lineWidth = Math.max(2, canvas.width / 380);
  context.shadowColor = "rgba(44, 255, 184, 0.55)";
  context.shadowBlur = 10;

  for (const connection of connections) {
    const start = landmarks[connection.start];
    const end = landmarks[connection.end];
    if (!start || !end || (start.visibility ?? 1) < 0.45 || (end.visibility ?? 1) < 0.45) {
      continue;
    }
    context.beginPath();
    context.moveTo(start.x * canvas.width, start.y * canvas.height);
    context.lineTo(end.x * canvas.width, end.y * canvas.height);
    context.stroke();
  }

  context.shadowBlur = 0;
  for (const [index, landmark] of landmarks.entries()) {
    if (!KEY_LANDMARKS.has(index) || (landmark.visibility ?? 1) < 0.45) continue;
    const x = landmark.x * canvas.width;
    const y = landmark.y * canvas.height;
    context.beginPath();
    context.fillStyle = index === 15 || index === 16 ? "#ffcf5c" : "#effff9";
    context.arc(x, y, index === 15 || index === 16 ? 7 : 5, 0, Math.PI * 2);
    context.fill();
  }
}

function MetricCard({
  label,
  value,
  unit,
  accent = false,
}: {
  label: string;
  value: string;
  unit: string;
  accent?: boolean;
}) {
  return (
    <article className={`${styles.metricCard} ${accent ? styles.metricAccent : ""}`}>
      <span>{label}</span>
      <strong>
        {value}<small>{unit}</small>
      </strong>
      <div className={styles.metricSpark} aria-hidden="true">
        <i /><i /><i /><i /><i /><i />
      </div>
    </article>
  );
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15.5 8.5 20 6v12l-4.5-2.5M4 6h11v12H4z" />
    </svg>
  );
}

export default function SmashAnalyzer() {
  const [status, setStatus] = useState<AnalyzerStatus>("idle");
  const [metrics, setMetrics] = useState<SmashMetrics>(initialMetrics);
  const [strokeCount, setStrokeCount] = useState(0);
  const [events, setEvents] = useState<StrokeEvent[]>([]);
  const [strokeCounts, setStrokeCounts] = useState(INITIAL_STROKE_COUNTS);
  const [activeStroke, setActiveStroke] = useState<StrokeType | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [cameraFacing, setCameraFacing] = useState<"user" | "environment">("environment");
  const [backendStatus, setBackendStatus] = useState<BackendStatus>("checking");

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const landmarkerRef = useRef<PoseLandmarker | null>(null);
  const connectionsRef = useRef<Connection[]>([]);
  const animationRef = useRef<number | null>(null);
  const memoryRef = useRef<PoseFrameMemory | null>(null);
  const lastVideoTimeRef = useRef(-1);
  const lastUiUpdateRef = useRef(0);
  const lastContactAtRef = useRef(-10_000);
  const runningRef = useRef(false);

  const stopCamera = useCallback(() => {
    runningRef.current = false;
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    landmarkerRef.current?.close();
    landmarkerRef.current = null;
    memoryRef.current = null;
    lastVideoTimeRef.current = -1;
    const context = canvasRef.current?.getContext("2d");
    if (canvasRef.current && context) {
      context.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }
    setMetrics(initialMetrics);
    setStatus("idle");
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/health", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Backend unavailable");
        setBackendStatus("online");
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setBackendStatus("offline");
        }
      });

    return () => controller.abort();
  }, []);

  const startDetectionLoop = useCallback(() => {
    function detectFrame() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const landmarker = landmarkerRef.current;

      if (!runningRef.current || !video || !canvas || !landmarker) return;

      if (
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.currentTime !== lastVideoTimeRef.current
      ) {
        lastVideoTimeRef.current = video.currentTime;
        const now = performance.now();
        const result = landmarker.detectForVideo(video, now);
        const landmarks = result.landmarks[0] as PoseLandmark[] | undefined;

        if (landmarks) {
          drawPose(canvas, landmarks, connectionsRef.current);
          const analysis = analyzePose(
            landmarks,
            now,
            memoryRef.current,
            lastContactAtRef.current,
          );
          memoryRef.current = analysis.memory;

          const newStroke =
            analysis.metrics.isContact && now - lastContactAtRef.current > 1_100;
          if (newStroke) {
            lastContactAtRef.current = now;
            const eventId = Date.now();
            const strokeEvent: StrokeEvent = {
              id: eventId,
              label: "Đang phân tích…",
              score: Math.round(analysis.metrics.score),
              wristSpeed: analysis.metrics.wristSpeed,
              elbowAngle: analysis.metrics.elbowAngle,
              time: new Date().toLocaleTimeString("vi-VN", {
                minute: "2-digit",
                second: "2-digit",
              }),
            };
            setStrokeCount((count) => count + 1);
            setEvents((current) => [strokeEvent, ...current].slice(0, 3));

            void analyzeWithBackend(analysis.metrics)
              .then((backendAnalysis) => {
                setBackendStatus("online");
                const strokeType = backendAnalysis.strokeType;
                if (isStrokeType(strokeType)) {
                  setActiveStroke(strokeType);
                  setStrokeCounts((current) => ({
                    ...current,
                    [strokeType]: current[strokeType] + 1,
                  }));
                }
                setEvents((current) => current.map((event) =>
                  event.id === eventId
                    ? { ...event, label: backendAnalysis.strokeLabel }
                    : event,
                ));
              })
              .catch(() => {
                setBackendStatus("offline");
                setEvents((current) => current.map((event) =>
                  event.id === eventId ? { ...event, label: "Smash" } : event,
                ));
              });
          }

          if (now - lastUiUpdateRef.current > 90 || newStroke) {
            lastUiUpdateRef.current = now;
            setMetrics({
              ...analysis.metrics,
              phase: newStroke ? "CONTACT" : analysis.metrics.phase,
            });
          }
        } else {
          const context = canvas.getContext("2d");
          context?.clearRect(0, 0, canvas.width, canvas.height);
        }
      }

      animationRef.current = requestAnimationFrame(detectFrame);
    }

    detectFrame();
  }, []);

  const startCamera = useCallback(async (requestedFacing?: "user" | "environment") => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      setErrorMessage("Trình duyệt này không hỗ trợ camera trực tiếp.");
      return;
    }

    setStatus("loading");
    setErrorMessage("");

    try {
      const [{ FilesetResolver, PoseLandmarker }, stream] = await Promise.all([
        import("@mediapipe/tasks-vision"),
        navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: requestedFacing ?? cameraFacing },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 60, min: 30 },
          },
        }),
      ]);

      streamRef.current = stream;
      const vision = await FilesetResolver.forVisionTasks(WASM_URL);
      let landmarker: PoseLandmarker;

      try {
        landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.55,
          minPosePresenceConfidence: 0.55,
          minTrackingConfidence: 0.55,
        });
      } catch {
        landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.55,
          minPosePresenceConfidence: 0.55,
          minTrackingConfidence: 0.55,
        });
      }

      landmarkerRef.current = landmarker;
      connectionsRef.current = PoseLandmarker.POSE_CONNECTIONS;

      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) throw new Error("Không tìm thấy khung camera.");

      video.srcObject = stream;
      await video.play();
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      runningRef.current = true;
      setStatus("live");
      startDetectionLoop();
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
      setStatus("error");
      setErrorMessage(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Bạn cần cho phép truy cập camera để bắt đầu phân tích."
          : "Không thể khởi động camera hoặc tải mô hình nhận diện. Hãy kiểm tra kết nối mạng.",
      );
    }
  }, [cameraFacing, startDetectionLoop]);

  const switchCamera = async () => {
    const nextFacing = cameraFacing === "environment" ? "user" : "environment";
    const shouldRestart = status === "live";
    stopCamera();
    setCameraFacing(nextFacing);
    if (shouldRestart) await startCamera(nextFacing);
  };

  const score = Math.round(metrics.score);
  const poseDetected = status === "live" && metrics.confidence > 45;

  return (
    <section className={styles.analyzer} aria-label="Trình phân tích smash trực tiếp">
      <div className={styles.videoColumn}>
        <div className={`${styles.videoStage} ${metrics.phase === "CONTACT" ? styles.contactFlash : ""}`}>
          <video
            ref={videoRef}
            className={styles.video}
            muted
            playsInline
            aria-label="Hình ảnh trực tiếp từ camera"
          />
          <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
          <div className={styles.courtGrid} aria-hidden="true" />

          <div className={styles.videoTopbar}>
            <span className={`${styles.livePill} ${status === "live" ? styles.isLive : ""}`}>
              <i /> {status === "live" ? "LIVE" : "OFFLINE"}
            </span>
            <span className={styles.poseStatus}>
              <i className={poseDetected ? styles.detected : ""} />
              {poseDetected ? `Vận động viên · ${Math.round(metrics.confidence)}%` : "Đang chờ vận động viên"}
            </span>
          </div>

          {status !== "live" ? (
            <div className={styles.cameraPrompt}>
              <div className={styles.cameraIcon}><CameraIcon /></div>
              <h2>Phân tích smash trực tiếp</h2>
              <p>Đặt toàn thân trong khung hình, cách camera khoảng 3–5 mét.</p>
              <button type="button" onClick={() => startCamera()} disabled={status === "loading"}>
                {status === "loading" ? <span className={styles.spinner} /> : <CameraIcon />}
                {status === "loading" ? "Đang tải mô hình…" : "Bật camera"}
              </button>
              {status === "error" ? <p className={styles.errorText}>{errorMessage}</p> : null}
            </div>
          ) : null}

          <div className={styles.phaseOverlay}>
            <span>Pha chuyển động</span>
            <strong>{PHASE_LABEL[metrics.phase]}</strong>
          </div>

          <div className={styles.videoControls}>
            <button
              type="button"
              onClick={status === "live" ? stopCamera : () => startCamera()}
            >
              {status === "live" ? "Dừng phân tích" : "Bắt đầu"}
            </button>
            <button type="button" className={styles.secondaryButton} onClick={switchCamera}>
              Đổi camera
            </button>
          </div>
        </div>

        <div className={styles.phaseTrack}>
          {(Object.keys(PHASE_LABEL) as SmashPhase[])
            .filter((phase) => phase !== "READY")
            .map((phase, index) => (
              <div
                key={phase}
                className={`${styles.phaseStep} ${metrics.phase === phase ? styles.activePhase : ""}`}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{PHASE_LABEL[phase]}</strong>
              </div>
            ))}
        </div>
      </div>

      <aside className={styles.dashboard}>
        <div className={styles.backendStatus} role="status">
          <i className={backendStatus === "online" ? styles.backendOnline : ""} />
          Python backend · {backendStatus === "checking" ? "đang kiểm tra" : backendStatus === "online" ? "online" : "offline"}
        </div>

        <section className={styles.skillPanel} aria-labelledby="skill-panel-title">
          <div className={styles.skillHeader}>
            <div>
              <span id="skill-panel-title">Phân loại kỹ năng</span>
              <strong>
                {activeStroke
                  ? STROKE_TYPES.find((stroke) => stroke.type === activeStroke)?.label
                  : "Đang chờ cú đánh"}
              </strong>
            </div>
            <small>AI pose · beta</small>
          </div>
          <div className={styles.skillGrid}>
            {STROKE_TYPES.map((stroke) => (
              <article
                key={stroke.type}
                className={activeStroke === stroke.type ? styles.activeSkill : ""}
              >
                <i>{stroke.shortLabel}</i>
                <span>{stroke.label}</span>
                <strong>{strokeCounts[stroke.type]}</strong>
              </article>
            ))}
          </div>
        </section>

        <div className={styles.scoreCard}>
          <div>
            <span>Điểm kỹ thuật trực tiếp</span>
            <p>Dựa trên tư thế và tốc độ tương đối</p>
          </div>
          <div
            className={styles.scoreRing}
            style={{ "--score": `${score * 3.6}deg` } as React.CSSProperties}
            aria-label={`Điểm kỹ thuật ${score} trên 100`}
          >
            <strong>{score}</strong><small>/100</small>
          </div>
        </div>

        <div className={styles.metricsGrid}>
          <MetricCard label="Góc khuỷu" value={Math.round(metrics.elbowAngle).toString()} unit="°" accent />
          <MetricCard label="Góc vai" value={Math.round(metrics.shoulderAngle).toString()} unit="°" />
          <MetricCard label="Tốc độ cổ tay" value={metrics.wristSpeed.toFixed(2)} unit=" rel/s" accent />
          <MetricCard label="Tốc độ duỗi tay" value={Math.round(metrics.armAngularSpeed).toString()} unit="°/s" />
          <MetricCard label="Gập gối" value={Math.round(metrics.kneeFlexion).toString()} unit="°" />
          <MetricCard label="Độ cao tiếp xúc" value={Math.round(metrics.contactHeight).toString()} unit="%" />
        </div>

        <div className={styles.sessionCard}>
          <div className={styles.sessionHeader}>
            <div>
              <span>Phiên tập hiện tại</span>
              <strong>{strokeCount} cú đánh</strong>
            </div>
            <span className={styles.sideBadge}>
              Tay {metrics.dominantSide === "right" ? "phải" : "trái"}
            </span>
          </div>

          <div className={styles.extensionBar}>
            <div><span>Độ duỗi cơ thể</span><strong>{Math.round(metrics.bodyExtension)}%</strong></div>
            <i><b style={{ width: `${metrics.bodyExtension}%` }} /></i>
          </div>

          <div className={styles.eventList}>
            {events.length ? events.map((event) => (
              <div key={event.id} className={styles.eventRow}>
                <span className={styles.eventDot} />
                <div><strong>{event.label} · {event.score} điểm</strong><span>{event.elbowAngle.toFixed(0)}° khuỷu · {event.wristSpeed.toFixed(2)} rel/s</span></div>
                <time>{event.time}</time>
              </div>
            )) : (
              <div className={styles.emptyEvents}>
                Các cú đánh được phát hiện sẽ xuất hiện tại đây.
              </div>
            )}
          </div>
        </div>

        <p className={styles.calibrationNote}>
          <span>i</span> Tốc độ đang là đơn vị tương đối. Cần hiệu chuẩn kích thước sân để đổi sang m/s hoặc km/h.
        </p>
      </aside>
    </section>
  );
}
