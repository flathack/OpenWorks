"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const sections = {
  bundles: ["Bundles", "m3 7 9-4 9 4-9 4-9-4zm0 0v10l9 4 9-4V7m-9 4v10"],
  assignments: [
    "Zuweisungen",
    "M4 6h9m-3-3 3 3-3 3M20 18h-9m3-3-3 3 3 3M4 18h3M17 6h3",
  ],
  packages: ["MSI-Pakete", "M4 4h16v16H4zM8 8h8m-8 4h5"],
  agents: ["Agenten", "M3 4h18v13H3zM8 21h8m-4-4v4"],
  variables: ["Variablen", "M8 4H6v6l-2 2 2 2v6h2m8-16h2v6l2 2-2 2v6h-2"],
  reports: ["Ausführungen", "M4 3h16v18H4zm3 11 3 3 6-7"],
};
const phases = { install: "Install", start: "Start", uninstall: "Uninstall" };
const triggers = {
  now: "Beim nächsten Abruf",
  boot: "Beim Booten",
  login: "Bei Anmeldung",
  at: "Zeitgesteuert",
};
const scopes = { device: "Gerät", user: "Benutzer" };
let state,
  section = "bundles",
  submitEditor,
  timer;
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const options = (obj) =>
  Object.entries(obj)
    .map(([k, v]) => '<option value="' + esc(k) + '">' + esc(v) + "</option>")
    .join("");
const time = (n) => (n ? new Date(n * 1000).toLocaleString("de-DE") : "–");
const badge = (value) => '<span class="badge">' + esc(value) + "</span>";
const btn = (name, text, id) =>
  '<button class="quiet" data-do="' +
  name +
  '" data-id="' +
  id +
  '">' +
  text +
  "</button>";
const bundleName = (id) => state.bundles.find((b) => b.id === id)?.name ?? "–";

