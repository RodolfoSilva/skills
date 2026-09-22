# Pagination

Fetching "the next page" sounds like a small problem, but the naive ways to do it get slower as the table grows or silently return the wrong rows once other requests are inserting or deleting concurrently. SKILL.md sends the agent here whenever a query has a `LIMIT` combined with `OFFSET`, a page number in the request, or an infinite-scroll style "give me more" endpoint.

## Ask Postgres for only the rows you need

`ORDER BY ... LIMIT` is only cheap when Postgres can walk a matching index in order and stop as soon as it has enough rows. This is a pipelined scan: no separate sort step, no need to touch rows past the limit. Without an index that already produces the right order, Postgres has to read and sort every matching row first, then throw away everything past the limit, so the cost stops depending on the limit and starts depending on the table size.

```sql
CREATE INDEX orders_inserted_at_id_idx
    ON orders (inserted_at DESC, id DESC);

SELECT id, total
FROM orders
ORDER BY inserted_at DESC, id DESC
LIMIT 20;
```

```elixir
from o in Order,
  order_by: [desc: o.inserted_at, desc: o.id],
  limit: 20
```

**Mistake:** loading every row into the application and slicing the first 20 there. Postgres still has to produce and ship the full result before the slicing happens.

## Do not page with OFFSET

`OFFSET` tells Postgres to read the first N rows in order and discard them before returning anything. The database still visits every discarded row, so a request for page 50 costs roughly 50 times more than page 1, and the cost keeps climbing the further a user pages back. On top of that, rows shift between pages: if a new order is inserted while someone is browsing, the row that used to sit at position 21 moves to position 22, and the next page either repeats it or skips the row that used to be there.

```sql
SELECT id, total
FROM orders
ORDER BY inserted_at DESC, id DESC
LIMIT 20 OFFSET 100;
```

**Mistake:** building "page 6" as `OFFSET 100 LIMIT 20` and assuming the response time is the same as page 1. It is not, and it degrades exactly when the table is busiest.

## Page with a keyset comparison instead of counting rows

Instead of counting past unwanted rows, remember the last row shown and ask for the rows that come after it. Postgres supports comparing whole row values directly, so `(inserted_at, id) < (?, ?)` reads as "anything that sorts after this pair" and can be answered by the same index that already serves the `ORDER BY`. There is nothing to discard: the index scan starts right where the previous page ended.

```sql
SELECT id, total, inserted_at
FROM orders
WHERE (inserted_at, id) < (?, ?)
ORDER BY inserted_at DESC, id DESC
LIMIT 20;
```

```elixir
from o in Order,
  where: fragment("(?, ?) < (?, ?)", o.inserted_at, o.id, ^last_inserted_at, ^last_id),
  order_by: [desc: o.inserted_at, desc: o.id],
  limit: 20
```

The parameters `last_inserted_at` and `last_id` come from the last row of the page the client already has, not from a page number. This keeps the query's cost constant no matter how deep a user pages, and it never repeats or skips a row when other transactions insert or delete concurrently, since the comparison is anchored to real values instead of a row count.

**Mistake:** writing the comparison as two separate conditions, `inserted_at <= ? AND id < ?`. That drops every earlier row whose id happens to be larger than the boundary id, so rows quietly go missing.

## Always include a tie breaker column in the keyset

`inserted_at` alone is rarely unique: two orders can be inserted in the same microsecond, and a sort on a non-unique column does not have to return ties in any particular order. Without a second, unique column in both the index and the comparison, Postgres can hand back the same row twice on consecutive pages, or drop one entirely, and it can happen differently on every run since nothing forces a stable tie-break order.

```sql
CREATE INDEX orders_inserted_at_id_idx
    ON orders (inserted_at DESC, id DESC);
```

Adding the primary key as the last column of the sort and the index, as in the two examples above, is usually the cheapest way to make the order deterministic: it is already unique and already indexed as part of most tables.

**Mistake:** sorting and comparing on `inserted_at` alone. It works during manual testing, where inserts rarely collide, then fails intermittently once traffic is high enough for same-timestamp rows to become common.

## Reach for a window function only when a page number is required

Keyset pagination cannot jump straight to "page 12" because it does not know how many rows sit between the start and that boundary. When the interface genuinely needs numbered pages with direct links, `ROW_NUMBER()` can assign a position to each row and filter on it.

```sql
SELECT id, total
FROM (
    SELECT id, total,
           row_number() OVER (ORDER BY inserted_at DESC, id DESC) AS rn
    FROM orders
) numbered
WHERE rn BETWEEN 221 AND 240
ORDER BY inserted_at DESC, id DESC;
```

Postgres still has to walk the index from the very first row and count up to the requested range before it can return anything, the same cost shape as `OFFSET`, just spelled differently. The advantage is only that a single query can report a row's absolute position, which a page number needs and a keyset does not. Prefer keyset pagination for infinite scroll and "load more" interactions, and keep this one for the rare screen that truly needs numbered pages.

**Mistake:** using `ROW_NUMBER()` pagination for an infinite-scroll feed. It buys nothing over `OFFSET` there and pays the same growing cost per page, when a keyset query would have stayed flat.
