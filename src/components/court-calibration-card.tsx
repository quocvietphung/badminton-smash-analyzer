"use client";

// Court calibration, explained: the step that decided the result, the fit against its thresholds, what is missing
// without a calibration, and how a person calibrates by hand in the evidence viewer. Nothing here calibrates: the
// card only reads results.json.
import { AlertTriangle, CheckCircle2, Crosshair, Hand } from "lucide-react";
import { explainCourt, type CourtBlock, type CourtStage } from "@/lib/match/court-explanation";
import type { StudioLanguage } from "@/lib/studio-types";
import styles from "./court-calibration-card.module.css";

const COPY = {
  en: {
    status: { auto: "Calibrated automatically", manual: "Calibrated by hand", failed: "Not calibrated" },
    stage: {
      calibrated: "The template's lines matched the white court lines of the video.",
      manual: "A person set the four court corners. The corners are stored as a correction, apart from the AI output.",
      no_frames: "No full-resolution frames were available, so the court could not be searched.",
      no_floor: "No large floor area of one colour was found, so the court lines could not be searched. Typical for black-and-white or very dark footage.",
      no_lines: "Too few straight white court lines were found. Typical when several courts are visible, the players are small, or the lines are thin or worn.",
      no_quad: "White lines were found, but no four of them formed a plausible court outline.",
      below_threshold: "A court outline was fitted, but it matched the white lines too weakly to be used.",
      unknown: "The calibration stopped for a reason this studio does not know:",
    } satisfies Record<CourtStage, string>,
    checks: { score: "Line match score", coverage: "Outline coverage" },
    needs: (threshold: string) => `needs ≥ ${threshold}`,
    notReached: "not reached: the calibration stopped before a fit",
    effectCalibrated: "Distances are floor-plane metres (flat-floor approximation) and court zones are available. Estimated 3D still needs an independent 3D camera calibration.",
    effectFailed: "Without it, distances stay in image pixels, court zones and floor metres are unavailable, and Estimated 3D is rejected.",
    guideTitle: "Calibrate by hand",
    guide: [
      "Open the Evidence viewer below the video and choose Court calibration.",
      "Click the four outer corners of the doubles court on the original video: near-left, near-right, far-right, far-left.",
      "Save. The corners are stored as your correction, and the analysis is recomputed from its raw outputs without running a model.",
    ],
    guideNote: "Your corners never become an automatic result: the AI output stays as it was.",
    goToCalibration: "Go to court calibration",
  },
  vi: {
    status: { auto: "Đã hiệu chỉnh tự động", manual: "Đã hiệu chỉnh bằng tay", failed: "Chưa hiệu chỉnh" },
    stage: {
      calibrated: "Các đường của mẫu sân khớp với các vạch trắng của sân trong video.",
      manual: "Một người đã đặt bốn góc sân. Các góc được lưu như một chỉnh sửa, tách khỏi kết quả của AI.",
      no_frames: "Không có khung hình độ phân giải đầy đủ nên không thể tìm sân.",
      no_floor: "Không tìm thấy vùng sàn lớn cùng màu nên không thể tìm vạch sân. Thường gặp với video đen trắng hoặc rất tối.",
      no_lines: "Tìm được quá ít vạch trắng thẳng của sân. Thường gặp khi thấy nhiều sân cùng lúc, người chơi nhỏ, hoặc vạch mảnh hay mờ.",
      no_quad: "Có tìm thấy vạch trắng, nhưng không có bốn vạch nào tạo thành khung sân hợp lý.",
      below_threshold: "Đã khớp được một khung sân, nhưng khớp với vạch trắng quá yếu để dùng.",
      unknown: "Hiệu chỉnh dừng vì một lý do studio này chưa biết:",
    } satisfies Record<CourtStage, string>,
    checks: { score: "Điểm khớp vạch", coverage: "Độ phủ khung sân" },
    needs: (threshold: string) => `cần ≥ ${threshold}`,
    notReached: "chưa tới bước này: hiệu chỉnh dừng trước khi khớp khung",
    effectCalibrated: "Quãng đường tính bằng mét trên mặt sân (xấp xỉ sàn phẳng) và có vùng sân. 3D ước lượng vẫn cần hiệu chỉnh camera 3D độc lập.",
    effectFailed: "Khi chưa hiệu chỉnh, quãng đường vẫn tính bằng pixel trong ảnh, không có vùng sân và mét trên mặt sân, và 3D ước lượng bị loại.",
    guideTitle: "Hiệu chỉnh bằng tay",
    guide: [
      "Mở Trình xem bằng chứng bên dưới video và chọn Hiệu chỉnh sân.",
      "Bấm bốn góc ngoài của sân đôi trên video gốc: trái gần, phải gần, phải xa, trái xa.",
      "Lưu lại. Các góc được lưu như chỉnh sửa của bạn, và phân tích được tính lại từ dữ liệu thô mà không chạy lại mô hình.",
    ],
    guideNote: "Các góc bạn đặt không bao giờ trở thành kết quả tự động: kết quả của AI vẫn giữ nguyên.",
    goToCalibration: "Đến phần hiệu chỉnh sân",
  },
  de: {
    status: { auto: "Automatisch kalibriert", manual: "Von Hand kalibriert", failed: "Nicht kalibriert" },
    stage: {
      calibrated: "Die Linien der Vorlage passen zu den weißen Feldlinien im Video.",
      manual: "Eine Person hat die vier Feldecken gesetzt. Die Ecken sind als Korrektur gespeichert, getrennt vom KI-Ergebnis.",
      no_frames: "Es gab keine Frames in voller Auflösung, daher konnte das Feld nicht gesucht werden.",
      no_floor: "Es wurde keine große einfarbige Bodenfläche gefunden, daher konnten die Feldlinien nicht gesucht werden. Typisch für Schwarzweiß- oder sehr dunkle Aufnahmen.",
      no_lines: "Es wurden zu wenige gerade weiße Feldlinien gefunden. Typisch, wenn mehrere Felder sichtbar sind, die Spieler klein sind oder die Linien dünn oder abgenutzt sind.",
      no_quad: "Weiße Linien wurden gefunden, aber keine vier davon bilden einen plausiblen Feldumriss.",
      below_threshold: "Ein Feldumriss wurde angepasst, passt aber zu schwach zu den weißen Linien, um ihn zu verwenden.",
      unknown: "Die Kalibrierung wurde aus einem Grund beendet, den dieses Studio nicht kennt:",
    } satisfies Record<CourtStage, string>,
    checks: { score: "Linien-Passungswert", coverage: "Umriss-Abdeckung" },
    needs: (threshold: string) => `benötigt ≥ ${threshold}`,
    notReached: "nicht erreicht: die Kalibrierung endete vor einer Anpassung",
    effectCalibrated: "Distanzen sind Meter auf der Bodenebene (Näherung ebener Boden) und Feldzonen sind verfügbar. Geschätztes 3D braucht weiterhin eine unabhängige 3D-Kamerakalibrierung.",
    effectFailed: "Ohne sie bleiben Distanzen in Bildpixeln, Feldzonen und Bodenmeter sind nicht verfügbar, und Geschätztes 3D wird abgelehnt.",
    guideTitle: "Von Hand kalibrieren",
    guide: [
      "Öffne den Evidenz-Viewer unter dem Video und wähle Feldkalibrierung.",
      "Klicke die vier äußeren Ecken des Doppelfelds im Originalvideo an: nah links, nah rechts, fern rechts, fern links.",
      "Speichern. Die Ecken werden als deine Korrektur gespeichert, und die Analyse wird ohne Modelllauf aus ihren Rohdaten neu berechnet.",
    ],
    guideNote: "Deine Ecken werden nie zu einem automatischen Ergebnis: das KI-Ergebnis bleibt unverändert.",
    goToCalibration: "Zur Feldkalibrierung",
  },
} as const;

