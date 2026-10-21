# Preferences

Файл `preferences.json` хранит личные настройки, которые влияют на то, как агент
вам отвечает: name, timezone, location, free-form notes и несколько behaviour
toggles. Они отделены от workspace definitions и несекретного состояния app в
[config file](config-file).

## Расположение

```
~/.nessy-agent/preferences.json
```

## Структура

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

## Поля

### name

Имя, которым агент должен к вам обращаться. Оно может появляться в greetings и
других personalized replies.

```json
"name": "Alex"
```

### timezone

Ваш timezone в [IANA format](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).

```json
"timezone": "America/New_York"
```

Используется для точных relative-time references ("today", "this week") и
time-sensitive tasks. Частые значения: `America/New_York`,
`America/Los_Angeles`, `Europe/London`, `Europe/Berlin`, `Asia/Tokyo`,
`Australia/Sydney`.

### location

Ваш location как nested object:

```json
"location": {
  "city": "New York",
  "region": "New York",
  "country": "USA"
}
```

Используется для location-aware answers, например local time и weather.

### notes

Free-form notes о том, как вам удобно работать. Агент читает их как часть
context и использует при выборе формы ответа.

```json
"notes": "Prefer bullet points over paragraphs. Technical background."
```

### includeCoAuthoredBy

Определяет, добавляет ли агент co-author trailer в git commits. Default —
`true`, если поле не задано; установите `false`, чтобы убрать trailer.

```json
"includeCoAuthoredBy": false
```

Изменение применяется в следующей session.

### diffViewer

Display options для diff viewer:

```json
"diffViewer": {
  "diffStyle": "split",
  "disableBackground": false
}
```

- `diffStyle` — `"unified"` (stacked) или `"split"` (side-by-side).
- `disableBackground` — выключает background highlighting на changed lines.

### updatedAt

Timestamp в Unix milliseconds последнего update. Задается автоматически.

```json
"updatedAt": 1737451800000
```

## Language

Language находится в **Settings → Appearance → Language**, а не в
`preferences.json`. Выбор влияет сразу на две вещи: interface chrome и язык, на
котором агент пишет ответы. Выберите русский, и агент начнет отвечать по-русски.

Internally выбранный language mirrored в persisted `uiLanguage` field, чтобы
main process и renderer оставались in sync между restarts. Session titles
генерируются на persisted language, а не откатываются к English после restart.
Это поле поддерживает только Appearance dropdown; оно не user-editable и не
доступно через preferences tool.

::: info
Legacy free-text `language` field от старой версии scrubbed on read и safely
ignored.
:::

## Редактирование

Предпочитайте сказать агенту в chat, например "My name is Alex" или "I'm in
London, GMT" — он обновит файл за вас. Для ручного редактирования сначала
закройте app и сохраните valid JSON:

```bash
nano ~/.nessy-agent/preferences.json
```

Изменения попадут в следующую conversation; откройте fresh session или
перезапустите app.

## Как используются preferences

Эти значения напрямую попадают в system prompt. Так агент держит под рукой ваше
preferred name, local clock и timezone, whereabouts, Appearance-chosen reply
language и выбор co-author-trailer.

## Пример

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

С такой настройкой агент планирует по Berlin time, отвечает на языке, выбранном
в Appearance, предпочитает code examples и использует metric units.
