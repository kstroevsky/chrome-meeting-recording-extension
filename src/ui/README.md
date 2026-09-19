# UI primitives — controls shared by more than one surface

> Behaviour only. Each page keeps its own skin, because each page has its own palette.

This directory exists for one reason: a control that appears on more than one surface should behave identically on all of them, and there was nowhere to put such a thing. `shared/` is the vocabulary the four runtime contexts agree on and deliberately owns no behaviour, so a DOM component does not belong there. `popup/` and `recordings/` each own a page.

Two primitives live here:

| Module | Owns | Used by |
| --- | --- | --- |
| `listboxSelect.ts` | the dropdown: keyboard, outside-click, trigger/native-select sync | popup "Save to" and mic mode, recordings detail modal, naming prompt |
| `modalShell.ts` | the prompt frame: overlay, focus capture/restore, Escape, backdrop, Tab trap | `ConfirmDialog`, `RecordingNameDialog` |

## The split: behaviour here, skin with the page

Every dropdown in this extension is the same three-part shape:

```text
<select class="native-select">   the value holder, hidden from the a11y tree
<button class="select-trigger">  what the user clicks
<div class="select-options"       role="listbox"
     role="listbox">              of role="option" buttons
```

Popup (`static/popup.html` + `src/popup/popupShell.ts`) and Settings (`static/settings.html` + `src/settings/SettingsController.ts`) each hand-roll that over **static** markup, and should keep doing so — their options are fixed at build time, so markup in HTML is the clearer expression.

`listboxSelect.ts` has an entry point for each case:

- **`bindListbox`** adopts markup that already exists. `popup.html` authors "Save to" and the mic-mode picker by hand, and HTML is the clearer expression when the options are fixed at build time. Settings still hand-rolls its own (`SettingsController.wireSelectControls`); its 21 static selects and `.value-cycle` trigger are a different enough shape that adopting them is a separate job.
- **`createListboxSelect`** builds the markup, then binds. Drive destinations are user-authored — added, renamed and removed in Settings — so there is nothing to write in HTML.

Either way the keyboard handling lives once, so a fix reaches every dropdown that uses it.

The class names are the contract. This module emits them; each page's stylesheet defines them in its own tokens:

| Surface | Skin |
| --- | --- |
| Popup naming dialog | `static/styles/popup/config.css` (shared with "Save to"), scoped bits in `popup/dialog.css` |
| Recordings detail modal | `static/styles/recordings.css`, under `.detail-destination__select` |

Do not add a palette here. A colour in this directory would be wrong on at least one of the pages that use it.

## Why the native `<select>` stays

It holds the value, it is what a test reads, and it keeps the control meaningful if the listbox script never runs. It is `aria-hidden` with `tabIndex = -1` so the listbox above it is the single accessible control — exposing both would announce every choice twice. This mirrors what the static surfaces already do with `.native-select` / `.sr-only`.

## Teardown is the caller's job

The control listens on `document` for outside clicks, so a host that discards its element must call `destroy()` or leak a listener. `RecordingsView.redraw()` and `RecordingNameDialog.dispose()` both do.

## `modalShell.ts`

`ConfirmDialog` and `RecordingNameDialog` had the same overlay, focus capture, Escape, backdrop click and `trapFocus` — the last two copies differing only in formatting. The shell owns that frame; each dialog keeps its own promise, because the answers differ (`boolean` versus `saved | canceled`) and that difference is the point of each.

The trap reads the focusable set **at keypress**, not at build time. The old copies fixed `first`/`last` at build time and had them in the reverse of DOM order, so they intercepted the two interior moves and let focus escape at both real edges. Reading live also means a control that appears — the naming prompt's destination picker, present only when destinations exist — joins the trap without anyone remembering to update it.

Not used by `PlayerView` (a full-screen player chrome, not a prompt) or the recordings detail modal (rebuilt per redraw, no pending answer). Neither would be simpler for being forced through here.
