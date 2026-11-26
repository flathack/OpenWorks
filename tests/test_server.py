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
