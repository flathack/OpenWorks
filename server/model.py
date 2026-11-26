"""Bundle validation and manifest compilation."""
import hashlib
import json
import re

PHASES = ("distribute", "install", "start", "repair", "uninstall", "terminate")
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



DEFAULT_KIND = dict(distribute="cache", install="install", start="launch", repair="repair",
                    uninstall="uninstall", terminate="uncache")
PACKAGE_KINDS = {"install", "uninstall", "cache", "repair", "uncache"}
FILE_KINDS = {"mkdir", "rmdir", "write_text", "copy_file", "remove_file"}
FILTERS = {"file", "registry", "architecture", "hostname", "windows", "memory", "free_disk", "service", "running"}
MARKER = "$" + "{"


def flag(data, key, default=False):
    value = data.get(key, default)
    if type(value) is not bool:
        raise ValueError(f"Ungültige Option {key}.")
    return value


def condition(node, resolve=None, depth=0):
    if not isinstance(node, dict) or depth > 4:
        raise ValueError("Ungültiger Filtersatz (maximal vier Ebenen).")
    if "rules" in node:
        mode, rules = node.get("mode"), node["rules"]
        if mode not in ("all", "any") or not isinstance(rules, list) or len(rules) > 16:
            raise ValueError("Ungültige Filterkombination.")
        return dict(mode=mode, rules=[condition(x, resolve, depth+1) for x in rules])
    kind = node.get("kind")
    if kind not in FILTERS:
        raise ValueError("Unbekannter Anforderungsfilter.")
    value = string(node.get("value"), "Filterwert", 1024)
    if resolve is not None:
        value = resolve(value)
        if kind in ("memory", "free_disk") and not re.fullmatch(r"[0-9]{1,12}", value):
            raise ValueError("Speichergröße als ganze Zahl in MiB angeben.")
    return dict(kind=kind, value=value, expected=flag(node, "expected", True))


def action(item, phase):
    if isinstance(item, str):
        return string(item, "Aktion", 1024)
    if not isinstance(item, dict):
        raise ValueError("Ungültige Aktion.")
    kind = item.get("kind")
    if kind not in PACKAGE_KINDS | FILE_KINDS | {"launch", "delay"} or (kind == "launch" and phase != "start"):
        raise ValueError("Dieser Aktionstyp ist in der gewählten Liste nicht verfügbar.")
    spec = dict(name=string(item.get("name"), "Aktionsname"), kind=kind,
                value=string(item.get("value"), "Aktionswert", 1024),
                enabled=flag(item, "enabled", True), continue_error=flag(item, "continue_error"),
                fail_unmet=flag(item, "fail_unmet"))
    if "requires" in item:
        spec["requires"] = condition(item["requires"])
    if kind == "write_text":
        content = item.get("text")
        if not isinstance(content, str) or len(content.encode()) > 65536 or "\0" in content:
            raise ValueError("Eine UTF-8-Textdatei mit bis zu 64 KiB angeben.")
        spec["text"] = content
    if kind == "copy_file":
        spec["source"] = string(item.get("source"), "Quelldatei", 1024)
    if kind == "launch":
        spec["environment"] = variables(item.get("environment", {}))
        mode = item.get("wait", "none")
        timeout = item.get("seconds", 60)
        if mode not in ("none", "exit", "timeout") or type(timeout) != int or not 1 <= timeout <= 86400:
            raise ValueError("Ungültige Warteoption.")
        args, codes = item.get("args", []), item.get("codes", [0])
        if not isinstance(args, list) or len(args) > 32 or not all(isinstance(x,str) and len(x)<=1024 and "\0" not in x for x in args):
            raise ValueError("Ungültige Befehlszeilenparameter.")
        if not isinstance(codes,list) or not 1 <= len(codes) <= 32 or not all(type(x) == int and -2147483648 <= x <= 2147483647 for x in codes):
            raise ValueError("Ungültige Rückgabecodes.")
        cwd = item.get("cwd", "")
        spec.update(wait=mode, seconds=timeout, kill_timeout=flag(item,"kill_timeout"),
                    codes=codes, args=args, cwd=string(cwd,"Arbeitsverzeichnis",1024) if cwd else "")
    return spec


