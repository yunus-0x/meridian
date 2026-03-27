import assert from "assert";
import { createReadlineSafety } from "../repl-safety.js";

function createMockReadline() {
  const calls = [];
  return {
    calls,
    setPrompt(value) { calls.push(["setPrompt", value]); },
    prompt(value) { calls.push(["prompt", value]); },
    pause() { calls.push(["pause"]); },
    resume() { calls.push(["resume"]); },
  };
}

function testSkipsReadlineCallsAfterClose() {
  const rl = createMockReadline();
  const safety = createReadlineSafety(rl);

  safety.setPrompt("before");
  safety.prompt(true);
  safety.pause();
  safety.resume();
  safety.markClosed();
  safety.setPrompt("after");
  safety.prompt(true);
  safety.pause();
  safety.resume();

  assert.deepStrictEqual(rl.calls, [
    ["setPrompt", "before"],
    ["prompt", true],
    ["pause"],
    ["resume"],
  ]);
  assert.equal(safety.isClosed(), true);
}

function testCloseCallbackRunsOnce() {
  const rl = createMockReadline();
  let closeCount = 0;
  const safety = createReadlineSafety(rl, {
    onClose: () => { closeCount += 1; },
  });

  safety.markClosed();
  safety.markClosed();

  assert.equal(closeCount, 1);
}

function testSkipsCallsWhenReadlineIsAlreadyClosed() {
  const rl = createMockReadline();
  rl.closed = true;
  const safety = createReadlineSafety(rl);

  safety.setPrompt("closed");
  safety.prompt(true);
  safety.pause();
  safety.resume();

  assert.deepStrictEqual(rl.calls, []);
}

testSkipsReadlineCallsAfterClose();
testCloseCallbackRunsOnce();
testSkipsCallsWhenReadlineIsAlreadyClosed();

console.log("readline safety tests passed");