async function api(path, method = "GET", data) {
  const multipart = data instanceof FormData;
  const headers = { "X-CSRF": state?.csrf ?? "" };
  if (data && !multipart) headers["Content-Type"] = "application/json";
  const res = await fetch("/api/" + path, {
    method,
    headers,
    body: multipart ? data : JSON.stringify(data),
  });
  const result = await res.json();
  if (!res.ok) {
    if (res.status === 401 && path !== "login") signedOut();
    throw Error(result.error || "Anfrage fehlgeschlagen.");
  }
  return result;
}
function signedOut() {
  state = null;
  if ($("#modal").open) $("#modal").close();
  $("#shell").hidden = true;
  $("#login").hidden = false;
}
async function refresh() {
  state = await api("admin/state");
  $("#login").hidden = true;
  $("#shell").hidden = false;
  render();
}
function notice(text) {
  $("#notice").textContent = text;
  $("#notice").hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => ($("#notice").hidden = true), 5000);
}
function table(headers, rows, empty, hint = "") {
  return (
    '<div class="panel">' +
    (rows.length
      ? "<table><thead><tr>" +
        headers.map((h) => "<th>" + esc(h) + "</th>").join("") +
        "</tr></thead><tbody>" +
        rows
          .map(
            (cells) =>
              "<tr>" +
              cells
                .map(
                  (c, i) =>
                    "<td" +
                    (headers[i] === "" ? ' class="actions"' : "") +
                    ">" +
                    c +
                    "</td>",
                )
                .join("") +
              "</tr>",
          )
          .join("") +
        "</tbody></table>"
      : '<div class="empty"><strong>' +
        esc(empty) +
        "</strong>" +
        esc(hint) +
        "</div>") +
    "</div>"
  );
}
function toolbar(action, text, search = false) {
  return (
    '<div class="toolbar">' +
    (search
      ? '<input id="search" aria-label="Bundles durchsuchen" placeholder="Bundles durchsuchen …">'
      : "<span></span>") +
    '<button data-do="' +
    action +
    '">' +
    text +
    "</button></div>"
  );
}
function bundleTable(filter = "") {
  return table(
    ["Bundle", "Revision", "Aktionen", "Zuweisungen", ""],
    state.bundles
      .filter((b) => b.name.toLowerCase().includes(filter.toLowerCase()))
      .map((b) => [
        esc(b.name),
        badge("R" + b.revision),
        Object.values(b.actions).flat().length,
        state.assignments.filter((a) => a.bundle === b.id).length,
        btn("bundle", "Bearbeiten", b.id) +
          btn("del-bundles", "Entfernen", b.id),
      ]),
    filter ? "Keine passenden Bundles" : "Noch keine Bundles",
    filter ? "" : "Lege ein Bundle an und stelle seine Aktionen zusammen.",
  );
}
function render() {
  $("nav").innerHTML = Object.entries(sections)
    .map(
      ([key, [label, path]]) =>
        '<button data-section="' +
        key +
        '" aria-current="' +
        (section === key ? "page" : "false") +
        '"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="' +
        path +
        '"/></svg>' +
        label +
        "</button>",
    )
    .join("");
  $("#heading").textContent = sections[section][0];
  let html;
  switch (section) {
    case "bundles":
      html =
        '<div class="gridstats">' +
        [
          ["Bundles", state.bundles.length],
          ["Zuweisungen", state.assignments.length],
          ["Agenten", state.agents.length],
        ]
          .map(
            ([name, n]) =>
              '<div class="stat"><span>' +
              name +
              "</span><strong>" +
              n +
              "</strong></div>",
          )
          .join("") +
        "</div>" +
        toolbar("bundle", "Bundle anlegen", true) +
        '<div id="bundle-table">' +
        bundleTable() +
        "</div>";
      break;
    case "packages":
      html =
        toolbar("upload", "MSI hochladen") +
        table(
          ["Paketname", "Größe", "SHA-256"],
          state.packages.map((p) => [
            esc(p.name),
            (p.size / 1048576).toFixed(2) + " MiB",
            '<code title="' +
              esc(p.digest) +
              '">' +
              esc(p.digest.slice(0, 16)) +
              "…</code>",
          ]),
          "Noch keine MSI-Pakete",
          "Lade ein MSI hoch, um es in Install- und Uninstall-Aktionen zu verwenden.",
        );
      break;
    case "agents":
      html =
        toolbar("agent", "Agent registrieren") +
        table(
          ["Installation", "Zieltyp", "Ziel", "Letzter Abruf", ""],
          state.agents.map((a) => [
            esc(a.label),
            badge(scopes[a.scope]),
            esc(a.principal),
            time(a.last_seen),
            btn("del-agents", "Zugang widerrufen", a.id),
          ]),
          "Noch keine Agenten",
          "Registriere ein Gerät oder eine Benutzerinstallation, um ein Token zu erhalten.",
        );
      break;
    case "assignments":
      html =
        toolbar("assign", "Zuweisung anlegen") +
        table(
          ["Bundle", "Ziel", "Aktionsliste", "Auslöser", ""],
          state.assignments.map((a) => [
            esc(bundleName(a.bundle)),
            esc(scopes[a.scope] + " · " + a.principal),
            badge(phases[a.phase]),
            esc(a.trigger === "at" ? time(a.due) : triggers[a.trigger]),
            btn("assign", "Bearbeiten", a.id) +
              btn("del-assignments", "Entfernen", a.id),
          ]),
          "Noch keine Zuweisungen",
          "Eine Zuweisung verbindet Bundle, Ziel und Auslöser.",
        );
      break;
    case "variables":
      html =
        toolbar("globals", "Variablen bearbeiten") +
        table(
          ["Name", "Globaler Wert"],
          Object.entries(state.variables).map(([k, v]) => [esc(k), esc(v)]),
          "Keine globalen Variablen",
          "Bundle-Variablen können gleichnamige globale Werte überschreiben.",
        );
      break;
    case "reports":
      html =
        toolbar("refresh", "Aktualisieren") +
        table(
          ["Bundle", "Agent", "Ergebnis", "Meldung", "Zeitpunkt"],
          state.reports.map((r) => {
            const assignment = state.assignments.find(
              (a) => a.id === r.assignment,
            );
            return [
              esc(bundleName(assignment?.bundle)),
              esc(state.agents.find((a) => a.id === r.agent)?.label),
              badge(r.status === "ok" ? "Erfolgreich" : "Fehler"),
              esc(r.detail),
              time(r.seen),
            ];
          }),
          "Noch keine Rückmeldungen",
          "Hier erscheint das letzte Ergebnis je Agent und Zuweisung.",
        );
      break;
  }
  $("#page").innerHTML = html;
  $("#search")?.addEventListener(
    "input",
    (e) => ($("#bundle-table").innerHTML = bundleTable(e.target.value)),
  );
}
function dialog(title, fields, handler, save = "Speichern") {
  $("#modal-title").textContent = title;
  $("#fields").innerHTML = fields;
  $("#editor .error").textContent = "";
  $("#save").textContent = save;
  $("#save").hidden = false;
  $("#save").disabled = false;
  $("#cancel").textContent = "Abbrechen";
  submitEditor = handler;
  if (!$("#modal").open) $("#modal").showModal();
}
function variableEditor(values) {
  const box = document.createElement("div");
  const rows = document.createElement("div");
  const add = document.createElement("button");
  add.type = "button";
  add.className = "secondary";
  add.textContent = "Variable hinzufügen";
  function row(key = "", value = "") {
    const line = document.createElement("div");
    line.className = "varrow";
    line.innerHTML =
      '<input required aria-label="Variablenname" placeholder="NAME" pattern="[A-Za-z_][A-Za-z0-9_]*"><input aria-label="Wert" placeholder="Wert"><button type="button" class="quiet" aria-label="Variable entfernen">×</button>';
    line.children[0].value = key;
    line.children[1].value = value;
    line.lastChild.onclick = () => line.remove();
    rows.append(line);
  }
  Object.entries(values).forEach(([k, v]) => row(k, v));
  add.onclick = () => row();
  box.append(rows, add);
  return {
    box,
    read: () => {
      const result = Object.create(null);
      for (const el of rows.children) {
        const [key, val] = el.children;
        if (Object.hasOwn(result, key.value))
          throw Error("Doppelter Variablenname.");
        result[key.value] = val.value;
      }
      return result;
    },
  };
}
function bundleEditor(id) {
  const b = state.bundles.find((b) => b.id === id) ?? {
    name: "",
    actions: { install: [], start: [], uninstall: [] },
    variables: {},
  };
  const actions = structuredClone(b.actions);
  const vars = variableEditor(b.variables);
  let phase = "install";
  dialog(
    id ? "Bundle bearbeiten" : "Bundle anlegen",
    '<label>Bundle-Name<input id="bname" maxlength="180" required></label><h3>Aktionslisten</h3><div class="tabs" id="phases"></div><p id="help" class="sub"></p><div id="steps"></div><datalist id="pkgs">' +
      state.packages
        .map((p) => '<option value="' + esc(p.name) + '">')
        .join("") +
      '</datalist><button type="button" class="secondary" id="add-step">Aktion hinzufügen</button><h3>Bundle-Variablen</h3><div id="bundle-vars"></div>',
    async () => {
      await api("admin/bundles", "POST", {
        id: b.id,
        revision: b.revision,
        name: $("#bname").value,
        variables: vars.read(),
        actions,
      });
    },
  );
  $("#bname").value = b.name;
  $("#bundle-vars").append(vars.box);
  function draw() {
    $("#phases").replaceChildren();
    $("#steps").replaceChildren();
    for (const [k, label] of Object.entries(phases)) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.textContent = label + " (" + actions[k].length + ")";
      tab.setAttribute("aria-pressed", String(k === phase));
      tab.onclick = () => {
        phase = k;
        draw();
      };
      $("#phases").append(tab);
    }
    $("#help").textContent =
      phase === "start"
        ? "EXE-Pfad relativ zu Program Files. Start erfolgt in der Benutzersitzung."
        : "MSI-Paketname aus dem Katalog oder ein Platzhalter wie " +
          String.fromCharCode(36) +
          "{PAKET}.";
    actions[phase].forEach((value, i) => {
      const row = document.createElement("div");
      row.className = "step";
      row.innerHTML =
        "<span>" +
        String(i + 1).padStart(2, "0") +
        '</span><input required aria-label="Aktion ' +
        (i + 1) +
        '" ' +
        (phase === "start"
          ? 'placeholder="Hersteller\\App.exe"'
          : 'list="pkgs" placeholder="Paket.msi"') +
        '><button type="button" class="quiet" aria-label="Nach oben">↑</button><button type="button" class="quiet" aria-label="Nach unten">↓</button><button type="button" class="quiet" aria-label="Aktion entfernen">×</button>';
      const [, field, up, down, remove] = row.children;
      field.value = value;
      field.oninput = () => (actions[phase][i] = field.value);
      const move = (delta) => {
        const list = actions[phase];
        [list[i], list[i + delta]] = [list[i + delta], list[i]];
        draw();
      };
      up.disabled = i === 0;
      up.onclick = () => move(-1);
      down.disabled = i === actions[phase].length - 1;
      down.onclick = () => move(1);
      remove.onclick = () => {
        actions[phase].splice(i, 1);
        draw();
      };
      $("#steps").append(row);
    });
  }
  $("#add-step").onclick = () => {
    actions[phase].push("");
    draw();
    $("#steps").lastChild.querySelector("input").focus();
  };
  draw();
}
function assignmentEditor(id) {
  const current = state.assignments.find((a) => a.id === id);
  if (!state.agents.length || !state.bundles.length)
    return notice("Zuerst ein Bundle und einen Agenten anlegen.");
  dialog(
    current ? "Zuweisung bearbeiten" : "Zuweisung anlegen",
    '<label>Bundle<select id="bundle"></select></label><label>Ziel<select id="target"></select></label><div class="pair"><label>Aktionsliste<select id="phase"></select></label><label>Auslöser<select id="trigger"></select></label></div><label id="date-label" hidden>Lokaler Zeitpunkt<input type="datetime-local" id="due"></label>',
    async () => {
      const a = state.agents.find((a) => a.id === Number($("#target").value));
      await api("admin/assignments", "POST", {
        id: current?.id,
        generation: current?.generation,
        scope: a.scope,
        principal: a.principal,
        bundle: Number($("#bundle").value),
        phase: $("#phase").value,
        trigger: $("#trigger").value,
        due: $("#due").value
          ? Math.floor(new Date($("#due").value).getTime() / 1000)
          : null,
      });
    },
  );
  $("#bundle").innerHTML = options(
    Object.fromEntries(state.bundles.map((b) => [b.id, b.name])),
  );
  const targets = new Map(
    state.agents.map((a) => [a.scope + ":" + a.principal.toLowerCase(), a]),
  );
  $("#target").innerHTML = options(
    Object.fromEntries(
      Array.from(targets.values(), (a) => [
        a.id,
        scopes[a.scope] + " · " + a.principal,
      ]),
    ),
  );
  function choices() {
    const user =
      state.agents.find((a) => a.id === Number($("#target").value)).scope ===
      "user";
    const b = state.bundles.find((b) => b.id === Number($("#bundle").value));
    $("#phase").innerHTML = options(
      Object.fromEntries(
        Object.entries(phases).filter(
          ([p]) => b.actions[p].length && (user || p !== "start"),
        ),
      ),
    );
    $("#trigger").innerHTML = options(
      Object.fromEntries(
        Object.entries(triggers).filter(([t]) => t !== "boot" || !user),
      ),
    );
    $("#date-label").hidden = true;
    $("#due").required = false;
    $("#save").disabled = !$("#phase").value;
    $("#editor .error").textContent = $("#phase").value
      ? ""
      : "Für dieses Ziel enthält das Bundle keine passende Aktionsliste.";
  }
  $("#bundle").onchange = choices;
  $("#target").onchange = choices;
  $("#trigger").onchange = () => {
    const at = $("#trigger").value === "at";
    $("#date-label").hidden = !at;
    $("#due").required = at;
  };
  if (current) {
    $("#bundle").value = current.bundle;
    const target = targets.get(
      current.scope + ":" + current.principal.toLowerCase(),
    );
    if (target) $("#target").value = target.id;
  }
  choices();
  if (current) {
    if (Array.from($("#phase").options).some((o) => o.value === current.phase))
      $("#phase").value = current.phase;
    $("#trigger").value = current.trigger;
    $("#trigger").onchange();
    if (current.due) {
      const local = new Date(current.due * 1000);
      $("#due").value = new Date(
        local.getTime() - local.getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 16);
    }
  }
}
function agentEditor() {
  dialog(
    "Agent registrieren",
    '<label>Zieltyp<select id="scope">' +
      options(scopes) +
      '</select></label><label>Zielkennung<input id="principal" required placeholder="PC-023 oder DOMÄNE\\Benutzer"></label><label>Name dieser Installation<input id="label" required placeholder="z. B. Büro-PC"></label><p class="sub">Verwende für denselben Benutzer auf mehreren Geräten dieselbe Zielkennung und je Installation ein eigenes Token.</p>',
    async () => {
      const { token } = await api("admin/agents", "POST", {
        scope: $("#scope").value,
        principal: $("#principal").value,
        label: $("#label").value,
      });
      dialog(
        "Agent-Token",
        '<label>Einmalig angezeigtes Token<input class="token" id="token" readonly></label><p>Gib dieses Token beim Einrichten mit Install-Agent.ps1 ein.</p>',
        null,
      );
      $("#token").value = token;
      $("#token").select();
      $("#save").hidden = true;
      $("#cancel").textContent = "Fertig";
      return false;
    },
    "Token erstellen",
  );
}
async function handle(action, id) {
  if (action === "refresh") return refresh();
  if (action === "bundle") return bundleEditor(id);
  if (action === "assign") return assignmentEditor(id);
  if (action === "agent") return agentEditor();
  if (action === "globals") {
    const vars = variableEditor(state.variables);
    dialog("Globale Variablen", "", () =>
      api("admin/variables", "POST", { variables: vars.read() }),
    );
    $("#fields").append(vars.box);
  }
  if (action === "upload")
    dialog(
      "MSI-Paket hochladen",
      '<label>Windows-Installer-Paket<input name="file" type="file" accept=".msi" required></label><p class="sub">Maximal 512 MiB. Verwende für neue Versionen einen eigenen Dateinamen.</p>',
      () => api("admin/packages", "POST", new FormData($("#editor"))),
      "Hochladen",
    );
  if (action.startsWith("del-")) {
    const kind = action.slice(4);
    dialog(
      kind === "agents" ? "Agent-Zugang widerrufen" : "Eintrag entfernen",
      "<p>" +
        {
          agents: "Dieser Agent kann anschließend keine Bundles mehr abrufen.",
          assignments:
            "Die Regel entfällt beim nächsten Abruf. Installierte Software bleibt auf dem Ziel.",
          bundles:
            "Das Bundle wird aus dem Katalog entfernt. Vorhandene Zuweisungen müssen zuerst entfernt werden.",
        }[kind] +
        "</p>",
      () => api("admin/" + kind + "/" + id, "DELETE"),
      "Bestätigen",
    );
  }
}
$("nav").onclick = (e) => {
  const b = e.target.closest("[data-section]");
  if (b) {
    section = b.dataset.section;
    render();
  }
};
$("#page").onclick = (e) => {
  const b = e.target.closest("[data-do]");
  if (b)
    handle(b.dataset.do, Number(b.dataset.id)).catch((err) =>
      notice(err.message),
    );
};
$("#close").onclick = $("#cancel").onclick = () => $("#modal").close();
$("#modal").onclose = () => {
  $("#fields").replaceChildren();
  submitEditor = null;
};
$("#editor").onsubmit = async (e) => {
  e.preventDefault();
  if (!submitEditor) return;
  $("#save").disabled = true;
  try {
    const close = await submitEditor();
    if (close !== false) $("#modal").close();
    await refresh();
  } catch (err) {
    $("#editor .error").textContent = err.message;
  } finally {
    $("#save").disabled = false;
  }
};
$("#login-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("login", "POST", { password: e.target.password.value });
    e.target.reset();
    $(".welcome .error").textContent = "";
    await refresh();
  } catch (err) {
    $(".welcome .error").textContent = err.message;
  }
};
$("#logout").onclick = async () => {
  try {
    await api("admin/logout", "POST", {});
    signedOut();
  } catch (err) {
    notice(err.message);
  }
};
refresh().catch((err) => {
  if ($("#login").hidden) {
    signedOut();
    notice(err.message);
  }
});
