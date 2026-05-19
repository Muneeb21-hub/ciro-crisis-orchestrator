# CIRO: Crisis Intelligence & Response Orchestrator 🚨

CIRO is an advanced, multi-agent AI system designed to radically transform emergency response operations. Built for real-time crisis management, CIRO leverages a sophisticated AI agent swarm to autonomously ingest unstructured public signals, verify crises, and intelligently orchestrate physical resources — saving lives when seconds matter most.

What started as a prototype has been hardened across three rigorous production upgrade phases into a fully resilient, event-driven system with geospatial algorithms, fault-isolation primitives, a persistent state machine, and a multi-state visual telemetry layer.

---

## 🚀 The Tech Stack & Core Infrastructure

Our backend is a production-ready, serverless architecture built on modern cloud primitives:

| Layer | Technology |
|---|---|
| **Runtime** | Node.js 20 on Google Cloud Run (2nd Gen) |
| **Infrastructure** | Firebase Cloud Functions v2 · Firestore (Immutable World State Engine) |
| **Scheduling** | Cloud Scheduler via `onSchedule` — cron-driven lifecycle management |
| **State Machine** | Firestore-persisted `ScheduledTransitions` collection — cold-start resilient |
| **AI Integration** | Google Agent Development Kit (ADK) via `@google/genai` |
| **Intelligence** | Gemini 2.5 Flash — strict `responseSchema` definitions for deterministic, machine-readable reasoning |
| **Geospatial** | Haversine formula computed natively inside serverless instances — no external geocoding service |
| **Resiliency** | Automated retry wrapper with exponential backoff · `FailedSignals` dead-letter queue |
| **Frontend** | React Native (Expo Router) · `react-native-maps` · Firebase real-time listeners |

### Key Infrastructure Decisions

**Haversine on Serverless.** Rather than calling an external geocoding or proximity API, CIRO implements the full Haversine great-circle distance formula directly in the Cloud Function runtime. This eliminates external latency, additional billing dimensions, and third-party failure surfaces — the swarm computes physical distances in metres between any two WGS84 coordinates entirely in-process.

**Database-Driven State Machine.** Resource lifecycle state transitions (`dispatched → on_scene → available`) are never managed by in-memory timers or `setTimeout`. Instead, each dispatch writes a document to the `ScheduledTransitions` root collection containing a `trigger_at` timestamp. The `crisisLifecycleManager` cron function polls this collection every 15 minutes, applies due transitions atomically, and self-queues the next state — making the entire pipeline immune to Cloud Run cold-start instance recycling.

---

## 🤖 The Antigravity Agent Swarm Architecture

CIRO operates on a 6-agent swarm. Each agent is triggered asynchronously by Firestore events, passing state through immutable pipeline documents. No agent holds in-memory state — every handoff is a durable Firestore write.

---

### 1 · 📡 Ingestion & Fusion Agent
**Trigger:** `IncomingSignals/{signalId}` — `onDocumentCreated`

Acts as the eyes and ears of the system. The agent continuously parses unstructured, noisy, and multilingual text (including Roman Urdu) from the `IncomingSignals` collection, normalizing it into clean, structured JSON via a strict Gemini `responseSchema`.

**Production Upgrade — 9-Tier Localized Incident Classification:**  
The `event_type` enum was expanded from 4 generic labels to 9 context-specific categories calibrated for Pakistani metropolitan geography: `traffic_accident`, `fire`, `medical_emergency`, `riot`, `flood`, `earthquake`, `infrastructure_failure`, `crime`, and `hazmat_spill`. Each classification carries explicit local context cues to reduce misclassification on multilingual or abbreviated input.

**Production Upgrade — AI-Driven Location Inference:**  
When strict GPS coordinates are absent (the common case for citizen-reported social signals), the Ingestion Agent uses deep knowledge of Pakistani regional geography to extract an `inferred_location` object containing:
- `lat` / `lng` — inferred WGS84 coordinates
- `confidence` — a 0–100 percentage certainty score
- `locality_name` — a human-readable place name (e.g., *"G-10 Markaz, Islamabad"*)

The inferred location is promoted to the **root of the `StagedSignals` document** so downstream agents can query it directly without deep field traversal.

---

### 2 · 🕵️ Analysis & Detection Agent
**Trigger:** `StagedSignals/{signalId}` — `onDocumentCreated`

The verification layer. It evaluates the credibility and severity of normalized signals, calculates the affected radius and expected duration, and decides whether to formally declare a crisis.

**Production Upgrade — Geospatial Deduplication Engine:**  
Before writing any new document to `ActiveCrises`, the Analysis Agent runs a **Deduplication Query**:

