# Index Anatomy

A btree index is not a magic speed switch, it is two data structures working together, and knowing what they are explains both why indexes help and why they sometimes do not. Come here when a query still feels slow despite hitting an index, before reaching for `REINDEX`, or before deciding whether a column belongs in an index key or in `INCLUDE`.

## An index is a sorted leaf chain under a search tree

The leaf pages hold the indexed values in sorted order and are linked to their neighbors, so once Postgres is on the right leaf it can walk forward or backward without touching the tree again. Above the leaves sits a balanced btree: branch pages that point down to the leaf holding a given range, and a root page on top of those. The tree only exists to answer one question fast: which leaf page starts the range I need.

```sql
CREATE INDEX orders_user_id_idx ON orders (user_id);
```

This index is a chain of leaf pages sorted by `user_id`, with a shallow tree above them. Tree depth grows with the logarithm of row count, so a table with a million rows and one with a hundred million rows have trees that differ by only one or two levels.

**Mistake:** picturing an index scan as reading every leaf page in order, like a smaller table scan. The tree exists precisely so a lookup skips straight to the matching leaf instead of walking the chain from the start.

## A lookup is three steps, not one

Finding rows through an index means: traverse the tree to the first matching leaf entry, follow the leaf chain forward while entries still match, then fetch each matching row from the table itself. The third step is a separate read for every match, because the leaf entry only carries the indexed columns plus a pointer to the row, not the whole row.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders WHERE user_id = 42;
```

The plan for this query shows an index scan for steps one and two, and a row fetch per match for step three. The deep read of how to tell these apart in a plan lives in explain.md.

**Mistake:** treating "it uses an index" as the end of the analysis. The tree traversal is cheap and bounded; the leaf scan and the row fetches are the parts that can still be expensive.

## A slow index almost never means a broken tree

Because tree depth barely grows, tree traversal is never the bottleneck, four or five levels handle millions of rows. When an indexed query is still slow, the cause is one of the other two steps: the leaf chain walk covers far more entries than expected, or each matching entry triggers a row fetch to a different, scattered part of the table. Rebuilding the index changes neither of these; it only repacks pages that were already doing their job.

```sql
REINDEX INDEX orders_user_id_idx; -- rarely the fix for a slow query
```

**Mistake:** reaching for `REINDEX` when a query slows down. Check first whether the `WHERE` clause still narrows the leaf range the way the index expects, and how many row fetches the plan performs.

## Index-only scans skip the table entirely

When every column a query touches, in the filter, the select list, or the sort, is already present in the index, Postgres can answer from the leaf pages alone and skip the row fetch step completely. This depends on the visibility map being current, which routine autovacuum keeps up to date.

```sql
CREATE INDEX orders_user_id_status_idx ON orders (user_id, status);

EXPLAIN SELECT status FROM orders WHERE user_id = 42;
-- Index Only Scan using orders_user_id_status_idx
```

```elixir
from(o in Order, where: o.user_id == ^user_id, select: o.status)
```

**Mistake:** widening an index to cover a `SELECT` list on the assumption that it will always help. An index-only scan saves the most when many rows match but few columns are needed; on a single-row lookup the row fetch it saves is negligible next to the write overhead the wider index adds.

## `INCLUDE` adds payload without growing the key

Columns listed in `INCLUDE` are stored in the leaf pages but take no part in the sort order, so they cannot narrow a search. They exist purely to let an index-only scan return more columns without lengthening the key that the tree has to compare and maintain.

```sql
CREATE INDEX orders_user_id_idx ON orders (user_id) INCLUDE (status, total);
```

**Mistake:** putting a column used in a `WHERE` condition into `INCLUDE`. Since it is not part of the key, Postgres cannot use it to narrow the leaf range, only to avoid a row fetch after the range is already found by other columns.

## Postgres heap tables are never clustered

Some databases can store a table's rows physically sorted by an index, so that scanning the index and scanning the table happen in the same order. Postgres does not do this. Table rows live in a heap, in whatever order they were inserted or reused after deletion, independent of any index built on them. The `CLUSTER` command can sort a table's rows to match one chosen index, but it is a one-time rewrite, not a maintained property.

```sql
CLUSTER orders USING orders_user_id_idx;
```

**Mistake:** assuming `CLUSTER` keeps the table sorted going forward. New rows and updated rows land wherever there is free space, so the physical order drifts again with normal write traffic.

## Access predicates narrow the scan, filter predicates only trim it

Not every condition on an indexed column earns its keep the same way. A condition that Postgres can use to pick the start and end of the leaf range, an access predicate, is what actually reduces the leaf chain walk. A condition evaluated against rows already pulled from that range, a filter predicate, only throws away rows after the work of reading them was already spent. Both can appear on the same query; the deep version of telling them apart in a plan lives in explain.md.

```sql
CREATE INDEX order_items_order_id_idx ON order_items (order_id);

EXPLAIN SELECT * FROM order_items
WHERE order_id = 100 AND quantity > 5;
-- order_id = 100 is the access predicate, it sets the leaf range
-- quantity > 5 is a filter predicate, checked row by row inside that range
```

**Mistake:** assuming any condition that mentions an indexed column narrows the scan. Only a leading, comparable condition on the column's position in the index key does that; a condition on a later key column acts as an index filter predicate, which Postgres still prints under Index Cond, so compare Index Cond to the index definition to tell them apart. A condition on a column outside the key altogether shows up as a plain Filter instead.

## One btree index can only narrow one range, two need combining

A single btree key has one sorted order, so it can only serve one column, or one leading run of equalities plus a single trailing range, as an access predicate. Two independent range or equality conditions on two different, separately indexed columns cannot both narrow the same scan. Postgres can still use both indexes by scanning each one, building an in-memory bitmap of matching row locations for each, and intersecting or unioning those bitmaps before it ever touches the table.

```sql
CREATE INDEX orders_status_idx ON orders (status);
CREATE INDEX orders_total_idx ON orders (total);

EXPLAIN SELECT * FROM orders WHERE status = 'refunded' AND total > 500;
-- BitmapAnd combining a Bitmap Index Scan on each index, before the Bitmap Heap Scan
```

The combined bitmap scan still costs more than one scan on a single tailored index would, because Postgres pays for two tree traversals and the memory to merge them. A composite index on `(status, total)` avoids that cost entirely for this exact query, at the price of being less reusable for queries that filter on `total` alone.

**Mistake:** creating two single-column indexes and expecting the same performance as a matching composite index. `BitmapAnd`/`BitmapOr` make single-column indexes usable together, but a purpose-built composite index is still cheaper for the query it was built for.
