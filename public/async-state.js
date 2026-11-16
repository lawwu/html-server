// Read ownership: idle -> pending -> idle. Starting a newer read or cancelling
// invalidates the old handle, even if its transport ignores AbortSignal. Check
// current after reading the body, before changing UI, caches, focus or the URL.
// Never use this to cancel writes: aborting a request cannot undo a server commit.
export function latestRequest() {
  let active = null;
  const cancel = () => {
    const previous = active;
    active = null;
    previous?.abort();
  };
  return {
    get pending() { return active !== null; },
    cancel,
    start() {
      cancel();
      const controller = active = new AbortController();
      return {
        signal: controller.signal,
        get current() { return active === controller; },
        finish() { if (active === controller) active = null; },
      };
    },
  };
}

// Write ownership: idle -> pending -> idle (success or failure). Repeated events
// while pending are ignored, never queued or retried. onChange projects pending
// onto controls; the guard also covers Enter and programmatic submit events.
export function singleAction(onChange = () => {}) {
  let pending = false;
  return {
    get pending() { return pending; },
    async run(action) {
      if (pending) return;
      pending = true;
      try { onChange(true); return await action(); }
      finally { pending = false; onChange(false); }
    },
  };
}
