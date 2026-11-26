PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS folders (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE,
 parent INTEGER REFERENCES folders(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS folder_names ON folders(IFNULL(parent,0),name);
CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bundles (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
 revision INTEGER NOT NULL, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS packages (
 digest TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, size INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bundle_catalog (
 bundle INTEGER PRIMARY KEY REFERENCES bundles(id) ON DELETE CASCADE,
 folder INTEGER REFERENCES folders(id), category TEXT NOT NULL DEFAULT '',
 enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS bundle_groups (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
 folder INTEGER REFERENCES folders(id)
);
CREATE TABLE IF NOT EXISTS group_members (
 group_id INTEGER NOT NULL REFERENCES bundle_groups(id) ON DELETE CASCADE,
 bundle INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
 PRIMARY KEY(group_id,bundle)
);
CREATE TABLE IF NOT EXISTS sandbox (
 bundle INTEGER PRIMARY KEY REFERENCES bundles(id) ON DELETE CASCADE,
 base INTEGER NOT NULL, stamp TEXT NOT NULL, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
 id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, principal TEXT NOT NULL COLLATE NOCASE,
 label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS assignments (
 id INTEGER PRIMARY KEY AUTOINCREMENT, bundle INTEGER NOT NULL REFERENCES bundles(id),
 scope TEXT NOT NULL, principal TEXT NOT NULL COLLATE NOCASE, phase TEXT NOT NULL, trigger TEXT NOT NULL,
 due INTEGER, generation INTEGER NOT NULL DEFAULT 1, UNIQUE(bundle,scope,principal,phase)
);
CREATE TABLE IF NOT EXISTS reports (
 agent INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
 assignment INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE, version TEXT NOT NULL,
 status TEXT NOT NULL, detail TEXT NOT NULL, seen INTEGER NOT NULL,
 PRIMARY KEY(agent,assignment)
);

CREATE TABLE IF NOT EXISTS device_info (
 agent INTEGER PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
 guid TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))), created INTEGER,
 inventory TEXT NOT NULL DEFAULT '{}', scanned INTEGER, properties TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS bundle_info (
 bundle INTEGER PRIMARY KEY REFERENCES bundles(id) ON DELETE CASCADE,
 guid TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))), created INTEGER,
 description TEXT NOT NULL DEFAULT '', symbol TEXT NOT NULL DEFAULT 'app', notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS bundle_versions (
 bundle INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
 name TEXT NOT NULL, recorded INTEGER, PRIMARY KEY(bundle,revision)
);
CREATE TRIGGER IF NOT EXISTS agent_created AFTER INSERT ON agents BEGIN
 INSERT INTO device_info(agent,created) VALUES (new.id,unixepoch());
END;
CREATE TRIGGER IF NOT EXISTS bundle_created AFTER INSERT ON bundles BEGIN
 INSERT INTO bundle_info(bundle,created) VALUES (new.id,unixepoch());
 INSERT INTO bundle_versions VALUES (new.id,new.revision,new.name,unixepoch());
END;
CREATE TRIGGER IF NOT EXISTS bundle_published AFTER UPDATE OF revision ON bundles
WHEN new.revision != old.revision BEGIN
 INSERT INTO bundle_versions VALUES (new.id,new.revision,new.name,unixepoch());
END;
INSERT OR IGNORE INTO device_info(agent) SELECT id FROM agents;
INSERT OR IGNORE INTO bundle_info(bundle) SELECT id FROM bundles;
INSERT OR IGNORE INTO bundle_versions(bundle,revision,name) SELECT id,revision,name FROM bundles;
CREATE TABLE IF NOT EXISTS user_device (
 user_agent INTEGER PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
 device_agent INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE
);
