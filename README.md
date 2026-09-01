# SmashLab Motion Science Studio

SmashLab is a browser-first badminton training studio that turns a phone camera into a practical motion-analysis tool. It helps players review racket technique and footwork through on-device pose tracking, repeatable session scores, and an AI coach grounded in the session's motion metrics.

Built with **Next.js 16**, **React 19**, **TypeScript**, **MediaPipe Tasks Vision**, and **Azure OpenAI**, then deployed as a lightweight **PWA on Vercel**.

> The interesting constraint: video frames stay on the athlete's device. The optional AI Coach receives reduced motion metrics, never raw video or camera frames.

## Product tour

### Live Motion Capture

Frame one athlete, confirm the target, choose a drill, and record a set. SmashLab tracks body landmarks, separates repetitions into motion phases, and surfaces technique signals such as elbow angle, shoulder position, knee bend, trunk rotation, rhythm, balance, and recovery.

![SmashLab Live Studio](public/screenshots/live-studio.png)

### Session Reports

Review repetition count, motion score, consistency, capture quality, and the main priorities to work on. Sessions are persisted locally with IndexedDB, so the app does not need a video-processing backend or database.

![SmashLab Session Reports](public/screenshots/session-reports.png)

### AI Coach

Ask questions about the current training data and get practical explanations from a grounded badminton knowledge base. The coach is designed to explain what the motion metrics suggest, not to pretend it can see racket contact or shuttle flight.

![SmashLab AI Coach](public/screenshots/ai-coach.png)

## What it can do

- Track up to four people in frame and let the athlete confirm which person should be analysed.
- Analyse racket technique drills: Smash, Backhand, Clear, Drop Shot, Drive, or automatic grouping.
- Analyse footwork cycles such as split step, chassé, lunge, jump and landing, scissor jump, China jump, and recovery to base.
- Use MediaPipe Pose Landmarker Lite, optional world landmarks, appearance-aware tracking, and a Web Worker when supported.
- Compare repetitions and highlight technique strengths, consistency, balance, recovery, and capture quality.
- Store up to 12 sessions locally on the device with no account or database.
- Offer English, Vietnamese, and German UI copy, plus dark and light training themes.
- Provide an optional Azure OpenAI Coach route with rate limiting and retrieval-grounded badminton references.

## Important scope

SmashLab analyses body movement form. It does **not** detect the racket face or shuttle, confirm contact timing, calculate official speed in km/h, reconstruct shuttle trajectory, or replace a qualified coach. Scores are internal training signals, not BWF ratings or scientific accuracy claims. Measurements such as foot speed and centre-of-mass speed are normalised relative values because the camera is not calibrated to a court.

## Run locally

### Requirements

- Node.js 20+
- A modern browser with camera access
- npm

### 1. Install dependencies

```bash
npm install
```

### 2. Configure optional AI Coach access

Copy the example environment file:

```bash
cp .env.example .env.local
```

The camera analysis works without Azure credentials. To enable the AI Coach, set these server-only variables in `.env.local`:

```env
AI_ASSISTANT_ENABLED=true
AZURE_RESOURCE_NAME=your-resource-name
AZURE_API_KEY=your-server-side-key
AZURE_OPENAI_DEPLOYMENT=your-deployment-name
AZURE_OPENAI_API_VERSION=v1
```

Never expose `AZURE_API_KEY` with a `NEXT_PUBLIC_` prefix.

### 3. Start the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), allow camera access, and follow the setup guide. For reliable tracking, place the phone around hip height, 3–5 metres from the athlete, keep the full body in frame, and avoid backlight. The first visit needs internet access to download the MediaPipe WASM runtime and Pose Landmarker model.

## Verify the project

```bash
npm run lint
npm run test:vision
npm run test:rag
npm run build
```

The test suite covers pose classification, pose metrics, motion phases, footwork analysis, multi-person tracking, appearance matching, and retrieval logic.

## Deploy to Vercel

SmashLab is a standard Next.js App Router application and can be deployed directly to Vercel:

1. Import the repository in the [Vercel dashboard](https://vercel.com/new).
2. Keep the default build command, or use `npm run build`.
3. Add the optional Azure variables under **Project Settings → Environment Variables**.
4. Deploy and open the generated HTTPS URL so browsers can grant camera permission.

Video inference runs in the browser, so Vercel only serves the application and handles the optional AI Coach Route Handler. No Python service, GPU instance, or cloud video pipeline is required.

## Architecture at a glance

```text
Camera
  → MediaPipe Pose Landmarker (browser)
  → Web Worker + athlete tracking + motion metrics
  → Local session store (IndexedDB)
  → Session reports / AI Coach
                         ↘ reduced metrics → Azure OpenAI Route Handler
```

The main app lives in `src/app`, UI composition is in `src/components`, and the analysis pipeline is kept in focused modules under `src/lib`. The project is intentionally designed to keep raw camera data local while making the analysis logic testable independently of the UI.

## License

This project is licensed under the [MIT License](LICENSE). Copyright (c) 2026 Viet Phung.
