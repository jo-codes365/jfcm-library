-- Safe, repeatable Event-sharing upgrade for MySQL, including phpMyAdmin's SQL tab.
-- Select the file_storage database in phpMyAdmin, then paste and run this entire file.
-- No DELIMITER or stored-procedure support is required.
-- Existing Events keep a NULL token and a disabled link. The application creates
-- a token only when an owner enables an Event share link.

USE file_storage;

-- Add each Event-sharing field only when it is absent.
SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'events' AND column_name = 'share_token') = 0,
    'ALTER TABLE events ADD COLUMN share_token VARCHAR(64) NULL',
    'SELECT 1'
);
PREPARE event_share_statement FROM @sql;
EXECUTE event_share_statement;
DEALLOCATE PREPARE event_share_statement;

-- Event sharing reads this permission with the token and link-status fields.
SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'events' AND column_name = 'share_permission') = 0,
    'ALTER TABLE events ADD COLUMN share_permission ENUM(''private'', ''public'') NOT NULL DEFAULT ''private''',
    'SELECT 1'
);
PREPARE event_share_statement FROM @sql;
EXECUTE event_share_statement;
DEALLOCATE PREPARE event_share_statement;

SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'events' AND column_name = 'is_share_link_enabled') = 0,
    'ALTER TABLE events ADD COLUMN is_share_link_enabled BOOLEAN NOT NULL DEFAULT FALSE',
    'SELECT 1'
);
PREPARE event_share_statement FROM @sql;
EXECUTE event_share_statement;
DEALLOCATE PREPARE event_share_statement;

-- Retain one legacy token if duplicates exist. Do not generate replacements.
UPDATE events AS duplicate_event
JOIN events AS retained_event
    ON duplicate_event.share_token = retained_event.share_token
    AND duplicate_event.id > retained_event.id
SET duplicate_event.share_token = NULL
WHERE duplicate_event.share_token IS NOT NULL;

-- Add the unique index only when it is absent.
SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'events' AND index_name = 'uq_events_share_token') = 0,
    'ALTER TABLE events ADD UNIQUE KEY uq_events_share_token (share_token)',
    'SELECT 1'
);
PREPARE event_share_statement FROM @sql;
EXECUTE event_share_statement;
DEALLOCATE PREPARE event_share_statement;

CREATE TABLE IF NOT EXISTS event_user_shares (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    event_id INT UNSIGNED NOT NULL,
    shared_with_user_id INT UNSIGNED NOT NULL,
    permission ENUM('viewer', 'editor') NOT NULL DEFAULT 'viewer',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_event_user_shares_event_user (event_id, shared_with_user_id),
    KEY idx_event_user_shares_user (shared_with_user_id),
    CONSTRAINT fk_event_user_shares_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    CONSTRAINT fk_event_user_shares_user FOREIGN KEY (shared_with_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