1. Query `ActiveCrises` for existing documents where `type` matches the incoming signal, `status` is `active` or `resolving`, and `timestamp ≥ now − 2 hours`.
2. For each candidate, compute the Haversine distance between the incoming `inferred_location` and the existing crisis `location`.
3. If any existing crisis is within **500 metres**, the incoming signal is treated as a duplicate: the existing document's `severity` is updated to the higher of the two values, `last_updated` is refreshed, and **no new map pin is created**.
4. A `log_level: "warning"` SwarmActivity entry is written: *"Duplicate signal detected — merged into existing crisis."*

This eliminates the fragmented multi-pin problem that plagues real-time crisis feeds: a single street fire reported across ten social posts produces one authoritative crisis node, not ten.

**Schema:** Every new `ActiveCrises` document now stores a root-level `location` object `{ lat, lng, locality_name }` for direct proximity querying by downstream agents.

---

### 3 · 🧠 Orchestration Agent
**Trigger:** `ActiveCrises/{crisisId}` — `onDocumentCreated`

The strategic core. Triggered by a new crisis declaration, this agent queries the `Resources` collection for all available assets and constructs a constraint-aware deployment plan.

**Production Upgrade — Proximity-Aware Resource Dispatching:**  
Available physical assets are no longer evaluated purely by type. Before the Gemini call is made, every resource is annotated with a `distance_metres` field computed via the Haversine formula against the crisis's declared coordinates. The resulting array is sorted ascending — closest first. The Gemini system instruction explicitly instructs the model to *"prioritize selecting available assets that are geographically closest to the crisis incident"*, and the prompt header labels the resource list as *"sorted by proximity — closest first"*.

This means the LLM's dispatch reasoning is grounded in real physical distances, not arbitrary Firestore document ordering. Dummy resources (no `current_location`) are safely sorted to the end via `Infinity` sentinel values.

---

### 4 · ⚡ Execution & Simulation Agent
**Trigger:** `Resources/{resourceId}` — `onDocumentUpdated` (on `available → dispatched` transition)

The operational layer. When a resource is dispatched, this agent calls Gemini to generate a public-facing action narrative and expected impact assessment, written to `ActionLogs`.

**Production Upgrade — Cold-Start Resilient State Scheduling:**  
After writing the `ActionLogs` entry, the agent writes a document to the `ScheduledTransitions` root collection:

```
{
  resource_id:   "res_ambulance_01",
  crisis_id:     "crisis_signal_abc",
  target_status: "on_scene",
  trigger_at:    <now + 2 minutes>,
  created_at:    <serverTimestamp>
}
```

No `setTimeout` is used anywhere. The transition lives in Firestore and will be executed by `crisisLifecycleManager` regardless of whether the originating Cloud Run instance is still alive.

---

### 5 · ⏱️ Crisis Lifecycle Manager
**Trigger:** Cloud Scheduler — `onSchedule("every 15 minutes")`

A cron-driven orchestration layer that manages the complete lifecycle of both resources and crises.

**Step A — Resource State Transitions:**  
Queries all `ScheduledTransitions` where `trigger_at ≤ now`. For each due transition:
- Applies the `target_status` update to the `Resources` document.
- If the new status is `on_scene`, immediately writes the next transition (`on_scene → available`, `trigger_at: now + 10 minutes`) and deletes the current document.
- Logs a `log_level: "info"` SwarmActivity entry per transition.

**Step B — Crisis Status Progression:**  
- Scans `ActiveCrises` where `status === "active"`. If all assigned resources have returned to `available`, the crisis transitions to `resolving`.
- Scans `ActiveCrises` where `status === "resolving"`. If `expected_duration` hours have elapsed since `resolving_since`, the crisis transitions to `resolved`.

The full status arc is: **`active → resolving → resolved`**.

---

### 6 · 🔔 Notification Agent
**Trigger:** `ActiveCrises/{crisisId}` — `onDocumentCreated`

Fires in parallel with the Orchestration Agent the instant a crisis is declared.

Reads the crisis `type`, `severity`, and `location.locality_name` to compose a push notification payload:
- **Title:** `⚠️ Crisis Declared: [Event Type]`
- **Body:** `[Locality] — Severity [N]/10. CIRO response teams are being deployed.`
- **Data:** `{ crisisId, screen: "CrisisDetail", type }` for deep-linking into the Expo app.

