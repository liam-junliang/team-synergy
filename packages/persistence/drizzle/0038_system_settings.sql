CREATE TABLE system_settings (
  id integer PRIMARY KEY DEFAULT 1,
  public_web_url text,
  public_api_url text,
  revision integer NOT NULL DEFAULT 0,
  updated_at text,
  updated_by bigint,
  CONSTRAINT ck_system_settings_singleton CHECK (id = 1),
  CONSTRAINT ck_system_settings_revision CHECK (revision >= 0)
);
INSERT INTO system_settings (id) VALUES (1);
