# postgres-indexing Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `skills/postgres-indexing`, a skill that makes the agent write Postgres and Ecto queries and migrations that use their indexes, registered in this plugin.

**Architecture:** A local, gitignored corpus of pages on SQL indexing is downloaded once (Task 1). Eight reference files are written from it in parallel, one agent each (Tasks 2 to 9), then `SKILL.md` is written as a checklist that points at them (Task 10), the plugin registers the skill (Task 11), and a coverage pass plus three live prompts validate it (Tasks 12 and 13).

**Tech Stack:** Markdown skill files, `uv run` with `markdownify` and `beautifulsoup4` for the download, a Bash lint in the scratchpad.

**Spec:** `docs/superpowers/specs/2026-09-22-postgres-indexing-skill-design.md`

## Global Constraints

- Postgres only. Behaviour specific to other databases is left out.
- No quotations, no links, no author names, no book or site titles anywhere in the skill, the references, the commit messages or the PR. The source is referred to, when at all, as "the corpus".
- Every rule ships with a Postgres SQL example and, where the shape changes, the same thing in Ecto.
- Examples use generic tables: `users`, `orders`, `order_items`.
- Reference files are 80 to 200 lines. `SKILL.md` is around 150 lines.
- Prose rules from the repo owner apply: no em dash (—), no AI jargon (robust, comprehensive, seamless, leverage, delve, cutting-edge), comments only for a non obvious why.
- Corpus lives in `corpus/` at the repo root and is listed in `.gitignore`. The download script lives in the session scratchpad, never in the repo.
- Commit messages follow the repo history: `feat: ...`, `docs: ...`, `chore: ...`, imperative, lowercase after the prefix.

The session scratchpad directory (outside the repo) is referred to below as `$SCRATCH`.

---

### Task 1: Download the corpus

**Files:**
- Create: `$SCRATCH/scrape.py`
- Create: `$SCRATCH/lint-skill.sh`
- Modify: `.gitignore`
- Output: `corpus/*.md` (gitignored)

**Interfaces:**
- Produces: `corpus/<slug>.md`, one file per page, slug is the URL path under the table-of-contents section with `/` replaced by `__`. Example: `corpus/where-clause__functions.md`. Each file starts with `# <page title>`.
- Produces: `$SCRATCH/lint-skill.sh <file>...`, exits non zero when a file contains a forbidden token or is outside 80 to 200 lines (SKILL.md is exempt from the line check).

- [ ] **Step 1: Add corpus to .gitignore**

```bash
printf '.DS_Store\ncorpus/\n' > .gitignore
git add .gitignore && git commit -m "chore: ignore the local indexing corpus"
```

- [ ] **Step 2: Write the download script**

```python
# $SCRATCH/scrape.py
import os, re, sys, time, pathlib, urllib.request
from bs4 import BeautifulSoup
from markdownify import markdownify

BASE = sys.argv[1].rstrip("/")
OUT = pathlib.Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
TOC_PATH = os.environ["SITE_TOC_PATH"]
SECTION = TOC_PATH.rsplit("/", 1)[0] + "/"
SKIP = re.compile(os.environ["SKIP_REGEX"])
UA = {"User-Agent": "Mozilla/5.0 (corpus fetch for a private study; 1 req/s)"}

def get(path):
    req = urllib.request.Request(BASE + path, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")

toc = BeautifulSoup(get(TOC_PATH), "html.parser")
paths = sorted({a["href"] for a in toc.select(f'a[href^="{SECTION}"]')
                if not SKIP.match(a["href"]) and "table-of-contents" not in a["href"]})

for path in paths:
    slug = path.removeprefix(SECTION).replace("/", "__") or "index"
    target = OUT / f"{slug}.md"
    if target.exists():
        continue
    soup = BeautifulSoup(get(path), "html.parser")
    main = soup.select_one("main") or soup.select_one("article") or soup.body
    for tag in main.select("nav, aside, script, style, form, .toc, .navigation, footer"):
        tag.decompose()
    title = soup.title.get_text(strip=True) if soup.title else slug
    md = markdownify(str(main), heading_style="ATX", strip=["img"])
    md = re.sub(r"\n{3,}", "\n\n", md).strip()
    target.write_text(f"# {title}\n\n{md}\n")
    print(slug, len(md))
    time.sleep(1)
```