function fixed(value: number): string {
  return value.toFixed(2);
}

export default function CourtCalibrationCard({ court, template, language }: {
  court: CourtBlock | null | undefined;
  template?: string | null;
  language: StudioLanguage;
}) {
  const copy = COPY[language];
  const explanation = explainCourt(court);
  const status = explanation.calibrated ? (explanation.source === "manual" ? copy.status.manual : copy.status.auto) : copy.status.failed;
  return (
    <div className={styles.card}>
      <p className={explanation.calibrated ? styles.good : styles.warn}>
        {explanation.calibrated ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
        <strong>{status}</strong>
        {explanation.calibrated && template ? <span className={styles.template}>{template}</span> : null}
      </p>
      <p className={styles.stage}>
        {copy.stage[explanation.stage]}
        {explanation.stage === "unknown" && explanation.reason ? <> <q>{explanation.reason}</q></> : null}
      </p>
      {explanation.checks.length ? (
        <dl className={styles.checks}>
          {explanation.checks.map((check) => (
            <div key={check.id} className={check.passed === null ? styles.notReached : check.passed ? styles.passed : styles.failed}>
              <dt>{copy.checks[check.id]}</dt>
              <dd>
                {check.value === null ? copy.notReached : <><strong>{fixed(check.value)}</strong> · {copy.needs(fixed(check.threshold))}</>}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p className={styles.effect}>{explanation.calibrated ? copy.effectCalibrated : copy.effectFailed}</p>
      {!explanation.calibrated ? (
        <details className={styles.guide} open>
          <summary><Hand aria-hidden="true" />{copy.guideTitle}</summary>
          <ol>{copy.guide.map((step) => <li key={step}>{step}</li>)}</ol>
          <p>{copy.guideNote}</p>
          <a href="#court-calibration" className={styles.link}><Crosshair aria-hidden="true" />{copy.goToCalibration}</a>
        </details>
      ) : null}
    </div>
  );
}
