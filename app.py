import logging
import os
import re
import secrets
import smtplib
import uuid
import zipfile
import calendar as calendar_module
from urllib.parse import urlparse
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from io import BytesIO
from datetime import date, datetime, timedelta
from functools import wraps
from pathlib import Path

import mysql.connector
from dotenv import load_dotenv
from flask import Flask, abort, flash, g, jsonify, redirect, render_template, request, send_file, send_from_directory, session, url_for
from flask_wtf.csrf import CSRFProtect
from mysql.connector import Error as MySQLError
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename


BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")


def env_int(name, default):
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


MAX_FILE_SIZE_MB = env_int("MAX_FILE_SIZE_MB", 50)
TRASH_RETENTION_DAYS = 30
SESSION_INACTIVITY_DAYS = 7
SESSION_LAST_ACTIVITY_KEY = "last_activity_at"
OFFLINE_CACHE_SCOPE_KEY = "offline_cache_scope"
UPLOAD_FOLDER = Path(os.getenv("UPLOAD_FOLDER", "uploads"))
if not UPLOAD_FOLDER.is_absolute():
    UPLOAD_FOLDER = BASE_DIR / UPLOAD_FOLDER
UPLOAD_FOLDER.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)
app.config.update(
    SECRET_KEY=os.getenv("SECRET_KEY", "change-this-before-production"),
    MAX_CONTENT_LENGTH=MAX_FILE_SIZE_MB * 1024 * 1024,
    UPLOAD_FOLDER=str(UPLOAD_FOLDER),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.getenv("SESSION_COOKIE_SECURE", "false").lower() == "true",
    PERMANENT_SESSION_LIFETIME=timedelta(days=SESSION_INACTIVITY_DAYS),
)
csrf = CSRFProtect(app)
UPLOAD_FOLDER.mkdir(parents=True, exist_ok=True)
logging.basicConfig(level=logging.INFO)

