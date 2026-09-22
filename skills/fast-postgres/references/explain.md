# Reading EXPLAIN Output

`EXPLAIN` is how you check whether an index actually did what you built it for, instead of guessing from response time alone. SKILL.md sends the agent here whenever a query is slow, whenever a new index needs to be verified, or whenever the plan text itself needs interpreting.

## Run EXPLAIN (ANALYZE, BUFFERS) and read the tree from the bottom up

`EXPLAIN` alone only shows the planner's estimate. Adding `ANALYZE` actually runs the statement and records real timings and row counts; adding `BUFFERS` records how many pages it touched. The plan is a tree of nodes, and each node feeds rows to the one above it, so the bottom-most nodes run first and their output shapes everything the rest of the tree can do.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, total
FROM orders
WHERE user_id = 42;
```

```
Index Scan using orders_user_id_idx on orders
  (cost=0.29..8.31 rows=3 width=12) (actual time=0.015..0.018 rows=3 loops=1)
  Index Cond: (user_id = 42)
  Buffers: shared hit=4
Planning Time: 0.084 ms
Execution Time: 0.033 ms
```

**Mistake:** running plain `EXPLAIN` on a slow query and trusting the estimated `cost` and `rows`. Those numbers come from table statistics, not from what the query actually did, and can be wrong by orders of magnitude.

## Tell the table access operations apart

Each access operation tells a different story about how Postgres reached the rows.

`Seq Scan` reads the whole table in physical order and checks every row against the condition. Cheap for small tables or when most rows qualify, expensive otherwise.

`Index Scan` walks the index to find matching entries, then fetches each matching row from the table one at a time.

`Index Only Scan` walks the index the same way but never touches the table, because every column the query needs is already in the index.

`Bitmap Heap Scan`, paired with a `Bitmap Index Scan` below it, first collects every matching tuple pointer from the index, sorts them by physical position, then reads the table in that order. It turns scattered lookups into fewer, more sequential reads, which pays off when a moderate fraction of the table matches.

```sql
CREATE INDEX orders_status_idx ON orders (status);

EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM orders WHERE status = 'refunded';
```

```
Bitmap Heap Scan on orders  (actual rows=1200 loops=1)
  Recheck Cond: (status = 'refunded')
  -> Bitmap Index Scan on orders_status_idx
       Index Cond: (status = 'refunded')
```

**Mistake:** assuming any node with "Index" in its name is fast. A `Bitmap Heap Scan` or `Index Scan` covering most of the table can cost more than a `Seq Scan`, and the planner will switch to `Seq Scan` on its own once the matched fraction gets large.

## Separate what the index served from what got thrown away

`Index Cond` is the condition that shaped what the scan actually retrieved from the index or the table. `Filter` runs after the row is already in hand and only decides whether to keep it, so it never narrows the scan itself.

```sql
CREATE INDEX orders_user_id_idx ON orders (user_id);

EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM orders
WHERE user_id = 42 AND status = 'paid';
```

```
Index Scan using orders_user_id_idx on orders
  Index Cond: (user_id = 42)
  Filter: (status = 'paid')
  Rows Removed by Filter: 37
```

`status` is not part of the index, so Postgres fetches every row for `user_id = 42` and only then checks `status`, discarding the ones that fail. `Rows Removed by Filter` is exactly the cost of that: the more rows it removes, the more work the index did for nothing. A composite index on `(user_id, status)` would turn `status` into an `Index Cond` too, so nothing gets fetched just to be discarded.

`Index Cond` by itself does not prove a condition narrowed anything. Postgres uses that same label both for a true access predicate, which sets where the leaf traversal starts and stops, and for an index filter predicate, which is only checked while walking leaves already selected by an earlier column, without moving those bounds. Once a column stops being pinned by an equality, no column after it in the index can narrow the range any further, even if the plan still lists it under `Index Cond`.

```sql
CREATE INDEX orders_user_id_inserted_at_idx ON orders (user_id, inserted_at);

EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM orders
WHERE user_id > 100000 AND inserted_at > now() - interval '7 days';
```

```
Index Scan using orders_user_id_inserted_at_idx on orders
  Index Cond: ((user_id > 100000) AND (inserted_at > (now() - '7 days'::interval)))
