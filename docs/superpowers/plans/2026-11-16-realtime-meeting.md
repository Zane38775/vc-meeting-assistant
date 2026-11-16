# 实时 VC 会议助手 Implementation Plan

> **For agentic workers:** Use focused parallel implementation tasks, with tests at each behavior boundary and an independent final review. User approved execution on 2026-11-16; no further plan approval required.

**Goal:** Deliver a working desktop-first meeting assistant with independent low-latency transcription, DeepSeek coaching/research, BP ingestion and authenticated partner synchronization.
**Architecture:** React client and Electron audio capture connect to a Fastify WebSocket/HTTP service. SQLite persists project-scoped data. ASR and AI adapters are separate, so provider delays never block transcript delivery.
**Tech Stack:** TypeScript, React, Electron, Fastify, node:sqlite, WebSocket, DeepSeek, Tencent ASR.
**Spec:** ../specs/2026-11-16-vc-meeting-design.md.

**User amendment:** Deliver Apple Silicon Mac, local streaming ASR by default, DeepSeek as the only needed API. Model weights/native arm64 runtime bundled. All ordinary implementation and packaging authorized; no further approval needed.

## Global Constraints
- Chinese UI; Apple Silicon Mac target; Windows development validation only. Online microphone plus system capture and offline microphone capture.
- Demo is opt-in and visibly labeled. Real failures never silently switch to demo.
- Keys stay on server. No sending messages or public deployment in this task.
- Final ASR segments trigger coaching; partials render immediately. Provider jobs have bounded deadlines and concurrency.
- All project resources and sockets require access checks; private notes stay private.
- Actual audio/API/two-device/60-minute evidence must be distinguished from software tests.

## Interfaces
Canonical entities are in shared/types.ts. HTTP errors are {error:string}; response objects are plain JSON.
GET /api/health -> Capabilities; GET /api/session -> {user:User|null}.
POST /api/auth/register {name,email,password}, /login {email,password} -> {user}; POST /logout.
GET/POST /api/projects -> {projects}/{project}; create accepts {name,description}.
GET /api/projects/:id -> {project,materials,meetings,members}; DELETE project (admin).
POST /api/projects/:id/materials multipart file -> {material}; PATCH /api/materials/:id {summary,pages?}; GET /api/materials/:id/file.
POST /api/projects/:id/meetings {title,mode,demo,retainAudio} -> {meeting}.
GET /api/meetings/:id -> MeetingSnapshot; WebSocket /api/meetings/:id/live accepts LiveCommand, emits LiveEvent.
PATCH /api/meetings/:id/questions/:qid {status}; POST /api/meetings/:id/questions {text}; PATCH /api/meetings/:id/segments/:sid {text?,speaker?}.
POST /api/meetings/:id/comments {text,private}; PATCH /api/meetings/:id/comments/:cid {private}.
POST /api/meetings/:id/summary -> {summary}; PATCH .../summary {text,published}; GET .../export -> markdown.
POST /api/projects/:id/invites {role} -> {token,expiresAt}; POST /api/invites/accept {token}; DELETE /api/projects/:id/members/:uid.

## Review Focus
1. Unauthorized project IDs, guessed material IDs, and revoked open sockets must reveal no content (Task 1 tests).
2. Duplicated/revised final ASR messages must not duplicate questions or transcript (Tasks 1/2).
3. Network stalls must not freeze recording UI, grow unlimited queues, or invent text (Tasks 2/4).
4. Scanned/malformed/oversized BP must produce visible warnings and preserve page indexing (Task 2).
5. Demo/manual provenance and unconfigured providers must remain explicit (Tasks 1/3).

## Task 1 — Service, persistence, collaboration (root)
Files: server/store.ts, server/app.ts, server/live.ts, server/index.ts, tests/service.test.ts.
- [x] Write and run failing tests for auth, project isolation, invitation expiry/single use, private notes, final segment dedup and socket revocation.
- [x] Implement SQLite storage and HTTP/WebSocket routes with session cookies, origin checks, input limits and safe error responses.
- [x] Implement realtime event lifecycle and bounded coaching scheduler; snapshots resync after reconnect.
- [x] Run service tests against real in-memory SQLite and real Fastify/socket server.

## Task 2 — AI, ASR, BP adapters (agent providers)
Files: server/providers/*.ts, server/materials.ts, tests/providers.test.ts.
Exports: getCapabilities():Capabilities; analyzeContext(input:AnalysisInput,signal?):Promise<{questions:QuestionDraft[]}>; researchTopic(query:string,signal?):Promise<Evidence[]>; summarizeMeeting(input:AnalysisInput,signal?):Promise<string>; summarizeMaterial(pages:MaterialPage[],signal?):Promise<string>; parseMaterial(buffer:Buffer,name:string):Promise<{pages:MaterialPage[],warning?:string}>; createASR(callbacks):ASRSession with write(pcm:Buffer),finish():Promise<void>,close(). Provider contracts in server/providers/contracts.ts.
- [x] Test provider stream decoding, finality mapping, query privacy boundaries and parser failure/size limits before implementation.
- [x] Verify official protocol docs and implement real adapters with deadlines and no hardcoded credentials.
- [x] Run focused tests; report live API prerequisites separately.

## Task 3 — Product UI (agent frontend)
Files: client/index.html, client/main.tsx, client/App.tsx, client/styles.css, client/api.ts; may add components.
- [x] Build project/preparation/meeting workspaces against the canonical API, with polished Chinese UI and accessible controls.
- [x] Render partial/final transcript, evidence links, question status, latency/provider status, manual input, demo, invitations and summary publishing.
- [x] Integrate capture module contract from Task 4; maintain independent transcript and AI indicators, reconnect snapshot.
- [x] Check type/build and exercise complete flow in browser after server integration.

## Task 4 — Desktop and audio (agent capture)
Files: desktop/main.cjs, desktop/preload.cjs, client/audio.ts, client/pcm-worklet.js, tests/audio.test.ts.
Exports captureAudio({mode,onChunk,onLevels,onError}):Promise<{stop():Promise<void>;pause():void;resume():void}>, onChunk({pcm:string,capturedAt:number,seq:number}), onLevels({mic:number,system:number}). Optional deviceId. Audio format PCM16LE mono 16kHz, 200ms frames.
- [x] Test streaming resampling/chunk framing before implementation.
- [x] Implement AudioWorklet capture and desktop loopback with restrictive IPC, contextIsolation, sandbox and local service lifecycle.
- [x] Handle track ending, permission failure and startup cleanup; verify no silent missing system audio.
- [x] Build desktop launch and portable packaging; actual microphone tests only with explicit user start.

## Task 5 — Integration and delivery (root + independent reviewer)
- [x] Run full tests, typecheck and production build; fix concrete failures.
- [x] Run authenticated browser flow, actual local-ASR via simulated microphone, realtime transport, and permission regression checks.
- [x] Produce Apple arm64 Mac test package with model/native modules and installation instructions.
- [x] Independent review, fix actionable findings and record evidence in VALIDATION.md.
- [x] Provide README, local configuration template and deployment instructions, explicitly listing blocked real-service/device checks.

## Verification boundaries
Mac physical-device/audio/installation validation, real DeepSeek API calls, remote two-device and 60-minute meeting acceptance remain unverified; see VALIDATION.md. These are not marked complete by the implementation task checkboxes above.
