---
name: fast-postgres
description: Writes and reviews Postgres queries, Ecto queries, schemas and migrations so they use their indexes. Runs a checklist by clause (WHERE, JOIN, ORDER BY, LIMIT, DML, index creation, EXPLAIN) with the Ecto equivalent for each rule. Use whenever writing or changing an Ecto query, `Repo.*` call, `Ecto.Query` `from`/`where`/`join`/`order_by`, `fragment`, a migration with `create index`, raw SQL, a `.sql` file, or when the user says "slow query", "add an index", "pagination", "N+1", "EXPLAIN", "query lenta", "tá lento", "adicionar índice", "criar índice", "paginação", "criar migration", "otimizar query". MANDATORY before writing any query, schema or migration that touches Postgres, because the checklist here catches mistakes that pass tests and only show up with production data volume.
---

# Writing queries that use their indexes

An index serves a query only when the query's clauses match the index's column order, direction and expressions, so decide which index will serve each clause before writing it and prove it with `EXPLAIN (ANALYZE, BUFFERS)` after.

## Before the query: which index will serve it?

A btree is a sorted chain of leaf pages under a shallow tree. A lookup is three steps: walk the tree to the first matching leaf, walk the leaf chain while entries match, fetch each matching row from the table. The tree is never the slow part; a wide leaf range or many scattered row fetches are. Name the index for every clause below before typing the query. If none exists, the query gets a migration (section 6) or a rewrite.

Deeper: `references/index-anatomy.md`, when a query is slow despite hitting an index, or before choosing between key columns and `INCLUDE`.

## 1. WHERE

- **Equality columns first, one range last.** Only a leading run of equalities narrows the scan; everything after the first range condition is checked row by row.
  Mistake: `(inserted_at, user_id)` for `WHERE user_id = 42 AND inserted_at >= ...`.
  Ecto: `create index(:orders, [:user_id, :inserted_at])`
- **Two conditions on separately indexed columns cannot both narrow one scan.** Postgres BitmapAnds the two single-column indexes, which costs more than one composite built for the query (see `references/index-anatomy.md`).
  Mistake: `(status)` and `(inserted_at)` as separate indexes for `WHERE status = 'refunded' AND inserted_at > now() - interval '7 days'`, expecting composite-index speed.
  Ecto: `create index(:orders, [:status, :inserted_at])`
- **A function or cast on the column needs an expression index.** `lower(email)`, `date_trunc(...)`, `column::int` and `a || b` all hide the column from a plain index.
  Mistake: indexing `email` and filtering on `lower(email)`; the query runs a sequential scan.
  Ecto: `create index(:users, ["lower(email)"])` with `where: fragment("lower(?)", u.email) == ^String.downcase(email)`, or a `citext` column.
- **Write date ranges as bounds, move arithmetic to the constant side.** `inserted_at >= ^from and inserted_at < ^to` keeps the column bare; so does `total = 99` instead of `total + 1 = 100`.
  Mistake: `date_trunc('day', inserted_at) = '2024-01-01'`.
  Ecto: `where: o.inserted_at >= ^start_date and o.inserted_at < ^end_date`
- **`LIKE 'ana%'` is a range scan, `LIKE '%ana%'` needs a trigram index.** A leading wildcard has no starting point in a btree. `ILIKE` never uses a plain btree; index `lower(col)` and match with `LIKE` on `lower(col)`, or use `pg_trgm`.
  Mistake: expecting a plain index on `email` to serve `LIKE '%ana%'` or any `ILIKE`.
  Ecto: `execute "CREATE INDEX users_email_trgm_idx ON users USING gin (email gin_trgm_ops)"` after `CREATE EXTENSION pg_trgm`.
- **`IS NULL` uses a plain index; use a partial index when one value dominates.** Postgres stores NULL in btrees, and a partial index stays small when the query only cares about a slice.
  Mistake: indexing `status` across a table where nearly every row is `'completed'`.
  Ecto: `create index(:users, [:email], where: "deleted_at IS NULL")` with `where: is_nil(u.deleted_at)`.
- **Add optional filters by composition, never with `OR $1 IS NULL`.** A generic plan cannot use an index tuned to either branch of `status = $1 OR $1 IS NULL`.
  Mistake: one big `WHERE` that toggles every filter with `OR ? IS NULL`.
  Ecto: `query = if status, do: where(query, [o], o.status == ^status), else: query`
- **Bind values with `^`, never interpolate into SQL.** Bound parameters keep the prepared statement cache warm and close the injection hole (a literal is only for a skewed value that must shape the plan, see `references/where-clause.md`).
  Mistake: `Repo.query!("... WHERE email = '#{email}'")`.
  Ecto: `where: u.email == ^email` (or `where: fragment("? = ?", u.email, ^email)` when the comparison itself needs raw SQL)

Deeper: `references/where-clause.md`, when a query has an index but still sequential-scans, when choosing column order for a composite index, or when a condition looks fine but disables the index.

