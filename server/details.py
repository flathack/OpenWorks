"""Object details and the user-facing application catalog."""
import json
import re
import time
from flask import abort, g, jsonify, request

from .model import compile_actions, condition, fingerprint, resolver

DEFAULT_BRANDING = {
    "title": "OpenWorks Anwendungen", "theme": "orbit", "accent": "#39AEEF",
    "layout": "tiles", "search": True, "favorites": True,
}
SYMBOLS = ("app", "folder", "tools", "document", "web", "code", "office")
INVENTORY = ("hostname", "os", "architecture", "build", "manufacturer", "model",
             "serial", "cpu", "memory", "boot", "user", "ips", "version")
DEVICE_FIELDS = ("owner", "department", "site", "location", "notes")


def text_fields(data, fields, limit=500):
    values = {key: data.get(key, "") for key in fields}
    if any(not isinstance(v, str) or len(v) > limit or "\0" in v for v in values.values()):
        abort(400, "Ungültiger Textwert.")
    return {k: v.strip() for k, v in values.items()}


def register_details(app, db, rows, globals_, packages, manifest):
    def body():
        data = request.get_json()
        if not isinstance(data, dict):
            abort(400)
        return data

    def policy():
        result = db().execute("SELECT value FROM settings WHERE name='branding'").fetchone()
        return json.loads(result[0]) if result else {
            "revision": 1, "enabled": True, "modified": None, **DEFAULT_BRANDING}

    @app.route("/api/admin/branding", methods=["GET", "POST"])
    def branding():
        current = policy()
        if request.method == "GET":
            return jsonify(current)
        data = body()
        if current["revision"] != data.get("revision"):
            abort(409, "Richtlinie wurde inzwischen geändert.")
        values = text_fields(data, ["title", "accent", "theme", "layout"], 80)
        if (not values["title"] or not re.fullmatch("#[0-9a-fA-F]{6}", values["accent"])
                or values["theme"] not in ("orbit", "slate", "light") or values["layout"] not in ("tiles", "list")):
            abort(400, "Ungültige Gestaltung.")
        for field in ("enabled", "search", "favorites"):
            if type(data.get(field)) is not bool:
                abort(400)
            values[field] = data[field]
        values.update(revision=current["revision"] + 1, modified=int(time.time()))
        db().execute("INSERT OR REPLACE INTO settings VALUES ('branding',?)", (json.dumps(values),))
        db().commit()
        return jsonify(values)

    @app.get("/api/agent/catalog")
    def client_catalog():
        if g.agent["scope"] != "user":
            abort(403)
        current = policy()
        apps = {}
        for rule in manifest():
            key = rule["bundle"]
            if key not in apps:
                info = db().execute("SELECT description,symbol FROM bundle_info WHERE bundle=?", (key,)).fetchone()
                apps[key] = dict(bundle=key, name=rule["name"], revision=rule["revision"],
                                 **dict(info), launch=None, phases=[], icon_path=None, device=False)
            if rule["phase"] == "install" or rule["install"]:
                apps[key]["user_install_version"] = rule["install_version"]
            if rule["phase"] == "install" and rule["trigger"] == "manual":
                apps[key]["install"] = rule["id"]
            if "requires" in rule:
                apps[key].update(requires=rule["requires"], show_unmet=rule["show_unmet"])
            apps[key]["phases"].append(rule["phase"])
            if rule["phase"] == "start" and rule["steps"]:
                apps[key]["icon_path"] = next((s["value"] for s in rule["steps"] if s["kind"] == "launch"), None)
            if rule["phase"] == "start" and rule["trigger"] == "manual":
                apps[key]["launch"] = rule["id"]
        for row in rows("""SELECT b.id,b.name,b.revision,b.body,i.description,i.symbol,a.phase
                           FROM user_device link JOIN agents device ON device.id=link.device_agent
                           JOIN assignments a ON a.scope='device' AND a.principal=device.principal
                           JOIN bundles b ON b.id=a.bundle JOIN bundle_info i ON i.bundle=b.id
                           LEFT JOIN bundle_catalog c ON c.bundle=b.id
                           WHERE link.user_agent=? AND COALESCE(c.enabled,1)=1""", (g.agent["id"],)):
            recipe = json.loads(row["body"])
            requirement = recipe.get("requires", {})
            gated = bool(requirement.get("rules") or "kind" in requirement)
            if gated and request.headers.get("X-OpenWorks-Protocol") != "2":
                continue
            if not any(isinstance(x, str) or x.get("enabled", True) for x in recipe["actions"].get(row["phase"], [])):
                continue
            item = apps.setdefault(row["id"], dict(bundle=row["id"], name=row["name"], revision=row["revision"],
                                   description=row["description"], symbol=row["symbol"], launch=None, phases=[], icon_path=None))
            if gated:
                item.update(requires=condition(requirement, resolver(recipe, globals_())),
                            show_unmet=recipe.get("show_unmet", False))
            if row["phase"] == "install":
                item["device_install_version"] = fingerprint(compile_actions(recipe, globals_(), packages())["install"])
            item["device"] = True
            if row["phase"] not in item["phases"]:
                item["phases"].append(row["phase"])
        return jsonify(principal=g.agent["principal"], updated=int(time.time()),
                       policy=current if current["enabled"] else DEFAULT_BRANDING,
                       apps=sorted(apps.values(), key=lambda a: a["name"].casefold()))

    @app.post("/api/agent/inventory")
    def inventory():
        if g.agent["scope"] != "device":
            abort(403)
        values = text_fields(body(), INVENTORY, 2048)
        if not values["hostname"] or not values["version"]:
            abort(400, "Hostname und Agent-Version fehlen.")
        db().execute("UPDATE device_info SET inventory=?,scanned=? WHERE agent=?",
                     (json.dumps(values), int(time.time()), g.agent["id"]))
        db().commit()
        return jsonify(ok=True)

    @app.route("/api/admin/device/<int:key>", methods=["GET", "POST"])
    def device_detail(key):
        found = rows("""SELECT a.id,a.label,a.principal,a.last_seen,d.* FROM agents a JOIN device_info d ON d.agent=a.id
                         WHERE a.scope='device' AND a.id=?""", (key,))
        if not found:
            abort(404)
        device = found[0]
        device["inventory"] = json.loads(device["inventory"])
        device["properties"] = json.loads(device["properties"])
        device["users"] = [r["user_agent"] for r in rows("SELECT user_agent FROM user_device WHERE device_agent=? ORDER BY user_agent", (key,))]
        device["etag"] = fingerprint([device["properties"],device["users"]])
        if request.method == "POST":
            data = body()
            if data.get("etag") != device["etag"]:
                abort(409, "Gerät wurde inzwischen geändert.")
            values = text_fields(data, DEVICE_FIELDS)
            users = data.get("users",device["users"])
            if not isinstance(users,list) or any(type(i) is not int for i in users):
                abort(400, "Ungültige Benutzerregistrierung.")
            db().execute("DELETE FROM user_device WHERE device_agent=?", (key,))
            for user in set(users):
                if not db().execute("SELECT 1 FROM agents WHERE id=? AND scope='user'",(user,)).fetchone():
                    abort(400, "Ungültige Benutzerregistrierung.")
                db().execute("INSERT INTO user_device VALUES (?,?)", (user,key))
            db().execute("UPDATE device_info SET properties=? WHERE agent=?", (json.dumps(values), key))
            db().commit()
            return jsonify(ok=True)
        device["reports"] = rows("SELECT * FROM reports WHERE agent=? ORDER BY seen DESC", (key,))
        return jsonify(device)

    @app.route("/api/admin/bundle/<int:key>", methods=["GET", "POST"])
    def bundle_detail(key):
        found = rows("SELECT * FROM bundle_info WHERE bundle=?", (key,))
        if not found:
            abort(404)
        info = found[0]
        info["etag"] = fingerprint([info["description"], info["notes"], info["symbol"]])
        if request.method == "POST":
            data = body()
            if info["etag"] != data.get("etag"):
                abort(409, "Details wurden inzwischen geändert.")
            values = text_fields(data, ("description","notes"), 2000)
            if data.get("symbol") not in SYMBOLS:
                abort(400, "Unbekanntes Symbol.")
            db().execute("UPDATE bundle_info SET description=?,notes=?,symbol=? WHERE bundle=?",
                         (values["description"], values["notes"], data["symbol"], key))
            db().commit()
            return jsonify(ok=True)
        published = db().execute("SELECT body FROM bundles WHERE id=?", (key,)).fetchone()
        actions = compile_actions(json.loads(published[0]), globals_(), packages())
        hashes = {step["value"] for steps in actions.values() for step in steps if step["kind"] in ("install","uninstall","cache","repair")}
        info["size"] = sum(p["size"] for p in rows("SELECT digest,size FROM packages") if p["digest"] in hashes)
        info["versions"] = rows("SELECT revision,name,recorded FROM bundle_versions WHERE bundle=? ORDER BY revision DESC", (key,))
        info["reports"] = rows("""SELECT r.* FROM reports r JOIN assignments a ON a.id=r.assignment
                                   WHERE a.bundle=? ORDER BY seen DESC""", (key,))
        return jsonify(info)