# SMTP Configuration
SMTP_SERVER = os.getenv("SMTP_SERVER", "smtp.gmail.com")
SMTP_PORT = env_int("SMTP_PORT", 587)
SMTP_USERNAME = os.getenv("SMTP_USERNAME", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM_EMAIL = os.getenv("SMTP_FROM_EMAIL", SMTP_USERNAME)
SMTP_FROM_NAME = os.getenv("SMTP_FROM_NAME", "JFCM Pila")


def send_welcome_email(email, subject="Welcome to JFCM Pila"):
    """Send a welcome email to a new user."""
    if not SMTP_USERNAME or not SMTP_PASSWORD or not SMTP_FROM_EMAIL:
        app.logger.warning("SMTP not configured; welcome email not sent")
        return False
    
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = f"{SMTP_FROM_NAME} <{SMTP_FROM_EMAIL}>"
        msg["To"] = email
        
        text = f"Welcome to JFCM Pila!\n\nYour account has been successfully created.\n\nYou can now sign in at the login page."
        html = f"""
        <html>
          <body>
            <h2>Welcome to JFCM Pila!</h2>
            <p>Your account has been successfully created.</p>
            <p>You can now sign in using your email and password.</p>
            <p style="margin-top: 30px; color: #999;">This is an automated message, please do not reply.</p>
          </body>
        </html>
        """
        
        part1 = MIMEText(text, "plain")
        part2 = MIMEText(html, "html")
        msg.attach(part1)
        msg.attach(part2)
        
        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as server:
            server.starttls()
            server.login(SMTP_USERNAME, SMTP_PASSWORD)
            server.send_message(msg)
        
        return True
    except Exception as e:
        app.logger.exception(f"Failed to send welcome email to {email}")
        return False




def get_db():
    if "db" not in g:
        g.db = mysql.connector.connect(
            host=os.getenv("MYSQLHOST"),
            port=int(os.getenv("MYSQLPORT", 3306)),
            user=os.getenv("MYSQLUSER"),
            password=os.getenv("MYSQLPASSWORD"),
            database=os.getenv("MYSQLDATABASE"),
            autocommit=False,
            )
    return g.db


@app.teardown_appcontext
def close_db(_error):
    db = g.pop("db", None)
    if db is not None and db.is_connected():
        db.close()


def query_one(sql, values):
    cursor = get_db().cursor(dictionary=True)
    try:
        cursor.execute(sql, values)
        return cursor.fetchone()
    finally:
        cursor.close()


def session_inactivity_deadline():
    return timedelta(days=SESSION_INACTIVITY_DAYS)


def touch_authenticated_session():
    session[SESSION_LAST_ACTIVITY_KEY] = datetime.now().isoformat()
    session.permanent = True
    session.modified = True


def current_offline_cache_scope():
    if "user_id" not in session:
        return "public"
    if not session.get(OFFLINE_CACHE_SCOPE_KEY):
        session[OFFLINE_CACHE_SCOPE_KEY] = secrets.token_urlsafe(24)
    return f"private:{session[OFFLINE_CACHE_SCOPE_KEY]}"


def session_is_expired():
    last_activity_raw = session.get(SESSION_LAST_ACTIVITY_KEY)
    if not last_activity_raw:
        return True
    try:
        last_activity = datetime.fromisoformat(last_activity_raw)
    except ValueError:
        return True
    return datetime.now() - last_activity > session_inactivity_deadline()


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if "user_id" not in session:
            flash("Please sign in to continue.", "error")
            return redirect(url_for("login"))
        if session_is_expired():
            session.clear()
            flash("Your session expired after 7 days of inactivity. Please sign in again.", "error")
            return redirect(url_for("login"))
        touch_authenticated_session()
        purge_expired_trash(session["user_id"])
        return view(*args, **kwargs)
    return wrapped


def login_or_public_share_required(view):
    """Allow an active signed-in session or a valid public share context."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        share_context = request_share_context()
        if "user_id" not in session:
            if not share_context:
                flash("Please sign in to continue.", "error")
                return redirect(url_for("login"))
        elif session_is_expired():
            session.clear()
            if not share_context:
                flash("Your session expired after 7 days of inactivity. Please sign in again.", "error")
                return redirect(url_for("login"))
        else:
            touch_authenticated_session()
            purge_expired_trash(session["user_id"])
        return view(*args, **kwargs)
    return wrapped


PERMISSION_LEVELS = {"viewer": 1, "editor": 2, "owner": 3}


def normalize_permission(permission, default="viewer"):
    permission = (permission or "").strip().lower()
    return permission if permission in {"viewer", "editor"} else default


def normalize_link_permission(permission, default="private"):
    """Link visibility is deliberately separate from a user's share permission."""
    permission = (permission or "").strip().lower()
    return permission if permission in {"private", "public"} else default


def permission_at_least(permission, required):
    return PERMISSION_LEVELS.get(permission or "", 0) >= PERMISSION_LEVELS[required]


def item_table(kind):
    if kind not in {"file", "folder", "event"}:
        abort(400)
    return "files" if kind == "file" else "folders" if kind == "folder" else "events"


def delete_physical_file(owner_id, stored_filename):
    path = UPLOAD_FOLDER / str(owner_id) / stored_filename
    if path.is_file():
        path.unlink()


def permanently_delete_file_record(cursor, record):
    delete_physical_file(record["user_id"], record["stored_filename"])
    cursor.execute("DELETE FROM files WHERE id = %s AND user_id = %s", (record["id"], record["user_id"]))


def permanently_delete_folder_record(cursor, folder):
    folder_ids = [folder["id"], *folder_descendants(folder["id"], owner_id=folder["user_id"], include_deleted=True)]
    placeholders = ",".join(["%s"] * len(folder_ids))
    cursor.execute(
        f"SELECT id, user_id, stored_filename FROM files WHERE user_id = %s AND folder_id IN ({placeholders})",
        (folder["user_id"], *folder_ids),
    )
    for record in cursor.fetchall():
        delete_physical_file(record["user_id"], record["stored_filename"])
    cursor.execute(f"DELETE FROM files WHERE user_id = %s AND folder_id IN ({placeholders})", (folder["user_id"], *folder_ids))
    cursor.execute(f"UPDATE folders SET parent_id = NULL WHERE user_id = %s AND id IN ({placeholders})", (folder["user_id"], *folder_ids))
    cursor.execute(f"DELETE FROM folders WHERE user_id = %s AND id IN ({placeholders})", (folder["user_id"], *folder_ids))


def permanently_delete_event_record(cursor, event):
    cursor.execute("SELECT id, user_id, stored_filename FROM files WHERE user_id = %s AND event_id = %s", (event["user_id"], event["id"]))
    for record in cursor.fetchall():
        delete_physical_file(record["user_id"], record["stored_filename"])
    cursor.execute("DELETE FROM files WHERE user_id = %s AND event_id = %s", (event["user_id"], event["id"]))
    cursor.execute("UPDATE folders SET parent_id = NULL WHERE user_id = %s AND event_id = %s", (event["user_id"], event["id"]))
    cursor.execute("DELETE FROM folders WHERE user_id = %s AND event_id = %s", (event["user_id"], event["id"]))
    cursor.execute("DELETE FROM events WHERE id = %s AND user_id = %s", (event["id"], event["user_id"]))


def purge_expired_trash(owner_id):
    cutoff = datetime.now() - timedelta(days=TRASH_RETENTION_DAYS)
    cursor = get_db().cursor(dictionary=True)
    try:
        cursor.execute("SELECT id, user_id, name FROM events WHERE user_id = %s AND is_deleted = TRUE AND deleted_at <= %s", (owner_id, cutoff))
        for event in cursor.fetchall():
            permanently_delete_event_record(cursor, event)

        cursor.execute(
            "SELECT id, user_id, name FROM folders WHERE user_id = %s AND is_deleted = TRUE AND deleted_at <= %s ORDER BY id",
            (owner_id, cutoff),
        )
        deleted_folder_ids = set()
        for folder in cursor.fetchall():
            if folder["id"] in deleted_folder_ids:
                continue
            subtree_ids = [folder["id"], *folder_descendants(folder["id"], owner_id=folder["user_id"], include_deleted=True)]
            permanently_delete_folder_record(cursor, folder)
            deleted_folder_ids.update(subtree_ids)

        cursor.execute("SELECT id, user_id, stored_filename FROM files WHERE user_id = %s AND is_deleted = TRUE AND deleted_at <= %s", (owner_id, cutoff))
        for record in cursor.fetchall():
            permanently_delete_file_record(cursor, record)
        get_db().commit()
    except (MySQLError, OSError):
        get_db().rollback()
        app.logger.exception("Automatic trash expiration failed")
    finally:
        cursor.close()


def share_table(kind):
    if kind not in {"file", "folder", "event"}:
        abort(400)
    return "file_user_shares" if kind == "file" else "folder_user_shares" if kind == "folder" else "event_user_shares"


def file_record(file_id, include_deleted=False):
    deleted_condition = "" if include_deleted else " AND files.is_deleted = FALSE"
    return query_one(
        "SELECT files.id, files.user_id, files.original_filename, files.stored_filename, files.file_size, files.mime_type, "
        "files.uploaded_at, files.accessed_at, files.share_token, files.share_permission, files.is_share_link_enabled, "
        "files.folder_id, files.event_id, files.is_starred, users.username AS owner "
        "FROM files JOIN users ON users.id = files.user_id "
        "WHERE files.id = %s" + deleted_condition,
        (file_id,),
    )


def event_record(event_id, include_deleted=False):
    condition = "" if include_deleted else " AND is_deleted = FALSE"
    return query_one(
        "SELECT id, user_id, name, event_date, event_type, share_token, share_permission, is_share_link_enabled, "
        "is_starred, is_deleted "
        "FROM events WHERE id = %s" + condition,
        (event_id,),
    )


def owned_file(file_id):
    record = file_record(file_id)
    if record and record["user_id"] == session["user_id"]:
        return record
    return None


def owned_folder(folder_id, include_deleted=False):
    condition = "" if include_deleted else " AND is_deleted = FALSE"
    return query_one(
        "SELECT id, user_id, parent_id, event_id, original_parent_id, name, share_token, share_permission, "
        "is_share_link_enabled, is_starred, is_deleted "
        "FROM folders WHERE id = %s AND user_id = %s" + condition,
        (folder_id, session["user_id"]),
    )


def folder_record(folder_id, include_deleted=False):
    condition = "" if include_deleted else " AND is_deleted = FALSE"
    return query_one(
        "SELECT id, user_id, parent_id, event_id, original_parent_id, name, share_token, share_permission, "
        "is_share_link_enabled, is_starred, is_deleted "
        "FROM folders WHERE id = %s" + condition,
        (folder_id,),
    )


def owned_event(event_id, include_deleted=False):
    record = event_record(event_id, include_deleted=include_deleted)
    if record and record["user_id"] == session["user_id"]:
        return record
    return None


def valid_event(event_id):
    if event_id in (None, ""):
        return None
    try:
        event_id = int(event_id)
    except (TypeError, ValueError):
        abort(400)
    if not owned_event(event_id):
        abort(404)
    return event_id


def valid_destination(folder_id):
    if folder_id in (None, "", "root"):
        return None
    try:
        folder_id = int(folder_id)
    except (TypeError, ValueError):
        abort(400)
    folder = owned_folder(folder_id)
    if not folder:
        abort(404)
    return folder_id


def event_archive_contents(event):
    cursor = get_db().cursor(dictionary=True)
    try:
        cursor.execute(
            "SELECT id, parent_id, name FROM folders WHERE user_id = %s AND event_id = %s AND is_deleted = FALSE ORDER BY id",
            (event["user_id"], event["id"]),
        )
        folders = cursor.fetchall()
        cursor.execute(
            "SELECT stored_filename, original_filename, folder_id FROM files WHERE user_id = %s AND event_id = %s AND is_deleted = FALSE ORDER BY id",
            (event["user_id"], event["id"]),
        )
        files = cursor.fetchall()
    finally:
        cursor.close()
    return folders, files


def write_event_archive(bundle, event, written_paths=None):
    folders, files = event_archive_contents(event)
    event_root = event["name"]
    if written_paths is not None:
        candidate_root = event_root
        counter = 2
        while f"{candidate_root}/" in written_paths:
            candidate_root = f"{event_root} ({counter})"
            counter += 1
        event_root = candidate_root
        written_paths.add(f"{event_root}/")
    bundle.writestr(f"{event_root}/", "")

    relative_paths = {}
    pending = [None]
    while pending:
        parent_id = pending.pop()
        for child in folders:
            if child["parent_id"] == parent_id:
                parent_path = event_root if parent_id is None else relative_paths[parent_id]
                relative_paths[child["id"]] = f"{parent_path}/{child['name']}"
                pending.append(child["id"])

    for folder in folders:
        folder_path = f"{relative_paths[folder['id']]}/"
        if written_paths is None or folder_path not in written_paths:
            if written_paths is not None:
                written_paths.add(folder_path)
            bundle.writestr(folder_path, "")

    owner_directory = user_directory(event["user_id"])
    for file_record in files:
        path = owner_directory / file_record["stored_filename"]
        if not path.is_file():
            continue
        parent_path = event_root if file_record["folder_id"] is None else relative_paths.get(file_record["folder_id"])
        if not parent_path:
            continue
        archive_path = f"{parent_path}/{file_record['original_filename']}"
        if written_paths is None:
            bundle.write(path, arcname=archive_path)
            continue
        candidate_path = archive_path
        counter = 2
        while candidate_path in written_paths:
            stem, suffix = os.path.splitext(archive_path)
            candidate_path = f"{stem} ({counter}){suffix}"
            counter += 1
        written_paths.add(candidate_path)
        bundle.write(path, arcname=candidate_path)


def user_directory(user_id):
    return UPLOAD_FOLDER / str(user_id)


def folder_chain(folder_id, stop_at=None):
    chain = []
    current_id = folder_id
    seen = set()
    while current_id and current_id not in seen:
        folder = folder_record(current_id)
        if not folder:
            break
        chain.append(folder)
        if stop_at and current_id == stop_at:
            break
        seen.add(current_id)
        current_id = folder["parent_id"]
    return chain


def folder_is_within(folder_id, root_folder_id):
    return any(folder["id"] == root_folder_id for folder in folder_chain(folder_id))


def share_context_from_token(kind, share_token):
    current_user_id = session.get("user_id")
    if kind == "file":
        record = query_one(
            "SELECT id, user_id, share_token, share_permission, is_share_link_enabled "
            "FROM files WHERE share_token = %s AND is_deleted = FALSE",
            (share_token,),
        )
        if not record:
            return None
        link_permission = "viewer" if record["is_share_link_enabled"] and normalize_link_permission(record["share_permission"]) == "public" else None
        user_share = query_one(
            "SELECT permission FROM file_user_shares WHERE file_id = %s AND shared_with_user_id = %s",
            (record["id"], current_user_id),
        )
        if current_user_id and record["user_id"] == current_user_id:
            permission = "owner"
        else:
            permission = None
            if link_permission:
                permission = link_permission
            if user_share:
                shared_permission = normalize_permission(user_share["permission"])
                if permission is None or permission_at_least(shared_permission, permission):
                    permission = shared_permission
            if permission is None:
                return None
        return {
            "kind": "file",
            "token": share_token,
            "item_id": record["id"],
            "owner_id": record["user_id"],
            "permission": permission,
        }

    if kind == "event":
        record = query_one(
            "SELECT id, user_id, share_token, share_permission, is_share_link_enabled "
            "FROM events WHERE share_token = %s AND is_deleted = FALSE",
            (share_token,),
        )
        if not record:
            return None
        user_share = query_one(
            "SELECT permission FROM event_user_shares WHERE event_id = %s AND shared_with_user_id = %s",
            (record["id"], current_user_id),
        )
        if current_user_id and record["user_id"] == current_user_id:
            permission = "owner"
        else:
            permission = None
            if record["is_share_link_enabled"] and normalize_link_permission(record["share_permission"]) == "public":
                permission = "viewer"
            if user_share:
                shared_permission = normalize_permission(user_share["permission"])
                if permission is None or permission_at_least(shared_permission, permission):
                    permission = shared_permission
            if permission is None:
                return None
        return {
            "kind": "event",
            "token": share_token,
            "item_id": record["id"],
            "owner_id": record["user_id"],
            "permission": permission,
        }

    record = query_one(
        "SELECT id, user_id, share_token, share_permission, is_share_link_enabled "
        "FROM folders WHERE share_token = %s AND is_deleted = FALSE",
        (share_token,),
    )
    if not record:
        return None
    user_share = query_one(
        "SELECT permission FROM folder_user_shares WHERE folder_id = %s AND shared_with_user_id = %s",
        (record["id"], current_user_id),
    )
    if current_user_id and record["user_id"] == current_user_id:
        permission = "owner"
    else:
        permission = None
        if record["is_share_link_enabled"] and normalize_link_permission(record["share_permission"]) == "public":
            permission = "viewer"
        if user_share:
            shared_permission = normalize_permission(user_share["permission"])
            if permission is None or permission_at_least(shared_permission, permission):
                permission = shared_permission
        if permission is None:
            return None
    return {
        "kind": "folder",
        "token": share_token,
        "item_id": record["id"],
        "owner_id": record["user_id"],
        "permission": permission,
    }


def request_share_context():
    share_kind = request.values.get("share_context_kind", "").strip().lower()
    share_token = request.values.get("share_context_token", "").strip()
    if share_kind in {"file", "folder", "event"} and re.fullmatch(r"[A-Za-z0-9_-]{32,64}", share_token):
        return share_context_from_token(share_kind, share_token)
    return None


def require_share_manage_access(kind, item_id):
    if kind not in {"file", "folder", "event"}:
        abort(404)
    record = owned_file(item_id) if kind == "file" else owned_folder(item_id) if kind == "folder" else owned_event(item_id)
    if not record:
        abort(404)
    return record


def direct_event_share_permission(event_id):
    share = query_one(
        "SELECT permission FROM event_user_shares WHERE event_id = %s AND shared_with_user_id = %s",
        (event_id, session["user_id"]),
    )
    return normalize_permission(share["permission"]) if share else None


def direct_folder_share_permission(folder_id):
    chain = folder_chain(folder_id)
    best_permission = None
    for folder in chain:
        share = query_one(
            "SELECT permission FROM folder_user_shares WHERE folder_id = %s AND shared_with_user_id = %s",
            (folder["id"], session["user_id"]),
        )
        if share:
            permission = normalize_permission(share["permission"])
            if best_permission is None or permission_at_least(permission, best_permission):
                best_permission = permission
                if permission == "editor":
                    break
    if chain:
        event_id = chain[0].get("event_id")
        if event_id:
            event_permission = direct_event_share_permission(event_id)
            if event_permission and (best_permission is None or permission_at_least(event_permission, best_permission)):
                best_permission = event_permission
    return best_permission


def direct_file_share_permission(record):
    share = query_one(
        "SELECT permission FROM file_user_shares WHERE file_id = %s AND shared_with_user_id = %s",
        (record["id"], session["user_id"]),
    )
    if share:
        return normalize_permission(share["permission"])
    best_permission = None
    folder_id = record.get("folder_id")
    if folder_id:
        best_permission = direct_folder_share_permission(folder_id)
    event_id = record.get("event_id")
    if event_id:
        event_permission = direct_event_share_permission(event_id)
        if event_permission and (best_permission is None or permission_at_least(event_permission, best_permission)):
            best_permission = event_permission
    return best_permission


def accessible_event(event_id, required="viewer", share_context=None, include_deleted=False):
    event = event_record(event_id, include_deleted=include_deleted)
    if not event:
        return None
    if session.get("user_id") and event["user_id"] == session["user_id"]:
        return {**event, "access_permission": "owner", "access_via": "owner"}
    direct_permission = direct_event_share_permission(event["id"]) if session.get("user_id") else None
    if direct_permission and permission_at_least(direct_permission, required):
        return {**event, "access_permission": direct_permission, "access_via": "event_share"}
    if share_context and share_context["kind"] == "event" and share_context["owner_id"] == event["user_id"]:
        if event["id"] == share_context["item_id"] and permission_at_least(share_context["permission"], required):
            return {**event, "access_permission": share_context["permission"], "access_via": "event_link"}
    return None


def accessible_folder(folder_id, required="viewer", share_context=None, include_deleted=False):
    folder = folder_record(folder_id, include_deleted=include_deleted)
    if not folder:
        return None
    if session.get("user_id") and folder["user_id"] == session["user_id"]:
        return {**folder, "access_permission": "owner", "access_via": "owner"}
    direct_permission = direct_folder_share_permission(folder["id"]) if session.get("user_id") else None
    if direct_permission and permission_at_least(direct_permission, required):
        return {**folder, "access_permission": direct_permission, "access_via": "folder_share"}
    if folder.get("event_id"):
        event_permission = direct_event_share_permission(folder["event_id"]) if session.get("user_id") else None
        if event_permission and permission_at_least(event_permission, required):
            return {**folder, "access_permission": event_permission, "access_via": "event_share"}
    if share_context and share_context["kind"] == "folder" and share_context["owner_id"] == folder["user_id"]:
        if folder["id"] == share_context["item_id"] or folder_is_within(folder["id"], share_context["item_id"]):
            if permission_at_least(share_context["permission"], required):
                return {**folder, "access_permission": share_context["permission"], "access_via": "folder_link"}
    if share_context and share_context["kind"] == "event" and share_context["owner_id"] == folder["user_id"]:
        if folder.get("event_id") == share_context["item_id"] and permission_at_least(share_context["permission"], required):
            return {**folder, "access_permission": share_context["permission"], "access_via": "event_link"}
    return None


def accessible_file(file_id, required="viewer", share_context=None):
    record = file_record(file_id)
    if not record:
        return None
    if session.get("user_id") and record["user_id"] == session["user_id"]:
        return {**record, "access_permission": "owner", "access_via": "owner"}
    direct_permission = direct_file_share_permission(record) if session.get("user_id") else None
    if direct_permission and permission_at_least(direct_permission, required):
        return {**record, "access_permission": direct_permission, "access_via": "direct_share"}
    if share_context and share_context["owner_id"] == record["user_id"]:
        if share_context["kind"] == "file" and share_context["item_id"] == record["id"] and permission_at_least(share_context["permission"], required):
            return {**record, "access_permission": share_context["permission"], "access_via": "file_link"}
        if share_context["kind"] == "folder" and record["folder_id"] and folder_is_within(record["folder_id"], share_context["item_id"]) and permission_at_least(share_context["permission"], required):
            return {**record, "access_permission": share_context["permission"], "access_via": "folder_link"}
        if share_context["kind"] == "event" and record.get("event_id") == share_context["item_id"] and permission_at_least(share_context["permission"], required):
            return {**record, "access_permission": share_context["permission"], "access_via": "event_link"}
    return None


def redirect_to_workspace(default=None):
    """Return to the current dashboard workspace when it is supplied safely."""
    target = request.form.get("return_to") or request.args.get("return_to") or request.referrer
    if target:
        parsed = urlparse(target)
        allowed_paths = {url_for("dashboard")}
        share_context = request_share_context()
        if share_context and share_context["kind"] == "folder":
            allowed_paths.add(url_for("shared_folder", share_token=share_context["token"]))
        if share_context and share_context["kind"] == "event":
            allowed_paths.add(url_for("shared_event", share_token=share_context["token"]))
        if (not parsed.netloc or parsed.netloc == request.host) and parsed.path in allowed_paths:
            return redirect(target)
    return redirect(default or url_for("dashboard"))


def workspace_return_url(default=None):
    """Return a safe dashboard URL for links and form return targets."""
    target = request.args.get("return_to") or request.referrer
    if target:
        parsed = urlparse(target)
        allowed_paths = {url_for("dashboard")}
        share_context = request_share_context()
        if share_context and share_context["kind"] == "folder":
            allowed_paths.add(url_for("shared_folder", share_token=share_context["token"]))
        if share_context and share_context["kind"] == "event":
            allowed_paths.add(url_for("shared_event", share_token=share_context["token"]))
        if (not parsed.netloc or parsed.netloc == request.host) and parsed.path in allowed_paths:
            return target
    return default or url_for("dashboard")


def folder_descendants(folder_id, owner_id=None, include_deleted=False):
    """Return descendant IDs using server-side ownership-scoped traversal."""
    owner_id = session["user_id"] if owner_id is None else owner_id
    descendants = []
    pending = [folder_id]
    while pending:
        current = pending.pop()
        cursor = get_db().cursor(dictionary=True)
        try:
            cursor.execute(
                "SELECT id FROM folders WHERE user_id = %s AND parent_id = %s AND is_deleted = %s",
                (owner_id, current, include_deleted),
            )
            children = [row["id"] for row in cursor.fetchall()]
        finally:
            cursor.close()
        descendants.extend(children)
        pending.extend(children)
    return descendants


def folder_sizes(cursor, folder_ids, include_deleted=False, owner_id=None):
    """Return recursive file-size totals for the supplied folder IDs."""
    if not folder_ids:
        return {}
    owner_id = session["user_id"] if owner_id is None else owner_id
    placeholders = ",".join(["%s"] * len(folder_ids))
    cursor.execute(
        f"""
        WITH RECURSIVE folder_tree (root_id, folder_id) AS (
            SELECT id, id
            FROM folders
            WHERE user_id = %s AND is_deleted = %s AND id IN ({placeholders})
            UNION ALL
            SELECT folder_tree.root_id, child.id
            FROM folder_tree
            JOIN folders AS child ON child.parent_id = folder_tree.folder_id
            WHERE child.user_id = %s AND child.is_deleted = %s
        )
        SELECT folder_tree.root_id, COALESCE(SUM(files.file_size), 0) AS total_size
        FROM folder_tree
        LEFT JOIN files ON files.folder_id = folder_tree.folder_id
            AND files.user_id = %s AND files.is_deleted = %s
        GROUP BY folder_tree.root_id
        """,
        (owner_id, include_deleted, *folder_ids, owner_id, include_deleted, owner_id, include_deleted),
    )
    return {row["root_id"]: row["total_size"] or 0 for row in cursor.fetchall()}


def folder_paths(folders):
    """Build display paths for a user's folder tree without cross-user lookups."""
    folders_by_id = {folder["id"]: folder for folder in folders}
    paths = {}

    def build_path(folder_id, seen=None):
        if folder_id in paths:
            return paths[folder_id]
        seen = set() if seen is None else seen
        folder = folders_by_id.get(folder_id)
        if not folder or folder_id in seen:
            return "Library"
        parent_id = folder.get("parent_id")
        parent_path = build_path(parent_id, seen | {folder_id}) if parent_id else "Library"
        paths[folder_id] = f"{parent_path} / {folder['name']}"
        return paths[folder_id]

    for folder_id in folders_by_id:
        build_path(folder_id)
    return paths


def file_location(record):
    """Return a safe display location for preview metadata."""
    if record.get("event_id"):
        event = query_one(
            "SELECT id, name FROM events WHERE id = %s AND user_id = %s AND is_deleted = FALSE",
            (record["event_id"], record["user_id"]),
        )
        root = f"Events / {event['name']}" if event else "Events"
    else:
        root = "Library"
    folder_id = record.get("folder_id")
    if not folder_id:
        return root
    parts = []
    while folder_id:
        folder = folder_record(folder_id)
        if folder and folder["user_id"] != record["user_id"]:
            break
        if not folder:
            break
        parts.append(folder["name"])
        folder_id = folder["parent_id"]
    return " / ".join([root, *reversed(parts)])


def normalized_calendar_month(year=None, month=None):
    today = date.today()
    try:
        year = int(year) if year is not None else today.year
    except (TypeError, ValueError):
        year = today.year
    try:
        month = int(month) if month is not None else today.month
    except (TypeError, ValueError):
        month = today.month
    if year < 1 or year > 9999:
        year = today.year
    if month < 1 or month > 12:
        month = today.month
    return year, month


def shift_calendar_month(year, month, delta):
    total_months = (year * 12) + (month - 1) + delta
    new_year = total_months // 12
    new_month = (total_months % 12) + 1
    if new_year < 1:
        new_year = 1
    return new_year, new_month


def sunday_first_month_weeks(year, month):
    """Return calendar weeks with Sunday as index 0 and no timezone-sensitive parsing."""
    return calendar_module.Calendar(firstweekday=calendar_module.SUNDAY).monthdayscalendar(year, month)


def build_events_calendar_context(year=None, month=None, url_builder=None):
    year, month = normalized_calendar_month(year, month)
    cursor = get_db().cursor(dictionary=True)
    try:
        cursor.execute(
            "SELECT id, name, event_date, event_type FROM events "
            "WHERE user_id = %s AND is_deleted = FALSE AND event_date IS NOT NULL "
            "AND YEAR(event_date) = %s AND MONTH(event_date) = %s ORDER BY event_date, name",
            (session["user_id"], year, month),
        )
        events = cursor.fetchall()
    except MySQLError:
        app.logger.exception("Events calendar database error")
        flash("Could not load the Events calendar. Please try again.", "error")
        events = []
    finally:
        cursor.close()
    events_by_day = {}
    for event in events:
        events_by_day.setdefault(event["event_date"].day, []).append(event)
    previous_year, previous_month = shift_calendar_month(year, month, -1)
    next_year, next_month = shift_calendar_month(year, month, 1)
    weeks = sunday_first_month_weeks(year, month)
    day_urls = {}
    if url_builder:
        for week in weeks:
            for day in week:
                if day:
                    day_urls[day] = url_builder(event_date=date(year, month, day).isoformat(), calendar=None)
    return {
        "month_name": calendar_module.month_name[month],
        "year": year,
        "month": month,
        "weeks": weeks,
        "events_by_day": events_by_day,
        "calendar_previous_url": url_builder(calendar="open", calendar_year=previous_year, calendar_month=previous_month) if url_builder else None,
        "calendar_next_url": url_builder(calendar="open", calendar_year=next_year, calendar_month=next_month) if url_builder else None,
        "calendar_day_urls": day_urls,
    }


def preview_kind(record):
    classification = classify_file_type(record)
    mime_type = classification["mime_type"]
    extension = classification["extension"]
    if classification["key"] in {"image", "pdf", "video", "audio", "powerpoint", "spreadsheet"}:
        return classification["key"]
    if mime_type.startswith("text/") or extension in {".txt", ".md", ".log"}:
        return "text"
    return "unavailable"


def record_path(record):
    stored_name = record["stored_filename"]
    if stored_name != Path(stored_name).name:
        abort(404)
    return user_directory(record["user_id"]) / stored_name


FILE_TYPE_DEFINITIONS = (
    {
        "key": "image",
        "label": "Image",
        "icon": "Image.png",
        "mime_prefixes": ("image/",),
        "extensions": {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".ico", ".tif", ".tiff"},
    },
    {
        "key": "pdf",
        "label": "PDF",
        "icon": "PDF.png",
        "mime_types": {"application/pdf"},
        "extensions": {".pdf"},
    },
    {
        "key": "document",
        "label": "Document",
        "icon": "Word.png",
        "mime_types": {
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.oasis.opendocument.text",
            "application/rtf",
            "text/rtf",
            "application/x-rtf",
            "text/plain",
            "text/markdown",
        },
        "extensions": {".doc", ".docx", ".odt", ".rtf", ".txt", ".md"},
    },
    {
        "key": "spreadsheet",
        "label": "Spreadsheet",
        "icon": "Spreadsheet.png",
        "mime_types": {
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.oasis.opendocument.spreadsheet",
            "text/csv",
            "text/tab-separated-values",
        },
        "extensions": {".xls", ".xlsx", ".ods", ".csv", ".tsv"},
    },
    {
        "key": "powerpoint",
        "label": "PowerPoint",
        "icon": "PPT.png",
        "mime_types": {
            "application/vnd.ms-powerpoint",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
            "application/vnd.oasis.opendocument.presentation",
        },
        "extensions": {".ppt", ".pptx", ".pps", ".ppsx", ".odp"},
    },
    {
        "key": "video",
        "label": "Video",
        "icon": "Video.png",
        "mime_prefixes": ("video/",),
        "extensions": {".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v"},
    },
    {
        "key": "audio",
        "label": "Audio",
        "icon": "Audio.png",
        "mime_prefixes": ("audio/",),
        "extensions": {".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"},
    },
    {
        "key": "zip",
        "label": "ZIP",
        "icon": "Zip.png",
        "mime_types": {
            "application/zip",
            "application/x-zip",
            "application/x-zip-compressed",
            "application/x-rar-compressed",
            "application/x-7z-compressed",
            "application/x-tar",
            "application/gzip",
            "application/x-gzip",
        },
        "extensions": {".zip", ".rar", ".7z", ".tar", ".gz", ".tgz"},
    },
)

EVENT_TYPE_OPTIONS = (
    ("event", "Event", "Event.png"),
    ("heart", "Heart", "Heart.png"),
    ("birthday", "Birthday", "Birthday.png"),
    ("graduation", "Graduation", "Graduation.png"),
    ("celebration", "Celebration", "Celebration.png"),
    ("fellowship", "Fellowship", "Fellowship.png"),
    ("water", "Water", "Water.png"),
    ("supper", "Supper", "Supper.png"),
)
EVENT_TYPE_FILE_MAP = {key: filename for key, _label, filename in EVENT_TYPE_OPTIONS}


def classify_file_type(file_or_mime, filename=None):
    if isinstance(file_or_mime, dict):
        mime_type = (file_or_mime.get("mime_type") or "").lower().strip()
        filename = file_or_mime.get("original_filename") or file_or_mime.get("name") or filename or ""
    else:
        mime_type = (file_or_mime or "").lower().strip()
        filename = filename or ""
    extension = Path(filename).suffix.lower()

    for definition in FILE_TYPE_DEFINITIONS:
        mime_types = definition.get("mime_types", set())
        mime_prefixes = definition.get("mime_prefixes", tuple())
        extensions = definition.get("extensions", set())
        if mime_type in mime_types or any(mime_type.startswith(prefix) for prefix in mime_prefixes) or extension in extensions:
            return {
                "key": definition["key"],
                "label": definition["label"],
                "icon": definition["icon"],
                "mime_type": mime_type,
                "extension": extension,
            }

    return {
        "key": "other",
        "label": "Other",
        "icon": "File.png",
        "mime_type": mime_type,
        "extension": extension,
    }


def clean_file_type(file_or_mime, filename=None):
    return classify_file_type(file_or_mime, filename)["label"]


def file_type_key(file_or_mime, filename=None):
    return classify_file_type(file_or_mime, filename)["key"]


def file_type_icon(file_or_mime, filename=None):
    return classify_file_type(file_or_mime, filename)["icon"]


def event_icon_file(event_type):
    return EVENT_TYPE_FILE_MAP.get((event_type or "").strip().lower(), EVENT_TYPE_FILE_MAP["event"])


def event_type_label(event_type):
    labels = {
        "event": "Event",
        "heart": "Anniversary",
        "balloon": "Birthday",
        "birthday": "Birthday",
        "graduation": "Graduation",
        "celebration": "Celebration",
        "fellowship": "Fellowship",
        "water": "Water Baptism",
        "supper": "Lord's Supper",
    }
    return labels.get((event_type or "").strip().lower(), "Event")


def trash_days_remaining(deleted_at):
    if not deleted_at:
        return ""
    expire_date = deleted_at.date() + timedelta(days=TRASH_RETENTION_DAYS)
    remaining_days = (expire_date - date.today()).days
    if remaining_days <= 0:
        return "Expires today"
    return f"{remaining_days} day{'s' if remaining_days != 1 else ''} left"


def display_name(name):
    """Format stored names for display without changing the stored value."""
    return (name or "").replace("-", " ").replace("_", " ")


def format_datetime(dt):
    """Format datetime to 'Aug 17, 2026 12:21pm' format."""
    if not dt:
        return ""
    formatted = dt.strftime('%b %d, %Y %I:%M%p')
    formatted = formatted.replace(' 0', ' ', 1)
    return formatted.replace('AM', 'am').replace('PM', 'pm')


@app.context_processor
def utility_processor():
    def readable_size(size):
        size = int(size or 0)
        for unit in ("B", "KB", "MB", "GB"):
            if size < 1024 or unit == "GB":
                if unit == "B":
                    return f"{size} B"
                formatted_size = f"{size:.1f}".rstrip("0").rstrip(".")
                return f"{formatted_size} {unit}"
            size /= 1024

    def display_item_size(kind, size):
        normalized_kind = (kind or "").strip().lower()
        normalized_size = int(size or 0)
        if normalized_kind in {"folder", "event"} and normalized_size == 0:
            return "—"
        return readable_size(normalized_size)

    return {
        "readable_size": readable_size,
        "display_item_size": display_item_size,
        "max_file_size_mb": MAX_FILE_SIZE_MB,
        "clean_file_type": clean_file_type,
        "file_type_key": file_type_key,
        "file_type_icon": file_type_icon,
        "display_name": display_name,
        "format_datetime": format_datetime,
        "event_icon_options": EVENT_TYPE_OPTIONS,
        "event_icon_file": event_icon_file,
        "event_type_label": event_type_label,
        "trash_days_remaining": trash_days_remaining,
        "offline_cache_scope": current_offline_cache_scope(),
    }


@app.route("/")
def index():
    # Keep the landing route session-aware while the dashboard remains the
    # single renderer for authenticated and public workspaces.
    if "user_id" in session:
        if session_is_expired():
            session.clear()
            flash("Your session expired after 7 days of inactivity. Please sign in again.", "error")
        else:
            touch_authenticated_session()
            purge_expired_trash(session["user_id"])
    return redirect(url_for("dashboard"))


@app.route("/register", methods=["GET", "POST"])
def register():
    if "user_id" in session:
        return redirect_to_workspace()
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        username = request.form.get("username", "").strip().lower()
        password = request.form.get("password", "")
        confirm_password = request.form.get("confirm_password", "")
        if not email or "@" not in email:
            flash("Enter a valid email address.", "error")
        elif not re.fullmatch(r"[a-z0-9_]{3,20}", username):
            flash("Username must be 3-20 characters using letters, numbers, or underscores.", "error")
        elif not password or len(password) < 6:
            flash("Password must be at least 6 characters.", "error")
        elif password != confirm_password:
            flash("Passwords do not match.", "error")
        else:
            cursor = None
            try:
                cursor = get_db().cursor()
                cursor.execute(
                    "INSERT INTO users (email, username, password_hash) VALUES (%s, %s, %s)",
                    (email, username, generate_password_hash(password)),
                )
                get_db().commit()
                send_welcome_email(email)
                flash("Account created. Please check your email and sign in.", "success")
                return redirect(url_for("login"))
            except MySQLError as error:
                get_db().rollback()
                if getattr(error, "errno", None) == 1062:
                    flash("That email or username is already in use.", "error")
                else:
                    app.logger.exception("Registration database error")
                    flash("Unable to create the account. Please try again.", "error")
            finally:
                if cursor:
                    cursor.close()
    return render_template("register.html")


@app.get("/login")
def login():
    if "user_id" in session:
        return redirect_to_workspace()
    return render_template("login.html")


@app.post("/login")
def login_post():
    identifier = request.form.get("identifier", "").strip().lower()
    password = request.form.get("password", "")
    if not identifier or not password:
        flash("Enter your email/username and password.", "error")
    else:
        try:
            user = query_one(
                "SELECT id, email, username, password_hash FROM users "
                "WHERE email = %s OR username = %s LIMIT 1",
                (identifier, identifier),
            )
            if not user or not check_password_hash(user["password_hash"], password):
                flash("Invalid email/username or password.", "error")
            else:
                session.clear()
                session["user_id"] = user["id"]
                session["username"] = user["username"] or user["email"]
                session[OFFLINE_CACHE_SCOPE_KEY] = secrets.token_urlsafe(24)
                touch_authenticated_session()
                return redirect(url_for("dashboard"))
        except MySQLError:
            app.logger.exception("Login database error")
            flash("Unable to sign in right now. Please try again.", "error")
    return render_template("login.html")


@app.get("/logout")
def logout():
    session.clear()
    flash("You have been signed out.", "success")
    return redirect(url_for("login"))


@app.get("/storage")
def dashboard():
    if "user_id" not in session:
        return public_dashboard()
    section = request.args.get("section", "files")
    folder_id = request.args.get("folder", type=int)
    event_id = request.args.get("event", type=int)
    selected_event_date_raw = request.args.get("event_date", "").strip()
    search_query = request.args.get("search", "").strip()
    calendar_year, calendar_month = normalized_calendar_month(request.args.get("calendar_year"), request.args.get("calendar_month"))
    if section not in {"files", "recent", "starred", "trash", "events", "shared"}:
        abort(404)
    if section == "shared":
        items = shared_with_me_items(session["user_id"])
        today = date.today()
        return render_template(
            "dashboard.html", page_title="Shared with me", items=items, total_storage=0, total_files=len(items),
            section="shared", current_folder=None, breadcrumbs=[], folder_id=None, event_id=None, current_event=None,
            selected_event_date=None, selected_event_date_iso="", is_event_date_workspace=False,
            date_workspace_events=[], is_trash=False, move_folders=[], sidebar_events=[], search_query="",
            calendar_auto_open=False, is_global_search=False, is_shared_workspace=False,
            workspace_can_edit=False, workspace_can_manage_sharing=False, share_context=None,
            is_shared_listing=True,
            month_name=calendar_module.month_name[today.month], year=today.year, month=today.month,
            weeks=sunday_first_month_weeks(today.year, today.month), events_by_day={}, calendar_day_urls={},
            calendar_previous_url="", calendar_next_url="", show_calendar_back_link=False,
        )
    try:
        selected_event_date = date.fromisoformat(selected_event_date_raw) if selected_event_date_raw else None
    except ValueError:
        selected_event_date = None
    is_event_date_workspace = section == "events" and event_id is None and selected_event_date is not None

    def dashboard_url_with_updates(**updates):
        params = dict(request.args.items())
        if "event_date" in updates:
            updates.setdefault("section", "events")
            updates.setdefault("event", None)
            updates.setdefault("folder", None)
            updates.setdefault("search", None)
        for key, value in updates.items():
            if value in (None, ""):
                params.pop(key, None)
            else:
                params[key] = str(value)
        return url_for("dashboard", **params)

    try:
        current_folder = None
        current_event = None
        breadcrumbs = []
        if event_id is not None:
            if section != "events":
                abort(400)
            current_event = owned_event(event_id)
            if not current_event:
                abort(404)
        if folder_id is not None:
            if section not in {"files", "events"}:
                abort(400)
            current_folder = owned_folder(folder_id)
            if not current_folder or (section == "events" and current_folder["event_id"] != event_id):
                abort(404)
            cursor = get_db().cursor()
            cursor.execute("UPDATE folders SET accessed_at = NOW() WHERE id = %s AND user_id = %s", (folder_id, session["user_id"]))
            get_db().commit()
            cursor.close()
            node = current_folder
            while node:
                breadcrumbs.append(node)
                node = owned_folder(node["parent_id"]) if node["parent_id"] else None
            breadcrumbs.reverse()
        cursor = get_db().cursor(dictionary=True)
        cursor.execute("SELECT COALESCE(SUM(file_size), 0) AS total_storage FROM files WHERE user_id = %s AND is_deleted = FALSE", (session["user_id"],))
        total_storage = cursor.fetchone()["total_storage"] or 0
        deleted = section == "trash"
        date_workspace_events = []
        events = []
        if is_event_date_workspace and not search_query:
            cursor.execute(
                "SELECT id, name, event_date, event_type, share_token, is_share_link_enabled, created_at, is_starred FROM events "
                "WHERE user_id = %s AND is_deleted = FALSE AND event_date = %s ORDER BY name",
                (session["user_id"], selected_event_date),
            )
            events = cursor.fetchall()
            date_workspace_events = events
            folders = []
            files = []
        elif section == "events" and event_id is None and not search_query:
            cursor.execute("SELECT id, name, event_date, event_type, share_token, is_share_link_enabled, created_at, is_starred FROM events WHERE user_id = %s AND is_deleted = FALSE ORDER BY event_date, name", (session["user_id"],))
            events = cursor.fetchall()
            folders = []
            files = []
        elif search_query:
            search_term = f"%{search_query}%"
            folder_scope = []
            if folder_id is not None:
                folder_scope = [folder_id, *folder_descendants(folder_id)]
            if folder_scope:
                placeholders = ",".join(["%s"] * len(folder_scope))
                folder_scope_sql = f" AND id IN ({placeholders})"
                file_scope_sql = f" AND folder_id IN ({placeholders})"
                folder_scope_values = tuple(folder_scope)
            elif section == "events" and event_id is not None:
                folder_scope_sql = " AND event_id = %s"
                file_scope_sql = " AND event_id = %s"
                folder_scope_values = (event_id,)
            else:
                folder_scope_sql = ""
                file_scope_sql = ""
                folder_scope_values = ()
            cursor.execute(
                "SELECT id, name, parent_id, "
                + ("deleted_at, deleted_at AS created_at, " if deleted else "created_at, ")
                + "accessed_at, is_starred, share_token, is_share_link_enabled FROM folders "
                f"WHERE user_id = %s AND is_deleted = %s AND name LIKE %s{folder_scope_sql} ORDER BY name",
                (session["user_id"], deleted, search_term, *folder_scope_values),
            )
            folders = cursor.fetchall()
            cursor.execute(
                "SELECT id, original_filename, folder_id, file_size, mime_type, "
                + ("deleted_at, deleted_at AS uploaded_at, " if deleted else "uploaded_at, ")
                + "accessed_at, is_starred, share_token, is_share_link_enabled FROM files "
                f"WHERE user_id = %s AND is_deleted = %s AND original_filename LIKE %s{file_scope_sql} ORDER BY uploaded_at DESC",
                (session["user_id"], deleted, search_term, *folder_scope_values),
            )
            files = cursor.fetchall()
            if section == "trash":
                cursor.execute(
                    "SELECT id, name, event_date, event_type, share_token, is_share_link_enabled, deleted_at, created_at, is_starred FROM events "
                    "WHERE user_id = %s AND is_deleted = TRUE AND name LIKE %s ORDER BY deleted_at DESC",
                    (session["user_id"], search_term),
                )
                events = cursor.fetchall()
        elif section == "starred":
            where = "user_id = %s AND is_deleted = FALSE AND is_starred = TRUE"
            values = (session["user_id"],)
        elif section == "recent":
            where = "user_id = %s AND is_deleted = FALSE"
            values = (session["user_id"],)
        elif section == "trash":
            where = "user_id = %s AND is_deleted = TRUE"
            values = (session["user_id"],)
            cursor.execute(
                "SELECT id, name, event_date, event_type, share_token, is_share_link_enabled, deleted_at, created_at, is_starred FROM events "
                "WHERE user_id = %s AND is_deleted = TRUE ORDER BY deleted_at DESC",
                (session["user_id"],),
            )
            events = cursor.fetchall()
        elif is_event_date_workspace:
            where = "user_id = %s AND is_deleted = FALSE AND 1 = 0"
            values = (session["user_id"],)
        elif section == "events":
            where = "user_id = %s AND is_deleted = FALSE AND event_id = %s AND parent_id <=> %s"
            values = (session["user_id"], event_id, folder_id)
        else:
            where = "user_id = %s AND is_deleted = FALSE AND parent_id <=> %s"
            values = (session["user_id"], folder_id)
        if not search_query and not (section == "events" and event_id is None) and not is_event_date_workspace:
            folder_date = "deleted_at, deleted_at AS created_at" if deleted else "COALESCE(accessed_at, created_at) AS created_at" if section == "recent" else "created_at"
            cursor.execute(f"SELECT id, name, parent_id, share_token, is_share_link_enabled, {folder_date}, accessed_at, is_starred FROM folders WHERE {where} ORDER BY created_at DESC", values)
            folders = cursor.fetchall()
        sizes = folder_sizes(cursor, [folder["id"] for folder in folders], include_deleted=deleted)
        for folder in folders:
            folder["size"] = sizes.get(folder["id"], 0)
        if not search_query and not (section == "events" and event_id is None) and not is_event_date_workspace:
            file_where = where.replace("parent_id", "folder_id")
            file_date = "deleted_at, deleted_at AS uploaded_at" if deleted else "COALESCE(accessed_at, uploaded_at) AS uploaded_at" if section == "recent" else "uploaded_at"
            cursor.execute(f"SELECT id, original_filename, folder_id, file_size, mime_type, share_token, is_share_link_enabled, {file_date}, accessed_at, is_starred FROM files WHERE {file_where} ORDER BY uploaded_at DESC", values)
            files = cursor.fetchall()
        cursor.execute("SELECT id, name FROM folders WHERE user_id = %s AND is_deleted = FALSE ORDER BY name", (session["user_id"],))
        move_folders = cursor.fetchall()
        cursor.execute("SELECT id, name, event_date, event_type FROM events WHERE user_id = %s AND is_deleted = FALSE ORDER BY event_date, name", (session["user_id"],))
        sidebar_events = cursor.fetchall()
        cursor.execute("SELECT id, name, parent_id FROM folders WHERE user_id = %s", (session["user_id"],))
        paths = folder_paths(cursor.fetchall())
        cursor.close()
        items = ([{"kind": "folder", "name": item["name"], "date": item["created_at"], "mime_type": "Folder", "location": paths.get(item["parent_id"], "Library"), **item} for item in folders] +
                 [{"kind": "file", "name": item["original_filename"], "parent_id": item["folder_id"], "date": item["uploaded_at"], "location": paths.get(item["folder_id"], "Library"), **item} for item in files] +
                 [{"kind": "event", "parent_id": None, "size": 0, "file_size": 0, "mime_type": "Event", "location": "Events", **item, "date": item["deleted_at"] if deleted else item["event_date"]} for item in (events if (section == "events" and event_id is None and not search_query and not is_event_date_workspace) or section == "trash" else [])])
        for item in items:
            location_folder_id = item["parent_id"]
            if deleted:
                item["location_url"] = ""
                item["location_is_current"] = True
            elif location_folder_id is None:
                item["location_url"] = url_for("dashboard", section="events") if section == "events" else url_for("dashboard")
                item["location_is_current"] = section == "events" or (section == "files" and folder_id is None)
            else:
                item["location_url"] = url_for("dashboard", folder=location_folder_id)
                item["location_is_current"] = section == "files" and folder_id == location_folder_id
        calendar_context = build_events_calendar_context(calendar_year, calendar_month, dashboard_url_with_updates)
        page_title = "My Files"
        if current_event:
            page_title = display_name(current_event["name"])
        elif section == "events":
            page_title = "Events"
        elif section == "recent":
            page_title = "Recent"
        elif section == "starred":
            page_title = "Starred"
        elif section == "trash":
            page_title = "Trash"

        return render_template(
            "dashboard.html",
            page_title=page_title,
            items=items,
            total_storage=total_storage,
            total_files=len(date_workspace_events) if is_event_date_workspace and not search_query else len(items),
            section=section,
            current_folder=current_folder,
            breadcrumbs=breadcrumbs,
            folder_id=folder_id,
            event_id=event_id,
            current_event=current_event,
            selected_event_date=selected_event_date,
            selected_event_date_iso=selected_event_date.isoformat() if selected_event_date else "",
            is_event_date_workspace=is_event_date_workspace,
            date_workspace_events=date_workspace_events,
            is_trash=deleted,
            move_folders=move_folders,
            sidebar_events=sidebar_events,
            search_query=search_query,
            calendar_auto_open=request.args.get("calendar") == "open",
            is_global_search=bool(search_query),
            is_shared_workspace=False,
            workspace_can_edit=True,
            workspace_can_manage_sharing=True,
            share_context=None,
            is_shared_listing=False,
            **calendar_context,
        )
    except MySQLError:
        app.logger.exception("Dashboard database error")
        flash("Could not load your files. Please try again.", "error")
        return render_template(
            "dashboard.html",
            page_title="My files",
            items=[],
            total_storage=0,
            total_files=0,
            section="files",
            current_folder=None,
            breadcrumbs=[],
            folder_id=None,
            event_id=None,
            current_event=None,
            selected_event_date=None,
            selected_event_date_iso="",
            is_event_date_workspace=False,
            date_workspace_events=[],
            is_trash=False,
            move_folders=[],
            sidebar_events=[],
            search_query="",
            calendar_auto_open=False,
            is_global_search=False,
            is_shared_workspace=False,
            workspace_can_edit=True,
            workspace_can_manage_sharing=True,
            share_context=None,
            is_shared_listing=False,
            month_name=calendar_module.month_name[calendar_month],
            year=calendar_year,
            month=calendar_month,
            weeks=sunday_first_month_weeks(calendar_year, calendar_month),
            events_by_day={},
            calendar_previous_url=url_for("dashboard", calendar="open", calendar_year=shift_calendar_month(calendar_year, calendar_month, -1)[0], calendar_month=shift_calendar_month(calendar_year, calendar_month, -1)[1]),
            calendar_next_url=url_for("dashboard", calendar="open", calendar_year=shift_calendar_month(calendar_year, calendar_month, 1)[0], calendar_month=shift_calendar_month(calendar_year, calendar_month, 1)[1]),
            calendar_day_urls={},
        )


def public_dashboard():
    """Render only resources whose owner explicitly enabled a share link."""
    cursor = get_db().cursor(dictionary=True)
    try:
        cursor.execute(
            "SELECT id, name, share_token, created_at FROM folders "
            "WHERE is_deleted = FALSE AND is_share_link_enabled = TRUE AND share_permission = 'public' AND share_token IS NOT NULL ORDER BY created_at DESC"
        )
        folders = cursor.fetchall()
        cursor.execute(
            "SELECT id, original_filename, file_size, mime_type, share_token, uploaded_at FROM files "
            "WHERE is_deleted = FALSE AND is_share_link_enabled = TRUE AND share_permission = 'public' AND share_token IS NOT NULL ORDER BY uploaded_at DESC"
        )
        files = cursor.fetchall()
        cursor.execute(
            "SELECT id, name, event_date, event_type, share_token, created_at FROM events "
            "WHERE is_deleted = FALSE AND is_share_link_enabled = TRUE AND share_permission = 'public' AND share_token IS NOT NULL ORDER BY event_date, name"
        )
        events = cursor.fetchall()
    except MySQLError:
        app.logger.exception("Public workspace database error")
        abort(500)
    finally:
        cursor.close()

    items = (
        [{"kind": "folder", "name": item["name"], "parent_id": None, "size": 0, "file_size": 0,
          "mime_type": "Folder", "location": "Public Files", "date": item["created_at"], "accessed_at": None,
          "is_starred": False, "is_share_link_enabled": True, **item} for item in folders]
        + [{"kind": "file", "name": item["original_filename"], "parent_id": None, "folder_id": None,
            "location": "Public Files", "date": item["uploaded_at"], "accessed_at": None, "is_starred": False,
            "is_share_link_enabled": True, **item} for item in files]
        + [{"kind": "event", "name": item["name"], "parent_id": None, "size": 0, "file_size": 0,
            "mime_type": "Event", "location": "Public Files", "date": item["event_date"], "accessed_at": None,
            "is_starred": False, "is_share_link_enabled": True, **item} for item in events]
    )
    return render_template(
        "dashboard.html", page_title="Public Files", items=items, total_storage=0, total_files=len(items),
        section="files", current_folder=None, breadcrumbs=[], folder_id=None, event_id=None, current_event=None,
        selected_event_date=None, selected_event_date_iso="", is_event_date_workspace=False,
        date_workspace_events=[], is_trash=False, move_folders=[], sidebar_events=[], search_query="",
        calendar_auto_open=False, is_global_search=False, is_shared_workspace=False, is_public_workspace=True,
        workspace_can_edit=False, workspace_can_manage_sharing=False, share_context=None,
        is_shared_listing=False,
        month_name=calendar_module.month_name[date.today().month], year=date.today().year, month=date.today().month,
        weeks=sunday_first_month_weeks(date.today().year, date.today().month), events_by_day={}, calendar_day_urls={},
        calendar_previous_url="", calendar_next_url="", show_calendar_back_link=False,
    )


@app.get("/events/calendar")
@login_required
def events_calendar():
    calendar_year, calendar_month = normalized_calendar_month(request.args.get("calendar_year"), request.args.get("calendar_month"))
    def calendar_url_with_updates(**updates):
        params = dict(request.args.items())
        for key, value in updates.items():
            if value in (None, ""):
                params.pop(key, None)
            else:
                params[key] = str(value)
        return url_for("events_calendar", **params)
    calendar_context = build_events_calendar_context(calendar_year, calendar_month, calendar_url_with_updates)
    calendar_context["calendar_day_urls"] = {
        day: url_for(
            "dashboard",
            section="events",
            event_date=date(calendar_year, calendar_month, day).isoformat(),
            calendar_year=calendar_year,
            calendar_month=calendar_month,
        )
        for day in calendar_context["calendar_day_urls"]
    }
    return render_template("events_calendar.html", **calendar_context)


@app.post("/upload")
@login_required
def upload():
    share_context = request_share_context()
    raw_folder_id = request.form.get("folder_id")
    if share_context:
        if raw_folder_id in (None, "", "root"):
            folder_id = None
        elif not str(raw_folder_id).isdigit():
            abort(400)
        else:
            folder_id = int(raw_folder_id)
        target_folder = accessible_folder(folder_id, required="editor", share_context=share_context) if folder_id else None
        if raw_folder_id not in (None, "", "root") and not target_folder:
            abort(404)
        upload_owner_id = share_context["owner_id"]
    else:
        folder_id = valid_destination(raw_folder_id)
        upload_owner_id = session["user_id"]
    incoming_files = request.files.getlist("file")
    folder_paths = request.form.getlist("folder_path")
    valid_files = [item for item in incoming_files if item and item.filename]
    if not valid_files:
        flash("Select a file to upload.", "error")
        if request.headers.get("X-Requested-With") == "XMLHttpRequest":
            return jsonify({"ok": False, "results": [{"name": "", "status": "error", "message": "Select a file to upload."}]})
        return redirect_to_workspace(url_for("dashboard", folder=folder_id) if folder_id else url_for("dashboard"))

    user_folder = user_directory(upload_owner_id)
    user_folder.mkdir(parents=True, exist_ok=True)

    uploaded = 0
    results = []
    folder_cache = {}

    def upload_target_folder(relative_path):
        if not relative_path:
            return folder_id
        parts = [part for part in relative_path.replace("\\", "/").split("/") if part]
        if len(parts) < 2:
            return folder_id

        parent_id = folder_id
        path_parts = []
        for part in parts[:-1]:
            safe_part = secure_filename(part).strip("._")
            if not safe_part or safe_part in {".", ".."}:
                raise ValueError("The selected folder path is invalid.")
            path_parts.append(safe_part)
            cache_key = (parent_id, *path_parts)
            if cache_key not in folder_cache:
                cursor = get_db().cursor()
                try:
                    cursor.execute(
                        "INSERT INTO folders (user_id, parent_id, name) VALUES (%s, %s, %s)",
                        (upload_owner_id, parent_id, safe_part),
                    )
                    folder_cache[cache_key] = cursor.lastrowid
                    get_db().commit()
                except MySQLError:
                    get_db().rollback()
                    raise
                finally:
                    cursor.close()
            parent_id = folder_cache[cache_key]
        return parent_id

    for index, incoming in enumerate(incoming_files):
        if incoming is None or not incoming.filename:
            results.append({"name": "", "status": "error", "message": "No file selected."})
            continue

        original_name = secure_filename(incoming.filename)
        if not original_name:
            results.append({"name": incoming.filename, "status": "error", "message": "The selected filename is invalid."})
            continue

        incoming.stream.seek(0, os.SEEK_END)
        file_size = incoming.stream.tell()
        incoming.stream.seek(0)
        if file_size <= 0:
            results.append({"name": original_name, "status": "error", "message": "Empty files cannot be uploaded."})
            continue
        if file_size > app.config["MAX_CONTENT_LENGTH"]:
            results.append({"name": original_name, "status": "error", "message": f"Files must be {MAX_FILE_SIZE_MB} MB or smaller."})
            continue

        try:
            target_folder_id = upload_target_folder(folder_paths[index] if index < len(folder_paths) else "")
        except (MySQLError, ValueError):
            app.logger.exception("Upload folder path error")
            results.append({"name": original_name, "status": "error", "message": "The folder could not be created for this upload."})
            continue

        stored_name = f"{uuid.uuid4().hex}_{original_name}"
        share_token = secrets.token_urlsafe(32)
        destination = user_folder / stored_name
        try:
            incoming.save(destination)
        except OSError:
            app.logger.exception("File save error")
            results.append({"name": original_name, "status": "error", "message": "The file could not be saved. Please try again."})
            continue

        cursor = None
        try:
            cursor = get_db().cursor()
            cursor.execute(
                "INSERT INTO files (user_id, original_filename, stored_filename, file_size, mime_type, share_token, folder_id) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (upload_owner_id, original_name, stored_name, file_size, incoming.mimetype or "application/octet-stream", share_token, target_folder_id),
            )
            get_db().commit()
            uploaded += 1
            results.append({"name": original_name, "status": "success", "message": "File uploaded successfully."})
        except MySQLError:
            get_db().rollback()
            app.logger.exception("Upload metadata database error")
            try:
                destination.unlink(missing_ok=True)
            except OSError:
                app.logger.exception("Could not remove orphaned upload")
            results.append({"name": original_name, "status": "error", "message": "The upload could not be completed. Please try again."})
        finally:
            if cursor:
                cursor.close()

    if uploaded:
        flash(f"{uploaded} file(s) uploaded successfully.", "success")
    else:
        flash("No valid files were uploaded.", "error")

    if request.headers.get("X-Requested-With") == "XMLHttpRequest":
        return jsonify({"ok": uploaded > 0, "uploaded": uploaded, "results": results})
    return redirect_to_workspace(url_for("dashboard", folder=folder_id) if folder_id else url_for("dashboard"))


@app.get("/download/<int:file_id>")
@login_or_public_share_required
def download(file_id):
    share_context = request_share_context()
    try:
        record = accessible_file(file_id, share_context=share_context)
    except MySQLError:
        app.logger.exception("Download database error")
        abort(500)
    if not record:
        abort(404)
    directory = user_directory(record["user_id"])
    path = record_path(record)
    if not path.is_file():
        flash("This file is no longer available on the server.", "error")
        return redirect(workspace_return_url())
    return send_from_directory(directory, record["stored_filename"], as_attachment=True, download_name=record["original_filename"])


@app.get("/download/folder/<int:folder_id>")
@login_or_public_share_required
def download_folder(folder_id):
    share_context = request_share_context()
    try:
        folder = accessible_folder(folder_id, share_context=share_context)
        if not folder:
            abort(404)

        folder_ids = [folder_id, *folder_descendants(folder_id, owner_id=folder["user_id"])]
        placeholders = ",".join(["%s"] * len(folder_ids))
        cursor = get_db().cursor(dictionary=True)
        try:
            cursor.execute(
                f"SELECT id, parent_id, name FROM folders WHERE user_id = %s AND is_deleted = FALSE AND id IN ({placeholders})",
                (folder["user_id"], *folder_ids),
            )
            folders = cursor.fetchall()
            cursor.execute(
                f"SELECT stored_filename, original_filename, folder_id FROM files WHERE user_id = %s AND is_deleted = FALSE AND folder_id IN ({placeholders})",
                (folder["user_id"], *folder_ids),
            )
            files = cursor.fetchall()
        finally:
            cursor.close()

        relative_paths = {folder_id: folder["name"]}
        pending = [folder_id]
        while pending:
            parent_id = pending.pop()
            for child in folders:
                if child["parent_id"] == parent_id:
                    relative_paths[child["id"]] = f"{relative_paths[parent_id]}/{child['name']}"
                    pending.append(child["id"])

        archive = BytesIO()
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            for item in folders:
                bundle.writestr(f"{relative_paths[item['id']]}/", "")
            owner_directory = user_directory(folder["user_id"])
            for item in files:
                path = owner_directory / item["stored_filename"]
                if path.is_file() and item["folder_id"] in relative_paths:
                    bundle.write(path, arcname=f"{relative_paths[item['folder_id']]}/{item['original_filename']}")

        archive.seek(0)
        return send_file(
            archive,
            as_attachment=True,
            download_name=f"{folder['name']}.zip",
            mimetype="application/zip",
        )
    except MySQLError:
        app.logger.exception("Folder download database error")
        abort(500)


@app.get("/download/event/<int:event_id>")
@login_or_public_share_required
def download_event(event_id):
    share_context = request_share_context()
    event = accessible_event(event_id, share_context=share_context)
    if not event:
        abort(404)
    archive = BytesIO()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        write_event_archive(bundle, event)
    archive.seek(0)
    return send_file(
        archive,
        as_attachment=True,
        download_name=f"{event['name']}.zip",
        mimetype="application/zip",
    )


@app.get("/offline-manifest/<kind>/<int:item_id>")
@login_or_public_share_required
def offline_manifest(kind, item_id):
    if kind not in {"file", "folder", "event"}:
        abort(404)

    share_context = request_share_context()
    context_params = {}
    if share_context:
        context_params = {
            "share_context_kind": share_context["kind"],
            "share_context_token": share_context["token"],
        }

    files = []
    folders = []
    root = None
    if kind == "file":
        root = accessible_file(item_id, share_context=share_context)
        if root:
            files = [root]
    elif kind == "folder":
        root = accessible_folder(item_id, share_context=share_context)
        if root:
            folder_ids = [item_id, *folder_descendants(item_id, owner_id=root["user_id"])]
            placeholders = ",".join(["%s"] * len(folder_ids))
            cursor = get_db().cursor(dictionary=True)
            try:
                cursor.execute(
                    f"SELECT id, parent_id, name FROM folders WHERE user_id = %s AND is_deleted = FALSE AND id IN ({placeholders})",
                    (root["user_id"], *folder_ids),
                )
                folders = cursor.fetchall()
                cursor.execute(
                    f"SELECT * FROM files WHERE user_id = %s AND is_deleted = FALSE AND folder_id IN ({placeholders})",
                    (root["user_id"], *folder_ids),
                )
                files = cursor.fetchall()
            finally:
                cursor.close()
    else:
        root = accessible_event(item_id, share_context=share_context)
        if root:
            cursor = get_db().cursor(dictionary=True)
            try:
                cursor.execute(
                    "SELECT id, parent_id, name FROM folders WHERE user_id = %s AND event_id = %s AND is_deleted = FALSE",
                    (root["user_id"], item_id),
                )
                folders = cursor.fetchall()
                cursor.execute(
                    "SELECT * FROM files WHERE user_id = %s AND event_id = %s AND is_deleted = FALSE",
                    (root["user_id"], item_id),
                )
                files = cursor.fetchall()
            finally:
                cursor.close()

    if not root:
        abort(404)

    urls = [
        url_for("static", filename="css/style.css"),
        url_for("static", filename="js/app.js"),
        url_for("static", filename="images/JF.ico"),
        url_for("static", filename="images/JF.png"),
        url_for("static", filename="images/ss.png"),
    ]
    if folders:
        urls.append(url_for("static", filename="images/Folder.png"))
    urls.extend(url_for("static", filename=f"images/{file_type_icon(file_record)}") for file_record in files)
    if kind == "event":
        urls.append(url_for("static", filename=f"images/{event_icon_file(root.get('event_type'))}"))

    root_open_url = ""
    if kind == "file":
        root_open_url = url_for("preview", file_id=item_id, **context_params)
        urls.append(root_open_url)
    elif kind == "folder":
        if share_context and share_context["kind"] == "event":
            root_open_url = url_for("shared_event", share_token=share_context["token"], folder=item_id)
            urls.append(root_open_url)
            urls.extend(url_for("shared_event", share_token=share_context["token"], folder=folder["id"]) for folder in folders if folder["id"] != item_id)
        elif share_context:
            root_open_url = url_for("shared_folder", share_token=share_context["token"])
            urls.append(root_open_url)
            urls.extend(url_for("shared_folder", share_token=share_context["token"], folder=folder["id"]) for folder in folders if folder["id"] != item_id)
        else:
            root_open_url = url_for("dashboard", folder=item_id)
            urls.append(root_open_url)
            urls.extend(url_for("dashboard", folder=folder["id"]) for folder in folders if folder["id"] != item_id)
    else:
        if share_context:
            root_open_url = url_for("shared_event", share_token=share_context["token"])
            urls.append(root_open_url)
            urls.extend(url_for("shared_event", share_token=share_context["token"], folder=folder["id"]) for folder in folders)
        else:
            root_open_url = url_for("dashboard", section="events", event=item_id)
            urls.append(root_open_url)
            urls.extend(url_for("dashboard", section="events", event=item_id, folder=folder["id"]) for folder in folders)

    for file_record in files:
        file_id = file_record["id"]
        urls.extend([
            url_for("preview", file_id=file_id, **context_params),
            url_for("preview_content", file_id=file_id, **context_params),
            url_for("download", file_id=file_id, **context_params),
        ])

    preview_kinds = {preview_kind(file_record) for file_record in files}
    if "powerpoint" in preview_kinds:
        urls.extend([
            "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js",
            "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js",
            "https://cdn.jsdelivr.net/npm/pptxviewjs/dist/PptxViewJS.min.js",
        ])
    if "spreadsheet" in preview_kinds:
        urls.append("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js")

    return jsonify({
        "ok": True,
        "item": {
            "kind": kind,
            "id": item_id,
            "name": root.get("original_filename") if kind == "file" else root.get("name"),
        },
        "open_url": root_open_url,
        "file_count": len(files),
        "urls": list(dict.fromkeys(urls)),
    })


@app.get("/service-worker.js")
def service_worker():
    response = send_from_directory(app.static_folder, "js/service-worker.js", mimetype="application/javascript")
    response.headers["Service-Worker-Allowed"] = "/"
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/preview/<int:file_id>")
def preview(file_id):
    share_context = request_share_context()
    try:
        record = accessible_file(file_id, share_context=share_context)
    except MySQLError:
        app.logger.exception("Preview database error")
        abort(500)
    if not record:
        abort(404)
    is_public_workspace = "user_id" not in session
    if not is_public_workspace:
        cursor = get_db().cursor()
        try:
            cursor.execute("UPDATE files SET accessed_at = NOW() WHERE id = %s AND user_id = %s", (file_id, record["user_id"]))
            get_db().commit()
        finally:
            cursor.close()
    cursor = get_db().cursor(dictionary=True)
    try:
        cursor.execute("SELECT id, name FROM folders WHERE user_id = %s AND is_deleted = FALSE ORDER BY name", (record["user_id"],))
        move_folders = cursor.fetchall()
    finally:
        cursor.close()
    return render_template(
        "preview.html",
        file=record,
        preview_kind=preview_kind(record),
        move_folders=move_folders,
        workspace_return_url=workspace_return_url(),
        file_location="Public Files" if is_public_workspace else file_location(record),
        workspace_can_edit=not is_public_workspace and permission_at_least(record["access_permission"], "editor"),
        workspace_can_manage_sharing=not is_public_workspace and record["access_permission"] == "owner",
        is_public_workspace=is_public_workspace,
        share_context=share_context,
    )


@app.get("/file/<share_token>")
def token_preview(share_token):
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,64}", share_token):
        abort(404)
    try:
        share_context = share_context_from_token("file", share_token)
        record = accessible_file(share_context["item_id"], share_context=share_context) if share_context else None
    except MySQLError:
        app.logger.exception("Token preview database error")
        abort(500)
    if not record:
        abort(404)
    is_public_workspace = "user_id" not in session
    move_folders = []
    if not is_public_workspace:
        cursor = get_db().cursor(dictionary=True)
        try:
            cursor.execute("SELECT id, name FROM folders WHERE user_id = %s AND is_deleted = FALSE ORDER BY name", (record["user_id"],))
            move_folders = cursor.fetchall()
        finally:
            cursor.close()
    return render_template(
        "preview.html",
        file=record,
        preview_kind=preview_kind(record),
        move_folders=move_folders,
        workspace_return_url=workspace_return_url(),
        file_location="Public Files" if is_public_workspace else file_location(record),
        workspace_can_edit=not is_public_workspace and permission_at_least(record["access_permission"], "editor"),
        workspace_can_manage_sharing=not is_public_workspace and record["access_permission"] == "owner",
        is_public_workspace=is_public_workspace,
        share_context=share_context,
    )