## 2. JOIN and N+1

- **Index the foreign key on the many side.** Postgres indexes primary keys automatically and foreign keys never; a nested loop needs the index on the inner, non-driving side.
  Mistake: trusting the `REFERENCES` constraint to make `orders.user_id` lookups fast.
  Ecto: `create index(:orders, [:user_id])` in the same migration as `references(:users)`.
- **Match the index to the algorithm the planner picks.** Nested loop needs the inner join column indexed; hash join needs only the independent filter that shrinks one side; merge join is only cheap when an index already delivers the order.
  Mistake: indexing `orders.user_id` to speed up a query the plan runs as a hash join; the index sits unused.
  Ecto: index the `where:` column on the hashed side, and `select:` only the columns the caller needs so the hash table stays small.
- **Never turn a join into N+1 queries.** One query per parent row is the nested loop with a network round trip added to every iteration.
  Mistake: `Repo.preload/2` or `Repo.all/1` inside `Enum.map/2` over a list already in memory.
  Ecto: `Repo.preload(users, :orders)` on the whole list, or `preload: :orders` in the query.
- **Preload for a plain load, join when filtering or ordering by the association.** `preload:` alone is two queries total, which is fine; a filter on the child column needs the join in the main query.
  Mistake: `preload: :orders` then filtering paid orders in Elixir.
  Ecto: `join: o in assoc(u, :orders), where: o.status == "paid", preload: [orders: o]`

Deeper: `references/joins.md`, when a query joins two or more tables, an association is being loaded, or the plan shows a `Hash Join` you did not expect.

## 3. ORDER BY and GROUP BY

- **Make the index order match the `ORDER BY`, after the `WHERE` equality columns.** Within one equality slice the rows are already sorted, so `Index Scan` feeds `Limit` with no `Sort` node.
  Mistake: `(inserted_at, user_id)` for `WHERE user_id = 42 ORDER BY inserted_at`, or `user_id IN (42, 43)`, which spans two sorted slices and still sorts.
  Ecto: `create index(:orders, [:user_id, :inserted_at])` with `order_by: [asc: o.inserted_at]`.
- **Declare mixed directions and `NULLS` placement on the index.** A single-direction index reads backwards for free; `a DESC, b ASC` does not, and a `NULLS` placement that differs from the default (`ASC NULLS LAST`, `DESC NULLS FIRST`) needs the index declared the same way.
  Mistake: a plain `(inserted_at, id)` index for `ORDER BY inserted_at DESC, id ASC`.
  Ecto: `create index(:orders, ["inserted_at DESC", "id ASC"])` or `["shipped_at DESC NULLS LAST"]`.
- **Give `GROUP BY` the same index prefix an `ORDER BY` would need.** Sorted input lets the planner pick a pipelined `GroupAggregate` over a buffering `HashAggregate`.
  Mistake: expecting `GROUP BY product_id` to use `(order_id, product_id)`; `product_id` is not a prefix.
  Ecto: `group_by: [oi.order_id, oi.product_id]` on `create index(:order_items, [:order_id, :product_id])`.

Deeper: `references/sorting-grouping.md`, when the plan still shows `Sort` or `HashAggregate` above an index scan.

## 4. LIMIT and pagination

- **`ORDER BY ... LIMIT` is cheap only on a matching index.** Then the scan stops after N rows; without it Postgres sorts every matching row first.
  Mistake: loading every row and slicing the first 20 in Elixir.
  Ecto: `order_by: [desc: o.inserted_at, desc: o.id], limit: 20`
- **Never page with `OFFSET`.** Page 50 reads and discards 49 pages of rows, and concurrent inserts shift rows between pages.
  Mistake: `LIMIT 20 OFFSET 100` for "page 6", assuming it costs the same as page 1.
  Ecto: no `offset:` in a paginated query; use the keyset below.
- **Page with a keyset row comparison and a unique tie breaker.** `(inserted_at, id) < (?, ?)` starts the index scan where the last page ended, and `id` makes ties deterministic.
  Mistake: two separate conditions `inserted_at <= ? AND id < ?`, which drops rows, or `inserted_at` alone, which repeats them.
  Ecto: `where: fragment("(?, ?) < (?, ?)", o.inserted_at, o.id, ^last_inserted_at, ^last_id)`
- **Use `row_number()` only when a numbered page is required.** It costs the same as `OFFSET`; its only gain is an absolute position.
  Mistake: `ROW_NUMBER()` pagination for an infinite-scroll feed.
  Ecto: keep keyset for "load more"; a window function only for a screen with direct page links.

Deeper: `references/pagination.md`, when a query has `LIMIT` with `OFFSET`, a page number in the request, or a "give me more" endpoint.

## 5. INSERT, UPDATE, DELETE

