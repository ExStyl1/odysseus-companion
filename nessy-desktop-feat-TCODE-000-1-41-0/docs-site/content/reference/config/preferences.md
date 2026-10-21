# Preferences

The `preferences.json` file stores personal settings that shape how the agent
responds to you — your name, timezone, location, free-form notes, and a few
behaviour toggles. These are separate from workspace definitions and from the
non-secret app state in the [config file](/reference/config/config-file).

## Location

```
~/.nessy-agent/preferences.json
```

## Structure

```json
{
  "name": "Alex",
  "timezone": "America/New_York",
  "location": {
    "city": "New York",
    "region": "New York",
    "country": "USA"
  },
  "notes": "I prefer concise responses",
  "includeCoAuthoredBy": true,
  "updatedAt": 1737451800000
}
```

## Fields

### name

The name you want the agent to call you. It can surface in greetings and
otherwise personalized replies.

```json
"name": "Alex"
```

### timezone

Your timezone in [IANA format](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).

```json
"timezone": "America/New_York"
```

Used for accurate relative-time references ("today", "this week") and
time-sensitive tasks. Common values include `America/New_York`,
`America/Los_Angeles`, `Europe/London`, `Europe/Berlin`, `Asia/Tokyo`, and
`Australia/Sydney`.

### location

Your location, as a nested object:

```json
"location": {
  "city": "New York",
  "region": "New York",
  "country": "USA"
}
```

Used for location-aware answers such as local time and weather.

### notes

Free-form notes on how you like to work. The agent reads them as part of its
context and leans on them when shaping how it replies.

```json
"notes": "Prefer bullet points over paragraphs. Technical background."
```

### includeCoAuthoredBy

Whether the agent appends a co-author trailer to git commits. Defaults to
`true` when unset; set it to `false` to suppress the trailer.

```json
"includeCoAuthoredBy": false
```

The change takes effect on the next session.

### diffViewer

Display options for the diff viewer:

```json
"diffViewer": {
  "diffStyle": "split",
  "disableBackground": false
}
```

- `diffStyle` — `"unified"` (stacked) or `"split"` (side-by-side).
- `disableBackground` — turn off background highlighting on changed lines.

### updatedAt

Timestamp in Unix milliseconds of the last update. Set automatically.

```json
"updatedAt": 1737451800000
```

## Language

Language lives under **Settings → Appearance → Language**, never in
`preferences.json`. Your pick drives two things at once — the interface chrome
and the language the agent writes back in. Switch it to Japanese and the agent
starts replying in Japanese.

Internally the chosen language is mirrored to a persisted `uiLanguage` field so
the main process and renderer stay in sync across restarts. Session titles are
generated in that persisted language rather than falling back to English after
a restart. This field is maintained only by the Appearance dropdown; it is not
user-editable and is not exposed through the preferences tool.

::: info
A legacy free-text `language` field left over from an older version is scrubbed
on read and safely ignored.
:::

## Editing

Prefer telling the agent in chat (for example "My name is Alex" or "I'm in
London, GMT") — it updates the file for you. To edit manually, quit the app
first and keep the JSON valid:

```bash
nano ~/.nessy-agent/preferences.json
```

The edits land on your next conversation; open a fresh session or relaunch to
pick them up.

## How preferences are used

These values feed straight into the system prompt. That is how the agent has
your preferred name, your local clock and timezone, your whereabouts, the
Appearance-chosen reply language, and your co-author-trailer choice all on hand.

## Example

```json
{
  "name": "Jordan",
  "timezone": "Europe/Berlin",
  "location": {
    "city": "Berlin",
    "region": "Berlin",
    "country": "Germany"
  },
  "notes": "Software engineer. Prefer code examples over descriptions. Use metric units."
}
```

Given this, the agent schedules against Berlin time, answers in whatever language
Appearance is set to, favours code examples, and sticks to metric units.
