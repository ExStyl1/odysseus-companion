#!/usr/bin/env python3
"""Assemble the Claude-doc sweep report as two documents.

The divergence ledger is the audit trail: every finding raised against the 174
pages, its verbatim doc sentence, and the challenger's verdict. The worklist is
what a plan gets cut from: only what survived, read back off the code and turned
into a change list.

Both tables are generated here rather than written by an agent. 245 and 174 rows
are exactly the sizes that get quietly truncated into "and N more", and a
truncated coverage table is indistinguishable from a complete one.

The parts that need judgement — why the refuted findings were wrong, and how the
survivors cut into plans — come from agents via data/phase3-analysis.json.

Usage: python3 scripts/build-doc-sweep-report.py
"""

import json
import os
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
SPECS = os.path.join(HERE, "..", "docs", "superpowers", "specs")
DATA = os.path.join(SPECS, "data")
P1 = os.path.join(DATA, "2026-07-31-doc-sweep-phase1.json")
P2 = os.path.join(DATA, "2026-07-31-doc-sweep-phase2.json")
SDIR = os.path.join(DATA, "phase25-specs")
ANALYSIS = os.path.join(DATA, "phase3-analysis.json")

DOC_A = os.path.join(SPECS, "2026-08-02-claude-doc-sweep-divergences.md")
DOC_B = os.path.join(SPECS, "2026-08-02-claude-doc-sweep-worklist.md")

KIND_RU = {
    "not-built": "не сделано",
    "built-wrong": "сделано не так",
    "built-partial": "сделано частично",
}
KIND_ORDER = ["built-wrong", "not-built", "built-partial", ""]
SUBSYS_ORDER = ["hooks", "plugins", "mcp", "skills", "commands", "agents", "permissions",
                "sessions", "context", "sandbox", "output", "settings", "other"]
EFFORT_ORDER = {"S": 0, "M": 1, "L": 2, "": 3}


def esc(s):
    """Make a cell safe for a Markdown table without altering its content."""
    return str(s or "").replace("|", "\\|").replace("\n", " ").strip()


def load_specs():
    specs = {}
    if not os.path.isdir(SDIR):
        return specs
    for name in sorted(os.listdir(SDIR)):
        if not name.endswith(".json"):
            continue
        try:
            s = json.load(open(os.path.join(SDIR, name)))
        except json.JSONDecodeError:
            continue
        specs[s.get("id") or name[:-5]] = s
    return specs


def write_tsv(path, cols, rows):
    with open(path, "w") as fh:
        fh.write("\t".join(cols) + "\n")
        for r in rows:
            fh.write("\t".join(str(c).replace("\t", " ").replace("\n", " ") for c in r) + "\n")


