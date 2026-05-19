# Orchestration Agent Implementation Plan

This plan outlines the architecture and tasks for building the third agent in our Swarm: **The Orchestration Agent**.

## Proposed Changes

### [MODIFY] `d:\CIRO\backend\index.js` (Append)
We will append the new `orchestrationAgent` Cloud Function to the end of the file.

- **Trigger:** `onDocumentCreated("ActiveCrises/{crisisId}")`.
- **Role:** Review newly declared crises, evaluate available resources, and deploy them based on priority and type.
- **Logic:**
  1. Retrieve the `ActiveCrises` data from the snapshot.
  2. Perform a Firestore Query: `db.collection('Resources').where('status', '==', 'available').get()`.
  3. Format the available resources into a list. If the query returns 0 documents, we will generate a fallback/dummy array (2 ambulances, 1 police unit, 1 rescue team) to ensure the AI always has context to simulate the dispatch.
  4. Construct the prompt for `gemini-2.5-flash`, injecting both the crisis details and the available resources.
  5. Enforce a strict `responseSchema` for structured outputs:
     - `action_plan` (STRING)
     - `deployed_resource_ids` (ARRAY of STRINGS)
  6. Parse the AI's response, initialize a Firestore `db.batch()`, and loop over the `deployed_resource_ids`.
  7. Add an update operation to the batch for each selected resource to set `status: "dispatched"` and `assigned_crisis_id: event.params.crisisId`.
  8. Commit the batch write to Firestore.

## Open Questions

> [!WARNING]
> **Firestore Fallback**
> If the `Resources` collection is completely empty and we use the dummy array, those dummy resources won't actually exist in the database when we try to run the Firestore Batch update. To prevent the Batch update from crashing with "Document not found" errors, I will ensure the function checks if the chosen `deployed_resource_ids` actually exist in the original Firestore snapshot before attempting to update them. Is this approach acceptable?

## Verification Plan
1. Append the code cleanly without disrupting the existing Agents.
2. Review the structured output schema to ensure it strictly matches `action_plan` and `deployed_resource_ids`.
3. Stop and request your code review prior to deploying or moving on to the final agent.

If you approve of this approach and the fallback safety check, I will execute the code changes!
