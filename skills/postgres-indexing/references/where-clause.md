# The WHERE Clause

The `where` clause decides whether Postgres can jump straight to the matching rows or has to walk the whole table. Come here when a query has an index but still runs a sequential scan, when deciding column order for a new composite index, or when a condition looks fine but quietly disables the index it should use.

## Put equality columns first, one range last

A composite index is a single sorted list. Only the leading columns can narrow where the scan starts and stops; everything after the first range condition just gets checked row by row once the scan is already there. Order the columns so every equality condition comes first, and if there is a range condition, put it last.

```sql
CREATE INDEX orders_user_id_inserted_at_idx
    ON orders (user_id, inserted_at);

SELECT * FROM orders
 WHERE user_id = 42
   AND inserted_at >= '2024-01-01'
   AND inserted_at <  '2024-02-01';
```

**Mistake:** `(inserted_at, user_id)`. The date range becomes the leading column, so `user_id` can only be applied as a filter after scanning every row in that date window instead of narrowing the scan to one user.

## Functions and casts on the column need an expression index

`lower(email) = 'ana@example.com'` cannot use a plain index on `email`, because the index stores the raw value and the query is now searching for something else entirely. Index the exact expression the query uses, or normalize the column type so the expression is never needed. A user-defined function needs its own `IMMUTABLE` label before Postgres will let it into an index at all, and Postgres trusts that label rather than checking it: a function that secretly depends on the clock, randomness, or another table can be declared `IMMUTABLE` anyway, and the index will build without complaint, then quietly drift from what the function would return today.

```sql
CREATE INDEX users_email_lower_idx ON users (lower(email));

SELECT * FROM users WHERE lower(email) = lower('Ana@Example.com');
```

```elixir
from(u in User, where: fragment("lower(?)", u.email) == ^String.downcase(email))
```

An alternative for case-insensitive text is the `citext` column type, which stores and compares case-insensitively without any expression index at all.

**Mistake:** indexing `email` plainly and then filtering on `lower(email)` everywhere. The index sits unused; every one of those queries falls back to a sequential scan. The opposite mistake is marking a function `IMMUTABLE` just to get it into an index definition when it is not actually deterministic; nothing rejects that at creation time, only stale results later reveal it.

## Do not index every variant of the same expression

`lower(email)` and `upper(email)` each need their own expression index, and every extra index adds write overhead to every insert, update and delete on that table. Pick one canonical form for the whole codebase instead of adding an index each time a different query writes the comparison differently.

```sql
-- redundant: two indexes maintained for the same logical lookup
CREATE INDEX users_email_lower_idx ON users (lower(email));
CREATE INDEX users_email_upper_idx ON users (upper(email));
```

**Mistake:** creating one index on `lower(email)` and another on `upper(email)` because two code paths formatted the comparison differently. Standardize on one function, or on `citext`, and drop the rest.

## A leading wildcard defeats `LIKE`, a trailing one does not

`LIKE 'ana%'` behaves like a range condition: Postgres can jump to the first entry starting with `ana` and stop once the prefix no longer matches. `LIKE '%ana%'` has no known starting point, so a plain B-tree index cannot narrow the scan at all. For infix or suffix search, use a trigram index instead.

```sql
SELECT * FROM users WHERE email LIKE 'ana%';        -- uses a B-tree range scan

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX users_email_trgm_idx ON users USING gin (email gin_trgm_ops);

SELECT * FROM users WHERE email LIKE '%ana%';        -- uses the trigram index
```

**Mistake:** expecting a plain index on `email` to speed up `LIKE '%ana%'`. It still runs a full scan; only the trigram index changes that.

## NULL lives in the index, so `IS NULL` can use it

Postgres includes NULL entries in an ordinary B-tree index, unlike some other databases that leave them out. That means `IS NULL` and `IS NOT NULL` are ordinary index conditions, not a special case you need to work around.

```sql
CREATE INDEX orders_shipped_at_idx ON orders (shipped_at);

SELECT * FROM orders WHERE shipped_at IS NULL;
```

```elixir
from(o in Order, where: is_nil(o.shipped_at))
```

**Mistake:** assuming `IS NULL` needs a workaround, like a sentinel value or an extra partial index, before it can use an index. In Postgres a plain index already supports it, because NULL entries are stored like any other value.

## Use a partial index when one value or NULL dominates

Indexing every row wastes space when the query only ever cares about a small slice, like pending orders among mostly completed ones, or live rows in a soft-deleted table. A partial index covers just that slice and stays small no matter how the rest of the table grows.

```sql
CREATE INDEX orders_pending_idx ON orders (user_id) WHERE status = 'pending';

CREATE INDEX users_active_idx ON users (email) WHERE deleted_at IS NULL;
```

```elixir
create index(:users, [:email], where: "deleted_at IS NULL")
```

