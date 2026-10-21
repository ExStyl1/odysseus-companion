# Connections: связи между задачами

Связи рисуются **в самую последнюю очередь**, когда на доску добавлены **все** элементы
(оси, бары, буферы, легенда). Связь — элемент `type: "line"` с двумя точками прикрепления
`tipPoints` к барам-«колбаскам».

## Точки прикрепления (`tipPoints.start` / `tipPoints.end`)

- `start` — **исходящий** объект (первая выполняемая задача).
- `end` — **входящий** объект (следующая/заблокированная задача).
- `boundToId` — id бара-задачи, к которому крепится линия.
- `position` — сторона элемента (нормированы 0..1):
  - `x: 0` слева, `x: 1` справа, `x: 0.5` по центру по X;
  - `y: 0` сверху, `y: 1` снизу, `y: 0.5` по центру по Y.
- **Все точки прикрепления лежат на границе элементов** (0 или 1 по осям, либо 0.5 по середине —
  не внутри).

## Стиль линии по типу связи

- **`sequence`**: сплошная со стрелкой в конце —
  `strokeColor "#3A3A3A"`, `strokeWidth 2`, `lineType "o"`, `lineStartTip 0`, `lineEndTip 2`,
  `strokeStyle "s"`.
- **`block`** (start блокирует end): сплошная **красная** со стрелкой и, как правило, подписью
  причины — `strokeColor "#FF6347"`, `strokeWidth 2`, `lineType "o"`, `lineStartTip 0`,
  `lineEndTip 2`, `strokeStyle "s"`.
- **`related`** (просто связаны): пунктирная, маркеры на обоих концах —
  `strokeColor "#3A3A3A"`, `strokeWidth 2`, `lineType "o"`, `lineStartTip 4`, `lineEndTip 4`,
  `strokeStyle "do"`.

## Подпись связи (поле `captions`)

На **любой** связи можно добавить подпись — короткое пояснение причинно-следственной связи
(например, причина блокировки). Подписи кладутся в массив `captions` на линии. Каждая запись:
`text` (обязательно в `<p>…</p>`), `style` (цвет/шрифт/размер), `relativePosition` (0..1 — вдоль
линии), `relativeOffset` (0.5 — по нормали):

```json
"captions": [
  {
    "text": "<p>освободить сервера</p>",
    "style": {
      "textColor": "#3A3A3A",
      "textFontFamily": "Neue Haas Unica, Segoe UI Emoji",
      "textFontSize": 20
    },
    "relativePosition": 0.34,
    "relativeOffset": 0.5
  }
]
```

## Примеры

Блокирующая линия с причиной:
```json
{
  "type": "line", "schema": 1,
  "size": { "width": 60, "height": 90 },
  "position": { "x": 1820, "y": 210 },
  "points": [],
  "tipPoints": {
    "start": { "boundToId": "<id блокирующей задачи>", "position": { "x": 1, "y": 0.5 } },
    "end":   { "boundToId": "<id заблокированной задачи>", "position": { "x": 0, "y": 0.5 } }
  },
  "style": {
    "fillColor": "transparent", "fillStyle": "s",
    "strokeColor": "#FF6347", "strokeStyle": "s", "strokeWidth": 2,
    "lineEndTip": 2, "lineStartTip": 0, "lineType": "o", "lineStrokesCount": 1
  },
  "captions": [
    { "text": "<p>освободить сервера</p>",
      "style": { "textColor": "#3A3A3A", "textFontFamily": "Neue Haas Unica, Segoe UI Emoji", "textFontSize": 20 },
      "relativePosition": 0.34, "relativeOffset": 0.5 }
  ]
}
```

Последовательность:
```json
{
  "type": "line", "schema": 1,
  "size": { "width": 40, "height": 90 },
  "position": { "x": 3560, "y": 570 },
  "points": [],
  "tipPoints": {
    "start": { "boundToId": "<id задачи A>", "position": { "x": 1, "y": 0.5 } },
    "end":   { "boundToId": "<id задачи B>", "position": { "x": 0, "y": 0.5 } }
  },
  "style": {
    "fillColor": "transparent", "fillStyle": "s",
    "strokeColor": "#3A3A3A", "strokeStyle": "s", "strokeWidth": 2,
    "lineEndTip": 2, "lineStartTip": 0, "lineType": "o", "lineStrokesCount": 1
  }
}
```

## Легенда

**Легенда** слева, над строками/логинами: методика отрисовки — масштаб, источники цветов, обводка
по типу, стиль буферов, стиль связей, якорь «Горизонт: <дата>».
**Стикеры-инсайты** под легендой/графиком — по желанию/при наличии переданных заметок.
Одна мысль — один стикер.