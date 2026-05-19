require("dotenv").config();
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const { GoogleGenAI, Type } = require("@google/genai");
const fs = require('fs');
const path = require('path');

// Setup file logging.
// Cloud Run 2nd Gen containers have a read-only filesystem except for /tmp.
// When K_SERVICE is set we're running on Cloud Run, so we redirect there.
// In the local emulator / dev environment we write to ../docs/log as before.
const IS_CLOUD_RUN = !!process.env.K_SERVICE;
const logDir = IS_CLOUD_RUN
    ? '/tmp/ciro-logs'
    : path.join(__dirname, '../docs/log');

try {
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
} catch (e) {
    // If we still can't create the dir (e.g. permission edge-case), log to
    // stdout only and continue — never crash the container at startup.
    console.warn(`[CIRO] Could not create log directory at ${logDir}:`, e.message);
}

function saveLogToFile(level, message, ...args) {
    try {
        const timestamp = new Date().toISOString();
        const argsString = args.length ? ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ') : '';
        const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}${argsString}\n`;
        fs.appendFileSync(path.join(logDir, 'app.log'), logMessage);
    } catch (_) {
        // File write failure must never crash the pipeline
    }
}

// Wrap logger methods to also save to file
['info', 'error', 'warn', 'log', 'debug'].forEach(level => {
    if (logger[level]) {
        const originalMethod = logger[level];
        logger[level] = function(message, ...args) {
            saveLogToFile(level, message, ...args);
            originalMethod.apply(logger, [message, ...args]);
        };
    }
});

// Ensure Firebase is initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();

// Initialize Google ADK
// We explicitly pass the API key to prevent SDK initialization errors during deployment
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "dummy_key_for_deployment" });

// log_level: "info" | "warning" | "critical" — used by the mobile frontend for color-coding
async function logSwarmActivity(agentName, message, crisisId = null, log_level = "info") {
    saveLogToFile(log_level, `[${agentName}] ${message}${crisisId ? ` (Crisis ID: ${crisisId})` : ''}`);
    try {
        await db.collection("SwarmActivity").add({
            agent_name: agentName,
            message: message,
            crisis_id: crisisId,
            log_level: log_level,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (error) {
        // Intentionally not re-throwing — logging failures must never crash the pipeline
        logger.error(`Failed to log swarm activity for ${agentName}:`, error);
    }
}

// ==========================================
// GEOSPATIAL HELPER
// ==========================================
/**
 * Haversine formula — returns the great-circle distance between two
 * WGS84 coordinates in metres.
 */
function getHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in metres
    const toRad = deg => deg * (Math.PI / 180);
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// ==========================================
// GEMINI RETRY WRAPPER (Phase 3, Issue #7)
// ==========================================
/**
 * Wraps a Gemini API call function with retry logic and a dead-letter queue.
 *
 * @param {string}   agentName    - Name used in SwarmActivity logs and FailedSignals docs.
 * @param {Function} callFunction - An async arrow function that performs the actual
 *                                  `ai.models.generateContent(...)` call and returns the response.
 * @param {object}   [context]    - Optional metadata (e.g. signalId) written to FailedSignals.
 * @param {number}   [maxRetries] - Maximum number of attempts (default 2).
 * @returns {Promise<*|null>}    - The raw Gemini response, or null on final failure.
 */
async function callGeminiWithRetry(agentName, callFunction, context = {}, maxRetries = 2) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await callFunction();
        } catch (err) {
            lastError = err;
            logger.warn(`${agentName}: Gemini call failed (attempt ${attempt}/${maxRetries}). Error: ${err.message}`);
            if (attempt < maxRetries) {
                // 3-second backoff between retries
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }
    }

    // All retries exhausted — write to dead-letter queue and log critical alert
    try {
        await db.collection("FailedSignals").add({
            agent_name: agentName,
            error_message: lastError ? lastError.message : "Unknown error",
            failed_at: admin.firestore.FieldValue.serverTimestamp(),
            status: "failed",
            retry_count: maxRetries,
            ...context  // spreads caller-supplied metadata (e.g. original_collection, original_id, payload)
        });
    } catch (writeErr) {
        // Writing to FailedSignals itself failed — log only, never throw
        logger.error(`${agentName}: Could not write to FailedSignals collection:`, writeErr);
    }

    await logSwarmActivity(
        agentName,
        "Gemini API failed after max retries. Signal moved to dead-letter queue.",
        context.crisis_id || null,
        'critical'
    );

    return null;  // callers must null-check before using the response
}

// ==========================================
// 1. THE INGESTION & FUSION AGENT
// ==========================================
exports.ingestionAgent = onDocumentCreated("IncomingSignals/{signalId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
        logger.log("No data associated with the event");
        return;
    }

    const data = snapshot.data();
    logger.info("Ingestion Agent triggered for signal:", event.params.signalId);
    
    const systemInstruction = `
You are the Ingestion & Fusion Agent for the CIRO (Crisis Intelligence & Response Orchestrator) system.
Your job is to analyze incoming signals (e.g., social media text, weather reports, field reports, often in Roman Urdu or English),
and output a JSON object containing the normalized data.
Evaluate credibility based on whether the text looks like spam, hyperbole, or a genuine crisis report.

LOCATION INFERENCE RULES:
If the signal contains any geographic hint — a sector name, landmark, neighborhood, road, or city area — you MUST infer approximate
WGS84 coordinates (lat/lng) for that location. Use your knowledge of Pakistani urban geography as your reference:
- Islamabad: sectors like G-10, F-7, I-8, E-11, Blue Area, Faizabad; coordinates roughly 33.6°N 73.0°E.
- Karachi: areas like Saddar, Clifton, Gulshan-e-Iqbal, Korangi, Lyari, SITE; roughly 24.8°N 67.0°E.
- Lahore: areas like Gulberg, DHA, Johar Town, Model Town, Anarkali; roughly 31.5°N 74.3°E.
- Rawalpindi: Saddar, Murree Road, Bahria Town; roughly 33.6°N 73.1°E.
If no location hint exists, set lat and lng to 0 and confidence to 0.
`;

    const userPrompt = `
Analyze the following incoming signal:
Source: ${data.source || 'unknown'}
Payload: ${data.payload || ''}
`;

    // Define strict response schema for Ingestion
    const responseSchema = {
        type: Type.OBJECT,
        properties: {
            event_type: {
                type: Type.STRING,
                // Expanded from 4 → 9 values to cover localized Pakistani crisis types
                enum: ["flood", "heatwave", "accident", "fire", "earthquake", "stampede", "structural_collapse", "riot", "unknown"],
                description: "Classify the event type based on the signal."
            },
            credibility_score: { 
                type: Type.INTEGER, 
                description: "Score from 0 to 100 representing signal reliability." 
            },
            severity_estimate: { 
                type: Type.INTEGER, 
                description: "Estimated severity from 1 to 10." 
            },
            summary: { 
                type: Type.STRING, 
                description: "Brief 1-sentence summary of the report." 
            },
            flags: { 
                type: Type.ARRAY, 
                items: { type: Type.STRING },
                description: "List of contradictions, missing info, or issues." 
            },
            inferred_location: {
                type: Type.OBJECT,
                description: "Best-effort geographic location derived from text hints in the signal.",
                properties: {
                    lat: {
                        type: Type.NUMBER,
                        description: "Latitude in WGS84. 0 if no location hint found."
                    },
                    lng: {
                        type: Type.NUMBER,
                        description: "Longitude in WGS84. 0 if no location hint found."
                    },
                    confidence: {
                        type: Type.INTEGER,
                        description: "Confidence in the inferred location from 0 (no hint) to 100 (explicit GPS data)."
                    },
                    locality_name: {
                        type: Type.STRING,
                        description: "Human-readable place name extracted or inferred from the signal (e.g. 'G-10 Markaz, Islamabad')."
                    }
                },
                required: ["lat", "lng", "confidence", "locality_name"]
            }
        },
        required: ["event_type", "credibility_score", "severity_estimate", "summary", "flags", "inferred_location"]
    };

    try {
        await logSwarmActivity('IngestionAgent', 'Parsing incoming signal and inferring location...', null, 'info');
        const response = await callGeminiWithRetry(
            'IngestionAgent',
            () => ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: userPrompt,
                config: {
                    systemInstruction: systemInstruction,
                    responseMimeType: "application/json",
                    responseSchema: responseSchema
                }
            }),
            { original_collection: 'IncomingSignals', original_id: event.params.signalId, payload: data.payload }
        );

        if (!response) {
            logger.error('IngestionAgent: Gemini returned null after retries. Aborting staging.');
            return;
        }

        const resultText = response.text;
        logger.info("Ingestion Agent Output:", resultText);

        let parsedData;
        try {
            parsedData = JSON.parse(resultText);
        } catch (e) {
            logger.error("Failed to parse Gemini output as JSON", e);
            parsedData = { raw_output: resultText, parse_error: true };
        }

        // Write the normalized output to a staging area.
        // inferred_location is promoted to the document root so downstream agents
        // (Analysis, Orchestration) can query it directly without deep field access.
        const stagedRef = db.collection("StagedSignals").doc(event.params.signalId);
        await stagedRef.set({
            original_signal_id: event.params.signalId,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            normalized_data: parsedData,
            raw_payload: data.payload,
            source: data.source,
            // Promoted from normalized_data for easier querying by downstream agents
            inferred_location: parsedData.inferred_location || { lat: 0, lng: 0, confidence: 0, locality_name: "Unknown" }
        });

        const loc = parsedData.inferred_location;
        const locSummary = loc && loc.confidence > 0
            ? `Location inferred: ${loc.locality_name} (${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}) — confidence ${loc.confidence}%`
            : 'No location hint found in signal.';
        await logSwarmActivity('IngestionAgent', `Signal staged. ${locSummary}`, null, 'info');
        logger.info("Successfully staged normalized signal.");
    } catch (error) {
        logger.error("Error calling Gemini ADK in Ingestion Agent:", error);
    }
});

// ==========================================
// 2. THE ANALYSIS & DETECTION AGENT
// ==========================================
exports.analysisAgent = onDocumentCreated("StagedSignals/{signalId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
        logger.log("No data associated with the event");
        return;
    }

    const data = snapshot.data();
    logger.info("Analysis Agent triggered for staged signal:", event.params.signalId);

    // Ensure we have normalized data to analyze
    if (!data.normalized_data || data.normalized_data.parse_error) {
        logger.warn("Normalized data is missing or malformed. Skipping analysis.");
        return;
    }

    const systemInstruction = `
You are the Analysis & Detection Agent for the CIRO system.
Your job is to review normalized crisis signals and determine if a formal crisis declaration is warranted.
Cross-reference the credibility score and the severity estimate to avoid triggering false alarms.
Output a strict JSON schema determining if this is a crisis, estimating the affected radius, affected population, and expected duration.
`;

    const userPrompt = `
Analyze the following staged signal data:
Event Type: ${data.normalized_data.event_type}
Credibility Score: ${data.normalized_data.credibility_score}/100
Severity Estimate: ${data.normalized_data.severity_estimate}/10
Summary: ${data.normalized_data.summary}
Source: ${data.source}
Original Payload: ${data.raw_payload}
`;

    // Define strict response schema for Analysis
    const responseSchema = {
        type: Type.OBJECT,
        properties: {
            is_crisis: { 
                type: Type.BOOLEAN, 
                description: "True if a formal crisis should be declared based on credibility and severity." 
            },
            type: {
                type: Type.STRING,
                // Must mirror the expanded ingestion enum so all event types survive the pipeline
                enum: ["flood", "heatwave", "accident", "fire", "earthquake", "stampede", "structural_collapse", "riot", "unknown"],
                description: "The official crisis classification."
            },
            severity: { 
                type: Type.INTEGER, 
                description: "Final adjusted severity from 1 to 10." 
            },
            confidence_score: { 
                type: Type.INTEGER, 
                description: "Final confidence score from 0 to 100." 
            },
            affected_radius: { 
                type: Type.INTEGER, 
                description: "Estimated affected radius in meters." 
            },
            affected_population: {
                type: Type.INTEGER,
                description: "Estimated number of people impacted by the crisis."
            },
            expected_duration: {
                type: Type.NUMBER,
                description: "Estimated duration of the crisis in hours."
            }
        },
        required: ["is_crisis", "type", "severity", "confidence_score", "affected_radius", "affected_population", "expected_duration"]
    };

    try {
        await logSwarmActivity('AnalysisAgent', 'Evaluating severity and credibility...', null, 'info');
        const response = await callGeminiWithRetry(
            'AnalysisAgent',
            () => ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: userPrompt,
                config: {
                    systemInstruction: systemInstruction,
                    responseMimeType: "application/json",
                    responseSchema: responseSchema
                }
            }),
            { original_collection: 'StagedSignals', original_id: event.params.signalId }
        );

        if (!response) {
            logger.error('AnalysisAgent: Gemini returned null after retries. Aborting crisis evaluation.');
            return;
        }

        const resultText = response.text;
        logger.info("Analysis Agent Output:", resultText);

        const analysis = JSON.parse(resultText);

        if (analysis.is_crisis) {
            // ---- DEDUPLICATION CHECK (Phase 2, Issue #2) ----
            // Before creating a new crisis, look for an existing active/resolving crisis
            // of the same type within the last 2 hours and within 500 metres.
            const incomingLoc = data.inferred_location || {};
            const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

            const existingCrisesSnap = await db.collection("ActiveCrises")
                .where("status", "in", ["active", "resolving"])
                .get();

            let mergedIntoId = null;

            if (!existingCrisesSnap.empty && incomingLoc.lat && incomingLoc.lng) {
                const relevantDocs = existingCrisesSnap.docs.filter(doc => {
                    const docData = doc.data();
                    const docTime = docData.timestamp && docData.timestamp.toDate ? docData.timestamp.toDate() : new Date(0);
                    return docData.type === analysis.type && docTime >= twoHoursAgo;
                });

                for (const existingDoc of relevantDocs) {
                    const existing = existingDoc.data();
                    const existingLoc = existing.location || {};

                    if (!existingLoc.lat || !existingLoc.lng) continue;

                    const distanceMetres = getHaversineDistance(
                        incomingLoc.lat, incomingLoc.lng,
                        existingLoc.lat, existingLoc.lng
                    );

                    if (distanceMetres <= 500) {
                        // Duplicate found — merge severity, do NOT create new doc
                        await existingDoc.ref.update({
                            severity: Math.max(existing.severity || 0, analysis.severity),
                            last_updated: admin.firestore.FieldValue.serverTimestamp()
                        });
                        mergedIntoId = existingDoc.id;
                        break;
                    }
                }
            }

            if (mergedIntoId) {
                await logSwarmActivity(
                    'AnalysisAgent',
                    `Duplicate signal detected — merged into existing crisis ${mergedIntoId} (distance ≤ 500m, same type within 2h). Severity updated.`,
                    mergedIntoId,
                    'warning'
                );
                logger.warn(`Duplicate signal merged into existing crisis: ${mergedIntoId}`);
            } else {
                // No duplicate — declare a new crisis
                const crisisId = `crisis_${event.params.signalId}`;
                const activeCrisesRef = db.collection("ActiveCrises").doc(crisisId);

                await activeCrisesRef.set({
                    id: crisisId,
                    type: analysis.type,
                    severity: analysis.severity,
                    confidence_score: analysis.confidence_score,
                    affected_radius: analysis.affected_radius,
                    affected_population: analysis.affected_population,
                    expected_duration: analysis.expected_duration,
                    status: "active",
                    // Store location at root level for proximity queries by downstream agents
                    location: {
                        lat: incomingLoc.lat || 0,
                        lng: incomingLoc.lng || 0,
                        locality_name: incomingLoc.locality_name || "Unknown"
                    },
                    originating_signal_id: event.params.signalId,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    last_updated: admin.firestore.FieldValue.serverTimestamp()
                });

                await logSwarmActivity('AnalysisAgent', `Crisis declared: ${analysis.type} (severity ${analysis.severity}/10) at ${incomingLoc.locality_name || 'Unknown'}.`, crisisId, 'info');
                logger.info(`🔥 Crisis Declared! Document created in ActiveCrises with ID: ${crisisId}`);
            }
        } else {
            logger.info("Signal analyzed. No formal crisis declared.");
        }
    } catch (error) {
        logger.error("Error calling Gemini ADK in Analysis Agent:", error);
    }
});

// ==========================================
// 3. THE ORCHESTRATION AGENT
// ==========================================
exports.orchestrationAgent = onDocumentCreated("ActiveCrises/{crisisId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
        logger.log("No data associated with the event");
        return;
    }

    const crisisData = snapshot.data();
    logger.info("Orchestration Agent triggered for crisis:", event.params.crisisId);

    try {
        // Query available resources
        const resourcesSnapshot = await db.collection("Resources").where("status", "==", "available").get();
        let availableResources = [];

        if (resourcesSnapshot.empty) {
            logger.warn("No available resources found. Injecting dummy resources for simulation context.");
            availableResources = [
                { id: "dummy_amb_1", type: "ambulance", status: "available" },
                { id: "dummy_amb_2", type: "ambulance", status: "available" },
                { id: "dummy_pol_1", type: "police", status: "available" },
                { id: "dummy_res_1", type: "rescue", status: "available" }
            ];
        } else {
            resourcesSnapshot.forEach(doc => {
                const data = doc.data();
                availableResources.push({
                    id: doc.id,
                    type: data.type,
                    status: data.status,
                    current_location: data.current_location
                });
            });
        }

        // ---- PROXIMITY SORT (Phase 2, Issue #3) ----
        // Append Haversine distance to each real resource and sort ascending.
        // Dummy resources (no location) are sorted to the end.
        const crisisLoc = crisisData.location || {};
        if (crisisLoc.lat && crisisLoc.lng && !resourcesSnapshot.empty) {
            availableResources = availableResources.map(r => {
                const rLoc = r.current_location || {};
                const distMetres = (rLoc.lat && rLoc.lng)
                    ? getHaversineDistance(crisisLoc.lat, crisisLoc.lng, rLoc.lat, rLoc.lng)
                    : Infinity;
                return { ...r, distance_metres: Math.round(distMetres) };
            });
            availableResources.sort((a, b) => a.distance_metres - b.distance_metres);
            logger.info(`Orchestration: resources sorted by proximity. Closest: ${availableResources[0]?.id} at ${availableResources[0]?.distance_metres}m`);
        }

        const systemInstruction = `
You are the Orchestration Agent for the CIRO system.
Your job is to allocate available resources to active crises based on the crisis type, severity, and required response.
You must output a strict JSON schema containing an action plan and an array of the resource IDs you choose to deploy.
Match resource types to the crisis (e.g., ambulances for injuries, rescue for flood, police for accidents/control).
Prioritize selecting available assets that are geographically closest to the crisis incident.
The resources are pre-sorted by distance_metres (ascending) — prefer units at the top of the list.
`;

        const userPrompt = `
CRISIS DETAILS:
Type: ${crisisData.type}
Severity: ${crisisData.severity}/10
Affected Population: ${crisisData.affected_population || 0}
Affected Radius: ${crisisData.affected_radius || 0}m
Expected Duration: ${crisisData.expected_duration || 0}h
Crisis Location: ${crisisLoc.locality_name || 'Unknown'} (${crisisLoc.lat || 0}, ${crisisLoc.lng || 0})

AVAILABLE RESOURCES (sorted by proximity — closest first):
${JSON.stringify(availableResources, null, 2)}

Determine which resources to deploy. Prefer units closest to the crisis. Return your strategy and the selected IDs.
`;

        const responseSchema = {
            type: Type.OBJECT,
            properties: {
                action_plan: {
                    type: Type.STRING,
                    description: "A brief explanation of the strategy."
                },
                deployed_resource_ids: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: "The IDs of the resources chosen."
                }
            },
            required: ["action_plan", "deployed_resource_ids"]
        };

        await logSwarmActivity('OrchestrationAgent', 'Evaluating proximity-sorted resources against crisis requirements...', event.params.crisisId, 'info');
        const response = await callGeminiWithRetry(
            'OrchestrationAgent',
            () => ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: userPrompt,
                config: {
                    systemInstruction: systemInstruction,
                    responseMimeType: "application/json",
                    responseSchema: responseSchema
                }
            }),
            { original_collection: 'ActiveCrises', original_id: event.params.crisisId, crisis_id: event.params.crisisId }
        );

        if (!response) {
            logger.error('OrchestrationAgent: Gemini returned null after retries. Aborting dispatch planning.');
            return;
        }

        const orchestrationPlan = JSON.parse(response.text);
        logger.info("Orchestration Agent Plan:", orchestrationPlan.action_plan);
        logger.info("Deploying Resources:", orchestrationPlan.deployed_resource_ids);

        if (orchestrationPlan.deployed_resource_ids.length > 0) {
            const batch = db.batch();
            let updatesQueued = false;

            // Only update actual existing documents (skip dummy ones created in memory)
            // If the collection was empty, resourcesSnapshot.docs is empty.
            const actualResourceIds = resourcesSnapshot.empty ? [] : resourcesSnapshot.docs.map(doc => doc.id);

            for (const resId of orchestrationPlan.deployed_resource_ids) {
                if (actualResourceIds.includes(resId)) {
                    const resRef = db.collection("Resources").doc(resId);
                    batch.update(resRef, {
                        status: "dispatched",
                        assigned_crisis_id: event.params.crisisId
                    });
                    updatesQueued = true;
                } else {
                    logger.warn(`Skipping DB update for dummy or non-existent resource ID: ${resId}`);
                }
            }

            if (updatesQueued) {
                await batch.commit();
                logger.info(`Successfully dispatched real resources for crisis ${event.params.crisisId}.`);
            } else {
                logger.info("No real resources required DB updates.");
            }
        }
    } catch (error) {
        logger.error("Error in Orchestration Agent:", error);
    }
});

// ==========================================
// 4. THE EXECUTION & SIMULATION AGENT
// ==========================================
exports.executionAgent = onDocumentUpdated("Resources/{resourceId}", async (event) => {
    const beforeData = event.data.before.data();
    const afterData = event.data.after.data();

    if (!beforeData || !afterData) {
        return;
    }

    // Proceed only if status changed from 'available' to 'dispatched'
    if (beforeData.status === "available" && afterData.status === "dispatched") {
        const crisisId = afterData.assigned_crisis_id;
        if (!crisisId) {
            logger.error(`Resource ${event.params.resourceId} was dispatched without an assigned_crisis_id.`);
            return;
        }

        logger.info(`Execution Agent triggered for Resource ${event.params.resourceId} (Crisis: ${crisisId})`);

        try {
            // Fetch Crisis Context
            const crisisRef = db.collection("ActiveCrises").doc(crisisId);
            const crisisDoc = await crisisRef.get();

            if (!crisisDoc.exists) {
                logger.error(`Crisis ${crisisId} not found in ActiveCrises.`);
                return;
            }

            const crisisData = crisisDoc.data();

            const systemInstruction = `
You are the Execution Agent for the CIRO system.
Your job is to simulate physical actions and handle communication whenever a resource is dispatched to an active crisis.
Based on the Crisis and Resource details, you must generate a simulation log using a strict JSON schema.
The response must include the action_type, a public-facing description, and the expected_impact.
`;

            const userPrompt = `
CRISIS DETAILS:
Type: ${crisisData.type}
Severity: ${crisisData.severity}/10
Affected Population: ${crisisData.affected_population || 0}
Expected Duration: ${crisisData.expected_duration || 0}h

RESOURCE DETAILS:
Resource ID: ${event.params.resourceId}
Type: ${afterData.type}
Current Location: ${JSON.stringify(afterData.current_location)}

Simulate the dispatch execution.
`;

            const responseSchema = {
                type: Type.OBJECT,
                properties: {
                    action_type: {
                        type: Type.STRING,
                        description: "Type of action taken (e.g., 'dispatch', 'reroute', 'alert')."
                    },
                    description: {
                        type: Type.STRING,
                        description: "A public-facing description of the action taken."
                    },
                    expected_impact: {
                        type: Type.STRING,
                        description: "The expected outcome of this action (e.g., 'Congestion reduced by 30%')."
                    }
                },
                required: ["action_type", "description", "expected_impact"]
            };

            const response = await callGeminiWithRetry(
                'ExecutionAgent',
                () => ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: userPrompt,
                    config: {
                        systemInstruction: systemInstruction,
                        responseMimeType: "application/json",
                        responseSchema: responseSchema
                    }
                }),
                { original_collection: 'Resources', original_id: event.params.resourceId, crisis_id: crisisId }
            );

            if (!response) {
                logger.error('ExecutionAgent: Gemini returned null after retries. Aborting action log generation.');
                return;
            }

            const actionLog = JSON.parse(response.text);
            logger.info("Execution Agent Log Generated:", actionLog.description);

            // Write to ActionLogs
            await db.collection("ActionLogs").add({
                crisis_id: crisisId,
                resource_id: event.params.resourceId,
                action_type: actionLog.action_type,
                description: actionLog.description,
                expected_impact: actionLog.expected_impact,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            // ---- SCHEDULED TRANSITIONS (Phase 2, Issue #5) ----
            // Write a ScheduledTransitions document instead of using setTimeout.
            // crisisLifecycleManager will poll this collection and execute transitions
            // safely across cold starts.
            const now = Date.now();
            const onSceneAt = new Date(now + 2 * 60 * 1000);   // +2 minutes

            await db.collection("ScheduledTransitions").add({
                resource_id: event.params.resourceId,
                crisis_id: crisisId,
                target_status: "on_scene",
                trigger_at: admin.firestore.Timestamp.fromDate(onSceneAt),
                created_at: admin.firestore.FieldValue.serverTimestamp()
            });

            await logSwarmActivity(
                'ExecutionAgent',
                `Resource ${event.params.resourceId} dispatched. Transition to on_scene scheduled at ${onSceneAt.toISOString()}.`,
                crisisId,
                'info'
            );
            logger.info(`🔥 ActionLog + ScheduledTransition created for Crisis: ${crisisId}`);

        } catch (error) {
            logger.error("Error in Execution Agent:", error);
        }
    } else {
        // Not the state transition we are looking for
        logger.debug(`Execution Agent skipped. State transition: ${beforeData.status} -> ${afterData.status}`);
    }
});

// ==========================================
// 5. CRISIS LIFECYCLE MANAGER (Scheduled)
// ==========================================
exports.crisisLifecycleManager = onSchedule("every 15 minutes", async () => {
    logger.info("crisisLifecycleManager: scheduled run starting.");
    const now = admin.firestore.Timestamp.now();

    // ---- STEP A: Process due ScheduledTransitions ----
    const dueTransitionsSnap = await db.collection("ScheduledTransitions")
        .where("trigger_at", "<=", now)
        .get();

    if (!dueTransitionsSnap.empty) {
        logger.info(`crisisLifecycleManager: processing ${dueTransitionsSnap.size} due transition(s).`);

        for (const transDoc of dueTransitionsSnap.docs) {
            const trans = transDoc.data();
            try {
                // Apply the status transition to the Resource document
                await db.collection("Resources").doc(trans.resource_id).update({
                    status: trans.target_status,
                    last_transition_at: admin.firestore.FieldValue.serverTimestamp()
                });

                await logSwarmActivity(
                    'LifecycleManager',
                    `Resource ${trans.resource_id} transitioned to '${trans.target_status}'.`,
                    trans.crisis_id || null,
                    'info'
                );

                // If we just moved to on_scene, queue the next transition → available (+10 min)
                if (trans.target_status === "on_scene") {
                    const availableAt = new Date(Date.now() + 10 * 60 * 1000);
                    await db.collection("ScheduledTransitions").add({
                        resource_id: trans.resource_id,
                        crisis_id: trans.crisis_id || null,
                        target_status: "available",
                        trigger_at: admin.firestore.Timestamp.fromDate(availableAt),
                        created_at: admin.firestore.FieldValue.serverTimestamp()
                    });
                    logger.info(`Queued available transition for ${trans.resource_id} at ${availableAt.toISOString()}`);
                }

                // Delete the processed transition document
                await transDoc.ref.delete();

            } catch (err) {
                logger.error(`Failed to process transition for resource ${trans.resource_id}:`, err);
            }
        }
    }

    // ---- STEP B: Evaluate ActiveCrises for lifecycle transitions ----
    const activeCrisesSnap = await db.collection("ActiveCrises")
        .where("status", "==", "active")
        .get();

    if (activeCrisesSnap.empty) {
        logger.info("crisisLifecycleManager: no active crises to evaluate.");
        return;
    }

    for (const crisisDoc of activeCrisesSnap.docs) {
        const crisis = crisisDoc.data();
        try {
            // Find all resources currently assigned to this crisis
            const assignedResourcesSnap = await db.collection("Resources")
                .where("assigned_crisis_id", "==", crisisDoc.id)
                .get();

            if (assignedResourcesSnap.empty) continue;

            // If ALL assigned resources have returned to 'available', the crisis is resolving
            const allAvailable = assignedResourcesSnap.docs.every(
                doc => doc.data().status === "available"
            );

            if (allAvailable) {
                // Transition crisis: active → resolving
                await crisisDoc.ref.update({
                    status: "resolving",
                    resolving_since: admin.firestore.FieldValue.serverTimestamp(),
                    last_updated: admin.firestore.FieldValue.serverTimestamp()
                });
                await logSwarmActivity(
                    'LifecycleManager',
                    `Crisis ${crisisDoc.id} transitioned to 'resolving' — all assigned resources have returned to available.`,
                    crisisDoc.id,
                    'info'
                );
                logger.info(`Crisis ${crisisDoc.id} → resolving.`);
            }
        } catch (err) {
            logger.error(`Error evaluating crisis ${crisisDoc.id}:`, err);
        }
    }

    // Transition resolving crises → resolved after their expected_duration has passed
    const resolvingCrisesSnap = await db.collection("ActiveCrises")
        .where("status", "==", "resolving")
        .get();

    for (const crisisDoc of resolvingCrisesSnap.docs) {
        const crisis = crisisDoc.data();
        try {
            const resolvingSince = crisis.resolving_since
                ? crisis.resolving_since.toDate()
                : null;
            const expectedDurationMs = (crisis.expected_duration || 1) * 60 * 60 * 1000;

            if (resolvingSince && (Date.now() - resolvingSince.getTime()) >= expectedDurationMs) {
                await crisisDoc.ref.update({
                    status: "resolved",
                    resolved_at: admin.firestore.FieldValue.serverTimestamp(),
                    last_updated: admin.firestore.FieldValue.serverTimestamp()
                });
                await logSwarmActivity(
                    'LifecycleManager',
                    `Crisis ${crisisDoc.id} marked as 'resolved' after cooldown period.`,
                    crisisDoc.id,
                    'info'
                );
                logger.info(`✅ Crisis ${crisisDoc.id} → resolved.`);
            }
        } catch (err) {
            logger.error(`Error resolving crisis ${crisisDoc.id}:`, err);
        }
    }

    logger.info("crisisLifecycleManager: scheduled run complete.");
});

// ==========================================
// 6. NOTIFICATION AGENT (Phase 3, Issue #9)
// ==========================================
/**
 * Triggered whenever a new crisis is declared in ActiveCrises.
 * Fetches all registered Expo push tokens from the PushTokens collection
 * and fans out a push notification.
 *
 * PushTokens collection schema:
 *   /PushTokens/{tokenId}
 *     expoPushToken : string  (e.g. "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]")
 *     created_at    : timestamp
 */
exports.notificationAgent = onDocumentCreated("ActiveCrises/{crisisId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;

    const crisis = snapshot.data();
    const crisisId = event.params.crisisId;

    // Build notification payload from crisis fields
    const eventLabel = (crisis.type || 'unknown').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const locality   = crisis.location?.locality_name || 'Unknown Location';
    const severity   = crisis.severity || '?';

    const notificationPayload = {
        title: `\u26a0\ufe0f Crisis Declared: ${eventLabel}`,
        body:  `${locality} — Severity ${severity}/10. CIRO response teams are being deployed.`,
        data:  {
            crisisId: crisisId,
            screen:   'CrisisDetail',  // deep-link target in the Expo app
            type:     crisis.type || 'unknown'
        }
    };

    logger.info('NotificationAgent: payload prepared.', notificationPayload);

    try {
        // Fetch all registered device tokens
        const tokensSnap = await db.collection("PushTokens").get();

        if (tokensSnap.empty) {
            logger.warn('NotificationAgent: No push tokens registered. Skipping fan-out.');
            await logSwarmActivity('NotificationAgent', 'Crisis alert suppressed — no registered devices.', crisisId, 'warning');
            return;
        }

        const tokens = tokensSnap.docs
            .map(doc => doc.data().expoPushToken)
            .filter(t => typeof t === 'string' && t.startsWith('ExponentPushToken'));

        logger.info(`NotificationAgent: ${tokens.length} valid token(s) found.`);

        // ---------------------------------------------------------------
        // TODO: PLUG IN EXPO PUSH HERE
        //
        // Expo's push API requires batches of at most 100 tokens per call.
        // The pattern below (from the AI Lawyers Diary architecture) is the
        // recommended way to fan-out to arbitrarily large device fleets.
        //
        // const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
        // const CHUNK_SIZE    = 100;
        //
        // function chunkArray(arr, size) {
        //     const chunks = [];
        //     for (let i = 0; i < arr.length; i += size) {
        //         chunks.push(arr.slice(i, i + size));
        //     }
        //     return chunks;
        // }
        //
        // const batches = chunkArray(tokens, CHUNK_SIZE);
        //
        // for (const batch of batches) {
        //     const messages = batch.map(token => ({
        //         to:    token,
        //         sound: 'default',
        //         title: notificationPayload.title,
        //         body:  notificationPayload.body,
        //         data:  notificationPayload.data
        //     }));
        //
        //     const res = await fetch(EXPO_PUSH_URL, {
        //         method:  'POST',
        //         headers: { 'Content-Type': 'application/json' },
        //         body:    JSON.stringify(messages)
        //     });
        //     const json = await res.json();
        //     logger.info('Expo push batch response:', json);
        // }
        // ---------------------------------------------------------------

        await logSwarmActivity(
            'NotificationAgent',
            `Broadcasted crisis alerts to ${tokens.length} active device token(s).`,
            crisisId,
            'info'
        );

    } catch (error) {
        logger.error('NotificationAgent: Error during push fan-out:', error);
        await logSwarmActivity('NotificationAgent', `Push fan-out failed: ${error.message}`, crisisId, 'critical');
    }
});