- [ ] **Step 3: Run it**

```bash
SITE_TOC_PATH=... SKIP_REGEX=... uv run --with markdownify --with beautifulsoup4 python3 $SCRATCH/scrape.py "$SITE_BASE_URL" corpus
ls corpus | wc -l
```

`$SITE_BASE_URL`, `$SITE_TOC_PATH` (the table-of-contents page path) and `$SKIP_REGEX` (a regex matching hrefs to skip, such as pages about other databases) are typed into the shell, never written into any file in the repo. Expected: about 70 files, each larger than 500 bytes. Open two at random and confirm the body text is there and the navigation is not. If a page came out empty, adjust the `main` selector in the script and delete that file so the rerun fetches it again.

- [ ] **Step 4: Write the lint**

```bash
# $SCRATCH/lint-skill.sh
#!/usr/bin/env bash
set -u
status=0
forbidden="$FORBIDDEN|http://|https://|—|robust|comprehensive|seamless|leverage|delve|cutting-edge|the book|the site|the author"
for f in "$@"; do
  if grep -niE "$forbidden" "$f"; then echo "FORBIDDEN TOKEN in $f"; status=1; fi
  n=$(wc -l < "$f")
  case "$f" in
    */SKILL.md) ;;
    *) if [ "$n" -lt 80 ] || [ "$n" -gt 200 ]; then echo "LINE COUNT $n out of 80..200 in $f"; status=1; fi ;;
  esac
done
exit $status
```

`$FORBIDDEN` is exported in the shell before running the lint: a regex with the corpus source's domain, the author's name and the book title. It is typed into the shell, never written into a file in the repo.

```bash
chmod +x $SCRATCH/lint-skill.sh
$SCRATCH/lint-skill.sh skills/send-pr/references/reviewer.md; echo "exit $?"
```

Expected: `LINE COUNT 18 out of 80..200`, exit 1. The lint works. Nothing to commit for this step.

- [ ] **Step 5: Build the corpus map**

Print `head -3` of every corpus file so the reference tasks can be handed their input list:

```bash
for f in corpus/*.md; do echo "== $f"; sed -n '1p' "$f"; done
```

Keep the output; Tasks 2 to 9 name their input files from it.

---

### Tasks 2 to 9: Reference files (run in parallel, one agent each)

Every reference task shares this contract. The agent reads only its corpus files plus the spec and this section, writes one file, runs the lint, commits.

**Shared steps for each reference task:**

- [ ] **Step 1: Read the inputs.** `cat` each corpus file listed for the task, then read the spec section "References" and "SKILL.md" for the rules that the file must support.
- [ ] **Step 2: Write the file** at the given path, following this skeleton:

```markdown
# <Topic title>

<One paragraph: what problem this file solves and when SKILL.md sends the agent here.>

## <Rule 1 as a short imperative sentence>

<Two to five lines: why it matters, in plain words.>

```sql
-- the shape that uses the index
```

```elixir
# the same in Ecto, only when the Ecto form is not obvious from the SQL
```

**Mistake:** <the classic wrong shape, one line, with the wrong SQL if it helps.>

## <Rule 2 ...>
```

Rules: 80 to 200 lines. Generic tables `users(id, email, status, inserted_at, ...)`, `orders(id, user_id, status, total, inserted_at)`, `order_items(id, order_id, product_id, quantity)`. Rewrite every idea in your own words; do not copy sentences from the corpus. No links, no names, no titles. No em dash. No AI jargon.