def bundle_body(data):
    actions = data.get("actions")
    if not isinstance(actions, dict):
        raise ValueError("Aktionslisten fehlen.")
    result = {}
    for phase in PHASES:
        items = actions.get(phase, [])
        if not isinstance(items, list) or len(items) > 64:
            raise ValueError("Maximal 64 Aktionen pro Liste.")
        result[phase] = [action(item, phase) for item in items]
    body = {"variables": variables(data.get("variables", {})), "actions": result}
    if "requires" in data:
        body.update(requires=condition(data["requires"]), show_unmet=flag(data,"show_unmet"))
    return body


def resolver(body, globals_):
    values = globals_ | body["variables"]
    memo = {}
    def expand(text, trail=()):
        def replace(match):
            key = match[1]
            if key in memo:
                return memo[key]
            if key in trail or len(trail) > 30:
                raise ValueError(f"Zyklischer oder zu tief verschachtelter Verweis auf {key}.")
            if key not in values:
                if key in {"ProgramFiles", "SystemRoot"}:
                    return "%" + key + "%"
                raise ValueError(f"Variable {key} fehlt.")
            memo[key] = expand(values[key], trail+(key,))
            return memo[key]
        parts, offset, length = [], 0, 0
        for match in VAR.finditer(text):
            part = text[offset:match.start()] + replace(match)
            length += len(part)
            if length > 8192:
                raise ValueError("Variablenwert ist zu lang.")
            parts.append(part)
            offset = match.end()
        value = "".join(parts) + text[offset:]
        if MARKER in value or len(value) > 8192:
            raise ValueError("Ungültiger oder zu langer Variablenwert.")
        return value
    return expand


def program_path(value):
    path = value.replace("/", "\\")
    if path.lower().startswith("%programfiles%\\"):
        path = path[len("%programfiles%\\"):]
    if (any(p in ("", ".", "..") or p.endswith((" ", ".")) for p in path.split("\\")) or
            any(c in path for c in ':*?"<>|')):
        raise ValueError("Relativen Pfad unter Program Files angeben.")
    return path


def workspace_path(value):
    path = value.replace("/", "\\")
    for part in path.split("\\"):
        if (not re.fullmatch(r"[\w .()-]{1,100}", part) or part.endswith((" ", ".")) or
                re.fullmatch(r"(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])", part.split(".")[0])):
            raise ValueError("Relativen Pfad im Bundle-Arbeitsverzeichnis angeben.")
    return path


def compile_actions(body, globals_, packages):
    resolve = resolver(body, globals_)
    if "requires" in body:
        condition(body["requires"], resolve)
    actions = {}
    for phase in PHASES:
        steps = []
        for item in body["actions"].get(phase, []):
            spec = item if isinstance(item, dict) else {"kind": DEFAULT_KIND[phase], "value": item}
            kind, value = spec["kind"], resolve(spec["value"])
            step = {"kind": kind, "value": value}
            if kind == "launch":
                step["value"] = program_path(value)
                if not step["value"].lower().endswith(".exe"):
                    raise ValueError("Start benötigt eine EXE-Datei.")
                if spec.get("environment"):
                    step["environment"] = {k:resolve(v) for k,v in spec["environment"].items()}
                if spec.get("args"):
                    step["args"] = [resolve(x) for x in spec["args"]]
                if spec.get("cwd"):
                    step["cwd"] = program_path(resolve(spec["cwd"]))
                if spec.get("wait", "none") != "none":
                    for key in ("wait","seconds","codes","kill_timeout"):
                        step[key] = spec[key]
            elif kind in FILE_KINDS:
                step["value"] = workspace_path(value)
                if kind == "copy_file":
                    step["source"] = workspace_path(resolve(spec["source"]))
                if kind == "write_text":
                    step["text"] = spec["text"]
            elif kind == "delay":
                if not value.isascii() or not value.isdigit() or not 1 <= int(value) <= 300:
                    raise ValueError("Eine Verzögerung muss 1 bis 300 Sekunden betragen.")
            else:
                digest = packages.get(value.casefold())
                if digest is None:
                    raise ValueError(f"MSI-Paket fehlt: {value}")
                step["value"] = digest
            if spec.get("requires", {}).get("rules") or "kind" in spec.get("requires", {}):
                step["requires"] = condition(spec["requires"], resolve)
                step["fail_unmet"] = spec.get("fail_unmet", False)
            if spec.get("continue_error"):
                step["continue_error"] = True
            if spec.get("enabled", True):
                steps.append(step)
        actions[phase] = steps
    return actions


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
