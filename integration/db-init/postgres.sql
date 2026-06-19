-- Local integration isolation: a database per ORM so the typeorm-postgres and mikro-orm-postgres
-- suites (which both use the `users`/`posts` tables) don't clobber each other when
-- `turbo run test` runs them concurrently. CI is unaffected — it runs each suite in its own
-- container with DB_NAME=nestjs_filter_test. Runs once, as the superuser, on a fresh data volume.
CREATE DATABASE nestjs_filter_typeorm;
CREATE DATABASE nestjs_filter_mikro;