@app.get("/preview-content/<int:file_id>")
def preview_content(file_id):
    share_context = request_share_context()
    try:
        record = accessible_file(file_id, share_context=share_context)
    except MySQLError:
        app.logger.exception("Preview content database error")
        abort(500)
    if not record:
        abort(404)
    path = record_path(record)
    if not path.is_file():
        abort(404)
    response = send_from_directory(
        user_directory(record["user_id"]),
        record["stored_filename"],
        as_attachment=False,
        mimetype=record["mime_type"],
        download_name=record["original_filename"],
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Content-Security-Policy"] = "sandbox"
    return response


@app.get("/view/<int:file_id>")
@login_required
def view_file(file_id):
    share_context = request_share_context()
    try:
        record = accessible_file(file_id, share_context=share_context)
    except MySQLError:
        app.logger.exception("File view database error")
        abort(500)
    if not record:
        abort(404)
    directory = user_directory(record["user_id"])
    path = directory / record["stored_filename"]
    if not path.is_file():
        flash("This file is no longer available on the server.", "error")
        return redirect(url_for("dashboard"))
    return send_from_directory(directory, record["stored_filename"], as_attachment=False, download_name=record["original_filename"])


@app.post("/delete/<int:file_id>")
@login_required
def delete(file_id):
    try:
        record = owned_file(file_id)
        if not record:
            flash("File not found or access denied.", "error")
            return redirect_to_workspace()
        cursor = get_db().cursor()
        cursor.execute("UPDATE files SET original_folder_id = folder_id, is_deleted = TRUE, deleted_at = NOW() WHERE id = %s AND user_id = %s", (file_id, session["user_id"]))
        get_db().commit()
        cursor.close()
        flash("File moved to Trash.", "danger")
    except MySQLError:
        get_db().rollback()
        app.logger.exception("File deletion error")
        flash("The file could not be moved to Trash. Please try again.", "error")
    return redirect_to_workspace()


@app.post("/folders")
@login_required
def create_folder():
    name = secure_filename(request.form.get("name", "")).strip("._")
    parent_id = valid_destination(request.form.get("parent_id"))
    if not name:
        flash("Enter a valid folder name.", "error")
    else:
        cursor = get_db().cursor()
        try:
            cursor.execute("INSERT INTO folders (user_id, parent_id, name) VALUES (%s, %s, %s)", (session["user_id"], parent_id, name))
            get_db().commit()
            flash("Folder created.", "success")
        except MySQLError:
            get_db().rollback()
            flash("The folder could not be created.", "error")
        finally:
            cursor.close()
    return redirect_to_workspace(url_for("dashboard", folder=parent_id) if parent_id else url_for("dashboard"))


@app.post("/events")
@login_required
def create_event():
    name = secure_filename(request.form.get("name", "")).strip("._")
    raw_date = request.form.get("event_date", "")
    event_type = (request.form.get("event_type") or "event").strip().lower()
    try:
        event_date = date.fromisoformat(raw_date)
    except ValueError:
        event_date = None
    if event_type not in EVENT_TYPE_FILE_MAP:
        event_type = "event"
    if not name or not event_date:
        flash("Enter a valid Event name and date.", "error")
        return redirect_to_workspace(url_for("dashboard", section="events"))
    cursor = get_db().cursor()
    try:
        cursor.execute(
            "INSERT INTO events (user_id, name, event_date, event_type) VALUES (%s, %s, %s, %s)",
            (session["user_id"], name, event_date, event_type),
        )
        get_db().commit()
        flash("Event created.", "success")
    except MySQLError:
        get_db().rollback()
        app.logger.exception("Event creation error")
        flash("The Event could not be created.", "error")
    finally:
        cursor.close()
    return redirect_to_workspace(url_for("dashboard", section="events"))


@app.post("/rename")
@login_required
def rename_item():
    share_context = request_share_context()
    kind = request.form.get("kind", "")
    raw_id = request.form.get("item_id", "")
    name = request.form.get("name", "").strip()
    if kind not in {"file", "folder"} or not raw_id.isdigit() or not name:
        abort(400)
    safe_name = secure_filename(name).strip("._")
    if not safe_name:
        flash("Enter a valid name.", "error")
        return redirect_to_workspace()
    table = "files" if kind == "file" else "folders"
    column = "original_filename" if kind == "file" else "name"
    if kind == "file":
        record = accessible_file(int(raw_id), required="editor", share_context=share_context)
        if not record:
            abort(404)
        original_extension = Path(record["original_filename"]).suffix
        submitted_extension = Path(safe_name).suffix
        if submitted_extension and submitted_extension.lower() != original_extension.lower():
            flash("A file's extension cannot be changed.", "error")
            return redirect_to_workspace()
        if original_extension:
            safe_name = f"{safe_name[:-len(submitted_extension)] if submitted_extension else safe_name}{original_extension}"
    else:
        record = accessible_folder(int(raw_id), required="editor", share_context=share_context)
        if not record:
            abort(404)
    cursor = get_db().cursor()
    try:
        cursor.execute(
            f"UPDATE {table} SET {column} = %s WHERE id = %s AND user_id = %s AND is_deleted = FALSE",
            (safe_name, int(raw_id), record["user_id"]),
        )
        if cursor.rowcount != 1:
            abort(404)
        get_db().commit()
        flash("Item renamed.", "success")
    except MySQLError:
        get_db().rollback()
        app.logger.exception("Rename error")
        flash("The item could not be renamed.", "error")
    finally:
        cursor.close()
    return redirect_to_workspace()


@app.post("/events/update")
@login_required
def update_event():
    raw_id = request.form.get("item_id", "")
    name = request.form.get("name", "").strip()
    if not raw_id.isdigit() or not name:
        abort(400)
    safe_name = secure_filename(name).strip("._")
    if not safe_name:
        flash("Enter a valid Event title.", "error")
        return redirect_to_workspace(url_for("dashboard", section="events"))
    event = owned_event(int(raw_id))
    if not event:
        abort(404)
    event_type = (request.form.get("event_type") or "event").strip().lower()
    if event_type not in EVENT_TYPE_FILE_MAP:
        event_type = "event"
    cursor = get_db().cursor()
    try:
        cursor.execute(
            "UPDATE events SET name = %s, event_type = %s WHERE id = %s AND user_id = %s AND is_deleted = FALSE",
            (safe_name, event_type, int(raw_id), session["user_id"]),
        )
        if cursor.rowcount != 1:
            abort(404)
        get_db().commit()
        flash("Event updated.", "success")
    except MySQLError:
        get_db().rollback()
        app.logger.exception("Event update error")
        flash("The Event could not be updated.", "error")
    finally:
        cursor.close()
    return redirect_to_workspace()


@app.post("/items/star")
@login_required
def star_items():
    selected = request.form.getlist("items")
    starred = request.form.get("starred") == "true"
    for item in selected:
        kind, _, raw_id = item.partition(":")
        if kind not in {"file", "folder", "event"} or not raw_id.isdigit():
            abort(400)
        table = "files" if kind == "file" else "folders" if kind == "folder" else "events"
        cursor = get_db().cursor()
        try:
            cursor.execute(f"UPDATE {table} SET is_starred = %s WHERE id = %s AND user_id = %s AND is_deleted = FALSE", (starred, int(raw_id), session["user_id"]))
            get_db().commit()
        finally:
            cursor.close()
    if request.headers.get("X-Requested-With") == "XMLHttpRequest":
        return jsonify({"ok": True})
    flash("Items added to Starred." if starred else "Items removed from Starred.", "success")
    return redirect_to_workspace()


@app.post("/items/move")
@login_required
def move_items():
    share_context = request_share_context()
    raw_destination = request.form.get("destination_id")
    if share_context:
        if raw_destination in (None, "", "root"):
            destination = None
        elif not str(raw_destination).isdigit():
            abort(400)
        else:
            destination_folder = accessible_folder(int(raw_destination), required="editor", share_context=share_context)
            if not destination_folder:
                abort(404)
            destination = destination_folder["id"]
    else:
        destination = valid_destination(raw_destination)
    for item in request.form.getlist("items"):
        kind, _, raw_id = item.partition(":")
        if kind not in {"file", "folder"} or not raw_id.isdigit():
            abort(400)
        item_id = int(raw_id)
        if kind == "folder":
            folder = accessible_folder(item_id, required="editor", share_context=share_context)
            if not folder or destination == item_id or (destination and destination in folder_descendants(item_id, owner_id=folder["user_id"])):
                abort(400)
            query = "UPDATE folders SET parent_id = %s WHERE id = %s AND user_id = %s AND is_deleted = FALSE"
        else:
            file_record = accessible_file(item_id, required="editor", share_context=share_context)
            if not file_record:
                abort(404)
            query = "UPDATE files SET folder_id = %s WHERE id = %s AND user_id = %s AND is_deleted = FALSE"
        cursor = get_db().cursor()
        try:
            owner_id = folder["user_id"] if kind == "folder" else file_record["user_id"]
            cursor.execute(query, (destination, item_id, owner_id))
            get_db().commit()
        finally:
            cursor.close()
    flash("Items moved to the selected folder.", "success")
    return redirect_to_workspace()


def selected_items_from_form(include_deleted=False):
    selected = []
    for item in request.form.getlist("items"):
        kind, _, raw_id = item.partition(":")
        if kind not in {"file", "folder", "event"} or not raw_id.isdigit():
            abort(400)
        table = "files" if kind == "file" else "folders" if kind == "folder" else "events"
        deleted_condition = "" if include_deleted else " AND is_deleted = FALSE"
        record = query_one(f"SELECT * FROM {table} WHERE id = %s AND user_id = %s{deleted_condition}", (int(raw_id), session["user_id"]))
        if not record:
            abort(404)
        selected.append((kind, int(raw_id), record))
    return selected


@app.post("/items/trash")
@login_required
def trash_items():
    for kind, item_id, _record in selected_items_from_form():
        cursor = get_db().cursor()
        try:
            if kind == "event":
                cursor.execute("UPDATE events SET is_deleted = TRUE, deleted_at = NOW() WHERE id = %s AND user_id = %s", (item_id, session["user_id"]))
                cursor.execute(
                    "UPDATE folders SET original_parent_id = parent_id, is_deleted = TRUE, deleted_at = NOW() "
                    "WHERE user_id = %s AND event_id = %s AND is_deleted = FALSE",
                    (session["user_id"], item_id),
                )
                cursor.execute(
                    "UPDATE files SET original_folder_id = folder_id, is_deleted = TRUE, deleted_at = NOW() "
                    "WHERE user_id = %s AND event_id = %s AND is_deleted = FALSE",
                    (session["user_id"], item_id),
                )
            else:
                table = "files" if kind == "file" else "folders"
                location_column = "folder_id" if kind == "file" else "parent_id"
                original_column = "original_folder_id" if kind == "file" else "original_parent_id"
                cursor.execute(
                    f"UPDATE {table} SET {original_column} = {location_column}, is_deleted = TRUE, deleted_at = NOW() "
                    "WHERE id = %s AND user_id = %s",
                    (item_id, session["user_id"]),
                )
            if kind == "folder":
                descendants = folder_descendants(item_id)
                if descendants:
                    placeholders = ",".join(["%s"] * len(descendants))
                    cursor.execute(f"UPDATE folders SET is_deleted = TRUE, deleted_at = NOW() WHERE user_id = %s AND id IN ({placeholders})", (session["user_id"], *descendants))
                    cursor.execute(f"UPDATE files SET is_deleted = TRUE, deleted_at = NOW() WHERE user_id = %s AND folder_id IN ({placeholders})", (session["user_id"], *descendants))
                cursor.execute("UPDATE files SET is_deleted = TRUE, deleted_at = NOW() WHERE user_id = %s AND folder_id = %s", (session["user_id"], item_id))
            get_db().commit()
        finally:
            cursor.close()
    flash("Selected items moved to Trash.", "danger")
    return redirect_to_workspace()


@app.post("/items/restore")
@login_required
def restore_items():
    for kind, item_id, record in selected_items_from_form(include_deleted=True):
        if not record["is_deleted"]:
            continue
        cursor = get_db().cursor()
        try:
            if kind == "event":
                cursor.execute("UPDATE events SET is_deleted = FALSE, deleted_at = NULL WHERE id = %s AND user_id = %s", (item_id, session["user_id"]))
                cursor.execute("UPDATE folders SET is_deleted = FALSE, deleted_at = NULL WHERE user_id = %s AND event_id = %s", (session["user_id"], item_id))
                cursor.execute("UPDATE files SET is_deleted = FALSE, deleted_at = NULL WHERE user_id = %s AND event_id = %s", (session["user_id"], item_id))
            elif kind == "folder":
                original = record.get("original_parent_id")
                target = original if original and owned_folder(original) else None
                folder_ids = [item_id, *folder_descendants(item_id, include_deleted=True)]
                placeholders = ",".join(["%s"] * len(folder_ids))
                cursor.execute("UPDATE folders SET parent_id = %s, is_deleted = FALSE, deleted_at = NULL WHERE id = %s AND user_id = %s", (target, item_id, session["user_id"]))
                cursor.execute(f"UPDATE folders SET is_deleted = FALSE, deleted_at = NULL WHERE user_id = %s AND id IN ({placeholders})", (session["user_id"], *folder_ids))
                cursor.execute(f"UPDATE files SET is_deleted = FALSE, deleted_at = NULL WHERE user_id = %s AND folder_id IN ({placeholders})", (session["user_id"], *folder_ids))
            else:
                original = record.get("original_folder_id")
                target = original if original and owned_folder(original) else None
                cursor.execute("UPDATE files SET folder_id = %s, is_deleted = FALSE, deleted_at = NULL WHERE id = %s AND user_id = %s", (target, item_id, session["user_id"]))
            get_db().commit()
        finally:
            cursor.close()
    flash("Selected items restored from Trash.", "success")
    return redirect_to_workspace(url_for("dashboard", section="trash"))


@app.post("/items/permanent-delete")
@login_required
def permanent_delete_items():
    for kind, item_id, record in selected_items_from_form(include_deleted=True):
        if not record["is_deleted"]:
            abort(400)
        cursor = get_db().cursor(dictionary=True)
        try:
            if kind == "event":
                permanently_delete_event_record(cursor, record)
            elif kind == "folder":
                permanently_delete_folder_record(cursor, record)
            else:
                permanently_delete_file_record(cursor, record)
            get_db().commit()
        finally:
            cursor.close()
    flash("Selected items permanently deleted.", "danger")
    return redirect_to_workspace(url_for("dashboard", section="trash"))


@app.post("/trash/empty")
@login_required
def empty_trash():
    cursor = get_db().cursor(dictionary=True)
    try:
        cursor.execute("SELECT id, user_id, name FROM events WHERE user_id = %s AND is_deleted = TRUE", (session["user_id"],))
        for event in cursor.fetchall():
            permanently_delete_event_record(cursor, event)
        cursor.execute("SELECT id, user_id, name FROM folders WHERE user_id = %s AND is_deleted = TRUE ORDER BY id", (session["user_id"],))
        deleted_folder_ids = set()
        for folder in cursor.fetchall():
            if folder["id"] in deleted_folder_ids:
                continue
            subtree_ids = [folder["id"], *folder_descendants(folder["id"], owner_id=session["user_id"], include_deleted=True)]
            permanently_delete_folder_record(cursor, folder)
            deleted_folder_ids.update(subtree_ids)
        cursor.execute("SELECT id, user_id, stored_filename FROM files WHERE user_id = %s AND is_deleted = TRUE", (session["user_id"],))
        for record in cursor.fetchall():
            permanently_delete_file_record(cursor, record)
        get_db().commit()
    except (MySQLError, OSError):
        get_db().rollback()
        app.logger.exception("Empty Trash error")
        flash("Trash could not be emptied. Please try again.", "error")
        return redirect(url_for("dashboard", section="trash"))
    finally:
        cursor.close()
    flash("Trash emptied.", "danger")
    return redirect(url_for("dashboard", section="trash"))


@app.post("/items/download")
@login_required
def bulk_download():
    selected = selected_items_from_form()
    if not selected:
        abort(400)
    if len(selected) == 1 and selected[0][0] == "file":
        return redirect(url_for("download", file_id=selected[0][1]))
    if len(selected) == 1 and selected[0][0] == "event":
        return redirect(url_for("download_event", event_id=selected[0][1]))

    archive = BytesIO()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        user_directory = UPLOAD_FOLDER / str(session["user_id"])
        written_paths = set()

        def unique_archive_path(path):
            candidate = path
            counter = 2
            while candidate in written_paths:
                stem, suffix = os.path.splitext(path)
                candidate = f"{stem} ({counter}){suffix}"
                counter += 1
            written_paths.add(candidate)
            return candidate

        for kind, _item_id, record in selected:
            if kind != "file":
                continue
            path = UPLOAD_FOLDER / str(session["user_id"]) / record["stored_filename"]
            if path.is_file():
                bundle.write(path, arcname=unique_archive_path(record["original_filename"]))

        for kind, _event_id, event in selected:
            if kind != "event":
                continue
            write_event_archive(bundle, event, written_paths)

        for kind, folder_id, folder in selected:
            if kind != "folder":
                continue
            folder_ids = [folder_id, *folder_descendants(folder_id, owner_id=folder["user_id"])]
            placeholders = ",".join(["%s"] * len(folder_ids))
            cursor = get_db().cursor(dictionary=True)
            try:
                cursor.execute(
                    f"SELECT id, parent_id, name FROM folders WHERE user_id = %s AND is_deleted = FALSE AND id IN ({placeholders})",
                    (session["user_id"], *folder_ids),
                )
                folders = cursor.fetchall()
                cursor.execute(
                    f"SELECT stored_filename, original_filename, folder_id FROM files WHERE user_id = %s AND is_deleted = FALSE AND folder_id IN ({placeholders})",
                    (session["user_id"], *folder_ids),
                )
                files = cursor.fetchall()
            finally:
                cursor.close()

            relative_paths = {folder_id: folder["name"]}
            pending = [folder_id]
            while pending:
                parent_id = pending.pop()
                for child in folders:
                    if child["parent_id"] == parent_id:
                        relative_paths[child["id"]] = f"{relative_paths[parent_id]}/{child['name']}"
                        pending.append(child["id"])

            for item in folders:
                if item["id"] in relative_paths:
                    directory_path = f"{relative_paths[item['id']]}/"
                    if directory_path not in written_paths:
                        written_paths.add(directory_path)
                        bundle.writestr(directory_path, "")
            for item in files:
                path = user_directory / item["stored_filename"]
                if path.is_file() and item["folder_id"] in relative_paths:
                    archive_path = f"{relative_paths[item['folder_id']]}/{item['original_filename']}"
                    bundle.write(path, arcname=unique_archive_path(archive_path))
    archive.seek(0)
    return send_file(archive, as_attachment=True, download_name="jfcmpila-files.zip", mimetype="application/zip")


def ensure_item_share_token(kind, item_id):
    table = item_table(kind)
    record = query_one(f"SELECT share_token FROM {table} WHERE id = %s", (item_id,))
    if record and record.get("share_token"):
        return record["share_token"]
    token = secrets.token_urlsafe(32)
    cursor = get_db().cursor()
    try:
        cursor.execute(f"UPDATE {table} SET share_token = %s WHERE id = %s", (token, item_id))
        get_db().commit()
        return token
    except MySQLError:
        get_db().rollback()
        raise
    finally:
        cursor.close()


def inherited_share_sources(kind, record):
    sources = []
    if kind in {"file", "folder"} and record.get("folder_id"):
        chain = folder_chain(record["folder_id"] if kind == "file" else record["id"])
        if kind == "folder" and chain and chain[0]["id"] == record["id"]:
            chain = chain[1:]
        for folder in chain:
            has_user_shares = bool(query_one("SELECT id FROM folder_user_shares WHERE folder_id = %s LIMIT 1", (folder["id"],)))
            if has_user_shares or folder.get("is_share_link_enabled"):
                sources.append({
                    "kind": "folder",
                    "id": folder["id"],
                    "name": folder["name"],
                    "display_name": display_name(folder["name"]),
                    "has_link": bool(folder.get("is_share_link_enabled")),
                    "share_permission": normalize_link_permission(folder.get("share_permission")),
                })
                break
    event_id = record.get("event_id")
    if event_id:
        event = event_record(event_id)
        if event:
            has_event_shares = bool(query_one("SELECT id FROM event_user_shares WHERE event_id = %s LIMIT 1", (event_id,)))
            if has_event_shares or event.get("is_share_link_enabled"):
                sources.append({
                    "kind": "event",
                    "id": event["id"],
                    "name": event["name"],
                    "display_name": display_name(event["name"]),
                    "has_link": bool(event.get("is_share_link_enabled")),
                    "share_permission": normalize_link_permission(event.get("share_permission")),
                })
    return sources


def item_share_overview(kind, item_id):
    share_table_name = share_table(kind)
    item_column = f"{kind}_id"
    if kind == "file":
        record = file_record(item_id)
        name = record["original_filename"] if record else None
    elif kind == "folder":
        record = folder_record(item_id)
        name = record["name"] if record else None
    else:
        record = event_record(item_id)
        name = record["name"] if record else None
    if not record:
        return None
    cursor = get_db().cursor(dictionary=True)
    try:
        cursor.execute(
            f"SELECT users.id, users.username, users.email, shares.permission "
            f"FROM {share_table_name} AS shares "
            f"JOIN users ON users.id = shares.shared_with_user_id "
            f"WHERE shares.{item_column} = %s ORDER BY users.username, users.email",
            (item_id,),
        )
        shared_users = cursor.fetchall()
    finally:
        cursor.close()
    link_url = ""
    if record.get("share_token"):
        link_url = url_for("token_preview" if kind == "file" else "shared_folder" if kind == "folder" else "shared_event", share_token=record["share_token"], _external=True)
    return {
        "item_name": name,
        "item_display_name": display_name(name),
        "link": {
            "enabled": bool(record["is_share_link_enabled"]),
            "permission": normalize_link_permission(record["share_permission"]),
            "url": link_url,
        },
        "users": shared_users,
        "inherited_sources": inherited_share_sources(kind, record),
    }


def shared_with_me_items(user_id):
    """Return only the roots explicitly shared with this account.

    Descendants are intentionally reached through their shared folder/Event root so
    inherited access never has to be copied into another user's storage.
    """
    cursor = get_db().cursor(dictionary=True)
    try:
        cursor.execute(
            "SELECT files.id, files.original_filename AS name, files.file_size, files.mime_type, files.share_token, "
            "files.uploaded_at AS date, shares.permission FROM file_user_shares AS shares "
            "JOIN files ON files.id = shares.file_id "
            "WHERE shares.shared_with_user_id = %s AND files.is_deleted = FALSE AND files.share_token IS NOT NULL "
            "ORDER BY files.uploaded_at DESC",
            (user_id,),
        )
        files = cursor.fetchall()
        cursor.execute(
            "SELECT folders.id, folders.name, folders.share_token, folders.created_at AS date, shares.permission FROM folder_user_shares AS shares "
            "JOIN folders ON folders.id = shares.folder_id "
            "WHERE shares.shared_with_user_id = %s AND folders.is_deleted = FALSE AND folders.share_token IS NOT NULL "
            "ORDER BY folders.created_at DESC",
            (user_id,),
        )
        folders = cursor.fetchall()
        cursor.execute(
            "SELECT events.id, events.name, events.event_date AS date, events.event_type, events.share_token, shares.permission FROM event_user_shares AS shares "
            "JOIN events ON events.id = shares.event_id "
            "WHERE shares.shared_with_user_id = %s AND events.is_deleted = FALSE AND events.share_token IS NOT NULL "
            "ORDER BY events.event_date, events.name",
            (user_id,),
        )
        events = cursor.fetchall()
    finally:
        cursor.close()
    return (
        [{"kind": "folder", "parent_id": None, "size": 0, "file_size": 0, "mime_type": "Folder", "location": "Shared with me", "accessed_at": None, "is_starred": False, "is_share_link_enabled": False, "shared_permission": item["permission"], **item} for item in folders]
        + [{"kind": "file", "parent_id": None, "folder_id": None, "location": "Shared with me", "accessed_at": None, "is_starred": False, "is_share_link_enabled": False, "shared_permission": item["permission"], **item} for item in files]
        + [{"kind": "event", "parent_id": None, "size": 0, "file_size": 0, "mime_type": "Event", "location": "Shared with me", "accessed_at": None, "is_starred": False, "is_share_link_enabled": False, "shared_permission": item["permission"], **item} for item in events]
    )


@app.get("/folder/<share_token>")
def shared_folder(share_token):
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,64}", share_token):
        abort(404)
    share_context = share_context_from_token("folder", share_token)
    if not share_context:
        abort(404)
    current_folder_id = request.args.get("folder", type=int) or share_context["item_id"]
    current_folder = accessible_folder(current_folder_id, share_context=share_context)
    if not current_folder:
        abort(404)

    breadcrumbs = []
    node = current_folder
    while node:
        breadcrumbs.append(node)
        if node["id"] == share_context["item_id"] or not node["parent_id"]:
            break
        node = folder_record(node["parent_id"])
    breadcrumbs.reverse()

    cursor = get_db().cursor(dictionary=True)
    try:
        cursor.execute(
            "SELECT id, name, parent_id, created_at, accessed_at, is_starred, share_token, is_share_link_enabled FROM folders "
            "WHERE user_id = %s AND is_deleted = FALSE AND parent_id <=> %s ORDER BY created_at DESC",
            (share_context["owner_id"], current_folder_id),
        )
        folders = [folder for folder in cursor.fetchall() if folder_is_within(folder["id"], share_context["item_id"])]
        sizes = folder_sizes(cursor, [folder["id"] for folder in folders], include_deleted=False, owner_id=share_context["owner_id"])
        for folder in folders:
            folder["size"] = sizes.get(folder["id"], 0)
        cursor.execute(
            "SELECT id, user_id, original_filename, folder_id, file_size, mime_type, uploaded_at, accessed_at, is_starred, share_token, is_share_link_enabled "
            "FROM files WHERE user_id = %s AND is_deleted = FALSE AND folder_id <=> %s ORDER BY uploaded_at DESC",
            (share_context["owner_id"], current_folder_id),
        )
        files = cursor.fetchall()
        cursor.execute("SELECT id, name FROM folders WHERE user_id = %s AND is_deleted = FALSE ORDER BY name", (share_context["owner_id"],))
        move_folders = [folder for folder in cursor.fetchall() if folder["id"] == share_context["item_id"] or folder_is_within(folder["id"], share_context["item_id"])]
        cursor.execute("SELECT id, name, parent_id FROM folders WHERE user_id = %s AND is_deleted = FALSE", (share_context["owner_id"],))
        paths = folder_paths(cursor.fetchall())
    finally:
        cursor.close()

    items = (
        [{"kind": "folder", "name": item["name"], "date": item["created_at"], "mime_type": "Folder", "location": paths.get(item["parent_id"], "Library"), **item} for item in folders]
        + [{"kind": "file", "name": item["original_filename"], "parent_id": item["folder_id"], "date": item["uploaded_at"], "location": paths.get(item["folder_id"], "Library"), **item} for item in files]
    )
    for item in items:
        item["location_url"] = ""
        item["location_is_current"] = True

    return render_template(
        "dashboard.html",
        items=items,
        total_storage=0,
        total_files=len(items),
        section="files",
        current_folder=current_folder,
        breadcrumbs=breadcrumbs,
        folder_id=current_folder_id,
        event_id=None,
        current_event=None,
        is_trash=False,
        move_folders=[] if "user_id" not in session else move_folders,
        sidebar_events=[],
        search_query="",
        is_global_search=False,
        is_shared_workspace=True,
        workspace_can_edit="user_id" in session and permission_at_least(share_context["permission"], "editor"),
        workspace_can_manage_sharing="user_id" in session and share_context["permission"] == "owner",
        is_public_workspace="user_id" not in session,
        share_context=share_context,
        is_shared_listing=False,
        shared_root_folder_id=share_context["item_id"],
    )


