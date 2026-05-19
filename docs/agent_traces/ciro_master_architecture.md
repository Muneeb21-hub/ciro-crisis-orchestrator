# Product Requirements Document (PRD): CIRO
**Crisis Intelligence & Response Orchestrator**

## 1. System Objective
Build a fault-tolerant, multi-agent simulation that fuses real-time urban signals, detects crises, optimizes resource allocation, and simulates response execution. The system must prioritize a React Native mobile command center and use Firebase Firestore as the centralized "World State" engine.

## 2. Tech Stack & State Management
* **Frontend Command Center:** React Native with Expo (Mobile), React Navigation, `react-native-maps`.
* **State Engine:** Firebase Firestore.
* **Orchestrator:** Google Antigravity (Multi-Agent Swarm).

### 2.1 Firestore Database Schema (The World State)
Agents must strictly adhere to this schema for reading and writing data:
* `IncomingSignals`: 
    * `id`, `source` (social | weather | traffic | field_report), `payload` (text/json), `timestamp`, `location_lat`, `location_lng`.
* `ActiveCrises`:
    * `id`, `type` (flood | heatwave | accident), `severity` (1-10), `confidence_score` (0-100), `affected_radius`, `status` (active | resolving | false_alarm).
* `Resources`:
    * `id`, `type` (ambulance | police | rescue | tanker), `status` (available | dispatched), `current_location`, `assigned_crisis_id`.
* `ActionLogs`:
    * `id`, `crisis_id`, `action_type` (reroute | dispatch | alert | retract), `description`, `timestamp`, `expected_impact`.

## 3. Antigravity Agent Swarm Topology
The system requires four specialized agents. Do not merge these roles into a single prompt.

### 3.1 The Ingestion & Fusion Agent
* **Role:** Monitor `IncomingSignals` collection.
* **Tasks:** 1. Parse unstructured inputs (e.g., Roman Urdu tweets, mock weather JSON).
    2. Perform Credibility Scoring (e.g., check for contradictions between social complaints and official sensor data).
* **Output:** Normalized signal objects passed to the Analysis Agent.

### 3.2 The Analysis & Detection Agent
* **Role:** Determine if a crisis is occurring.
* **Tasks:**
    1. Classify the crisis type and calculate the severity/confidence score based on fused signals.
    2. Estimate the affected population and expected duration.
* **Output:** Creates or updates a document in the `ActiveCrises` collection.

### 3.3 The Orchestration Agent (Resource Optimizer)
* **Role:** Allocate constrained resources across multiple simultaneous crises.
* **Tasks:**
    1. Query the `Resources` collection to find available assets.
    2. Run optimization logic: prioritize severe crises, calculate travel distance, and assign appropriate units (e.g., medical to heatwave, rescue to flood).
* **Output:** Updates `status` and `assigned_crisis_id` in the `Resources` collection.

### 3.4 The Execution & Simulation Agent
* **Role:** Simulate physical actions and handle communication.
* **Tasks:**
    1. Write simulated actions to the `ActionLogs` collection (e.g., "Traffic rerouted away from G-10").
    2. Draft stakeholder payloads (Public Alert, Hospital Notification, Dispatch Order).
    3. Calculate and log the "Expected After State" (e.g., "Congestion reduced by 30%").

## 4. Core Execution Workflows
Agents must handle the following specific flows:

### 4.1 Multi-Crisis Conflict Flow
* **Trigger:** Two high-severity events are injected into `IncomingSignals` within 30 seconds.
* **Required Logic:** The Orchestration Agent must demonstrate a trade-off. If only 3 ambulances are available, it must split them based on severity and estimated casualties, logging the exact reasoning for the split.

### 4.2 The False Alarm / Recovery Flow
* **Trigger:** A "Field Report" signal arrives contradicting an active crisis (e.g., "Not a flood, just a broken pipe").
* **Required Logic:** 1. Analysis Agent downgrades crisis severity and alters type.
    2. Execution Agent issues a "retraction" public alert.
    3. Orchestration Agent recalls heavy rescue resources and updates their status to `available`.

### 4.3 Degraded Mode (API Failure)
* **Trigger:** Mock Traffic API fails to send data for 60 seconds.
* **Required Logic:** Ingestion Agent flags the API as "down." Analysis Agent lowers its confidence score but proceeds using historical vulnerability maps and social mentions.

## 5. Front-End (React Native) UI Requirements
The React Native agent must build a dashboard that listens to Firebase in real-time (`onSnapshot`).

* **Main Map View:** Visualizes active crises (colored zones based on severity) and moving resource markers.
* **Incident Feed:** A scrolling list of real-time `ActionLogs` and stakeholder notifications.
* **Transparency Panel:** A dedicated drawer/modal showing raw Antigravity Agent logs (e.g., "Credibility Score reduced due to weather API contradiction").
* **Simulation Controls (Admin):** Buttons to manually inject stress tests (e.g., "Trigger Heatwave", "Simulate False Alarm", "Kill Traffic API").

## 6. Success Criteria (Hackathon Scoring Alignment)
* [ ] **25% - Detection & Analysis:** System handles Roman Urdu and flags contradictions effectively.
* [ ] **20% - Antigravity Integration:** Logs prove that multiple agents are coordinating, not just a single LLM call.
* [ ] **20% - Optimization:** System visually demonstrates running out of resources and making hard choices.
* [ ] **15% - Simulation:** Actions have logged "before" and "after" states.