# UI primitives — controls shared by more than one page

> Behaviour only. Each page keeps its own skin, because each page has its own palette.

This directory exists for one reason: a control that appears on two pages should behave identically on both, and there was nowhere to put such a thing. `shared/` is the vocabulary the four runtime contexts agree on and deliberately owns no behaviour, so a DOM component does not belong there. `popup/` and `recordings/` each own a page.

## The split: behaviour here, skin with the page

Every dropdown in this extension is the same three-part shape:

```text
<select class="native-select">   the value holder, hidden from the a11y tree
<button class="select-trigger">  what the user clicks
<div class="select-options"       role="listbox"
     role="listbox">              of role="option" buttons
```

Popup (`static/popup.html` + `src/popup/popupShell.ts`) and Settings (`static/settings.html` + `src/settings/SettingsController.ts`) each hand-roll that over **static** markup, and should keep doing so — their options are fixed at build time, so markup in HTML is the clearer expression.

`listboxSelect.ts` is for the case those two cannot cover: **options known only at runtime**. Drive destinations are user-authored — added, renamed and removed in Settings — so the markup has to be generated. Two surfaces use it, the recordings-page detail modal and the popup's naming prompt.

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
