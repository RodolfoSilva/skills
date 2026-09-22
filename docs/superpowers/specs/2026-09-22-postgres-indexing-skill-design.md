# postgres-indexing skill: design

A skill that makes the agent write Postgres queries, Ecto queries and migrations that can actually use their indexes. It ships in this plugin next to `send-pr` and `pixel-perfect`.

## Goal

Every time the agent writes or reviews something that touches Postgres, it runs a short checklist that catches the classic index mistakes before the code lands: functions on indexed columns, wrong column order in composite indexes, `OFFSET` pagination, N+1 loads, sorts that an index could serve, missing FK indexes. The rules are stated once, in the agent's own words, with the Ecto equivalent next to the SQL.

## Scope

- Postgres only. Behaviour specific to other databases is left out.
- Triggers on Ecto (`Ecto.Query`, `Repo.*`, schemas, migrations, `fragment`) and on plain SQL (raw `Repo.query`, `.sql` files, SQL pasted into the prompt, "this query is slow", "add an index").
- One skill, no split between a generic layer and an Ecto layer. The Ecto translation lives inline with each rule.

Out of scope for this round: server tuning (`work_mem`, autovacuum), partitioning, full text search, JSONB indexing, other databases. Each can become its own skill later.

## Layout

```
skills/postgres-indexing/
  SKILL.md                 checklist by SQL clause, around 150 lines
  references/
    index-anatomy.md       B-tree structure, leaf chain, why an index gets "slow"
    where-clause.md        equality vs range, functions and casts, NULL, obfuscated predicates, LIKE, bind parameters
    joins.md               nested loops, hash join, merge join; N+1; preload vs join in Ecto
    sorting-grouping.md    ORDER BY / GROUP BY served by an index, mixed ASC/DESC, NULLS FIRST/LAST
    pagination.md          top-N, OFFSET vs keyset, window functions
    dml.md                 what every index costs INSERT, UPDATE and DELETE
    explain.md             reading EXPLAIN (ANALYZE, BUFFERS) in Postgres, access vs filter predicates
    myths.md               common beliefs about indexes that are wrong
```

Registered in `.claude-plugin/marketplace.json` (`description` and `keywords`) and in `README.md` next to the other two skills.

## SKILL.md

**Frontmatter.** `description` in the style of `send-pr`: what it does, then triggers in English and Portuguese (query, migration, index, `Repo.`, `from`, `Ecto.Query`, `fragment`, `EXPLAIN`, "slow query", "add an index", "pagination", "tá lento", "adicionar índice", "paginação", "criar migration"), then "MANDATORY before writing any query, schema or migration that touches Postgres, because the checklist here catches mistakes that pass tests and only show up with production data volume."

**Golden rule, first line of the body.** An index only helps when the query lets Postgres walk the tree: equality conditions first, at most one range condition and it comes last, nothing wrapped around the indexed column.

**Checklist by clause.** Each item is three lines: the rule, the classic mistake, the Ecto form. Sections, in the order the agent writes a query:

1. **WHERE.** Column order in composite indexes (equality columns first, the range column last). A function or cast on the column disables the index; use an expression index or rewrite. `LIKE 'abc%'` uses the index, `'%abc'` does not (`ILIKE` never does without `lower()` expression index or trigram). NULL is indexed in Postgres; `IS NULL` works, but a partial index `WHERE col IS NOT NULL` is smaller when nulls dominate. Partial indexes for status flags and soft delete. Bind parameters always; Ecto does it, the leak is string interpolation inside `fragment`. Date obfuscation (`date_trunc`, `::date`, `to_char`) and math on the column (`col + 1 = ?`) are the same mistake in disguise. Dynamic `WHERE` built from optional filters: compose the query conditionally, never `col = ? OR ? IS NULL`.
2. **JOIN.** The three join algorithms and what makes Postgres pick each. Index the foreign key on the many side. N+1: `preload` with a second query is fine for one-to-many; `join` + `preload` when the filter needs the association; never load in a loop.
3. **ORDER BY / GROUP BY.** An index in the same column order and direction removes the sort node. Mixed ASC/DESC needs an index declared with the same mix. `NULLS FIRST/LAST` must match the index too. `GROUP BY` on an index prefix turns HashAggregate into GroupAggregate with no sort.
4. **LIMIT and pagination.** `LIMIT` is only cheap when the rows come pre-sorted from an index. `OFFSET n` reads and throws away n rows; cost grows with the page number. Keyset pagination: `WHERE (sort_col, id) > (?, ?) ORDER BY sort_col, id LIMIT ?`, same index serves both. In Ecto that is a row-value comparison in a `where` with `fragment` or two ordered conditions. Window functions when the client insists on page numbers.
5. **INSERT, UPDATE, DELETE.** Every index is one more write per row. UPDATE on an indexed column is a delete plus an insert in that index. DELETE and UPDATE need the same WHERE indexing as SELECT. Bulk loads: drop or defer indexes, recreate after.
6. **Creating an index.** One composite index beats several single-column ones when the query filters on all of them; a single-column index on the first column is redundant with the composite. Covering index with `INCLUDE` for index-only scans. Expression index for `lower(email)`. Partial index for the hot subset. In migrations: `create index(..., concurrently: true)` with `@disable_ddl_transaction true` and `@disable_migration_lock true`.
7. **Verify.** `EXPLAIN (ANALYZE, BUFFERS)`. Seq Scan on a large table is the first alarm. Index Scan with a large `Filter` and high `Rows Removed by Filter` means the index has the wrong columns or wrong order. `Index Cond` is the part the tree served; `Filter` is what was read and discarded. Compare `rows` estimate with `actual rows`; a big gap points at stale statistics.

**Myths, five lines at the end.** "Most selective column first" (order follows the queries, not selectivity). "NULL cannot be indexed" (it can, in Postgres). "Indexes degenerate and need rebuilding" (B-trees self-balance; bloat is a different, measurable thing). "Dynamic SQL is slow" (composed queries with bind parameters are fine; string-built SQL is the problem). "`SELECT *` is only about bandwidth" (it also prevents index-only scans).

**Pointers.** Each section ends with one line naming its `references/` file and when to open it: "three or more joins, read joins.md"; "the plan shows Sort on top of Index Scan, read sorting-grouping.md".

## References

Each file is 80 to 200 lines of original text. Every rule has a Postgres SQL example and, where the shape changes, the same thing in Ecto. Examples use generic tables (`users`, `orders`, `order_items`) so any project maps onto them. No quotations, no links, no author names, no book or site titles anywhere in the skill, the references, the commit messages or the PR.

## Source material

The rules are distilled from a local reference corpus on SQL indexing that stays outside git: `corpus/` is listed in `.gitignore`, and the download script lives in the session scratchpad, not in the repo. The corpus is raw material for writing; nothing from it is copied verbatim into the skill.

Download rules: table of contents first, then one page per second, HTML converted to Markdown with `markdownify`, skipping the chapters that cover other databases. Around 70 pages remain.

## Validation

1. **Coverage.** After the references are written, go back through the corpus chapter by chapter and confirm each tip became a rule or was dropped on purpose. The dropped list goes in the PR description, not in the skill.
2. **Real use.** In a fresh session, run three prompts and check that the skill triggers and the answer applies the right rule:
   - "Add pagination to this users list" must produce keyset, not `OFFSET`.
   - "This query with `lower(email)` in the where is slow" must propose an expression index or a `citext` column, and an `EXPLAIN` to confirm.
   - "Create an index for this filter by status" must ask which statuses are hot and propose a partial index when one dominates.
   If a prompt does not trigger the skill, extend `description` and rerun.
3. **Plugin load.** `/reload-plugins` in a session with the marketplace installed, confirm `/skills:postgres-indexing` appears.

## Delivery

Work on the current branch. One PR via `send-pr` containing the skill, the marketplace entry, the README line and this spec. Optional: a Codex review of the finished skill in an Orca worktree before opening the PR.
