-- Run once for existing installations.  It makes link visibility explicit and
-- safe: historical enabled links become Private, never silently public.
USE file_storage;

ALTER TABLE files
    MODIFY share_permission ENUM('viewer', 'editor', 'private', 'public') NOT NULL DEFAULT 'private';
ALTER TABLE folders
    MODIFY share_permission ENUM('viewer', 'editor', 'private', 'public') NOT NULL DEFAULT 'private';
ALTER TABLE events
    MODIFY share_permission ENUM('viewer', 'editor', 'private', 'public') NOT NULL DEFAULT 'private';

UPDATE files SET share_permission = 'private' WHERE share_permission IN ('viewer', 'editor');
UPDATE folders SET share_permission = 'private' WHERE share_permission IN ('viewer', 'editor');
UPDATE events SET share_permission = 'private' WHERE share_permission IN ('viewer', 'editor');

ALTER TABLE files
    MODIFY share_permission ENUM('private', 'public') NOT NULL DEFAULT 'private',
    MODIFY is_share_link_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE folders
    MODIFY share_permission ENUM('private', 'public') NOT NULL DEFAULT 'private';
ALTER TABLE events
    MODIFY share_permission ENUM('private', 'public') NOT NULL DEFAULT 'private';
