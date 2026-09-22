# Joins

Postgres picks one of three algorithms to combine two tables, and each algorithm leans on indexes in a different way. This file explains what each algorithm needs, then covers the Ecto side: how `preload` and `join` turn into queries, and how careless loading turns a single join into hundreds of round trips. SKILL.md sends the agent here whenever a query joins two or more tables or an association is being loaded.

## Match the index to the join algorithm Postgres picks

The planner chooses the algorithm based on row estimates, not on what you wrote. Indexing the wrong side does nothing.

A nested loop scans one table (the driving side) and, for each row, does an index lookup into the other table. It wins when the driving side returns few rows. The index has to sit on the join column of the inner, non-driving side.

```sql
-- few users match the email filter, so Postgres drives from users
-- and looks up matching orders one user at a time
EXPLAIN SELECT *
  FROM users u
  JOIN orders o ON o.user_id = u.id
 WHERE u.email = 'ana@example.com';

--  Nested Loop
--    ->  Index Scan using users_email_idx on users u
--    ->  Index Scan using orders_user_id_idx on orders o
```

A hash join builds an in-memory hash table from the smaller side, then streams the other side through it, probing the table row by row. It wins when both sides are large and neither filter narrows the result enough for a nested loop. No index is needed on the join columns themselves, only on independent filters that shrink one side before it goes into the hash table.

```sql
-- both sides are large; the join column needs no index,
-- but the date filter on orders does
CREATE INDEX orders_inserted_at_idx ON orders (inserted_at);

EXPLAIN SELECT *
  FROM orders o
  JOIN users u ON u.id = o.user_id
 WHERE o.inserted_at > now() - interval '7 days';

--  Hash Join
--    ->  Index Scan using orders_inserted_at_idx on orders o
--    ->  Hash
--          ->  Seq Scan on users u
```

A merge join walks two inputs that are sorted on the join key in lockstep, matching rows as it goes. Postgres sorts either side on the fly when needed, but a merge join is only cheap when an index already delivers the order, so it shows up most often on reporting queries where both tables are indexed on the same key and the planner can skip an explicit sort.

```sql
CREATE INDEX order_items_order_id_idx ON order_items (order_id);

EXPLAIN SELECT *
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
 ORDER BY o.id;

--  Merge Join
--    ->  Index Scan using orders_pkey on orders o
--    ->  Index Scan using order_items_order_id_idx on order_items oi
```

**Mistake:** indexing `orders.user_id` to speed up a query that Postgres runs as a hash join. The index sits unused because a hash join needs no index on the join predicate, only on the filters that narrow the rows going into the hash table.

## Index the foreign key on the many side

Postgres indexes primary keys automatically but never foreign keys. Without an index on the many side, every nested loop lookup by that key falls back to a sequential scan of the whole table.

```sql
CREATE INDEX orders_user_id_idx ON orders (user_id);
CREATE INDEX order_items_order_id_idx ON order_items (order_id);
```

**Mistake:** trusting the foreign key constraint to make lookups fast. The constraint only checks that a value exists; it does not build an index to find it quickly.

## Never turn a join into N+1 queries

A nested loop join is efficient because Postgres runs it inside one query plan, one index lookup after another, without a round trip to the application between rows. Fetching the child rows from application code, once per parent row, is the same access pattern with the round trips added back in. One query per row is the pathological case: it costs `1 + N` queries for `N` parents, and the network latency of each round trip dwarfs the cost of the index lookup it replaced.

```sql
-- run once per user instead of once, total
SELECT * FROM orders WHERE user_id = $1;

-- one round trip for every user in the batch
SELECT * FROM orders WHERE user_id = ANY($1);
```

```elixir
# one query per user: exactly the N+1 pattern
users = Repo.all(User)
Enum.map(users, fn user -> Repo.all(from o in Order, where: o.user_id == ^user.id) end)
```

```elixir
# one extra query total, not one per user
users = Repo.all(from u in User, preload: :orders)
```

**Mistake:** calling `Repo.preload/2` inside `Enum.map/2` over a list already in memory. It runs one query per element instead of one query for the whole list.

```elixir
# N queries, one per user
Enum.map(users, fn user -> Repo.preload(user, :orders) end)

# one query for every user in the list
Repo.preload(users, :orders)
```

## Choose preload or join based on what you filter

`preload` on an association issues a second query that fetches all children for the parents already loaded, using a single `WHERE user_id IN (...)`. That is fine for a plain one-to-many load: it is two queries total, not `N + 1`.

```sql
SELECT * FROM users WHERE status = 'active';
SELECT * FROM orders WHERE user_id IN (1, 2, 3);
```

```elixir
from(u in User, where: u.status == "active", preload: :orders)
```

Filtering or ordering by a column on the association needs the join in the main query, with `preload` telling Ecto to reuse the same joined rows instead of running a second query.

```sql
SELECT u.*, o.*
  FROM users u
  JOIN orders o ON o.user_id = u.id
 WHERE o.status = 'paid';
```

```elixir
from(u in User,
  join: o in assoc(u, :orders),
  where: o.status == "paid",
  preload: [orders: o]
)
```

## Filter and select before a hash join builds its table

A hash join has to materialize the smaller side entirely before it can start probing, so anything that shrinks that side or narrows its columns shrinks the hash table Postgres has to build and, often, keep in memory. Have a selective filter on the hashed side and an index for it, the planner applies the filter before building the hash regardless of where it sits in the SQL or the Ecto pipeline. Also select only the columns the caller needs instead of every column on both tables.

```sql
SELECT o.id, o.total, u.email
  FROM orders o
  JOIN users u ON u.id = o.user_id
 WHERE o.inserted_at > now() - interval '7 days';
```

```elixir
from(o in Order,
  join: u in assoc(o, :user),
  where: o.inserted_at > ago(7, "day"),
  select: %{id: o.id, total: o.total, email: u.email}
)
```

**Mistake:** `SELECT *` across a join used only to display two or three fields. Every extra column travels into the hash table even though it is thrown away right after.
