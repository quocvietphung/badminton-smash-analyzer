# SmashLab Coach (current build)

The Coach answers questions about one completed local analysis and gives general badminton advice from a small cited
knowledge base. Its layout follows a compact document-assistant design: a launcher pill, a panel with a
brand header, two tabs and a composer dock. The same conversation is shared by the floating panel and the Coach page.

## What it receives

- The video analysis snapshot (`src/lib/video-analysis.ts`) and the analysis's coach dataset
  (`/api/v1/analyses/<job>/coach-dataset`, coach-dataset/v1, built by `backend/app/services/coach_dataset.py`).
- Never frames or video. The video stays on this computer; Azure OpenAI receives derived values only
  (`src/app/api/ai/chat/route.ts`).
- In doubles the dataset covers P1 to P4; the movement comparison names the identity that moved most and the one that
  moved least (`movement_comparison.compared`).

## Two tabs

| Tab | What it shows | Language model |
|---|---|---|
| Ask Coach | The chat. A context chip lists the analysis, its frames with a shuttle detection, tracks, contacts and court status. Questions to try fold away on phones and short windows. | Yes (the configured provider) |
| Data report | A report written from the coach dataset alone (`src/lib/ai/coach-report.ts`): overview, movement, shots (trajectory estimates, unverified), image-space speed, contact timeline, not evaluated. Every value line names its frame and video time, or the analysed range. Missing values read "Unavailable"; nothing is filled in. It can be copied as Markdown or sent to the chat. | No |

## Number check

After each answer, `src/lib/ai/number-check.ts` looks up every number of the answer in the analysis data (the coach
dataset and the snapshot, including shares as percentages and the P1/P2 differences), in the question, and in the
knowledge base. Rounding is accepted to the precision written. Counts from 0 to 3 and calendar years are not checked.

- All found: a green chip, "N of M numbers found in the data".
- Some not found: an amber panel listing each number with its context.
- A number followed by km/h, m/s or mph is flagged on its own: this build never measures physical shuttle speed.

The check says a number exists in the data, not that the sentence around it is right.

## Tests

`tests/coach-report.test.ts` (in `npm run test:local-ai`): every value line has evidence, estimates are marked
unverified, missing values are unavailable, decimal styles of EN/VI/DE answers are read, invented numbers and km/h are
reported.

## Model provider

- Default: Azure OpenAI (`AZURE_*` settings, see `.env.example`). The reply streams through `src/app/api/ai/chat/route.ts`.
- `SMASHLAB_COACH_PROVIDER=ollama`: the same instructions and the same derived data go to a model on this computer, through
  the OpenAI-compatible `/v1/chat/completions` endpoint of an Ollama server. Azure is not called in this mode.
- `OLLAMA_BASE_URL` must be an address of this computer: `http://127.0.0.1:11434`, `http://localhost:11434`,
  `http://[::1]:11434`, or `http://host.docker.internal:11434` (Docker Desktop's name for the Mac). Any other host, or https,
  is refused at start.
- No new package: the reply is written with `createUIMessageStream` from the `ai` package the route already uses
  (`src/lib/ai/coach-provider.ts`). The page shows the model name from `/api/ai/status`.

### Model name and context window

Ollama 0.40.18 gives a model a 2,048-token context unless told otherwise. The coach prompt is about 4,600 tokens, so the plain
tag cuts it silently: measured through `/v1`, `usage.prompt_tokens` was 2,050 instead of 4,642. The server setting
`OLLAMA_CONTEXT_LENGTH` did not change this version. The fix is a local variant with its own context length. It reuses the
same weights and downloads nothing:

```bash
printf 'FROM qwen2.5:7b\nPARAMETER num_ctx 8192\nPARAMETER temperature 0.2\n' > Modelfile
~/Applications/Ollama.app/Contents/Resources/ollama create qwen2.5-7b-8k -f Modelfile
```

`OLLAMA_MODEL` defaults to `qwen2.5-7b-8k`. If the variant does not exist, a request fails with an error instead of answering
from a cut prompt.

### Start the server (no GUI, no admin rights)

```bash
OLLAMA_HOST=127.0.0.1:11434 ~/Applications/Ollama.app/Contents/Resources/ollama serve
```

### Measured on this Mac (27 Nov 2026)

Apple M3, 16 GB, macOS 15.8.4. Ollama 0.40.18 from the official zip (valid signature, notarized; the signing name is
"Infra Technologies, Inc", not verified as the Ollama company). Model `qwen2.5:7b`, 4.68 GB. Typical coach prompt: 4,642 tokens
(Vietnamese rules, 14,368 characters of derived coach data from sample A, one Vietnamese question). `num_ctx` 8192, answers
up to 384 tokens, native API, Metal used.

| Measure | Result |
|---|---|
| Model load (first call) | 14.6 s |
| Prompt processing, cold | 142 s (32.6 tokens/s) |
| Generation | 3.4 to 6.2 tokens/s (median 5.6) |
| Median total per answer, 3 runs | 69 s |
| Same prompt again | prompt cached, 0.1 to 0.2 s |

Judgement: slow for interactive use on this Mac. The first answer per analysis waits about three minutes. Alternatives, none
pulled: a 3B model (about 1.9 GB, faster, weaker), a shorter data summary in the prompt, or Azure for answers with Ollama for
tests only. Each needs an owner decision.

### Docker

The Ollama server listens on 127.0.0.1 by default, which a container cannot reach. `npm run dev` on the Mac reaches it.
Reaching it from the Docker web container needs Ollama to listen beyond loopback, a decision for the owner.

### Test

`tests/coach-provider.test.ts` (in `npm run test:local-ai`). The live check skips with its reason when no Ollama server answers
or the model variant does not exist.
