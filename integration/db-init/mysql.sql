-- Local integration isolation: a database per ORM so the typeorm-mysql and mikro-orm-mysql
-- suites (which both use the `users`/`posts` tables) don't clobber each other when
-- `turbo run test` runs them concurrently. CI is unaffected — it runs each suite in its own
-- container with DB_NAME=nestjs_filter_test. Runs once, as root, on a fresh data volume.
CREATE DATABASE IF NOT EXISTS nestjs_filter_typeorm;
CREATE DATABASE IF NOT EXISTS nestjs_filter_mikro;
GRANT ALL PRIVILEGES ON nestjs_filter_typeorm.* TO 'test'@'%';
GRANT ALL PRIVILEGES ON nestjs_filter_mikro.* TO 'test'@'%';
FLUSH PRIVILEGES;
