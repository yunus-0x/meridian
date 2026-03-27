export function createReadlineSafety(rl, { onClose } = {}) {
  let closed = false;
  const isReallyClosed = () => closed || rl.closed === true;

  function markClosed() {
    if (isReallyClosed()) {
      closed = true;
      return;
    }
    closed = true;
    onClose?.();
  }

  return {
    isClosed() {
      return isReallyClosed();
    },
    markClosed,
    setPrompt(value) {
      if (isReallyClosed()) return;
      rl.setPrompt(value);
    },
    prompt(preserveCursor = false) {
      if (isReallyClosed()) return;
      rl.prompt(preserveCursor);
    },
    pause() {
      if (isReallyClosed()) return;
      rl.pause();
    },
    resume() {
      if (isReallyClosed()) return;
      rl.resume();
    },
  };
}