@app.get("/event/<share_token>")
def shared_event(share_token):
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,64}", share_token):
        abort(404)
    share_context = share_context_from_token("event", share_token)
    if not share_context:
        abort(404)
    event_id = share_context["item_id"]
    current_event = accessible_event(event_id, share_context=share_context)
    if not current_event:
        abort(404)
    current_folder_id = request.args.get("folder", type=int)
    current_folder = None
    breadcrumbs = []
    if current_folder_id is not None:
        current_folder = accessible_folder(current_folder_id, share_context=share_context)
        if not current_folder or current_folder.get("event_id") != event_id:
            abort(404)
        node = current_folder
        while node:
            breadcrumbs.append(node)
            node = folder_record(node["parent_id"]) if node["parent_id"] else None
        breadcrumbs.reverse()

    cursor = get_db().cursor(dictionary=True)
    try:
        cursor.execute(
            "SELECT id, name, parent_id, event_id, created_at, accessed_at, is_starred, share_token, is_share_link_enabled "
            "FROM folders WHERE user_id = %s AND is_deleted = FALSE AND event_id = %s AND parent_id <=> %s ORDER BY created_at DESC",
            (share_context["owner_id"], event_id, current_folder_id),
        )
        folders = cursor.fetchall()
        sizes = folder_sizes(cursor, [folder["id"] for folder in folders], include_deleted=False, owner_id=share_context["owner_id"])
        for folder in folders:
            folder["size"] = sizes.get(folder["id"], 0)
        cursor.execute(
            "SELECT id, user_id, original_filename, folder_id, event_id, file_size, mime_type, uploaded_at, accessed_at, is_starred, share_token, is_share_link_enabled "
            "FROM files WHERE user_id = %s AND is_deleted = FALSE AND event_id = %s AND folder_id <=> %s ORDER BY uploaded_at DESC",
            (share_context["owner_id"], event_id, current_folder_id),
        )
        files = cursor.fetchall()
        cursor.execute("SELECT id, name FROM folders WHERE user_id = %s AND is_deleted = FALSE ORDER BY name", (share_context["owner_id"],))
        move_folders = [folder for folder in cursor.fetchall() if accessible_folder(folder["id"], required="editor", share_context=share_context)]
        cursor.execute("SELECT id, name, parent_id FROM folders WHERE user_id = %s AND is_deleted = FALSE", (share_context["owner_id"],))
        paths = folder_paths(cursor.fetchall())
    finally:
        cursor.close()

    items = (
        [{"kind": "folder", "name": item["name"], "date": item["created_at"], "mime_type": "Folder", "location": paths.get(item["parent_id"], "Events"), **item} for item in folders]
        + [{"kind": "file", "name": item["original_filename"], "parent_id": item["folder_id"], "date": item["uploaded_at"], "location": paths.get(item["folder_id"], "Events"), **item} for item in files]
    )
    for item in items:
        item["location_url"] = ""
        item["location_is_current"] = True

    return render_template(
        "dashboard.html",
        page_title=display_name(current_event["name"]),
        items=items,
        total_storage=0,
        total_files=len(items),
        section="events",
        current_folder=current_folder,
        breadcrumbs=breadcrumbs,
        folder_id=current_folder_id,
        event_id=event_id,
        current_event=current_event,
        selected_event_date=None,
        selected_event_date_iso="",
        is_event_date_workspace=False,
        date_workspace_events=[],
        is_trash=False,
        move_folders=[] if "user_id" not in session else move_folders,
        sidebar_events=[],
        search_query="",
        calendar_auto_open=False,
        is_global_search=False,
        is_shared_workspace=True,
        workspace_can_edit="user_id" in session and permission_at_least(share_context["permission"], "editor"),
        workspace_can_manage_sharing="user_id" in session and share_context["permission"] == "owner",
        is_public_workspace="user_id" not in session,
        share_context=share_context,
        is_shared_listing=False,
        month_name=calendar_module.month_name[date.today().month],
        year=date.today().year,
        month=date.today().month,
        weeks=sunday_first_month_weeks(date.today().year, date.today().month),
        events_by_day={},
    )


