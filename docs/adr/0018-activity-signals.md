# 0018 Activity signals for context help

## Status

Accepted.

## Context

Context help (ADR 0005) opens on the help for the host app's current view: a key, or a path mapped to one. Within a view, readers want the help for the thing they are working on: the field they are filling in, the button they just pressed, the tab they are on. Host apps know this, but had no way to say it short of calling `setContext` with a finer key on every focus change, which loses the page and gives no order between competing hints.

## Decision

**Four signals, in a fixed order.** A context request carries, most specific first:

1. `focus`: the field or control selected or focused now;
2. `action`: the button or command pressed last;
3. `pane`: the tab, pane or dialog last worked in;
4. the view: `key`, or `path` through `help-contexts.yaml`, as before.

Each is an ordinary context key. Authors tag field and button help with `resourceid` like any other context, and nothing changes in `help-contexts.yaml` or the release snapshot.

**One resolver.** `resolveContext` (in `@opend/filter`) builds a single list of keys to try:

- each signal's key, then its parents, before the next signal;
- a parent that also belongs to a later signal's ancestry is left to that signal's turn, so with focus on an untagged `settings.sso.nickname` and the pane `settings.sso.advanced`, the pane's topic beats the general `settings.sso`;
- then the app default, with keys already tried skipped.

Visibility works as it always has: a target counts only when the reader can see it, so no signal can reveal a hidden topic. The result records the `signal` that answered, beside `via`.

`parseContextRequest` reads the same parameters (`app`, `focus`, `action`, `pane`, `key`|`path`) everywhere: the panel's `/embed/context`, `/api/v1/help/context`, public `/context/<app>` links and the help lab. It ignores values that are empty, repeated, not strings, or longer than 256 characters.

**The widget does the tracking.** `OpenDHelp` watches the host page through capturing `focusin` and `click` listeners. It reads only two attributes, `data-help-key` (focus, and action when a pressable control inside is pressed) and `data-help-pane`. It follows `composedPath()` and crosses shadow roots.

- **Ignored:** events on the help button and the panel, so opening help keeps the reader's place.
- **Focus:** moving to an element without a key clears it.
- **Action and pane:** kept until `setContext` changes the view.
- **Apps that track selection themselves:** `setActivity({ focus, action, pane })`, and `activity: false` turns the DOM watching off.
- **Native renderers:** `activity()` returns the signals as query parameters for the JSON API.

**Explicit beats inferred.** `open(context)` and `<opend-help-button key>` open exactly that context and ignore activity until the panel closes. `open()` without an argument uses activity.

**The open panel follows, until the reader takes over.** While open, a change of signal reloads the panel after 250 ms. The widget counts `opend:ready` messages: one it did not ask for means the reader navigated inside the panel, by link or search. From then on the panel stops following until it is next opened. `follow: false` turns following off. The protocol is unchanged (still `v: 1`); it only gives `opend:ready` this second use.

## Consequences

- **No new server state or cache keys.** Panel pages and API answers are already per reader and `no-store`, or public and the same for everyone; the extra parameters only choose among visible topics.
- **Privacy:** the widget sends author-chosen keys only, never field values, text, element ids or selectors. It sends nothing from elements without the attributes. Analytics still record the topic shown, not the signals.
- **Older widgets keep working:** a request with only `key` or `path` resolves exactly as before. The only change to answers is the new `signal` field.
- **Live following reloads the frame.** It is debounced, and it stops as soon as the reader navigates. A host app that would rather update help only on open sets `follow: false`.
- **Tests:** the per-reader leak sweep in `packages/cli/test/leak.test.ts` now covers every key as every signal. A Playwright test drives focus, buttons, tabs, following, pinning and explicit opens across origins.