- [ ] **Step 3: Lint.** `$SCRATCH/lint-skill.sh skills/postgres-indexing/references/<file>.md`. Expected: exit 0 and no output. Fix and rerun until clean.
- [ ] **Step 4: Commit.** `git add skills/postgres-indexing/references/<file>.md && git commit -m "feat: add <file> reference to postgres-indexing"`.

Parallel commits touch different files, so there are no conflicts; if `git commit` fails on a lock, retry once.

#### Task 2: `references/index-anatomy.md`

**Inputs:** `corpus/anatomy*.md`, `corpus/clustering*.md`, `corpus/preface.md`, `corpus/glossary.md`, `corpus/example-schema.md`.
**Must cover:** B-tree with balanced tree plus doubly linked leaf list; why a lookup is tree traversal then leaf scan then table access; why "the index is slow" usually means a wide leaf scan or many table accesses, not a broken tree; index-only scans and `INCLUDE`; what a clustered layout is and that Postgres heap tables do not keep one (the `CLUSTER` command is one-off); index filter predicates vs access predicates in one paragraph (the deep version is in explain.md).

#### Task 3: `references/where-clause.md`

**Inputs:** `corpus/where-clause*.md`, `corpus/clustering__index-filter-predicates.md`.
**Must cover:** equality first, one range last, column order in composite indexes; functions and casts on the column (expression index, `lower(email)`, `citext` as the alternative); over-indexing; `LIKE 'x%'` vs `'%x'`, and `pg_trgm` as the way out for infix search; NULL is indexed, `IS NULL` uses the index, partial index when nulls dominate, `NOT NULL` constraint lets the planner use the index for `count(*)`; partial and filtered indexes for status flags and soft delete; obfuscation: date ranges (`>= date AND < date + 1` instead of `date_trunc`), numeric strings (`'42'` vs `42` cast direction), concatenation (`first_name || ' ' || last_name`), math (`col + 1 = ?`), smart logic (`col = ? OR ? IS NULL`) and how to compose Ecto queries conditionally instead; bind parameters (Ecto does it, `fragment` with interpolation breaks it; `fragment("? = ?", u.email, ^email)` is fine); when a literal beats a bind parameter (skewed data, partial index match).

#### Task 4: `references/joins.md`

**Inputs:** `corpus/join*.md`.
**Must cover:** nested loops, hash join, merge join, what makes Postgres pick each and which side needs the index; N+1: one query per row is the pathological nested loop moved into the app; Ecto `preload` as a second query (fine for one-to-many), `join` + `preload(..., [assoc: alias])` when filtering by the association, never load inside `Enum.map`; index the foreign key on the many side, Postgres does not create it; hash join needs the full row set so filter before joining and `select` only needed columns; merge join wants both sides sorted, an index can provide it.

#### Task 5: `references/sorting-grouping.md`

**Inputs:** `corpus/sorting-grouping*.md`.
**Must cover:** an index whose columns match `ORDER BY` in order and direction removes the Sort node and makes `LIMIT` cheap; pipelined execution vs sort everything then cut; mixed `ASC`/`DESC` requires the index declared the same way (`CREATE INDEX ... (inserted_at DESC, id ASC)`) and Ecto migration syntax for it (`create index(:orders, ["inserted_at DESC", "id ASC"])`); `NULLS FIRST/LAST` must match the index; `GROUP BY` on an index prefix gives GroupAggregate without a sort, otherwise HashAggregate; the `ORDER BY` columns can follow the equality columns of the `WHERE` in the same index.

#### Task 6: `references/pagination.md`

**Inputs:** `corpus/partial-results*.md`.
**Must cover:** top-N with `ORDER BY ... LIMIT` is only cheap on a pipelined index; `OFFSET` reads and discards, cost grows with page number, and rows shift between pages when data changes; keyset pagination with a row value comparison `WHERE (inserted_at, id) < (?, ?) ORDER BY inserted_at DESC, id DESC LIMIT ?`, the same index serves filter and order; the tie breaker column is mandatory; Ecto version with `where: fragment("(?, ?) < (?, ?)", o.inserted_at, o.id, ^ts, ^id)` plus `order_by` and `limit`; window functions (`ROW_NUMBER() OVER (ORDER BY ...)`) when page numbers are non negotiable and why they still read from the start.

