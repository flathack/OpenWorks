"""Bundle validation and manifest compilation."""
import hashlib
import json
import re

PHASES = ("install", "start", "uninstall")
VAR = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def string(value, label, limit=180):
    if not isinstance(value, str) or not value.strip() or len(value) > limit or "\0" in value:
        raise ValueError(f"Ungültiger Wert für {label}.")
    return value.strip()


def variables(values):
    if not isinstance(values, dict) or len(values) > 100:
        raise ValueError("Variablen müssen Schlüssel und Textwerte enthalten.")
    for key, value in values.items():
        if not NAME.fullmatch(key) or not isinstance(value, str) or len(value) > 1024:
            raise ValueError(f"Ungültige Variable: {key}")
    return values


def bundle_body(data):
    actions = data.get("actions")
    if not isinstance(actions, dict):
        raise ValueError("Aktionslisten fehlen.")
    result = {}
    for phase in PHASES:
        items = actions.get(phase, [])
        if not isinstance(items, list) or len(items) > 64:
            raise ValueError("Maximal 64 Aktionen pro Liste.")
        result[phase] = [string(item, "Aktion", 1024) for item in items]
    return {"variables": variables(data.get("variables", {})), "actions": result}


def compile_actions(body, globals_, packages):
    values = globals_ | body["variables"]

    def substitute(match):
        key = match[1]
        if key not in values:
            raise ValueError(f"Variable {key} fehlt.")
        return values[key]

    actions = {}
    for phase, items in body["actions"].items():
        steps = []
        for item in items:
            value = VAR.sub(substitute, item)
            if "$" + "{" in value:
                raise ValueError(f"Unaufgelöster Platzhalter in {item}.")
            if phase == "start":
                path = value.replace("/", "\\")
                if (not path.lower().endswith(".exe") or
                    any(p in ("", ".", "..") or p.endswith((" ", ".")) for p in path.split("\\")) or
                    any(c in path for c in ':*?"<>|')):
                    raise ValueError("Start benötigt einen relativen EXE-Pfad unter Program Files.")
                steps.append({"kind": "launch", "value": path})
            else:
                digest = packages.get(value.casefold())
                if digest is None:
                    raise ValueError(f"MSI-Paket fehlt: {value}")
                steps.append({"kind": phase, "value": digest})
        actions[phase] = steps
    return actions


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