@app.get("/shares/<kind>/<int:item_id>")
@login_required
def get_item_shares(kind, item_id):
    require_share_manage_access(kind, item_id)
    overview = item_share_overview(kind, item_id)
    if not overview:
        abort(404)
    return jsonify({"ok": True, **overview})


@app.post("/shares/<kind>/<int:item_id>/users")
@login_required
def add_item_share_user(kind, item_id):
    record = require_share_manage_access(kind, item_id)
    identifier = request.form.get("identifier", "").strip().lower()
    permission = normalize_permission(request.form.get("permission"))
    if not identifier:
        return jsonify({"ok": False, "message": "Enter a username or email."}), 400
    target_user = query_one(
        "SELECT id, username, email FROM users WHERE (username = %s OR email = %s) LIMIT 1",
        (identifier, identifier),
    )
    if not target_user or target_user["id"] == record["user_id"]:
        return jsonify({"ok": False, "message": "Choose a different account."}), 400
    table = share_table(kind)
    item_column = f"{kind}_id"
    # A restricted link token is a stable route for the recipient; it confers no
    # access on its own, because the direct share is still checked on every use.
    ensure_item_share_token(kind, item_id)
    cursor = get_db().cursor()
    try:
        cursor.execute(
            f"INSERT INTO {table} ({item_column}, shared_with_user_id, permission) VALUES (%s, %s, %s) "
            f"ON DUPLICATE KEY UPDATE permission = VALUES(permission)",
            (item_id, target_user["id"], permission),
        )
        get_db().commit()
    except MySQLError:
        get_db().rollback()
        app.logger.exception("Share user update error")
        return jsonify({"ok": False, "message": "Could not update sharing."}), 500
    finally:
        cursor.close()
    return jsonify({"ok": True, **item_share_overview(kind, item_id)})


