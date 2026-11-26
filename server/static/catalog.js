"use strict";
const catalog = {
  folder: null,
  selected: new Set(),
  filters: {},
  page: 1,
  size: 25,
  descending: false,
};
const objectTypes = {
  folder: "Ordner",
  group: "Bundle-Gruppe",
  bundle: "Windows-Bundle",
};
function folderTrail(id) {
  const parts = [];
  while (id) {
    const folder = state.folders.find((f) => f.id === id);
    if (!folder) break;
    parts.unshift(folder);
    id = folder.parent;
  }
  return parts;
}
function folderOptions(selected) {
  const list = state.folders.map((f) => [
    f.id,
    folderTrail(f.id)
      .map((x) => x.name)
      .join(" / "),
  ]);
  list.sort((a, b) => a[1].localeCompare(b[1], "de"));
  return [[0, "Bundles"], ...list]
    .map(
      ([id, name]) =>
        `<option value="${id}" ${id === (selected || 0) ? "selected" : ""}>${esc(name)}</option>`,
    )
    .join("");
}
function command(action, label, id = 0, extra = "") {
  return `<button type="button" data-do="cat-${action}" data-id="${id}" ${extra}>${esc(label)}</button>`;
}
function pins() {
  try {
    return JSON.parse(localStorage.getItem("openworks.bundlePins") || "[]");
  } catch {
    return [];
  }
}
function drawSidebar() {
  const favorites = state.bundles.filter((b) => pins().includes(b.id));
  $("#favorites").innerHTML = favorites.length
    ? favorites.map((b) => command("open-bundle", b.name, b.id)).join("")
    : "<small>Keine angehefteten Bundles</small>";
}
function dashboardPage() {
  const counts = [
    ["bundles", "Bundles", state.bundles.length],
    ["assignments", "Zuweisungen", state.assignments.length],
    [
      "devices",
      "Geräte-Agenten",
      state.agents.filter((a) => a.scope === "device").length,
    ],
    [
      "users",
      "Benutzer-Agenten",
      state.agents.filter((a) => a.scope === "user").length,
    ],
    ["reports", "Fehlermeldungen", state.error_count],
  ];
  return (
    `<div class="metrics">${counts.map(([key, label, n]) => `<button data-section="${key}"><strong>${n}</strong>${label}</button>`).join("")}</div><h2>Letzte Agentenabrufe</h2>` +
    table(
      ["Installation", "Ziel", "Zeitpunkt"],
      state.agents
        .filter((a) => a.last_seen)
        .sort((a, b) => b.last_seen - a.last_seen)
        .slice(0, 8)
        .map((a) => [esc(a.label), esc(a.principal), time(a.last_seen)]),
      "Noch keine Abrufe",
    )
  );
}
function catalogRows() {
  const { folder, filters } = catalog;
  const categories = new Set(state.assignments.map((a) => a.bundle));
  const drafts = new Set(state.drafts.map((d) => d.bundle));
  const items = [
    ...state.folders.map((f) => ({ ...f, type: "folder", folder: f.parent })),
    ...state.groups.map((g) => ({ ...g, type: "group" })),
    ...state.bundles.map((b) => ({
      ...b,
      type: "bundle",
      draft: drafts.has(b.id),
      assigned: categories.has(b.id),
    })),
  ];
  return items
    .filter((obj) => {
      const recursive =
        filters.recursive &&
        (folder === null ||
          folderTrail(obj.folder).some((f) => f.id === folder));
      return (
        (recursive || obj.folder === folder) &&
        (!filters.name ||
          obj.name
            .toLocaleLowerCase("de")
            .includes(filters.name.toLocaleLowerCase("de"))) &&
        (!filters.type || filters.type === obj.type) &&
        (!filters.category || filters.category === obj.category) &&
        (!filters.enabled ||
          (obj.type === "bundle" && String(obj.enabled) === filters.enabled)) &&
        (!filters.sandbox ||
          (obj.type === "bundle" &&
            String(Number(obj.draft)) === filters.sandbox)) &&
        (!filters.report ||
          (obj.type === "bundle" &&
            (obj.report_status || "pending") === filters.report)) &&
        (!filters.assignment ||
          (obj.type === "bundle" &&
            String(Number(obj.assigned)) === filters.assignment))
      );
    })
    .sort(
      (a, b) =>
        Object.keys(objectTypes).indexOf(a.type) -
          Object.keys(objectTypes).indexOf(b.type) ||
        a.name.localeCompare(b.name, "de", { numeric: true }) *
          (catalog.descending ? -1 : 1),
    );
}
function filterField(key, label, items) {
  return `<label>${label}<select name="${key}"><option value="">Alle</option>${items.map(([v, n]) => `<option value="${esc(v)}" ${catalog.filters[key] === v ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>`;
}
function catalogFilters() {
  const categories = [
    ...new Set(state.bundles.map((b) => b.category).filter(Boolean)),
  ]
    .sort()
    .map((c) => [c, c]);
  const yesNo = [
    ["1", "Ja"],
    ["0", "Nein"],
  ];
  return `<details class="filter-panel" open><summary>Suchen</summary><form id="filters">
    <label>Name<input name="name" value="${esc(catalog.filters.name || "")}" type="search" placeholder="Name enthält …"></label>
    ${filterField("type", "Typ", Object.entries(objectTypes))}
    ${filterField("category", "Kategorie", categories)}
    ${filterField("enabled", "Aktiviert", yesNo)}
    ${filterField("sandbox", "Hat Sandbox", yesNo)}
    ${filterField("assignment", "Zugewiesen", yesNo)}
    ${filterField("report", "Letzte Meldung", [
      ["ok", "Erfolgreich"],
      ["error", "Fehler"],
      ["pending", "Ohne Meldung"],
    ])}
    <label class="check"><input type="checkbox" name="recursive" ${catalog.filters.recursive ? "checked" : ""}>Unterordner einbeziehen</label>
    <div class="filter-buttons"><button>Suchen</button>${command("reset", "Zurücksetzen")}</div></form></details>`;
}
function menu(label, items) {
  return `<details class="tool-menu"><summary>${label}</summary><div>${items}</div></details>`;
}
function currentSelection() {
  return catalogRows().filter((row) =>
    catalog.selected.has(row.type + ":" + row.id),
  );
}
function toolstrip() {
  const list = currentSelection(),
    single = list.length === 1,
    b = single && list[0].type === "bundle";
  const bundles = list.length > 0 && list.every((i) => i.type === "bundle");
  const group = single && list[0].type === "group";
  const disabled = (condition) => (condition ? "" : "disabled");
  return (
    menu(
      "Neu",
      command("new-bundle", "Windows-Bundle") +
        command("new-folder", "Ordner") +
        command("new-group", "Bundle-Gruppe"),
    ) +
    command("edit", "Bearbeiten", 0, disabled(single)) +
    command("remove", "Löschen", 0, disabled(single || bundles)) +
    menu(
      "Aktion",
      command("move", "Verschieben", 0, disabled(bundles)) +
        command("enable", "Aktivieren", 0, disabled(bundles)) +
        command("disable", "Deaktivieren", 0, disabled(bundles)) +
        command(
          "pin",
          b && pins().includes(list[0].id)
            ? "Favorit entfernen"
            : "Als Favorit merken",
          0,
          disabled(b),
        ),
    ) +
    menu(
      "Schnellaufgaben",
      command("assign", "Zuweisen", 0, disabled(b || group)) +
        command("draft", "Sandbox bearbeiten", 0, disabled(b)) +
        command(
          "publish",
          "Sandbox veröffentlichen",
          0,
          disabled(b && list[0].draft),
        ) +
        command(
          "discard",
          "Sandbox verwerfen",
          0,
          disabled(b && list[0].draft),
        ),
    ) +
    `<button class="refresh" data-do="refresh" title="Aktualisieren" aria-label="Aktualisieren">↻</button>`
  );
}
function catalogPage() {
  if (catalog.folder && !state.folders.some((f) => f.id === catalog.folder))
    catalog.folder = null;
  const rows = catalogRows(),
    pages = Math.max(1, Math.ceil(rows.length / catalog.size));
  catalog.page = Math.min(catalog.page, pages);
  const start = (catalog.page - 1) * catalog.size,
    visible = rows.slice(start, start + catalog.size);
  const selected = new Set(rows.map((r) => r.type + ":" + r.id));
  for (const key of catalog.selected)
    if (!selected.has(key)) catalog.selected.delete(key);
  const trail = [
    command("open-folder", "Bundles"),
    ...folderTrail(catalog.folder).map((f) =>
      command("open-folder", f.name, f.id),
    ),
  ].join('<span aria-hidden="true"> / </span>');
  const body = visible
    .map((obj) => {
      const key = obj.type + ":" + obj.id,
        bundle = obj.type === "bundle";
      return `<tr class="${catalog.selected.has(key) ? "selected" : ""}"><td><input class="row-select" type="checkbox" data-key="${key}" aria-label="${esc(obj.name)} auswählen" ${catalog.selected.has(key) ? "checked" : ""}></td>
      <td><span class="object-icon ${obj.type}" aria-hidden="true"></span>${command("open-" + obj.type, obj.name, obj.id, 'class="object-link"')}${pins().includes(obj.id) && bundle ? ' <span title="Favorit">★</span>' : ""}</td>
      <td>${objectTypes[obj.type]}</td><td>${esc(obj.category || "–")}</td><td>${bundle ? `<span class="${obj.enabled ? "on" : "off"}">${obj.enabled ? "Ja" : "Nein"}</span>` : "–"}</td>
      <td>${bundle ? obj.revision : "–"}</td><td>${bundle ? (obj.draft ? "Entwurf" : "–") : "–"}</td></tr>`;
    })
    .join("");
  return `<div class="catalog-path" aria-label="Ordnerpfad">${trail}</div><div class="catalog-grid"><section class="catalog-panel">
    <h2>${esc(folderTrail(catalog.folder).at(-1)?.name || "Bundles")}</h2><div class="toolstrip" id="tools">${toolstrip()}</div>
    <div class="table-scroll"><table class="objects"><thead><tr><th><input type="checkbox" id="select-page" aria-label="Seite auswählen"></th>
    <th aria-sort="${catalog.descending ? "descending" : "ascending"}">${command("sort", catalog.descending ? "Name ▾" : "Name ▴")}</th><th>Typ</th><th>Kategorie</th><th>Aktiviert</th><th>Version</th><th>Sandbox</th></tr></thead><tbody>${body}</tbody></table></div>
    ${rows.length ? "" : `<div class="empty"><strong>${Object.values(catalog.filters).some(Boolean) ? "Keine passenden Objekte" : "Dieser Ordner ist leer"}</strong>${Object.values(catalog.filters).some(Boolean) ? command("reset", "Filter zurücksetzen") : command("new-bundle", "Bundle anlegen") + " " + command("new-folder", "Ordner anlegen")}</div>`}
    <div class="pager"><span>${rows.length ? start + 1 : 0}–${Math.min(start + catalog.size, rows.length)} von ${rows.length} Objekten</span><div>
    ${command("prev", "‹", 0, catalog.page === 1 ? 'disabled aria-label="Vorherige Seite"' : 'aria-label="Vorherige Seite"')} ${catalog.page} / ${pages} ${command("next", "›", 0, catalog.page === pages ? 'disabled aria-label="Nächste Seite"' : 'aria-label="Nächste Seite"')}</div>
    <label><select id="size" aria-label="Einträge je Seite">${[10, 25, 100].map((n) => `<option ${n === catalog.size ? "selected" : ""}>${n}</option>`).join("")}</select> pro Seite</label></div></section>${catalogFilters()}</div>`;
}
function bindCatalog() {
  if (window.matchMedia("(max-width:720px)").matches)
    $(".filter-panel").open = false;
  const boxes = [...document.querySelectorAll(".row-select")],
    all = $("#select-page");
  function reflect() {
    all.checked = boxes.length > 0 && boxes.every((c) => c.checked);
    all.indeterminate = !all.checked && boxes.some((c) => c.checked);
    all.disabled = !boxes.length;
    $("#tools").innerHTML = toolstrip();
  }
  function mark(box, checked) {
    box.checked = checked;
    box.closest("tr").classList.toggle("selected", checked);
    if (checked) catalog.selected.add(box.dataset.key);
    else catalog.selected.delete(box.dataset.key);
  }
  boxes.forEach(
    (c) =>
      (c.onchange = () => {
        mark(c, c.checked);
        reflect();
      }),
  );
  all.onchange = () => {
    boxes.forEach((c) => mark(c, all.checked));
    reflect();
  };
  reflect();
  $("#filters").onsubmit = (e) => {
    e.preventDefault();
    catalog.filters = Object.fromEntries(new FormData(e.target));
    catalog.page = 1;
    catalog.selected.clear();
    render();
  };
  $("#size").onchange = (e) => {
    catalog.size = Number(e.target.value);
    catalog.page = 1;
    render();
  };
}
function folderEditor(folder) {
  dialog(
    folder ? "Ordner umbenennen" : "Ordner anlegen",
    '<label>Ordnername<input id="folder-name" maxlength="180" required></label>',
    () =>
      api("admin/folders", "POST", {
        id: folder?.id,
        parent: catalog.folder,
        name: $("#folder-name").value,
      }),
  );
  $("#folder-name").value = folder?.name || "";
}
function groupEditor(group) {
  dialog(
    group ? "Bundle-Gruppe bearbeiten" : "Bundle-Gruppe anlegen",
    `<label>Gruppenname<input id="group-name" maxlength="180" required></label><label>Ordner<select id="group-folder">${folderOptions(group ? group.folder : catalog.folder)}</select></label><fieldset><legend>Mitglieder</legend>${state.bundles.map((b) => `<label class="check"><input type="checkbox" name="member" value="${b.id}" ${group?.members.includes(b.id) ? "checked" : ""}>${esc(b.name)}</label>`).join("") || "Noch keine Bundles vorhanden."}</fieldset>`,
    () =>
      api("admin/groups", "POST", {
        id: group?.id,
        name: $("#group-name").value,
        folder: Number($("#group-folder").value) || null,
        members: [...document.querySelectorAll("[name=member]:checked")].map(
          (c) => Number(c.value),
        ),
      }),
  );
  $("#group-name").value = group?.name || "";
}
function catalogAction(action, id) {
  const selection = currentSelection(),
    obj = selection[0],
    ids = selection.map((x) => x.id);
  const folder = state.folders.find((f) => f.id === id),
    group = state.groups.find((g) => g.id === id);
  switch (action) {
    case "new-bundle":
      return bundleEditor();
    case "new-folder":
      return folderEditor();
    case "new-group":
      return groupEditor();
    case "open-folder":
      catalog.folder = folder?.id || null;
      catalog.page = 1;
      catalog.filters = {};
      catalog.selected.clear();
      return render();
    case "open-group":
      return groupEditor(group);
    case "open-bundle":
      return openObject("bundle",id);
    case "edit":
      return obj.type === "bundle"
        ? bundleEditor(obj.id)
        : obj.type === "folder"
          ? folderEditor(obj)
          : groupEditor(obj);
    case "draft":
      return bundleEditor(obj.id, true);
    case "assign":
      return assignmentEditor(
        null,
        obj.type === "bundle" ? obj.id : null,
        obj.type === "group" ? obj : null,
      );
    case "publish":
    case "discard": {
      const title =
        action === "publish" ? "Sandbox veröffentlichen" : "Sandbox verwerfen";
      const message =
        action === "publish"
          ? "Der Entwurf wird zur nächsten verteilbaren Bundle-Version."
          : "Der gespeicherte Entwurf wird entfernt.";
      return dialog(
        title,
        `<p><b>${esc(obj.name)}</b></p><p>${message}</p>`,
        () =>
          api("admin/sandbox/" + obj.id, "POST", {
            action,
            stamp: state.drafts.find((d) => d.bundle === obj.id).stamp,
          }),
        title,
      );
    }
    case "move":
      return dialog(
        "Bundles verschieben",
        `<label>Zielordner<select id="move-target">${folderOptions(catalog.folder)}</select></label>`,
        () =>
          api("admin/catalog", "POST", {
            action,
            ids,
            folder: Number($("#move-target").value) || null,
          }),
      );
    case "remove":
      if (obj.type !== "bundle")
        return handle(
          obj.type === "folder" ? "del-folders" : "del-groups",
          obj.id,
        );
      return dialog(
        "Bundles löschen",
        `<p>${ids.length} ausgewählte Bundles löschen? Bestehende Zuweisungen müssen vorher entfernt werden.</p>`,
        () => api("admin/catalog", "POST", { action: "delete", ids }),
        "Löschen",
      );
    case "enable":
    case "disable": {
      const verb = action === "enable" ? "aktivieren" : "deaktivieren";
      return dialog(
        "Verteilung ändern",
        `<p>${ids.length} ausgewählte Bundles ${verb}?</p><p>Die Änderung greift beim nächsten Abruf der Agenten.</p>`,
        () => api("admin/catalog", "POST", { action, ids }),
        "Bestätigen",
      );
    }
    case "pin": {
      const favorites = new Set(pins());
      if (favorites.has(obj.id)) favorites.delete(obj.id);
      else favorites.add(obj.id);
      localStorage.setItem(
        "openworks.bundlePins",
        JSON.stringify([...favorites]),
      );
      return render();
    }
    case "reset":
      catalog.filters = {};
      catalog.page = 1;
      catalog.selected.clear();
      break;
    case "prev":
      catalog.page--;
      break;
    case "next":
      catalog.page++;
      break;
    case "sort":
      catalog.descending = !catalog.descending;
      catalog.page = 1;
      break;
  }
  render();
}
