-- Safe, repeatable File and Folder sharing upgrade for MySQL/phpMyAdmin.
-- It may be run even if an earlier sharing upgrade partially succeeded.
USE file_storage;

-- Add each folder link column only if it does not exist.
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'folders' AND column_name = 'share_token') = 0,
    'ALTER TABLE folders ADD COLUMN share_token VARCHAR(64) NULL AFTER name', 'SELECT 1');
PREPARE sharing_statement FROM @sql; EXECUTE sharing_statement; DEALLOCATE PREPARE sharing_statement;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'folders' AND column_name = 'share_permission') = 0,
    'ALTER TABLE folders ADD COLUMN share_permission ENUM(''private'', ''public'') NOT NULL DEFAULT ''private'' AFTER share_token', 'SELECT 1');
PREPARE sharing_statement FROM @sql; EXECUTE sharing_statement; DEALLOCATE PREPARE sharing_statement;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'folders' AND column_name = 'is_share_link_enabled') = 0,
    'ALTER TABLE folders ADD COLUMN is_share_link_enabled BOOLEAN NOT NULL DEFAULT FALSE AFTER share_permission', 'SELECT 1');
PREPARE sharing_statement FROM @sql; EXECUTE sharing_statement; DEALLOCATE PREPARE sharing_statement;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'folders' AND index_name = 'uq_folders_share_token') = 0,
    'ALTER TABLE folders ADD UNIQUE KEY uq_folders_share_token (share_token)', 'SELECT 1');
PREPARE sharing_statement FROM @sql; EXECUTE sharing_statement; DEALLOCATE PREPARE sharing_statement;

-- Existing folders need a token so a direct share has a stable private route.
UPDATE folders SET share_token = REPLACE(UUID(), '-', '') WHERE share_token IS NULL;

-- Add each file link column only if it does not exist.
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'files' AND column_name = 'share_permission') = 0,
    'ALTER TABLE files ADD COLUMN share_permission ENUM(''private'', ''public'') NOT NULL DEFAULT ''private'' AFTER share_token', 'SELECT 1');
PREPARE sharing_statement FROM @sql; EXECUTE sharing_statement; DEALLOCATE PREPARE sharing_statement;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'files' AND column_name = 'is_share_link_enabled') = 0,
    'ALTER TABLE files ADD COLUMN is_share_link_enabled BOOLEAN NOT NULL DEFAULT FALSE AFTER share_permission', 'SELECT 1');
PREPARE sharing_statement FROM @sql; EXECUTE sharing_statement; DEALLOCATE PREPARE sharing_statement;

CREATE TABLE IF NOT EXISTS file_user_shares (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    file_id INT UNSIGNED NOT NULL,
    shared_with_user_id INT UNSIGNED NOT NULL,
    permission ENUM('viewer', 'editor') NOT NULL DEFAULT 'viewer',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_file_user_shares_file_user (file_id, shared_with_user_id),
    KEY idx_file_user_shares_user (shared_with_user_id),
    CONSTRAINT fk_file_user_shares_file FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
    CONSTRAINT fk_file_user_shares_user FOREIGN KEY (shared_with_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS folder_user_shares (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    folder_id INT UNSIGNED NOT NULL,
    shared_with_user_id INT UNSIGNED NOT NULL,
    permission ENUM('viewer', 'editor') NOT NULL DEFAULT 'viewer',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_folder_user_shares_folder_user (folder_id, shared_with_user_id),
    KEY idx_folder_user_shares_user (shared_with_user_id),
    CONSTRAINT fk_folder_user_shares_folder FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
    CONSTRAINT fk_folder_user_shares_user FOREIGN KEY (shared_with_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
