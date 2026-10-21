# Decisions for the 1.43.0 plan revision (2026-10-14)

Owner (verbatim, chat 2026-10-14):
- «добавить в этот план все что необходимо до самой последней версии» — plan covers upstream through v0.15.1.
- «насчет дизайна - максимально переносим 1 в 1 с нашей спецификой, они сильно поменяли там и обновили дизайн в плане стилей и прочего» — redesign 1:1, ALL slices (incl. AppShell and the transcript core; B3's "defer" is overridden), our specifics kept.
- «настроек 1 в 1. найстройки у нас имеют специфику, но в целом да, мы все приложение стримимся максимально близко держать к апстриму но со своей спецификой так как у нас ведь больше рантаймов и заточены под клод и кодекс и квену/несси» — settings 1:1 with our specifics; standing rule for the whole app.
- «может не хватить лимита… нужно успеть хотя бы сам план сделать и проверить хотя бы 1им проходом» — one writer + one review pass; another agent executes; the controller verifies after the limit reset.
- On MCP prompts («а что вообще делает и на что влияет? возможно это должно быть на уровне хост объекта общего?»), then «берем да»: OWNER-CONFIRMED — host session tools for all three runtimes.

Controller decisions under the delegated-question rule (owner 2026-10-08: take the simplest, most runtime-native default; upstream parity otherwise):
- OQ-B4-1 → (a) upstream `project_memory_append` (append-only host tool; a stated second new session tool).
- OQ-B4-2 → REVISED to (c): model-callable MCP prompt tools `source_list_prompts` / `source_get_prompt` as HOST session tools on Pi, Claude and Codex (no runtime has a model-facing prompt mechanism → AGENTS.md native-first step 2, "the host supplies it uniformly"; upstream parity). Resources stay native (Claude/Codex) + our Pi host tools (HAVE); templates + pagination per B4-07 (UB7.10). User-invoked prompt commands unchanged.
- OQ-B4-3 → (a) upstream v0.15.1: a stopped task step waits; the user's next turn completes it.
- OQ-B2.1 → yes: Haiku 5.5 is the title/summary model on Anthropic connections (upstream parity), after B2-02's thinking fix.
- OQ-B3-1 → superseded by the owner: full redesign 1:1 in slices. OQ-B3-1b (primary accent) → upstream's default theme values; our theme set re-solved with upstream's contrast solver.
- Publish page as Claude artifact (B3) → DROP-b (sends internal page data to claude.ai); recorded as a visible divergence, owner may reverse.
- Cloudflare AI Gateway preset (B2-11) → DROP-a.
- Composer: upstream LOOK 1:1, our BEHAVIOUR kept where upstream has no equivalent (prefer upstream's where equivalent).
