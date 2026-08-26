import { Agent, RunContext, Logger } from "../../core/agent/types";
// Shared with pre-inspection so the two stages cannot drift into separate copies of the same route map.
import {
  buildInspectUrlsFromRequest,
  type RouteSource,
} from "../../core/inspection/RouteIntentResolver";
import { PlaywrightMcpClient } from "../../core/mcp/PlaywrightMcpClient";
import { EmbeddingClient } from "../../core/llm/EmbeddingClient";
import { insertElementSignature } from "../../core/db/db";
import {
  toolResultToText,
  normalizeLocator,
  findBestRefMultiRole,
  findByRef,
  toPagePath,
  buildSignatureText,
  waitForPageStable,
  mergePageRefs,
  mcpRefOf,
  findEquallyMatchingRefs,
  FILLABLE_ROLES,
  CLICKABLE_ROLES,
  SELECTABLE_ROLES,
  type RefItem,
} from "../../core/utils/mcp-helpers";
import { stepKeyForIndex } from "../../core/utils/stepKeys";
import { getLocatorStats } from "../../core/db/db";
import { preferReliableLocator } from "../../core/learn/priors";
import {
  stepsNeedingWalk,
  walkPlanForLocators,
  type WalkedStep,
} from "../../core/inspection/PlanWalker";

/* ─── agent-specific helpers ─── */

