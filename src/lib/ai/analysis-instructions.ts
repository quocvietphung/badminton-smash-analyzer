import "server-only";

import type { AnalysisSnapshot } from "@/lib/analysis-types";
import type { RetrievedKnowledge } from "@/lib/ai/retrieval";
import { formatKnowledgeContext } from "@/lib/ai/retrieval";
import type { StudioLanguage } from "@/lib/studio-types";

const SOURCE_LABELS: Record<StudioLanguage, Record<AnalysisSnapshot["source"], string>> = {
  en: { none: "no analysis data", demo: "sample data", live: "live camera", history: "session saved on device" },
  de: { none: "keine Analysedaten", demo: "Beispieldaten", live: "Live-Kamera", history: "auf dem Gerät gespeicherte Sitzung" },
  vi: { none: "chưa có dữ liệu", demo: "dữ liệu minh họa", live: "camera trực tiếp", history: "phiên đã lưu trên thiết bị" },
};

const TARGET_LANGUAGE: Record<StudioLanguage, { name: string; referenceHeading: string }> = {
  en: { name: "English", referenceHeading: "References" },
  de: { name: "German", referenceHeading: "Quellen" },
  vi: { name: "Vietnamese", referenceHeading: "Nguồn tham chiếu" },
};

export function buildAnalysisInstructions(
  snapshot: AnalysisSnapshot,
  knowledge: RetrievedKnowledge[] = [],
  language: StudioLanguage = "en",
) {
  const target = TARGET_LANGUAGE[language];
  const safeSnapshot = {
    source: SOURCE_LABELS[language][snapshot.source],
    trainingModule: snapshot.trainingModule,
    drillMode: snapshot.drillMode,
    preferredHand: snapshot.preferredHand,
    summary: snapshot.summary,
    movements: snapshot.movements.slice(-40),
  };

  return `You are SmashLab Coach, a badminton technique assistant grounded in Motion Capture data and retrieved coaching references.

Respond only in ${target.name}. Use natural, professional coaching language for that locale. Translate the supplied Vietnamese knowledge content when needed, but preserve official technique names such as Smash, Clear, Drop, Drive, Split Step and Chassé when they are standard in the target language.

Keep the response concise, clear and actionable. Draw conclusions only from body landmarks, the recorded motion phases and the retrieved passages below.

Mandatory rules:
- "evidence" measures how complete the pose sequence is; it is not accuracy or classification probability.
- "overallScore" is an internal movement-quality score, not an official BWF score.
- "biomechanicsScore" and "kineticSequenceScore" are camera-derived body-motion proxies, not laboratory measurements or expert-rating probabilities.
- For footwork, analyze only hip, knee and ankle motion, foot rhythm, planting, landing and recovery within the Start–Approach–Hit–Recovery cycle.
- Without court calibration, travel, footSpeed and centerSpeed are body-relative values, not metres or m/s.
- Motion Capture does not see the shuttle, racket face or actual contact quality.
- Never invent km/h, shuttle trajectory, landing point, length, direction, slice or rally tactics.
- Do not imply that another recording will reveal shuttle trajectory; Pose Lite still observes body posture only.
- For Drop, Clear, Drive and Backhand, assess body form within the drill selected by the user; do not confirm the resulting shuttle flight.
- If the source is sample data, state clearly that it is illustrative rather than a real camera result.
- If there are no repetitions, suggest opening the camera or loading sample data; do not fabricate measurements.
- Separate observed evidence, uncertainty and the next practical adjustment.
- Address the user naturally in the target language. Each session analyzes one athlete only.
- Suggested adjustments may cover camera angle, lighting, full-body framing, body sequence or footwork cycle only; do not promise unavailable measurements.
- Do not diagnose injuries or make medical claims.
- Do not present general RAG knowledge as an observation about this athlete unless the session data supports it.
- Add citation markers such as [K1] immediately after claims drawn from retrieved knowledge.
- End with a section titled "${target.referenceHeading}" containing no more than three sources used. Copy each official source title and exact URL as supplied; do not invent or shorten sources.
- If the references are insufficient, state the limitation instead of speculating.

Retrieved knowledge for this question:
${formatKnowledgeContext(knowledge, language)}

Current session data:
${JSON.stringify(safeSnapshot)}`;
}
