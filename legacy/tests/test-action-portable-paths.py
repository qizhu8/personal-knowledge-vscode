"""Publisher-unavailable delivery and explicit migration regression tests."""

import copy
import json
import os
import runpy
import shutil
import subprocess
import sys
import time
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

fixtures = runpy.run_path(str(Path(__file__).with_name("test-action-modules.py")))
ModuleRuntime = fixtures["ModuleRuntime"]
ResourceReferenceTests = fixtures["ResourceReferenceTests"]


class PortablePathTests(unittest.TestCase):
    setUp = ResourceReferenceTests.setUp
    grant = ResourceReferenceTests.grant

    def test_declared_tree_executes_after_publisher_and_receiver_removed(self):
        helper = self.script.with_name("helper.py")
        data = self.script.parent / "数据" / "value.txt"
        other = self.script.parent / "other" / "value.txt"
        data.parent.mkdir()
        other.parent.mkdir()
        helper.write_text("from pathlib import Path\n"
                          "def value():\n"
                          " return int((Path(__file__).parent/'数据'/'value.txt').read_text())\n")
        data.write_text("42")
        other.write_text("99")
        self.script.write_text("import json\nfrom helper import value\nprint(json.dumps({'value':value()}))\n")
        value = self.runtime.definition_read(self.definition["action_id"])["definition"]
        value["version"] = 2
        value["implementations"][0]["files"] += [str(helper), str(data), str(other)]
        definition = self.runtime.register(value)
        package = self.runtime.workspace() / "tree.zip"
        exported = self.runtime.module_set_export("test.tree", 1, [definition["action_id"]], str(package))
        members = exported["manifest"]["files"]
        self.assertIn("assets/test.resource.reference/helper.py", members)
        self.assertIn("assets/test.resource.reference/数据/value.txt", members)
        self.assertIn("assets/test.resource.reference/other/value.txt", members)
        receiver = ModuleRuntime(self.directory / "receiver")
        receiver.configure_workspace(str(self.directory / "receiver-workspace"))
        copied = receiver.workspace() / "tree.zip"
        shutil.copyfile(package, copied)
        # Neither the source store nor the exporting workspace is available.
        publisher_workspace = self.runtime.workspace()
        shutil.rmtree(self.runtime.store)
        shutil.rmtree(publisher_workspace)
        receiver.module_set_import(str(copied))
        receiver.module_set_load("test.tree", 1)
        received = receiver.definition(definition["action_id"])
        self.grant(receiver, received)
        self.assertTrue(receiver.validate(received["action_id"], received["content_hash"])["ok"])
        run = receiver.call(received["action_id"], {}, "tree", received["content_hash"])
        self.assertEqual(receiver.wait(run["run_id"])["output"], {"value": 42})
        reexported = receiver.workspace() / "again.zip"
        receiver.module_set_export("test.tree.again", 1, [received["action_id"]], str(reexported))
        third = ModuleRuntime(self.directory / "third")
        third.configure_workspace(str(self.directory / "third-workspace"))
        third_package = third.workspace() / "again.zip"
        shutil.copyfile(reexported, third_package)
        receiver_workspace = receiver.workspace()
        shutil.rmtree(receiver.store)
        shutil.rmtree(receiver_workspace)
        third.module_set_import(str(third_package))
        third.module_set_load("test.tree.again", 1)
        final = third.definition(received["action_id"])
        self.grant(third, final)
        self.assertTrue(third.validate(final["action_id"], final["content_hash"])["ok"])
        run = third.call(final["action_id"], {}, "reexported", final["content_hash"])
        self.assertEqual(third.wait(run["run_id"])["output"], {"value": 42})

    def test_shared_resource_across_implementations_has_one_tree(self):
        value = self.runtime.definition_read(self.definition["action_id"])["definition"]
        value["version"] = 2
        value["implementations"].append(copy.deepcopy(value["implementations"][0]))
        value["implementations"][1]["platforms"] = ["Windows" if sys.platform != "win32" else "Linux"]
        definition = self.runtime.register(value)
        package = self.runtime.workspace() / "shared.zip"
        manifest = self.runtime.module_set_export("test.shared", 1, [definition["action_id"]], str(package))["manifest"]
        assets = [entry for entry in manifest["files"] if entry.startswith("assets/")]
        self.assertEqual(len(assets), 1)
        self.assertEqual(manifest["resources"][definition["action_id"]][self.uri], assets[0])

    @unittest.skipUnless(shutil.which("cc") and os.name != "nt", "Requires a local C compiler")
    def test_native_sibling_include_build_after_publisher_removed(self):
        source = self.script.with_name("main.c")
        header = source.with_name("value.h")
        source.write_text('#include <stdio.h>\n#include "value.h"\n'
                          'int main(void) { puts("{\\"value\\": " VALUE "}"); return 0; }\n')
        header.write_text('#define VALUE "42"\n')
        value = self.runtime.definition_read(self.definition["action_id"])["definition"]
        value["version"] = 2
        value["implementations"] = [{"kind": "program", "platforms": ["Linux", "Darwin"],
            "program": "${build_dir}/result", "args": [], "build": {
                "program": "cc", "source_files": [str(source), str(header)],
                "args": [str(source), "-o", "${build_dir}/result"], "outputs": ["result"]}}]
        definition = self.runtime.register(value)
        package = self.runtime.workspace() / "native.zip"
        self.runtime.module_set_export("test.native.tree", 1, [definition["action_id"]], str(package))
        receiver = ModuleRuntime(self.directory / "receiver")
        receiver.configure_workspace(str(self.directory / "receiver-workspace"))
        copied = receiver.workspace() / "native.zip"
        shutil.copyfile(package, copied)
        shutil.rmtree(self.runtime.store)
        receiver.module_set_import(str(copied))
        receiver.module_set_load("test.native.tree", 1)
        definition = receiver.definition(definition["action_id"])
        self.grant(receiver, definition)
        self.assertTrue(receiver.validate(definition["action_id"], definition["content_hash"])["ok"])
        run = receiver.call(definition["action_id"], {}, "native", definition["content_hash"])
        self.assertEqual(receiver.wait(run["run_id"])["output"], {"value": 42})

    def test_graph_resource_export_rewrites_only_schema_owned_literal_path(self):
        component = next(item for item in self.runtime.components() if item["action_id"] == "core.file-path")
        graph = {"action_id": "test.resource.graph", "name": "File fixture", "nodes": [{
            "id": "file", "action_id": "core.file-path", "content_hash": component["content_hash"],
            "parameters": {"path": str(self.script), "must_exist": True}}], "edges": [], "output_node": "file"}
        definition = self.runtime.graph_save(graph)
        package = self.runtime.workspace() / "graph.zip"
        self.runtime.module_set_export("test.graph.tree", 1, [definition["action_id"]], str(package))
        receiver = ModuleRuntime(self.directory / "receiver")
        receiver.configure_workspace(str(receiver.store))
        copied = receiver.workspace() / "graph.zip"
        shutil.copyfile(package, copied)
        shutil.rmtree(self.runtime.store)
        receiver.module_set_import(str(copied))
        receiver.module_set_load("test.graph.tree", 1)
        received = receiver.definition(definition["action_id"])
        path = received["graph"]["nodes"][0]["parameters"]["path"]
        self.assertTrue(path.startswith("${module_assets}/"), path)
        self.assertEqual(received["implementations"][0]["steps"][0]["inputs"]["path"], path)
        run = receiver.call(received["action_id"], {}, "graph", received["content_hash"], validation=True)
        self.assertEqual(receiver.wait(run["run_id"])["output"], {"path": str(receiver.resource_path(received, path))})

    @unittest.skipIf(os.name == "nt", "POSIX executable bits are a Linux/macOS contract")
    def test_executable_resource_mode_survives_import(self):
        executable = self.script.with_name("entry.sh")
        executable.write_text("#!/bin/sh\nprintf '{\"value\": 42}\\n'\n")
        executable.chmod(0o700)
        value = self.runtime.definition_read(self.definition["action_id"])["definition"]
        value["version"] = 2
        value["implementations"][0].update(program=str(executable), args=[], files=[str(executable)])
        definition = self.runtime.register(value)
        package = self.runtime.workspace() / "executable.zip"
        exported = self.runtime.module_set_export("test.exec.tree", 1, [definition["action_id"]], str(package))
        self.assertEqual(len(exported["manifest"]["executables"]), 1)
        receiver = ModuleRuntime(self.directory / "receiver")
        receiver.configure_workspace(str(self.directory / "receiver-workspace"))
        copied = receiver.workspace() / "executable.zip"
        shutil.copyfile(package, copied)
        shutil.rmtree(self.runtime.store)
        receiver.module_set_import(str(copied))
        receiver.module_set_load("test.exec.tree", 1)
        received = receiver.definition(definition["action_id"])
        self.grant(receiver, received)
        self.assertTrue(receiver.validate(received["action_id"], received["content_hash"])["ok"])
        run = receiver.call(received["action_id"], {}, "exec", received["content_hash"])
        self.assertEqual(receiver.wait(run["run_id"])["output"], {"value": 42})

    def test_layout_validation_rejects_cross_platform_aliases_and_containment(self):
        for names in [["assets/a", "assets/A"], ["assets/a", "assets/a/b"],
                      ["assets/../outside"], ["/absolute"], ["assets\\escape"],
                      ["assets/C:drive"], ["assets/a."], ["assets/CON.txt"],
                      ["assets/COM¹.txt"], ["assets/é.txt", "assets/e\u0301.txt"],
                      ["assets/a//b"], ["assets/./b"], ["assets/x\0y"]]:
            with self.subTest(names=names), self.assertRaises(ValueError):
                self.runtime.validate_member_layout(names)
        self.runtime.validate_member_layout(["assets/数据/file.txt", "assets/other/file.txt"])
        package = self.runtime.workspace() / "collision.zip"
        with zipfile.ZipFile(package, "w") as archive:
            archive.writestr("assets/a.py", "x")
            archive.writestr("assets/A.py", "y")
        with self.assertRaisesRegex(ValueError, "collision"):
            self.runtime.module_set_import(str(package))

    def test_export_rejects_case_collision_and_symlink_directory(self):
        upper = self.script.with_name("Same.txt")
        lower = self.script.with_name("same.txt")
        upper.write_text("1")
        lower.write_text("2")
        value = self.runtime.definition_read(self.definition["action_id"])["definition"]
        value["version"] = 2
        value["implementations"][0]["files"] += [str(upper), str(lower)]
        definition = self.runtime.register(value)
        with self.assertRaisesRegex(ValueError, "collision"):
            self.runtime.module_set_export("test.collision", 1, [definition["action_id"]],
                                           str(self.runtime.workspace() / "unsafe.zip"))
        if os.name != "nt":
            link = self.runtime.workspace() / "link"
            link.symlink_to(self.script.parent, target_is_directory=True)
            with self.assertRaisesRegex(PermissionError, "symlink"):
                self.runtime.resource_path(definition, str(link / self.script.name))

    def test_migration_only_verified_typed_slots_and_rollback_evidence(self):
        value = self.runtime.definition_read(self.definition["action_id"])["definition"]
        implementation = value["implementations"][0]
        implementation.update(files=[str(self.script)], args=["--source=" + str(self.script)],
                              description=str(self.script), cwd=str(self.script),
                              script="print(" + repr(str(self.script)) + ")",
                              environment={"SECRET": str(self.script)})
        value["description"] = str(self.script)
        original = copy.deepcopy(value)
        result = self.runtime.migration_preview(value)
        migrated = result["candidate"]["implementations"][0]
        self.assertEqual(migrated["files"], [self.uri])
        self.assertEqual(migrated["args"], ["--source=" + self.uri])
        for field in ("description", "cwd", "script", "environment"):
            self.assertEqual(migrated[field], implementation[field])
        self.assertEqual(value, original)
        self.assertEqual(result["original"], original)
        self.assertFalse(result["applied"])
        self.assertEqual(result["changes"][0]["before"], str(self.script))
        self.assertEqual(len(result["changes"][0]["sha256"]), 64)
        # Preview does not register, version, or rewrite the live Action.
        self.assertEqual(self.runtime.definition(value["action_id"])["content_hash"], self.definition["content_hash"])

    def test_migration_argv_build_server_graph_and_recipe(self):
        path = str(self.script)
        value = self.runtime.definition_read(self.definition["action_id"])["definition"]
        impl = value["implementations"][0]
        impl.update(files=[], args=[path, "literal " + path, "--file=" + path],
                    build={"program": "python", "source_files": [path], "args": [path]},
                    server={"program": "python", "args": [path]})
        impl["steps"] = [{"id": "file", "component": "core.file-path", "inputs": {"path": path}}]
        value["graph"] = {"nodes": [{"id": "file", "action_id": "core.file-path", "parameters": {"path": path}},
                                    {"id": "constant", "action_id": "core.constant", "parameters": {"value": path}}]}
        result = self.runtime.migration_preview(value)["candidate"]
        migrated = result["implementations"][0]
        self.assertEqual(migrated["args"], [self.uri, "literal " + path, "--file=" + self.uri])
        self.assertEqual(migrated["build"]["source_files"], [self.uri])
        self.assertEqual(migrated["server"]["files"], [self.uri])
        self.assertEqual(migrated["steps"][0]["inputs"]["path"], self.uri)
        self.assertEqual(result["graph"]["nodes"][0]["parameters"]["path"], self.uri)
        self.assertEqual(result["graph"]["nodes"][1]["parameters"]["value"], path)
        recipe = {"recipeId": "recipe_test", "name": "Recipe fixture", "nodes": [
            {"nodeId": "run", "kind": "pkm.step.pipeline/v1", "config": {
                "executor": "script", "script": path, "cwd": path, "environmentId": path, "args": [path]}}]}
        candidate = self.runtime.migration_preview(recipe, "recipe")["candidate"]
        config = candidate["nodes"][0]["config"]
        self.assertEqual(config["args"], [self.uri])
        self.assertEqual(config["files"], [self.uri])
        for field in ("script", "cwd", "environmentId"):
            self.assertEqual(config[field], path)
        canonical_record = {"recipeId": "recipe_test", "name": "Stored Recipe",
                            "definition": {"schema": "pkm.workflow.definition/v1",
                                           "spec": {"nodes": recipe["nodes"]}}}
        preview = self.runtime.migration_preview(canonical_record, "recipe")
        self.assertEqual(preview["candidate"]["definition"]["spec"]["nodes"][0]["config"]["args"], [self.uri])
        self.assertEqual(preview["changes"][0]["field"], "definition.spec.nodes[0].config.args[0]")
        definition = {"action_id": "test.nested", "implementations": [{"steps": [{
            "id": "branch", "component": "core.if-else", "inputs": {
                "then_steps": [{"id": "path", "component": "core.file-path", "inputs": {"path": path}}],
                "else_steps": [{"id": "constant", "component": "core.constant", "inputs": {"value": path}}]}}]}]}
        migrated = self.runtime.migration_preview(definition)["candidate"]
        inputs = migrated["implementations"][0]["steps"][0]["inputs"]
        self.assertEqual(inputs["then_steps"][0]["inputs"]["path"], self.uri)
        self.assertEqual(inputs["else_steps"][0]["inputs"]["value"], path)

    def test_migration_missing_duplicate_and_foreign_windows_paths_are_diagnostic(self):
        value = self.runtime.definition_read(self.definition["action_id"])["definition"]
        values = [str(self.script.parent / "missing.py"), r"C:\publisher\source.py"]
        value["implementations"][0]["files"] = values
        preview = self.runtime.migration_preview(value)
        self.assertEqual(preview["candidate"]["implementations"][0]["files"], values)
        self.assertEqual(len(preview["diagnostics"]), 2)
        for diagnostic in preview["diagnostics"]:
            self.assertEqual(diagnostic["id"], value["action_id"])
            self.assertEqual(diagnostic["name"], "Portable source")
            self.assertIn("files[", diagnostic["field"])
        duplicate = self.script.with_name("duplicate.py")
        duplicate.write_text("print('{}')")
        duplicate.with_name("." + duplicate.name + ".pkm.json").write_text(json.dumps(self.identity))
        value["implementations"][0]["files"] = [str(self.script)]
        preview = self.runtime.migration_preview(value)
        self.assertEqual(preview["changes"], [])
        self.assertIn("multiple", preview["diagnostics"][0]["reason"])

    def test_migration_malformed_identity_and_typed_arrays_have_named_diagnostics(self):
        value = self.runtime.definition_read(self.definition["action_id"])["definition"]
        value["implementations"][0]["files"] = [str(self.script)]
        self.sidecar.write_text("[]")
        preview = self.runtime.migration_preview(value)
        self.assertEqual(preview["changes"], [])
        self.assertIn("metadata must be an object", preview["diagnostics"][0]["reason"])
        value["implementations"][0]["args"] = "not-an-array"
        with self.assertRaisesRegex(ValueError, r"Portable source.*test.resource.reference.*implementations\[0\].args"):
            self.runtime.migration_preview(value)

    def test_recipe_existing_command_executor_resolves_migrated_resources(self):
        import recipe_runtime
        config = {"program": sys.executable, "args": [str(self.script)]}
        document = {"recipeId": "recipe_fixture", "nodes": [
            {"nodeId": "run", "kind": "pkm.step.command/v1", "config": config}]}
        node = self.runtime.migration_preview(document, "recipe")["candidate"]["nodes"][0]
        run = {"schema": recipe_runtime.RUN_SCHEMA, "runId": "recipe_run_fixture",
               "recipeId": "recipe_fixture", "inputs": {}, "nodes": {"run": {}}}
        # Exercise the actual launch function, executing its existing worker
        # synchronously so the test owns/reaps the process.
        real_popen = subprocess.Popen
        with patch.object(recipe_runtime.subprocess, "Popen") as launcher:
            def launch(argv, **kwargs):
                process = real_popen(argv, **kwargs)
                process.wait(timeout=20)
                return process
            launcher.side_effect = launch
            self.assertTrue(recipe_runtime._start_command(self.runtime.store, run, node))
        result_path = Path(run["nodes"]["run"]["background"]["resultPath"])
        result = json.loads(result_path.read_text())
        self.assertTrue(result["ok"], result)
        self.assertEqual(json.loads(result["stdout"]), {"value": 42})
        self.assertEqual(run["nodes"]["run"]["background"]["command"]["args"], [str(self.script)])

    def test_existing_action_recipe_and_package_namespace_resources(self):
        self.assertRegex(self.definition["knowledgeId"], r"^action_[a-f0-9]{32}$")
        self.assertEqual(self.definition["source_id"], "pkm://knowledge/" + self.definition["knowledgeId"])
        builtin = self.runtime.definition("core.date.parse")
        self.assertRegex(builtin["source_id"], r"^pkm://knowledge/action_[a-f0-9]{24}$")
        self.assertEqual(self.runtime.resource_path(self.definition, self.definition["source_id"]),
                         self.runtime.registry / (self.definition["action_id"] + ".json"))
        action = self.runtime.resource_path(self.definition, "pkm://actions/" + self.definition["action_id"])
        self.assertEqual(action, self.runtime.registry / (self.definition["action_id"] + ".json"))
        recipe = self.runtime.store / "recipes" / "moved" / "recipe.json"
        recipe.parent.mkdir(parents=True)
        recipe.write_text(json.dumps({"recipeId": "recipe_fixture", "knowledgeId": "knowledge_" + "f" * 24,
                                      "category": "Operations", "name": "My Recipe"}))
        self.assertEqual(self.runtime.resource_path(self.definition, "pkm://recipes/recipe_fixture"), recipe)
        self.assertEqual(self.runtime.resource_path(self.definition, "pkm://recipes/Operations/My%20Recipe"), recipe)
        package = self.runtime.store / "packages" / "demo" / "src" / "entry.py"
        package.parent.mkdir(parents=True)
        package.write_text("print('{}')")
        self.assertEqual(self.runtime.resource_path(self.definition, "pkm://packages/demo/src/entry.py"), package)
        for reference in ("pkm://packages/demo/../entry.py", "pkm://packages/demo/%2fetc",
                          "pkm://packages/demo/file.py?x=1"):
            with self.assertRaises(ValueError):
                self.runtime.resource_path(self.definition, reference)
        self.assertEqual(self.runtime.locator_read("pkm://actions/cosmos.directory.list")["definition"]["action_id"],
                         "cosmos.directory.list")
        self.assertEqual(self.runtime.locator_read("pkm://components/core.file-path")["definition"]["action_id"],
                         "core.file-path")

    def test_identity_delete_restore_copy_and_package_install_symlink_boundary(self):
        content_hash = self.definition["content_hash"]
        trash = self.directory / "trash"
        trash.mkdir()
        shutil.move(self.script, trash / self.script.name)
        shutil.move(self.sidecar, trash / self.sidecar.name)
        with self.assertRaises(FileNotFoundError):
            self.runtime.resource_path(self.definition, self.uri)
        restored = self.runtime.store / "scripts" / "恢复" / "renamed.py"
        restored.parent.mkdir()
        shutil.move(trash / self.script.name, restored)
        shutil.move(trash / self.sidecar.name, restored.with_name("." + restored.name + ".pkm.json"))
        self.assertEqual(self.runtime.resource_path(self.definition, self.uri), restored)
        self.assertEqual(self.runtime.definition(self.definition["action_id"])["content_hash"], content_hash)
        copied = restored.with_name("copied.py")
        shutil.copyfile(restored, copied)
        shutil.copyfile(restored.with_name("." + restored.name + ".pkm.json"),
                        copied.with_name("." + copied.name + ".pkm.json"))
        with self.assertRaisesRegex(ValueError, "multiple"):
            self.runtime.resource_path(self.definition, self.uri)
        if os.name != "nt":
            self.runtime.module_sets.mkdir()
            (self.runtime.module_sets / "test.escape").symlink_to(self.directory, target_is_directory=True)
            with self.assertRaisesRegex(PermissionError, "installation root"):
                self.runtime.module_set_path("test.escape", 1)


del ResourceReferenceTests

if __name__ == "__main__":
    unittest.main()
