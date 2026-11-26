"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const sections = {
  policies: ["Richtlinien", "M5 4h14v16H5zM8 9h8m-8 4h6"],
  dashboard: ["Startseite", "M3 10L12 3l9 7M6 9v12h5v-7h3v7h4V9"],
  bundles: ["Bundles", "m3 7 9-4 9 4-9 4-9-4zm0 0v10l9 4 9-4V7m-9 4v10"],
  assignments: [
    "Zuweisungen",
    "M4 6h9m-3-3 3 3-3 3M20 18h-9m3-3-3 3 3 3M4 18h3M17 6h3",
  ],
  packages: ["MSI-Pakete", "M4 4h16v16H4zM8 8h8m-8 4h5"],
  users: [
    "Benutzer",
    "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-8 9a8 8 0 0 1 16 0",
  ],
  devices: ["Geräte", "M3 4h18v13H3zM8 21h8m-4-4v4"],
  variables: ["Variablen", "M8 4H6v6l-2 2 2 2v6h2m8-16h2v6l2 2-2 2v6h-2"],
  reports: ["Ausführungen", "M4 3h16v18H4zm3 11 3 3 6-7"],
};
const phases = {
  distribute: "Verteilen",
  install: "Installieren",
  start: "Starten",
  repair: "Reparieren",
  uninstall: "Deinstallieren",
  terminate: "Beenden",
};
const triggers = {
  manual: "Im Anwendungskatalog",
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
  objectView = null;
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
  if (objectView) {
    drawSidebar();
    renderObject();
    return;
  }
  let html;
  switch (section) {
    case "bundles":
      html = catalogPage();
      break;
    case "policies":
      html = table(
        ["Richtlinie", "Typ", "Geltungsbereich"],
        [
          [
            btn("open-policy", "Anwendungskatalog", 1),
            "Endbenutzer-Branding",
            "Alle Benutzer-Agenten",
          ],
        ],
      );
      break;
    case "dashboard":
      html = dashboardPage();
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
    case "users":
    case "devices":
      html =
        toolbar("agent", "Agent registrieren") +
        table(
          ["Installation", "Zieltyp", "Ziel", "Letzter Abruf", ""],
          state.agents
            .filter(
              (a) => a.scope === (section === "users" ? "user" : "device"),
            )
            .map((a) => [
              a.scope === "device"
                ? btn("open-device", esc(a.label), a.id)
                : esc(a.label),
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
  drawSidebar();
  document.querySelectorAll(".workspace-tabs button").forEach((button) => {
    button.setAttribute(
      "aria-current",
      button.dataset.section === section ? "page" : "false",
    );
  });
  if (section === "bundles") bindCatalog();
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
function assignmentEditor(id, initialBundle, group, scope) {
  const current = state.assignments.find((a) => a.id === id);
  const available = state.agents.filter((a) => !scope || a.scope === scope);
  if (!available.length || !state.bundles.length)
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
        bundle: group ? undefined : Number($("#bundle").value),
        group: group?.id,
        members: group?.members,
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
  if (group) {
    $("#bundle").innerHTML = options({ group: group.name });
    $("#bundle").disabled = true;
    $("#fields").insertAdjacentHTML(
      "afterbegin",
      "<p>Erstellt eine eigene Zuweisung für jedes der " +
        group.members.length +
        " aktuellen Gruppenmitglieder.</p>",
    );
  } else if (initialBundle) $("#bundle").value = initialBundle;
  const targets = new Map(
    available.map((a) => [a.scope + ":" + a.principal.toLowerCase(), a]),
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
    const members = group
      ? state.bundles.filter((b) => group.members.includes(b.id))
      : state.bundles.filter((b) => b.id === Number($("#bundle").value));
    $("#phase").innerHTML = options(
      Object.fromEntries(
        Object.entries(phases).filter(
          ([p]) =>
            members.length &&
            members.every((b) =>
              b.actions[p]?.some((x) => x.enabled !== false),
            ) &&
            (user || p !== "start"),
        ),
      ),
    );
    updateTriggers();
    $("#save").disabled = !$("#phase").value;
    $("#editor .error").textContent = $("#phase").value
      ? ""
      : "Für dieses Ziel enthält das Bundle keine passende Aktionsliste.";
  }
  function updateTriggers() {
    const previous = $("#trigger").value;
    const user =
      state.agents.find((a) => a.id === Number($("#target").value))?.scope ===
      "user";
    const allowed = Object.entries(triggers).filter(
      ([k]) =>
        (k !== "boot" || !user) &&
        (k !== "manual" || (user && ["start", "install"].includes($("#phase").value))),
    );
    $("#trigger").innerHTML = options(Object.fromEntries(allowed));
    $("#trigger").value = allowed.some(([k]) => k === previous)
      ? previous
      : "now";
    $("#date-label").hidden = $("#trigger").value !== "at";
    $("#due").required = !$("#date-label").hidden;
  }
  $("#phase").onchange = updateTriggers;
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
    updateTriggers();
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
  $("#scope").value = section === "users" ? "user" : "device";
}
async function handle(action, id) {
  if (action === "open-device") return openObject("device", id);
  if (action === "open-policy") return openObject("branding", 1);
  if (action.startsWith("detail-")) return detailAction(action.slice(7));
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
  if (action.startsWith("cat-")) return catalogAction(action.slice(4), id);
  if (action.startsWith("del-")) {
    const kind = action.slice(4);
    dialog(
      kind === "agents" ? "Agent-Zugang widerrufen" : "Eintrag entfernen",
      "<p>" +
        {
          folders: "Nur leere Ordner können entfernt werden.",
          groups:
            "Die Gruppe wird entfernt. Ihre Bundles und die erstellten Einzelzuweisungen bleiben erhalten.",
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
$("#shell").onclick = (e) => {
  const link = e.target.closest("[data-section]");
  if (link) {
    objectView = null;
    section = link.dataset.section;
    render();
    return;
  }
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
