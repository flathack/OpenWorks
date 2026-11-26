import argparse
import getpass
import hashlib
import json
import os
import secrets
import sqlite3
import tempfile
import time
from contextlib import closing
from pathlib import Path

from flask import Flask, abort, g, jsonify, request, send_file, session
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

from .model import PHASES, bundle_body, compile_actions, fingerprint, string, variables

ROOT = Path(__file__).resolve().parent


def create_app(directory, secure=False):
    data = Path(directory).resolve()
    data.mkdir(parents=True, exist_ok=True)
    content = data / "packages"
    content.mkdir(exist_ok=True)
    database = data / "openworks.db"
    with closing(sqlite3.connect(database)) as conn, conn:
        conn.executescript((ROOT / "schema.sql").read_text())
        conn.execute("INSERT OR IGNORE INTO settings VALUES ('secret', ?)", (secrets.token_hex(32),))
        conn.execute("""INSERT OR IGNORE INTO settings VALUES ('variables','{}')""")
        secret = conn.execute("SELECT value FROM settings WHERE name='secret'").fetchone()[0]
    app = Flask(__name__)
    app.config.update(SECRET_KEY=secret, SESSION_COOKIE_SAMESITE="Strict",
                      SESSION_COOKIE_SECURE=secure, MAX_CONTENT_LENGTH=513 * 1024**2)

    def db():
        if "db" not in g:
            g.db = sqlite3.connect(database, timeout=30)
            g.db.row_factory = sqlite3.Row
            g.db.execute("PRAGMA foreign_keys=ON")
        return g.db

    @app.teardown_appcontext
    def close(_):
        if "db" in g:
            g.db.close()

    def rows(sql, args=()):
        return [dict(row) for row in db().execute(sql, args)]

    def setting(key):
        row = db().execute("SELECT value FROM settings WHERE name=?", (key,)).fetchone()
        return row[0] if row else None

    def packages():
        return {p["name"].casefold(): p["digest"] for p in rows("SELECT name,digest FROM packages")}

    def globals_():
        return json.loads(setting("variables"))

    def payload():
        data = request.get_json()
        if not isinstance(data, dict):
            abort(400)
        return data

    @app.before_request
    def authorize():
        if request.path.startswith("/api/admin/"):
            if not session.get("admin"):
                abort(401)
            if request.method != "GET" and request.headers.get("X-CSRF") != session.get("csrf"):
                abort(403)
            if request.method != "GET":
                db().execute("BEGIN IMMEDIATE")
        if request.path.startswith("/api/agent/"):
            token = request.headers.get("Authorization", "")
            if not token.startswith("Bearer "):
                abort(401)
            digest = hashlib.sha256(token[7:].encode()).hexdigest()
            g.agent = db().execute("SELECT * FROM agents WHERE token_hash=?", (digest,)).fetchone()
            if not g.agent:
                abort(401)

    @app.after_request
    def headers(response):
        response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                                 "Content-Security-Policy": "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"})
        return response

    @app.errorhandler(ValueError)
    def invalid(exc):
        return jsonify(error=str(exc)), 400

    @app.errorhandler(sqlite3.IntegrityError)
    def conflict(_):
        return jsonify(error="Dieser Eintrag existiert bereits oder wird noch verwendet."), 409

    @app.errorhandler(HTTPException)
    def http_error(exc):
        return jsonify(error=exc.description), exc.code

    @app.get("/")
    def index():
        return app.send_static_file("index.html")

    @app.post("/api/login")
    def login():
        password = payload().get("password")
        stored = setting("password")
        if not stored or not isinstance(password, str) or not check_password_hash(stored, password):
            abort(401, "Anmeldung fehlgeschlagen.")
        session.clear()
        session.update(admin=True, csrf=secrets.token_urlsafe(24))
        return jsonify(ok=True)

    @app.post("/api/admin/logout")
    def logout():
        session.clear()
        return jsonify(ok=True)

    @app.get("/api/admin/state")
    def state():
        bundles = rows("SELECT * FROM bundles ORDER BY name")
        for bundle in bundles:
            bundle.update(json.loads(bundle.pop("body")))
        return jsonify(bundles=bundles, variables=globals_(), csrf=session["csrf"],
                       packages=rows("SELECT * FROM packages ORDER BY name"),
                       agents=rows("SELECT id,scope,principal,label,last_seen FROM agents ORDER BY label"),
                       assignments=rows("SELECT * FROM assignments ORDER BY id"),
                       reports=rows("SELECT * FROM reports ORDER BY seen DESC LIMIT 200"))

    @app.post("/api/admin/variables")
    def set_variables():
        values = variables(payload().get("variables"))
        catalog = packages()
        for bundle in rows("SELECT body FROM bundles"):
            compile_actions(json.loads(bundle["body"]), values, catalog)
        db().execute("UPDATE settings SET value=? WHERE name='variables'", (json.dumps(values),))
        db().commit()
        return jsonify(ok=True)

    @app.post("/api/admin/packages")
    def upload():
        file = request.files.get("file")
        if file is None:
            abort(400, "MSI-Datei fehlt.")
        name = string(file.filename, "Dateiname")
        if "/" in name or "\\" in name or not name.lower().endswith(".msi"):
            abort(400, "MSI-Dateinamen prüfen.")
        digest = hashlib.sha256()
        with tempfile.NamedTemporaryFile(dir=content, delete=False) as tmp:
            path = Path(tmp.name)
        try:
            size = 0
            with path.open("wb") as out:
                for chunk in iter(lambda: file.stream.read(1024**2), b""):
                    if not size and not chunk.startswith(bytes.fromhex("d0cf11e0a1b11ae1")):
                        abort(400, "Ungültiger MSI-Dateikopf.")
                    size += len(chunk)
                    if size > 512 * 1024**2:
                        abort(413)
                    digest.update(chunk)
                    out.write(chunk)
            if size == 0:
                abort(400)
            key = digest.hexdigest()
            db().execute("INSERT INTO packages VALUES (?,?,?)", (key, name, size))
            os.replace(path, content / key)
            db().commit()
        finally:
            path.unlink(missing_ok=True)
        return jsonify(ok=True), 201

    @app.post("/api/admin/bundles")
    def save_bundle():
        data = payload()
        name = string(data.get("name"), "Bundle-Name")
        body = bundle_body(data)
        compile_actions(body, globals_(), packages())
        raw = json.dumps(body)
        if data.get("id"):
            for rule in rows("SELECT DISTINCT phase FROM assignments WHERE bundle=?", (data["id"],)):
                if not body["actions"][rule["phase"]]:
                    abort(400, "Eine zugewiesene Aktionsliste muss mindestens eine Aktion enthalten.")
            cur = db().execute("UPDATE bundles SET name=?,body=?,revision=revision+1 WHERE id=? AND revision=?",
                               (name, raw, data["id"], data.get("revision")))
            if not cur.rowcount:
                abort(409, "Das Bundle wurde inzwischen geändert. Bitte neu laden.")
            key = data["id"]
        else:
            key = db().execute("INSERT INTO bundles(name,revision,body) VALUES (?,1,?)", (name, raw)).lastrowid
        db().commit()
        return jsonify(id=key)

    @app.post("/api/admin/agents")
    def new_agent():
        data = payload()
        scope = data.get("scope")
        if scope not in ("device", "user"):
            abort(400)
        principal = string(data.get("principal"), "Ziel")
        label = string(data.get("label"), "Agent-Name")
        token = secrets.token_urlsafe(32)
        db().execute("INSERT INTO agents(scope,principal,label,token_hash) VALUES (?,?,?,?)",
                     (scope, principal, label, hashlib.sha256(token.encode()).hexdigest()))
        db().commit()
        return jsonify(token=token), 201

    @app.post("/api/admin/assignments")
    def assign():
        data = payload()
        phase, trigger = data.get("phase"), data.get("trigger")
        scope, principal = data.get("scope"), string(data.get("principal"), "Ziel")
        if phase not in PHASES or trigger not in ("now", "at", "boot", "login") or scope not in ("device", "user"):
            abort(400)
        if (scope == "user" and trigger == "boot") or (scope == "device" and phase == "start"):
            abort(400, "Benutzer benötigen eine Sitzung. Start-Aktionen benötigen ein Benutzerziel.")
        due = data.get("due") if trigger == "at" else None
        if trigger == "at" and (type(due) is not int or due < 1):
            abort(400, "Zeitpunkt fehlt.")
        if not db().execute("SELECT 1 FROM agents WHERE scope=? AND principal=?", (scope, principal)).fetchone():
            abort(400, "Unbekanntes Ziel.")
        bundle = db().execute("SELECT body FROM bundles WHERE id=?", (data.get("bundle"),)).fetchone()
        if not bundle or not json.loads(bundle[0])["actions"][phase]:
            abort(400, "Die gewählte Aktionsliste ist leer.")
        fields = (data["bundle"], scope, principal, phase, trigger, due)
        if data.get("id"):
            old = db().execute("SELECT bundle,scope,principal,phase,trigger,due FROM assignments WHERE id=? AND generation=?",
                               (data["id"], data.get("generation"))).fetchone()
            if old is None:
                abort(409, "Die Zuweisung wurde inzwischen geändert. Bitte neu laden.")
            if tuple(old) != fields:
                db().execute("UPDATE assignments SET bundle=?,scope=?,principal=?,phase=?,trigger=?,due=?,generation=generation+1 WHERE id=?",
                             (*fields, data["id"]))
                db().execute("DELETE FROM reports WHERE assignment=?", (data["id"],))
        else:
            db().execute("INSERT INTO assignments(bundle,scope,principal,phase,trigger,due) VALUES (?,?,?,?,?,?)", fields)
        db().commit()
        return jsonify(ok=True), 201

    @app.delete("/api/admin/<kind>/<int:key>")
    def remove(kind, key):
        if kind not in ("agents", "assignments", "bundles"):
            abort(404)
        cur = db().execute(f"DELETE FROM {kind} WHERE id=?", (key,))
        if not cur.rowcount:
            abort(404)
        db().commit()
        return jsonify(ok=True)

    def manifest():
        items = rows("""SELECT a.id,a.bundle,a.phase,a.trigger,a.due,a.generation,b.name,b.revision,b.body
                        FROM assignments a JOIN bundles b ON b.id=a.bundle
                        WHERE a.scope=? AND a.principal=? ORDER BY a.id""", (g.agent["scope"], g.agent["principal"]))
        catalog, values = packages(), globals_()
        for item in items:
            actions = compile_actions(json.loads(item.pop("body")), values, catalog)
            item["steps"] = actions[item["phase"]]
            item["install"] = actions["install"] if item["phase"] == "start" else []
            item["install_version"] = fingerprint(actions["install"])
            item["version"] = fingerprint([item["generation"], item["revision"], item["steps"], item["install"]])
        return items

    @app.get("/api/agent/manifest")
    def pull():
        now = int(time.time())
        db().execute("UPDATE agents SET last_seen=? WHERE id=?", (now, g.agent["id"]))
        items = manifest()
        db().commit()
        return jsonify(agent=g.agent["id"], scope=g.agent["scope"], now=now, assignments=items)

    @app.get("/api/agent/packages/<digest>")
    def download(digest):
        allowed = any(step["value"] == digest and step["kind"] in ("install", "uninstall")
                      for rule in manifest() for step in rule["steps"] + rule["install"])
        if not allowed:
            abort(404)
        return send_file(content / digest, mimetype="application/octet-stream")

    @app.post("/api/agent/report")
    def report():
        data = payload()
        db().execute("BEGIN IMMEDIATE")
        rule = next((r for r in manifest() if r["id"] == data.get("assignment")), None)
        if rule is None or rule["version"] != data.get("version"):
            abort(409, "Zuweisung hat sich geändert.")
        if data.get("status") not in ("ok", "error"):
            abort(400)
        detail = string(data.get("detail"), "Statusmeldung", 1024)
        db().execute("INSERT OR REPLACE INTO reports VALUES (?,?,?,?,?,?)",
                     (g.agent["id"], rule["id"], rule["version"], data["status"], detail, int(time.time())))
        db().commit()
        return jsonify(ok=True)

    return app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["init", "serve"])
    parser.add_argument("--data", default="instance")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--secure-cookie", action="store_true")
    args = parser.parse_args()
    app = create_app(args.data, args.secure_cookie)
    if args.command == "init":
        password = getpass.getpass("Neues Admin-Passwort (mindestens 12 Zeichen): ")
        if len(password) < 12 or password != getpass.getpass("Wiederholen: "):
            parser.exit(1, "Passwort zu kurz oder Eingaben unterschiedlich.\n")
        with closing(sqlite3.connect(Path(args.data) / "openworks.db")) as conn, conn:
            conn.execute("INSERT OR REPLACE INTO settings VALUES ('password',?)", (generate_password_hash(password),))
            conn.execute("UPDATE settings SET value=? WHERE name='secret'", (secrets.token_hex(32),))
        print("Admin-Zugang eingerichtet.")
    else:
        from waitress import serve
        print(f"OpenWorks auf http://{args.host}:{args.port}", flush=True)
        serve(app, host=args.host, port=args.port, max_request_body_size=513 * 1024**2)


if __name__ == "__main__":
    main()
