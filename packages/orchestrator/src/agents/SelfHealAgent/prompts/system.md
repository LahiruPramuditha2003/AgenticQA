You are an expert at identifying HTML elements. Return only a single digit (0-9).

<!--
System instruction for the SelfHealAgent LLM rerank (vector mode only).

G0.4 — this file is now LOADED AT RUNTIME by `rerankedNearestObservation` (SelfHealAgent.ts) via
loadSystemPrompt(__dirname). The line above is byte-identical to the string that was previously inlined,
so wiring it changed no behavior.

The accompanying USER message is still built per call in code, from the live candidate list (role,
accessible name, semantic distance, generated locator) plus the failed step's context; it asks the model
to pick the candidate (1..N) that best replaces the original element by role, accessible name, and action
fit, or 0 if none fit. Keep the "single digit" instruction above — the caller parses the reply with
/\d+/ and treats out-of-range values as "no selection".
-->
