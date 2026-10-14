import { expect, test } from "@playwright/test";
import { inspectRuntimeCapabilities } from "./runtime-diagnostics";
import { assertUnavailableRuntime } from "./runtime-refusal";

test("Linux WebKit without storage estimate refuses backup before creating a worker", async ({
  page,
}) => {
  // TEMPORARY DIAGNOSTIC (reverted by the next commit): print the raw engine capability.
  await page.goto("/");
  const diagnostic = await page.evaluate(() => ({
    estimateType: typeof navigator.storage?.estimate,
    storageType: typeof navigator.storage,
    ua: navigator.userAgent,
  }));
  console.log(`DIAG-WEBKIT-CAPS ${JSON.stringify(diagnostic)}`);
  console.log(`DIAG-WEBKIT-RUNTIME ${JSON.stringify(await inspectRuntimeCapabilities(page))}`);
  // This is the unmodified Linux engine capability, never a synthetic quota fallback.
  await assertUnavailableRuntime(page);
  expect(await page.evaluate(() => typeof navigator.storage?.estimate)).toBe("undefined");
});