#### Task 7: `references/dml.md`

**Inputs:** `corpus/dml*.md`.
**Must cover:** every index is one more write per inserted row, insert cost grows with index count; `UPDATE` on an indexed column removes and re-adds the entry in that index, non indexed columns cost only the heap write (plus HOT when it applies); `DELETE` and `UPDATE` use the same `WHERE` rules as `SELECT`, so the same index is needed to find the rows; bulk loads: load first, index after, or drop and recreate; Ecto `Repo.insert_all` and `Repo.update_all` shapes; the trade off question to ask before adding an index on a write heavy table.

#### Task 8: `references/explain.md`

**Inputs:** `corpus/explain-plan.md`, `corpus/explain-plan__postgresql*.md`, `corpus/testing-scalability*.md`.
**Must cover:** `EXPLAIN (ANALYZE, BUFFERS)` and reading the tree bottom up; Seq Scan, Index Scan, Index Only Scan, Bitmap Heap Scan and what each means; `Index Cond` is what the tree served, `Filter` is what was read then discarded, `Rows Removed by Filter` is the cost of a wrong index; estimate `rows` vs `actual rows` and `ANALYZE` the table when they diverge; `Sort` on top of `Index Scan` means the index order does not match; `Buffers: shared hit/read` as the honest cost; why tests pass and production is slow: data volume and load change the plan, so test with production sized data; how to get the plan from Ecto (`Repo.explain(:all, query, analyze: true, buffers: true)`).

#### Task 9: `references/myths.md`

**Inputs:** `corpus/myth-directory*.md`.
**Must cover, one section per myth, each stated then corrected:** "put the most selective column first" (order follows the queries; equality columns first, range last); "NULL cannot be indexed" (Postgres indexes NULL, `IS NULL` works); "indexes degenerate and need periodic rebuilds" (the tree self balances; bloat is measured with `pgstattuple` and fixed with `REINDEX CONCURRENTLY`, not on a schedule); "dynamic SQL is slow" (composed queries with bind parameters are fine, string built SQL is the problem, Ecto composition is dynamic SQL done right); "`SELECT *` only costs bandwidth" (it also blocks index-only scans); "more indexes is safer" (each costs writes and planner time).

---

### Task 10: `SKILL.md`

**Files:**
- Create: `skills/postgres-indexing/SKILL.md`

**Interfaces:**
- Consumes: the eight reference files from Tasks 2 to 9 (read them all first; the checklist must not contradict them and must name each file once).

- [ ] **Step 1: Read** `skills/send-pr/SKILL.md` (frontmatter style, tone) and all eight references.

- [ ] **Step 2: Write the file** with this structure. The frontmatter is fixed; the body follows the spec section "SKILL.md", around 150 lines.

```markdown
---
name: postgres-indexing
description: Writes and reviews Postgres queries, Ecto queries, schemas and migrations so they use their indexes. Runs a checklist by clause (WHERE, JOIN, ORDER BY, LIMIT, DML, index creation, EXPLAIN) with the Ecto equivalent for each rule. Use whenever writing or changing an Ecto query, `Repo.*` call, `Ecto.Query` `from`/`where`/`join`/`order_by`, `fragment`, a migration with `create index`, raw SQL, a `.sql` file, or when the user says "slow query", "add an index", "pagination", "N+1", "EXPLAIN", "query lenta", "tá lento", "adicionar índice", "criar índice", "paginação", "criar migration", "otimizar query". MANDATORY before writing any query, schema or migration that touches Postgres, because the checklist here catches mistakes that pass tests and only show up with production data volume.
---

# Writing queries that use their indexes

<golden rule, one sentence>

## Before the query: which index will serve it?
...
## 1. WHERE
## 2. JOIN
## 3. ORDER BY and GROUP BY
## 4. LIMIT and pagination
## 5. INSERT, UPDATE, DELETE
## 6. Creating an index
## 7. Verify with EXPLAIN
## Myths
```

