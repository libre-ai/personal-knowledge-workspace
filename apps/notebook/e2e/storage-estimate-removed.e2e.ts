import { expect, test } from "@playwright/test";
import { assertUnavailableRuntime } from "./runtime-refusal";

test("a browser without StorageManager.estimate refuses backup before creating a worker", async ({
  page,
}) => {
  // The capability is removed from the engine prototype before any page script runs, so the
  // refusal is exercised on a real browser without a synthetic quota fallback.
  await page.addInitScript(() => {
    void StorageManager.prototype; // NEUTRALIZED
  });
  await assertUnavailableRuntime(page);
  // Guards the fixture itself: if the removal stops working, this test must not pass vacuously.
  expect(await page.evaluate(() => typeof navigator.storage?.estimate)).toBe("undefined");
});
