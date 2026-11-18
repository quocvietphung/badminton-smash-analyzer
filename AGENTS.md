# AGENTS.md — SmashLab (badminton-smash-analyzer)

Shared guidance for Codex and Claude Code. Both tools use this same checkout; do not copy it.

## Project

SmashLab is an offline badminton video analysis platform. A user analyses a match or training clip on their own machine. A local Docker FastAPI backend detects players (YOLOX) and tracks the shuttle (TrackNetV3), assigns logical player identities, and writes an annotated MP4 plus structured JSON evidence. The Next.js studio shows the results with timestamps and frame indices. Manual corrections are stored separately from raw AI output. The AI Coach answers only from these derived results. The live camera feature has been removed.

- Stack: Next.js 16, React 19, TypeScript, Python FastAPI backend (ONNX Runtime, OpenCV, NumPy), MediaPipe Tasks Vision (offline pose modules kept in the studio), Azure OpenAI (AI Coach route only).
- Deployment: local Docker Compose project `smashlab-ai`. Do not deploy to Azure or Vercel production without explicit approval.
- Layout:
  - `src/app/`: Next.js App Router pages and `api/` route handlers. `api/ai/chat` is the AI Coach.
  - `src/components/`: UI. `local-ai-lab.tsx` is Video Analysis, `session-library.tsx` is Sessions, `analysis-chatbot.tsx` is the AI Coach.
  - `src/lib/`: client helpers, the video-analysis snapshot, RAG and the offline pose modules.
  - `src/workers/` and `src/lib/pose-*`, `src/lib/multi-pose-tracker.ts`: MediaPipe pose code kept for offline pose analysis.
  - `tests/`: Node test files run with `--experimental-strip-types`.
  - `backend/`: FastAPI service, analysis pipeline and Python tests in `backend/tests`. Command-line tools in `backend/tools/`.
  - `data/`, `models/`, `outputs/`: local datasets, model files and job outputs. Git-ignored.
  - `infra/`: Azure draft. Not deployed and not compiled.
  - `docs/`: test report, Azure plan and reference review (`docs/REFERENCE_REVIEW.md`).

## Commands

```bash
npm install
npm run dev              # studio at http://localhost:3000
npm run lint
npm run test:vision      # pose, tracking, footwork modules
npm run test:rag         # coach retrieval
npm run test:local-ai    # client and video-analysis snapshot
npm run build
cd backend && .venv-dev/bin/python -m pytest    # backend tests (venv in backend/.venv-dev)
scripts/download-test-data.sh --verify-only     # checks the local samples; downloads nothing
docker compose -p smashlab-ai -f docker-compose.yml up -d --build
scripts/run-local-test.sh --no-build            # end-to-end test against the local stack
```

## Product rules

- **Videos may be uploaded only to the local Docker backend on localhost.** The backend accepts uploads only from the studio origin (`localhost:3000` and `127.0.0.1:3000`), limits size and duration, checks the container signature, and stores the file in the job folder. Sample videos are referenced by server-side IDs. The browser never sends filesystem paths.
- No cloud video upload and no cloud video processing. Azure OpenAI receives derived metrics only, never frames or video.
- Do not add face recognition. Player identity uses body position, motion continuity and body-appearance features only.
- Do not claim racket-contact measurement, shuttle flight measurement, or shuttle speed in km/h from pixels. Shuttle values are image-space detections.
- Every reported statistic must trace to a video timestamp and frame index, or be shown as "Unavailable" or "Not evaluated". Never fabricate a value to fill a field or a file.
- Rally segmentation and shot classification are unvalidated unless they are evaluated against ground truth. The UI and the exports must say so.
- Raw AI inference outputs are immutable. Manual corrections live in their own file and are applied as derived results.
- Player identities are logical (Player 1 to 4). Never reassign an identity silently. Low confidence is marked as uncertain, and a manual correction resolves it.

## Conventions

- TypeScript strict mode. Keep components in `.tsx` with co-located `*.module.css`.
- Keep UI copy in English, Vietnamese and German for every user-visible string.
- Add or update tests for changes to motion, tracking, identity, rally or replay logic.
- Reference repositories: check the licence before reusing code, weights or dependencies. Do not add AGPL dependencies such as the Ultralytics YOLO packages. Record decisions in `docs/REFERENCE_REVIEW.md`.

## Safety for agents

- `.env.local` and `.env.example` hold configuration. Do not print, copy or commit secret values.
- Do not run `git add`, `git commit`, `git push`, `git reset`, `git clean`, `git stash` or `git rebase` without explicit approval.
- Check `git status` before editing. Leave unrelated changes alone.
- Docker: do not prune or delete resources of other projects, including the Document Intelligence Lab resources, and do not delete volumes, without explicit approval. Check free disk space before building images.
- Do not download datasets or checkpoints that already exist locally. Verify checksums instead.
