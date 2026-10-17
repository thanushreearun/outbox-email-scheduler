-- Separate database for the automated integration tests so they never touch dev data.
CREATE DATABASE outbox_test OWNER outbox;