Queries the `PushTokens` root collection (`{ expoPushToken: string, created_at: timestamp }`) and filters to valid `ExponentPushToken[...]` strings. The function is architected for batch fan-out in chunks of **100 tokens per request** to the Expo Push API (`https://exp.host/--/api/v2/push/send`), matching Expo's documented rate-limit boundary.

---

## 🛡️ System Resiliency & Dead-Letter Queue (DLQ)

Production AI pipelines cannot afford silent data loss. Every call to `ai.models.generateContent` in CIRO is wrapped in `callGeminiWithRetry` — a fault-isolation primitive that ensures the swarm degrades gracefully rather than crashing silently.

### `callGeminiWithRetry` — How It Works

```
callGeminiWithRetry(agentName, callFunction, context, maxRetries = 2)
```

1. **Attempt 1:** Execute the Gemini API call.
2. **On failure:** Log a `WARN`, wait **3 seconds**, attempt again.
3. **Attempt 2:** Execute the Gemini API call.
4. **On final failure:** Write to the `FailedSignals` dead-letter collection and emit a `log_level: "critical"` SwarmActivity entry. Return `null` to the caller.

Every call site performs an explicit `null` guard — if the wrapper returns `null`, the agent exits cleanly without writing corrupt partial data downstream.

**`FailedSignals` document schema:**

| Field | Value |
|---|---|
| `agent_name` | Name of the originating agent |
| `error_message` | Raw exception message |
| `failed_at` | Server timestamp |
| `status` | `"failed"` |
| `retry_count` | Number of attempts made |
| `original_collection` | Source Firestore collection |
| `original_id` | Source document ID |
| `payload` | Original input data (where available) |

This design means **no signal is ever silently dropped**. Every API failure produces a recoverable audit record that an operator (or a future recovery agent) can inspect and replay.

---

## 🧠 Swarm Intelligence Highlight: Constraint-Aware Orchestration

A multi-agent system is only as powerful as its ability to reason within strict constraints. CIRO is not just an LLM wrapper — it is a context-aware orchestrator.

During our live execution tests, our swarm demonstrated remarkable constraint-aware reasoning. In one scenario, a **severe urban flood** was detected and verified by the Analysis Agent. The Orchestration Agent immediately queried the `Resources` collection and identified that the *only* available asset in the vicinity was a standard medical ambulance.

Instead of hallucinating a deployment or blindly throwing resources at the problem, the Orchestration Agent correctly deduced that an ambulance is physically unsuitable for water rescue operations. It intelligently chose **NOT to deploy** the ambulance, prioritizing asset safety, and automatically escalated the crisis for specialized aquatic rescue intervention.

> **Proof of Execution:** Our live execution traces, raw reasoning outputs, and autonomous JSON schemas generated by the Gemini ADK have been exported and documented in the repository at:  
> `docs/agent_traces/logs-20260514-204735.json`

---

## 📱 The Mobile Command Center (Frontend)

CIRO features a high-fidelity, real-time operational dashboard built with **React Native** and **Expo Router**, connecting directly to Firebase via real-time `onSnapshot` listeners.

### Live Interactive Map

Displays dynamic markers for `ActiveCrises` (severity-coloured pins) and `Resources` (state-coloured dots) rendered on `react-native-maps`.

**Map Clutter Management — Crisis Lifecycle Opacity:**  
As crises progress through the `active → resolving → resolved` arc, their map layer opacity is dialled down automatically:
- `active` → full opacity `1.0` — high-severity active crises pulse with an animated ring
- `resolving` → muted opacity `0.52` — visually receding but still present
- `resolved` → greyscale tint `#8a9099` at opacity `0.28` — near-invisible, zero visual noise

Pulse animations are gated to `status === 'active'` only — resolved crises never throb on the map.

**Coordinate Extraction Hierarchy:**  
The `CrisisMarker` component resolves coordinates using a deterministic three-tier fallback chain:
1. Root `location.latitude / longitude` — Phase 2 Analysis Agent output
2. Root `inferred_location.lat / lng` — Phase 1 Ingestion Agent AI inference
3. Stable hash-derived offset from the Firestore document ID — reproducible across renders (replaces the previous `Math.random()` anti-pattern)

### Multi-State Resource Node Tracking

The `ResourceMarker` component renders distinct colours for all three operational states produced by the backend state machine:

| Status | Colour | Meaning |
|---|---|---|
| `available` | Slate Blue `#4dabf7` | Unit is staged and ready for dispatch |
| `dispatched` | Warning Orange `#ff9f43` | Unit is en-route to the crisis scene |
| `on_scene` | Response Green `#69db7c` | Unit is actively operating at the incident |