def main():
    p1 = json.load(open(P1))
    p2 = json.load(open(P2))
    specs = load_specs()
    analysis = json.load(open(ANALYSIS)) if os.path.exists(ANALYSIS) else {}

    results = p2["results"]
    survived = [r for r in results if not r["verdict"]["refuted"]]
    refuted = [r for r in results if r["verdict"]["refuted"]]
    unchallenged = p2["unchallengedFindings"]
    pages = p1["pages"]

    state = {r["id"]: "выжило" for r in survived}
    state.update({r["id"]: "опровергнуто" for r in refuted})
    allrows = sorted(results + [dict(u, verdict=None) for u in unchallenged],
                     key=lambda r: r["id"])
    with_spec = [r for r in survived if r["id"] in specs]

    def counters(w):
        w(f"Прочитано **{p1['pagesRead']} из {p1['pagesTotal']}** страниц корпуса Claude Code "
          f"целиком, через `curl -sL <url>.md`; непрочитанных нет. Корпус проверен как "
          f"полный двумя путями — `llms.txt` и `sitemap.xml` дают одно и то же множество. "
          f"Документация платформы вне области по решению владельца.")
        w("")
        w(f"Заведено **{p2['raised']}** находок уровня bug/gap. Каждая отдана независимому "
          f"оппоненту с задачей её **опровергнуть**, а не подтвердить: проверить цитату "
          f"дословно, открыть указанный файл, посмотреть на слой выше и слой ниже.")
        w("")
        w("| Состояние | Число | Что это значит |")
        w("| --- | --- | --- |")
        w(f"| Выжило | **{len(survived)}** | Оппонент пытался опровергнуть и не смог |")
        w(f"| Опровергнуто | {len(refuted)} | Находка неверна — сфабрикованная цитата, не та "
          f"подсистема, ложное следствие, или записанное решение владельца |")
        w(f"| **Не оспорено** | {len(unchallenged)} | Отдельное состояние. НЕ складывать "
          f"с выжившими |")
        w("")
        if unchallenged:
            w(f"> Из {len(results)} оспоренных находок убито {len(refuted)}. Поэтому "
              f"неоспоренная находка — не «вероятно верная», а «неизвестной верности», "
              f"и в трекер паритета она не переносится.")
            w("")

    # ======================================================================
    # DOCUMENT A — the divergence ledger
    # ======================================================================
    a = []
    w = a.append
    w("# Сверка с документацией Claude Code — расхождения")
    w("")
    counters(w)
    w(f"Рабочий список правок по выжившим — в `{os.path.basename(DOC_B)}`.")
    w("")

    w(f"## Таблица 1. Все расхождения ({len(allrows)})")
    w("")
    w("Каждая находка, заведённая при чтении страниц, с дословным предложением "
      "документации и вердиктом оппонента. Цитаты без номеров строк намеренно: "
      "страницы растут, номер разъезжается, предложение остаётся идентификатором. "
      "Машиночитаемая копия — `data/2026-08-02-doc-sweep-divergences.tsv`.")
    w("")
    w(f"**Номера строк в колонке «вердикт оппонента» — датированные, а не "
      f"актуальные.** Это ЗАПИСЬ ИЗМЕРЕНИЯ: каждый вердикт мерился по выборке "
      f"страниц от {p1.get('generatedAt', '?')} и по коду того же дня, и с тех пор "
      f"разъехались И номера страниц, И номера файлов исходников. Они здесь "
      f"намеренно НЕ перевешиваются на свежую выборку: перенумерованный датированный "
      f"вердикт — это уже не то, что было измерено. Идентификатор — процитированное "
      f"предложение и названный символ; если нужен номер, перемерьте сами и "
      f"поставьте свою дату. Проверено 2026-08-25 на f237 "
      f"(`permission-modes.md:156`/`:210` → предложение живёт на `:281`), f013 и "
      f"f233 — класс общий для всех 245 вердиктов, а не дефект трёх из них.")
    w("")
    t1_cols = ["#", "страница", "состояние", "уровень", "цитата документации",
               "что документация связывает", "что у нас", "доказательство",
               "вердикт оппонента"]

    def t1_row(r):
        return [r["id"], r["slug"], state.get(r["id"], "не оспорено"), r["severity"],
                r["quote"].strip(), r["claim"], r["ourState"], r["evidence"],
                (r.get("verdict") or {}).get("why", "—")]

    w("| " + " | ".join(t1_cols) + " |")
    w("| " + " | ".join("---" for _ in t1_cols) + " |")
    for r in allrows:
        c = t1_row(r)
        w("| " + " | ".join([c[0], f"`{c[1]}`", c[2], c[3]] + [esc(x) for x in c[4:]]) + " |")
    w("")
    write_tsv(os.path.join(DATA, "2026-08-02-doc-sweep-divergences.tsv"), t1_cols,
              [t1_row(r) for r in allrows])

    w(f"## Что было опровергнуто и почему ({len(refuted)})")
    w("")
    w("Опровергнутые находки ценны не меньше выживших: это ровно то, что наивная "
      "сверка внесла бы в трекер как работу.")
    w("")
    w(analysis.get("taxonomy") or "_(таксономия не построена)_")
    w("")

    vc = Counter(p["verdict"] for p in pages)
    w(f"## Все {len(pages)} страниц корпуса")
    w("")
    w("Вердикт страницы — оценка читателя на первом проходе, до оппонирования. "
      "Местами он опровергнут результатами: страница, помеченная пробелом, могла "
      "оказаться в паритете.")
    w("")
    w(" · ".join(f"**{k}** {v}" for k, v in vc.most_common()))
    w("")
    w("| # | Страница | Вердикт | Состояние |")
    w("| --- | --- | --- | --- |")
    for i, p in enumerate(pages, 1):
        w(f"| {p.get('n') or i} | `{p['slug']}` | {p['verdict']} | {esc(p['summary'])} |")
    w("")

    if unchallenged:
        w(f"## Не оспорено ({len(unchallenged)})")
        w("")
        w("Заведены при чтении, но ни один оппонент их не проверял.")
        w("")
        w("| # | Страница | Уровень | Находка |")
        w("| --- | --- | --- | --- |")
        for r in unchallenged:
            w(f"| {r.get('id', '')} | `{r['slug']}` | {r['severity']} | {esc(r['claim'])} |")
        w("")

    # ======================================================================
    # DOCUMENT B — the worklist
    # ======================================================================
    b = []
    w = b.append
    w("# Сверка с документацией Claude Code — что доделать")
    w("")
    counters(w)
    kinds = Counter(specs[r["id"]]["kind"] for r in with_spec)
    if kinds:
        w("Из выживших: " + ", ".join(
            f"**{v}** {KIND_RU[k]}" for k, v in
            sorted(kinds.items(), key=lambda kv: KIND_ORDER.index(kv[0]))) + ".")
        w("")
    w(f"Полный перечень расхождений, включая опровергнутые, — в "
      f"`{os.path.basename(DOC_A)}`.")
    w("")
    # The same dated-citation rule Table 1's preamble states, applied to Table 2
    # and to both machine copies. Table 2's cells carry `<файл>.ts:<строка>`
    # anchors into OUR OWN tree — the largest single concentration of dated
    # anchors in the repo — and unlike a doc page, our files move on every commit.
    # Measured 2026-08-25 over the resolvable source anchors cited from `docs/`:
    # 674 land on a blank line, 249 point past the end of their file, 959 land on
    # a bare `}`/`*/`. They are deliberately never re-hung: renumbering a dated
    # verdict turns a record of what was measured into a claim nobody made.
    w(f"**Номера строк в этом файле — датированное измерение, а не живой "
      f"указатель.** Каждая ссылка вида `<файл>:<строка>` бралась по дереву "
      f"на {p1.get('generatedAt', '?')}, и с тех пор наши файлы двигались на "
      f"каждом коммите. Замер 2026-08-25 по всем разрешимым ссылкам на исходники "
      f"из `docs/`: 674 попадают на пустую строку, 249 — за конец файла, 959 — "
      f"на одинокую `}}` или `*/`. Перевешивать их на свежее дерево нельзя: "
      f"перенумерованный датированный вердикт — это уже не то, что было "
      f"измерено. Идентификатор — процитированное предложение и названный "
      f"символ; нужен номер — перемерьте сами и поставьте свою дату. То же "
      f"относится к машинным копиям `data/2026-08-02-doc-sweep-worklist.tsv` и "
      f"`data/2026-08-02-doc-sweep-divergences.tsv`, у которых нет преамбулы.")
    w("")

    w(f"## Таблица 2. Разница с нашим кодом ({len(with_spec)})")
    w("")
    ordered = []
    if not with_spec:
        w("_(спецификации не построены)_")
        w("")
    else:
        w(f"Только выжившие находки. Каждая была прочитана по коду заново "
          f"{p1.get('generatedAt', '?')} и превращена в список правок — это "
          f"утверждение о том дне, а не о HEAD. Порядок: сначала сделанное "
          f"неверно, потом отсутствующее, потом частичное; внутри — по подсистеме "
          f"и объёму. Машиночитаемая копия — "
          f"`data/2026-08-02-doc-sweep-worklist.tsv`.")
        w("")
        t2_cols = ["#", "страница", "тип", "подсистема", "расхождение",
                   "что и где менять", "радиус", "что чувствует пользователь",
                   "объём", "уверенность"]

        def t2_row(r):
            s = specs[r["id"]]
            change = "; ".join(
                f"{c['file']}" + (f" ({c['symbol']})" if c.get("symbol") else "")
                + f" — {c['what']}" for c in s.get("change", []))
            return [r["id"], r["slug"], KIND_RU.get(s["kind"], s["kind"]),
                    s.get("subsystem", ""), s.get("divergence", ""), change,
                    s.get("blastRadius", ""), s.get("userImpact", ""),
                    s.get("effort", ""), s.get("confidence", "")]

        ordered = sorted(with_spec, key=lambda r: (
            KIND_ORDER.index(specs[r["id"]]["kind"]),
            SUBSYS_ORDER.index(specs[r["id"]].get("subsystem", "other"))
            if specs[r["id"]].get("subsystem") in SUBSYS_ORDER else 99,
            EFFORT_ORDER.get(specs[r["id"]].get("effort", ""), 3),
        ))
        w("| " + " | ".join(t2_cols) + " |")
        w("| " + " | ".join("---" for _ in t2_cols) + " |")
        for r in ordered:
            c = t2_row(r)
            w("| " + " | ".join([c[0], f"`{c[1]}`"] + [esc(x) for x in c[2:]]) + " |")
        w("")
        write_tsv(os.path.join(DATA, "2026-08-02-doc-sweep-worklist.tsv"), t2_cols,
                  [t2_row(r) for r in ordered])

    w("## Нарезка на планы")
    w("")
    units = analysis.get("units") or []
    if units:
        w("| План | Что закрывает | Находки | Зависит от | Объём | Что получает пользователь |")
        w("| --- | --- | --- | --- | --- | --- |")
        for u in units:
            dep = ", ".join(f"`{d}`" for d in u.get("dependsOn", [])) or "—"
            w(f"| `{u['name']}` | {esc(u['title'])} | {', '.join(u['findings'])} | {dep} "
              f"| {u.get('effort', '')} | {esc(u.get('rationale', ''))} |")
        w("")
        covered = {f for u in units for f in u["findings"]}
        orphan = [r["id"] for r in survived if r["id"] not in covered]
        if orphan:
            w(f"> Не попали ни в один план: {', '.join(orphan)}.")
            w("")
    w(analysis.get("plan") or "_(порядок не построен)_")
    w("")

    if ordered:
        w("## Развёрнуто по каждой позиции")
        w("")
        groups = defaultdict(list)
        for r in ordered:
            s = specs[r["id"]]
            groups[(s["kind"], s.get("subsystem", "other"))].append((r, s))
        for key in sorted(groups, key=lambda k: (
                KIND_ORDER.index(k[0]),
                SUBSYS_ORDER.index(k[1]) if k[1] in SUBSYS_ORDER else 99)):
            w(f"### {KIND_RU.get(key[0], key[0])} · {key[1]}")
            w("")
            for r, s in groups[key]:
                w(f"#### {r['id']} · `{r['slug']}`")
                w("")
                w(f"{s.get('divergence', '')}")
                w("")
                w(f"- **Документация связывает.** {s.get('docRequirement', '')}")
                w(f"  > {r['quote'].strip()}")
                w(f"- **У нас.** {s.get('current', '')}")
                w(f"- **Пользователь.** {s.get('userImpact', '')}")
                if s.get("change"):
                    w("- **Правка.**")
                    for c in s["change"]:
                        sym = f" `{c['symbol']}`" if c.get("symbol") else ""
                        w(f"  - `{c['file']}`{sym} — {c['what']}")
                w(f"- **Радиус.** {s.get('blastRadius', '')}")
                w(f"- **Объём** {s.get('effort', '')} · **уверенность** {s.get('confidence', '')}"
                  + (f" · {s['notes']}" if s.get("notes") else ""))
                w("")

    missing = [r for r in survived if r["id"] not in specs]
    if missing:
        w(f"## Выжило, но спецификация не построена ({len(missing)})")
        w("")
        w("| # | Страница | Уровень | Расхождение |")
        w("| --- | --- | --- | --- |")
        for r in missing:
            w(f"| {r['id']} | `{r['slug']}` | {r['severity']} | {esc(r['claim'])} |")
        w("")

    open(DOC_A, "w").write("\n".join(a) + "\n")
    open(DOC_B, "w").write("\n".join(b) + "\n")
    print(f"{DOC_A}  ({len(a)} lines)")
    print(f"{DOC_B}  ({len(b)} lines)")
    print(f"survived {len(survived)} · specified {len(with_spec)} · refuted {len(refuted)} "
          f"· unchallenged {len(unchallenged)}")


if __name__ == "__main__":
    main()
