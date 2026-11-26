"use strict";
let objectView = null;
const symbols = {
  app: "◆ Anwendung",
  folder: "▰ Ordner",
  tools: "⚙ Werkzeug",
  document: "▤ Dokument",
  web: "◎ Web",
  code: "〈〉 Entwicklung",
  office: "▦ Büro",
};
const themes = { orbit: "Orbit", slate: "Schiefer", light: "Hell" };
const layouts = { tiles: "Kacheln", list: "Liste" };
const propertyNames = {
  owner: "Eigentümer",
  department: "Abteilung",
  site: "Site",
  location: "Standort",
  notes: "Administratorhinweise",
};
const yes = (value) => (value ? "Ja" : "Nein");
function openObject(kind, id) {
  section = { bundle: "bundles", device: "devices", branding: "policies" }[
    kind
  ];
  objectView = { kind, id, tab: "Zusammenfassung", draft: false };
  render();
}
function panel(title, content) {
  return `<details class="record-panel" open><summary>${esc(title)}</summary>${content}</details>`;
}
function facts(pairs) {
  return `<dl class="record-fields">${pairs.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value == null || value === "" ? "–" : value)}</dd></div>`).join("")}</dl>`;
}
function editAction(action, name) {
  return btn("detail-" + action, name, 0);
}
function relations(rows) {
  return table(
    ["Bundle", "Ziel", "Aktionsliste", "Auslöser"],
    rows.map((a) => [
      esc(bundleName(a.bundle)),
      esc(a.principal),
      esc(phases[a.phase]),
      esc(a.trigger === "at" ? time(a.due) : triggers[a.trigger]),
    ]),
    "Keine Zuweisungen",
  );
}
function messages(reports) {
  return table(
    ["Zeitpunkt", "Agent", "Ergebnis", "Meldung"],
    reports.map((r) => [
      time(r.seen),
      esc(state.agents.find((a) => a.id === r.agent)?.label),
      r.status === "ok" ? "Erfolgreich" : "Fehler",
      esc(r.detail),
    ]),
    "Keine Rückmeldungen",
  );
}
async function renderObject() {
  const view = objectView,
    seq = (view.sequence = (view.sequence || 0) + 1);
  const { kind, id } = view;
  const bundle = kind === "bundle" && state.bundles.find((b) => b.id === id);
  const parent = sections[section][0];
  $("#heading").textContent =
    bundle?.name ||
    (kind === "branding"
      ? "Anwendungskatalog"
      : state.agents.find((a) => a.id === id)?.label || "Gerät");
  document
    .querySelectorAll(".workspace-tabs button")
    .forEach((b) => b.setAttribute("aria-current", "false"));
  $("#page").innerHTML = '<p role="status">Details werden geladen …</p>';
  try {
    const data = await api(
      "admin/" + (kind === "branding" ? "branding" : kind + "/" + id),
    );
    if (view !== objectView || seq !== view.sequence) return;
    view.data = data;
    const tabs =
      kind === "bundle"
        ? [
            "Zusammenfassung",
            "Beziehungen",
            "Anforderungen",
            "Aktionen",
            "Einstellungen",
            "Freigeben",
            "Revision",
          ]
        : kind === "device"
          ? [
              "Zusammenfassung",
              "Inventar",
              "Zuweisungen",
              "Einstellungen",
              "Meldungen",
            ]
          : ["Zusammenfassung", "Beziehungen", "Einstellungen"];
    const draft = bundle && state.drafts.find((d) => d.bundle === id);
    if (!draft) view.draft = false;
    const version = bundle
      ? `<label class="version-line">Angezeigte Version <select id="shown-version"><option value="live">${bundle.revision} (Veröffentlicht)</option>${draft ? `<option value="draft" ${view.draft ? "selected" : ""}>Sandbox · Basis ${draft.base}</option>` : ""}</select></label>`
      : "";
    const breadcrumb = `<div class="record-path"><button data-section="${section}">${esc(parent)}</button> › ${
      bundle
        ? folderTrail(bundle.folder)
            .map((f) => esc(f.name) + " › ")
            .join("")
        : ""
    }${esc($("#heading").textContent)}</div>`;
    const content =
      kind === "bundle"
        ? bundleContent(view, bundle, view.draft ? draft : bundle)
        : kind === "device"
          ? deviceContent(view)
          : policyContent(view);
    $("#page").innerHTML =
      breadcrumb +
      version +
      `<div class="tabs record-tabs">${tabs.map((t) => `<button data-record-tab="${t}" aria-pressed="${view.tab === t}">${t}</button>`).join("")}</div>` +
      content;
    document.querySelectorAll("[data-record-tab]").forEach(
      (b) =>
        (b.onclick = () => {
          view.tab = b.dataset.recordTab;
          renderObject();
        }),
    );
    if (bundle && view.tab === "Aktionen") {
      for (const tab of document.querySelectorAll("[data-list]"))
        tab.onclick = () => {
          view.phase = tab.dataset.list;
          renderObject();
        };
      for (const link of document.querySelectorAll("[data-open-step]"))
        link.onclick = () =>
          bundleEditor(
            bundle.id,
            view.draft,
            "Aktionen",
            view.phase || "install",
            Number(link.dataset.openStep),
          );
    }
    if ($("#shown-version"))
      $("#shown-version").onchange = (e) => {
        view.draft = e.target.value === "draft";
        renderObject();
      };
  } catch (e) {
    if (view === objectView && seq === view.sequence)
      $("#page").innerHTML =
        `<p class="error">${esc(e.message)}</p><button data-section="${section}">Zur Übersicht</button>`;
  }
}
function bundleContent(v, b, shown) {
  const d = v.data,
    rules = state.assignments.filter((a) => a.bundle === b.id);
  switch (v.tab) {
    case "Beziehungen":
      return (
        ["device", "user"]
          .map((scope) =>
            panel(
              scope === "device" ? "Gerätezuweisungen" : "Benutzerzuweisungen",
              editAction("assign-" + scope, "Hinzufügen") +
                table(
                  ["Name", "Aktionsliste", "Auslöser", "Details"],
                  rules
                    .filter((a) => a.scope === scope)
                    .map((a) => [
                      esc(a.principal),
                      esc(phases[a.phase]),
                      esc(
                        a.trigger === "at" ? time(a.due) : triggers[a.trigger],
                      ),
                      btn("assign", "Zuweisungsdetails", a.id) +
                        btn("del-assignments", "Entfernen", a.id),
                    ]),
                  "Keine Zuweisungen",
                ),
            ),
          )
          .join("") +
        panel(
          "Bundle-Gruppen",
          editAction("members", "Mitgliedschaften bearbeiten") +
            table(
              ["Name", "Ordner"],
              state.groups
                .filter((g) => g.members.includes(b.id))
                .map((g) => [
                  esc(g.name),
                  esc(
                    folderTrail(g.folder)
                      .map((f) => f.name)
                      .join("/") || "/",
                  ),
                ]),
              "Keine Gruppenmitgliedschaften",
            ),
        )
      );
    case "Anforderungen":
      return panel(
        "Systemanforderungen",
        facts([
          ["Filter", conditionText(shown.requires)],
          [
            "Symbol bei unerfüllten Anforderungen anzeigen",
            yes(shown.show_unmet),
          ],
        ]) + editAction("requirements", "Anforderungen bearbeiten"),
      );
    case "Aktionen": {
      const phase = v.phase || "install",
        list = shown.actions[phase] || [];
      return panel(
        "Aktionslisten",
        '<div class="tabs sub-tabs">' +
          Object.entries(phases)
            .map(
              ([k, n]) =>
                `<button data-list="${k}" aria-pressed="${k === phase}">${n}</button>`,
            )
            .join("") +
          "</div>" +
          editAction("actions", "Aktionsliste bearbeiten") +
          table(
            ["Name", "Typ", "Status", "Anforderungen", "Bei Fehler fortfahren"],
            list.map((raw, i) => {
              const a = stepSpec(raw, phase);
              return [
                `<button class="quiet action-name" data-open-step="${i}">${esc(a.name)}</button>`,
                esc(actionNames[a.kind]),
                a.enabled === false ? "Deaktiviert" : "Aktiviert",
                esc(conditionText(a.requires)),
                yes(a.continue_error),
              ];
            }),
            "Keine Aktionen",
          ),
      );
    }
    case "Einstellungen":
      return (
        panel("Vererbte Variablen", variableTable(state.variables)) +
        panel(
          "Systemvariablen",
          editAction("variables", "Bundle-Variablen bearbeiten") +
            variableTable(shown.variables),
        ) +
        panel(
          "Katalogeintrag",
          editAction("properties", "Details bearbeiten") +
            facts([
              ["Symbol", symbols[d.symbol]],
              ["Beschreibung", d.description],
              ["Administratorhinweise", d.notes],
            ]),
        )
      );
    case "Freigeben": {
      const draft = state.drafts.find((x) => x.bundle === b.id);
      return panel(
        "Sandbox",
        facts([
          ["Veröffentlichte Version", b.revision],
          [
            "Sandbox",
            draft ? "Entwurf auf Basis " + draft.base : "Kein Entwurf",
          ],
        ]) +
          editAction("draft", "Sandbox bearbeiten") +
          (draft
            ? editAction("publish", "Sandbox veröffentlichen") +
              editAction("discard", "Entwurf verwerfen")
            : ""),
      );
    }
    case "Revision":
      return panel(
        "Veröffentlichte Revisionen",
        table(
          ["Version", "Name", "Veröffentlicht am"],
          d.versions.map((x) => [x.revision, esc(x.name), time(x.recorded)]),
          "Keine Revisionen",
        ),
      );
    default:
      return (
        panel(
          "Allgemein",
          facts([
            ["Bundle-Typ", "Windows-Bundle"],
            ["Angezeigte Version", v.draft ? "Sandbox" : b.revision],
            [
              "Veröffentlichter Paketinhalt",
              (d.size / 1048576).toLocaleString("de-DE", {
                maximumFractionDigits: 2,
              }) + " MiB",
            ],
            ["Aktiviert", yes(b.enabled)],
            ["GUID", d.guid],
            ["Erstellt am", time(d.created)],
            ["Letzte Veröffentlichung", time(d.versions[0]?.recorded)],
            ["Kategorie", b.category],
            ["Beschreibung", d.description],
            ["Symbol", symbols[d.symbol]],
            ["Administratorhinweise", d.notes],
            ["Zuweisungen", rules.length],
          ]) + editAction("properties", "Details bearbeiten"),
        ) + panel("Meldungsprotokoll", messages(d.reports))
      );
  }
}
function deviceContent(v) {
  const d = v.data,
    i = d.inventory,
    p = d.properties;
  const rules = state.assignments.filter(
    (a) =>
      a.scope === "device" &&
      a.principal.toLowerCase() === d.principal.toLowerCase(),
  );
  const ownership = facts([
    ...Object.entries(propertyNames).map(([k, n]) => [n, p[k]]),
    [
      "Lokale Benutzer-Agenten",
      d.users
        .map((id) => state.agents.find((a) => a.id === id)?.label)
        .join(", "),
    ],
  ]);
  switch (v.tab) {
    case "Inventar":
      return panel(
        "Windows-Inventar",
        facts([
          ["Erfasst am", time(d.scanned)],
          ["Betriebssystem", i.os],
          ["Build", i.build],
          ["Architektur", i.architecture],
          ["Hersteller", i.manufacturer],
          ["Modell", i.model],
          ["Seriennummer", i.serial],
          ["Prozessor", i.cpu],
          ["Arbeitsspeicher", i.memory],
          ["IP-Adressen", i.ips],
        ]),
      );
    case "Zuweisungen":
      return panel("Gerätezuweisungen", relations(rules));
    case "Einstellungen":
      return panel(
        "Organisation",
        ownership + editAction("properties", "Eigenschaften bearbeiten"),
      );
    case "Meldungen":
      return panel("Agentenmeldungen", messages(d.reports));
    default:
      return (
        `<div class="record-columns"><div>` +
        panel(
          "Allgemein",
          facts([
            ["Alias", d.label],
            ["Hostname", i.hostname],
            ["Zielkennung", d.principal],
            ["IP-Adressen", i.ips],
            ["Gerät hinzugefügt", time(d.created)],
            ["Letzter Kontakt", time(d.last_seen)],
            ["Letztes Inventar", time(d.scanned)],
            [
              "Letzter Systemstart",
              i.boot ? new Date(i.boot).toLocaleString("de-DE") : "",
            ],
            ["OpenWorks-Agent", i.version],
            ["Betriebssystem", [i.os, i.build].filter(Boolean).join(" · ")],
            ["Seriennummer", i.serial],
            ["GUID", d.guid],
          ]),
        ) +
        panel(
          "Organisation",
          ownership + editAction("properties", "Eigenschaften bearbeiten"),
        ) +
        `</div><div>` +
        panel(
          "Anstehende Zeitpläne",
          relations(
            rules.filter(
              (a) =>
                a.trigger === "at" &&
                a.due * 1000 > Date.now() &&
                state.bundles.find((b) => b.id === a.bundle)?.enabled,
            ),
          ),
        ) +
        panel(
          "Benutzersitzung",
          facts([
            ["Konsolenbenutzer beim Inventarabruf", i.user],
            ["Stand", time(d.scanned)],
          ]),
        ) +
        panel(
          "Meldungsstatus",
          facts([
            [
              "Erfolgreiche Regeln",
              d.reports.filter((r) => r.status === "ok").length,
            ],
            [
              "Fehlgeschlagene Regeln",
              d.reports.filter((r) => r.status === "error").length,
            ],
          ]),
        ) +
        `</div></div>`
      );
  }
}
function policyContent(v) {
  const d = v.data;
  if (v.tab === "Beziehungen")
    return panel(
      "Geltungsbereich",
      table(
        ["Installation", "Benutzer", "Letzter Agentenabruf"],
        state.agents
          .filter((a) => a.scope === "user")
          .map((a) => [esc(a.label), esc(a.principal), time(a.last_seen)]),
        "Keine Benutzer-Agenten",
      ),
    );
  if (v.tab === "Einstellungen")
    return panel(
      "Gestaltung des Anwendungskatalogs",
      facts([
        ["Fenstertitel", d.title],
        ["Hintergrund", themes[d.theme]],
        ["Akzentfarbe", d.accent],
        ["Standardansicht", layouts[d.layout]],
        ["Suche", yes(d.search)],
        ["Favoriten", yes(d.favorites)],
      ]) + editAction("policy", "Gestaltung bearbeiten"),
    );
  return panel(
    "Allgemein",
    facts([
      ["Richtlinientyp", "Branding für Endbenutzer"],
      ["Version", d.revision + " (Veröffentlicht)"],
      ["Aktiviert", yes(d.enabled)],
      ["Geändert am", time(d.modified)],
      ["Geltungsbereich", "Alle Benutzer-Agenten"],
      ["Übernahme", "Beim Öffnen und Aktualisieren des Anwendungskatalogs"],
    ]) + editAction("policy", "Richtlinie bearbeiten"),
  );
}
function detailAction(action) {
  const v = objectView,
    d = v.data;
  if (action.startsWith("assign-"))
    return assignmentEditor(null, v.id, null, action.slice(7));
  if (action === "members")
    return dialog(
      "Bundle-Gruppen",
      state.groups
        .map(
          (g) =>
            `<label class="check"><input type="checkbox" name="membership" value="${g.id}" ${g.members.includes(v.id) ? "checked" : ""}>${esc(g.name)}</label>`,
        )
        .join("") || "<p>Keine Bundle-Gruppen vorhanden.</p>",
      () =>
        api("admin/bundle/" + v.id + "/groups", "POST", {
          before: state.groups
            .filter((g) => g.members.includes(v.id))
            .map((g) => g.id),
          groups: [
            ...document.querySelectorAll("[name=membership]:checked"),
          ].map((el) => Number(el.value)),
        }),
    );
  if (
    action === "draft" ||
    action === "actions" ||
    action === "requirements" ||
    action === "variables"
  )
    return bundleEditor(
      v.id,
      action === "draft" || v.draft,
      {
        actions: "Aktionen",
        requirements: "Anforderungen",
        variables: "Systemvariablen",
        draft: "Allgemein",
      }[action],
      v.phase || "install",
    );
  if (action === "publish" || action === "discard") {
    const draft = state.drafts.find((x) => x.bundle === v.id);
    return dialog(
      action === "publish" ? "Sandbox veröffentlichen" : "Entwurf verwerfen",
      `<p>${action === "publish" ? "Den Entwurf als nächste Version verteilen?" : "Den aktuellen Entwurf entfernen?"}</p>`,
      () =>
        api("admin/sandbox/" + v.id, "POST", { action, stamp: draft.stamp }),
      "Bestätigen",
    );
  }
  if (action === "policy") {
    const checks = {
      enabled: "Richtlinie aktiviert",
      search: "Suchfeld anzeigen",
      favorites: "Favoriten erlauben",
    };
    dialog(
      "Branding-Richtlinie bearbeiten",
      `<label>Fenstertitel<input id="brand-title" required maxlength="80"></label><div class="pair"><label>Hintergrund<select id="brand-theme">${options(themes)}</select></label><label>Akzentfarbe<input id="brand-accent" type="color"></label></div><label>Standardansicht<select id="brand-layout">${options(layouts)}</select></label>` +
        Object.entries(checks)
          .map(
            ([k, n]) =>
              `<label class="check"><input id="brand-${k}" type="checkbox">${n}</label>`,
          )
          .join(""),
      () => {
        const values = { revision: d.revision };
        for (const key of ["title", "theme", "accent", "layout"])
          values[key] = $("#brand-" + key).value;
        for (const key of Object.keys(checks))
          values[key] = $("#brand-" + key).checked;
        return api("admin/branding", "POST", values);
      },
      "Veröffentlichen",
    );
    for (const key of ["title", "theme", "accent", "layout"])
      $("#brand-" + key).value = d[key];
    for (const key of Object.keys(checks)) $("#brand-" + key).checked = d[key];
    return;
  }
  if (action === "properties") {
    const bundle = v.kind === "bundle",
      labels = bundle
        ? { description: "Beschreibung", notes: "Administratorhinweise" }
        : propertyNames;
    dialog(
      "Eigenschaften bearbeiten",
      Object.entries(labels)
        .map(
          ([k, n]) =>
            `<label>${n}<input id="prop-${k}" maxlength="${bundle ? 2000 : 500}"></label>`,
        )
        .join("") +
        (bundle
          ? `<label>Symbol<select id="prop-symbol">${options(symbols)}</select></label>`
          : `<fieldset><legend>Benutzer-Agenten auf diesem Gerät</legend><p>Die ausgewählten Registrierungen sehen zusätzlich die Geräte-Bundles im Katalog.</p>${state.agents
              .filter((a) => a.scope === "user")
              .map(
                (a) =>
                  '<label class="check"><input type="checkbox" name="device-user" value="' +
                  a.id +
                  '" ' +
                  (d.users.includes(a.id) ? "checked" : "") +
                  ">" +
                  esc(a.label + " · " + a.principal) +
                  "</label>",
              )
              .join("")}</fieldset>`),
      () => {
        const values = { etag: d.etag };
        for (const k of Object.keys(labels)) values[k] = $("#prop-" + k).value;
        if (bundle) values.symbol = $("#prop-symbol").value;
        else
          values.users = [
            ...document.querySelectorAll("[name=device-user]:checked"),
          ].map((el) => Number(el.value));
        return api("admin/" + v.kind + "/" + v.id, "POST", values);
      },
    );
    for (const k of Object.keys(labels))
      $("#prop-" + k).value = (bundle ? d : d.properties)[k] || "";
    if (bundle) $("#prop-symbol").value = d.symbol;
  }
}
