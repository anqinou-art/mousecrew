// fake.js — an in-memory terminal, so the delivery logic can be tested without a terminal.
//
// This is the event layer the tests assert against. It is not a mock in the "returns
// whatever I told it to" sense: it keeps real state, and text sent to a window really does
// appear on that window's screen. What it removes is the renderer, not the behaviour.
//
// Why that distinction matters: an assertion against a real screen is answering two
// questions at once — did our code do the right thing, and did the terminal draw it — and
// when it goes red you cannot tell which. Here there is only one question.

function createFakeAdapter({ windows = [] } = {}) {
  const state = new Map();
  let seq = 0;
  const events = [];

  for (const w of windows) addWindow(w);

  function addWindow({ ref, identity = null, title = null, screen = '' } = {}) {
    const id = ref || `%${seq++}`;
    state.set(id, { ref: id, identity, title, screen, sent: [], keys: [] });
    return id;
  }

  const adapter = {
    name: 'fake',

    async available() { return true; },

    async listWindows() {
      return [...state.values()].map((w) => ({ ref: w.ref, identity: w.identity, title: w.title }));
    },

    async setIdentity(ref, identity) {
      const w = must(ref);
      w.identity = identity;
      events.push({ type: 'setIdentity', ref, identity });
    },

    async clearIdentity(ref) {
      const w = must(ref);
      w.identity = null;
      events.push({ type: 'clearIdentity', ref });
    },

    async readScreen(ref, lines = 12) {
      const w = must(ref);
      return w.screen.split('\n').slice(-lines).join('\n');
    },

    async sendText(ref, text) {
      const w = must(ref);
      w.sent.push(text);
      // Text lands on the screen but is not "submitted" until a key is pressed — the same
      // shape as a real terminal, and the reason sendText/sendKey are separate verbs.
      w.screen += (w.screen && !w.screen.endsWith('\n') ? '\n' : '') + text;
      events.push({ type: 'sendText', ref, chars: text.length });
    },

    async sendKey(ref, key) {
      const w = must(ref);
      w.keys.push(key);
      w.screen += '\n';
      events.push({ type: 'sendKey', ref, key });
    },
  };

  function must(ref) {
    const w = state.get(ref);
    if (!w) throw new Error(`fake adapter: no such window "${ref}"`);
    return w;
  }

  // Test-facing controls. Deliberately not part of the contract.
  adapter.__test = {
    addWindow,
    events,
    window: (ref) => state.get(ref),
    setScreen: (ref, screen) => { must(ref).screen = screen; },
    /** Everything typed into a window, in order. */
    sentTo: (ref) => [...must(ref).sent],
    reset: () => { events.length = 0; for (const w of state.values()) { w.sent.length = 0; w.keys.length = 0; } },
  };

  return adapter;
}

module.exports = { createFakeAdapter };
