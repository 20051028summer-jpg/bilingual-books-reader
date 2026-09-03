import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { runChapterTranslation } from "../src/chapter-runner.js";

const paragraphs = Array.from({ length: 12 }, (_, id) => ({ id, text: `测试段落${id}，今天她拿起书本，打开窗户，看着窗外的树木。` }));
const metadata = { model: "qwen-flash", thinking: "disabled", targetDensity: 20 };
const answer = (batch) => ({ paragraphs: batch.map(({ id }) => ({ id, replacements: [] })) });

test("bounded parallel workers checkpoint every out-of-order batch without losing results", async () => {
  let active = 0;
  let peak = 0;
  let writing = 0;
  const snapshots = [];
  const result = await runChapterTranslation({ paragraphs, metadata, concurrency: 3,
    requestBatch: async (batch) => {
      peak = Math.max(peak, ++active);
      await delay(batch[0].id === 0 ? 25 : 3);
      active--;
      return answer(batch);
    },
    persist: async (checkpoint) => {
      assert.equal(++writing, 1, "checkpoint writes must be serialized");
      await delay(1);
      snapshots.push(structuredClone(checkpoint));
      writing--;
    },
  });
  assert.equal(peak, 3);
  assert.equal(result.error, null);
  assert.equal(result.snapshot.complete, true);
  assert.deepEqual(snapshots.map((item) => item.completedCount), [0, 2, 4, 6, 8, 10, 12]);
  assert.deepEqual(result.snapshot.mixedByParagraph.map(([id]) => id), paragraphs.map((p) => p.id));
});

test("quota failure stops new dispatch, drains successful in-flight work, and resumes only gaps", async () => {
  let disk;
  const submitted = [];
  const first = await runChapterTranslation({ paragraphs, metadata, concurrency: 3,
    persist: async (checkpoint) => { disk = structuredClone(checkpoint); },
    requestBatch: async (batch) => {
      submitted.push(batch[0].id);
      await delay(batch[0].id === 2 ? 2 : 15);
      if (batch[0].id === 2) throw new Error("insufficient quota");
      return answer(batch);
    },
  });
  assert.deepEqual(submitted, [0, 2, 4]);
  assert.equal(first.snapshot.completedCount, 4);
  assert.equal(first.snapshot.complete, false);
  assert.match(first.error.message, /quota/);
  const resumedIds = [];
  const resumed = await runChapterTranslation({ paragraphs, metadata, initial: disk, concurrency: 3,
    persist: async (checkpoint) => { disk = structuredClone(checkpoint); },
    requestBatch: async (batch) => { resumedIds.push(...batch.map((p) => p.id)); return answer(batch); },
  });
  assert.deepEqual(resumedIds.sort((a, b) => a - b), [2, 3, 6, 7, 8, 9, 10, 11]);
  assert.equal(resumed.snapshot.completedCount, 12);
  assert.equal(disk.complete, true);
});

test("completed empty replacements are cached and a complete chapter makes no request", async () => {
  const initial = { mixedByParagraph: paragraphs.map(({ id }) => [id, []]) };
  const result = await runChapterTranslation({ paragraphs, metadata, initial,
    persist: async () => {}, requestBatch: async () => { throw new Error("must not be called"); },
  });
  assert.equal(result.error, null);
  assert.equal(result.snapshot.complete, true);
});

test("rate-limit retries are bounded and honor cooldown; quota errors are not retried", async () => {
  let clock = 0;
  let calls = 0;
  const result = await runChapterTranslation({ paragraphs: paragraphs.slice(0, 2), metadata, concurrency: 1,
    persist: async () => {}, now: () => clock, random: () => 0,
    sleep: async (ms) => { clock += ms; },
    requestBatch: async (batch) => {
      if (++calls < 3) throw Object.assign(new Error("rate limit"), { retryable: true, retryAfterMs: 5000 });
      return answer(batch);
    },
  });
  assert.equal(result.retries, 2);
  assert.equal(calls, 3);
  assert.ok(clock >= 11000);
  assert.equal(result.snapshot.complete, true);
  calls = 0;
  const failed = await runChapterTranslation({ paragraphs, metadata, concurrency: 1, persist: async () => {},
    requestBatch: async () => { calls++; throw Object.assign(new Error("balance"), { retryable: false }); },
  });
  assert.equal(calls, 1);
  assert.equal(failed.snapshot.completedCount, 0);
});

test("storage failure prevents spending tokens; malformed results never become completed", async () => {
  let calls = 0;
  await assert.rejects(() => runChapterTranslation({ paragraphs, metadata,
    persist: async () => { throw new Error("disk full"); }, requestBatch: async () => { calls++; },
  }), /保存失败/);
  assert.equal(calls, 0);
  const result = await runChapterTranslation({ paragraphs, metadata, concurrency: 1,
    persist: async () => {}, requestBatch: async () => ({ paragraphs: [] }),
  });
  assert.equal(result.snapshot.completedCount, 0);
  assert.match(result.error.message, /缺少/);
});

test("pause drains the in-flight batch and supplemental failure preserves initial results", async () => {
  let paused = false;
  let calls = 0;
  const result = await runChapterTranslation({ paragraphs, metadata, concurrency: 1,
    shouldStop: () => paused, persist: async () => {}, requestBatch: async (batch) => { calls++; paused = true; return answer(batch); },
  });
  assert.equal(calls, 1);
  assert.equal(result.paused, true);
  assert.equal(result.snapshot.completedCount, 2);
  const supplement = await runChapterTranslation({ paragraphs, metadata, concurrency: 1, persist: async () => {},
    requestBatch: async (batch) => ({ ...answer(batch), haltError: { error: "余额不足" } }),
  });
  assert.equal(supplement.snapshot.completedCount, 2);
  assert.match(supplement.error.message, /首轮结果已保留/);
});
