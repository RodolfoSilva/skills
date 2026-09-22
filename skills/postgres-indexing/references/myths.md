# Indexing Myths

Some indexing advice sounds authoritative but does not hold up in Postgres, either because it never applied here or because it comes from a different database with different internals. Come here when a query plan or a schema review contradicts something everyone "knows" to be true, before accepting the myth or writing a fix based on it.

## Myth: put the most selective column first in a compound index

Column order in a compound index is not chosen by selectivity, it is chosen by the queries that will use it. An index can only narrow its scan using a leading, unbroken run of equality conditions, followed by at most one range condition; columns after that range are not used to narrow anything. So the rule that matters is: equality columns first, in whatever order the queries actually filter on, then the range column last.

```sql
CREATE INDEX orders_user_id_inserted_at_idx
  ON orders (user_id, inserted_at);

SELECT * FROM orders
WHERE user_id = 42 AND inserted_at > now() - interval '30 days';
-- user_id is the equality condition, it belongs first
-- inserted_at is the range condition, it belongs last
```

Selectivity only earns a say when two independent range conditions compete for the same index and Postgres has to pick which one becomes the access predicate and which becomes a filter; that is a narrow, advanced case, not a general rule for ordering columns.

**Mistake:** building `(inserted_at, user_id)` because `inserted_at` looks more selective, then wondering why a query filtering only on `user_id` cannot use the index.

## Myth: NULL cannot be indexed

This one comes from other databases that leave a row out of an index entirely when every indexed column is null. Postgres does not do that. A btree index stores an entry for every row, null values included, and `IS NULL` can use that index like any other condition.

```sql
CREATE INDEX users_deleted_at_idx ON users (deleted_at);

SELECT * FROM users WHERE deleted_at IS NULL;
-- can use an index scan, deleted_at is indexed whether it holds a value or NULL
```

```elixir
from(u in User, where: is_nil(u.deleted_at))
```

If most rows share the same null (or non-null) state, a partial index targeting the common case keeps the index smaller than indexing the whole column:

```sql
CREATE INDEX users_active_idx ON users (id) WHERE deleted_at IS NULL;
```

**Mistake:** adding a sentinel value instead of `NULL` to make a column "indexable". It already is, the sentinel only adds a value you now have to filter out everywhere.

## Myth: indexes degenerate over time and need scheduled rebuilds

A btree keeps itself balanced on every insert, update, and delete, there is no slow decay in tree depth to correct. What can happen is bloat: dead entries left behind by updates and deletes that autovacuum has not reclaimed yet, which makes the index bigger on disk than it needs to be. That is a space and cache-efficiency question, not a structural one, and it does not need a calendar-based fix.

```sql
CREATE EXTENSION IF NOT EXISTS pgstattuple;

SELECT * FROM pgstattuple('orders_user_id_idx');
-- check dead_tuple_percent before deciding anything needs to change

SELECT * FROM pgstatindex('orders_user_id_idx');
-- leaf_fragmentation and avg_leaf_density, btree-specific view of the same bloat
```

```sql
REINDEX INDEX CONCURRENTLY orders_user_id_idx;
-- rebuild only when bloat is actually measured, not on a recurring schedule
```

**Mistake:** cron-scheduling a nightly `REINDEX` on every index "for health". Measure bloat with `pgstattuple` first; an index with low bloat gains nothing from a rebuild, and `REINDEX` without `CONCURRENTLY` locks writes against the table for its duration.

## Myth: dynamic SQL is slow

The slow thing is not a query built at runtime, it is a query built by concatenating values straight into the SQL text. Postgrex keeps a per-connection cache of prepared statements keyed by the query text, so a statement with a bind parameter is prepared once and reused on every call. Concatenating the value into the string instead produces a different query text for every value, so each one misses that cache and has to be parsed and planned again, on top of opening the door to SQL injection. A query whose shape changes at runtime but still passes its values as bind parameters keeps hitting the same cache entry, same as any fixed query.

```sql
-- slow and unsafe: the value is part of the SQL string
-- "SELECT * FROM orders WHERE user_id = " <> user_id_from_request
```

```sql
-- fine: the shape can vary, the value is still a bind parameter
SELECT * FROM orders WHERE user_id = $1 AND status = $2;
```

Ecto's query composition is this pattern done right. Building a query across several optional filters still emits bind parameters for every value; only the shape of the `WHERE` clause changes per call.

```elixir
def list_orders(query, opts) do
  query
  |> filter_by_status(opts[:status])
  |> filter_by_user(opts[:user_id])
end

defp filter_by_status(query, nil), do: query
defp filter_by_status(query, status), do: where(query, [o], o.status == ^status)

defp filter_by_user(query, nil), do: query
defp filter_by_user(query, user_id), do: where(query, [o], o.user_id == ^user_id)
```

**Mistake:** building the `WHERE` clause with `<>` or string interpolation to "keep it simple", then blaming the resulting slowness and injection risk on dynamic SQL in general.

## Myth: `SELECT *` only costs extra bandwidth

Pulling columns you do not need is not just a network cost. It also rules out an index-only scan: if every column the query touches lived in the index, Postgres could answer straight from the index leaves, but `SELECT *` forces a fetch of the full row from the table for every match, index or not.

```sql
CREATE INDEX orders_user_id_status_idx ON orders (user_id, status);

SELECT * FROM orders WHERE user_id = 42;
-- fetches the whole row, no index-only scan possible

SELECT status FROM orders WHERE user_id = 42;
-- status is in the index, this can be answered without touching the table
```

```elixir
from(o in Order, where: o.user_id == ^user_id, select: o.status)
```

**Mistake:** treating `SELECT *` as a style preference to clean up later. On a wide table it silently removes an optimization Postgres would otherwise pick for you.

## Myth: more indexes is always safer

An index that nothing queries for is not free insurance, it is a standing cost. Every `INSERT`, `UPDATE` of an indexed column, and `DELETE` has to update every index on that table, so extra indexes slow down writes whether or not they ever serve a read. They also give the planner more paths to evaluate when choosing a plan.

```sql
CREATE INDEX orders_status_idx ON orders (status);
CREATE INDEX orders_total_idx ON orders (total);
CREATE INDEX orders_inserted_at_idx ON orders (inserted_at);
-- three indexes maintained on every write, useful only if real queries filter on each column alone
```

An index earns its place by matching a query pattern that actually runs, not by covering a column just in case.

**Mistake:** adding one index per column on a busy write table "to be safe", then finding that ordinary inserts got slower without any query getting faster.