**Mistake:** indexing `status` across the whole table when nearly every row is `'completed'`. The index still works, but it grows with rows nobody queries by that value.

## `NOT NULL` changes what `count(column)` means, not whether the index gets used

Because Postgres stores NULLs in an ordinary index, `count(*)` can already use an index-only scan whether or not the column allows NULL; there is nothing to unlock there. What a `NOT NULL` constraint changes is the meaning of `count(column)` itself: `count(column)` only counts non-NULL values, so on a nullable column it can return less than `count(*)`. With `NOT NULL` in place, no row can be excluded, so the two always agree.

```sql
ALTER TABLE orders ALTER COLUMN user_id SET NOT NULL;

-- with the constraint in place these always return the same number
SELECT count(*)        FROM orders;
SELECT count(user_id)  FROM orders;
```

**Mistake:** adding `NOT NULL` on the assumption that `count(*)` needs it to use an index. It does not; the constraint is about guaranteeing `count(column)` matches `count(*)`, not about index eligibility.

## Write date ranges explicitly instead of truncating the column

Wrapping the timestamp in `date_trunc` or casting it to a date hides it from a plain index on that column, the same way any function call does. Write the boundaries as an explicit range instead.

```sql
-- bad: date_trunc('day', inserted_at) is a function call, so the plain index on inserted_at doesn't match
WHERE date_trunc('day', inserted_at) = '2024-01-01';

-- good: the raw column stays comparable
WHERE inserted_at >= '2024-01-01' AND inserted_at < '2024-01-02';
```

```elixir
from(o in Order, where: o.inserted_at >= ^start_date and o.inserted_at < ^end_date)
```

**Mistake:** reaching for `date_trunc` as the obvious way to compare a whole day. It reads fine but wraps the column in a function; the range form gets the same result while staying indexable.

## Do not cast the column to compare numeric strings

If a column is text holding digits, compare it as text or cast the search term, never the column. Casting the column disables the index the same way any other function call does.

```sql
-- good: index on reference_code stays usable
WHERE reference_code = '42';

-- bad: casts the column on every row
WHERE reference_code::int = 42;
```

**Mistake:** fixing a type mismatch by wrapping the column in a cast. Cast the literal on the other side of the comparison instead, so the column stays untouched.

## Do not build the search value out of the column

Concatenating columns or doing arithmetic on one turns a simple lookup into an expression the planner cannot map back to any index, the same problem as wrapping the column in a function.

```sql
-- bad: no index supports this
WHERE first_name || ' ' || last_name = 'Ana Silva';

-- good: compare the columns separately
WHERE first_name = 'Ana' AND last_name = 'Silva';

-- bad
WHERE total + 1 = 100;

-- good: move the arithmetic to the constant side
WHERE total = 99;
```

**Mistake:** filtering on a computed value, like a full name or `total + 1`, instead of the underlying columns. Move the computation to the constant side, or compare the columns separately, so the indexed column appears bare in the `where` clause.

## Do not build one clause that toggles filters with OR

A `where` clause like `status = ? OR ? IS NULL` looks convenient for an optional filter. With a fresh, custom plan Postgres can still constant-fold `$1 IS NULL` and pick the right index, but bind parameters get re-planned as generic after repeated use (by default once a statement runs five times, controlled by `plan_cache_mode`). Once Postgres switches to that generic plan, it has to handle both the filter-present and filter-disabled case with the same plan, so it cannot use an index tuned to either. Build the query by adding conditions only when the filter is actually present, so every plan stays specific.

```sql
-- bad: every filter is "smart" and none can be optimized for
WHERE (status = $1 OR $1 IS NULL)
  AND (user_id = $2 OR $2 IS NULL);
```

```elixir
query = from(o in Order)
query = if status, do: where(query, [o], o.status == ^status), else: query
query = if user_id, do: where(query, [o], o.user_id == ^user_id), else: query
```

**Mistake:** reaching for one big conditional `where` clause to cover every combination of optional filters. It is easier to write, but it forces a plan that ignores every index that could have helped a specific search.

## Bind parameters are automatic, fragment interpolation is not

Ecto binds every value you pass through `^` as a parameter, which is both what keeps queries safe from injection and what lets Postgres reuse a cached plan. `fragment` requires its SQL string to be a compile-time literal, so it refuses to interpolate a variable into it at all; the only way to get a value in is as a bound argument with `^`.

```elixir
# good: value is bound
from(u in User, where: fragment("? = ?", u.email, ^email))

# what people reach for instead when they want interpolation: it compiles, but
# throws away parameter binding and reopens the door to SQL injection
Repo.query!("SELECT * FROM users WHERE email = '#{email}'")
```

A literal can still beat a bind parameter when the value's frequency should shape the plan, such as a heavily skewed status column or a condition meant to match a partial index. In those cases the planner needs to see the actual value to choose the cheap plan instead of a generic one.