@app.post("/shares/<kind>/<int:item_id>/users/<int:shared_user_id>")
@login_required
def update_item_share_user(kind, item_id, shared_user_id):
    require_share_manage_access(kind, item_id)
    action = request.form.get("action", "update").strip().lower()
    table = share_table(kind)
    item_column = f"{kind}_id"
    cursor = get_db().cursor()
    try:
        if action == "remove":
            cursor.execute(
                f"DELETE FROM {table} WHERE {item_column} = %s AND shared_with_user_id = %s",
                (item_id, shared_user_id),
            )
        else:
            permission = normalize_permission(request.form.get("permission"))
            cursor.execute(
                f"UPDATE {table} SET permission = %s WHERE {item_column} = %s AND shared_with_user_id = %s",
                (permission, item_id, shared_user_id),
            )
        get_db().commit()
    except MySQLError:
        get_db().rollback()
        app.logger.exception("Share permission change error")
        return jsonify({"ok": False, "message": "Could not update sharing."}), 500
    finally:
        cursor.close()
    return jsonify({"ok": True, **item_share_overview(kind, item_id)})


@app.post("/shares/<kind>/<int:item_id>/link")
@login_required
def update_item_share_link(kind, item_id):
    require_share_manage_access(kind, item_id)
    action = request.form.get("action", "update").strip().lower()
    permission = normalize_link_permission(request.form.get("permission"))
    table = item_table(kind)
    cursor = get_db().cursor()
    try:
        if action == "disable":
            cursor.execute(
                f"UPDATE {table} SET is_share_link_enabled = FALSE WHERE id = %s AND user_id = %s",
                (item_id, session["user_id"]),
            )
        elif action == "enable":
            token = ensure_item_share_token(kind, item_id)
            cursor.execute(
                f"UPDATE {table} SET share_token = %s, share_permission = %s, is_share_link_enabled = TRUE WHERE id = %s AND user_id = %s",
                (token, permission, item_id, session["user_id"]),
            )
        else:
            cursor.execute(
                f"UPDATE {table} SET share_permission = %s WHERE id = %s AND user_id = %s",
                (permission, item_id, session["user_id"]),
            )
        get_db().commit()
    except MySQLError:
        get_db().rollback()
        app.logger.exception("Share link update error")
        return jsonify({"ok": False, "message": "Could not update link sharing."}), 500
    finally:
        cursor.close()
    return jsonify({"ok": True, **item_share_overview(kind, item_id)})


@app.errorhandler(RequestEntityTooLarge)
def too_large(_error):
    flash(f"Files must be {MAX_FILE_SIZE_MB} MB or smaller.", "error")
    return redirect(url_for("dashboard") if "user_id" in session else url_for("login"))


@app.errorhandler(404)
def not_found(_error):
    return render_template("error.html", message="The requested page or file was not found."), 404


@app.errorhandler(500)
def server_error(_error):
    return render_template("error.html", message="Something went wrong. Please try again later."), 500


if __name__ == "__main__":
    app.run(debug=os.getenv("FLASK_DEBUG", "false").lower() == "true")
