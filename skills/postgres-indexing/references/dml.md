# Insert, Update, Delete

An index is redundant data on purpose: the same values as the table, kept in a second, sorted structure so a query can find rows without scanning everything. That redundancy has to be paid for on every write, not just the read it was built for. This file covers what that bill looks like for `INSERT`, `UPDATE`, and `DELETE`, and when it is worth paying. Come here before adding an index to a table that takes heavy write traffic, or when a bulk load is slower than it should be.

## Every index is one more write on insert

`INSERT` has no `WHERE` clause, so it cannot benefit from any index the way a query can. It can only pay for them. The database writes the new row to the table heap once, then adds one entry to every index defined on that table. Three indexes mean four writes for a single row: one heap write and three index writes.

```sql
-- orders has indexes on (user_id), (status), (inserted_at)
INSERT INTO orders (user_id, status, total, inserted_at)
VALUES (42, 'pending', 19.99, now());
-- one heap write, plus one write per index: four writes total
```

```elixir
Repo.insert_all(Order, [
  %{user_id: 42, status: "pending", total: 19.99, inserted_at: now},
  %{user_id: 43, status: "pending", total: 8.50, inserted_at: now}
])
```

`insert_all/2` saves round trips by sending every row in one statement, not by skipping index maintenance. Each of the rows still pays the full per-index cost.

**Mistake:** adding an index "just in case" on a table that takes far more writes than the reads it would speed up.

## An update on an indexed column removes and re-adds that entry

An index keeps its entries in sorted order, so changing an indexed value cannot be done in place. Postgres deletes the old entry and inserts a new one at the correct position, the same cost as a delete plus an insert in that one index. A column that is not part of any index only needs the heap write. When the updated row still fits on its current page and no indexed column changed, Postgres can use a heap-only tuple update, which skips every index entirely.

```sql
-- status is indexed, total is not
UPDATE orders SET status = 'shipped' WHERE id = 100; -- rewrites the status index entry
UPDATE orders SET total = 24.99 WHERE id = 100;      -- heap-only tuple, no index touched
```

```elixir
order
|> Ecto.Changeset.cast(%{total: 24.99}, [:total])
|> Repo.update()

from(o in Order, where: o.id == ^order.id)
|> Repo.update_all(set: [status: "shipped"])
```

A changeset only puts changed fields in the `SET` list, so `Repo.update/1` already avoids touching an index for a column nobody changed. `Repo.update_all/2` writes exactly the columns named in `set:`, which makes it easy to see up front which indexes an update statement will pay for.

**Mistake:** building an update that sets every column of a struct regardless of what changed. That turns a one-column update into a write against every index on the table.

## Delete and update need the same index a select would

`DELETE` and `UPDATE` both carry a `WHERE` clause, so the column order and predicate rules in where.md apply exactly as they do to `SELECT`: an index on the filtered column decides whether the database walks a tree or scans the table to find which rows to touch. Deleting or updating a row itself is roughly as cheap as inserting one; finding it without an index is the same table scan a slow `SELECT` would run.

```sql
CREATE INDEX orders_status_idx ON orders (status);

DELETE FROM orders WHERE status = 'cancelled';
UPDATE order_items SET quantity = 0 WHERE order_id = 100;
```

```elixir
from(o in Order, where: o.status == "cancelled")
|> Repo.delete_all()
```

In Postgres a deleted row is only flagged dead at the heap level right away; cleaning up its entries in every index is deferred to autovacuum, not done synchronously. That changes how a delete-heavy table degrades over time, but it does not change the rule above: finding the rows still needs the same index a matching `SELECT` would.

**Mistake:** running a `DELETE` or `UPDATE` against a filter with no supporting index and blaming the delete or update itself, when the cost is really an unindexed scan to locate the rows.

## Load first, index after, for a bulk import

Every index on a table turns a bulk load into thousands of individual index insertions, each one doing tree traversal and possible page splits. Building the index once, after the data is already in the table, lets Postgres sort the values and construct the tree in a single pass instead.

```sql
DROP INDEX orders_status_idx;

COPY orders FROM '/data/orders.csv' WITH (FORMAT csv);

CREATE INDEX orders_status_idx ON orders (status);
```

```elixir
Repo.query!("DROP INDEX orders_status_idx")
Repo.query!("COPY orders FROM '/data/orders.csv' WITH (FORMAT csv)")
Repo.query!("CREATE INDEX orders_status_idx ON orders (status)")
```

The same idea applies to a brand new table: load the rows first, then create the indexes it needs for querying. Only drop an index this way when nothing else running against the table depends on it while it is missing.

**Mistake:** loading millions of rows into a table that already has its full set of indexes, paying the per-row index cost repeatedly instead of the one-time cost of building it after.

## Ask what the table's write to read ratio is before adding an index

Every rule above turns into one question before creating a new index: how often would this index actually serve a query, compared to how often the table is written. An index that speeds up a report run once a day on a table that takes hundreds of writes a second is a bad trade, because every one of those writes now pays for an index almost nothing reads.

```sql
SELECT relname, seq_scan, idx_scan, n_tup_ins, n_tup_upd, n_tup_del
FROM pg_stat_user_tables
WHERE relname = 'orders';
```

Compare `idx_scan` against `n_tup_ins`, `n_tup_upd`, and `n_tup_del` for the table before adding an index to it. If the writes outnumber the reads that index would serve by a wide margin, consider a partial index restricted to the rows actually queried instead of a full one, or question whether the index earns its keep at all.

**Mistake:** adding an index because one query was slow once, without checking how many writes on that table will now carry its cost forever.