The callout tooltip displays the current status label (`○ Available`, `▶ Dispatched`, `● On Scene`) along with the assigned `crisis_id` for dispatched units, enabling precise cross-referencing between the map and the Incident Feed.

### Color-Coded Swarm Telemetry Terminal

The Agent Terminal overlay streams `SwarmActivity` documents in real-time and applies dynamic text colour based on the structured `log_level` field written by each backend agent:

| `log_level` | Colour | When Used |
|---|---|---|
| `info` | Neon Green `#39ff14` | Normal pipeline progression |
| `warning` | Amber Yellow `#ffb020` | Duplicate detections, suppressed alerts, degraded states |
| `critical` | Emergency Red `#ff4b4b` | Gemini API failures routed to the DLQ |

Agent identifiers (`[IngestionAgent]`, `[AnalysisAgent]`, etc.) are always rendered in neon green as a stable visual anchor; only the message body changes colour based on severity.

### KPI Command Strip

Three live-updating KPI cards give operators an at-a-glance operational picture:
- **Active Crises** — count of `status === "active"` crises, with critical count sub-label
- **Resources** — total assets, sub-labelled with `dispatched + on_scene` combined deployment count
- **On Scene** — units actively at incident locations, sub-labelled with available reserve count

### Map Legend

| Colour | Meaning |
|---|---|
| 🔴 `#ff4b4b` | Critical severity crisis (≥ 8/10) |
| 🟠 `#ff9f43` | Moderate severity crisis · Dispatched resource |
| 🟡 `#ffd93d` | Low severity crisis |
| 🟢 `#69db7c` | Resource on scene |
| 🔵 `#4dabf7` | Available resource |

---

## 🛠️ Getting Started

### Prerequisites

- Node.js v20+
- Firebase CLI (`npm install -g firebase-tools`)
- Expo CLI (`npx expo`)
- A valid Google Gemini API Key

### 1. Backend Deployment

```bash
# Clone and navigate to the backend
cd backend/

# Create your environment file
echo "GEMINI_API_KEY=your_key_here" > .env

# Deploy all 6 Cloud Functions
firebase deploy --only functions
```

### 2. Frontend Launch

```bash
cd ciro-mobile/
npm install
npx expo start
```

### 3. Run the End-to-End Simulation Diagnostics

CIRO ships with a four-scenario automated test suite. Each script injects a structured signal into the live Firestore pipeline, activating the full 6-agent swarm. Run them with your frontend map open to observe the real-time system response.

---

#### `node backend/tests/test-1-benign-noise.js` — Noise Filtering & Credibility Validation

Injects an ambiguous, low-credibility signal (e.g., a vague social post) to validate that the Analysis Agent correctly **rejects** the signal and does not create a false-positive crisis pin. Demonstrates the swarm's gatekeeping logic.

---

#### `node backend/tests/test-2-flood-escalation.js` — Resource Constraint Reasoning

Injects a severe flood signal into a region where only an ambulance is registered as available. Demonstrates the Orchestration Agent's constraint-aware reasoning: it correctly refuses to deploy an ambulance for water rescue and escalates the crisis instead of hallucinating an inappropriate dispatch.

---

#### `node backend/tests/test-3-api-integration.js` — Structured Webhook Processing

Injects a machine-formatted JSON payload (simulating a structured Maps API webhook) to validate the pipeline's ability to process programmatic signals alongside unstructured social text. Tests the `inferred_location` schema when GPS coordinates arrive pre-formed from an external system.

---

#### `node backend/tests/test-4-golden-demo.js` — Full Multi-Unit Coordinated Emergency Simulation

The definitive end-to-end demonstration run. Injects a high-severity, multi-resource emergency and observes:

1. **Ingestion Agent** — parses and normalizes the signal, extracts `inferred_location`
2. **Analysis Agent** — declares a formal crisis in `ActiveCrises`, runs deduplication check
3. **Orchestration Agent** — queries proximity-sorted resources, builds and executes a multi-unit dispatch plan
4. **Execution Agent** — generates public `ActionLogs`, writes `ScheduledTransitions` for each deployed unit
5. **Notification Agent** — fans out push alerts to registered `PushTokens`
6. **Crisis Lifecycle Manager** — (next cron tick) drives units through `dispatched → on_scene → available`, progresses crisis to `resolving`, then `resolved`

**Observe the magic:** Watch as signals cascade through the pipeline, the Agent Terminal colour-codes each reasoning step, crisis and resource markers update in real-time on the map, and the Incident Feed populates with AI-generated dispatch narratives.

---

*Built to save lives. Powered by Gemini & Firebase.*
