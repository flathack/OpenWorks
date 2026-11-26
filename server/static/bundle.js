"use strict";
const actionNames = {
  launch: "Ausführbare Datei aufrufen",
  cache: "MSI-Paket verteilen",
  install: "MSI installieren",
  repair: "MSI reparieren",
  uninstall: "MSI deinstallieren",
  uncache: "MSI aus dem Agent-Cache entfernen",
  mkdir: "Verzeichnis erstellen",
  rmdir: "Leeres Verzeichnis löschen",
  write_text: "Textdatei installieren",
  copy_file: "Datei kopieren",
  remove_file: "Datei entfernen",
  delay: "Verzögerung",
};
const phaseDefaults = {
  distribute: "cache",
  install: "install",
  start: "launch",
  repair: "repair",
  uninstall: "uninstall",
  terminate: "uncache",
};
const filters = {
  memory: "Arbeitsspeicher (mindestens MiB)",
  free_disk: "Freier Speicher auf dem Systemlaufwerk (mindestens MiB)",
  service: "Dienst vorhanden",
  running: "Dienst wird ausgeführt",
  file: "Ordner/Datei vorhanden",
  registry: "Registrierungsschlüssel vorhanden",
  architecture: "Architektur",
  hostname: "Angegebenes Gerät",
  windows: "Betriebssystem",
};
const filterHints = {
  memory: "8192",
  free_disk: "1024",
  service: "Dienstname",
  running: "Dienstname",
  file: "%ProgramFiles%\\Anwendung\\App.exe",
  registry: "HKLM\\SOFTWARE\\Hersteller",
  architecture: "AMD64, ARM64 oder x86",
  hostname: "Computername",
  windows: "Windows",
};
const emptyGroup = () => ({ mode: "all", rules: [] });
function stepSpec(raw, phase) {
  return typeof raw === "string"
    ? { kind: phaseDefaults[phase], name: raw, value: raw }
    : raw;
}
function conditionText(node) {
  if (!node || node.rules?.length === 0) return "Keine Anforderungen";
  if (node.rules)
    return (
      "(" +
      node.rules
        .map(conditionText)
        .join(node.mode === "all" ? " und " : " oder ") +
      ")"
    );
  return `${filters[node.kind]} · ${node.value} · ${node.expected === false ? "Nein" : "Ja"}`;
}
function button(label, callback) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "secondary";
  el.textContent = label;
  el.onclick = callback;
  return el;
}
function editableCondition(node) {
  if (!node) return emptyGroup();
  return structuredClone(node.rules ? node : { mode: "all", rules: [node] });
}
function conditionEditor(root) {
  const box = document.createElement("div");
  box.className = "conditions";
  function draw(node, depth) {
    const group = document.createElement("fieldset");
    group.innerHTML = `<legend>Filtersatz</legend><label>Filter kombinieren durch <select>${options({ all: "und", any: "oder" })}</select></label>`;
    const mode = group.querySelector("select");
    mode.value = node.mode;
    mode.onchange = () => (node.mode = mode.value);
    node.rules.forEach((rule, index) => {
      const row = document.createElement("div");
      row.className = "condition-row";
      if (rule.rules) row.append(draw(rule, depth + 1));
      else {
        row.innerHTML = `<select aria-label="Filtertyp">${options(filters)}</select><input required aria-label="Filterwert"><select aria-label="Erwartet"><option value="yes">Ja</option><option value="no">Nein</option></select>`;
        const [kind, val, expected] = row.children;
        kind.value = rule.kind;
        val.value = rule.value;
        val.placeholder = filterHints[rule.kind];
        expected.value = rule.expected === false ? "no" : "yes";
        kind.onchange = () => {
          rule.kind = kind.value;
          rule.value = kind.value === "windows" ? "Windows" : "";
          render();
        };
        val.oninput = () => (rule.value = val.value);
        expected.onchange = () => (rule.expected = expected.value === "yes");
      }
      row.append(
        button("Entfernen", () => {
          node.rules.splice(index, 1);
          render();
        }),
      );
      group.append(row);
    });
    if (node.rules.length < 16) {
      group.append(
        button("Filter hinzufügen", () => {
          node.rules.push({ kind: "file", value: "", expected: true });
          render();
        }),
      );
      if (depth < 3)
        group.append(
          button("Filtersatz hinzufügen", () => {
            node.rules.push(emptyGroup());
            render();
          }),
        );
    }
    return group;
  }
  function render() {
    box.replaceChildren(draw(root, 0));
  }
  render();
  return box;
}
function actionDialog(old, accept) {
  const a = structuredClone(old);
  const requirements = editableCondition(a.requires);
  const launch = a.kind === "launch";
  const dlg = document.createElement("dialog");
  dlg.className = "action-dialog";
  document.body.append(dlg);
  const tabs = launch
    ? ["Allgemein", "Erweitert", "Startoptionen", "Anforderungen"]
    : ["Allgemein", "Anforderungen"];
  const managedFile = [
    "mkdir",
    "rmdir",
    "write_text",
    "copy_file",
    "remove_file",
  ].includes(a.kind);
  const environment = launch && variableEditor(a.environment || {});
  const label = managedFile
    ? "Zielpfad im Bundle-Arbeitsverzeichnis"
    : launch
      ? "Befehl"
      : a.kind === "delay"
        ? "Wartedauer in Sekunden"
        : "Paketname";
  dlg.innerHTML = `<form><header class="modal-head"><h2>${esc(actionNames[a.kind])}</h2></header><div class="action-fields"><label>Aktionsname<input name="name" maxlength="180" required></label><div class="tabs sub-tabs"></div>
    <section data-pane="Allgemein"><label>${label}<input name="value" required ${a.kind === "delay" ? 'type="number" min="1" max="300"' : managedFile ? "" : launch ? 'placeholder="Hersteller\\App.exe"' : 'list="action-packages"'}></label>
    <datalist id="action-packages">${state.packages.map((p) => `<option value="${esc(p.name)}">`).join("")}</datalist>
    ${a.kind === "copy_file" ? '<label>Quelldatei im Bundle-Arbeitsverzeichnis<input name="source" required></label>' : ""}
    ${a.kind === "write_text" ? '<label>Dateiinhalt (UTF-8, maximal 64 KiB)<textarea name="text" rows="6"></textarea></label><label>Textdatei einlesen<input name="importFile" type="file" accept=".txt,.xml,.ini,.cfg,.json,.conf,.csv"></label>' : ""}
    ${managedFile ? '<p class="sub">Pfade sind relativ zum Arbeitsverzeichnis dieses Bundles auf dem Agenten. Übergeordnete Ordner mit einer Verzeichnisaktion anlegen.</p>' : ""}
    ${launch ? '<label>Befehlszeilenparameter (ein Argument je Zeile)<textarea name="args" rows="3"></textarea></label><label>Erfolgreiche Rückgabecodes<input name="codes" placeholder="0, 3010"></label>' : ""}
    <label class="check"><input type="checkbox" name="enabled">Aktiviert</label><label class="check"><input type="checkbox" name="continue_error">Bei Fehler fortfahren</label></section>
    ${
      launch
        ? `<section data-pane="Erweitert"><label>Vor der nächsten Aktion<select name="wait">${options({ none: "Nicht warten", exit: "Auf Prozessende warten", timeout: "Maximale Wartedauer" })}</select></label><div class="timing"><label>Wartedauer in Sekunden<input name="seconds" type="number" min="1" max="86400"></label><label class="check"><input type="checkbox" name="kill_timeout">Gestarteten Prozess bei Zeitablauf beenden</label></div></section>
    <section data-pane="Startoptionen"><label>Arbeitsverzeichnis unter Program Files<input name="cwd"></label><h3>Umgebungsvariablen</h3><div class="process-env"></div><dl class="record-fields"><div><dt>Ausführungskontext</dt><dd>Angemeldeter Benutzer</dd></div></dl></section>`
        : ""
    }
    <section data-pane="Anforderungen"><div class="action-conditions"></div><label class="check"><input type="checkbox" name="fail_unmet">Fehler melden, wenn die Anforderungen nicht erfüllt sind</label></section>
    </div><p class="error" role="alert"></p><footer><button type="button" class="secondary" data-cancel>Abbrechen</button><button>OK</button></footer></form>`;
  const form = dlg.querySelector("form"),
    fields = form.elements;
  for (const key of [
    "name",
    "value",
    "cwd",
    "seconds",
    "wait",
    "source",
    "text",
  ]) {
    if (fields[key])
      fields[key].value = a[key] ?? ({ seconds: 60, wait: "none" }[key] || "");
  }
  if (launch) {
    dlg.querySelector(".process-env").append(environment.box);
    fields.args.value = (a.args || []).join("\n");
    fields.codes.value = (a.codes || [0]).join(", ");
    const timing = () =>
      (dlg.querySelector(".timing").hidden = fields.wait.value !== "timeout");
    fields.wait.onchange = timing;
    timing();
  }
  for (const key of [
    "enabled",
    "continue_error",
    "fail_unmet",
    "kill_timeout",
  ]) {
    if (fields[key]) fields[key].checked = a[key] ?? key === "enabled";
  }
  dlg.querySelector(".action-conditions").append(conditionEditor(requirements));
  function tab(name) {
    for (const pane of dlg.querySelectorAll("[data-pane]"))
      pane.hidden = pane.dataset.pane !== name;
    for (const t of dlg.querySelectorAll(".tabs button"))
      t.setAttribute("aria-pressed", String(t.textContent === name));
  }
  for (const name of tabs)
    dlg.querySelector(".tabs").append(button(name, () => tab(name)));
  tab("Allgemein");
  if (fields.importFile)
    fields.importFile.onchange = async () => {
      const file = fields.importFile.files[0];
      if (!file) return;
      if (file.size > 65536) {
        dlg.querySelector(".error").textContent =
          "Die Datei überschreitet 64 KiB.";
        return;
      }
      fields.text.value = await file.text();
      if (!fields.value.value) fields.value.value = file.name;
    };
  form.noValidate = true;
  form.onsubmit = (e) => {
    e.preventDefault();
    const invalid = form.querySelector(":invalid");
    if (invalid) {
      tab(invalid.closest("[data-pane]")?.dataset.pane || "Allgemein");
      invalid.reportValidity();
      return;
    }
    a.name = fields.name.value.trim();
    a.value = fields.value.value.trim();
    a.enabled = fields.enabled.checked;
    a.continue_error = fields.continue_error.checked;
    a.requires = requirements;
    a.fail_unmet = fields.fail_unmet.checked;
    if (fields.source) a.source = fields.source.value;
    if (fields.text) a.text = fields.text.value;
    if (launch) {
      try {
        a.environment = environment.read();
      } catch (error) {
        tab("Startoptionen");
        dlg.querySelector(".error").textContent = error.message;
        return;
      }
      a.wait = fields.wait.value;
      a.seconds = Number(fields.seconds.value);
      a.kill_timeout = fields.kill_timeout.checked;
      a.args = fields.args.value ? fields.args.value.split(/\r?\n/) : [];
      a.cwd = fields.cwd.value.trim();
      const codes = (fields.codes.value.trim() || "0")
        .split(",")
        .map((x) => x.trim());
      if (codes.some((x) => !/^-?\d+$/.test(x))) {
        tab("Allgemein");
        dlg.querySelector(".error").textContent =
          "Rückgabecodes als ganze Zahlen angeben.";
        return;
      }
      a.codes = codes.map(Number);
    }
    accept(a);
    dlg.close();
  };
  dlg.querySelector("[data-cancel]").onclick = () => dlg.close();
  dlg.onclose = () => dlg.remove();
  dlg.showModal();
}
function actionTable(steps, phase, selected = -1) {
  return table(
    ["", "Name", "Typ", "Status", "Anforderungen", "Bei Fehler fortfahren"],
    steps.map((raw, i) => {
      const a = stepSpec(raw, phase);
      return [
        `<input type="radio" name="selected-step" aria-label="Aktion ${i + 1} auswählen" value="${i}" ${selected === i ? "checked" : ""}>`,
        `<button type="button" class="quiet action-name" data-step="${i}">${esc(a.name)}</button>`,
        esc(actionNames[a.kind]),
        a.enabled === false ? "Deaktiviert" : "Aktiviert",
        esc(conditionText(a.requires)),
        a.continue_error ? "Ja" : "Nein",
      ];
    }),
    "Keine Aktionen",
  );
}
function bundleEditor(
  id,
  sandbox = false,
  initialTab = "Allgemein",
  initialPhase = "install",
  initialStep = null,
) {
  const b = state.bundles.find((x) => x.id === id) || {
    name: "",
    variables: {},
    actions: {},
  };
  const draft = sandbox && state.drafts.find((d) => d.bundle === id);
  const source = draft || b,
    actions = structuredClone(source.actions);
  for (const p of Object.keys(phases)) actions[p] ??= [];
  const vars = variableEditor(source.variables),
    requirement = editableCondition(source.requires);
  let phase = initialPhase,
    selected = -1;
  dialog(
    sandbox
      ? "Sandbox bearbeiten"
      : id
        ? "Bundle bearbeiten"
        : "Bundle anlegen",
    `<div class="bundle-workbench"><div class="tabs edit-tabs"></div><section data-editor-pane="Allgemein"><label>Bundle-Name<input id="bname" maxlength="180" required></label>${sandbox ? "" : `<div class="pair"><label>Ordner<select id="bundle-folder">${folderOptions(b.id ? b.folder : catalog.folder)}</select></label><label>Kategorie<input id="category" maxlength="100"></label></div>`}</section>
    <section data-editor-pane="Aktionen"><div class="tabs sub-tabs" id="phases"></div><div class="action-bar"></div><div id="steps"></div></section>
    <section data-editor-pane="Anforderungen"><label class="check"><input type="checkbox" id="show-unmet">Anwendungssymbol anzeigen, wenn Systemanforderungen nicht erfüllt werden</label><div id="bundle-requirements"></div></section>
    <section data-editor-pane="Systemvariablen">${panel("Vererbte Variablen", variableTable(state.variables))}<h3>Bundle-Variablen</h3><div id="bundle-vars"></div></section></div>`,
    async () => {
      const data = {
        variables: vars.read(),
        actions,
        requires: requirement,
        show_unmet: $("#show-unmet").checked,
      };
      if (sandbox)
        return api("admin/sandbox/" + id, "POST", {
          ...data,
          action: "save",
          stamp: draft?.stamp,
          base: draft?.base ?? b.revision,
        });
      return api("admin/bundles", "POST", {
        ...data,
        id: b.id,
        revision: b.revision,
        name: $("#bname").value,
        folder: Number($("#bundle-folder").value) || null,
        category: $("#category").value,
      });
    },
    sandbox ? "Entwurf speichern" : "Speichern",
  );
  $("#bname").value = b.name;
  $("#bname").readOnly = sandbox;
  if (!sandbox) $("#category").value = b.category || "";
  $("#bundle-vars").append(vars.box);
  $("#show-unmet").checked = !!source.show_unmet;
  $("#bundle-requirements").append(conditionEditor(requirement));
  function show(tab) {
    for (const pane of document.querySelectorAll("[data-editor-pane]"))
      pane.hidden = pane.dataset.editorPane !== tab;
    for (const el of document.querySelectorAll(".edit-tabs button"))
      el.setAttribute("aria-pressed", String(el.textContent === tab));
  }
  for (const tab of [
    "Allgemein",
    "Aktionen",
    "Anforderungen",
    "Systemvariablen",
  ])
    $(".edit-tabs").append(button(tab, () => show(tab)));
  // Reveal a hidden tab before the browser focuses an invalid field on save.
  $("#fields").addEventListener(
    "invalid",
    function reveal(e) {
      const pane = e.target.closest("[data-editor-pane]");
      if (pane) show(pane.dataset.editorPane);
    },
    { capture: true, signal: editorLifetime() },
  );
  function edit(index, kind) {
    const list = actions[phase];
    const a =
      index === null
        ? { kind, name: actionNames[kind], value: kind === "delay" ? "1" : "" }
        : stepSpec(list[index], phase);
    actionDialog(a, (changed) => {
      selected = index === null ? list.length : index;
      list[selected] = changed;
      draw();
    });
  }
  function draw() {
    const list = actions[phase],
      active = selected >= 0 && selected < list.length;
    const spec = active && stepSpec(list[selected], phase);
    $("#phases").replaceChildren();
    for (const [key, label] of Object.entries(phases)) {
      const t = button(label, () => {
        phase = key;
        selected = -1;
        draw();
      });
      t.setAttribute("aria-pressed", String(key === phase));
      $("#phases").append(t);
    }
    const bar = $(".action-bar");
    bar.replaceChildren();
    const add = document.createElement("select");
    add.setAttribute("aria-label", "Aktion hinzufügen");
    add.innerHTML =
      '<option value="">Hinzufügen …</option>' +
      options(
        Object.fromEntries(
          Object.entries(actionNames).filter(
            ([k]) => k !== "launch" || phase === "start",
          ),
        ),
      );
    add.onchange = () => {
      const kind = add.value;
      add.value = "";
      edit(null, kind);
    };
    bar.append(add);
    function tool(name, func, enabled = active) {
      const b = button(name, () => {
        func();
        draw();
      });
      b.disabled = !enabled;
      bar.append(b);
    }
    tool("Entfernen", () => {
      list.splice(selected, 1);
      selected = -1;
    });
    function move(delta) {
      const [item] = list.splice(selected, 1);
      selected += delta;
      list.splice(selected, 0, item);
    }
    tool("Nach oben", () => move(-1), active && selected > 0);
    tool("Nach unten", () => move(1), active && selected < list.length - 1);
    tool("Duplizieren", () => {
      const copy = structuredClone(spec);
      copy.name += " (Kopie)";
      list.splice(++selected, 0, copy);
    });
    tool(spec?.enabled === false ? "Aktivieren" : "Deaktivieren", () => {
      list[selected] = { ...spec, enabled: spec.enabled === false };
    });
    const dest = document.createElement("select");
    dest.setAttribute("aria-label", "Aktion verlagern");
    dest.innerHTML =
      '<option value="">Verlagern …</option>' +
      options(
        Object.fromEntries(
          Object.entries(phases).filter(
            ([key]) =>
              key !== phase && (spec?.kind !== "launch" || key === "start"),
          ),
        ),
      );
    dest.disabled = !active || spec?.kind === "launch";
    dest.onchange = () => {
      actions[dest.value].push(spec);
      list.splice(selected, 1);
      phase = dest.value;
      selected = actions[phase].length - 1;
      draw();
    };
    bar.append(dest);
    $("#steps").innerHTML = actionTable(list, phase, selected);
    for (const b of $("#steps").querySelectorAll("[data-step]"))
      b.onclick = () => edit(Number(b.dataset.step));
    for (const r of $("#steps").querySelectorAll("input"))
      r.onchange = () => {
        selected = Number(r.value);
        draw();
      };
  }
  show(initialTab);
  draw();
  if (initialStep !== null) edit(initialStep);
}
function editorLifetime() {
  const controller = new AbortController();
  $("#modal").addEventListener("close", () => controller.abort(), {
    once: true,
  });
  return controller.signal;
}
function variableTable(values) {
  return table(
    ["Name", "Wert"],
    Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [esc(k), esc(v)]),
    "Keine Variablen",
  );
}
