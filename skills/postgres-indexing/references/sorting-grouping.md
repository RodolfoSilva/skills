# Sorting and Grouping

Sorting is expensive: Postgres must read the entire input before it can emit a single row, so a `Sort` node blocks on the whole result set and buffers it in memory or on disk. An index stores rows in a fixed order, so a scan that walks the index in that same order needs no `Sort` node at all. SKILL.md sends the agent here whenever a query has an `ORDER BY`, a `GROUP BY`, or a `LIMIT` on a query that also sorts, and the plan still shows an explicit `Sort` or `HashAggregate` that a different index shape could remove.

## Make the index order match the ORDER BY order

When an index's column order and direction match the `ORDER BY` clause, Postgres can walk the index leaf pages directly and skip sorting. The scan then produces rows one at a time in final order, so `LIMIT` can stop early instead of materializing every row first.

```sql
CREATE INDEX orders_inserted_at_idx ON orders (inserted_at);

SELECT id, total
FROM orders
ORDER BY inserted_at
LIMIT 20;
```

```elixir
create index(:orders, [:inserted_at])
```

With the index in place, `EXPLAIN` shows an `Index Scan` feeding `Limit` directly, no `Sort` node above it. Without the index, Postgres reads every row, sorts all of them, and only then takes the first 20, which costs the same no matter how small the `LIMIT` is.

**Mistake:** relying on a sequential scan plus a `Sort` node for a query that always takes a small `LIMIT`. The cost of that plan grows with table size even though the result size never does.

## Put the ORDER BY columns after the WHERE equality columns in the same index

A single index can serve both an equality filter and a sort, as long as the equality columns come first and the sort columns come right after them, in the order the query sorts by.

```sql
CREATE INDEX orders_user_id_inserted_at_idx ON orders (user_id, inserted_at);

SELECT id, total
FROM orders
WHERE user_id = 42
ORDER BY inserted_at
LIMIT 10;
```

```elixir
from o in Order,
  where: o.user_id == ^user_id,
  order_by: [asc: o.inserted_at],
  limit: 10
```

Within the slice of the index where `user_id = 42`, the rows are already ordered by `inserted_at`, so Postgres scans that slice in order and never sorts. This only holds for the range actually scanned: widen the `WHERE` to `user_id IN (42, 43)` and the slice spans two different sub-ranges, each sorted by `inserted_at` on its own, so the combined result is no longer globally sorted and Postgres falls back to an explicit sort.

**Mistake:** indexing `(inserted_at, user_id)` for this query. The sort column leads, so an equality filter on `user_id` can no longer produce a contiguous, correctly ordered index range.

## Declare mixed ASC/DESC directions on the index itself

Postgres can read a single-direction index backwards for free, so an index on `(a, b)` alone still satisfies `ORDER BY a DESC, b DESC`. It cannot do that when a query sorts one column ascending and another descending, because there is no direction reversal that satisfies both at once. In that case the index must declare each column's direction explicitly.

```sql
CREATE INDEX orders_inserted_at_id_idx
    ON orders (inserted_at DESC, id ASC);

SELECT id, inserted_at
FROM orders
ORDER BY inserted_at DESC, id ASC
LIMIT 20;
```

```elixir
create index(:orders, ["inserted_at DESC", "id ASC"])
```

**Mistake:** creating a plain `(inserted_at, id)` index for a query that sorts `inserted_at DESC, id ASC`. Reading that index in either direction gives both columns the same relative order, which matches neither the query nor its reverse.

## Match NULLS FIRST/LAST between the query and the index

Postgres defaults to sorting nulls as the largest value in `ASC` order and the smallest in `DESC` order. When a query overrides that with an explicit `NULLS FIRST` or `NULLS LAST`, the index needs the same modifier or the scan produces rows in the wrong order for a pipelined sort.

```sql
CREATE INDEX orders_shipped_at_idx
    ON orders (shipped_at DESC NULLS LAST);

SELECT id, shipped_at
FROM orders
ORDER BY shipped_at DESC NULLS LAST
LIMIT 20;
```

```elixir
create index(:orders, ["shipped_at DESC NULLS LAST"])
```

**Mistake:** sorting with `ORDER BY shipped_at DESC NULLS LAST` against a default `(shipped_at DESC)` index, which places nulls first for a descending sort. The direction matches but the null placement does not, so Postgres still sorts.

## Give GROUP BY the same index prefix it would need for ORDER BY

Postgres groups rows with either a `HashAggregate`, which buffers every group in memory before returning any of them, or a `GroupAggregate`, which expects its input pre-sorted by the grouping columns and can emit each group as soon as the next key value appears. An index on the grouping columns lets the planner choose `GroupAggregate` fed by an index scan, skipping the sort step entirely.

```sql
CREATE INDEX order_items_order_id_product_id_idx
    ON order_items (order_id, product_id);

SELECT order_id, product_id, sum(quantity)
FROM order_items
GROUP BY order_id, product_id;
```

```elixir
from oi in OrderItem,
  group_by: [oi.order_id, oi.product_id],
  select: {oi.order_id, oi.product_id, sum(oi.quantity)}
```

`ASC`/`DESC` and `NULLS FIRST`/`LAST` do not matter for `GROUP BY`, since grouping only needs rows of the same key adjacent to each other, not in a particular direction. Postgres is an exception on nulls, though: if the index treats null as the smallest value, it may skip the pipelined `GroupAggregate` for a grouping column that contains nulls. Adding an `ORDER BY` that matches the index column order works around this.

**Mistake:** grouping by `product_id, order_id` while the index is `(order_id, product_id)`. The grouping key order does not match the index prefix, so Postgres cannot rely on the index order and falls back to `HashAggregate`.