```

`user_id > 100000` sets the real starting point of the scan. `inserted_at` comes second in the index, but `user_id` is bounded by a range rather than an equality, so there is no single position where "recent enough" rows begin across every `user_id` value above 100000. Postgres checks the `inserted_at` condition entry by entry while walking past all of them, exactly like a `Filter` would, and still prints it on the same `Index Cond` line. Spotting this means comparing every condition in `Index Cond` to the index definition: a condition only narrows the range if every column before it is pinned by an equality.

**Mistake:** seeing `Index Scan` in the plan and stopping there. Check `Rows Removed by Filter` right below it. A scan that discards thousands of rows per match for a wrong index shape behaves like a partial table scan, only slower to spot.

## Compare estimated rows to actual rows

The planner picks operations based on row count estimates from table statistics, not from the real data. When `rows` (estimated) and `actual rows` diverge by a large factor, the planner is working from stale or wrong statistics, and the operations it picked, an `Index Scan` instead of a `Bitmap Heap Scan`, a nested loop instead of a hash join, may no longer fit the real data.

```sql
EXPLAIN ANALYZE
SELECT id FROM orders WHERE status = 'refunded';
```

```
Seq Scan on orders  (cost=0.00..2100.00 rows=10 width=4)
                    (actual time=0.02..14.30 rows=8000 loops=1)
```

```sql
ANALYZE orders;
```

**Mistake:** tuning indexes against a plan built on outdated statistics. Run `ANALYZE` on the table first (or confirm autovacuum ran recently) so the estimate reflects the current data before deciding an index is wrong.

## Watch for a Sort sitting directly on top of an Index Scan

When the index order used by the scan does not match the query's `ORDER BY`, Postgres adds an explicit `Sort` node above the scan. That `Sort` has to buffer the whole intermediate result before it can return the first row, which defeats a `LIMIT` that was meant to stop early.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, total
FROM orders
WHERE user_id = 42
ORDER BY total DESC
LIMIT 10;
```

```
Limit
  -> Sort
       Sort Key: total DESC
       -> Index Scan using orders_user_id_idx on orders
            Index Cond: (user_id = 42)
```

An index on `(user_id, total DESC)` would let the scan produce rows already in the right order, removing the `Sort` node entirely.

**Mistake:** reading only the top-level node's cost and missing a `Sort` further down the tree. The `Sort` is often where most of the actual time goes, even though the row count above it looks small.

## Read Buffers: shared hit/read as the honest cost

`shared hit` counts pages found already in Postgres's own shared buffer cache; `shared read` counts pages it had to ask the operating system for because they were not there. A `shared read` is not proof of a physical disk read, since the OS page cache can still serve it from memory, but it does mean Postgres's cache missed, which is the number to trust once other queries have had a chance to push pages out between runs. `Execution Time` alone can mislead, because a query run twice in a row looks fast the second time purely from caching, which will not hold once other queries have pushed those pages out in production.

```
Buffers: shared hit=3 read=812
```

A plan reading hundreds of pages from disk for a query that returns a handful of rows is a sign the index is not selective enough, even if the wall clock time still looks acceptable on a warm cache.

**Mistake:** judging a query only by `Execution Time` measured right after running it a few times in development. Look at `shared read` too, since that is the cost that shows up on a cold cache or under memory pressure in production.

## Test with data and load sized like production

Response time depends on data volume and concurrent load as much as on the SQL and the index. A wrong index, one where a condition ends up as `Filter` instead of `Index Cond`, scales with the size of the range it scans; a correct index scales with the size of the result. On a small development table both look equally fast, and the gap only shows up once the table has grown, or once other queries are competing for the same pages.

```sql
-- seed a table to a realistic size before trusting a plan comparison
INSERT INTO orders (user_id, status, total, inserted_at)
SELECT (random() * 100000)::int,
       (ARRAY['pending', 'paid', 'refunded'])[floor(random() * 3 + 1)::int],
       (random() * 500)::numeric(10, 2),
       now() - (random() * interval '365 days')
FROM generate_series(1, 2000000);
```

**Mistake:** trusting a plan comparison run against an empty or freshly seeded table with no other activity. Re-run it against a table close to production size, and if possible while another session is generating background load, before ruling one index shape better than another.

## Get the plan from Ecto

`Repo.explain/3` runs the query through Postgres and returns the plan as a string, using the same options as raw `EXPLAIN`.

```elixir
Repo.explain(:all, query, analyze: true, buffers: true)
|> IO.puts()
```

This gives the exact tree Postgres would produce for that query, so the checks above apply the same way whether the query started as SQL or as an Ecto query.

**Mistake:** calling `Repo.explain/3` without `analyze: true` and `buffers: true`. Without them it only returns the planner's estimate, the same limitation as plain `EXPLAIN`, so there is no `actual rows` to compare against and no `Buffers` line to read.