- **Every index is one more write per inserted row.** Four indexes counting the primary key mean five writes; `insert_all/2` saves round trips, not index maintenance.
  Mistake: adding an index "just in case" on a table that takes far more writes than the reads it would serve.
  Ecto: `Repo.query!("SELECT relname, idx_scan, n_tup_ins, n_tup_upd, n_tup_del FROM pg_stat_user_tables WHERE relname = 'orders'")` before the migration, to compare reads against writes.
- **An update on an indexed column removes and re-adds the entry.** A column outside every index only needs the heap write and can be a heap-only tuple update.
  Mistake: setting every column of a struct regardless of what changed.
  Ecto: a changeset only puts changed fields in `SET`; `Repo.update_all(set: [status: "shipped"])` shows exactly which indexes pay.
- **`DELETE` and `UPDATE` need the same index a `SELECT` on that `WHERE` would.** Finding the rows is the cost; touching them is cheap.
  Mistake: blaming the delete when the cost is an unindexed scan to locate the rows.
  Ecto: `from(o in Order, where: o.status == "cancelled") |> Repo.delete_all()` with `create index(:orders, [:status])`.
- **Bulk load first, create indexes after.** Building the tree once in a single pass beats thousands of individual insertions with page splits.
  Mistake: `COPY` of millions of rows into a table that already has its full set of indexes.
  Ecto: `drop index` and `create index` in the migration around the load; the load itself runs through `\copy` or `COPY ... FROM STDIN`.

Deeper: `references/dml.md`, before adding an index to a write-heavy table, or when a bulk import is slower than it should be.

## 6. Creating an index

- **One index per query pattern that actually runs, not one per column.** Extra indexes slow every write and give the planner more paths to weigh.
  Mistake: `(status)`, `(total)`, `(inserted_at)` each alone on a busy write table "to be safe".
  Ecto: one composite index shaped like sections 1 and 3 above, then drop the single-column ones it makes redundant.
- **Key columns narrow, `INCLUDE` columns only avoid the row fetch.** A column in `INCLUDE` cannot narrow a `WHERE`, though it can still be checked as a Filter on the index tuple; it exists so an index-only scan can return it.
  Mistake: putting a filtered column in `INCLUDE` and expecting it to narrow the scan.
  Ecto: `create index(:orders, [:user_id], include: [:status, :total])`
- **Create concurrently, outside the DDL transaction.** A plain `CREATE INDEX` locks writes on the table for its whole duration.
  Mistake: `create index(:orders, [:user_id])` in a default migration on a production table.
  Ecto:

```elixir
@disable_ddl_transaction true
@disable_migration_lock true

def change do
  create index(:orders, [:user_id, :inserted_at], concurrently: true)
end
```

Deeper: `references/index-anatomy.md` for key versus `INCLUDE` and index-only scans; `references/dml.md` for the write cost, when deciding whether the index earns its keep.

## 7. Verify with EXPLAIN

- **Run `EXPLAIN (ANALYZE, BUFFERS)` and read the tree bottom up.** Plain `EXPLAIN` shows estimates only; `ANALYZE` runs the statement and records real rows and time.
  Mistake: trusting `cost` and `rows` from plain `EXPLAIN` on a slow query.
  Ecto: `Repo.explain(:all, query, analyze: true, buffers: true) |> IO.puts()`
- **`Index Cond` narrows, `Filter` discards, and `Rows Removed by Filter` is the waste.** A condition under `Index Cond` only narrows if every column before it in the index is pinned by an equality.
  Mistake: seeing `Index Scan` and stopping there.
  Ecto: compare each `Index Cond` line to the `create index` column list.
- **Compare estimated `rows` to `actual rows`; run `ANALYZE` when they diverge.** The planner chose the operation from statistics, not from the data.
  Mistake: tuning indexes against a plan built on stale statistics.
  Ecto: `Repo.query!("ANALYZE orders")` before re-reading the plan.
- **A `Sort` above an `Index Scan` means the index order does not match the `ORDER BY`.** It buffers the whole result and defeats the `LIMIT`.
  Mistake: reading only the top node's cost and missing the `Sort` below.
  Ecto: fix the index per section 3, then re-run `Repo.explain/3`.
- **Read `shared read` and test at production size.** `Execution Time` on a warm cache and a small table hides the cost that shows up in production.
  Mistake: judging a query by its second run in development.
  Ecto: seed with `generate_series` to production size before comparing two index shapes.

Deeper: `references/explain.md`, when a query is slow, a new index needs verifying, or the plan text needs interpreting.

## Myths

Do not act on these, each is refuted in `references/myths.md`: the most selective column goes first in a compound index (equality columns first, range last, is the rule); NULL cannot be indexed (Postgres stores it, `IS NULL` uses the index); indexes degrade and need scheduled `REINDEX` (measure bloat with `pgstattuple` first); dynamic SQL is slow (interpolated values are slow, bound parameters in a composed query are not); `SELECT *` only costs bandwidth (it also rules out an index-only scan); more indexes is always safer (every unused index is a standing write cost).