Each numbered section: three lines per item (rule, mistake, Ecto form), ends with one line "Deeper: `references/<file>.md`, when <condition>". Section 6 includes the migration snippet:

```elixir
@disable_ddl_transaction true
@disable_migration_lock true

def change do
  create index(:orders, [:user_id, :inserted_at], concurrently: true)
end
```

- [ ] **Step 3: Lint.** `$SCRATCH/lint-skill.sh skills/postgres-indexing/SKILL.md`. Expected: exit 0. Also `grep -c 'references/' skills/postgres-indexing/SKILL.md` returns 8 or more, and every `references/<name>.md` mentioned exists.

- [ ] **Step 4: Commit.** `git add skills/postgres-indexing/SKILL.md && git commit -m "feat: add postgres-indexing skill"`.

---

### Task 11: Register the skill in the plugin

**Files:**
- Modify: `.claude-plugin/marketplace.json` (the `description` and `keywords` of the `skills` plugin)
- Modify: `README.md` (the sentence that lists the skills, and the skills section if one exists)

- [ ] **Step 1: Update marketplace.json**

`description` becomes: `pixel-perfect, for measuring design fidelity as a number, send-pr, for opening and shepherding Pull Requests, and postgres-indexing, for queries and migrations that use their indexes`. Append `"postgres", "ecto", "sql", "index"` to `keywords`.

- [ ] **Step 2: Update README.md.** `grep -n 'pixel-perfect' README.md` to find every line that enumerates the skills and add `/skills:postgres-indexing` in the same style. If there is a per-skill section, add one paragraph for this skill in the same shape as the others.

- [ ] **Step 3: Validate JSON.** `python3 -m json.tool .claude-plugin/marketplace.json > /dev/null && echo ok`. Expected: `ok`.

- [ ] **Step 4: Commit.** `git add .claude-plugin/marketplace.json README.md && git commit -m "feat: register postgres-indexing in the plugin"`.

---

### Task 12: Coverage pass against the corpus

**Files:**
- Create: `$SCRATCH/coverage.md` (not in the repo)

- [ ] **Step 1:** For every file in `corpus/`, read its headings (`grep '^#' file`) and write one line in `$SCRATCH/coverage.md`: `<corpus file> -> <reference file that covers it>` or `<corpus file> -> dropped: <reason>`. Valid reasons: other database, marketing or meta page, duplicate of another chapter.
- [ ] **Step 2:** For every line marked as covered, `grep -il '<key term>' skills/postgres-indexing/references/*.md` to confirm the term appears. Any covered chapter with no hit becomes a rule to add to the reference; add it, lint, commit with `feat: cover <topic> in <file> reference`.
- [ ] **Step 3:** Keep the dropped list; it goes into the PR description.

---

### Task 13: Live validation

- [ ] **Step 1:** `/reload-plugins` in a session with the marketplace installed (or `claude plugin marketplace update rodolfosilva` from the shell). Confirm `/skills:postgres-indexing` is listed.
- [ ] **Step 2:** In a fresh session inside any Elixir project, run the three prompts and check the answer:
  - "Add pagination to this users list" must produce keyset, not `OFFSET`.
  - "This query with `lower(email)` in the where is slow" must propose an expression index or `citext`, and an `EXPLAIN` to confirm.
  - "Create an index for this filter by status" must ask which statuses are hot and propose a partial index when one dominates.
- [ ] **Step 3:** If a prompt did not trigger the skill, add the missing phrase to `description`, lint, commit `fix: widen postgres-indexing triggers`, rerun that prompt.
- [ ] **Step 4:** Open the PR with `/skills:send-pr`. The PR body lists the dropped chapters from Task 12 as "Left out on purpose".