function cleanExpectVisibleTarget(target: string): string {
  return target
    .replace(
      /\b(heading|title|text|label|form|page|section|element|area)\b/gi,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function stripRolePrefixesFromTarget(target: string): string {
  // Remove role prefixes like "textbox \"Search\"" → "Search"
  // Handle format like: heading "Welcome to TechStore" → Welcome to TechStore
  const quoteMatch = target.match(/^(heading|textbox|link|button|combobox|checkbox|radio|listbox|menuitem|tab|role)\s+"([^"]+)"/i);
  if (quoteMatch) {
    return quoteMatch[2].trim();
  }
  // Handle format like: heading 'Welcome to TechStore' → Welcome to TechStore  
  const singleQuoteMatch = target.match(/^(heading|textbox|link|button|combobox|checkbox|radio|listbox|menuitem|tab|role)\s+'([^']+)'/i);
  if (singleQuoteMatch) {
    return singleQuoteMatch[2].trim();
  }
  // Handle format like: heading Welcome → Welcome
  const rolePattern = /^(heading|textbox|link|button|combobox|checkbox|radio|listbox|menuitem|tab|role)\s+["']?/i;
  let cleaned = target.replace(rolePattern, "");
  cleaned = cleaned.replace(/^["']|["']$/g, "").trim();
  // Remove surrounding quotes
  while (cleaned.length >= 2 && (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
    (cleaned.startsWith('"') && cleaned.endsWith('"'))
  )) {
    cleaned = cleaned.slice(1, -1);
  }
  return cleaned.trim();
}

function normalizeHintText(value: string | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Which pages must the inspector browse to resolve this plan's locators? (G3.3)
 *
 * The answer is mostly written on the plan itself: a step runs on whatever page the preceding `goto`
 * navigated to, so the plan's own `goto` targets ARE the page list. The app's declared routes are
 * consulted as a secondary source, for the LLM plans that assert something before navigating to it.
 *
 * This replaced six keyword rules (`products|catalog|shop|search|... -> /products`, `cart|checkout|... ->
 * /cart`, and so on) that were the same demo-web map G3.1 removed from `RouteIntentResolver`, duplicated
 * here. On any other app they sent the inspector to URLs that do not exist, and a 404's inventory is
 * empty — so locator resolution silently had nothing to resolve against.
 */
function inferInspectPagesFromPlan(
  steps: any[],
  requestText: string,
  baseUrl: string,
  pack?: RouteSource | null
): string[] {
  const candidates = new Set<string>();
  const add = (path: string) => {
    try {
      candidates.add(new URL(path, baseUrl).toString());
    } catch {
      // ignore invalid URLs
    }
  };

  add(baseUrl);

  // 1. The plan's own navigations - authoritative, and free of inference.
  for (const step of steps) {
    if (step?.action === "goto" && typeof step.url === "string") {add(step.url);}
  }

  // 2. Routes the APP declares, matched to the request. Shared with pre-inspection so the two stages
  //    cannot drift apart (they were separately-maintained copies of the same demo-web map).
  if (pack) {
    for (const url of buildInspectUrlsFromRequest(requestText, baseUrl, undefined, pack)) {add(url);}
  }

  return Array.from(candidates);
}

/* ─── agent ─── */

export class UiInspectorAgent implements Agent {
  name = "UiInspectorAgent";

  async run(ctx: RunContext, logger: Logger): Promise<void> {
    if (!ctx.testPlan) {
      logger.log("UI Inspector: no testPlan found; skipping MCP inspection.");
      return;
    }
    if (!ctx.effectiveBaseUrl) throw new Error("effectiveBaseUrl missing");

    if (!ctx.projectId) {
      logger.log(
        "UI Inspector: projectId missing (DB not initialized?). Skipping signature storage."
      );
    }

    const embedder = new EmbeddingClient();
    const embeddingsEnabled = embedder.isConfigured();
    if (!embeddingsEnabled) {
      logger.log(
        "UI Inspector: OPENAI_EMBED_MODEL not configured; will skip embedding+DB signature insert."
      );
    }

    logger.log("UI Inspector: starting MCP client (headless)");
    const mcp = await PlaywrightMcpClient.connect({
      headless: true,
      caps: ["core", "testing"],
      snapshotMode: "full",
    });

    ctx.stepLocators = {};

    try {
      // Collect all steps from all test cases, tracking which test case each step belongs to
      const allSteps: Array<{ testCaseIndex: number; stepIndex: number; step: any }> = [];
      for (let tcIdx = 0; tcIdx < ctx.testPlan.testCases.length; tcIdx++) {
        const tc = ctx.testPlan.testCases[tcIdx];
        for (let sIdx = 0; sIdx < tc.steps.length; sIdx++) {
          allSteps.push({ testCaseIndex: tcIdx, stepIndex: sIdx, step: tc.steps[sIdx] });
        }
      }

      if (allSteps.length === 0) {
        logger.log("UI Inspector: no steps found in test plan; skipping.");
        return;
      }

      // Get the first goto URL from any test case
      const firstGotoStep = allSteps.find((s) => s.step.action === "goto")?.step;
      if (!firstGotoStep) {
        logger.log("UI Inspector: no goto step found; skipping.");
        return;
      }

      const steps = allSteps.map((s) => s.step); // For page inference

      const gotoUrl = firstGotoStep.url.startsWith("http")
        ? firstGotoStep.url
        : new URL(firstGotoStep.url, ctx.effectiveBaseUrl).toString();

      const pageCandidates = inferInspectPagesFromPlan(
        steps,
        ctx.requestText ?? "",
        ctx.effectiveBaseUrl,
        ctx.knowledgePack
      );

      const uniquePageUrls = [gotoUrl, ...pageCandidates].filter(
        (url, index, list) => list.indexOf(url) === index
      );

      let currentPageUrl = "";
      const allRefs: RefItem[] = [];
      let mainPagePath = toPagePath(gotoUrl, ctx.effectiveBaseUrl);

      for (const pageUrl of uniquePageUrls) {
        try {
          await mcp.callTool("browser_navigate", { url: pageUrl });
          currentPageUrl = pageUrl;
          logger.log(`UI Inspector: navigated to ${pageUrl}`);

          const { snapshotText, refs } = await waitForPageStable(mcp, logger, {
            label: "UI Inspector",
          });

          if (pageUrl === gotoUrl) {
            mainPagePath = toPagePath(gotoUrl, ctx.effectiveBaseUrl);
            const preview = snapshotText.split(/\r?\n/).slice(0, 60).join("\n");
            logger.log(
              "UI Inspector: snapshot preview (first 60 lines):\n" + preview
            );
          }

          // Namespaced by page — a raw MCP ref id is only unique within one snapshot (see `mergePageRefs`).
          mergePageRefs(allRefs, refs, pageUrl);

          logger.log(
            `UI Inspector: parsed refs count = ${allRefs.length} after inspecting ${pageUrl}`
          );
        } catch (e: any) {
          logger.log(
            `UI Inspector: failed to inspect ${pageUrl} — ${e?.message ?? String(e)}. Continuing...`
          );
        }
      }

      if (allRefs.length === 0) {
        logger.log("UI Inspector: no refs found on inspected pages; skipping.");
        return;
      }

      const maybeStoreBaseline = async (input: {
        stepIndex: number;
        /** D7: two test cases used to share `plan-step-1`; the baseline must name its own case. */
        testCaseIndex?: number;
        action: string;
        role?: string;
        name?: string;
        locator: string;
        pageUrl?: string;
      }) => {
        if (!ctx.projectId) return;
        if (!embeddingsEnabled) return;

        const stepKey = stepKeyForIndex(input.stepIndex, input.testCaseIndex ?? 0);
        const pagePath = input.pageUrl
          ? toPagePath(input.pageUrl, ctx.effectiveBaseUrl!)
          : mainPagePath;
        const sigText = buildSignatureText({
          stepKey,
          pageUrl: pagePath,
          action: input.action,
          role: input.role,
          name: input.name,
          locator: input.locator,
        });

        try {
          const embedding = await embedder.embedOne(sigText);
          await insertElementSignature({
            projectId: ctx.projectId,
            stepKey,
            pageUrl: pagePath,
            role: input.role,
            name: input.name,
            locator: input.locator,
            signatureText: sigText,
            embedding,
          });
          logger.log(
            `UI Inspector: stored baseline signature for ${stepKey}`
          );
        } catch (e: any) {
          logger.log(
            `UI Inspector: embedding/DB insert failed for ${stepKey}: ${e?.message ?? String(e)}`
          );
        }
      };

      const ensurePageForRef = async (ref: string) => {
        const item = findByRef(allRefs, ref);
        if (!item?.pageUrl || item.pageUrl === currentPageUrl) return;

        await mcp.callTool("browser_navigate", { url: item.pageUrl });
        currentPageUrl = item.pageUrl;
        logger.log(`UI Inspector: switched to ${item.pageUrl} for locator generation`);
        await waitForPageStable(mcp, logger, { label: "UI Inspector" });
      };

      // Generate locators for ALL test cases (not just the first one)
      // stepLocators will be keyed by "tcIdx-stepIdx" to handle multiple test cases
      for (let tcIdx = 0; tcIdx < ctx.testPlan.testCases.length; tcIdx++) {
        const tc = ctx.testPlan.testCases[tcIdx];
        const tcSteps = tc.steps;

        logger.log(`UI Inspector: generating locators for test case ${tcIdx + 1}/${ctx.testPlan.testCases.length} ("${tc.title}")`);

        // ── G3.10: state-aware pass, only where the pooled inventory cannot honestly answer ──
        // Pre-inspection sees every page in its INITIAL state. When a step's element isn't on the route
        // that step runs on — because the plan got there by clicking, or because the page looks different
        // once the plan has acted on it — the pooled search below will reach for some *other* page's
        // element, and a wrong locator is worse than none (codegen's role fallback would have worked).
        // So: ask first whether the pool suffices, and only then pay for a live walk of the plan.
        let walked = new Map<number, WalkedStep>();
        const needWalk = stepsNeedingWalk(tcSteps, ctx.pageInventory ?? [], ctx.effectiveBaseUrl);
        if (needWalk.length) {
          logger.log(
            `UI Inspector: ${needWalk.length} step(s) cannot be resolved from the pre-inspected pages ` +
              `(steps ${needWalk.map((n) => n + 1).join(", ")}) — walking the plan live.`
          );
          walked = await walkPlanForLocators({
            mcp,
            steps: tcSteps,
            baseUrl: ctx.effectiveBaseUrl,
            logger,
          });
          currentPageUrl = ""; // the walk moved the browser; force the pooled path to re-navigate
          logger.log(`UI Inspector: walk resolved ${walked.size} step(s) against their real page.`);
        }

        for (let i = 0; i < tcSteps.length; i++) {
          const s = tcSteps[i];
          const locatorKey = `${tcIdx}-${i + 1}`; // e.g., "0-1", "0-2", "1-1", etc.

          // A locator resolved on the page the step will actually be on beats anything from the pool.
          const fromWalk = walked.get(i);
          if (fromWalk) {
            ctx.stepLocators[locatorKey] = fromWalk.locator;
            await maybeStoreBaseline({
              stepIndex: i,
              testCaseIndex: tcIdx,
              action: s.action,
              role: fromWalk.role,
              name: fromWalk.name,
              locator: fromWalk.locator,
              pageUrl: fromWalk.pageUrl,
            });
            continue;
          }

          /* ── fill ── */
          if (s.action === "fill") {
            const cleanField = stripRolePrefixesFromTarget(s.field);
            const ref = findBestRefMultiRole(allRefs, FILLABLE_ROLES, cleanField);
            if (!ref) {
              logger.log(
                `UI Inspector [${locatorKey}]: no input ref found for field="${s.field}" (cleaned: "${cleanField}")`
              );
              continue;
            }

            await ensurePageForRef(ref);
            const locRes = await mcp.callTool("browser_generate_locator", {
              ref: mcpRefOf(ref),
            });
            const locatorStr = normalizeLocator(toolResultToText(locRes).trim());

            if (locatorStr) {
              ctx.stepLocators[locatorKey] = locatorStr;
              const item = findByRef(allRefs, ref);
              logger.log(
                `UI Inspector [${locatorKey}]: fill "${s.field}" = ${locatorStr}`
              );
              await maybeStoreBaseline({
                stepIndex: i,
              testCaseIndex: tcIdx,
                action: "fill",
                role: item?.role ?? "textbox",
                name: item?.name ?? s.field,
                locator: locatorStr,
                pageUrl: item?.pageUrl,
              });
            } else {
              logger.log(
                `UI Inspector [${locatorKey}]: could not normalize locator for fill "${s.field}".`
              );
            }
          }

          /* ── click ── */
          if (s.action === "click") {
            let targetName = String(s.target ?? "");
            targetName = stripRolePrefixesFromTarget(targetName);
            const cleanTarget = targetName.replace(/button/gi, "").trim() || targetName;
            const ref = findBestRefMultiRole(allRefs, CLICKABLE_ROLES, cleanTarget);

            if (!ref) {
              logger.log(
                `UI Inspector [${locatorKey}]: no clickable ref found for target="${s.target}" (cleaned: "${cleanTarget}")`
              );
              continue;
            }

            await ensurePageForRef(ref);
            const locRes = await mcp.callTool("browser_generate_locator", {
              ref: mcpRefOf(ref),
            });
            let locatorStr = normalizeLocator(toolResultToText(locRes).trim());

            // ── G4.3: when several elements match equally well, let history break the tie ──
            // `findBestRefMultiRole` returns the FIRST equally-good match, which is arbitrary — and that
            // arbitrariness IS the `strict-mode` failure class (demo-web prompt 14 hit it). The extra
            // locator generations are paid for only where a real ambiguity exists, and the resolver's
            // choice is overridden only by a record `preferReliableLocator` judges decisive. No history,
            // no change.
            if (locatorStr && ctx.projectId) {
              const tied = findEquallyMatchingRefs(allRefs, CLICKABLE_ROLES, cleanTarget);
              if (tied.length > 1) {
                const byLocator = new Map<string, string>([[locatorStr, ref]]);
                for (const alt of tied) {
                  if (alt.ref === ref) {continue;}
                  await ensurePageForRef(alt.ref);
                  const altRes = await mcp.callTool("browser_generate_locator", {
                    ref: mcpRefOf(alt.ref),
                  });
                  const altLoc = normalizeLocator(toolResultToText(altRes).trim());
                  if (altLoc && !byLocator.has(altLoc)) {byLocator.set(altLoc, alt.ref);}
                }
                if (byLocator.size > 1) {
                  const stats = await getLocatorStats(ctx.projectId, stepKeyForIndex(i, tcIdx));
                  const better = preferReliableLocator(
                    [...byLocator.keys()],
                    new Map(stats.map((st) => [st.locator, st]))
                  );
                  if (better && better !== locatorStr) {
                    logger.log(
                      `UI Inspector [${locatorKey}]: ${byLocator.size} elements match "${cleanTarget}" ` +
                        `equally; history prefers ${better} over ${locatorStr}.`
                    );
                    locatorStr = better;
                  }
                }
                await ensurePageForRef(ref);
              }
            }

            if (locatorStr) {
              ctx.stepLocators[locatorKey] = locatorStr;
              const item = findByRef(allRefs, ref);
              logger.log(
                `UI Inspector [${locatorKey}]: click "${s.target}" = ${locatorStr}`
              );
              await maybeStoreBaseline({
                stepIndex: i,
              testCaseIndex: tcIdx,
                action: "click",
                role: item?.role ?? "button",
                name: item?.name ?? cleanTarget,
                locator: locatorStr,
                pageUrl: item?.pageUrl,
              });
            } else {
              logger.log(
                `UI Inspector [${locatorKey}]: could not normalize locator for click "${s.target}".`
              );
            }
          }

          /* ── select ── */
          if (s.action === "select") {
            const cleanField = stripRolePrefixesFromTarget(s.field || "");
            const ref = findBestRefMultiRole(allRefs, SELECTABLE_ROLES, cleanField);

            if (!ref) {
              logger.log(
                `UI Inspector [${locatorKey}]: no selectable ref found for field="${s.field}" (cleaned: "${cleanField}")`
              );
              continue;
            }

            await ensurePageForRef(ref);
            const locRes = await mcp.callTool("browser_generate_locator", {
              ref: mcpRefOf(ref),
            });
            const locatorStr = normalizeLocator(toolResultToText(locRes).trim());

            if (locatorStr) {
              ctx.stepLocators[locatorKey] = locatorStr;
              const item = findByRef(allRefs, ref);
              logger.log(
                `UI Inspector [${locatorKey}]: select "${s.field}" = ${locatorStr}`
              );
              await maybeStoreBaseline({
                stepIndex: i,
              testCaseIndex: tcIdx,
                action: "select",
                role: item?.role ?? "combobox",
                name: item?.name ?? s.field,
                locator: locatorStr,
                pageUrl: item?.pageUrl,
              });
            } else {
              logger.log(
                `UI Inspector [${locatorKey}]: could not normalize locator for select "${s.field}".`
              );
            }
          }

          /* ── slider ── */
          if (s.action === "slider") {
            const cleanField = stripRolePrefixesFromTarget(s.field || "");
            const ref = findBestRefMultiRole(allRefs, ["slider"], cleanField);

            if (!ref) {
              logger.log(
                `UI Inspector [${locatorKey}]: no slider ref found for field="${s.field}" (cleaned: "${cleanField}")`
              );
              continue;
            }

            await ensurePageForRef(ref);
            const locRes = await mcp.callTool("browser_generate_locator", {
              ref: mcpRefOf(ref),
            });
            const locatorStr = normalizeLocator(toolResultToText(locRes).trim());

            if (locatorStr) {
              ctx.stepLocators[locatorKey] = locatorStr;
              const item = findByRef(allRefs, ref);
              logger.log(
                `UI Inspector [${locatorKey}]: slider "${s.field}" = ${locatorStr}`
              );
              await maybeStoreBaseline({
                stepIndex: i,
              testCaseIndex: tcIdx,
                action: "slider",
                role: item?.role ?? "slider",
                name: item?.name ?? s.field,
                locator: locatorStr,
                pageUrl: item?.pageUrl,
              });
            } else {
              logger.log(
                `UI Inspector [${locatorKey}]: could not normalize locator for slider "${s.field}".`
              );
            }
          }

          /* ── expectVisible ── */
          if (s.action === "expectVisible") {
            let targetName = String(s.target ?? "");
            targetName = stripRolePrefixesFromTarget(targetName);
            const cleanTarget = cleanExpectVisibleTarget(targetName);

            // Headings are preferred over links, but only at equal match quality — `findBestRefMultiRole`
            // tries exact across BOTH roles before substring across both, so the two must be passed in one
            // call. Asking for headings first and links only on a total miss is what broke the logout test:
            // the plan asserts "Login", the post-logout navbar has `link "Login"` exactly, and
            // `heading "Please Login"` on the page it had already left won on a substring.
            //
            // (The link half was once gated on a list of demo-web nav nouns — "products", "cart",
            // "orders", … — which bought nothing, since the match still has to succeed, and made
            // asserting any OTHER app's nav item fail.)
            let ref = findBestRefMultiRole(allRefs, ["heading", "link"], cleanTarget);

            if (!ref && cleanTarget !== targetName.trim()) {
              ref = findBestRefMultiRole(allRefs, ["heading", "link", "button"], targetName.trim());
            }

            if (!ref) {
              const searchText = cleanTarget.toLowerCase();
              const exactMatch = allRefs.find((r) => r.name.toLowerCase() === searchText);
              if (exactMatch) {
                ref = exactMatch.ref;
              } else {
                const containsMatch = allRefs.find((r) => r.name.toLowerCase().includes(searchText));
                if (containsMatch) ref = containsMatch.ref;
              }
            }

            if (!ref) {
              const words = cleanTarget
                .toLowerCase()
                .split(/\s+/)
                .filter((w) => w.length > 2);
              if (words.length <= 2) {
                for (const word of words) {
                  const match = allRefs.find((r) => r.name.toLowerCase().includes(word));
                  if (match) {
                    ref = match.ref;
                    break;
                  }
                }
              }
            }

            if (ref) {
              await ensurePageForRef(ref);
              const locRes = await mcp.callTool("browser_generate_locator", {
                ref: mcpRefOf(ref),
              });
              const locatorStr = normalizeLocator(toolResultToText(locRes).trim());

              if (locatorStr) {
                ctx.stepLocators[locatorKey] = locatorStr;
                const item = findByRef(allRefs, ref);
                logger.log(
                  `UI Inspector [${locatorKey}]: expectVisible "${targetName}" = ${locatorStr} [grounded to "${item?.name ?? "?"}"]`
                );
                await maybeStoreBaseline({
                  stepIndex: i,
              testCaseIndex: tcIdx,
                  action: "expectVisible",
                  role: item?.role ?? "heading",
                  name: item?.name ?? cleanTarget,
                  locator: locatorStr,
                  pageUrl: item?.pageUrl,
                });
              }
            } else {
              logger.log(
                `UI Inspector [${locatorKey}]: expectVisible target "${targetName}" not found in snapshot — test will use fallback locator`
              );
            }
          }
        }
      }
    } finally {
      logger.log("UI Inspector: closing MCP client");
      await mcp.close();
    }
  }
}