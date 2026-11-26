import hashlib
import io
import tempfile
import unittest

from server.app import create_app

HEADER = bytes.fromhex("d0cf11e0a1b11ae1")


class DistributionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = create_app(self.tmp.name)
        self.admin = self.app.test_client()
        with self.admin.session_transaction() as s:
            s.update(admin=True, csrf="test")
        self.admin.environ_base["HTTP_X_CSRF"] = "test"

    def post(self, path, data):
        response = self.admin.post("/api/admin/" + path, json=data)
        self.assertLess(response.status_code, 300, response.json)
        return response.json

    def agent(self, name, scope):
        token = self.post("agents", {"label": name, "scope": scope, "principal": name})["token"]
        client = self.app.test_client()
        client.environ_base["HTTP_AUTHORIZATION"] = "Bearer " + token
        return client

    def upload(self, name, content):
        response = self.admin.post("/api/admin/packages", data={"file": (io.BytesIO(content), name)})
        self.assertEqual(response.status_code, 201)
        return hashlib.sha256(content).hexdigest()

    def test_scope_variables_content_and_reports(self):
        mine = self.agent("demo", "user")
        device = self.agent("demo", "device")
        other = self.agent("another", "user")
        a = self.upload("a.msi", HEADER + b"a")
        b = self.upload("b.msi", HEADER + b"b")
        self.post("variables", {"variables": {"PACKAGE": "a.msi"}})
        body = {"name": "Demo", "variables": {"PACKAGE": "b.msi"},
                "actions": {"install": ["$" + "{PACKAGE}"], "start": ["Demo/App.exe"]}}
        key = self.post("bundles", body)["id"]
        self.post("assignments", {"bundle": key, "phase": "start", "scope": "user",
                                  "principal": "DEMO", "trigger": "login"})
        rule, = mine.get("/api/agent/manifest").json["assignments"]
        self.assertEqual(rule["install"], [{"kind": "install", "value": b}])
        self.assertEqual(rule["steps"][0]["value"], "Demo\\App.exe")
        for client in (device, other):
            self.assertEqual(client.get("/api/agent/manifest?principal=demo").json["assignments"], [])
            self.assertEqual(client.get("/api/agent/packages/" + b).status_code, 404)
        self.assertEqual(mine.get("/api/agent/packages/" + a).status_code, 404)
        with mine.get("/api/agent/packages/" + b) as download:
            self.assertEqual(download.data, HEADER + b"b")
        report = {"assignment": rule["id"], "version": rule["version"], "status": "ok", "detail": "OK"}
        self.assertEqual(other.post("/api/agent/report", json=report).status_code, 409)
        self.assertEqual(mine.post("/api/agent/report", json=report).status_code, 200)
        self.post("bundles", body | {"id": key, "revision": 1})
        self.assertEqual(mine.post("/api/agent/report", json=report).status_code, 409)

    def test_csrf_and_revoked_credentials(self):
        agent = self.agent("pc", "device")
        response = self.admin.delete("/api/admin/agents/1", headers={"X-CSRF": "bad"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(agent.get("/api/agent/manifest").status_code, 200)
        self.assertEqual(self.admin.delete("/api/admin/agents/1").status_code, 200)
        self.assertEqual(agent.get("/api/agent/manifest").status_code, 401)

    def test_editing_distribution_rule_invalidates_old_plan(self):
        agent = self.agent("anna", "user")
        key = self.post("bundles", {"name": "App", "actions": {"start": ["Demo/App.exe"]}})["id"]
        assignment = {"bundle": key, "phase": "start", "scope": "user", "principal": "anna", "trigger": "login"}
        self.post("assignments", assignment)
        before, = agent.get("/api/agent/manifest").json["assignments"]
        edit = assignment | {"id": before["id"], "generation": 1, "trigger": "at", "due": 1800000000}
        self.post("assignments", edit)
        after, = agent.get("/api/agent/manifest").json["assignments"]
        self.assertEqual((after["trigger"], after["due"]), ("at", 1800000000))
        self.assertNotEqual(before["version"], after["version"])
        self.assertEqual(self.admin.post("/api/admin/assignments", json=edit).status_code, 409)

    def test_invalid_action_and_stale_edit(self):
        body = {"name": "Demo", "actions": {"start": ["../App.exe"]}}
        self.assertEqual(self.admin.post("/api/admin/bundles", json=body).status_code, 400)
        body["actions"] = {"install": ["$" + "{UNDEFINED}"]}
        self.assertEqual(self.admin.post("/api/admin/bundles", json=body).status_code, 400)
        body["actions"] = {}
        key = self.post("bundles", body)["id"]
        self.post("bundles", body | {"id": key, "revision": 1})
        self.assertEqual(self.admin.post("/api/admin/bundles", json=body | {"id": key, "revision": 1}).status_code, 409)

    def test_legacy_bundle_sandbox_and_activation(self):
        agent = self.agent("anna", "user")
        key = self.post("bundles", {"name": "Editor", "actions": {"start": ["App/Live.exe"]}})["id"]
        self.post("assignments", {"bundle": key, "phase": "start", "scope": "user", "principal": "anna", "trigger": "login"})
        plan = lambda: agent.get("/api/agent/manifest").json["assignments"]
        initial, = plan()
        self.post(f"sandbox/{key}", {"action": "save", "base": 1, "actions": {"start": ["App/Next.exe"]}})
        self.assertEqual(plan(), [initial])
        draft, = self.admin.get("/api/admin/state").json["drafts"]
        endpoint = f"/api/admin/sandbox/{key}"
        self.assertEqual(self.admin.post(endpoint, json={"action":"publish","stamp":"old"}).status_code, 409)
        self.post(f"sandbox/{key}", {"action": "publish", "stamp": draft["stamp"]})
        published, = plan()
        self.assertEqual(published["steps"][0]["value"], "App\\Next.exe")
        self.assertNotEqual(initial["version"], published["version"])
        self.post("catalog", {"ids": [key], "action":"disable"})
        self.assertEqual(plan(), [])
        self.post("catalog", {"ids": [key], "action":"enable"})
        self.assertEqual(plan(), [published])

    def test_folder_bulk_operations_and_group_assignment_are_atomic(self):
        self.agent("anna", "user")
        self.post("folders", {"name":"Apps"})
        folder, = self.admin.get("/api/admin/state").json["folders"]
        keys = [self.post("bundles", {"name":n, "actions":{"start":[n+".exe"]}})["id"] for n in ("One", "Two")]
        self.post("catalog", {"action":"move", "ids":keys, "folder":folder["id"]})
        self.assertEqual(self.admin.delete("/api/admin/folders/"+str(folder["id"])).status_code, 409)
        group = self.post("groups", {"name":"Werkzeuge", "members":keys})["id"]
        params = {"phase":"start","scope":"user","principal":"anna","trigger":"login"}
        self.post("assignments", params | {"bundle":keys[1]})
        self.assertEqual(self.admin.post("/api/admin/assignments", json=params | {"group":group}).status_code, 409)
        rule, = self.admin.get("/api/admin/state").json["assignments"]
        self.assertEqual(rule["bundle"], keys[1])
        self.assertEqual(self.admin.post("/api/admin/catalog", json={"action":"delete","ids":keys}).status_code, 409)
        self.assertEqual(len(self.admin.get("/api/admin/state").json["bundles"]), 2)
        self.admin.delete("/api/admin/assignments/"+str(rule["id"]))
        self.assertEqual(self.post("assignments", params | {"group":group})["created"], 2)
